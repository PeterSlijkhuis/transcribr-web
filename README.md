# transcribr-web

Audio/video transcription with basic speaker diarization that runs entirely
in the browser: no server, no install, and nothing you transcribe leaves
your machine. Built on whisper.cpp (Whisper `base` model) and sherpa-onnx
(pyannote segmentation + TitaNet speaker embeddings), both compiled to
WebAssembly. Desktop Chrome or Edge.

Pick a model per run: Fast (tiny), Standard (base) or Accurate (small),
optionally translating to English. Speakers can be renamed (for example
"Speaker 1" to "Interviewer") before exporting CSV, JSON, SRT or DOCX. The CSV/JSON schema
(`speaker_id, timestamp_start, timestamp_end, transcribed_text`) matches the
companion desktop app, so output from either works in the same analysis
workflow.

## Run it locally

```sh
node test/serve.mjs        # http://localhost:8090/
```

Any static server works as long as it sends
`Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`; on hosts that can't (GitHub
Pages), `coi-serviceworker.js` adds them client-side. Opening `index.html`
from `file://` does not work.

The first file you add downloads about 275 MB of engines and the standard
model from Hugging Face (URLs in `engines/manifest.json`); the browser
caches them. The tiny and small models come straight from
`ggerganov/whisper.cpp` on Hugging Face the first time they are picked.

## Tests

```sh
npm install
npm test          # unit tests: merge logic and exporters
npm run e2e       # real engines + fixture audio in headless Chromium
```

`.github/workflows/deploy-pages.yml` runs both on every pull request and on
`master`, then deploys the static files to GitHub Pages from `master`.

## Layout

- `index.html`, `styles.css`, `app.js`: the page, file queue and rendering
- `engines/whisper-worker.js`, `engines/sherpa-worker.js`: one Web Worker per
  WASM engine (their Emscripten runtimes are globals and can't share a scope)
- `merge.js`: assigns speakers to transcript segments (port of the desktop
  app's max-overlap merge)
- `export/`: CSV, JSON, SRT, DOCX writers
- `engines-build/`: CI-only scripts that build and publish the WASM engines
  (`.github/workflows/build-engines.yml`)

See `docs/superpowers/specs/` for the design.
