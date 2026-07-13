const DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT || 9223);
const AVA_URL = process.env.AVA_URL || "http://127.0.0.1:8000/";
const TEST_LANGUAGE = process.env.TEST_LANGUAGE || "english_2026-04";
const TEST_VOICE = {
  "english_2026-04": "alba",
  german: "juergen",
  italian: "giovanni",
  portuguese: "rafael",
  spanish: "lola",
}[TEST_LANGUAGE];
const TEST_TEXT = {
  "english_2026-04": "ava should stream this Pocket TTS benchmark and let us move through received audio.",
  german: "ava soll diesen deutschen Text streamen und die Wiedergabe sofort ermöglichen.",
  italian: "ava dovrebbe leggere questo testo italiano e avviare subito la riproduzione.",
  portuguese: "ava deve ler este texto em português e iniciar a reprodução imediatamente.",
  spanish: "ava debería leer este texto en español e iniciar la reproducción inmediatamente.",
}[TEST_LANGUAGE];
if (!TEST_TEXT || !TEST_VOICE) throw new Error(`Unsupported TEST_LANGUAGE: ${TEST_LANGUAGE}`);
const timeoutAt = Date.now() + 10 * 60 * 1000;

const targets = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`).then((response) => response.json());
const target = targets.find((item) => item.type === "page" && item.url.startsWith(AVA_URL));
if (!target) throw new Error("ava page was not found in headless Chrome");

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

let sequence = 0;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
    const content = message.params.args.map((argument) => argument.description || argument.value).join(" ");
    console.log(`Browser error: ${content}`);
    return;
  }
  if (!message.id || !pending.has(message.id)) return;
  const { resolve, reject } = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) reject(new Error(message.error.message));
  else resolve(message.result);
});

function command(method, params = {}) {
  const id = ++sequence;
  const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  socket.send(JSON.stringify({ id, method, params }));
  return promise;
}

async function evaluate(expression) {
  const response = await command("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description || "Browser evaluation failed");
  }
  return response.result.value;
}

await command("Runtime.enable");
await command("Page.enable");
if (process.env.SEED_LEGACY_PREFERENCES === "1") {
  await evaluate(`localStorage.setItem('ava-preferences-v1', JSON.stringify({
    voice: 'azelma',
    volume: 0.65
  }))`);
}
if (process.env.NO_RELOAD !== "1") {
  await command("Page.reload", { ignoreCache: true });
}

while (Date.now() < timeoutAt) {
  const ready = await evaluate(`document.readyState === 'complete' && document.querySelector('script[src*="app.js?v=27"]') !== null`);
  if (ready) break;
  await new Promise((resolve) => setTimeout(resolve, 250));
}

const languageOptions = await evaluate(`[
  ...document.querySelector('#language-select').options
].map((option) => option.value)`);
const expectedLanguages = [
  "english_2026-04",
  "german",
  "italian",
  "portuguese",
  "spanish",
];
if (JSON.stringify(languageOptions) !== JSON.stringify(expectedLanguages)) {
  throw new Error(`Language selector mismatch: ${JSON.stringify(languageOptions)}`);
}

const editorStyles = await evaluate(`(() => {
  const text = document.querySelector('#source-text');
  const language = document.querySelector('#language-select');
  const languageField = document.querySelector('.language-field');
  const playButton = document.querySelector('#play-button');
  const restingBorder = getComputedStyle(languageField).borderColor;
  text.focus();
  const textStyle = getComputedStyle(text);
  const result = {
    resize: textStyle.resize,
    textOutline: textStyle.outlineStyle,
    playTransition: getComputedStyle(playButton).transitionDuration,
    restingBorder,
  };
  language.focus();
  const focusedFieldStyle = getComputedStyle(languageField);
  result.focusedBorder = focusedFieldStyle.borderColor;
  result.focusedShadow = focusedFieldStyle.boxShadow;
  result.pageBackgroundImage = getComputedStyle(document.body).backgroundImage;
  playButton.focus();
  playButton.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  result.pointerFocusCleared = document.activeElement !== playButton;
  return result;
})()`);
if (
  editorStyles.resize !== "none"
  || editorStyles.textOutline !== "none"
  || editorStyles.playTransition !== "0s"
  || editorStyles.focusedBorder !== editorStyles.restingBorder
  || editorStyles.focusedShadow !== "none"
  || editorStyles.pageBackgroundImage !== "none"
  || !editorStyles.pointerFocusCleared
) {
  throw new Error(`Editor focus styling failed: ${JSON.stringify(editorStyles)}`);
}

if (process.env.EXPECT_ISOLATION_ERROR === "1") {
  await evaluate(`(() => {
    const text = document.querySelector('#source-text');
    text.value = 'This should show the local-server guidance.';
    text.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);

  while (Date.now() < timeoutAt) {
    const errorState = await evaluate(`(() => ({
      isolated: crossOriginIsolated,
      label: document.querySelector('#status-label')?.textContent || '',
      detail: document.querySelector('#status-detail')?.textContent || '',
    }))()`);
    if (errorState.label === "Could not start") {
      if (
        errorState.isolated
        || !errorState.detail.includes("dev_server.py")
      ) {
        throw new Error(`Isolation error UI failed: ${JSON.stringify(errorState)}`);
      }
      console.log("Missing-header guidance and Retry state passed");
      socket.close();
      process.exit(0);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Isolation error UI timed out");
}

const gainReset = await evaluate(`(async () => {
  const { PCMPlayerWorklet } = await import('./pocket/PCMPlayerWorklet.js?v=7');
  const context = new AudioContext({ sampleRate: 24000 });
  const player = new PCMPlayerWorklet(context, { minBufferBeforePlaybackMs: 220 });
  await player.initPromise;
  player.volume = 0.73;
  for (let index = 0; index < 5; index += 1) {
    player.reset();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await player.resume();
  await new Promise((resolve) => setTimeout(resolve, 120));
  const result = { configured: player.volume, output: player.gainNode.gain.value };
  await context.close();
  return result;
})()`);
if (Math.abs(gainReset.configured - 0.73) > 0.001 || Math.abs(gainReset.output - 0.73) > 0.001) {
  throw new Error(`Player gain reset failed: ${JSON.stringify(gainReset)}`);
}

const restoredPreferences = await evaluate(`(() => {
  const saved = JSON.parse(localStorage.getItem('ava-preferences-v1') || 'null');
  return saved ? {
    saved,
    expectedLanguage: ['english_2026-04', 'german', 'italian', 'portuguese', 'spanish'].includes(saved.language)
      ? saved.language
      : 'english_2026-04',
    language: document.querySelector('#language-select').value,
  } : null;
})()`);
if (
  restoredPreferences
  && restoredPreferences.language !== restoredPreferences.expectedLanguage
) {
  throw new Error(`Preference restoration failed: ${JSON.stringify(restoredPreferences)}`);
}

const isolated = await evaluate(`(() => {
  const text = document.querySelector('#source-text');
  const language = document.querySelector('#language-select');
  language.value = ${JSON.stringify(TEST_LANGUAGE)};
  language.dispatchEvent(new Event('change', { bubbles: true }));
  text.value = ${JSON.stringify(TEST_TEXT)};
  text.dispatchEvent(new Event('input', { bubbles: true }));
  return crossOriginIsolated;
})()`);
if (!isolated) throw new Error("ava is not cross-origin isolated");

let previousLabel = "";
let firstAudioSeen = false;
let streamPlaybackStarted = false;
let previousPlayedPercent = 0;
while (Date.now() < timeoutAt) {
  const state = await evaluate(`(() => ({
    label: document.querySelector('#status-label')?.textContent || '',
    detail: document.querySelector('#status-detail')?.textContent || '',
    received: Number(document.querySelector('#seek-slider')?.dataset.bufferedSamples || 0),
    position: Number(document.querySelector('#seek-slider')?.value || 0),
    playedPercent: Number.parseFloat(document.querySelector('#seek-wrap')?.style.getPropertyValue('--played')) || 0,
    busy: document.querySelector('#player')?.getAttribute('aria-busy') === 'true',
    seekDisabled: document.querySelector('#seek-slider')?.disabled
  }))()`);

  if (state.label && state.label !== previousLabel) {
    console.log(`${state.label}${state.detail ? ` — ${state.detail}` : ""}`);
    previousLabel = state.label;
  }

  if (!firstAudioSeen && state.received > 1 && !state.seekDisabled) {
    firstAudioSeen = true;
    console.log(`First streamed audio observed (${(state.received / 24000).toFixed(2)}s buffered)`);
  }

  if (firstAudioSeen && !streamPlaybackStarted && state.busy) {
    await evaluate(`document.querySelector('#play-button').click()`);
    streamPlaybackStarted = true;
  }

  if (state.playedPercent + 0.01 < previousPlayedPercent) {
    throw new Error(`Streaming playhead moved backward: ${previousPlayedPercent} -> ${state.playedPercent}`);
  }
  previousPlayedPercent = Math.max(previousPlayedPercent, state.playedPercent);

  if (firstAudioSeen && state.received > 1 && !state.busy) {
    const seekResult = await evaluate(`(() => {
      const seek = document.querySelector('#seek-slider');
      const step = Number(seek.step) || 1;
      const target = Math.round((Number(seek.max) / 2) / step) * step;
      seek.value = String(target);
      seek.dispatchEvent(new Event('input', { bubbles: true }));
      seek.dispatchEvent(new Event('change', { bubbles: true }));
      return { target, value: Number(seek.value), max: Number(seek.max), step };
    })()`);
    if (Math.abs(seekResult.value - seekResult.target) > seekResult.step) {
      throw new Error(`Seek failed: ${JSON.stringify(seekResult)}`);
    }
    console.log(`Session seek passed at ${(seekResult.value / 24000).toFixed(2)}s`);

    const controls = await evaluate(`(async () => {
      const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const seek = document.querySelector('#seek-slider');
      const playLabel = document.querySelector('#play-label');
      const playbackIconPath = document.querySelector('#playback-icon-path');
      const language = document.querySelector('#language-select');

      await delay(150);
      if (playLabel.textContent === 'Pause') {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
        await delay(150);
      }

      const beforeRemovedKeys = Number(seek.value);
      for (const key of ['k', 'j', 'l', ',', '.', 'm']) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      }
      await delay(100);
      const removedKeysStayedInactive = Number(seek.value) === beforeRemovedKeys;

      const languageBeforeShortcuts = language.value;
      language.focus();
      const focusedLeft = new KeyboardEvent('keydown', {
        key: 'ArrowLeft', bubbles: true, cancelable: true
      });
      language.dispatchEvent(focusedLeft);
      await delay(100);
      const afterLeft = Number(seek.value);
      const focusedRight = new KeyboardEvent('keydown', {
        key: 'ArrowRight', bubbles: true, cancelable: true
      });
      language.dispatchEvent(focusedRight);
      await delay(100);
      const afterRight = Number(seek.value);
      const languageIgnoredArrows = language.value === languageBeforeShortcuts
        && focusedLeft.defaultPrevented
        && focusedRight.defaultPrevented;

      const focusedPlay = new KeyboardEvent('keydown', {
        key: ' ', bubbles: true, cancelable: true
      });
      language.dispatchEvent(focusedPlay);
      await delay(150);
      const focusedSpaceStartedPlayback = focusedPlay.defaultPrevented
        && playLabel.textContent === 'Pause';
      const focusedPause = new KeyboardEvent('keydown', {
        key: ' ', bubbles: true, cancelable: true
      });
      language.dispatchEvent(focusedPause);
      await delay(150);
      const focusedSpacePausedPlayback = focusedPause.defaultPrevented
        && playLabel.textContent === 'Play';

      seek.value = seek.max;
      seek.dispatchEvent(new Event('input', { bubbles: true }));
      seek.dispatchEvent(new Event('change', { bubbles: true }));
      await delay(150);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
      const replayPositions = [];
      for (let index = 0; index < 7; index += 1) {
        await delay(50);
        replayPositions.push(Number(seek.value));
      }
      const pausePath = 'M8 7h3v10H8zM13 7h3v10h-3z';
      const playPath = 'm9 7 8 5-8 5z';
      const replayStarted = playLabel.textContent === 'Pause'
        && playbackIconPath.getAttribute('d') === pausePath
        && Number(seek.value) < Number(seek.max);

      const beforePause = Number(seek.value);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
      await delay(150);
      const pausedCorrectly = playLabel.textContent === 'Play'
        && playbackIconPath.getAttribute('d') === playPath;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
      await delay(350);
      const resumedCorrectly = playLabel.textContent === 'Pause'
        && playbackIconPath.getAttribute('d') === pausePath
        && Number(seek.value) > beforePause;
      const pauseResumeState = {
        pausedCorrectly,
        resumedCorrectly,
        beforePause,
        afterResume: Number(seek.value),
        max: Number(seek.max),
        replayPositions,
        label: playLabel.textContent,
        icon: playbackIconPath.getAttribute('d'),
      };

      const text = document.querySelector('#source-text');
      const textareaShortcutsStayedNative = [' ', 'ArrowLeft', 'ArrowRight'].every((key) => {
        const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
        return text.dispatchEvent(event) && !event.defaultPrevented;
      });
      text.value = ${JSON.stringify(`${TEST_TEXT} This draft should be replaced.`)};
      text.dispatchEvent(new Event('input', { bubbles: true }));
      const editClearedOldAudio = seek.disabled
        && Number(seek.value) === 0
        && Number(seek.max) === 1
        && playLabel.textContent === 'Play'
        && playbackIconPath.getAttribute('d') === playPath;
      await delay(120);
      text.value = ${JSON.stringify(`${TEST_TEXT} This is the updated reading.`)};
      text.dispatchEvent(new Event('input', { bubbles: true }));
      const editBecameBusy = document.querySelector('#player').getAttribute('aria-busy') === 'true';
      const editDeadline = Date.now() + 60_000;
      while (Date.now() < editDeadline && document.querySelector('#player').getAttribute('aria-busy') === 'true') {
        await delay(250);
      }
      const editRegenerated = editBecameBusy
        && document.querySelector('#player').getAttribute('aria-busy') === 'false'
        && Number(seek.max) > 1;

      language.value = ${JSON.stringify(TEST_LANGUAGE)};
      language.dispatchEvent(new Event('change', { bubbles: true }));
      const preferences = JSON.parse(localStorage.getItem('ava-preferences-v1'));
      const removedControlsAbsent = [
        '#rewind-button',
        '#forward-button',
        '#mute-button',
        '#volume-slider',
        '#generate-button',
        '#player-message',
        '#live-badge',
      ].every((selector) => !document.querySelector(selector));
      const timeFormat = document.querySelector('.time-line')?.textContent.replace(/\s+/g, ' ').trim();

      const cache = await caches.open('ava-pocket-tts-en-58a6d00-d0c0c79-v1');
      const cacheUrls = (await cache.keys()).map((request) => request.url);
      const modelPinned = cacheUrls.some((url) => url.includes('58a6d00cf13d239b6748cb0769f35c580a8f606c/onnx/${TEST_LANGUAGE}/'));
      const voicesPinned = cacheUrls.some((url) => url.includes('e041936c75475d350b405bc870bcf7c22da4e9e6/languages/${TEST_LANGUAGE}/embeddings/${TEST_VOICE}.safetensors'));

      return {
        removedKeysStayedInactive,
        arrowsWorked: afterLeft < beforeRemovedKeys && afterRight > afterLeft,
        focusedShortcutsWorked: languageIgnoredArrows
          && focusedSpaceStartedPlayback
          && focusedSpacePausedPlayback,
        textareaShortcutsStayedNative,
        replayStarted,
        pauseResumePassed: pausedCorrectly && resumedCorrectly,
        pauseResumeState,
        editClearedOldAudio,
        editRegenerated,
        removedControlsAbsent,
        timeFormat,
        preferences,
        modelPinned,
        voicesPinned,
        modelState: document.querySelector('#model-state').textContent,
      };
    })()`);

    if (!controls.removedKeysStayedInactive) throw new Error("A removed keyboard shortcut is still active");
    if (!controls.removedControlsAbsent) throw new Error("A removed player control is still rendered");
    if (!/^\d+:\d{2} \/ \d+:\d{2}$/.test(controls.timeFormat)) {
      throw new Error(`Time display format failed: ${controls.timeFormat}`);
    }
    if (!controls.arrowsWorked) throw new Error(`Arrow shortcuts failed: ${JSON.stringify(controls)}`);
    if (!controls.focusedShortcutsWorked) throw new Error(`Focused shortcuts failed: ${JSON.stringify(controls)}`);
    if (!controls.textareaShortcutsStayedNative) throw new Error(`Textarea shortcuts were intercepted: ${JSON.stringify(controls)}`);
    if (!controls.replayStarted) throw new Error(`Replay failed: ${JSON.stringify(controls)}`);
    if (!controls.pauseResumePassed) throw new Error(`Pause/resume state failed: ${JSON.stringify(controls)}`);
    if (!controls.editClearedOldAudio) throw new Error(`Edit did not clear old audio: ${JSON.stringify(controls)}`);
    if (!controls.editRegenerated) throw new Error(`Automatic edit regeneration failed: ${JSON.stringify(controls)}`);
    if (controls.preferences?.language !== TEST_LANGUAGE) {
      throw new Error(`Preference persistence failed: ${JSON.stringify(controls.preferences)}`);
    }
    if (!controls.modelPinned || !controls.voicesPinned || controls.modelState !== "Model cached") {
      throw new Error(`Pinned cache check failed: ${JSON.stringify(controls)}`);
    }
    console.log("Automatic regeneration, shortcuts, replay, preferences, and pinned cache passed");
    socket.close();
    process.exit(0);
  }

  if (/could not|failed/i.test(state.label)) {
    throw new Error(`${state.label}: ${state.detail}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}

socket.close();
throw new Error("Pocket TTS smoke test timed out");
