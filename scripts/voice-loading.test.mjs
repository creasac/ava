import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const voiceUrl = 'https://huggingface.co/kyutai/pocket-tts-without-voice-cloning/resolve/e041936c75475d350b405bc870bcf7c22da4e9e6/languages/english_2026-04/embeddings/jane.safetensors';
const bundleUrl = 'https://huggingface.co/KevinAHM/pocket-tts-onnx/resolve/58a6d00cf13d239b6748cb0769f35c580a8f606c/onnx/english_2026-04/bundle.json';

async function pinnedAsset(url, sha256, override) {
  const path = override || join(tmpdir(), 'ava-test-voices', sha256);
  let bytes;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (error.code !== 'ENOENT' || override) throw error;
    const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
    assert.ok(response.ok, `Could not download ${url}: ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(createHash('sha256').update(bytes).digest('hex'), sha256);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }
  assert.equal(createHash('sha256').update(bytes).digest('hex'), sha256);
  return bytes;
}

test('the pinned Jane state loads through the worker and preserves all six voice caches', async () => {
  const [voice, bundle, source] = await Promise.all([
    pinnedAsset(voiceUrl, '37386227ca8ec5bf1b8e516c13d132ce5ff5437a304fe90129a1c62f41d9a008', process.env.AVA_JANE_STATE),
    pinnedAsset(bundleUrl, 'bab643150f437f37df080a710520ff39ed9ebd9a339f8ebdc739f7eddfc28b3f', process.env.AVA_ENGLISH_BUNDLE),
    readFile(new URL('../pocket/inference-worker.js', import.meta.url), 'utf8'),
  ]);
  assert.equal(voice.length, 7374072);
  const metadata = JSON.parse(bundle);
  assert.equal(metadata.schema_version, 2);
  assert.equal(metadata.language, 'english_2026-04');
  class Tensor {
    constructor(type, data, dims) { Object.assign(this, { type, data, dims }); }
  }
  const requests = [];
  const context = vm.createContext({
    Float32Array, BigInt64Array, Uint8Array, DataView, TextDecoder,
    console: { log() {}, warn() {} }, self: { postMessage() {} }, postMessage() {},
    Tensor, metadata,
    // Keep the actual asset fetch/parser/conditioning path, supplying only the
    // already hash-verified HTTP response to avoid downloading Jane twice.
    async fetch(url) {
      requests.push(url);
      assert.equal(url, voiceUrl);
      return new Response(voice);
    },
  });
  vm.runInContext(source.replace(/^import .*\n/m, ''), context);
  const state = await vm.runInContext(`
    ort = { Tensor }; bundleMetadata = metadata;
    ensurePredefinedVoiceCached(LANGUAGE_DEFAULT_VOICES[DEFAULT_LANGUAGE]);
  `, context);
  const record = vm.runInContext('predefinedVoiceRecords.jane', context);
  assert.deepEqual(requests, [voiceUrl]);
  assert.equal(await vm.runInContext("ensurePredefinedVoiceCached('jane')", context), state);
  assert.equal(requests.length, 1, 'the parsed state is reused');
  let caches = 0;
  let steps = 0;
  for (const entry of metadata.flow_lm_state_manifest) {
    const tensor = state[entry.input_name];
    assert.equal(tensor.type, entry.dtype);
    assert.deepEqual(tensor.dims, entry.shape);
    if (entry.key === 'cache') {
      const original = record[entry.path];
      assert.deepEqual(Array.from(original.shape), [2, 1, 150, 16, 64]);
      assert.ok(original.data.every(Number.isFinite));
      for (let branch = 0; branch < 2; branch++) {
        assert.deepEqual(
          tensor.data.subarray(branch * 1000 * 1024, branch * 1000 * 1024 + 150 * 1024),
          original.data.subarray(branch * 150 * 1024, (branch + 1) * 150 * 1024),
        );
        assert.ok(tensor.data.subarray(branch * 1000 * 1024 + 150 * 1024, (branch + 1) * 1000 * 1024).every(Number.isNaN));
      }
      caches++;
    } else if (entry.key === 'step') {
      assert.equal(tensor.data[0], 150n);
      steps++;
    }
  }
  assert.equal(caches, 6);
  assert.equal(steps, 6);
});
