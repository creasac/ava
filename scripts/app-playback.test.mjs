import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { createPlayer, quantum, sampleRate, samples } from './helpers/audio-harness.mjs';

const source = await readFile(new URL('../app.js', import.meta.url), 'utf8');

// Only browser IO is replaced: the application's generation, worker-message,
// Play/Pause, seek, and reset handlers run unchanged with the real audio player.
async function createApp(preferences = null) {
  const audio = await createPlayer({ instantiate: false });
  audio.audioContext.state = 'suspended';
  const elements = new Map();
  function element(selector) {
    if (!elements.has(selector)) elements.set(selector, {
      value: '', dataset: {}, hidden: false, open: false,
      classList: { add() {}, remove() {}, toggle() {} },
      style: { setProperty() {} },
      setAttribute() {}, removeAttribute() {}, addEventListener() {},
    });
    return elements.get(selector);
  }
  let worker;
  let now = 0;
  let timerId = 0;
  const timers = new Map();
  const storage = new Map(preferences ? [['ava-preferences-v1', JSON.stringify(preferences)]] : []);
  const errors = [];
  const context = vm.createContext({
    Float32Array, Blob, URL, crossOriginIsolated: true,
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    console: { ...console, error: (...args) => errors.push(args) },
    document: { querySelector: element, documentElement: { dataset: {} }, addEventListener() {} },
    window: { AudioContext: class { constructor() { return audio.audioContext; } } },
    navigator: {},
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    performance: { now: () => now },
    setTimeout(fn, delay) { timers.set(++timerId, { fn, delay }); return timerId; },
    clearTimeout(id) { timers.delete(id); }, queueMicrotask,
    PCMPlayerWorklet: audio.PCMPlayerWorklet,
    Worker: class {
      constructor() { worker = this; this.listeners = new Map(); this.sent = []; }
      addEventListener(type, handler) { this.listeners.set(type, handler); }
      postMessage(message) { this.sent.push(message); }
      terminate() {}
      receive(message) { this.listeners.get('message')({ data: message }); }
    },
  });
  const adapted = source
    .replaceAll('import.meta.url', JSON.stringify(new URL('../app.js', import.meta.url).href))
    .replace(/const \{ PCMPlayerWorklet \} = await import\([^;]+;/,
      'const { PCMPlayerWorklet } = globalThis;')
    .replace(/\nloadPreferences\(\);[\s\S]*$/, '');
  assert.notEqual(adapted, source);
  vm.runInContext(adapted, context);
  const evaluate = expression => vm.runInContext(expression, context);
  element('#language-select').value = 'english_2026-04';
  element('#voice-select').value = 'jane';
  evaluate('modelReady = true; loadedLanguage = "english_2026-04";');

  async function begin(estimatedSeconds) {
    context.testJob = { revision: 0, text: 'A reading for the playback test.', language: 'english_2026-04', voice: 'jane' };
    evaluate('globalThis.generationDone = generateSpeech(testJob)');
    // generateSpeech awaits player initialization and model/voice readiness.
    for (let i = 0; i < 12; i++) await Promise.resolve();
    assert.ok(worker.sent.some(message => message.type === 'generate'));
    evaluate(`estimatedDurationSamples = ${Math.round(estimatedSeconds * sampleRate)}`);
    audio.flushMessages();
  }
  return {
    audio, elements, errors, begin, evaluate, timers, storage,
    get player() { return evaluate('streamPlayer'); },
    setTime(seconds) { now = seconds * 1000; },
    receive(message) { worker.receive(message); },
    play() { return evaluate('togglePlayback()'); },
    seek(seconds) { return evaluate(`seekToSamples(${Math.round(seconds * sampleRate)}, false)`); },
    async finish(type = 'stream_ended') {
      worker.receive({ type });
      await context.generationDone;
    },
    render() { return audio.render(); },
    state() { return evaluate('({ wantsPlayback, isPlaying, playbackQueued, streamEnded, receivedSamples, playbackPositionSamples })'); },
  };
}

// Simulated model arrivals use its actual 240 ms first batch / 960 ms following
// batches. Virtual time keeps minute-long readings fast and deterministic.
async function simulate({ speed, duration, estimate = 1, jitter = false }) {
  const app = await createApp();
  await app.begin(duration * estimate);
  const expected = samples(Math.round(duration * sampleRate));
  let generated = 0;
  let played = 0;
  let armed = false;
  let nextArrival = 0.24 / speed;
  let nextLength = Math.min(5760, expected.length);
  let startup = null;
  let startupBufferSeconds = null;
  let peakPending = 0;
  let gaps = 0;
  let gapSamples = 0;
  let inGap = false;
  let batch = 0;
  const deadline = (duration / speed + duration + 10) * sampleRate;

  for (let elapsed = 0; elapsed < deadline; elapsed += quantum) {
    const seconds = elapsed / sampleRate;
    app.setTime(seconds);
    while (generated < expected.length && seconds >= nextArrival) {
      app.receive({ type: 'audio_chunk', data: expected.slice(generated, generated + nextLength) });
      generated += nextLength;
      if (!armed) { await app.play(); armed = true; }
      if (generated === expected.length) {
        await app.finish();
      } else {
        nextLength = Math.min(23040, expected.length - generated);
        // Bounded extra stalls every fourth batch, then a correspondingly
        // faster arrival: average production speed remains unchanged.
        const delay = jitter ? [0.35, 0, -0.35, 0][batch % 4] : 0;
        nextArrival += nextLength / sampleRate / speed + delay;
      }
      batch++;
    }
    peakPending = Math.max(peakPending, app.player.pendingChunks.length);
    const output = app.render();
    const audible = output.filter(value => value !== 0);
    if (audible.length) {
      if (startup === null) {
        startup = seconds;
        startupBufferSeconds = (generated - played) / sampleRate;
      }
      assert.deepEqual(audible, expected.subarray(played, played + audible.length), 'PCM order must survive underruns and backpressure');
      played += audible.length;
      inGap = false;
    }
    if (startup !== null && played < expected.length && audible.length < quantum) {
      if (!inGap) gaps++;
      inGap = true;
      gapSamples += quantum - audible.length;
    }
    if (app.audio.events.some(event => event.type === 'audioEnded')) break;
  }
  assert.equal(generated, expected.length);
  assert.equal(played, expected.length, 'every generated sample must play exactly once');
  assert.equal(app.audio.events.filter(event => event.type === 'audioEnded').length, 1);
  assert.equal(app.errors.length, 0);
  return { startup, startupBufferSeconds, gaps, gapSeconds: gapSamples / sampleRate, underruns: app.player.metrics.underruns, peakPending };
}

for (const speed of [0.5, 0.8, 1, 2]) {
  for (const estimate of [1, 0.8]) {
    test(`${speed}x generation, ${estimate === 1 ? 'accurate' : '20% short'} duration estimate: immediate complete playback`, async t => {
      const result = await simulate({ speed, duration: 30, estimate, jitter: true });
      assert.ok(result.startup - 0.24 / speed < quantum / sampleRate, 'start on the first available batch');
      assert.equal(result.startupBufferSeconds, 0.24);
      t.diagnostic(`startup ${result.startup.toFixed(2)}s; ${result.gaps} gaps from simulated production timing`);
    });
  }
}

test('long fast reading queues more than the worklet ring capacity without loss or stalls', async t => {
  const result = await simulate({ speed: 8, duration: 150, estimate: 0.8 });
  assert.ok(result.peakPending > 0, 'exercise >60 seconds of retained audio and wrapper backpressure');
  assert.equal(result.startupBufferSeconds, 0.24);
  assert.equal(result.underruns, 0);
  assert.equal(result.gaps, 0);
  t.diagnostic(`150s reading at 8x: startup ${result.startup.toFixed(2)}s; no playback gaps`);
});

test('slow production starts immediately even when the estimated reading is very long', async () => {
  const result = await simulate({ speed: 0.5, duration: 30, estimate: 30 });
  assert.ok(result.startup < 0.5);
  assert.ok(result.gaps > 0, 'immediate playback cannot hide real production stalls');
});

test('short reading plays its complete tail', async () => {
  const result = await simulate({ speed: 0.5, duration: 0.1 });
  assert.equal(result.underruns, 0);
  assert.equal(result.gaps, 0);
});

test('Pause cancels pending Play; later generation cannot start audio unexpectedly', async () => {
  const app = await createApp();
  await app.begin(30);
  await app.play();
  assert.equal(app.state().wantsPlayback, true);
  assert.equal(app.state().playbackQueued, false);
  assert.equal(app.elements.get('#play-label').textContent, 'Pause');
  assert.equal(app.elements.get('#play-button').disabled, false);
  await app.play();
  assert.equal(app.state().wantsPlayback, false);
  app.setTime(20);
  app.receive({ type: 'audio_chunk', data: samples(23040) });
  await app.finish();
  for (let i = 0; i < 20; i++) assert.ok(app.render().every(value => value === 0));
  assert.equal(app.audio.events.filter(event => event.type === 'firstPlayback').length, 0);
  await app.play();
  assert.equal(app.render()[0], samples(1)[0]);
});

for (const liveEdge of [false, true]) {
  test(`seek ${liveEdge ? 'to live edge' : 'within available audio'} preserves Play and starts from selected sample`, async () => {
    const app = await createApp();
    await app.begin(30);
    app.setTime(4);
    app.receive({ type: 'audio_chunk', data: samples(24000) });
    await app.play();
    const target = liveEdge ? 1 : 0.5;
    await app.seek(target);
    assert.equal(app.state().wantsPlayback, true);
    assert.equal(app.state().playbackQueued, !liveEdge);
    app.setTime(8);
    app.receive({ type: 'audio_chunk', data: samples(24000, 24000) });
    await app.finish();
    assert.deepEqual(app.render(), samples(quantum, target * sampleRate));
  });
}

test('generation cancellation releases the retained partial reading', async () => {
  const app = await createApp();
  await app.begin(30);
  app.setTime(2);
  app.receive({ type: 'audio_chunk', data: samples(5760) });
  await app.play();
  await app.finish('generation_cancelled');
  assert.deepEqual(app.render(), samples(quantum));
});

test('seeking from active playback to the live edge starts with the next tiny batch', async () => {
  const app = await createApp();
  await app.begin(30);
  app.setTime(1);
  app.receive({ type: 'audio_chunk', data: samples(4 * sampleRate) });
  await app.play();
  assert.deepEqual(app.render(), samples(quantum));
  assert.equal(app.state().isPlaying, true);
  await app.seek(4);
  assert.equal(app.state().wantsPlayback, true);
  assert.equal(app.state().playbackQueued, false);
  assert.ok(app.render().every(value => value === 0));
  app.setTime(2);
  app.receive({ type: 'audio_chunk', data: samples(quantum, 4 * sampleRate) });
  assert.deepEqual(app.render(), samples(quantum, 4 * sampleRate));
  await app.finish();
  assert.equal(app.player.metrics.underruns, 0);
});

test('worker failure releases retained partial audio and finishes pending generation', async () => {
  const app = await createApp();
  await app.begin(30);
  app.setTime(2);
  app.receive({ type: 'audio_chunk', data: samples(5760) });
  await app.play();
  app.receive({ type: 'error', error: 'Synthetic generation failure' });
  await app.evaluate('generationDone');
  assert.deepEqual(app.render(), samples(quantum));
  assert.equal(app.errors.length, 1);
});

test('editing text cancels pending playback and rejects stale audio', async () => {
  const app = await createApp();
  await app.begin(30);
  app.setTime(2);
  app.receive({ type: 'audio_chunk', data: samples(5760) });
  await app.play();
  app.elements.get('#source-text').value = 'Replacement reading';
  app.evaluate('scheduleGeneration()');
  app.receive({ type: 'audio_chunk', data: samples(23040, 5760) });
  await app.finish('generation_cancelled');
  assert.equal(app.state().wantsPlayback, false);
  assert.equal(app.state().receivedSamples, 0);
  assert.ok(app.render().every(value => value === 0));
  assert.equal(app.audio.events.filter(event => event.type === 'firstPlayback').length, 0);
});

for (const length of [1, 37, 128]) {
  test(`pending Play starts the first ${length} samples without stream end or a duration gate`, async () => {
    const app = await createApp();
    await app.begin(900);
    await app.play();
    assert.equal(app.state().wantsPlayback, true);
    assert.equal(app.state().playbackQueued, false);
    assert.ok(app.render().every(value => value === 0));
    app.receive({ type: 'audio_chunk', data: samples(length) });
    const output = app.render();
    assert.deepEqual(output.subarray(0, length), samples(length));
    assert.ok(output.subarray(length).every(value => value === 0));
    assert.equal(app.state().streamEnded, false);
    assert.equal(app.state().isPlaying, true);
  });
}

for (const pressPlay of [false, true]) {
  test(`the 700 ms text debounce generates ${pressPlay ? 'with retained Play intent' : 'silently'}`, async () => {
    const app = await createApp();
    app.elements.get('#source-text').value = 'An automatically generated reading.';
    app.evaluate('scheduleGeneration()');
    const timer = [...app.timers.values()][0];
    assert.equal(timer.delay, 700);
    assert.equal(app.elements.get('#play-button').disabled, false);
    if (pressPlay) await app.play();
    timer.fn();
    for (let i = 0; i < 12; i++) await Promise.resolve();
    assert.equal(app.evaluate('isGenerating'), true);
    app.receive({ type: 'audio_chunk', data: samples(quantum) });
    assert.deepEqual(app.render(), pressPlay ? samples(quantum) : new Float32Array(quantum));
    assert.equal(app.state().wantsPlayback, pressPlay);
  });
}

test('Pause during the debounce cancels intent before model loading', async () => {
  const app = await createApp();
  app.elements.get('#source-text').value = 'Another reading.';
  app.evaluate('scheduleGeneration()');
  await app.play();
  await app.play();
  [...app.timers.values()][0].fn();
  for (let i = 0; i < 12; i++) await Promise.resolve();
  app.receive({ type: 'audio_chunk', data: samples(quantum) });
  assert.equal(app.state().wantsPlayback, false);
  assert.ok(app.render().every(value => value === 0));
});

test('Pause/resume, completed replay, and WAV export retain every source sample', async () => {
  const app = await createApp();
  await app.begin(2);
  const expected = samples(8192);
  app.receive({ type: 'audio_chunk', data: expected });
  await app.finish();
  await app.play();
  assert.deepEqual(app.render(), expected.slice(0, quantum));
  await app.play();
  assert.ok(app.render().every(value => value === 0));
  // Position messages are periodic; use a selected exact position for resuming.
  await app.seek(quantum / sampleRate);
  await app.play();
  assert.deepEqual(app.render(), expected.slice(quantum, quantum * 2));
  for (let i = 0; i < 100; i++) app.render();
  assert.equal(app.state().wantsPlayback, false);
  await app.play();
  assert.deepEqual(app.render(), expected.slice(0, quantum));
  const wav = await app.evaluate('createWavBlob(audioChunks.map(({data}) => data), receivedSamples)');
  const data = new DataView(await wav.arrayBuffer());
  assert.equal(data.byteLength, 44 + expected.length * 2);
  assert.equal(data.getUint32(24, true), sampleRate);
  for (let i = 0; i < expected.length; i++) {
    assert.equal(data.getInt16(44 + i * 2, true), Math.round(expected[i] * 32767));
  }
});

test('Jane is the new default, while clones, other languages, and subsequent Alba choices survive', async () => {
  const app = await createApp({ voices: { 'english_2026-04': 'alba', german: 'custom:german-voice' } });
  app.evaluate('loadPreferences()');
  assert.equal(app.evaluate('voiceSelections[DEFAULT_LANGUAGE]'), 'jane');
  assert.equal(app.evaluate('voiceSelections.german'), 'custom:german-voice');
  assert.equal(app.evaluate('LANGUAGE_VOICES[DEFAULT_LANGUAGE]'), 'jane');
  assert.deepEqual(Array.from(app.evaluate('LANGUAGE_BUILTIN_VOICES[DEFAULT_LANGUAGE]')), ['jane', 'alba']);
  app.elements.get('#voice-select').value = 'alba';
  app.evaluate('savePreferences(); loadPreferences()');
  assert.equal(app.evaluate('voiceSelections[DEFAULT_LANGUAGE]'), 'alba');
  const custom = await createApp({ voices: { 'english_2026-04': 'custom:my-voice' } });
  custom.evaluate('loadPreferences()');
  assert.equal(custom.evaluate('voiceSelections[DEFAULT_LANGUAGE]'), 'custom:my-voice');
});

test('seeking to the completed end clears Play intent and permits replay', async () => {
  const app = await createApp();
  await app.begin(1);
  app.receive({ type: 'audio_chunk', data: samples(sampleRate) });
  await app.finish();
  await app.play();
  app.render();
  await app.seek(1);
  assert.ok(app.render().every(value => value === 0));
  assert.equal(app.state().wantsPlayback, false);
  assert.equal(app.state().playbackPositionSamples, sampleRate);
  await app.play();
  assert.deepEqual(app.render(), samples(quantum));
});
