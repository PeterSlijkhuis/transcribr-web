# transcribr-web: design

Date: 2026-08-13

## Motivation

A standalone, static GitHub Pages app that transcribes audio/video files with
basic speaker diarization and exports the result in multiple formats — no
server, no install, works for anyone at the university who can open a URL.
This is a separate project from the `Wisprflow`/BMS Lab Transcribr Electron
app (sibling folder), not a port of it, though it reuses that project's
already-verified research: `Wisprflow/web/engines/` contains a working spike
of whisper.cpp and sherpa-onnx compiled to WebAssembly, with a confirmed API
in `Wisprflow/web/engines/API.md`. This spec treats that API as ground truth
and does not re-derive it.

## Scope

**In scope:** pick one or more local audio/video files, transcribe with
timestamps, diarize into speakers ("basic" — automatic speaker clustering,
no manual coding/correction workspace), export as CSV, JSON, SRT, and DOCX.

**Out of scope:**
- Live dictation (not portable to a browser sandbox — dropped, not degraded).
- The qualitative-analysis workspace the Electron app has (codebook, coded
  spans, memos, inter-rater reliability). This app is transcribe-in,
  export-out for one browser session — no persistence across page reloads,
  no job history.
- Mobile browsers, and any browser other than desktop Chrome/Edge (see
  "Browser support" below).
- A hard cap on input file length (see "Long recordings" below) — warned,
  not blocked.

## Feasibility (verified, not assumed)

Per `Wisprflow/web/engines/API.md`, both engines are proven working in a
browser via Playwright tests against real fixture audio:

- **whisper.cpp → WASM**: `Module.init(modelPath)` then
  `Module.full_default(instance, float32Audio, lang, nthreads, translate)`;
  output arrives incrementally via `Module.print(text)`, not a return value.
- **sherpa-onnx offline speaker diarization → WASM**:
  `createOfflineSpeakerDiarization(Module, config)` then `sd.process(audio)`
  returns `[{start, end, speaker}, ...]` directly, synchronously.
- **Both builds use `-pthread`/`USE_PTHREADS=1`**, so both require
  `SharedArrayBuffer`, which requires the page to be cross-origin-isolated
  (COOP/COEP response headers). GitHub Pages cannot set custom response
  headers, so this app must ship the `coi-serviceworker` workaround
  (a small vendored service worker that makes the page cross-origin-isolated
  client-side) — this is a hard requirement for the app to function at all,
  not an optional speed optimization.
- **Audio decoding** needs no ffmpeg: the browser's native
  `AudioContext.decodeAudioData` + `OfflineAudioContext` resample handles
  any container the browser can play (covers the common audio/video formats
  used for interview recordings), rendered directly to mono Float32Array at
  each engine's required sample rate.
- **Payload**: whisper `base` model (~141MB) + sherpa's baked-in
  segmentation+embedding models (~103MB `.data` file) + both engines' wasm/js
  glue ≈ 250-300MB on first visit. Both exceed GitHub's 100MB per-file git
  limit, so they're not committed to the repo — see "Asset hosting."

## Architecture

Plain HTML/CSS/JS, ES modules, **no bundler, no build step for the app
itself** — chosen for long-term maintainability by people who aren't
necessarily JS specialists: there's no Node toolchain version to keep
working, `index.html` can be opened and edited directly, and there's nothing
to debug when a bundler breaks.

```
transcribr-web/
  index.html, styles.css, app.js      # main thread: UI, file queue, job rendering, export buttons
  worker.js                            # Web Worker: owns both engines, runs one job at a time
  engines/whisper.js                   # thin wrapper matching API.md's whisper.cpp contract exactly
  engines/sherpa.js                    # thin wrapper matching API.md's sherpa-onnx contract exactly
  engines/manifest.json                # GitHub Release URLs + versions for the WASM/model binaries
  merge.js                             # combine diarization + transcript segments into speaker-labeled rows
                                        #   (mirrors Wisprflow's src/Main/Merge.fs max-overlap logic)
  export/csv.js, json.js, srt.js, docx.js   # pure functions: rows -> Blob
  coi-serviceworker.js                 # vendored COOP/COEP workaround (MIT, gzuidhof/coi-serviceworker)
  NOTICE.md                            # attribution for whisper.cpp / sherpa-onnx / coi-serviceworker licenses
  engines-build/
    whisper/build.sh                   # ported from Wisprflow/web/engines/whisper/build.sh
    sherpa/build.sh                    # ported from Wisprflow/web/engines/sherpa/build.sh
    fixtures/                          # single-speaker.wav, two-speaker.wav, expected-words.json
                                        #   (copied from Wisprflow/web/engines/fixtures/)
  test/e2e.spec.mjs                    # Playwright: real fixture in, real transcript+speakers out
  .github/workflows/
    build-engines.yml                  # manual/tag-triggered: builds WASM via emsdk on ubuntu-latest,
                                        #   publishes dist/ output as a GitHub Release's assets
    deploy-pages.yml                   # on push to main: runs e2e test as a gate, deploys static
                                        #   files (not engines-build/) to GitHub Pages
```

`engines-build/` is a build-time-only tree (mirrors `Wisprflow/web/engines/`'s
own `.gitignore` pattern: vendored upstream source and build output are
gitignored, only the build scripts and fixtures are committed). It only runs
inside `build-engines.yml`, never on a contributor's machine and never as
part of the app's own deploy.

## Data flow

1. Page loads → `coi-serviceworker.js` registers and does one reload if
   needed to become cross-origin-isolated.
2. First engine use → check the Cache API for the whisper/sherpa binaries
   named in `engines/manifest.json`; if missing, download from their GitHub
   Release URLs with a visible progress bar, then cache them. Repeat visits
   skip straight to step 3.
3. User picks file(s) via `<input type=file multiple>` or drag-drop → each
   becomes a queued job, processed **one at a time** (sequential, like the
   desktop app's `Pipeline.fs` — bounds peak memory instead of running
   multiple ~250MB WASM heaps at once). Engine instances are initialized
   once and reused across jobs in the queue, not reloaded per file.
4. Worker, per job: decode file → mono Float32Array at each engine's
   required sample rate → `sherpa.diarize()` → `whisper.transcribe()` →
   `merge.js` → posts the job result back to the main thread.
5. Main thread renders the transcript (speaker-colored turns) and exposes
   CSV/JSON/SRT/DOCX export buttons per job. CSV/JSON use the same
   `speaker_id, timestamp_start, timestamp_end, transcribed_text` schema as
   the desktop app, so output is interchangeable with the existing
   R-analysis workflow described in the Wisprflow README.

## Long recordings

The desktop app routinely handles 45-90+ minute interview recordings; doing
that in a browser tab has real, unaddressed limits: decoding a 90-minute
file to a raw Float32Array plus both engines' working memory can approach a
tab's practical memory ceiling, and whisper.wasm runs sub-realtime on a
laptop, so a long file can take a long time with the tab required to stay
open throughout.

Resolution: a **soft warning, not a hard cap**. Before queuing a file whose
decoded duration exceeds **60 minutes**, show a banner: "Recordings over
about an hour may be slow or run out of memory in this browser tab — for
longer files, consider splitting the file or using the desktop app." The
job still runs if the user proceeds. 60 minutes is a rough, adjustable
threshold (not a measured hard limit) chosen to warn before the range where
memory pressure becomes a real risk, not to block legitimate use.

## Browser support

Written and tested against **desktop Chrome and Edge** only. SharedArrayBuffer
+ WASM SIMD + pthreads are solid there; Safari's support is historically
shakier and mobile browsers can't reasonably handle a 250-300MB download plus
this compute. On load, the app feature-detects WASM SIMD support and
cross-origin isolation (`crossOriginIsolated === true` after the service
worker's reload); if either check fails, it shows a plain "this browser
isn't supported — use desktop Chrome or Edge" banner instead of attempting a
broken run.

## Error handling

- **Compatibility check** (above) runs before anything else.
- **Download failures** (network drop, storage quota): a visible retry
  button, not a silent hang — mirrors the desktop app's Setup-tab pattern.
- **Per-file failures** (corrupt/unsupported input, decode error): that job
  fails with a clear inline message; the queue continues to the next file —
  same graceful-degradation principle as the desktop app.

## Attribution

`NOTICE.md` credits whisper.cpp (MIT), sherpa-onnx (Apache-2.0), and
coi-serviceworker (MIT), since this app distributes their compiled binaries
and vendored source respectively.

## Asset hosting

The whisper `base` model, sherpa's segmentation+embedding models, and both
engines' compiled wasm/js/`.data` output are published as assets on a
GitHub Release in the transcribr-web repo (not committed to git — both the
model and the sherpa `.data` file exceed GitHub's 100MB per-file limit).
`engines/manifest.json` hardcodes that release's asset URLs and a version
string; bumping the engine/model version is: re-run `build-engines.yml`
against a new tag, update `manifest.json` to point at the new release,
commit.

## Testing

No `--selftest` CLI equivalent exists in a browser. Replacement:
`test/e2e.spec.mjs` (Playwright) loads the page against a locally-served
build (with COOP/COEP headers set by a small local dev server), feeds it
the fixture files ported from the Wisprflow spike (`single-speaker.wav`,
`two-speaker.wav`), and asserts: expected words appear in the transcript,
diarization reports the expected speaker count, and each of the four export
formats produces a correctly-structured file (CSV header row present, SRT
timestamp lines present, DOCX is a valid zip with the expected text inside).
This is the one runnable check, and the deploy workflow's gate.

## Deployment

Two independent workflows:
- `build-engines.yml` — manually triggered or on an `engines-vX` tag, since
  it's a slow C++/Emscripten build (ubuntu-latest, pinned Emscripten 4.0.23,
  same versions verified in the Wisprflow spike) that only needs to re-run
  when the model or engine version changes.
- `deploy-pages.yml` — on every push to `main`: runs the Playwright e2e test
  as a gate, then publishes the static app files (excluding
  `engines-build/`) to GitHub Pages via `actions/deploy-pages`.

**Prerequisite:** GitHub Pages and Releases both require an actual GitHub
repository. `transcribr-web/` isn't a git repo yet — creating it locally (this
spec's own commit) is safe and local-only; creating the *remote* GitHub
repo and pushing is a separate, visible action to confirm explicitly during
implementation, not assumed here.
