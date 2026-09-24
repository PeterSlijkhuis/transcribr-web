# transcribr-web

[![Test and deploy](https://github.com/PeterSlijkhuis/transcribr-web/actions/workflows/deploy-pages.yml/badge.svg)](https://github.com/PeterSlijkhuis/transcribr-web/actions/workflows/deploy-pages.yml)
[![Live on GitHub Pages](https://img.shields.io/badge/demo-live-brightgreen)](https://peterslijkhuis.github.io/transcribr-web/)

Transcription and speaker diarization that runs entirely **in the browser**.
No server, no install, no upload — the audio never leaves your machine.

**→ [Try it live](https://peterslijkhuis.github.io/transcribr-web/)** (desktop Chrome or Edge)

## Why

Most "free" transcription tools are a form that uploads your file to someone
else's server. This one isn't. Whisper (via [whisper.cpp](https://github.com/ggml-org/whisper.cpp))
and a speaker-diarization pipeline (via [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx))
are compiled to WebAssembly and run as Web Workers on your own CPU. Drop in a
file, get a transcript with speaker labels, done.

## Features

- **Transcription** — Whisper `tiny` (Fast) / `small` (Standard) / `medium`
  (Accurate), with optional translation to English
- **Speaker diarization** — pyannote segmentation + TitaNet embeddings,
  merged onto the transcript by max time-overlap
- **Rename speakers** — turn "Speaker 1" into "Interviewer" before exporting
- **Export** — CSV, JSON, SRT, DOCX (the CSV/JSON schema matches a companion
  desktop app, so output from either drops into the same analysis pipeline)
- **Offline-friendly** — engines and models are cached in the browser
  (Cache API) after the first run
- **Private by design** — nothing is uploaded; it's a static site with no
  backend

## Run it locally

```sh
node test/serve.mjs        # http://localhost:8090/
```

Any static server works as long as it sends
`Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` (required for the
`SharedArrayBuffer`-based WASM threading). On hosts that can't set those
headers, like GitHub Pages, `coi-serviceworker.js` adds them client-side.
Opening `index.html` via `file://` does not work.

The first file you transcribe downloads about 320 MB of engines and the
standard (`small`) model from Hugging Face (URLs in `engines/manifest.json`);
the browser caches them after that. All three Whisper models are fetched
from `ggerganov/whisper.cpp` on Hugging Face the first time they're picked.

Recommended hardware per model, shown in the app next to the picker:

| Model | Size | Hardware |
| --- | --- | --- |
| Fast (tiny) | 32 MB | Any laptop from the last decade; real-time or faster on one core |
| Standard (small) | 190 MB | A 4+ core CPU from the last ~5 years; roughly real-time with 4 threads |
| Accurate (medium) | 514 MB | An 8+ core CPU; several times slower than real-time |

## How it works

- One dedicated Web Worker per engine — Emscripten's WASM runtime exposes
  itself as globals (`Module`, `HEAPU8`, ...), so two engines can't share a
  worker scope
- `engines/whisper-worker.js` runs whisper.cpp, watching stderr for
  `whisper_print_timings: total time` to know a run finished
- `engines/sherpa-worker.js` runs sherpa-onnx diarization at 16 kHz
- `merge.js` assigns each transcript segment to whichever speaker overlaps
  it the most, splitting segments that straddle a speaker change, then
  numbers speakers by first appearance
- `export/` turns the merged rows into CSV, JSON, SRT, or a hand-built
  minimal DOCX

See `docs/superpowers/specs/` for the full design.

## Tests

```sh
npm install
npm test          # unit tests: merge logic and exporters
npm run e2e       # real engines + fixture audio in headless Chromium
```

`.github/workflows/deploy-pages.yml` runs both on every pull request and on
`master`, then deploys the static files to GitHub Pages from `master`. To
redeploy without a new commit, run it manually on `master` (Actions → Test
and deploy → Run workflow).

## Layout

- `index.html`, `styles.css`, `app.js` — the page, file queue and rendering
- `engines/` — the two worker wrappers, plus the cached-fetch helper and
  engine manifest
- `merge.js`, `shared.js` — speaker/transcript merge logic and small
  formatting helpers
- `export/` — CSV, JSON, SRT, DOCX writers
- `engines-build/` — CI-only scripts that build and publish the WASM
  engines (`.github/workflows/build-engines.yml`)
- `test/` — unit tests, the Playwright e2e check, and a local dev server

## Credits

Built on [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (MIT) and
[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) (Apache-2.0), with
cross-origin isolation via [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker)
(MIT). Full attribution in `NOTICE.md`.
