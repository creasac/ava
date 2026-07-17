// Pocket TTS ONNX Web Worker
// Adapted for ava from KevinAHM/pocket-tts-web (Apache-2.0).
// ava changes: remote model caching, multilingual built-in and cloned voices,
// lazy voice-cloning encoder loading, and streamed Float32 audio chunks.
console.log("Pocket TTS Worker Starting...");
self.postMessage({ type: "status", status: "Worker Thread Started", state: "idle" });

let ort = null;

const DEFAULT_LANGUAGE = "english_2026-04";
const LANGUAGE_BUNDLES = [
    "english_2026-04",
    "french_24l",
    "german",
    "italian",
    "portuguese",
    "spanish",
];
const LANGUAGE_DEFAULT_VOICES = {
    "english_2026-04": "alba",
    french_24l: "estelle",
    german: "juergen",
    italian: "giovanni",
    portuguese: "rafael",
    spanish: "lola",
};
const LANGUAGE_BUILTIN_VOICES = {
    "english_2026-04": ["alba"],
    french_24l: ["estelle"],
    german: ["juergen"],
    italian: ["giovanni"],
    portuguese: ["rafael"],
    spanish: ["lola"],
};
const MODEL_BASE_URL =
    "https://huggingface.co/KevinAHM/pocket-tts-onnx/resolve/58a6d00cf13d239b6748cb0769f35c580a8f606c/onnx";
const VOICE_ASSET_BASE_URL =
    "https://huggingface.co/kyutai/pocket-tts-without-voice-cloning/resolve/e041936c75475d350b405bc870bcf7c22da4e9e6/languages";
// Keep the original cache name so existing English model downloads are reused.
const MODEL_CACHE_NAME = "ava-pocket-tts-en-58a6d00-d0c0c79-v1";
const MODEL_STEMS = {
    mimi_encoder: "mimi_encoder_int8.onnx",
    text_conditioner: "text_conditioner_int8.onnx",
    flow_lm_main: "flow_lm_main_int8.onnx",
    flow_lm_flow: "flow_lm_flow_int8.onnx",
    mimi_decoder: "mimi_decoder_int8.onnx",
};
const DEBUG_LOGS = false;
const CHUNK_GAP_SEC = 0.25;
const MAX_FRAMES = 500;
const LSD_STEPS = 1;
const RESET_FLOW_STATE_EACH_CHUNK = true;
const RESET_MIMI_STATE_EACH_CHUNK = true;

let currentLanguage = DEFAULT_LANGUAGE;
let currentBundleDir = null;
let bundleMetadata = null;
let tokenizerProcessor = null;
let tokenizerModelB64 = null;
let bosBeforeVoice = null;

let mimiEncoderSession = null;
let textConditionerSession = null;
let flowLmMainSession = null;
let flowLmFlowSession = null;
let mimiDecoderSession = null;

let currentSampleRate = 24000;
let currentSamplesPerFrame = 1920;
let currentLatentDim = 32;
let currentConditioningDim = 1024;
let currentMaxTokenPerChunk = 50;

let predefinedVoiceRecords = {};
let customVoiceEmbeddings = new Map();
let currentVoiceName = null;
let voiceConditioningCache = new Map();

let stTensors = [];
let isGenerating = false;
let isReady = false;

function bundleDir(language) {
    return `${MODEL_BASE_URL}/${language}`;
}

function bundlePath(language, filename) {
    return `${bundleDir(language)}/${filename}`;
}

function debugLog(...args) {
    if (DEBUG_LOGS) {
        console.log(...args);
    }
}

function makeFilledArray(shape, dtype, fill) {
    const size = shape.reduce((a, b) => a * b, 1);
    let data;

    if (dtype === "int64") {
        data = new BigInt64Array(size);
    } else if (dtype === "bool") {
        data = new Uint8Array(size);
    } else {
        data = new Float32Array(size);
        if (fill === "nan") {
            data.fill(NaN);
        } else if (fill === "ones") {
            data.fill(1);
        }
    }

    return data;
}

function createTensor(dtype, data, dims) {
    return new ort.Tensor(dtype, data, dims);
}

function initStateFromManifest(manifest) {
    const state = {};
    for (const entry of manifest) {
        state[entry.input_name] = createTensor(
            entry.dtype,
            makeFilledArray(entry.shape, entry.dtype, entry.fill),
            entry.shape
        );
    }
    return state;
}

function cloneState(state) {
    return { ...state };
}

function updateStateFromManifestOutputs(state, result, manifest) {
    for (const entry of manifest) {
        state[entry.input_name] = result[entry.output_name];
    }
}

function groupVoiceRecordByModule(record) {
    const grouped = {};
    for (const [key, value] of Object.entries(record)) {
        const slash = key.indexOf("/");
        if (slash === -1) continue;
        const moduleName = key.slice(0, slash);
        const tensorKey = key.slice(slash + 1);
        if (!grouped[moduleName]) {
            grouped[moduleName] = {};
        }
        grouped[moduleName][tensorKey] = value;
    }
    return grouped;
}

function adaptTypedArray(source, entry) {
    const targetShape = entry.shape;
    const targetSize = targetShape.reduce((a, b) => a * b, 1);
    const target = makeFilledArray(targetShape, entry.dtype, entry.fill);

    if (source.shape.length === targetShape.length) {
        const exactShape = source.shape.every((dim, idx) => dim === targetShape[idx]);
        if (exactShape) {
            if (entry.dtype === "int64") {
                return new BigInt64Array(source.data);
            }
            if (entry.dtype === "bool") {
                return new Uint8Array(source.data);
            }
            return new Float32Array(source.data);
        }
    }

    if (source.data.length === targetSize) {
        if (entry.dtype === "int64") {
            return new BigInt64Array(source.data);
        }
        if (entry.dtype === "bool") {
            return new Uint8Array(source.data);
        }
        return new Float32Array(source.data);
    }

    if (source.shape.length !== targetShape.length) {
        return target;
    }

    const strides = [];
    let stride = 1;
    for (let i = source.shape.length - 1; i >= 0; i--) {
        strides[i] = stride;
        stride *= source.shape[i];
    }

    const indices = new Array(source.shape.length).fill(0);
    const maxIndices = source.shape.map((dim, idx) => Math.min(dim, targetShape[idx]));

    function targetIndex(coords) {
        let idx = 0;
        let tStride = 1;
        for (let i = targetShape.length - 1; i >= 0; i--) {
            idx += coords[i] * tStride;
            tStride *= targetShape[i];
        }
        return idx;
    }

    let done = false;
    while (!done) {
        let sourceIdx = 0;
        for (let i = 0; i < indices.length; i++) {
            sourceIdx += indices[i] * strides[i];
        }
        target[targetIndex(indices)] = source.data[sourceIdx];

        for (let dim = indices.length - 1; dim >= 0; dim--) {
            indices[dim] += 1;
            if (indices[dim] < maxIndices[dim]) {
                break;
            }
            indices[dim] = 0;
            if (dim === 0) {
                done = true;
            }
        }
    }

    return target;
}

function deriveStep(moduleState) {
    if (moduleState.step) {
        return { data: BigInt64Array.from([BigInt(moduleState.step.data[0])]), shape: [1], dtype: "int64" };
    }
    if (moduleState.offset && !moduleState.end_offset) {
        return { data: BigInt64Array.from([BigInt(moduleState.offset.data[0])]), shape: [1], dtype: "int64" };
    }
    if (moduleState.current_end) {
        return { data: BigInt64Array.from([BigInt(moduleState.current_end.shape[0])]), shape: [1], dtype: "int64" };
    }
    return { data: BigInt64Array.from([0n]), shape: [1], dtype: "int64" };
}

function stateFromVoiceRecord(record) {
    const grouped = groupVoiceRecordByModule(record);
    const state = initStateFromManifest(bundleMetadata.flow_lm_state_manifest);

    for (const entry of bundleMetadata.flow_lm_state_manifest) {
        const moduleState = grouped[entry.module] || {};
        let source = moduleState[entry.key];
        if (!source && entry.key === "step") {
            source = deriveStep(moduleState);
        }
        if (!source) {
            continue;
        }

        const data = adaptTypedArray(source, entry);
        state[entry.input_name] = createTensor(entry.dtype, data, entry.shape);
    }

    return state;
}

function prepareVoiceEmbeddingData(voiceEmb) {
    let data = voiceEmb.data;
    let dims = voiceEmb.shape.slice();

    if (bundleMetadata.insert_bos_before_voice && bosBeforeVoice) {
        const bosData = bosBeforeVoice.data;
        const combined = new Float32Array(bosData.length + data.length);
        combined.set(bosData, 0);
        combined.set(data, bosData.length);
        data = combined;
        dims = [1, dims[1] + bosBeforeVoice.shape[1], dims[2]];
    }

    return createTensor("float32", data, dims);
}

async function buildVoiceConditionedState(voiceEmb) {
    const flowLmState = initStateFromManifest(bundleMetadata.flow_lm_state_manifest);
    const emptySeq = createTensor("float32", new Float32Array(0), [1, 0, currentLatentDim]);
    const voiceTensor = prepareVoiceEmbeddingData(voiceEmb);

    const result = await flowLmMainSession.run({
        sequence: emptySeq,
        text_embeddings: voiceTensor,
        ...flowLmState,
    });

    updateStateFromManifestOutputs(flowLmState, result, bundleMetadata.flow_lm_state_manifest);
    return flowLmState;
}

async function ensurePredefinedVoiceCached(voiceName, options = {}) {
    const { force = false, statusText = "Preparing voice..." } = options;
    if (!LANGUAGE_BUILTIN_VOICES[currentLanguage]?.includes(voiceName)) {
        throw new Error(`Unknown built-in voice: ${voiceName}`);
    }

    if (!predefinedVoiceRecords[voiceName]) {
        const voiceBuffer = await fetchCachedAsset(
            `${VOICE_ASSET_BASE_URL}/${currentLanguage}/embeddings/${voiceName}.safetensors`,
            `${voiceName}.safetensors`,
        );
        predefinedVoiceRecords[voiceName] = parseSafetensorsVoice(voiceBuffer, voiceName);
    }

    if (!force && voiceConditioningCache.has(voiceName)) {
        return voiceConditioningCache.get(voiceName);
    }

    postMessage({ type: "status", status: statusText, state: "loading" });
    const conditioned = stateFromVoiceRecord(predefinedVoiceRecords[voiceName]);
    voiceConditioningCache.set(voiceName, conditioned);
    return conditioned;
}

async function ensureCustomVoiceCached(voiceName, options = {}) {
    const { force = false, statusText = "Preparing custom voice..." } = options;
    const customVoiceEmbedding = customVoiceEmbeddings.get(voiceName);
    if (!customVoiceEmbedding) {
        throw new Error("No custom voice loaded.");
    }

    if (!force && voiceConditioningCache.has(voiceName)) {
        return voiceConditioningCache.get(voiceName);
    }

    postMessage({ type: "status", status: statusText, state: "loading" });
    const conditioned = await buildVoiceConditionedState(customVoiceEmbedding);
    voiceConditioningCache.set(voiceName, conditioned);
    return conditioned;
}

function parseNpyFloat32(buffer) {
    const view = new DataView(buffer);
    const magic = new Uint8Array(buffer, 0, 6);
    const expected = [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59];
    for (let i = 0; i < expected.length; i++) {
        if (magic[i] !== expected[i]) {
            throw new Error("Invalid NPY file");
        }
    }

    const major = view.getUint8(6);
    const headerLen = major === 1 ? view.getUint16(8, true) : view.getUint32(8, true);
    const headerOffset = major === 1 ? 10 : 12;
    const headerText = new TextDecoder().decode(new Uint8Array(buffer, headerOffset, headerLen));
    const shapeMatch = headerText.match(/\(\s*([0-9,\s]+)\)/);
    if (!shapeMatch) {
        throw new Error("Could not parse NPY shape");
    }
    const shape = shapeMatch[1]
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => Number.parseInt(part, 10));
    const dataOffset = headerOffset + headerLen;
    const data = new Float32Array(buffer, dataOffset);
    return { data: new Float32Array(data), shape };
}

function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const chunkSize = 32 * 1024;
    const chunks = [];

    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        const end = Math.min(offset + chunkSize, bytes.length);
        let binaryChunk = "";
        for (let index = offset; index < end; index++) {
            binaryChunk += String.fromCharCode(bytes[index]);
        }
        chunks.push(binaryChunk);
    }

    return btoa(chunks.join(""));
}

function parseSafetensorsVoice(buffer, voiceName) {
    if (buffer.byteLength < 8) {
        throw new Error(`Invalid voice state: ${voiceName}`);
    }

    const view = new DataView(buffer);
    const headerLengthBig = view.getBigUint64(0, true);
    if (headerLengthBig > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error(`Voice state header is too large: ${voiceName}`);
    }

    const headerLength = Number(headerLengthBig);
    const dataOffset = 8 + headerLength;
    if (dataOffset > buffer.byteLength) {
        throw new Error(`Invalid voice state header: ${voiceName}`);
    }

    const header = JSON.parse(new TextDecoder().decode(
        new Uint8Array(buffer, 8, headerLength),
    ));
    const tensors = {};

    for (const [key, descriptor] of Object.entries(header)) {
        if (key === "__metadata__") continue;

        const [relativeStart, relativeEnd] = descriptor.data_offsets || [];
        const start = dataOffset + Number(relativeStart);
        const end = dataOffset + Number(relativeEnd);
        if (
            !Number.isSafeInteger(start)
            || !Number.isSafeInteger(end)
            || start < dataOffset
            || end < start
            || end > buffer.byteLength
        ) {
            throw new Error(`Invalid tensor offsets in voice state: ${voiceName}`);
        }

        const bytes = buffer.slice(start, end);
        let data;
        let dtype;
        if (descriptor.dtype === "F32") {
            data = new Float32Array(bytes);
            dtype = "float32";
        } else if (descriptor.dtype === "I64") {
            data = new BigInt64Array(bytes);
            dtype = "int64";
        } else if (descriptor.dtype === "BOOL") {
            data = new Uint8Array(bytes);
            dtype = "bool";
        } else {
            throw new Error(`Unsupported voice tensor type: ${descriptor.dtype}`);
        }

        tensors[key] = {
            data,
            shape: descriptor.shape.map(Number),
            dtype,
        };
    }

    return tensors;
}

async function encodeVoiceAudio(audioData) {
    const input = createTensor("float32", audioData, [1, 1, audioData.length]);
    const outputs = await mimiEncoderSession.run({ audio: input });
    const embeddings = outputs[mimiEncoderSession.outputNames[0]];

    let dims = embeddings.dims.slice();
    let data = new Float32Array(embeddings.data);
    while (dims.length > 3) {
        if (dims[0] !== 1) break;
        dims = dims.slice(1);
    }
    if (dims.length < 3) {
        dims = [1, dims[0], dims[1]];
    }

    return { data, shape: dims };
}

async function ensureMimiEncoder() {
    if (mimiEncoderSession) return mimiEncoderSession;
    postMessage({ type: "status", status: "Loading voice encoder...", state: "loading" });
    mimiEncoderSession = await createCachedSession(
        currentLanguage,
        MODEL_STEMS.mimi_encoder,
        { executionProviders: ["wasm"], graphOptimizationLevel: "all" },
    );
    return mimiEncoderSession;
}

function prepareTextPrompt(text) {
    let prompt = text.trim();
    if (!prompt) {
        return { text: "", framesAfterEos: 1 };
    }

    prompt = prompt.replace(/\r/g, " ").replace(/\n/g, " ").replace(/\s+/g, " ");
    if (bundleMetadata.remove_semicolons) {
        prompt = prompt.replace(/;/g, ",");
    }

    const wordCount = prompt.split(/\s+/).filter(Boolean).length;
    let framesAfterEos = wordCount <= 4 ? 3 : 1;
    if (bundleMetadata.model_recommended_frames_after_eos != null) {
        framesAfterEos = Number(bundleMetadata.model_recommended_frames_after_eos);
    }

    if (prompt && !/[A-ZÀ-Þ]/.test(prompt[0])) {
        prompt = prompt[0].toUpperCase() + prompt.slice(1);
    }
    if (prompt && /[0-9A-Za-zÀ-ÿ]/.test(prompt[prompt.length - 1])) {
        prompt += ".";
    }
    if (bundleMetadata.pad_with_spaces_for_short_inputs && wordCount < 5) {
        prompt = "        " + prompt;
    }

    return { text: prompt, framesAfterEos };
}

const SENTENCE_SPLIT_RE = /[^.!?]+[.!?]+|[^.!?]+$/g;

function splitTextIntoSentences(text) {
    const matches = text.match(SENTENCE_SPLIT_RE);
    if (!matches) return [];
    return matches.map((sentence) => sentence.trim()).filter(Boolean);
}

function splitTokenIdsIntoChunks(tokenIds, maxTokens) {
    const chunks = [];
    for (let i = 0; i < tokenIds.length; i += maxTokens) {
        const chunkText = tokenizerProcessor.decodeIds(tokenIds.slice(i, i + maxTokens)).trim();
        if (chunkText) {
            chunks.push(chunkText);
        }
    }
    return chunks;
}

function splitIntoBestSentences(text) {
    const prepared = prepareTextPrompt(text);
    if (!prepared.text) {
        return { chunks: [], framesAfterEos: prepared.framesAfterEos };
    }

    const sentences = splitTextIntoSentences(prepared.text);
    if (!sentences.length) {
        return { chunks: [prepared.text], framesAfterEos: prepared.framesAfterEos };
    }

    const chunks = [];
    let currentChunk = "";

    for (const sentenceText of sentences) {
        const sentenceTokenIds = tokenizerProcessor.encodeIds(sentenceText);
        const sentenceTokens = sentenceTokenIds.length;

        if (sentenceTokens > currentMaxTokenPerChunk) {
            if (currentChunk) {
                chunks.push(currentChunk.trim());
                currentChunk = "";
            }
            const splitChunks = splitTokenIdsIntoChunks(sentenceTokenIds, currentMaxTokenPerChunk);
            for (const splitChunk of splitChunks) {
                if (splitChunk) {
                    chunks.push(splitChunk.trim());
                }
            }
            continue;
        }

        if (!currentChunk) {
            currentChunk = sentenceText;
            continue;
        }

        const combined = `${currentChunk} ${sentenceText}`;
        const combinedTokens = tokenizerProcessor.encodeIds(combined).length;
        if (combinedTokens > currentMaxTokenPerChunk) {
            chunks.push(currentChunk.trim());
            currentChunk = sentenceText;
        } else {
            currentChunk = combined;
        }
    }

    if (currentChunk) {
        chunks.push(currentChunk.trim());
    }

    return { chunks, framesAfterEos: prepared.framesAfterEos };
}

function precomputeFlowBuffers() {
    stTensors = [];
    const dt = 1.0 / LSD_STEPS;
    for (let step = 0; step < LSD_STEPS; step++) {
        const s = step / LSD_STEPS;
        const t = s + dt;
        stTensors.push({
            s: createTensor("float32", new Float32Array([s]), [1, 1]),
            t: createTensor("float32", new Float32Array([t]), [1, 1]),
        });
    }
}

async function fetchCachedAsset(url, label) {
    let cache = null;
    try {
        cache = await caches.open(MODEL_CACHE_NAME);
        const cached = await cache.match(url);
        if (cached) {
            postMessage({
                type: "model_progress",
                file: label,
                status: "cached",
                loaded: 1,
                total: 1,
            });
            return cached.arrayBuffer();
        }
    } catch (error) {
        console.warn("Pocket TTS cache is unavailable", error);
    }

    postMessage({
        type: "model_progress",
        file: label,
        status: "downloading",
        loaded: 0,
        total: 0,
    });
    const response = await fetch(url, { mode: "cors" });
    if (!response.ok) {
        throw new Error(`Failed to download ${label} (${response.status})`);
    }

    const cacheWrite = cache
        ? cache.put(url, response.clone()).catch((error) => {
            console.warn(`Could not cache ${label}`, error);
        })
        : Promise.resolve();
    const contentLength = Number(response.headers.get("content-length")) || 0;

    if (!response.body || !contentLength) {
        const buffer = await response.arrayBuffer();
        await cacheWrite;
        postMessage({
            type: "model_progress",
            file: label,
            status: "downloaded",
            loaded: buffer.byteLength,
            total: buffer.byteLength,
        });
        return buffer;
    }

    const reader = response.body.getReader();
    const chunks = [];
    let loaded = 0;
    let lastReport = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.byteLength;
        const now = performance.now();
        if (now - lastReport > 120 || loaded === contentLength) {
            lastReport = now;
            postMessage({
                type: "model_progress",
                file: label,
                status: "downloading",
                loaded,
                total: contentLength,
            });
        }
    }

    const buffer = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
        buffer.set(chunk, offset);
        offset += chunk.byteLength;
    }
    await cacheWrite;
    postMessage({
        type: "model_progress",
        file: label,
        status: "downloaded",
        loaded,
        total: contentLength || loaded,
    });
    return buffer.buffer;
}

async function evictCachedAsset(url, label) {
    try {
        const cache = await caches.open(MODEL_CACHE_NAME);
        await cache.delete(url);
    } catch (error) {
        console.warn(`Could not evict cached ${label}`, error);
    }
}

async function createCachedSession(language, filename, sessionOptions) {
    const url = bundlePath(language, filename);
    let bytes = await fetchCachedAsset(url, filename);
    postMessage({ type: "status", status: `Starting ${filename.replace("_int8.onnx", "")}…`, state: "loading" });
    try {
        return await ort.InferenceSession.create(bytes, sessionOptions);
    } catch (initialError) {
        console.warn(`Could not create a session from ${filename}; redownloading once.`, initialError);
        await evictCachedAsset(url, filename);
        bytes = await fetchCachedAsset(url, filename);
        postMessage({ type: "status", status: `Retrying ${filename.replace("_int8.onnx", "")}…`, state: "loading" });
        return ort.InferenceSession.create(bytes, sessionOptions);
    }
}

async function loadOrt() {
    if (ort) {
        return;
    }

    postMessage({ type: "status", status: "Loading ONNX Runtime...", state: "loading" });
    const version = "1.20.0";
    const cdnBase = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${version}/dist/`;
    const ortModule = await import(`https://cdn.jsdelivr.net/npm/onnxruntime-web@${version}/dist/ort.min.mjs`);
    ort = ortModule.default || ortModule;
    ort.env.wasm.wasmPaths = cdnBase;
    ort.env.wasm.simd = true;
    ort.env.wasm.numThreads = self.crossOriginIsolated
        ? Math.min(navigator.hardwareConcurrency || 4, 4)
        : 1;
    precomputeFlowBuffers();
}

async function releaseSession(session) {
    if (!session) {
        return;
    }
    if (typeof session.release === "function") {
        await session.release();
    }
}

async function loadBundle(language, { initialLoad = false } = {}) {
    if (!LANGUAGE_BUNDLES.includes(language)) {
        throw new Error(`Unsupported language bundle: ${language}`);
    }

    await loadOrt();

    postMessage({ type: "status", status: `Loading ${language} bundle...`, state: "loading" });
    currentLanguage = language;
    currentBundleDir = bundleDir(language);

    const metadataBuffer = await fetchCachedAsset(bundlePath(language, "bundle.json"), "bundle.json");
    bundleMetadata = JSON.parse(new TextDecoder().decode(metadataBuffer));

    currentSampleRate = Number(bundleMetadata.sample_rate);
    currentSamplesPerFrame = Number(bundleMetadata.samples_per_frame);
    currentLatentDim = Number(bundleMetadata.latent_dim);
    currentConditioningDim = Number(bundleMetadata.conditioning_dim);
    currentMaxTokenPerChunk = Number(bundleMetadata.max_token_per_chunk || 50);
    isReady = false;

    await Promise.all([
        releaseSession(textConditionerSession),
        releaseSession(flowLmMainSession),
        releaseSession(flowLmFlowSession),
        releaseSession(mimiDecoderSession),
    ]);

    const sessionOptions = {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
    };

    const [textCondRes, flowMainRes, flowFlowRes, decoderRes] = await Promise.all([
        createCachedSession(language, MODEL_STEMS.text_conditioner, sessionOptions),
        createCachedSession(language, MODEL_STEMS.flow_lm_main, sessionOptions),
        createCachedSession(language, MODEL_STEMS.flow_lm_flow, sessionOptions),
        createCachedSession(language, MODEL_STEMS.mimi_decoder, sessionOptions),
    ]);

    mimiEncoderSession = null;
    textConditionerSession = textCondRes;
    flowLmMainSession = flowMainRes;
    flowLmFlowSession = flowFlowRes;
    mimiDecoderSession = decoderRes;

    const tokenizerBuffer = await fetchCachedAsset(
        bundlePath(language, bundleMetadata.tokenizer_file),
        bundleMetadata.tokenizer_file,
    );
    tokenizerModelB64 = arrayBufferToBase64(tokenizerBuffer);
    const spModule = await import("./sentencepiece.js?v=3");
    tokenizerProcessor = new spModule.SentencePieceProcessor();
    await tokenizerProcessor.loadFromB64StringModel(tokenizerModelB64);

    bosBeforeVoice = null;
    if (bundleMetadata.bos_before_voice_file) {
        const bosBuffer = await fetchCachedAsset(
            bundlePath(language, bundleMetadata.bos_before_voice_file),
            bundleMetadata.bos_before_voice_file,
        );
        bosBeforeVoice = parseNpyFloat32(bosBuffer);
    }

    const defaultVoice = LANGUAGE_DEFAULT_VOICES[language];
    predefinedVoiceRecords = {};
    voiceConditioningCache = new Map();
    currentVoiceName = defaultVoice;
    await ensurePredefinedVoiceCached(defaultVoice, {
        force: true,
        statusText: `Preparing voice (${defaultVoice})...`,
    });
    customVoiceEmbeddings = new Map();

    isReady = true;

    postMessage({
        type: "voices_loaded",
        voices: LANGUAGE_BUILTIN_VOICES[language] || [defaultVoice],
        defaultVoice,
        language,
    });
    postMessage({
        type: "bundle_loaded",
        language,
        sampleRate: currentSampleRate,
        initialLoad,
    });
    postMessage({ type: "status", status: "Ready", state: "idle" });
    postMessage({ type: "model_status", status: "ready", text: `Ready (${language})` });
    if (initialLoad) {
        postMessage({ type: "loaded", language, defaultVoice });
    }
}

self.onmessage = async (e) => {
    const { type, data } = e.data;

    try {
        if (type === "load") {
            await loadBundle(data?.language || DEFAULT_LANGUAGE, { initialLoad: true });
            return;
        }

        if (type === "set_language") {
            if (isGenerating) {
                postMessage({ type: "error", error: "Cannot switch language while generation is running." });
                return;
            }
            await loadBundle(data.language, { initialLoad: false });
            return;
        }

        if (type === "stop") {
            isGenerating = false;
            postMessage({ type: "generation_cancelled" });
            postMessage({ type: "stream_ended" });
            postMessage({ type: "status", status: "Stopped", state: "idle" });
            return;
        }

        if (!isReady) {
            postMessage({ type: "error", error: "Models are not loaded yet." });
            return;
        }

        if (type === "encode_voice") {
            if (isGenerating) {
                postMessage({ type: "error", error: "Cannot encode a voice while generation is running." });
                return;
            }
            await ensureMimiEncoder();
            const voiceName = `custom:${data.id}`;
            const embedding = await encodeVoiceAudio(data.audio);
            for (const key of customVoiceEmbeddings.keys()) voiceConditioningCache.delete(key);
            customVoiceEmbeddings.clear();
            customVoiceEmbeddings.set(voiceName, embedding);
            currentVoiceName = voiceName;
            await ensureCustomVoiceCached(voiceName, {
                force: true,
                statusText: "Preparing cloned voice...",
            });
            const persistedData = new Float32Array(embedding.data);
            postMessage({
                type: "voice_encoded",
                voiceName,
                id: data.id,
                embedding: persistedData,
                shape: embedding.shape,
            }, [persistedData.buffer]);
            postMessage({ type: "status", status: "Ready", state: "idle" });
            return;
        }

        if (type === "load_custom_voice") {
            if (isGenerating) {
                postMessage({ type: "error", error: "Cannot load a voice while generation is running." });
                return;
            }
            const voiceName = `custom:${data.id}`;
            const embeddingData = data.embedding instanceof Float32Array
                ? data.embedding
                : new Float32Array(data.embedding);
            for (const key of customVoiceEmbeddings.keys()) voiceConditioningCache.delete(key);
            customVoiceEmbeddings.clear();
            customVoiceEmbeddings.set(voiceName, {
                data: new Float32Array(embeddingData),
                shape: data.shape.map(Number),
            });
            await ensureCustomVoiceCached(voiceName, {
                force: true,
                statusText: "Preparing cloned voice...",
            });
            currentVoiceName = voiceName;
            postMessage({ type: "voice_set", voiceName });
            postMessage({ type: "status", status: "Ready", state: "idle" });
            return;
        }

        if (type === "remove_custom_voice") {
            const voiceName = `custom:${data.id}`;
            customVoiceEmbeddings.delete(voiceName);
            voiceConditioningCache.delete(voiceName);
            if (currentVoiceName === voiceName) currentVoiceName = LANGUAGE_DEFAULT_VOICES[currentLanguage];
            return;
        }

        if (type === "set_voice") {
            if (isGenerating) {
                postMessage({ type: "error", error: "Cannot switch voice while generation is running." });
                return;
            }
            if (data.voiceName.startsWith("custom:")) {
                await ensureCustomVoiceCached(data.voiceName, { statusText: "Preparing cloned voice..." });
                currentVoiceName = "custom";
            } else {
                await ensurePredefinedVoiceCached(data.voiceName, {
                    statusText: `Preparing voice (${data.voiceName})...`,
                });
                currentVoiceName = data.voiceName;
            }
            postMessage({ type: "voice_set", voiceName: currentVoiceName });
            postMessage({ type: "status", status: "Ready", state: "idle" });
            return;
        }

        if (type === "generate") {
            if (isGenerating) {
                return;
            }
            if (data.language && data.language !== currentLanguage) {
                throw new Error(
                    `Language mismatch: loaded ${currentLanguage}, requested ${data.language}.`,
                );
            }
            await startGeneration(data.text, data.voice || currentVoiceName);
        }
    } catch (err) {
        console.error("Worker error:", err);
        postMessage({ type: "error", error: err.toString() });
    }
};

async function startGeneration(text, voiceName) {
    isGenerating = true;
    postMessage({ type: "status", status: "Generating...", state: "running" });
    postMessage({ type: "generation_started", data: { time: performance.now() } });

    try {
        const { chunks, framesAfterEos } = splitIntoBestSentences(text);
        if (!chunks.length) {
            throw new Error("No text to generate");
        }

        if (voiceName.startsWith("custom:")) {
            await ensureCustomVoiceCached(voiceName, { statusText: "Preparing cloned voice..." });
        } else {
            await ensurePredefinedVoiceCached(voiceName, {
                statusText: `Preparing voice (${voiceName})...`,
            });
        }
        currentVoiceName = voiceName;

        await runGenerationPipeline(voiceName, chunks, framesAfterEos);
    } catch (err) {
        console.error("Generation error:", err);
        postMessage({ type: "error", error: err.toString() });
    } finally {
        if (isGenerating) {
            postMessage({ type: "stream_ended" });
            postMessage({ type: "status", status: "Finished", state: "idle" });
        }
        isGenerating = false;
    }
}

async function runGenerationPipeline(voiceName, chunks, framesAfterEos) {
    let mimiState = initStateFromManifest(bundleMetadata.mimi_state_manifest);
    const emptySeq = createTensor("float32", new Float32Array(0), [1, 0, currentLatentDim]);
    const emptyTextEmb = createTensor("float32", new Float32Array(0), [1, 0, currentConditioningDim]);
    const baseFlowState = voiceConditioningCache.get(voiceName);
    if (!baseFlowState) {
        throw new Error(`Voice conditioning cache missing for '${voiceName}'.`);
    }
    let flowLmState = cloneState(baseFlowState);

    const firstChunkFrames = 3;
    const normalChunkFrames = 12;
    let generatedFrameCount = 0;
    let isFirstAudioChunk = true;
    let totalFlowLmTime = 0;
    let totalDecodeTime = 0;
    const generationStart = performance.now();

    for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
        if (!isGenerating) break;

        if (RESET_FLOW_STATE_EACH_CHUNK && chunkIdx > 0) {
            flowLmState = cloneState(baseFlowState);
        }
        if (RESET_MIMI_STATE_EACH_CHUNK && chunkIdx > 0) {
            mimiState = initStateFromManifest(bundleMetadata.mimi_state_manifest);
        }

        const chunkText = chunks[chunkIdx];
        let isFirstAudioChunkOfTextChunk = true;
        const tokenIds = tokenizerProcessor.encodeIds(chunkText);
        const textInput = createTensor(
            "int64",
            BigInt64Array.from(tokenIds.map((token) => BigInt(token))),
            [1, tokenIds.length]
        );

        let textEmb = (await textConditionerSession.run({ token_ids: textInput }))[textConditionerSession.outputNames[0]];
        if (textEmb.dims.length === 2) {
            textEmb = createTensor("float32", new Float32Array(textEmb.data), [1, textEmb.dims[0], textEmb.dims[1]]);
        }

        const condResult = await flowLmMainSession.run({
            sequence: emptySeq,
            text_embeddings: textEmb,
            ...flowLmState,
        });
        updateStateFromManifestOutputs(flowLmState, condResult, bundleMetadata.flow_lm_state_manifest);

        const chunkLatents = [];
        let chunkDecodedFrames = 0;
        let currentLatent = createTensor("float32", new Float32Array(currentLatentDim).fill(NaN), [1, 1, currentLatentDim]);
        let eosStep = null;
        let chunkEnded = false;
        let chunkGenTimeMs = 0;
        let generatedFramesForChunk = 0;

        async function decodeAndEmit(decodeSize, isLastChunk) {
            const decodeLatents = new Float32Array(decodeSize * currentLatentDim);
            for (let frame = 0; frame < decodeSize; frame++) {
                decodeLatents.set(chunkLatents[chunkDecodedFrames + frame], frame * currentLatentDim);
            }

            const decoderStart = performance.now();
            const decodeResult = await mimiDecoderSession.run({
                latent: createTensor("float32", decodeLatents, [1, decodeSize, currentLatentDim]),
                ...mimiState,
            });
            const decoderElapsed = performance.now() - decoderStart;
            chunkGenTimeMs += decoderElapsed;
            totalDecodeTime += decoderElapsed;

            for (const entry of bundleMetadata.mimi_state_manifest) {
                mimiState[entry.input_name] = decodeResult[entry.output_name];
            }

            chunkDecodedFrames += decodeSize;
            const audioFloat32 = new Float32Array(decodeResult[mimiDecoderSession.outputNames[0]].data);
            if (!isGenerating) {
                return false;
            }

            postMessage({
                type: "audio_chunk",
                data: audioFloat32,
                metrics: {
                    bbTime: 0,
                    decTime: 0,
                    chunkDuration: audioFloat32.length / currentSampleRate,
                    genTimeSec: chunkGenTimeMs / 1000,
                    isFirst: isFirstAudioChunk,
                    isLast: isLastChunk,
                    chunkStart: isFirstAudioChunkOfTextChunk,
                },
            }, [audioFloat32.buffer]);

            isFirstAudioChunk = false;
            isFirstAudioChunkOfTextChunk = false;
            chunkGenTimeMs = 0;
            return true;
        }

        for (let step = 0; step < MAX_FRAMES; step++) {
            if (!isGenerating) break;
            if (step > 0 && step % 4 === 0) {
                await new Promise((resolve) => setTimeout(resolve, 0));
            }

            const stepStart = performance.now();
            const arResult = await flowLmMainSession.run({
                sequence: currentLatent,
                text_embeddings: emptyTextEmb,
                ...flowLmState,
            });
            const stepElapsed = performance.now() - stepStart;
            chunkGenTimeMs += stepElapsed;
            totalFlowLmTime += stepElapsed;

            const conditioning = arResult.conditioning;
            const eosLogit = arResult.eos_logit.data[0];
            const isEos = eosLogit > -4.0;
            if (isEos && eosStep == null) {
                eosStep = step;
            }
            const shouldStop = eosStep != null && step >= eosStep + framesAfterEos;

            const temperature = 0.7;
            const std = Math.sqrt(temperature);
            const latentData = new Float32Array(currentLatentDim);
            for (let i = 0; i < currentLatentDim; i++) {
                let u = 0;
                let v = 0;
                while (u === 0) u = Math.random();
                while (v === 0) v = Math.random();
                latentData[i] = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v) * std;
            }

            const dt = 1.0 / LSD_STEPS;
            for (let lsdIndex = 0; lsdIndex < LSD_STEPS; lsdIndex++) {
                const flowResult = await flowLmFlowSession.run({
                    c: conditioning,
                    s: stTensors[lsdIndex].s,
                    t: stTensors[lsdIndex].t,
                    x: createTensor("float32", latentData, [1, currentLatentDim]),
                });
                const flowDir = flowResult.flow_dir.data;
                for (let i = 0; i < currentLatentDim; i++) {
                    latentData[i] += flowDir[i] * dt;
                }
            }

            chunkLatents.push(new Float32Array(latentData));
            generatedFrameCount += 1;
            generatedFramesForChunk += 1;
            currentLatent = createTensor("float32", latentData, [1, 1, currentLatentDim]);
            updateStateFromManifestOutputs(flowLmState, arResult, bundleMetadata.flow_lm_state_manifest);

            const pending = chunkLatents.length - chunkDecodedFrames;
            let decodeSize = 0;
            if (shouldStop) {
                decodeSize = pending;
            } else if (isFirstAudioChunk && pending >= firstChunkFrames) {
                decodeSize = firstChunkFrames;
            } else if (pending >= normalChunkFrames) {
                decodeSize = normalChunkFrames;
            }

            if (decodeSize > 0) {
                const isLastChunk = shouldStop && chunkIdx === chunks.length - 1;
                const emitted = await decodeAndEmit(decodeSize, isLastChunk);
                if (!emitted) break;
            }

            if (shouldStop) {
                chunkEnded = true;
                break;
            }
        }

        const hitMaxFrames = generatedFramesForChunk >= MAX_FRAMES;
        if (isGenerating && !chunkEnded && hitMaxFrames) {
            if (eosStep == null) {
                const warning = `Chunk ${chunkIdx + 1} reached ${MAX_FRAMES} frames without EOS.`;
                console.warn(warning);
                postMessage({
                    type: "generation_warning",
                    code: "max_frames_without_eos",
                    warning,
                    chunkIndex: chunkIdx,
                });
            }

            const pendingFrames = chunkLatents.length - chunkDecodedFrames;
            if (pendingFrames > 0) {
                await decodeAndEmit(pendingFrames, chunkIdx === chunks.length - 1);
            }
            chunkEnded = isGenerating;
        }

        if (chunkEnded && isGenerating && chunkIdx < chunks.length - 1) {
            const gapSamples = Math.max(1, Math.floor(CHUNK_GAP_SEC * currentSampleRate));
            const silence = new Float32Array(gapSamples);
            postMessage({
                type: "audio_chunk",
                data: silence,
                metrics: {
                    bbTime: 0,
                    decTime: 0,
                    chunkDuration: gapSamples / currentSampleRate,
                    isFirst: false,
                    isLast: false,
                    isSilence: true,
                },
            }, [silence.buffer]);
        }
    }

    const totalTime = (performance.now() - generationStart) / 1000;
    const audioSeconds = generatedFrameCount * currentSamplesPerFrame / currentSampleRate;
    const genTime = (totalFlowLmTime + totalDecodeTime) / 1000;
    const rtfx = genTime > 0 ? audioSeconds / genTime : 0;

    debugLog(`Generation complete for ${voiceName} in ${totalTime.toFixed(2)}s (RTFx ${rtfx.toFixed(2)}x)`);
    postMessage({
        type: "status",
        status: `Finished (RTFx: ${rtfx.toFixed(2)}x)`,
        state: "idle",
        metrics: { rtfx, genTime, totalTime, audioDuration: audioSeconds },
    });
}
