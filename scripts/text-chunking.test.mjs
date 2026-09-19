// Run with Node 22+: node --test scripts/text-chunking.test.mjs
// The first run downloads the same pinned English tokenizer used by Ava and
// caches it outside the repository. For an offline run, set AVA_TOKENIZER_MODEL
// to a local copy of that tokenizer.model (its SHA-256 is checked below).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { SentencePieceProcessor } from "../pocket/sentencepiece.js";
import { splitTextIntoChunks } from "../pocket/text-chunking.js";

const MODEL_URL = "https://huggingface.co/KevinAHM/pocket-tts-onnx/resolve/58a6d00cf13d239b6748cb0769f35c580a8f606c/onnx/english_2026-04/tokenizer.model";
const MODEL_SHA256 = "d461765ae179566678c93091c5fa6f2984c31bbe990bf1aa62d92c64d91bc3f6";
const modelPath = process.env.AVA_TOKENIZER_MODEL
  || join(tmpdir(), "ava-test-tokenizers", `${MODEL_SHA256}.model`);

function verifyModel(model) {
  assert.equal(createHash("sha256").update(model).digest("hex"), MODEL_SHA256,
    `Expected Ava's pinned English tokenizer at ${modelPath}`);
  return model;
}

async function loadModel() {
  try {
    return verifyModel(await readFile(modelPath));
  } catch (error) {
    if (error.code !== "ENOENT" || process.env.AVA_TOKENIZER_MODEL) throw error;
  }
  let model;
  try {
    const response = await fetch(MODEL_URL, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    model = verifyModel(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    throw new Error("Could not download the pinned tokenizer. Set AVA_TOKENIZER_MODEL to a local copy of tokenizer.model to run offline.", { cause: error });
  }
  await mkdir(dirname(modelPath), { recursive: true });
  await writeFile(modelPath, model);
  return model;
}

const tokenizer = new SentencePieceProcessor();
await tokenizer.loadFromB64StringModel((await loadModel()).toString("base64"));

function split(text, maxTokens = 50, language = "en") {
  const chunks = splitTextIntoChunks(text, { tokenizer, maxTokens, language });
  let position = 0;
  for (const chunk of chunks) {
    assert.ok(chunk.text.length > 0, "chunks must contain text");
    assert.ok(["sentence", "continuation"].includes(chunk.boundary));
    assert.ok(tokenizer.encodeIds(chunk.text).length <= maxTokens,
      `Chunk exceeds the model's token budget: ${JSON.stringify(chunk.text)}`);
    // Allow only whitespace to be omitted at edges. This detects inserted
    // spaces, dropped punctuation, reordered words, and token-decoding changes.
    while (/\s/u.test(text[position] || "") && position < text.length) position++;
    assert.equal(text.slice(position, position + chunk.text.length), chunk.text);
    assert.ok(position === 0 || /\s/u.test(text[position - 1]),
      `Chunk starts inside a word: ${JSON.stringify(chunk.text)}`);
    position += chunk.text.length;
    assert.ok(position === text.length || /\s/u.test(text[position]),
      `Chunk ends inside a word: ${JSON.stringify(chunk.text)}`);
  }
  assert.equal(text.slice(position).trim(), "", "all source text must be retained");
  return chunks;
}

test("decimals and domains remain unchanged when sentences fit together", () => {
  const text = "The value is 3.14. Visit example.com now.";
  assert.deepEqual(split(text), [{ text, boundary: "sentence" }]);
});

test("decimals and domains remain whole when the token budget forces chunks", () => {
  const text = "The value is 3.14. Visit example.com now.";
  const chunks = split(text, 9);
  assert.deepEqual(chunks, [
    { text: "The value is 3.14.", boundary: "sentence" },
    { text: "Visit example.com now.", boundary: "sentence" },
  ]);
});

test("a budget cutting a SentencePiece subword keeps the entire word together", () => {
  const text = "We spoke uncharacteristically slowly while describing an extraordinary misunderstanding.";
  // Six tokens used to decode to "We spoke uncharacteristic". This fixture
  // exercises the real subword boundary, rather than a word-count tokenizer.
  assert.equal(tokenizer.decodeIds(tokenizer.encodeIds(text).slice(0, 6)), "We spoke uncharacteristic");
  const chunks = split(text, 6);
  assert.ok(chunks.some(({ text }) => text.includes("uncharacteristically")));
  assert.ok(chunks.length > 1);
  assert.ok(chunks.slice(0, -1).every(({ boundary }) => boundary === "continuation"),
    "a token limit within a sentence must not request an added sentence pause");
  assert.equal(chunks.at(-1).boundary, "sentence");
});

test("the production 50-token limit also keeps subword tokens together", () => {
  const text = "We spoke ".repeat(24) + "uncharacteristically slowly about what happened.";
  const oldFirstChunk = tokenizer.decodeIds(tokenizer.encodeIds(text).slice(0, 50));
  assert.ok(oldFirstChunk.endsWith(" uncha"), "fixture must exercise a mid-word token cut");
  const chunks = split(text, 50);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].boundary, "continuation");
  assert.ok(chunks[1].text.startsWith("uncharacteristically "));
});

test("a sentence ending takes priority over a later word boundary", () => {
  const text = "Wait here. Then read the rest of this rather long sentence slowly.";
  const chunks = split(text, 7);
  assert.deepEqual(chunks[0], { text: "Wait here.", boundary: "sentence" });
  assert.ok(chunks.some(({ boundary }) => boundary === "continuation"));
});

test("clause punctuation takes priority over a later word boundary", () => {
  for (const punctuation of [",", ";", ":"]) {
    const text = `Keep the words together${punctuation} even when the sentence must continue across several chunks because it is long.`;
    const chunks = split(text, 10);
    assert.deepEqual(chunks[0], {
      text: `Keep the words together${punctuation}`,
      boundary: "continuation",
    });
  }
});

test("abbreviations and closing quotes are preserved", () => {
  const text = 'He used e.g. small words. "Hello there!" She waved.';
  assert.deepEqual(split(text), [{ text, boundary: "sentence" }]);
  const chunks = split(text, 12);
  assert.ok(chunks.some(({ text }) => text.includes("e.g.")));
  assert.ok(chunks.some(({ text }) => text.includes('"Hello there!"')));
});

test("non-English text preserves accents and whole words", () => {
  // Use the real English tokenizer for token budgeting while exercising locale
  // segmentation; this is not a claim about another language model's speech.
  const chunks = split("Dies ist überraschend; wir lesen alle Wörter zusammen.", 14, "de");
  assert.deepEqual(chunks[0], { text: "Dies ist überraschend;", boundary: "continuation" });
  assert.ok(chunks.some(({ text }) => text.includes("überraschend")));
  assert.ok(chunks.some(({ text }) => text.includes("Wörter")));
});

test("existing whitespace within a chunk is retained", () => {
  const text = "  Keep  these words.\tKeep these too.  ";
  assert.deepEqual(split(text), [{ text: text.trim(), boundary: "sentence" }]);
});

test("an unbroken word exceeding the token limit produces an explicit error", () => {
  assert.ok(tokenizer.encodeIds("uncharacteristically").length > 4);
  assert.throws(() => splitTextIntoChunks("uncharacteristically", {
    tokenizer, maxTokens: 4, language: "en",
  }), /word|token|limit/i);
});

test("empty and whitespace-only inputs produce no chunks", () => {
  assert.deepEqual(split(""), []);
  assert.deepEqual(split(" \t\n "), []);
});
