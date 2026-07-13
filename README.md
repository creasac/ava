# ava

ava is a private, browser-only Pocket TTS player. Speech streams from a worker into an AudioWorklet; pasted text never leaves the browser.

## Run locally

```bash
python3 dev_server.py 8000
```

Open `http://localhost:8000`. The included server supplies the cross-origin-isolation headers required for multithreaded WebAssembly. There is no install or build step.

Choose English, German, Italian, Portuguese, or Spanish. ava automatically uses the matching built-in voice: Alba, Juergen, Giovanni, Rafael, or Lola.

Each language downloads about 130–132 MB the first time it is used, then ava keeps that bundle in the browser Cache API and requests persistent storage. Other cached languages are not downloaded again. Clearing site data, using a private window, or browser storage pressure can remove them.

## Playback

Text and language changes automatically start generation after a short pause in editing. Audio builds silently in the background; the play button controls only playback. ava keeps the current reading so it can be paused, replayed, or moved backward and forward without generating it again. A reading is limited to 12,000 input characters and 15 minutes of retained audio to keep memory use predictable.

| Key | Action |
| --- | --- |
| `Space` | Play/pause |
| `Left` / `Right` | Back/forward 5 seconds |

Forward seeking stops at the current live edge while speech is still being generated.

## Main files

- `index.html` — minimal interface and player
- `style.css` — dark responsive presentation
- `app.js` — Pocket worker communication, streaming, and session seeking
- `pocket/inference-worker.js` — Pocket TTS ONNX inference and model caching
- `pocket/PCMPlayerWorklet.js` — low-latency streamed PCM playback
- `dev_server.py` — development-only static server with the headers required for threaded WASM
- `sw.js` — offline app shell

Model files are intentionally not committed. See `THIRD_PARTY_NOTICES.md` for attribution and licenses.

The models and built-in voice downloads are pinned to tested upstream revisions; update the cache version constants whenever either pin changes.
