const SAMPLE_RATE = 24000;
const MAX_TEXT_LENGTH = 12000;
const MAX_SESSION_SECONDS = 15 * 60;
const MAX_SESSION_SAMPLES = MAX_SESSION_SECONDS * SAMPLE_RATE;
const AUTO_GENERATE_DELAY = 700;
const MODEL_REVISION = "58a6d00cf13d239b6748cb0769f35c580a8f606c";
const VOICE_REVISION = "e041936c75475d350b405bc870bcf7c22da4e9e6";
// Keep the original cache name so existing English model downloads are reused.
const MODEL_CACHE_NAME = "ava-pocket-tts-en-58a6d00-d0c0c79-v1";
const MODEL_CACHE_MARKER_PREFIX = "ava-pocket-ready-58a6d00-e041936-v2";
const PREFERENCES_KEY = "ava-preferences-v1";
const DEFAULT_LANGUAGE = "english_2026-04";
const LANGUAGE_VOICES = {
  [DEFAULT_LANGUAGE]: "alba",
  german: "juergen",
  italian: "giovanni",
  portuguese: "rafael",
  spanish: "lola",
};
const SUPPORTED_LANGUAGES = new Set(Object.keys(LANGUAGE_VOICES));
const MODEL_CACHE_ASSETS = [
  "/bundle.json",
  "/text_conditioner_int8.onnx",
  "/flow_lm_main_int8.onnx",
  "/flow_lm_flow_int8.onnx",
  "/mimi_decoder_int8.onnx",
  "/tokenizer.model",
  "/bos_before_voice.npy",
];

const elements = {
  text: document.querySelector("#source-text"),
  language: document.querySelector("#language-select"),
  modelState: document.querySelector("#model-state"),
  status: document.querySelector("#status"),
  statusLabel: document.querySelector("#status-label"),
  statusDetail: document.querySelector("#status-detail"),
  progress: document.querySelector("#progress"),
  progressBar: document.querySelector("#progress-bar"),
  player: document.querySelector("#player"),
  seekWrap: document.querySelector("#seek-wrap"),
  seek: document.querySelector("#seek-slider"),
  currentTime: document.querySelector("#current-time"),
  duration: document.querySelector("#duration"),
  play: document.querySelector("#play-button"),
  playLabel: document.querySelector("#play-label"),
  playbackIconPath: document.querySelector("#playback-icon-path"),
  toast: document.querySelector("#toast"),
};

document.documentElement.dataset.crossOriginIsolated = String(crossOriginIsolated);

let worker = null;
let modelReady = false;
let loadedLanguage = null;
let selectedVoice = null;
let modelLoadRequest = null;
let generationRequest = null;
let isLoading = false;
let isGenerating = false;
let isStopping = false;
let acceptGenerationAudio = false;
let generationRevision = 0;
let generationTimer = null;
let queuedGeneration = null;

let audioContext = null;
let streamPlayer = null;
let audioChunks = [];
let receivedSamples = 0;
let playbackBaseSamples = 0;
let playbackPositionSamples = 0;
let estimatedDurationSamples = 1;
let displayedPlaybackRatio = 0;
let lastTimelinePositionSamples = 0;
let streamEnded = true;
let sessionAvailable = false;
let isPlaying = false;
let wantsPlayback = false;
let isSeeking = false;
let firstChunkSeen = false;
let memoryLimitReached = false;
let toastTimer = null;

let pendingServiceWorker = null;
let serviceWorkerReloadPending = false;

function storageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ava still works if browser storage is unavailable.
  }
}

function storageRemove(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // Old data is harmless if browser storage is unavailable.
  }
}

function loadPreferences() {
  try {
    const saved = JSON.parse(storageGet(PREFERENCES_KEY) || "null");
    if (!saved || typeof saved !== "object") return;

    if (typeof saved.language === "string" && SUPPORTED_LANGUAGES.has(saved.language)) {
      elements.language.value = saved.language;
    }

  } catch {
    // Ignore malformed preferences.
  }
}

function savePreferences() {
  storageSet(PREFERENCES_KEY, JSON.stringify({
    language: elements.language.value,
  }));
}

function showStatus(label, detail = "", percent = null) {
  elements.status.hidden = false;
  elements.statusLabel.textContent = label;
  elements.statusDetail.textContent = detail;
  elements.progress.hidden = percent === false;
  if (percent === false) return;

  const determinate = Number.isFinite(percent);
  elements.progress.classList.toggle("is-indeterminate", !determinate);
  elements.progressBar.style.width = determinate
    ? `${Math.min(100, Math.max(0, percent))}%`
    : "36%";
}

function showToast(message) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  toastTimer = setTimeout(() => {
    elements.toast.hidden = true;
  }, 1300);
}

function formatTime(samples) {
  const total = Math.max(0, Math.floor(samples / SAMPLE_RATE));
  const seconds = String(total % 60).padStart(2, "0");
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}:${seconds}`;
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${seconds}`;
}

function estimateDurationSamples(text) {
  const words = text.trim().split(/\s+/u).filter(Boolean).length;
  const characters = Array.from(text).filter((character) => /[\p{L}\p{N}]/u.test(character)).length;
  const punctuation = (text.match(/[.!?;:,]/gu) || []).length;
  const seconds = Math.max(2, words / 2.2, characters / 14) + punctuation * 0.12;
  return Math.ceil(seconds * SAMPLE_RATE);
}

function timelineScaleSamples() {
  if (streamEnded && receivedSamples > 0) return receivedSamples;
  return Math.max(1, estimatedDurationSamples, receivedSamples);
}

function updateSeekVisual(playedRatio, bufferedRatio) {
  const played = Math.min(1, Math.max(0, playedRatio));
  const buffered = Math.min(1, Math.max(played, bufferedRatio));
  elements.seekWrap.style.setProperty("--played", `${played * 100}%`);
  elements.seekWrap.style.setProperty("--buffered", `${buffered * 100}%`);
}

function updateActivityState() {
  const busy = Boolean(generationTimer || queuedGeneration || isLoading || isGenerating || isStopping);
  elements.player.setAttribute("aria-busy", String(busy));
}

function updatePlayerControls() {
  const enabled = sessionAvailable;
  elements.seek.disabled = !enabled;
  elements.play.disabled = !enabled;
  elements.player.classList.toggle("is-empty", !enabled);
}

function updateTimeline() {
  const scale = timelineScaleSamples();
  const position = Math.min(receivedSamples, Math.max(0, playbackPositionSamples));
  const actualRatio = position / scale;

  if (position < lastTimelinePositionSamples) {
    displayedPlaybackRatio = actualRatio;
  } else {
    displayedPlaybackRatio = Math.max(displayedPlaybackRatio, actualRatio);
  }
  if (streamEnded && receivedSamples > 0 && position >= receivedSamples - 1) {
    displayedPlaybackRatio = 1;
  }
  lastTimelinePositionSamples = position;

  elements.seek.max = String(scale);
  elements.seek.dataset.bufferedSamples = String(receivedSamples);
  if (!isSeeking) elements.seek.value = String(Math.round(position));
  elements.currentTime.textContent = formatTime(position);
  elements.duration.textContent = formatTime(receivedSamples);
  elements.seek.setAttribute(
    "aria-valuetext",
    `${formatTime(position)} of ${formatTime(receivedSamples)}`,
  );
  updateSeekVisual(displayedPlaybackRatio, receivedSamples / scale);
  updatePlayerControls();
}

function updatePlayState() {
  const playing = wantsPlayback && isPlaying && audioContext?.state === "running";
  elements.playbackIconPath.setAttribute(
    "d",
    playing ? "M8 7h3v10H8zM13 7h3v10h-3z" : "m9 7 8 5-8 5z",
  );
  elements.playLabel.textContent = playing ? "Pause" : "Play";
  elements.player.classList.toggle("is-playing", playing);
}

function failWorker(error) {
  const failedWorker = worker;
  const pendingLoad = modelLoadRequest;
  const pendingGeneration = generationRequest;

  worker = null;
  modelReady = false;
  loadedLanguage = null;
  selectedVoice = null;
  modelLoadRequest = null;
  generationRequest = null;
  failedWorker?.terminate();

  pendingLoad?.reject(error);
  pendingGeneration?.reject(error);
}

function stopAtSessionLimit() {
  if (memoryLimitReached) return;
  memoryLimitReached = true;
  isStopping = true;
  updateActivityState();
  showStatus("Stopping", "15-minute reading limit reached", false);
  worker?.postMessage({ type: "stop" });
}

function getWorker() {
  if (worker) return worker;

  worker = new Worker(new URL("./pocket/inference-worker.js?v=11", import.meta.url), {
    type: "module",
    name: "ava-pocket-tts",
  });

  worker.addEventListener("message", (event) => {
    const message = event.data || {};

    if (message.type === "model_progress") {
      const isCached = message.status === "cached";
      const percent = message.total > 0 ? (message.loaded / message.total) * 100 : null;
      showStatus(
        isCached ? "Opening model" : "Downloading model",
        isCached ? "From browser storage" : "Cached for next time",
        percent,
      );
      return;
    }

    if (message.type === "status") {
      if (modelLoadRequest && message.state === "loading") {
        showStatus("Preparing model", "First use takes a moment", null);
      }
      return;
    }

    if (message.type === "voices_loaded") {
      if (message.language === modelLoadRequest?.language || message.language === loadedLanguage) {
        selectedVoice = message.defaultVoice || null;
      }
      return;
    }

    if (message.type === "bundle_loaded") {
      if (!modelLoadRequest || message.language !== modelLoadRequest.language) return;
      loadedLanguage = message.language;
      modelReady = true;
      modelLoadRequest?.resolve(true);
      modelLoadRequest = null;
      return;
    }

    if (message.type === "loaded") return;

    if (message.type === "audio_chunk" && message.data) {
      if (!acceptGenerationAudio) return;
      let data = message.data instanceof Float32Array
        ? message.data
        : new Float32Array(message.data);
      const remaining = MAX_SESSION_SAMPLES - receivedSamples;

      if (remaining <= 0) {
        stopAtSessionLimit();
        return;
      }
      if (data.length > remaining) data = data.slice(0, remaining);

      const start = receivedSamples;
      receivedSamples += data.length;
      audioChunks.push({ start, end: receivedSamples, data });
      sessionAvailable = true;
      if (wantsPlayback) streamPlayer?.playAudio(data);

      if (!firstChunkSeen) {
        firstChunkSeen = true;
        elements.status.hidden = true;
      }

      updateTimeline();
      if (receivedSamples >= MAX_SESSION_SAMPLES) stopAtSessionLimit();
      return;
    }

    if (message.type === "stream_ended") {
      streamEnded = true;
      if (wantsPlayback) streamPlayer?.notifyStreamEnded();
      updateTimeline();
      generationRequest?.resolve({ cancelled: false });
      generationRequest = null;
      return;
    }

    if (message.type === "generation_cancelled") {
      generationRequest?.resolve({ cancelled: true });
      generationRequest = null;
      return;
    }

    if (message.type === "error") {
      failWorker(new Error(message.error || "Pocket TTS failed"));
    }
  });

  worker.addEventListener("error", (event) => {
    event.preventDefault();
    failWorker(new Error(event.message || "Pocket TTS stopped unexpectedly"));
  });

  return worker;
}

async function ensurePlayer() {
  if (!streamPlayer) {
    const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextConstructor) throw new Error("AudioWorklet is unavailable in this browser");

    audioContext = new AudioContextConstructor({ sampleRate: SAMPLE_RATE, latencyHint: "interactive" });
    const { PCMPlayerWorklet } = await import("./pocket/PCMPlayerWorklet.js?v=7");
    streamPlayer = new PCMPlayerWorklet(audioContext, { minBufferBeforePlaybackMs: 220 });
    await streamPlayer.initPromise;

    streamPlayer.addEventListener("firstPlayback", () => {
      isPlaying = wantsPlayback && audioContext?.state === "running";
      updatePlayState();
    });

    streamPlayer.addEventListener("position", (event) => {
      if (isSeeking) return;
      playbackPositionSamples = Math.min(
        receivedSamples,
        playbackBaseSamples + Number(event.detail?.samplesPlayed || 0),
      );
      updateTimeline();
    });

    streamPlayer.addEventListener("audioEnded", () => {
      isPlaying = false;
      wantsPlayback = false;
      playbackPositionSamples = receivedSamples;
      updateTimeline();
      updatePlayState();
      activatePendingServiceWorkerIfIdle();
    });
  }

  return streamPlayer;
}

async function requestPersistentStorage() {
  try {
    if (!navigator.storage?.persist) return false;
    return (await navigator.storage.persisted()) || (await navigator.storage.persist());
  } catch {
    return false;
  }
}

function modelCacheMarker(language) {
  return `${MODEL_CACHE_MARKER_PREFIX}-${language}`;
}

async function modelIsCached(language = elements.language.value) {
  try {
    if (!("caches" in window)) return Boolean(storageGet(modelCacheMarker(language)));
    const names = await caches.keys();
    if (!names.includes(MODEL_CACHE_NAME)) return false;
    const cache = await caches.open(MODEL_CACHE_NAME);
    const urls = (await cache.keys()).map((request) => request.url);
    const hasModels = MODEL_CACHE_ASSETS.every((asset) => urls.some((url) => (
      url.includes(`/${MODEL_REVISION}/onnx/${language}/`) && url.endsWith(asset)
    )));
    const voice = LANGUAGE_VOICES[language];
    const hasVoice = urls.some((url) => (
      url.includes(`/${VOICE_REVISION}/languages/${language}/embeddings/`)
      && url.endsWith(`/${voice}.safetensors`)
    ));
    return hasModels && hasVoice;
  } catch {
    return false;
  }
}

async function updateModelState() {
  const language = elements.language.value;
  const cached = await modelIsCached(language);
  if (language !== elements.language.value) return;
  if (modelLoadRequest?.language === language) {
    elements.modelState.textContent = "Loading model…";
    elements.modelState.classList.remove("is-ready");
    return;
  }
  elements.modelState.textContent = cached ? "Model cached" : "Runs locally";
  elements.modelState.classList.toggle("is-ready", cached);
}

function ensureModel(language) {
  if (modelReady && loadedLanguage === language) return Promise.resolve(true);
  if (modelLoadRequest) {
    if (modelLoadRequest.language === language) return modelLoadRequest.promise;
    return Promise.reject(new Error("A different language is already loading"));
  }
  if (!crossOriginIsolated) {
    return Promise.reject(new Error("ava needs HTTPS or python3 dev_server.py 8000"));
  }

  const switchingLanguage = Boolean(worker && loadedLanguage && loadedLanguage !== language);
  const pocketWorker = getWorker();
  const promise = new Promise((resolve, reject) => {
    modelLoadRequest = { promise: null, resolve, reject, language };
  });
  modelLoadRequest.promise = promise;
  modelReady = false;
  elements.modelState.textContent = "Loading model…";
  elements.modelState.classList.remove("is-ready");
  void requestPersistentStorage();
  showStatus("Preparing model", "Cached in this browser after download", null);
  pocketWorker.postMessage({
    type: switchingLanguage ? "set_language" : "load",
    data: { language },
  });

  return promise.then(async (result) => {
    storageSet(modelCacheMarker(language), new Date().toISOString());
    await updateModelState();
    return result;
  }).catch(async (error) => {
    await updateModelState();
    throw error;
  });
}

function resetSession(text) {
  const continuePlayback = wantsPlayback && audioContext?.state === "running";
  streamPlayer?.reset();
  audioChunks = [];
  receivedSamples = 0;
  playbackBaseSamples = 0;
  playbackPositionSamples = 0;
  estimatedDurationSamples = estimateDurationSamples(text);
  displayedPlaybackRatio = 0;
  lastTimelinePositionSamples = 0;
  streamEnded = false;
  sessionAvailable = false;
  isPlaying = false;
  wantsPlayback = continuePlayback;
  firstChunkSeen = false;
  memoryLimitReached = false;
  elements.seek.value = "0";
  elements.seek.max = String(estimatedDurationSamples);
  updateSeekVisual(0, 0);
  updateTimeline();
  updatePlayState();
}

function clearSession() {
  acceptGenerationAudio = false;
  streamPlayer?.reset();
  audioChunks = [];
  receivedSamples = 0;
  playbackBaseSamples = 0;
  playbackPositionSamples = 0;
  estimatedDurationSamples = 1;
  displayedPlaybackRatio = 0;
  lastTimelinePositionSamples = 0;
  streamEnded = true;
  sessionAvailable = false;
  isPlaying = false;
  wantsPlayback = false;
  firstChunkSeen = false;
  memoryLimitReached = false;
  elements.seek.value = "0";
  elements.seek.max = "1";
  updateSeekVisual(0, 0);
  updateTimeline();
  updatePlayState();
}

function generateWithPocket(text, language) {
  if (generationRequest) return Promise.reject(new Error("Speech is already being generated"));
  const promise = new Promise((resolve, reject) => {
    generationRequest = { resolve, reject };
  });
  getWorker().postMessage({ type: "generate", data: { text, language, voice: selectedVoice } });
  return promise;
}

function friendlyError(error) {
  const message = String(error?.message || error || "");
  if (!crossOriginIsolated || /cross.?origin|dev_server\.py/i.test(message)) {
    return "Use HTTPS or run python3 dev_server.py 8000.";
  }
  if (/failed to fetch|network|download|load failed|fetch/i.test(message)) {
    return "The model download failed. Check your connection and retry.";
  }
  if (/memory|allocation|out of bounds/i.test(message)) {
    return "This device ran out of memory. Try shorter text.";
  }
  if (/audioworklet|audio context/i.test(message)) {
    return "This browser cannot play streamed audio.";
  }
  if (/voice|language bundle/i.test(message)) {
    return "This language could not be prepared. Reload ava and retry.";
  }
  return "Reload ava and retry.";
}

async function generateSpeech(job) {
  isLoading = true;
  updateActivityState();
  const playerPromise = ensurePlayer();

  try {
    await Promise.all([ensureModel(job.language), playerPromise]);
    if (job.revision !== generationRevision) return;

    resetSession(job.text);
    acceptGenerationAudio = true;
    isLoading = false;
    isGenerating = true;
    updateActivityState();
    showStatus("Generating", "", null);

    const result = await generateWithPocket(job.text, job.language);
    if (memoryLimitReached) {
      showStatus("Stopped", "15-minute reading limit reached", false);
    } else if (!result.cancelled) {
      elements.status.hidden = true;
    }
  } catch (error) {
    if (modelLoadRequest?.language === job.language) failWorker(error);
    console.error(error);
    acceptGenerationAudio = false;
    streamEnded = true;
    if (wantsPlayback) streamPlayer?.notifyStreamEnded();
    if (job.revision === generationRevision) {
      const message = friendlyError(error);
      showStatus(sessionAvailable ? "Could not finish" : "Could not start", message, false);
      showToast(message);
    }
  } finally {
    acceptGenerationAudio = false;
    isLoading = false;
    isGenerating = false;
    isStopping = false;
    updateActivityState();
    updateTimeline();
    updatePlayState();
    activatePendingServiceWorkerIfIdle();
    if (queuedGeneration && !generationTimer) queueMicrotask(runQueuedGeneration);
  }
}

function runQueuedGeneration() {
  if (isLoading || isGenerating || !queuedGeneration) return;
  const job = queuedGeneration;
  queuedGeneration = null;
  updateActivityState();
  void generateSpeech(job);
}

function scheduleGeneration(delay = AUTO_GENERATE_DELAY) {
  generationRevision += 1;
  clearTimeout(generationTimer);
  generationTimer = null;
  queuedGeneration = null;

  acceptGenerationAudio = false;
  if (isGenerating && !isStopping) {
    isStopping = true;
    worker?.postMessage({ type: "stop" });
  }
  clearSession();
  elements.status.hidden = true;

  const text = elements.text.value.trim();
  if (!text) {
    updateActivityState();
    return;
  }

  if (text.length > MAX_TEXT_LENGTH) {
    showToast("Keep the text under 12,000 characters");
    updateActivityState();
    return;
  }

  generationTimer = setTimeout(() => {
    generationTimer = null;
    queuedGeneration = {
      revision: generationRevision,
      text: elements.text.value.trim(),
      language: elements.language.value,
    };

    if (!isLoading && !isGenerating) {
      runQueuedGeneration();
    }
    updateActivityState();
  }, delay);
  updateActivityState();
}

function queueFromPosition(targetSamples) {
  streamPlayer.reset();
  playbackBaseSamples = targetSamples;
  playbackPositionSamples = targetSamples;

  for (const chunk of audioChunks) {
    if (chunk.end <= targetSamples) continue;
    const offset = Math.max(0, targetSamples - chunk.start);
    const segment = offset > 0 ? chunk.data.subarray(offset) : chunk.data;
    if (segment.length) streamPlayer.playAudio(segment);
  }

  if (streamEnded) streamPlayer.notifyStreamEnded();
}

async function seekToSamples(samples, announce = true) {
  if (!sessionAvailable || !streamPlayer) return;
  const target = Math.round(Math.min(receivedSamples, Math.max(0, samples)));
  const shouldContinue = wantsPlayback && isPlaying && audioContext?.state === "running";

  if (!shouldContinue && audioContext?.state === "running") {
    try {
      await audioContext.suspend();
    } catch {
      // The queued position is still valid if suspension is unavailable.
    }
  }

  wantsPlayback = shouldContinue;
  queueFromPosition(target);
  isPlaying = shouldContinue && (!streamEnded || target < receivedSamples);
  displayedPlaybackRatio = target / timelineScaleSamples();
  lastTimelinePositionSamples = target;
  updateTimeline();
  updatePlayState();
  if (announce) showToast(formatTime(target));
}

function seekBy(seconds) {
  if (!sessionAvailable) return;
  void seekToSamples(playbackPositionSamples + seconds * SAMPLE_RATE, false);
  showToast(`${seconds > 0 ? "+" : ""}${seconds}s`);
}

async function togglePlayback() {
  if (!sessionAvailable || !audioContext) return;
  const atEnd = streamEnded && playbackPositionSamples >= receivedSamples - SAMPLE_RATE / 10;

  try {
    if (wantsPlayback && audioContext.state === "running") {
      wantsPlayback = false;
      await audioContext.suspend();
      isPlaying = false;
    } else {
      queueFromPosition(atEnd ? 0 : playbackPositionSamples);
      wantsPlayback = true;
      await audioContext.resume();
      isPlaying = true;
    }
    updateTimeline();
    updatePlayState();
    activatePendingServiceWorkerIfIdle();
  } catch {
    showToast("Playback could not start");
  }
}

function isTextEditingTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.tagName === "TEXTAREA") return true;
  if (target.tagName !== "INPUT") return false;
  return !["button", "checkbox", "radio", "range", "reset", "submit"].includes(target.type);
}

function handleKeyboard(event) {
  if (isTextEditingTarget(event.target)) return;
  if (![" ", "ArrowLeft", "ArrowRight"].includes(event.key)) return;

  if (event.key === " ") {
    event.preventDefault();
    if (event.repeat || !sessionAvailable) return;
    void togglePlayback();
  } else if (event.key === "ArrowLeft") {
    event.preventDefault();
    if (!sessionAvailable) return;
    seekBy(-5);
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    if (!sessionAvailable) return;
    seekBy(5);
  }
}

function appIsIdleForUpdate() {
  return !isLoading && !isGenerating && !isStopping && !isPlaying && !sessionAvailable;
}

function activatePendingServiceWorkerIfIdle() {
  if (!pendingServiceWorker || serviceWorkerReloadPending || !appIsIdleForUpdate()) return;
  serviceWorkerReloadPending = true;
  pendingServiceWorker.postMessage({ type: "SKIP_WAITING" });
}

function watchServiceWorkerRegistration(registration) {
  const rememberWaitingWorker = () => {
    if (!registration.waiting || !navigator.serviceWorker.controller) return;
    pendingServiceWorker = registration.waiting;
    activatePendingServiceWorkerIfIdle();
  };

  rememberWaitingWorker();
  registration.addEventListener("updatefound", () => {
    const installing = registration.installing;
    if (!installing) return;
    installing.addEventListener("statechange", () => {
      if (installing.state === "installed") rememberWaitingWorker();
    });
  });
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (serviceWorkerReloadPending) window.location.reload();
  });

  window.addEventListener("load", async () => {
    try {
      const registration = await navigator.serviceWorker.register("./sw.js");
      watchServiceWorkerRegistration(registration);
      void registration.update();
    } catch {
      // The app remains usable without its offline shell.
    }
  });
}

async function removeLegacyEngineData() {
  try {
    await Promise.all([
      caches.delete("transformers-cache"),
      caches.delete("ava-pocket-tts-english-v1"),
    ]);
  } catch {
    // Old data is harmless if browser storage is unavailable.
  }
  storageRemove("ava-engine-cache-v1");
  storageRemove("ava-pocket-ready-v1");
}

elements.play.addEventListener("click", () => void togglePlayback());
elements.play.addEventListener("pointerup", () => elements.play.blur());
elements.text.addEventListener("input", () => scheduleGeneration());

elements.language.addEventListener("change", () => {
  savePreferences();
  void updateModelState();
  scheduleGeneration(0);
});

elements.seek.addEventListener("pointerdown", () => {
  isSeeking = true;
});
elements.seek.addEventListener("input", () => {
  const scale = timelineScaleSamples();
  const value = Math.min(receivedSamples, Number(elements.seek.value));
  playbackPositionSamples = value;
  displayedPlaybackRatio = value / scale;
  lastTimelinePositionSamples = value;
  updateSeekVisual(displayedPlaybackRatio, receivedSamples / scale);
  elements.currentTime.textContent = formatTime(value);
  elements.seek.setAttribute(
    "aria-valuetext",
    `${formatTime(value)} of ${formatTime(receivedSamples)}`,
  );
});
elements.seek.addEventListener("change", () => {
  void seekToSamples(playbackPositionSamples, false);
  isSeeking = false;
});
elements.seek.addEventListener("pointerup", () => {
  if (!isSeeking) return;
  void seekToSamples(playbackPositionSamples, false);
  isSeeking = false;
});
elements.seek.addEventListener("pointercancel", () => {
  isSeeking = false;
  updateTimeline();
});

document.addEventListener("keydown", handleKeyboard, true);

loadPreferences();
updateSeekVisual(0, 0);
updateActivityState();
updatePlayerControls();
updateTimeline();
updatePlayState();
void removeLegacyEngineData();
void updateModelState();
registerServiceWorker();
