const SAMPLE_RATE = 24000;
const MAX_TEXT_LENGTH = 12000;
const MAX_SESSION_SECONDS = 15 * 60;
const MAX_SESSION_SAMPLES = MAX_SESSION_SECONDS * SAMPLE_RATE;
const AUTO_GENERATE_DELAY = 700;
const MAX_VOICE_SECONDS = 10;
const MIN_VOICE_SECONDS = 3;
const MODEL_REVISION = "58a6d00cf13d239b6748cb0769f35c580a8f606c";
const VOICE_REVISION = "e041936c75475d350b405bc870bcf7c22da4e9e6";
// Keep the original cache name so existing English model downloads are reused.
const MODEL_CACHE_NAME = "ava-pocket-tts-en-58a6d00-d0c0c79-v1";
const MODEL_CACHE_MARKER_PREFIX = "ava-pocket-ready-58a6d00-e041936-v2";
const PREFERENCES_KEY = "ava-preferences-v1";
const THEME_KEY = "ava-theme-v1";
const VOICE_DATABASE_NAME = "ava-voices-v1";
const VOICE_STORE_NAME = "voices";
const DEFAULT_LANGUAGE = "english_2026-04";
const LANGUAGE_DETAILS = {
  [DEFAULT_LANGUAGE]: { label: "English", voice: "alba", bytes: 131658438 },
  german: { label: "German", voice: "juergen", bytes: 131708069 },
  italian: { label: "Italian", voice: "giovanni", bytes: 130086289 },
  portuguese: { label: "Portuguese", voice: "rafael", bytes: 131660084 },
  spanish: { label: "Spanish", voice: "lola", bytes: 131414218 },
};
const LANGUAGE_VOICES = {
  [DEFAULT_LANGUAGE]: LANGUAGE_DETAILS[DEFAULT_LANGUAGE].voice,
  german: LANGUAGE_DETAILS.german.voice,
  italian: LANGUAGE_DETAILS.italian.voice,
  portuguese: LANGUAGE_DETAILS.portuguese.voice,
  spanish: LANGUAGE_DETAILS.spanish.voice,
};
const LANGUAGE_BUILTIN_VOICES = {
  [DEFAULT_LANGUAGE]: ["alba"],
  german: ["juergen"],
  italian: ["giovanni"],
  portuguese: ["rafael"],
  spanish: ["lola"],
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
  voice: document.querySelector("#voice-select"),
  clone: document.querySelector("#clone-button"),
  modelStorage: document.querySelector("#model-storage"),
  modelState: document.querySelector("#model-state"),
  modelCacheList: document.querySelector("#model-cache-list"),
  clonedVoiceList: document.querySelector("#cloned-voice-list"),
  themeToggle: document.querySelector("#theme-toggle"),
  themeIconPath: document.querySelector("#theme-icon-path"),
  themeColor: document.querySelector("#theme-color"),
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
  download: document.querySelector("#download-button"),
  voiceDialog: document.querySelector("#voice-dialog"),
  voiceForm: document.querySelector("#voice-form"),
  voiceDialogClose: document.querySelector("#voice-dialog-close"),
  voiceName: document.querySelector("#voice-name"),
  record: document.querySelector("#record-button"),
  recordLabel: document.querySelector("#record-label"),
  recordStatus: document.querySelector("#record-status"),
  toast: document.querySelector("#toast"),
};

document.documentElement.dataset.crossOriginIsolated = String(crossOriginIsolated);

let worker = null;
let modelReady = false;
let loadedLanguage = null;
let selectedVoice = null;
let voiceSelections = {};
let modelLoadRequest = null;
let generationRequest = null;
let voiceRequest = null;
let activeWorkerCustomVoices = new Set();
let isLoading = false;
let isGenerating = false;
let isStopping = false;
let isVoiceTask = false;
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
let downloadReady = false;
let isExporting = false;
let ignoreNextStreamEnd = false;
let isPlaying = false;
let wantsPlayback = false;
let isSeeking = false;
let firstChunkSeen = false;
let memoryLimitReached = false;
let toastTimer = null;
let modelStorageRevision = 0;
let voiceStorageRevision = 0;
let voiceOptionsRevision = 0;
let voiceDatabasePromise = null;

let mediaRecorder = null;
let microphoneStream = null;
let recordingChunks = [];
let recordingStartedAt = 0;
let recordingTimer = null;
let recordingStopTimer = null;

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

function currentTheme() {
  const explicit = document.documentElement.dataset.theme;
  if (explicit === "light" || explicit === "dark") return explicit;
  return matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function updateThemeUi() {
  const theme = currentTheme();
  const next = theme === "light" ? "dark" : "light";
  const label = `Use ${next} theme`;
  elements.themeToggle.setAttribute("aria-label", label);
  elements.themeToggle.title = label;
  elements.themeColor.content = theme === "light" ? "#f4f1ed" : "#09090b";
  elements.themeIconPath.setAttribute("d", theme === "light"
    ? "M12.7 2.2a9.8 9.8 0 1 0 9.1 13.5 1 1 0 0 0-1.4-1.2 7.4 7.4 0 0 1-8.9-10.8 1 1 0 0 0 1.2-1.5Z"
    : "M12 3a1 1 0 0 1 1 1v1a1 1 0 1 1-2 0V4a1 1 0 0 1 1-1Zm0 5a4 4 0 1 1 0 8 4 4 0 0 1 0-8Zm9 4a1 1 0 0 1-1 1h-1a1 1 0 1 1 0-2h1a1 1 0 0 1 1 1ZM6 12a1 1 0 0 1-1 1H4a1 1 0 1 1 0-2h1a1 1 0 0 1 1 1Zm12.36-6.36a1 1 0 0 1 0 1.42l-.71.7a1 1 0 0 1-1.41-1.41l.7-.71a1 1 0 0 1 1.42 0ZM7.76 16.24a1 1 0 0 1 0 1.41l-.7.71a1 1 0 0 1-1.42-1.42l.71-.7a1 1 0 0 1 1.41 0Zm10.6 2.12a1 1 0 0 1-1.42 0l-.7-.71a1 1 0 0 1 1.41-1.41l.71.7a1 1 0 0 1 0 1.42ZM7.76 7.76a1 1 0 0 1-1.41 0l-.71-.7a1 1 0 0 1 1.42-1.42l.7.71a1 1 0 0 1 0 1.41ZM12 18a1 1 0 0 1 1 1v1a1 1 0 1 1-2 0v-1a1 1 0 0 1 1-1Z");
}

function toggleTheme() {
  const theme = currentTheme() === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = theme;
  storageSet(THEME_KEY, theme);
  updateThemeUi();
}

function openVoiceDatabase() {
  if (voiceDatabasePromise) return voiceDatabasePromise;
  if (!("indexedDB" in window)) return Promise.reject(new Error("IndexedDB is unavailable"));

  voiceDatabasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(VOICE_DATABASE_NAME, 1);
    request.addEventListener("upgradeneeded", () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(VOICE_STORE_NAME)) {
        const store = database.createObjectStore(VOICE_STORE_NAME, { keyPath: "id" });
        store.createIndex("language", "language", { unique: false });
      }
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error || new Error("Voice storage failed")));
    request.addEventListener("blocked", () => reject(new Error("Voice storage is blocked")));
  });
  voiceDatabasePromise.catch(() => {
    voiceDatabasePromise = null;
  });
  return voiceDatabasePromise;
}

function databaseRequest(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error || new Error("Storage request failed")));
  });
}

async function getClonedVoices(language = null) {
  const database = await openVoiceDatabase();
  const transaction = database.transaction(VOICE_STORE_NAME, "readonly");
  const store = transaction.objectStore(VOICE_STORE_NAME);
  const request = language ? store.index("language").getAll(language) : store.getAll();
  const voices = await databaseRequest(request);
  return voices.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

async function getClonedVoice(id) {
  const database = await openVoiceDatabase();
  const transaction = database.transaction(VOICE_STORE_NAME, "readonly");
  return databaseRequest(transaction.objectStore(VOICE_STORE_NAME).get(id));
}

async function putClonedVoice(voice) {
  const database = await openVoiceDatabase();
  const transaction = database.transaction(VOICE_STORE_NAME, "readwrite");
  await databaseRequest(transaction.objectStore(VOICE_STORE_NAME).put(voice));
}

async function deleteClonedVoice(id) {
  const database = await openVoiceDatabase();
  const transaction = database.transaction(VOICE_STORE_NAME, "readwrite");
  await databaseRequest(transaction.objectStore(VOICE_STORE_NAME).delete(id));
}

function displayVoiceName(voice) {
  return voice
    .split("_")
    .map((part) => part ? part[0].toUpperCase() + part.slice(1) : "")
    .join(" ");
}

function renderVoiceOptions(language, clonedVoices, preferred) {
  const options = [];
  for (const voice of LANGUAGE_BUILTIN_VOICES[language] || [LANGUAGE_VOICES[language]]) {
    const option = document.createElement("option");
    option.value = voice;
    option.textContent = `${displayVoiceName(voice)} (built-in)`;
    options.push(option);
  }

  for (const voice of clonedVoices) {
    const option = document.createElement("option");
    option.value = `custom:${voice.id}`;
    option.textContent = voice.name;
    options.push(option);
  }

  elements.voice.replaceChildren(...options);
  elements.voice.value = preferred;
  if (!elements.voice.value) elements.voice.value = LANGUAGE_VOICES[language];
  selectedVoice = elements.voice.value;
  voiceSelections[language] = selectedVoice;
}

async function populateVoiceOptions(language = elements.language.value) {
  const revision = ++voiceOptionsRevision;
  const preferred = voiceSelections[language] || LANGUAGE_VOICES[language];
  renderVoiceOptions(language, [], preferred);

  try {
    const clonedVoices = await getClonedVoices(language);
    if (revision !== voiceOptionsRevision || language !== elements.language.value) return;
    renderVoiceOptions(language, clonedVoices, preferred);
  } catch {
    // Built-in voices remain available without IndexedDB.
  }
}

function loadPreferences() {
  try {
    const saved = JSON.parse(storageGet(PREFERENCES_KEY) || "null");
    if (!saved || typeof saved !== "object") return;

    if (typeof saved.language === "string" && SUPPORTED_LANGUAGES.has(saved.language)) {
      elements.language.value = saved.language;
    }

    if (saved.voices && typeof saved.voices === "object") {
      voiceSelections = { ...saved.voices };
    }

  } catch {
    // Ignore malformed preferences.
  }
}

function savePreferences() {
  if (elements.voice.value) voiceSelections[elements.language.value] = elements.voice.value;
  storageSet(PREFERENCES_KEY, JSON.stringify({
    language: elements.language.value,
    voices: voiceSelections,
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

function writeWavText(view, offset, text) {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}

async function createWavBlob(chunks, totalSamples) {
  const bytesPerSample = 2;
  const dataBytes = totalSamples * bytesPerSample;
  const header = new ArrayBuffer(44);
  const view = new DataView(header);

  writeWavText(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeWavText(view, 8, "WAVE");
  writeWavText(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeWavText(view, 36, "data");
  view.setUint32(40, dataBytes, true);

  const parts = [header];
  let remaining = totalSamples;
  let samplesSinceYield = 0;

  for (const chunk of chunks) {
    const length = Math.min(chunk.length, remaining);
    if (length <= 0) break;
    const pcm = new Uint8Array(length * bytesPerSample);

    for (let index = 0; index < length; index += 1) {
      const sample = Math.max(-1, Math.min(1, chunk[index]));
      const value = Math.round(sample < 0 ? sample * 32768 : sample * 32767);
      pcm[index * 2] = value & 0xff;
      pcm[index * 2 + 1] = (value >> 8) & 0xff;
    }

    parts.push(pcm);
    remaining -= length;
    samplesSinceYield += length;
    if (samplesSinceYield >= SAMPLE_RATE * 10) {
      samplesSinceYield = 0;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  if (remaining !== 0) throw new Error("The completed audio is unavailable");
  return new Blob(parts, { type: "audio/wav" });
}

async function downloadWav() {
  if (!downloadReady || isExporting || receivedSamples <= 0) return;

  isExporting = true;
  updatePlayerControls();
  elements.download.setAttribute("aria-busy", "true");
  showToast("Preparing WAV…");

  const chunks = audioChunks.map(({ data }) => data);
  const totalSamples = receivedSamples;
  const language = languageLabel(elements.language.value).toLowerCase();

  try {
    const wav = await createWavBlob(chunks, totalSamples);
    const url = URL.createObjectURL(wav);
    const link = document.createElement("a");
    link.href = url;
    link.download = `ava-${language}.wav`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    console.error(error);
    showToast("Audio download failed");
  } finally {
    isExporting = false;
    elements.download.removeAttribute("aria-busy");
    updatePlayerControls();
  }
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
  const busy = Boolean(
    generationTimer || queuedGeneration || isLoading || isGenerating || isStopping || isVoiceTask
  );
  elements.player.setAttribute("aria-busy", String(busy));
}

function updatePlayerControls() {
  const enabled = sessionAvailable;
  elements.seek.disabled = !enabled;
  elements.play.disabled = !enabled;
  elements.download.disabled = !downloadReady || isExporting;
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
  const pendingVoice = voiceRequest;

  worker = null;
  modelReady = false;
  loadedLanguage = null;
  selectedVoice = null;
  modelLoadRequest = null;
  generationRequest = null;
  voiceRequest = null;
  ignoreNextStreamEnd = false;
  activeWorkerCustomVoices.clear();
  failedWorker?.terminate();

  pendingLoad?.reject(error);
  pendingGeneration?.reject(error);
  pendingVoice?.reject(error);
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

  worker = new Worker(new URL("./pocket/inference-worker.js?v=13", import.meta.url), {
    type: "module",
    name: "ava-pocket-tts",
  });

  worker.addEventListener("message", (event) => {
    const message = event.data || {};

    if (message.type === "model_progress") {
      const isCached = message.status === "cached";
      const percent = message.total > 0 ? (message.loaded / message.total) * 100 : null;
      const language = modelLoadRequest?.language || loadedLanguage || elements.language.value;
      showStatus(
        isCached ? `Opening ${languageLabel(language)}` : `Downloading ${languageLabel(language)}`,
        isCached ? "From browser storage" : "Cached for next time",
        percent,
      );
      return;
    }

    if (message.type === "status") {
      if (modelLoadRequest && message.state === "loading") {
        showStatus(`Preparing ${languageLabel(modelLoadRequest.language)}`, "First use takes a moment", null);
      }
      return;
    }

    if (message.type === "voices_loaded") {
      if (message.language === modelLoadRequest?.language || message.language === loadedLanguage) {
        selectedVoice = elements.voice.value || message.defaultVoice || null;
      }
      return;
    }

    if (message.type === "bundle_loaded") {
      if (!modelLoadRequest || message.language !== modelLoadRequest.language) return;
      loadedLanguage = message.language;
      modelReady = true;
      activeWorkerCustomVoices.clear();
      modelLoadRequest?.resolve(true);
      modelLoadRequest = null;
      return;
    }

    if (message.type === "loaded") return;

    if (message.type === "voice_encoded") {
      const pendingVoice = voiceRequest;
      voiceRequest = null;
      selectedVoice = message.voiceName;
      activeWorkerCustomVoices.clear();
      activeWorkerCustomVoices.add(message.voiceName);
      pendingVoice?.resolve(message);
      return;
    }

    if (message.type === "voice_set") {
      const pendingVoice = voiceRequest;
      voiceRequest = null;
      selectedVoice = message.voiceName;
      if (message.voiceName?.startsWith("custom:")) {
        activeWorkerCustomVoices.clear();
        activeWorkerCustomVoices.add(message.voiceName);
      }
      pendingVoice?.resolve(message);
      return;
    }

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
      if (ignoreNextStreamEnd) {
        ignoreNextStreamEnd = false;
        return;
      }
      streamEnded = true;
      downloadReady = receivedSamples > 0;
      if (wantsPlayback) streamPlayer?.notifyStreamEnded();
      updateTimeline();
      generationRequest?.resolve({ cancelled: false });
      generationRequest = null;
      return;
    }

    if (message.type === "generation_cancelled") {
      ignoreNextStreamEnd = true;
      streamEnded = true;
      downloadReady = false;
      if (wantsPlayback) streamPlayer?.notifyStreamEnded();
      updateTimeline();
      updatePlayerControls();
      generationRequest?.resolve({ cancelled: true });
      generationRequest = null;
      return;
    }

    if (message.type === "error") {
      if (voiceRequest) {
        const pendingVoice = voiceRequest;
        voiceRequest = null;
        pendingVoice.reject(new Error(message.error || "Voice preparation failed"));
        return;
      }
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

function languageLabel(language) {
  return LANGUAGE_DETAILS[language]?.label || "Language";
}

function modelUrlBelongsToLanguage(url, language) {
  return url.includes(`/onnx/${language}/`)
    || url.includes(`/languages/${language}/embeddings/`);
}

function cachedModelInfo(language, urls) {
  const matchingUrls = urls.filter((url) => modelUrlBelongsToLanguage(url, language));
  const hasModels = MODEL_CACHE_ASSETS.every((asset) => urls.some((url) => (
    url.includes(`/${MODEL_REVISION}/onnx/${language}/`) && url.endsWith(asset)
  )));
  const voice = LANGUAGE_VOICES[language];
  const hasVoice = urls.some((url) => (
    url.includes(`/${VOICE_REVISION}/languages/${language}/embeddings/`)
    && url.endsWith(`/${voice}.safetensors`)
  ));
  return {
    cached: hasModels && hasVoice,
    partial: matchingUrls.length > 0 && !(hasModels && hasVoice),
    matchingUrls,
  };
}

async function modelCacheUrls() {
  if (!("caches" in window)) return null;
  const names = await caches.keys();
  if (!names.includes(MODEL_CACHE_NAME)) return [];
  const cache = await caches.open(MODEL_CACHE_NAME);
  return (await cache.keys()).map((request) => request.url);
}

async function modelIsCached(language = elements.language.value) {
  try {
    const urls = await modelCacheUrls();
    if (urls === null) return Boolean(storageGet(modelCacheMarker(language)));
    return cachedModelInfo(language, urls).cached;
  } catch {
    return false;
  }
}

async function updateModelState() {
  const language = elements.language.value;
  if (modelLoadRequest?.language === language) {
    elements.modelState.textContent = `Loading ${languageLabel(language)}…`;
    elements.modelState.classList.remove("is-ready");
    return;
  }
  if (modelReady && loadedLanguage === language) {
    elements.modelState.textContent = `${languageLabel(language)} loaded`;
    elements.modelState.classList.add("is-ready");
    return;
  }
  const cached = await modelIsCached(language);
  if (language !== elements.language.value) return;
  elements.modelState.textContent = cached
    ? `${languageLabel(language)} cached`
    : "Runs locally";
  elements.modelState.classList.toggle("is-ready", cached);
}

function formatModelSize(bytes) {
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

async function refreshModelStorage() {
  const revision = ++modelStorageRevision;

  try {
    const urls = await modelCacheUrls();
    if (revision !== modelStorageRevision) return;
    elements.modelCacheList.replaceChildren();

    if (urls === null) {
      const message = document.createElement("p");
      message.className = "model-cache-empty";
      message.textContent = "Model storage is unavailable in this browser.";
      elements.modelCacheList.append(message);
      return;
    }

    for (const [language, details] of Object.entries(LANGUAGE_DETAILS)) {
      const cacheInfo = cachedModelInfo(language, urls);
      const loaded = modelReady && loadedLanguage === language;
      const loading = modelLoadRequest?.language === language;
      const row = document.createElement("div");
      row.className = "model-cache-row";

      const copy = document.createElement("span");
      copy.className = "model-cache-copy";
      const name = document.createElement("span");
      name.className = "model-cache-language";
      name.textContent = details.label;
      const detail = document.createElement("span");
      detail.className = "model-cache-detail";
      if (loading) {
        detail.textContent = "Loading";
      } else if (loaded && cacheInfo.cached) {
        detail.textContent = `Loaded · ${formatModelSize(details.bytes)} stored`;
      } else if (loaded) {
        detail.textContent = "Loaded · not stored";
      } else if (cacheInfo.cached) {
        detail.textContent = `Cached · ${formatModelSize(details.bytes)}`;
      } else if (cacheInfo.partial) {
        detail.textContent = "Partial download";
      } else {
        detail.textContent = "Not downloaded";
      }
      copy.append(name, detail);
      row.append(copy);

      if (cacheInfo.matchingUrls.length > 0 || loaded || loading) {
        const remove = document.createElement("button");
        remove.className = "model-cache-remove";
        remove.type = "button";
        remove.dataset.removeModel = language;
        remove.textContent = "Remove";
        remove.setAttribute("aria-label", `Remove stored ${details.label}`);
        row.append(remove);
      }

      elements.modelCacheList.append(row);
    }
  } catch (error) {
    console.error(error);
    if (revision !== modelStorageRevision) return;
    const message = document.createElement("p");
    message.className = "model-cache-empty";
    message.textContent = "Stored models could not be checked.";
    elements.modelCacheList.replaceChildren(message);
  }
}

async function refreshClonedVoiceStorage() {
  const revision = ++voiceStorageRevision;
  try {
    const voices = await getClonedVoices();
    if (revision !== voiceStorageRevision) return;
    elements.clonedVoiceList.replaceChildren();

    if (!voices.length) {
      const message = document.createElement("p");
      message.className = "model-cache-empty";
      message.textContent = "None stored";
      elements.clonedVoiceList.append(message);
      return;
    }

    for (const voice of voices) {
      const row = document.createElement("div");
      row.className = "model-cache-row";
      const copy = document.createElement("span");
      copy.className = "model-cache-copy";
      const name = document.createElement("span");
      name.className = "model-cache-language";
      name.textContent = voice.name;
      const detail = document.createElement("span");
      detail.className = "model-cache-detail";
      const bytes = voice.embedding?.byteLength || 0;
      detail.textContent = `${languageLabel(voice.language)} · ${formatModelSize(bytes)}`;
      copy.append(name, detail);

      const remove = document.createElement("button");
      remove.className = "model-cache-remove";
      remove.type = "button";
      remove.dataset.removeVoice = voice.id;
      remove.textContent = "Remove";
      remove.setAttribute("aria-label", `Remove cloned voice ${voice.name}`);
      row.append(copy, remove);
      elements.clonedVoiceList.append(row);
    }
  } catch {
    if (revision !== voiceStorageRevision) return;
    const message = document.createElement("p");
    message.className = "model-cache-empty";
    message.textContent = "Voice storage is unavailable";
    elements.clonedVoiceList.replaceChildren(message);
  }
}

async function removeStoredVoice(id) {
  try {
    const voice = await getClonedVoice(id);
    if (!voice) return;
    await deleteClonedVoice(id);
    if (worker && loadedLanguage === voice.language) {
      worker.postMessage({ type: "remove_custom_voice", data: { id } });
      activeWorkerCustomVoices.delete(`custom:${id}`);
    }

    const wasSelected = elements.language.value === voice.language
      && elements.voice.value === `custom:${id}`;
    if (wasSelected) {
      voiceSelections[voice.language] = LANGUAGE_VOICES[voice.language];
    }
    await populateVoiceOptions(elements.language.value);
    savePreferences();
    await refreshClonedVoiceStorage();
    showToast(`${voice.name} removed`);
    if (wasSelected) scheduleGeneration(0);
  } catch (error) {
    console.error(error);
    showToast("Voice could not be removed");
    await refreshClonedVoiceStorage();
  }
}

async function removeStoredModel(language) {
  const details = LANGUAGE_DETAILS[language];
  if (!details) return;

  try {
    if (elements.language.value === language) {
      generationRevision += 1;
      clearTimeout(generationTimer);
      generationTimer = null;
      if (queuedGeneration?.language === language) queuedGeneration = null;
    }

    const workerLanguage = modelLoadRequest?.language || loadedLanguage;
    const activeLanguage = workerLanguage === language;
    if (activeLanguage) {
      const pendingLoad = modelLoadRequest;
      const pendingGeneration = generationRequest;
      const pendingVoice = voiceRequest;
      const cancellation = new Error(`${details.label} was removed`);
      cancellation.code = "MODEL_REMOVED";

      worker?.terminate();
      worker = null;
      modelReady = false;
      loadedLanguage = null;
      selectedVoice = null;
      modelLoadRequest = null;
      generationRequest = null;
      voiceRequest = null;
      activeWorkerCustomVoices.clear();
      acceptGenerationAudio = false;
      streamEnded = true;
      elements.status.hidden = true;
      if (wantsPlayback) streamPlayer?.notifyStreamEnded();

      pendingLoad?.reject(cancellation);
      pendingGeneration?.resolve({ cancelled: true });
      pendingVoice?.reject(cancellation);
    }

    const urls = await modelCacheUrls();
    if (urls === null) throw new Error("Cache Storage is unavailable");

    if (urls.some((url) => modelUrlBelongsToLanguage(url, language))) {
      const cache = await caches.open(MODEL_CACHE_NAME);
      await Promise.all(urls
        .filter((url) => modelUrlBelongsToLanguage(url, language))
        .map((url) => cache.delete(url)));
      if ((await cache.keys()).length === 0) await caches.delete(MODEL_CACHE_NAME);
    }
    storageRemove(modelCacheMarker(language));
    updateActivityState();
    showToast(`${details.label} removed`);
    await Promise.all([updateModelState(), refreshModelStorage()]);
  } catch (error) {
    console.error(error);
    showToast("Model could not be removed");
    await refreshModelStorage();
  }
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
  elements.modelState.textContent = `Loading ${languageLabel(language)}…`;
  elements.modelState.classList.remove("is-ready");
  if (elements.modelStorage.open) void refreshModelStorage();
  void requestPersistentStorage();
  showStatus(`Preparing ${languageLabel(language)}`, "Cached in this browser after download", null);
  pocketWorker.postMessage({
    type: switchingLanguage ? "set_language" : "load",
    data: { language },
  });

  return promise.then(async (result) => {
    storageSet(modelCacheMarker(language), new Date().toISOString());
    await Promise.all([updateModelState(), refreshModelStorage()]);
    return result;
  }).catch(async (error) => {
    await Promise.all([updateModelState(), refreshModelStorage()]);
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
  downloadReady = false;
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
  downloadReady = false;
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

function requestWorkerVoice(type, data, transfer = []) {
  if (voiceRequest) return Promise.reject(new Error("A voice is already being prepared"));
  const promise = new Promise((resolve, reject) => {
    voiceRequest = { promise: null, resolve, reject };
  });
  voiceRequest.promise = promise;
  getWorker().postMessage({ type, data }, transfer);
  return promise;
}

async function ensureCustomVoiceForWorker(voiceName, language) {
  if (!voiceName?.startsWith("custom:") || activeWorkerCustomVoices.has(voiceName)) return;
  const id = voiceName.slice("custom:".length);
  const voice = await getClonedVoice(id);
  if (!voice || voice.language !== language) throw new Error("The selected cloned voice is unavailable");
  const embedding = voice.embedding.slice(0);
  await requestWorkerVoice("load_custom_voice", {
    id,
    embedding,
    shape: voice.shape,
  }, [embedding]);
}

function generateWithPocket(text, language, voice) {
  if (generationRequest) return Promise.reject(new Error("Speech is already being generated"));
  const promise = new Promise((resolve, reject) => {
    generationRequest = { promise: null, resolve, reject };
  });
  generationRequest.promise = promise;
  getWorker().postMessage({ type: "generate", data: { text, language, voice } });
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
  if (/voice/i.test(message)) {
    return "The voice could not be prepared. Try recording it again.";
  }
  if (/language bundle/i.test(message)) {
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
    await ensureCustomVoiceForWorker(job.voice, job.language);
    if (job.revision !== generationRevision) return;
    selectedVoice = job.voice;

    resetSession(job.text);
    acceptGenerationAudio = true;
    isLoading = false;
    isGenerating = true;
    updateActivityState();
    showStatus("Generating", "", null);

    const result = await generateWithPocket(job.text, job.language, job.voice);
    if (memoryLimitReached) {
      showStatus("Stopped", "15-minute reading limit reached", false);
    } else if (!result.cancelled) {
      elements.status.hidden = true;
    }
  } catch (error) {
    if (error?.code === "MODEL_REMOVED") {
      elements.status.hidden = true;
      return;
    }
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
  if (isLoading || isGenerating || isVoiceTask || !queuedGeneration) return;
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
      voice: elements.voice.value,
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

function setRecordingUi(recording) {
  elements.record.classList.toggle("is-recording", recording);
  elements.recordLabel.textContent = recording ? "Stop and clone" : "Start recording";
  elements.voiceName.disabled = recording || isVoiceTask;
}

function stopMicrophone() {
  clearInterval(recordingTimer);
  clearTimeout(recordingStopTimer);
  recordingTimer = null;
  recordingStopTimer = null;
  microphoneStream?.getTracks().forEach((track) => track.stop());
  microphoneStream = null;
}

function resetVoiceDialog() {
  stopMicrophone();
  mediaRecorder = null;
  recordingChunks = [];
  recordingStartedAt = 0;
  isVoiceTask = false;
  elements.record.disabled = false;
  elements.voiceDialogClose.disabled = false;
  elements.language.disabled = false;
  elements.voice.disabled = false;
  elements.clone.disabled = false;
  elements.recordStatus.textContent = "Stored only in this browser.";
  setRecordingUi(false);
  updateActivityState();
}

function resampleMonoAudio(audioBuffer) {
  const sourceLength = audioBuffer.length;
  const mono = new Float32Array(sourceLength);
  for (let channel = 0; channel < audioBuffer.numberOfChannels; channel++) {
    const data = audioBuffer.getChannelData(channel);
    for (let index = 0; index < sourceLength; index++) mono[index] += data[index];
  }
  if (audioBuffer.numberOfChannels > 1) {
    for (let index = 0; index < sourceLength; index++) mono[index] /= audioBuffer.numberOfChannels;
  }
  if (audioBuffer.sampleRate === SAMPLE_RATE) return mono;

  const ratio = audioBuffer.sampleRate / SAMPLE_RATE;
  const output = new Float32Array(Math.floor(mono.length / ratio));
  for (let index = 0; index < output.length; index++) {
    const sourceIndex = index * ratio;
    const lower = Math.floor(sourceIndex);
    const upper = Math.min(lower + 1, mono.length - 1);
    const mix = sourceIndex - lower;
    output[index] = mono[lower] * (1 - mix) + mono[upper] * mix;
  }
  return output;
}

async function decodeRecording(blob) {
  const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextConstructor) throw new Error("Audio decoding is unavailable");
  const context = new AudioContextConstructor();
  try {
    const buffer = await context.decodeAudioData(await blob.arrayBuffer());
    return resampleMonoAudio(buffer).slice(0, MAX_VOICE_SECONDS * SAMPLE_RATE);
  } finally {
    await context.close().catch(() => {});
  }
}

async function stopSpeechForVoiceTask() {
  generationRevision += 1;
  clearTimeout(generationTimer);
  generationTimer = null;
  queuedGeneration = null;
  acceptGenerationAudio = false;
  const pendingGeneration = generationRequest?.promise;
  if (isGenerating && !isStopping) {
    isStopping = true;
    worker?.postMessage({ type: "stop" });
  }
  if (pendingGeneration) await pendingGeneration.catch(() => {});
}

async function cloneRecordedVoice(blob, durationSeconds) {
  const name = elements.voiceName.value.trim();
  if (!name) throw new Error("Give the voice a name");
  if (durationSeconds < MIN_VOICE_SECONDS) {
    throw new Error(`Record at least ${MIN_VOICE_SECONDS} seconds`);
  }

  isVoiceTask = true;
  elements.record.disabled = true;
  elements.voiceDialogClose.disabled = true;
  elements.language.disabled = true;
  elements.voice.disabled = true;
  elements.clone.disabled = true;
  setRecordingUi(false);
  updateActivityState();
  elements.recordStatus.textContent = "Preparing recording…";

  const language = elements.language.value;
  const audio = await decodeRecording(blob);
  await stopSpeechForVoiceTask();
  elements.recordStatus.textContent = `Loading ${languageLabel(language)}…`;
  await ensureModel(language);

  const id = crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  elements.recordStatus.textContent = "Cloning voice…";
  const result = await requestWorkerVoice("encode_voice", { id, audio }, [audio.buffer]);
  const embedding = result.embedding instanceof Float32Array
    ? result.embedding.buffer.slice(0)
    : result.embedding;
  await putClonedVoice({
    id,
    name: name.slice(0, 40),
    language,
    shape: result.shape.map(Number),
    embedding,
    createdAt: new Date().toISOString(),
  });

  const voiceName = `custom:${id}`;
  voiceSelections[language] = voiceName;
  await populateVoiceOptions(language);
  elements.voice.value = voiceName;
  selectedVoice = voiceName;
  savePreferences();
  await refreshClonedVoiceStorage();
  elements.voiceDialog.close();
  showToast(`${name} saved`);
  isVoiceTask = false;
  updateActivityState();
  if (elements.text.value.trim()) scheduleGeneration(0);
}

async function stopRecordingAndClone() {
  if (!mediaRecorder || mediaRecorder.state !== "recording") return;
  const recorder = mediaRecorder;
  const durationSeconds = (performance.now() - recordingStartedAt) / 1000;
  const stopped = new Promise((resolve) => recorder.addEventListener("stop", resolve, { once: true }));
  recorder.stop();
  stopMicrophone();
  setRecordingUi(false);
  await stopped;
  const blob = new Blob(recordingChunks, { type: recorder.mimeType || "audio/webm" });
  mediaRecorder = null;

  try {
    await cloneRecordedVoice(blob, durationSeconds);
  } catch (error) {
    console.error(error);
    isVoiceTask = false;
    elements.record.disabled = false;
    elements.voiceDialogClose.disabled = false;
    elements.language.disabled = false;
    elements.voice.disabled = false;
    elements.clone.disabled = false;
    setRecordingUi(false);
    updateActivityState();
    elements.recordStatus.textContent = error.message || "Voice cloning failed";
  }
}

async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia || !("MediaRecorder" in window)) {
    elements.recordStatus.textContent = "Recording is unavailable in this browser.";
    return;
  }
  if (!elements.voiceName.value.trim()) {
    elements.recordStatus.textContent = "Give the voice a name first.";
    elements.voiceName.focus();
    return;
  }

  try {
    microphoneStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    const mimeType = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/webm"]
      .find((type) => MediaRecorder.isTypeSupported(type));
    mediaRecorder = mimeType
      ? new MediaRecorder(microphoneStream, { mimeType })
      : new MediaRecorder(microphoneStream);
    recordingChunks = [];
    mediaRecorder.addEventListener("dataavailable", (event) => {
      if (event.data.size) recordingChunks.push(event.data);
    });
    mediaRecorder.start(250);
    recordingStartedAt = performance.now();
    elements.language.disabled = true;
    elements.voice.disabled = true;
    elements.clone.disabled = true;
    setRecordingUi(true);

    const updateTimer = () => {
      const elapsed = Math.min(MAX_VOICE_SECONDS, (performance.now() - recordingStartedAt) / 1000);
      elements.recordStatus.textContent = `${elapsed.toFixed(1)} / ${MAX_VOICE_SECONDS}s`;
    };
    updateTimer();
    recordingTimer = setInterval(updateTimer, 100);
    recordingStopTimer = setTimeout(() => void stopRecordingAndClone(), MAX_VOICE_SECONDS * 1000);
  } catch (error) {
    console.error(error);
    stopMicrophone();
    setRecordingUi(false);
    elements.recordStatus.textContent = error.name === "NotAllowedError"
      ? "Microphone permission was not granted."
      : "The microphone could not be opened.";
  }
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
  if (
    event.target instanceof Element
    && event.target.closest("#model-storage, #voice-dialog")
  ) return;
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
  return !isLoading
    && !isGenerating
    && !isStopping
    && !isVoiceTask
    && !mediaRecorder
    && !isPlaying
    && !sessionAvailable;
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

elements.modelStorage.addEventListener("toggle", () => {
  if (elements.modelStorage.open) {
    void refreshModelStorage();
    void refreshClonedVoiceStorage();
  }
});

elements.modelCacheList.addEventListener("click", (event) => {
  const button = event.target instanceof Element
    ? event.target.closest("button[data-remove-model]")
    : null;
  if (!(button instanceof HTMLButtonElement) || button.disabled) return;
  button.disabled = true;
  button.textContent = "Removing…";
  void removeStoredModel(button.dataset.removeModel);
});

elements.clonedVoiceList.addEventListener("click", (event) => {
  const button = event.target instanceof Element
    ? event.target.closest("button[data-remove-voice]")
    : null;
  if (!(button instanceof HTMLButtonElement) || button.disabled) return;
  button.disabled = true;
  button.textContent = "Removing…";
  void removeStoredVoice(button.dataset.removeVoice);
});

document.addEventListener("pointerdown", (event) => {
  if (!elements.modelStorage.open || elements.modelStorage.contains(event.target)) return;
  elements.modelStorage.open = false;
});

elements.language.addEventListener("change", async () => {
  void updateModelState();
  if (elements.modelStorage.open) void refreshModelStorage();
  await populateVoiceOptions(elements.language.value);
  savePreferences();
  scheduleGeneration(0);
});

elements.voice.addEventListener("change", () => {
  selectedVoice = elements.voice.value;
  savePreferences();
  scheduleGeneration(0);
});

elements.clone.addEventListener("click", () => {
  elements.voiceName.value = "My voice";
  elements.recordStatus.textContent = "Stored only in this browser.";
  elements.voiceDialog.showModal();
  elements.voiceName.select();
});

elements.themeToggle.addEventListener("click", toggleTheme);
matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
  if (!document.documentElement.dataset.theme) updateThemeUi();
});

elements.download.addEventListener("click", () => void downloadWav());

elements.record.addEventListener("click", () => {
  if (mediaRecorder?.state === "recording") {
    void stopRecordingAndClone();
  } else {
    void startRecording();
  }
});

elements.voiceDialog.addEventListener("close", () => {
  if (mediaRecorder?.state === "recording") mediaRecorder.stop();
  resetVoiceDialog();
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
updateThemeUi();
void populateVoiceOptions(elements.language.value);
updateSeekVisual(0, 0);
updateActivityState();
updatePlayerControls();
updateTimeline();
updatePlayState();
void removeLegacyEngineData();
void updateModelState();
if (elements.modelStorage.open) {
  void refreshModelStorage();
  void refreshClonedVoiceStorage();
}
registerServiceWorker();
