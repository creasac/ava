import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const playerSource = await readFile(new URL('../pocket/PCMPlayerWorklet.js', import.meta.url), 'utf8');
const sampleRate = 24000;
const quantum = 128;

// Execute the actual wrapper and its generated processor. Message delivery is
// queued in both directions, as with MessagePort, including initial capacity.
async function createPlayer(minBufferBeforePlaybackMs = 1200) {
  const messages = [];
  const deliveries = [];
  const events = [];
  let Processor;
  let processor;
  let hostPort;
  const context = vm.createContext({
    console,
    Float32Array,
    Int16Array,
    currentTime: 0,
    EventEmitter: class {
      emit(type, detail) { events.push({ type, detail }); }
    },
    Blob: class {
      constructor(parts) { this.source = parts.join(''); }
    },
    URL: {
      createObjectURL(blob) { return blob; },
      revokeObjectURL() {}
    },
    AudioWorkletProcessor: class {
      constructor() {
        this.port = {
          postMessage(message) {
            messages.push(message);
            deliveries.push(() => hostPort.onmessage({ data: message }));
          }
        };
      }
    },
    registerProcessor(name, constructor) { Processor = constructor; },
    AudioWorkletNode: class {
      constructor() {
        hostPort = this.port = {
          postMessage(message) {
            deliveries.push(() => processor.port.onmessage({ data: message }));
          }
        };
        processor = new Processor();
      }
      connect() {}
    }
  });
  const audioContext = {
    sampleRate,
    currentTime: 0,
    destination: {},
    createGain() {
      return {
        gain: { value: 1, cancelScheduledValues() {}, setValueAtTime() {} },
        connect() {}
      };
    },
    createAnalyser() { return {}; },
    audioWorklet: {
      async addModule(blob) { vm.runInContext(blob.source, context); }
    }
  };
  vm.runInContext(
    playerSource.replace(/^import .*\n/, '').replace('export class PCMPlayerWorklet', 'class PCMPlayerWorklet')
      + '\nglobalThis.PCMPlayerWorklet = PCMPlayerWorklet;',
    context
  );
  const player = new context.PCMPlayerWorklet(audioContext, { minBufferBeforePlaybackMs });
  await player.initPromise;

  function flushMessages() {
    let count = 0;
    while (deliveries.length > 0) {
      assert.ok(++count < 10000, 'message queue must settle');
      deliveries.shift()();
    }
  }

  function render() {
    flushMessages();
    const output = new Float32Array(quantum);
    processor.process([], [[output]], {});
    context.currentTime += quantum / sampleRate;
    audioContext.currentTime = context.currentTime;
    flushMessages();
    return output;
  }

  flushMessages();
  return { player, processor, messages, events, flushMessages, render };
}

// Nonzero, exactly representable PCM values make any added silence and missing,
// repeated, or reordered samples observable without a model or audio device.
function samples(length, offset = 0) {
  return Float32Array.from({ length }, (_, i) => (offset + i + 1) / 1048576);
}

function assertSilence(output) {
  assert.ok(output.every(value => value === 0));
}

function assertAudio(output, expected) {
  assert.deepEqual(Float32Array.from(output.filter(value => value !== 0)), expected);
}

function drain(harness, limit = 20000) {
  const output = [];
  for (let frame = 0; frame < limit; frame++) {
    output.push(...harness.render());
    if (harness.events.some(event => event.type === 'audioEnded')) return output;
  }
  assert.fail('playback must complete');
}

async function simulateBatches(minBufferMs, generationSpeed) {
  const harness = await createPlayer(minBufferMs);
  const firstBatch = 5760; // 240 ms
  const normalBatch = 23040; // 960 ms
  const expected = samples(firstBatch + normalBatch * 4);
  let offset = 0;
  let nextArrival = 0;
  let batch = 0;
  const output = [];

  for (let elapsed = 0; elapsed < sampleRate * 15; elapsed += quantum) {
    if (batch < 5 && elapsed >= nextArrival) {
      const length = batch === 0 ? firstBatch : normalBatch;
      harness.player.playAudio(expected.slice(offset, offset + length));
      offset += length;
      batch++;
      nextArrival += normalBatch / generationSpeed;
      if (batch === 5) harness.player.notifyStreamEnded();
    }
    output.push(...harness.render());
    if (harness.events.some(event => event.type === 'audioEnded')) break;
  }

  assert.equal(batch, 5);
  assert.equal(harness.events.filter(event => event.type === 'audioEnded').length, 1);
  assertAudio(output, expected);
  const first = output.findIndex(value => value !== 0);
  const last = output.findLastIndex(value => value !== 0);
  const silentSamples = output.slice(first, last + 1).filter(value => value === 0).length;
  return { silentSamples, underruns: harness.player.metrics.underruns };
}

for (const speed of [1, 2]) {
  test(`1200 ms buffering removes the startup gap with generation at ${speed}x playback`, async () => {
    const oldBuffer = await simulateBatches(220, speed);
    const newBuffer = await simulateBatches(1200, speed);
    assert.equal(oldBuffer.silentSamples, speed === 1 ? 17280 : 5760);
    assert.ok(oldBuffer.underruns > 0);
    assert.equal(newBuffer.silentSamples, 0);
    assert.equal(newBuffer.underruns, 0);
  });
}

test('underrun waits for a fresh minimum buffer and preserves sample order', async () => {
  const harness = await createPlayer();
  const expected = samples(57600);
  harness.player.playAudio(expected.slice(0, 28800));
  const output = [];
  for (let frame = 0; frame < 225; frame++) output.push(...harness.render());
  assertSilence(harness.render());
  assert.equal(harness.processor.isPlaying, false);
  assert.equal(harness.player.metrics.underruns, 1);

  harness.player.playAudio(expected.slice(28800, 34560));
  for (let frame = 0; frame < 30; frame++) assertSilence(harness.render());
  assert.equal(harness.player.metrics.underruns, 1, 'one report per starvation, not per silent frame');
  assert.equal(harness.processor.getBufferedSamples(), 5760);

  harness.player.playAudio(expected.slice(34560));
  harness.flushMessages();
  assert.equal(harness.processor.isPlaying, true);
  harness.player.notifyStreamEnded();
  output.push(...drain(harness));
  assertAudio(output, expected);
});

for (const initiallyPlaying of [false, true]) {
  test(`end of stream drains a short tail ${initiallyPlaying ? 'after starvation' : 'before initial playback'}`, async () => {
    const harness = await createPlayer();
    const initialLength = initiallyPlaying ? 28800 : 0;
    const expected = samples(initialLength + 333);
    const output = [];
    if (initiallyPlaying) {
      harness.player.playAudio(expected.slice(0, initialLength));
      for (let frame = 0; frame < 226; frame++) output.push(...harness.render());
      assert.equal(harness.processor.isPlaying, false);
    }
    harness.player.playAudio(expected.slice(initialLength));
    assertSilence(harness.render());
    harness.player.notifyStreamEnded();
    output.push(...drain(harness));
    assertAudio(output, expected);
    assert.equal(harness.player.metrics.underruns, initiallyPlaying ? 1 : 0);
    for (let frame = 0; frame < 20; frame++) assertSilence(harness.render());
    assert.equal(harness.events.filter(event => event.type === 'audioEnded').length, 1);
  });
}

for (const initiallyPlaying of [false, true]) {
  test(`empty end of stream completes ${initiallyPlaying ? 'during rebuffering' : 'without playback'}`, async () => {
    const harness = await createPlayer();
    if (initiallyPlaying) {
      harness.player.playAudio(samples(28800));
      for (let frame = 0; frame < 226; frame++) harness.render();
    }
    assert.equal(harness.processor.isPlaying, false);
    assert.equal(harness.processor.getBufferedSamples(), 0);
    harness.player.notifyStreamEnded();
    harness.flushMessages();
    assert.equal(harness.events.filter(event => event.type === 'audioEnded').length, 1);
    for (let frame = 0; frame < 20; frame++) assertSilence(harness.render());
    assert.equal(harness.events.filter(event => event.type === 'audioEnded').length, 1);
  });
}

test('queued chunks respect capacity and deliver stream end after the last audio', async () => {
  const harness = await createPlayer();
  const batchSize = 23040;
  const expected = samples(batchSize * 8);
  for (let offset = 0; offset < expected.length; offset += batchSize) {
    harness.player.playAudio(expected.slice(offset, offset + batchSize));
  }
  harness.player.notifyStreamEnded();
  harness.flushMessages();
  assert.ok(harness.player.pendingChunks.length > 0, 'exercise wrapper backpressure');
  assert.equal(harness.processor.streamEnded, false);
  const output = drain(harness);
  assertAudio(output, expected);
  assert.equal(harness.player.pendingChunks.length, 0);
  assert.equal(harness.player.pendingStreamEnd, false);
  assert.equal(harness.player.metrics.underruns, 0);
});

test('reset for seeking discards old queued audio and ignores stale session messages', async () => {
  const harness = await createPlayer();
  const oldSession = harness.player.playbackSession;
  for (let i = 0; i < 8; i++) harness.player.playAudio(samples(23040));
  harness.player.notifyStreamEnded();
  harness.flushMessages();
  assert.ok(harness.player.pendingChunks.length > 0);

  harness.player.reset();
  harness.flushMessages();
  assert.equal(harness.player.pendingChunks.length, 0);
  assert.equal(harness.player.pendingStreamEnd, false);
  assert.equal(harness.processor.samplesPlayed, 0);
  assert.equal(harness.processor.getBufferedSamples(), 0);
  harness.processor.port.onmessage({ data: { type: 'audio', sessionId: oldSession, data: samples(28800) } });
  harness.processor.port.onmessage({ data: { type: 'stream-ended', sessionId: oldSession } });
  harness.player.workletNode.port.onmessage({ data: { type: 'playback-complete', sessionId: oldSession } });
  assertSilence(harness.render());
  assert.equal(harness.events.filter(event => event.type === 'audioEnded').length, 0);

  const expected = samples(777, 500000);
  harness.player.playAudio(expected);
  harness.player.notifyStreamEnded();
  assertAudio(drain(harness), expected);
  assert.equal(harness.events.filter(event => event.type === 'audioEnded').length, 1);
  assert.equal(harness.processor.samplesPlayed, expected.length);
});
