import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const workerSource = await readFile(new URL('../pocket/inference-worker.js', import.meta.url), 'utf8');

// Run the real worker pipeline with explicit deterministic model doubles. This
// checks chunk-object consumption and emitted PCM, not model quality or the
// tokenizer/chunking algorithm (covered separately with the real tokenizer).
async function generate(chunks) {
  const messages = [];
  const encodedTexts = [];
  let chunkIndex = -1;
  let clock = 0;
  const frameSamples = 1920;
  const framesPerChunk = 2; // EOS on the first frame, plus one trailing frame.
  class Tensor {
    constructor(type, data, dims) { Object.assign(this, { type, data, dims }); }
  }
  const sessions = {
    text: {
      outputNames: ['text_embeddings'],
      async run({ token_ids }) {
        chunkIndex++;
        assert.deepEqual(Array.from(token_ids.data), [BigInt(chunkIndex + 11)]);
        return { text_embeddings: new Tensor('float32', new Float32Array([1]), [1, 1, 1]) };
      }
    },
    main: {
      async run() {
        return {
          conditioning: new Tensor('float32', new Float32Array([1]), [1, 1]),
          eos_logit: new Tensor('float32', new Float32Array([0]), [1])
        };
      }
    },
    flow: {
      async run({ x }) {
        return { flow_dir: new Tensor('float32', new Float32Array(x.data.length), x.dims) };
      }
    },
    decoder: {
      outputNames: ['audio'],
      async run({ latent }) {
        assert.equal(latent.dims[1], framesPerChunk);
        // Each request has its own nonzero PCM marker, making both ordering and
        // inserted silence directly observable in the worker's output.
        const data = new Float32Array(latent.dims[1] * frameSamples).fill((chunkIndex + 1) / 8);
        return { audio: new Tensor('float32', data, [1, 1, data.length]) };
      }
    }
  };
  const postMessage = message => messages.push(message);
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    self: { postMessage },
    postMessage,
    performance: { now: () => ++clock },
    setTimeout,
    Float32Array,
    BigInt64Array,
    Uint8Array,
    Tensor,
    sessions,
    chunks,
    tokenizer: {
      encodeIds(text) {
        assert.equal(typeof text, 'string', 'the worker must pass chunk.text to the tokenizer');
        assert.equal(text, chunks[encodedTexts.length].text);
        encodedTexts.push(text);
        return [encodedTexts.length + 10];
      }
    }
  });
  vm.runInContext(workerSource.replace(/^import .*\n/m, ''), context);
  await vm.runInContext(`
    Math.random = () => 0.5;
    ort = { Tensor };
    bundleMetadata = { mimi_state_manifest: [], flow_lm_state_manifest: [] };
    tokenizerProcessor = tokenizer;
    currentSampleRate = 24000;
    currentSamplesPerFrame = 1920;
    currentLatentDim = 1;
    currentConditioningDim = 1;
    textConditionerSession = sessions.text;
    flowLmMainSession = sessions.main;
    flowLmFlowSession = sessions.flow;
    mimiDecoderSession = sessions.decoder;
    voiceConditioningCache.set('test-voice', {});
    stTensors = [{ s: new Tensor('float32', new Float32Array([0]), [1, 1]),
      t: new Tensor('float32', new Float32Array([1]), [1, 1]) }];
    isGenerating = true;
    runGenerationPipeline('test-voice', chunks, 1);
  `, context);
  assert.deepEqual(encodedTexts, chunks.map(chunk => chunk.text));
  return messages.filter(message => message.type === 'audio_chunk');
}

for (const boundaries of [
  ['continuation', 'sentence', 'continuation', 'sentence'],
  ['continuation', 'continuation', 'continuation'],
  ['sentence']
]) {
  test(`generation emits gaps only after non-final sentence boundaries: ${boundaries.join(', ')}`, async () => {
    const chunks = boundaries.map((boundary, index) => ({ text: `Request ${index + 1}`, boundary }));
    const audio = await generate(chunks);
    let outputIndex = 0;
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
      const emitted = audio[outputIndex++];
      assert.ok(emitted, `missing audio for request ${chunkIndex + 1}`);
      assert.equal(emitted.data.length, 3840);
      assert.ok(emitted.data.every(value => value === (chunkIndex + 1) / 8));
      assert.equal(emitted.metrics.isFirst, chunkIndex === 0);
      assert.equal(emitted.metrics.isLast, chunkIndex === chunks.length - 1);
      assert.equal(emitted.metrics.chunkStart, true);
      assert.ok(!emitted.metrics.isSilence);

      if (chunks[chunkIndex].boundary === 'sentence' && chunkIndex < chunks.length - 1) {
        const gap = audio[outputIndex++];
        assert.ok(gap, 'missing sentence gap');
        assert.equal(gap.data.length, 6000, '250 ms at 24 kHz');
        assert.ok(gap.data.every(value => value === 0));
        assert.equal(gap.metrics.chunkDuration, 0.25);
        assert.equal(gap.metrics.isSilence, true);
        assert.equal(gap.metrics.isFirst, false);
        assert.equal(gap.metrics.isLast, false);
      }
    }
    assert.equal(audio.length, outputIndex, 'no continuation gap or trailing gap');
  });
}
