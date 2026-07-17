# ava

ava is a minimal Pocket TTS player: paste text, choose a language and voice, and listen.

**Live:** [ava.creasac.com](https://ava.creasac.com)

## Use

Text changes start generation automatically after a 700 ms pause; selecting another
language with text present restarts immediately. Audio builds silently in the
background, while the current reading remains available for replay and seeking.
Built-in voices appear in the voice selector. The clone dialog records or uploads
audio and creates a reusable cloned voice for the selected language; at least
3 seconds are required and only the first 10 seconds are used.
The last language and the selected voice for each language are remembered locally.
The theme follows the operating system until the header toggle is used, then the
chosen theme is remembered locally.
When generation finishes, the player can download the completed reading as a
16-bit mono WAV without regenerating it.

| Key | Action |
| --- | --- |
| `Space` | Play/pause |
| `Left` / `Right` | Back/forward 5 seconds |

## Languages

| Language | Default voice |
| --- | --- |
| English | Alba |
| French | Estelle |
| German | Juergen |
| Italian | Giovanni |
| Portuguese | Rafael |
| Spanish | Lola |

French uses the substantially larger 24-layer bundle. It works locally like the
other languages, but generation is much slower on typical CPUs; for uninterrupted
playback, let the reading finish generating first.

Each language has one built-in voice. Cloned voices are language-specific.

## Downloads and storage

Each 6-layer language requires an approximately 130–132 MB first-use model
download. French requires about 387 MB on first use, including its Estelle voice.
The model assets across all six languages total about 1.01 GB; voice files add to
that. ava stores completed bundles in the browser Cache API, requests persistent
storage, and reuses them without another model download. Open the language status
in the header to inspect or remove stored languages at any time. Removing the
active language stops its current load or generation; retained audio remains
playable. Cached models still need to be initialized on each new page load.

Voice cloning lazily adds the approximately 20.8 MB Mimi encoder for that
language. Cloned voice embeddings are stored separately in IndexedDB; the
storage menu lists and removes them without exposing removal controls for
built-in voices.

Caches are separate for each domain, browser, profile, and private window. Clearing
site data or browser storage pressure can remove them.

## Privacy

Pasted text, microphone recordings, uploaded audio, cloned voice states, and
generated audio stay inside the browser. Microphone access is requested only
when recording a clone.
ava has no account, application backend, inference API, analytics, or cookies.

The browser retrieves the site from Cloudflare Pages, ONNX Runtime from jsDelivr,
and model assets from Hugging Face. Those providers receive ordinary network
request information and can infer the requested language, but the pasted text is
not included in those requests.

## Requirements

ava requires a modern browser with WebAssembly SIMD and threads, Web Workers,
AudioWorklet, Cache Storage, and cross-origin isolation. Inference uses the device's
CPU through ONNX Runtime Web, with at most four WASM threads; no GPU or cloud
compute is used.

Voice cloning additionally requires IndexedDB and browser-supported audio
decoding. Recording also requires MediaRecorder and microphone permission.

Production hosting must use HTTPS and return the COOP and COEP headers defined in
`_headers`.

## Limits

- 12,000 input characters and 15 minutes of retained audio per reading
- Editing text discards the old audio and regenerates from the beginning
- Reloading or closing the tab discards text, audio, and playback position
- Forward seeking stops at the generated live edge
- Voice clones require at least 3 seconds of clear, consented speech, use at most
  the first 10 seconds, and are tied to the language selected while cloning
- No speed control, in-app volume control, history, or word-level text/audio
  alignment
- Full offline startup is not guaranteed because the runtime remains an external
  dependency

## Architecture

```text
Cloudflare Pages ─► UI + browser worker
Hugging Face ─► Cache API ───────┐
jsDelivr ─► ONNX Runtime/WASM ───┼─► inference worker ─► Float32 PCM
Pasted text ─────────────────────┘                           │
                                                   retained reading
                                                            │
                                                            ▼
                                                     AudioWorklet ─► speakers

Microphone/audio file ─► Mimi encoder ─► cloned voice embedding ─► IndexedDB
                                                 │
                                                 └─► inference worker conditioning
```

A dedicated worker loads four ONNX sessions and the selected built-in voice. It
tokenizes the text, generates speech in chunks, and transfers 24 kHz mono PCM to
an AudioWorklet for low-latency playback.

## Run locally

```bash
python3 dev_server.py 8000
```

Open `http://localhost:8000`. The development server supplies the isolation headers
required for multithreaded WASM. There is no install or build step.

## Project structure

- `index.html` — interface and player
- `style.css` — responsive presentation
- `app.js` — application controller
- `pocket/inference-worker.js` — ONNX model integration
- `pocket/PCMPlayerWorklet.js` — audio worklet wrapper
- `sw.js` — shell caching and updates
- `dev_server.py` — local static server with the required headers

Model and voice URLs are pinned to tested upstream revisions. Update their cache
version constants when changing either revision.

## Attribution and license

[Pocket TTS](https://github.com/kyutai-labs/pocket-tts) was created by Kyutai. ava
uses a community ONNX conversion and is not endorsed by Kyutai.

Original ava code is licensed under the [MIT License](LICENSE). Third-party code,
model weights, and voice states retain their respective licenses; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
