# ava

ava is a minimal Pocket TTS player: paste text, choose a language, and listen.

**Live:** [tts.creasac.com](https://tts.creasac.com)

## Use

Text changes start generation automatically after a 700 ms pause; selecting another
language with text present restarts immediately. Audio builds silently in the
background, while the current reading remains available for replay and seeking.

| Key | Action |
| --- | --- |
| `Space` | Play/pause |
| `Left` / `Right` | Back/forward 5 seconds |

## Languages

| Language | Voice |
| --- | --- |
| English | Alba |
| German | Juergen |
| Italian | Giovanni |
| Portuguese | Rafael |
| Spanish | Lola |

French is not included because the pinned ONNX export provides it only as a
substantially larger and slower 24-layer bundle.

## Downloads and storage

Each language requires an approximately 130–132 MB first-use download; all five
bundles and voices total about 656.5 MB. ava stores completed bundles in the
browser Cache API, requests persistent storage, and reuses them without another
model download. Cached models still need to be initialized on each new page load.

Caches are separate for each domain, browser, profile, and private window. Clearing
site data or browser storage pressure can remove them.

## Privacy

Pasted text and generated audio stay inside the browser. ava has no account,
application backend, inference API, analytics, cookies, or microphone access.

The browser retrieves the site from Cloudflare Pages, ONNX Runtime from jsDelivr,
and model assets from Hugging Face. Those providers receive ordinary network
request information and can infer the requested language, but the pasted text is
not included in those requests.

## Requirements

ava requires a modern browser with WebAssembly SIMD and threads, Web Workers,
AudioWorklet, Cache Storage, and cross-origin isolation. Inference uses the device's
CPU through ONNX Runtime Web, with at most four WASM threads; no GPU or cloud
compute is used.

Production hosting must use HTTPS and return the COOP and COEP headers defined in
`_headers`.

## Limits

- 12,000 input characters and 15 minutes of retained audio per reading
- Editing text discards the old audio and regenerates from the beginning
- Reloading or closing the tab discards text, audio, and playback position
- Forward seeking stops at the generated live edge
- No voice cloning, speed control, in-app volume control, audio export, history,
  or word-level text/audio alignment
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
