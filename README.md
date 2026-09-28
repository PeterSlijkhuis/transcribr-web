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

## Privacy: is it really local?

Yes. **Your audio and video files are never uploaded anywhere — to GitHub,
to us, or to anyone.** transcribr-web is a static page with no backend and
no analytics; decoding, diarization and transcription all run inside your
own browser tab as WebAssembly.

This isn't just a claim — it's checkable. The app makes exactly three kinds
of network request, all one-directional *downloads*, and your files never
appear in any of them:

1. `engines/manifest.json` — a small same-origin JSON file listing engine URLs.
2. The whisper.cpp / sherpa-onnx WASM engines and the Whisper model you pick,
   downloaded once from Hugging Face and cached by the browser afterward.
3. `coi-serviceworker.js` re-issues the page's own requests with different
   response headers (needed for `SharedArrayBuffer`); it never adds a new
   destination or new data.

Your audio never goes through `fetch`, `XMLHttpRequest`, or any network
call — it's decoded locally (`AudioContext`) and handed to the transcription
engines only as in-memory `postMessage` data between your own browser tabs
and workers. You can verify this yourself: open DevTools → Network while
transcribing, or just read `app.js` and `engines/*.js` — there's no code
path that sends file contents anywhere.

## Features

- **A clear workflow** — settings, then files, then a queue with live
  progress, then download, laid out as numbered steps on the page
- **Transcription** — Whisper `tiny` (Fast) / `small` (Standard) / `medium`
  (Accurate), with optional translation to English
- **Speaker diarization** — pyannote segmentation + TitaNet embeddings,
  merged onto the transcript by max time-overlap
- **Edit the transcript** — reassign a sentence to a different speaker (the
  way you'd merge it into a neighboring turn) and fix up wording, before
  exporting; edits apply live, no separate save step
- **Rename speakers** — turn "Speaker 1" into "Interviewer" before exporting
- **Export** — CSV, JSON, SRT, DOCX (the CSV/JSON schema matches a companion
  desktop app, so output from either drops into the same analysis pipeline)
- **Offline-friendly** — engines and models are cached in the browser
  (Cache API) after the first run

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
- the transcript editor edits the same per-segment rows every exporter
  reads, so a reassigned speaker or fixed-up sentence shows up in every
  export immediately, with no separate save step
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
