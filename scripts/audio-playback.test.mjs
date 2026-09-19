import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlayer, sampleRate, quantum, samples } from './helpers/audio-harness.mjs';

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

async function simulateBatches(generationSpeed, arrivalJitter = [0, 0, 0, 0]) {
  const harness = await createPlayer();
  const firstBatch = 5760; // 240 ms
  const normalBatch = 23040; // 960 ms
  const expected = samples(firstBatch + normalBatch * 4);
  let offset = 0;
  let nextArrival = 0;
  let batch = 0;
  let played = 0;
  const output = [];

  for (let elapsed = 0; elapsed < sampleRate * 15; elapsed += quantum) {
    if (batch < 5 && elapsed >= nextArrival) {
      const length = batch === 0 ? firstBatch : normalBatch;
      harness.player.playAudio(expected.slice(offset, offset + length));
      offset += length;
      batch++;
      nextArrival += normalBatch / generationSpeed + (arrivalJitter[batch - 1] ?? 0) * sampleRate;
      if (batch === 5) harness.player.notifyStreamEnded();
    }
    harness.flushMessages();
    const available = harness.processor.getBufferedSamples();
    const frame = harness.render();
    const expectedSamples = Math.min(quantum, available);
    assertAudio(frame, expected.slice(played, played + expectedSamples));
    played += expectedSamples;
    output.push(...frame);
    if (harness.events.some(event => event.type === 'audioEnded')) break;
  }

  assert.equal(batch, 5);
  assert.equal(harness.events.filter(event => event.type === 'audioEnded').length, 1);
  assertAudio(output, expected);
}

test('low-level worklet starts with the first 240 ms audio batch', async () => {
  const harness = await createPlayer();
  const expected = samples(5760);
  harness.player.playAudio(expected);
  assertAudio(harness.render(), expected.slice(0, quantum));
  harness.player.notifyStreamEnded();
  assertAudio(drain(harness), expected.slice(quantum));
});

for (const speed of [0.5, 0.8, 1, 2]) {
  test(`generation at ${speed}x plays available PCM without added waits and preserves every sample`, async () => {
    await simulateBatches(speed);
  });
}

test('jittered arrivals resume immediately and preserve every sample', async () => {
  await simulateBatches(1, [0.4, -0.3, 1.3, -0.6]);
});

for (const resumedLength of [128, 23040]) {
  test(`after starvation, ${resumedLength} new samples resume next quantum without waiting for another batch`, async () => {
    const harness = await createPlayer();
    const initialLength = 28800;
    const expected = samples(initialLength + resumedLength);
    harness.player.playAudio(expected.slice(0, initialLength));
    const output = [];
    for (let frame = 0; frame < initialLength / quantum; frame++) output.push(...harness.render());
    for (let frame = 0; frame < 30; frame++) assertSilence(harness.render());
    assert.ok(harness.player.metrics.underruns > 0);

    harness.player.playAudio(expected.slice(initialLength));
    const resumedFrame = harness.render();
    assertAudio(resumedFrame, expected.slice(initialLength, initialLength + quantum));
    output.push(...resumedFrame);
    harness.player.notifyStreamEnded();
    output.push(...drain(harness));
    assertAudio(output, expected);
  });
}

for (const initiallyPlaying of [false, true]) {
  test(`end of stream drains a short tail ${initiallyPlaying ? 'after starvation' : 'before initial playback'}`, async () => {
    const harness = await createPlayer();
    const initialLength = initiallyPlaying ? 28800 : 0;
    const expected = samples(initialLength + 333);
    const output = [];
    if (initiallyPlaying) {
      harness.player.playAudio(expected.slice(0, initialLength));
      for (let frame = 0; frame < 226; frame++) output.push(...harness.render());
    }
    harness.player.playAudio(expected.slice(initialLength));
    const firstTailFrame = harness.render();
    if (initiallyPlaying) {
      assertAudio(firstTailFrame, expected.slice(initialLength, initialLength + quantum));
      output.push(...firstTailFrame);
    } else {
      assertSilence(firstTailFrame);
    }
    harness.player.notifyStreamEnded();
    output.push(...drain(harness));
    assertAudio(output, expected);
    assert.equal(harness.player.metrics.underruns > 0, initiallyPlaying);
    for (let frame = 0; frame < 20; frame++) assertSilence(harness.render());
    assert.equal(harness.events.filter(event => event.type === 'audioEnded').length, 1);
  });
}

for (const initiallyPlaying of [false, true]) {
  test(`empty end of stream completes ${initiallyPlaying ? 'after starvation' : 'without playback'}`, async () => {
    const harness = await createPlayer();
    if (initiallyPlaying) {
      harness.player.playAudio(samples(28800));
      for (let frame = 0; frame < 226; frame++) harness.render();
    }
    assert.equal(harness.processor.getBufferedSamples(), 0);
    harness.player.notifyStreamEnded();
    assertSilence(harness.render());
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
