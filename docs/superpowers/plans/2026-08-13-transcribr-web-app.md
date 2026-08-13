# transcribr-web App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The static app itself — file picker, a Web Worker running whisper.cpp + sherpa-onnx WASM to transcribe and diarize, CSV/JSON/SRT/DOCX export, and a GitHub Pages deploy gated on a real end-to-end browser check.

**Architecture:** Plain HTML/CSS/JS, ES modules, no bundler. The main thread (`app.js`) owns the UI and decodes audio via the Web Audio API; a classic (non-module) Web Worker (`worker.js`) owns both WASM engines and does the heavy lifting via `importScripts()`, since the engines' own Emscripten-generated glue is itself a classic, non-ES-module script. Pure logic (`shared.js`, `merge.js`) is written once, in a form loadable both as a global-defining classic script (browser) and via `require()` (Node, for unit tests).

**Tech Stack:** No framework, no bundler. Playwright for the end-to-end check. Node's built-in `node:test`/`node:assert` for unit tests (no test framework dependency).

## Global Constraints

- **Depends on the `engine-build-pipeline` plan.** This plan's Task 1 needs the real Hugging Face asset URLs that plan's Task 5 produces — do not start this plan until that one has a green, published `engines-v1` (or later) run.
- Desktop Chrome/Edge only (per spec) — the compatibility check in `app.js` is the enforcement point.
- No persistence across page reloads: job state lives in memory only, cleared on refresh. No IndexedDB, no job history.
- Jobs process **one at a time**, sequentially (`app.js`'s queue only posts the next job to the worker after the previous one reports `done` or `error`).
- Every cross-origin binary asset (the WASM/model/`.data` files, hosted on Hugging Face — see below) is fetched via `fetch()` + the Cache API + a `blob:` URL before being handed to the engine glue, never loaded directly by URL. This is required, not optional: the app runs under `Cross-Origin-Embedder-Policy: require-corp` (needed for `SharedArrayBuffer`), and COEP blocks any cross-origin resource that doesn't send a matching `Cross-Origin-Resource-Policy` header. Fetching the bytes ourselves and loading from a same-origin `blob:` URL sidesteps that requirement entirely, and doubles as the offline-cache mechanism the spec calls for.
- **Asset hosting is Hugging Face, not a GitHub Release.** Verified empirically: GitHub release assets send no `Access-Control-Allow-Origin` header (a browser `fetch()` reading the response body would be blocked), while Hugging Face's file CDN does send `Access-Control-Allow-Origin: *` — and it's already the pattern this codebase uses for the Whisper model in the native app. `engine-build-pipeline`'s Task 5 publishes there; this plan's Task 1 references `https://huggingface.co/<repo>/resolve/main/<filename>` URLs.
- Export formats and schema match the desktop app: CSV/JSON use the `speaker_id, timestamp_start, timestamp_end, transcribed_text` columns; all four formats (CSV, JSON, SRT, DOCX) are in scope.
- **Known implementation risks to verify once the real engine build exists** (cannot be fully confirmed until `engine-build-pipeline`'s Task 5 has run for real):
  1. Whether `Module.locateFile` correctly redirects sherpa's `.data` file fetch to our pre-fetched `blob:` URL (API.md confirms the `.data` file is auto-fetched by the generated runtime, but doesn't confirm it goes through `locateFile`). If Task 2's Step 4 verification shows it doesn't, grep the built `sherpa-onnx-wasm-main-speaker-diarization.js` for how it fetches the `.data` file and adjust `engines/sherpa.js` accordingly.
  2. The exact sherpa output filenames (`helperJsUrl`/`mainJsUrl`/`wasmUrl`/`dataUrl` in Task 1's manifest) — copy them verbatim from the published files, don't guess.
  3. Both engines are `-pthread` builds, and Emscripten's pthread runtime spawns nested Web Workers by re-loading its own script URL. Loading the main glue from a `blob:` URL (as `engines/whisper.js`/`engines/sherpa.js` do) may break that self-reference, since a `blob:` URL has no meaningful base for the runtime to resolve its own worker script against. Check this in the same Task 6 Step 5 smoke test: if pthread workers fail to spawn (symptom: `full_default`/`process()` hangs or throws inside a nested-worker error rather than completing), grep the built glue for how it constructs the nested worker's URL and, if it truly can't tolerate a `blob:` base, fall back to same-origin hosting for the two JS glue files specifically (small enough to commit directly to this repo) while keeping the large `.wasm`/model/`.data` files on the `blob:` URL path.

---

### Task 1: Engine manifest

**Files:**
- Create: `engines/manifest.json`

**Interfaces:**
- Consumes: the exact filenames recorded at the end of `engine-build-pipeline`'s Task 5, and that plan's Hugging Face repo id.
- Produces: the `{ whisper: {...}, sherpa: {...} }` shape Tasks 2 and 5 read by `fetch("engines/manifest.json")`.

- [ ] **Step 1: Write the manifest**

Substitute the real Hugging Face repo id and sherpa's exact reported filenames from the `engine-build-pipeline` plan's Task 5 output into this shape:

```json
{
  "version": "engines-v1",
  "whisper": {
    "libJsUrl": "https://huggingface.co/<hf-repo-id>/resolve/main/whisper-libmain.js",
    "wasmUrl": "https://huggingface.co/<hf-repo-id>/resolve/main/whisper-libmain.wasm",
    "modelUrl": "https://huggingface.co/<hf-repo-id>/resolve/main/whisper-ggml-base.bin"
  },
  "sherpa": {
    "helperJsUrl": "https://huggingface.co/<hf-repo-id>/resolve/main/<sherpa-helper-js-filename>",
    "mainJsUrl": "https://huggingface.co/<hf-repo-id>/resolve/main/<sherpa-main-glue-js-filename>",
    "wasmUrl": "https://huggingface.co/<hf-repo-id>/resolve/main/<sherpa-wasm-filename>",
    "dataUrl": "https://huggingface.co/<hf-repo-id>/resolve/main/<sherpa-data-filename>"
  }
}
```

- [ ] **Step 2: Verify the URLs actually resolve, and that CORS is really in effect**

```bash
for u in <all seven URLs above>; do
  echo "== $u =="
  curl -s -D - -o /dev/null -H "Origin: https://example.github.io" -L "$u" | grep -i -E "^HTTP|access-control-allow-origin"
done
```

Expected: each prints a final `HTTP/1.1 200` (or `HTTP/2 200`) and an `access-control-allow-origin: *` line. A 404 means a filename was copied wrong — recheck against the file listing from `engine-build-pipeline`'s Task 5 Step 4. A 200 with no CORS header would mean Hugging Face changed behavior since this plan verified it — stop and re-examine before continuing, since the whole loading strategy depends on it.

- [ ] **Step 3: Commit**

```bash
git add engines/manifest.json
git commit -m "Add engine manifest pointing at the published Hugging Face engine assets"
```

---

### Task 2: Engine wrapper modules

**Files:**
- Create: `engines/whisper.js`
- Create: `engines/sherpa.js`

**Interfaces:**
- Consumes: `engines/manifest.json`'s `whisper`/`sherpa` objects (Task 1); a `fetchCachedBlobUrl(url): Promise<string>` function passed in by the caller (defined in `worker.js`, Task 5).
- Produces: global `WhisperEngine` with `{ load(manifestWhisper, fetchCachedBlobUrl): Promise<void>, transcribe(audioFloat32, language, quietMs): Promise<{t0,t1,text}[]> }`; global `SherpaEngine` with `{ load(manifestSherpa, fetchCachedBlobUrl): Promise<void>, diarize(numSpeakers): void, sampleRate(): number, process(audioFloat32): {start,end,speaker}[] }`. Both are classic scripts (no `import`/`export`) loaded via `importScripts()` in `worker.js`, matching the API documented in `Wisprflow/web/engines/API.md`.

- [ ] **Step 1: Write the whisper.cpp wrapper**

```js
// engines/whisper.js -- classic script (no import/export), loaded via
// importScripts() in worker.js. API per Wisprflow/web/engines/API.md:
// output arrives via Module.print(text) line-by-line, not a return value.
var WhisperEngine = (function () {
  let Module = null;
  let instance = null;
  let segments = [];

  function parseSegmentLine(line) {
    // whisper.cpp prints "[hh:mm:ss.mmm --> hh:mm:ss.mmm]  text" per segment.
    const m = line.match(/^\[(\d\d):(\d\d):(\d\d)\.(\d\d\d) --> (\d\d):(\d\d):(\d\d)\.(\d\d\d)\]\s*(.*)$/);
    if (!m) return null;
    const t0 = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000;
    const t1 = (+m[5]) * 3600 + (+m[6]) * 60 + (+m[7]) + (+m[8]) / 1000;
    return { t0, t1, text: m[9].trim() };
  }

  // Whisper prints "[BLANK_AUDIO]", "(music)" etc for non-speech -- drop those.
  function isNoise(text) {
    return text === "" || /^\[[^\]]*\]$/.test(text) || /^\([^)]*\)$/.test(text) || /^\*[^*]*\*$/.test(text);
  }

  async function load(manifestWhisper, fetchCachedBlobUrl) {
    const wasmBlobUrl = await fetchCachedBlobUrl(manifestWhisper.wasmUrl);
    const jsBlobUrl = await fetchCachedBlobUrl(manifestWhisper.libJsUrl);
    let resolveReady;
    const ready = new Promise((r) => { resolveReady = r; });
    self.Module = {
      print: (text) => {
        const seg = parseSegmentLine(text);
        if (seg && !isNoise(seg.text)) segments.push(seg);
      },
      printErr: () => {},
      locateFile: () => wasmBlobUrl,
      onRuntimeInitialized: () => resolveReady(),
    };
    importScripts(jsBlobUrl);
    await ready;
    Module = self.Module;
    const modelBlobUrl = await fetchCachedBlobUrl(manifestWhisper.modelUrl);
    const modelBytes = new Uint8Array(await (await fetch(modelBlobUrl)).arrayBuffer());
    try { Module.FS_unlink("whisper.bin"); } catch (e) {}
    Module.FS_createDataFile("/", "whisper.bin", modelBytes, true, true);
    instance = Module.init("whisper.bin");
    if (!instance) throw new Error("whisper.wasm: init() returned 0");
  }

  /// full_default's return value only means "handed off to a background
  /// thread", not "done" -- see API.md. Resolve once no new segment has
  /// arrived for quietMs.
  async function transcribe(audioFloat32, language, quietMs) {
    segments = [];
    const nthreads = Math.max(1, Math.min(8, (self.navigator.hardwareConcurrency || 4) - 1));
    const ret = Module.full_default(instance, audioFloat32, language || "auto", nthreads, false);
    if (ret !== 0) throw new Error("whisper.wasm: full_default returned " + ret);
    let lastCount = -1;
    while (true) {
      await new Promise((r) => setTimeout(r, quietMs || 1500));
      if (segments.length === lastCount) break;
      lastCount = segments.length;
    }
    return segments.slice();
  }

  return { load, transcribe };
})();
```

- [ ] **Step 2: Write the sherpa-onnx wrapper**

```js
// engines/sherpa.js -- classic script (no import/export), loaded via
// importScripts() in worker.js. API per Wisprflow/web/engines/API.md.
var SherpaEngine = (function () {
  let sd = null;

  async function load(manifestSherpa, fetchCachedBlobUrl) {
    const wasmBlobUrl = await fetchCachedBlobUrl(manifestSherpa.wasmUrl);
    const dataBlobUrl = await fetchCachedBlobUrl(manifestSherpa.dataUrl);
    const helperJsBlobUrl = await fetchCachedBlobUrl(manifestSherpa.helperJsUrl);
    const mainJsBlobUrl = await fetchCachedBlobUrl(manifestSherpa.mainJsUrl);
    let resolveReady;
    const ready = new Promise((r) => { resolveReady = r; });
    self.Module = {
      print: () => {},
      printErr: () => {},
      // See this plan's "Known implementation risks" #1 if the .data file
      // doesn't actually route through locateFile in the real build.
      locateFile: (path) => (path.endsWith(".data") ? dataBlobUrl : wasmBlobUrl),
      onRuntimeInitialized: () => resolveReady(),
    };
    importScripts(helperJsBlobUrl, mainJsBlobUrl);
    await ready;
  }

  function diarize(numSpeakers) {
    const config = {
      segmentation: { pyannote: { model: "./segmentation.onnx" }, debug: 0 },
      embedding: { model: "./embedding.onnx", debug: 0 },
      clustering: { numClusters: numSpeakers > 0 ? numSpeakers : -1, threshold: 0.5 },
      minDurationOn: 0.3,
      minDurationOff: 0.5,
    };
    sd = self.createOfflineSpeakerDiarization(self.Module, config);
  }

  function sampleRate() {
    return sd.sampleRate;
  }

  function process(audioFloat32) {
    return sd.process(audioFloat32);
  }

  return { load, diarize, sampleRate, process };
})();
```

- [ ] **Step 3: Commit**

```bash
git add engines/whisper.js engines/sherpa.js
git commit -m "Add whisper.cpp and sherpa-onnx WASM wrapper modules"
```

(Real verification of these against the actual built engine glue happens in Task 5's manual smoke test, once `worker.js` exists to drive them — see that task's Step 3.)

---

### Task 3: Shared pure logic (`shared.js`, `merge.js`)

**Files:**
- Create: `shared.js`
- Create: `merge.js`
- Test: `test/unit-shared.js`
- Test: `test/unit-merge.js`

**Interfaces:**
- Produces: global `fmtClock(sec): string`, `toTurns(rows): rows`, `speakerCount(rows): number` (from `shared.js`); global `assignSpeakers(wsegs, dsegs): rows` (from `merge.js`). Both files also `module.exports` the same functions when run under Node (the unit tests use this), so there is exactly one implementation, not a browser copy and a test copy.
- Consumes (in the browser): nothing — pure functions. Loaded via a plain `<script>` tag in `index.html` (Task 6) and via `importScripts()` in `worker.js` (Task 5).

- [ ] **Step 1: Write the failing test for `shared.js`**

```js
// test/unit-shared.js
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { fmtClock, toTurns, speakerCount } = require("../shared.js");

test("fmtClock formats mm:ss", () => {
  assert.equal(fmtClock(65), "01:05");
  assert.equal(fmtClock(0), "00:00");
});

test("toTurns collapses consecutive same-speaker rows", () => {
  const rows = [
    { speaker_id: "Speaker 1", timestamp_start: 0, timestamp_end: 1, transcribed_text: "hello" },
    { speaker_id: "Speaker 1", timestamp_start: 1, timestamp_end: 2, transcribed_text: "world" },
    { speaker_id: "Speaker 2", timestamp_start: 2, timestamp_end: 3, transcribed_text: "hi" },
  ];
  const turns = toTurns(rows);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].transcribed_text, "hello world");
  assert.equal(turns[0].timestamp_end, 2);
  assert.equal(turns[1].speaker_id, "Speaker 2");
});

test("speakerCount counts distinct speakers", () => {
  const rows = [{ speaker_id: "Speaker 1" }, { speaker_id: "Speaker 1" }, { speaker_id: "Speaker 2" }];
  assert.equal(speakerCount(rows), 2);
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `node --test test/unit-shared.js`
Expected: fails with a module-not-found error for `../shared.js` (it doesn't exist yet).

- [ ] **Step 3: Implement `shared.js`**

```js
// shared.js -- classic script (no import/export): loaded via <script> in
// index.html (before app.js) and via importScripts() in worker.js. Also
// require()-able from plain Node (test/unit-shared.js) via the
// module.exports guard at the bottom. Ported from Wisprflow's
// src/Shared/Shared.fs (toTurns) and src/Main/Merge.fs (speakerCount).

/// mm:ss clock, used by the DOCX turn labels.
function fmtClock(sec) {
  const s = Math.floor(sec);
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

/// Collapse consecutive same-speaker rows into conversational turns.
function toTurns(rows) {
  const acc = [];
  for (const r of rows) {
    const last = acc[acc.length - 1];
    if (last && last.speaker_id === r.speaker_id) {
      acc[acc.length - 1] = {
        ...last,
        timestamp_end: r.timestamp_end,
        transcribed_text: (last.transcribed_text + " " + r.transcribed_text).trim(),
      };
    } else {
      acc.push({ ...r });
    }
  }
  return acc;
}

function speakerCount(rows) {
  return new Set(rows.map((r) => r.speaker_id)).size;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { fmtClock, toTurns, speakerCount };
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `node --test test/unit-shared.js`
Expected: 3 passing tests.

- [ ] **Step 5: Write the failing test for `merge.js`**

```js
// test/unit-merge.js
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { assignSpeakers } = require("../merge.js");

test("assignSpeakers assigns by max overlap", () => {
  const wsegs = [
    { t0: 0, t1: 2, text: "hello there" },
    { t0: 2, t1: 4, text: "general kenobi" },
  ];
  const dsegs = [
    { s: 0, e: 2.1, spk: 0 },
    { s: 2.1, e: 5, spk: 1 },
  ];
  const rows = assignSpeakers(wsegs, dsegs);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].speaker_id, "Speaker 1");
  assert.equal(rows[1].speaker_id, "Speaker 2");
});

test("assignSpeakers falls back to nearest midpoint with no overlap, ties favor the first segment", () => {
  const rows = assignSpeakers(
    [{ t0: 10, t1: 11, text: "hi" }],
    [
      { s: 0, e: 1, spk: 0 },
      { s: 20, e: 21, spk: 1 },
    ]
  );
  assert.equal(rows[0].speaker_id, "Speaker 1");
});

test("assignSpeakers with no diarization segments assigns everything to Speaker 1", () => {
  const rows = assignSpeakers([{ t0: 0, t1: 1, text: "solo" }], []);
  assert.equal(rows[0].speaker_id, "Speaker 1");
});
```

- [ ] **Step 6: Run it, verify it fails**

Run: `node --test test/unit-merge.js`
Expected: fails with a module-not-found error for `../merge.js`.

- [ ] **Step 7: Implement `merge.js`**

```js
// merge.js -- classic script (no import/export), loaded via
// importScripts() in worker.js. Also require()-able from plain Node
// (test/unit-merge.js). Ported from Wisprflow's src/Main/Merge.fs (the
// same max-overlap speaker-assignment algorithm the desktop app uses),
// since whisper.wasm's embind API has no equivalent to whisper-cli's
// -ml/-sow segment-length cap (see engines/whisper.js) -- splitAtBoundaries
// is the only mechanism apportioning a longer raw whisper.wasm segment
// across a diarization boundary that falls inside it.

function round3(x) {
  return Math.round(x * 1000) / 1000;
}

function splitAtBoundaries(dsegs, w) {
  const dur = w.t1 - w.t0;
  if (dsegs.length < 2 || dur <= 0.4) return [w];

  const boundaries = [];
  for (let i = 0; i < dsegs.length - 1; i++) {
    const a = dsegs[i], b = dsegs[i + 1];
    if (a.spk !== b.spk) {
      const cut = (a.e + b.s) / 2;
      if (cut > w.t0 + dur * 0.15 && cut < w.t1 - dur * 0.15) boundaries.push(cut);
    }
  }
  const uniqSorted = [...new Set(boundaries)].sort((a, b) => a - b);
  if (uniqSorted.length === 0) return [w];

  const tokens = w.text.trim().split(" ").filter((t) => t !== "");
  if (tokens.length < 2) return [w];

  const pieces = [];
  let startT = w.t0;
  let startI = 0;
  for (const b of uniqSorted) {
    const raw = Math.round((tokens.length * (b - w.t0)) / dur);
    const idx = Math.max(startI + 1, Math.min(tokens.length - 1, raw));
    if (idx > startI) {
      pieces.push({ t0: startT, t1: b, text: tokens.slice(startI, idx).join(" ") });
      startT = b;
      startI = idx;
    }
  }
  if (startI < tokens.length) {
    pieces.push({ t0: startT, t1: w.t1, text: tokens.slice(startI).join(" ") });
  }
  return pieces;
}

/// Assign each whisper segment the speaker whose diarization turn overlaps
/// it the most; fall back to the nearest-midpoint turn when there is no
/// overlap. Ties favor whichever diarization segment comes first.
function assignSpeakers(wsegs, dsegs) {
  function speakerOf(w) {
    if (dsegs.length === 0) return 0;
    let best = dsegs[0];
    let bestOverlap = -Infinity;
    for (const d of dsegs) {
      const overlap = Math.max(0, Math.min(w.t1, d.e) - Math.max(w.t0, d.s));
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        best = d;
      }
    }
    if (bestOverlap > 0) return best.spk;
    const mid = (w.t0 + w.t1) / 2;
    let nearest = dsegs[0];
    let nearestDist = Infinity;
    for (const d of dsegs) {
      const dist = Math.abs((d.s + d.e) / 2 - mid);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = d;
      }
    }
    return nearest.spk;
  }

  const sorted = [...wsegs].sort((a, b) => a.t0 - b.t0);
  const split = sorted.flatMap((w) => splitAtBoundaries(dsegs, w));
  return split.map((w) => ({
    speaker_id: `Speaker ${speakerOf(w) + 1}`,
    timestamp_start: round3(w.t0),
    timestamp_end: round3(w.t1),
    transcribed_text: w.text.trim(),
  }));
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { assignSpeakers, splitAtBoundaries };
}
```

- [ ] **Step 8: Run it, verify it passes**

Run: `node --test test/unit-merge.js`
Expected: 3 passing tests.

- [ ] **Step 9: Commit**

```bash
git add shared.js merge.js test/unit-shared.js test/unit-merge.js
git commit -m "Add shared/merge pure logic, ported from the desktop app, with unit tests"
```

---

### Task 4: Export writers (CSV, JSON, SRT, DOCX)

**Files:**
- Create: `export/download.js`
- Create: `export/csv.js`
- Create: `export/json.js`
- Create: `export/srt.js`
- Create: `export/docx.js`
- Test: `test/unit-export.mjs`

**Interfaces:**
- Consumes: global `toTurns`/`speakerCount`/`fmtClock` from `shared.js` (Task 3) — available as globals in the browser (loaded via `<script>` before `app.js`), loaded explicitly in the test via `require()`.
- Produces: ES modules `export/{csv,json,srt,docx}.js`, each exporting a pure `toX(rows)`/`buildDocx(...)` function plus a `downloadX(...)` function that triggers a browser file download. Consumed by `app.js` (Task 6).

- [ ] **Step 1: Write the shared download trigger**

```js
// export/download.js
export function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
```

- [ ] **Step 2: Write the CSV writer**

```js
// export/csv.js -- schema matches the desktop app's CSV export exactly
// (speaker_id, timestamp_start, timestamp_end, transcribed_text), so
// output from either app is interchangeable in the same R workflow.
import { triggerDownload } from "./download.js";

function csvField(s) {
  if (s.includes('"') || s.includes(",") || s.includes("\n") || s.includes("\r")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

export function toCsv(rows) {
  const header = "speaker_id,timestamp_start,timestamp_end,transcribed_text";
  const lines = rows.map((r) =>
    [csvField(r.speaker_id), r.timestamp_start.toFixed(3), r.timestamp_end.toFixed(3), csvField(r.transcribed_text)].join(",")
  );
  return header + "\n" + lines.join("\n") + "\n";
}

export function downloadCsv(rows, filename) {
  triggerDownload(new Blob([toCsv(rows)], { type: "text/csv" }), filename);
}
```

- [ ] **Step 3: Write the JSON writer**

```js
// export/json.js
import { triggerDownload } from "./download.js";
// toTurns/speakerCount come from shared.js, loaded globally via a plain
// <script> tag in index.html before this module runs.

export function toJsonString(sourceFileName, durationSec, rows) {
  const payload = {
    source_file: sourceFileName,
    duration_sec: durationSec,
    whisper_model: "whisper.cpp ggml-base (wasm)",
    diarization: "sherpa-onnx (pyannote segmentation-3.0 + TitaNet embedding)",
    generated_at: new Date().toISOString(),
    speaker_count: speakerCount(rows),
    segments: rows,
    turns: toTurns(rows),
  };
  return JSON.stringify(payload, null, 2);
}

export function downloadJson(sourceFileName, durationSec, rows, filename) {
  triggerDownload(new Blob([toJsonString(sourceFileName, durationSec, rows)], { type: "application/json" }), filename);
}
```

- [ ] **Step 4: Write the SRT writer**

```js
// export/srt.js
import { triggerDownload } from "./download.js";

function srtTime(sec) {
  const total = Math.max(0, sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const ms = Math.min(999, Math.round((total - Math.floor(total)) * 1000));
  const pad = (n, w) => String(n).padStart(w, "0");
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(ms, 3)}`;
}

export function toSrt(rows) {
  return rows
    .map((r, i) => `${i + 1}\r\n${srtTime(r.timestamp_start)} --> ${srtTime(r.timestamp_end)}\r\n${r.speaker_id}: ${r.transcribed_text.trim()}\r\n`)
    .join("\r\n");
}

export function downloadSrt(rows, filename) {
  triggerDownload(new Blob([toSrt(rows)], { type: "application/x-subrip" }), filename);
}
```

- [ ] **Step 5: Write the DOCX writer**

```js
// export/docx.js -- minimal, dependency-free .docx (OOXML) generation,
// ported from Wisprflow's src/Main/Docx.fs: a .docx is a ZIP of a few XML
// parts, built by hand (STORED entries + CRC32) so no zip library is
// needed. Word opens the result normally. toTurns/speakerCount/fmtClock
// come from shared.js, loaded globally via <script> in index.html.
import { triggerDownload } from "./download.js";

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    let c = (crc ^ bytes[i]) & 0xff;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(n) {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n & 0xffff, true);
  return b;
}
function u32(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, true);
  return b;
}
function concatBytes(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/// Build a ZIP archive (all entries STORED/uncompressed) from {name, data}
/// objects where data is a Uint8Array.
function zipStored(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = new TextEncoder().encode(e.name);
    const data = e.data;
    const crc = crc32(data);
    const local = concatBytes([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), name,
    ]);
    parts.push(local, data);
    const cent = concatBytes([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0),
      u32(0), u32(offset), name,
    ]);
    central.push(cent);
    offset += local.length + data.length;
  }
  const cd = concatBytes(central);
  const end = concatBytes([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(cd.length), u32(offset), u16(0),
  ]);
  return concatBytes([...parts, cd, end]);
}

function xmlEsc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const contentTypesXml =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  "</Types>";

const relsXml =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  "</Relationships>";

function para(bold, rest) {
  const boldRun = bold ? `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${xmlEsc(bold)}</w:t></w:r>` : "";
  const restRun = rest ? `<w:r><w:t xml:space="preserve">${xmlEsc(rest)}</w:t></w:r>` : "";
  return `<w:p>${boldRun}${restRun}</w:p>`;
}

function heading(text) {
  return `<w:p><w:r><w:rPr><w:b/><w:sz w:val="32"/></w:rPr><w:t xml:space="preserve">${xmlEsc(text)}</w:t></w:r></w:p>`;
}

export function buildDocx(title, rows) {
  const turns = toTurns(rows);
  const body =
    heading(title) +
    para("", `${speakerCount(rows)} speakers · ${rows.length} segments · generated by transcribr-web`) +
    para("", "") +
    turns.map((r) => para(`${r.speaker_id} [${fmtClock(r.timestamp_start)}–${fmtClock(r.timestamp_end)}]  `, r.transcribed_text)).join("");
  const documentXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    "<w:body>" + body + "<w:sectPr/></w:body></w:document>";
  const enc = new TextEncoder();
  return zipStored([
    { name: "[Content_Types].xml", data: enc.encode(contentTypesXml) },
    { name: "_rels/.rels", data: enc.encode(relsXml) },
    { name: "word/document.xml", data: enc.encode(documentXml) },
  ]);
}

export function downloadDocx(title, rows, filename) {
  triggerDownload(
    new Blob([buildDocx(title, rows)], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }),
    filename
  );
}
```

- [ ] **Step 6: Write and run the unit test**

```js
// test/unit-export.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

// shared.js is a classic script with a module.exports guard; pull its
// functions into globalThis the same way index.html's plain <script> tag
// makes them global in the browser, before importing modules that use them.
const require = createRequire(import.meta.url);
Object.assign(globalThis, require("../shared.js"));

const { toCsv } = await import("../export/csv.js");
const { toSrt } = await import("../export/srt.js");
const { buildDocx } = await import("../export/docx.js");

const rows = [
  { speaker_id: "Speaker 1", timestamp_start: 0, timestamp_end: 1.5, transcribed_text: "hello, world" },
  { speaker_id: "Speaker 2", timestamp_start: 1.5, timestamp_end: 3, transcribed_text: "hi" },
];

test("toCsv quotes fields containing commas", () => {
  const csv = toCsv(rows);
  assert.match(csv, /^speaker_id,timestamp_start,timestamp_end,transcribed_text\n/);
  assert.match(csv, /"hello, world"/);
});

test("toSrt emits SRT cue format with speaker prefix", () => {
  const srt = toSrt(rows);
  assert.match(srt, /^1\r\n00:00:00,000 --> 00:00:01,500\r\nSpeaker 1: hello, world\r\n/);
});

test("buildDocx produces a valid ZIP (PK signature + matching entry count)", () => {
  const bytes = buildDocx("Test", rows);
  assert.equal(bytes[0], 0x50);
  assert.equal(bytes[1], 0x4b);
  const tail = bytes.slice(bytes.length - 22);
  assert.equal(tail[0], 0x50);
  assert.equal(tail[1], 0x4b);
  assert.equal(tail[2], 0x05);
  assert.equal(tail[3], 0x06);
  const view = new DataView(tail.buffer, tail.byteOffset);
  const entryCount = view.getUint16(10, true);
  assert.equal(entryCount, 3);
});
```

Run: `node --test test/unit-export.mjs`
Expected: 3 passing tests.

- [ ] **Step 7: Commit**

```bash
git add export/ test/unit-export.mjs
git commit -m "Add CSV/JSON/SRT/DOCX export writers, ported from the desktop app, with unit tests"
```

---

### Task 5: Worker orchestration

**Files:**
- Create: `worker.js`

**Interfaces:**
- Consumes: `shared.js`, `merge.js`, `engines/whisper.js`, `engines/sherpa.js` (all via `importScripts()`), `engines/manifest.json` (via `fetch()`).
- Produces: a classic `Worker` that accepts `postMessage({ jobId, samples: Float32Array, durationSec, numSpeakers, language })` (with `samples.buffer` transferred) and emits a sequence of `postMessage({ jobId, status, stage, progress, ... })` culminating in `status: "done"` (with `rows`, `durationSec`, `speakerCount`) or `status: "error"` (with `error`). Consumed by `app.js` (Task 6).

- [ ] **Step 1: Write the worker**

```js
// worker.js -- classic (non-module) worker: uses importScripts() because
// the engines' own Emscripten glue is a classic, non-ES-module script and
// both must share one worker scope. Audio is already decoded to 16kHz mono
// on the main thread (app.js) and transferred in, so this file has no Web
// Audio API dependency at all.
importScripts("shared.js", "merge.js", "engines/whisper.js", "engines/sherpa.js");

const CACHE_NAME = "transcribr-web-engines-v1";

async function fetchCachedBlobUrl(url) {
  const cache = await caches.open(CACHE_NAME);
  let res = await cache.match(url);
  if (!res) {
    const fresh = await fetch(url);
    if (!fresh.ok) throw new Error(`download failed (${fresh.status}): ${url}`);
    await cache.put(url, fresh.clone());
    res = fresh;
  }
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

let manifest = null;
let enginesLoaded = false;

async function ensureEnginesLoaded(onStage) {
  if (enginesLoaded) return;
  if (!manifest) {
    manifest = await (await fetch("engines/manifest.json")).json();
  }
  onStage("downloading whisper engine");
  await WhisperEngine.load(manifest.whisper, fetchCachedBlobUrl);
  onStage("downloading diarization engine");
  await SherpaEngine.load(manifest.sherpa, fetchCachedBlobUrl);
  enginesLoaded = true;
}

self.onmessage = async (ev) => {
  const { jobId, samples, durationSec, numSpeakers, language } = ev.data;
  const post = (patch) => self.postMessage({ jobId, ...patch });
  try {
    post({ status: "processing", stage: "loading engines", progress: 0.05 });
    await ensureEnginesLoaded((stage) => post({ status: "processing", stage, progress: 0.1 }));

    post({ status: "processing", stage: "diarizing speakers", progress: 0.3 });
    SherpaEngine.diarize(numSpeakers || 0);
    const rate = SherpaEngine.sampleRate();
    if (rate !== 16000) {
      throw new Error(`diarization engine expects ${rate}Hz audio, but this app only decodes at 16000Hz`);
    }
    const rawSegments = SherpaEngine.process(samples);
    const dsegs = rawSegments.map((s) => ({ s: s.start, e: s.end, spk: s.speaker }));

    post({ status: "processing", stage: "transcribing", progress: 0.55 });
    const wsegs = await WhisperEngine.transcribe(samples, language || "auto", 1500);

    post({ status: "processing", stage: "merging speakers with transcript", progress: 0.9 });
    const rows = assignSpeakers(wsegs, dsegs);

    post({
      status: "done",
      stage: "done",
      progress: 1,
      rows,
      durationSec,
      speakerCount: speakerCount(rows),
    });
  } catch (err) {
    post({ status: "error", stage: "failed", error: String(err && err.message ? err.message : err) });
  }
};
```

- [ ] **Step 2: Commit**

```bash
git add worker.js
git commit -m "Add worker orchestration: engine loading, diarize, transcribe, merge"
```

- [ ] **Step 3: Manual smoke test (real verification against the real engine build)**

This is the first point where `engines/whisper.js`/`engines/sherpa.js` (Task 2) run against the *actual* built engines from `engine-build-pipeline`, so it's also where this plan's "Known implementation risks" get resolved for real. Once Task 6 exists (there needs to be *something* calling `new Worker("worker.js")` and posting a message — Task 6 provides that), come back and run the app end-to-end once by hand in a real browser before writing Task 7's automated version, and fix `engines/sherpa.js`'s `locateFile` per the risk note if the `.data` fetch doesn't route through it.

---

### Task 6: App shell — compatibility check, file queue, UI, exports

**Files:**
- Create: `index.html`
- Create: `styles.css`
- Create: `app.js`
- Create: `coi-serviceworker.js` (vendored, not hand-written)

**Interfaces:**
- Consumes: `worker.js` (Task 5, via `new Worker("worker.js")`), `export/{csv,json,srt,docx}.js` (Task 4), `shared.js` (Task 3, via global `toTurns`).
- Produces: the actual page a user opens.

- [ ] **Step 1: Vendor coi-serviceworker**

This is a well-known, small, security-relevant MIT-licensed script (client-side COOP/COEP emulation) — fetch the real file rather than hand-writing a reconstruction of it.

Run: `curl -L -o coi-serviceworker.js https://raw.githubusercontent.com/gzuidhof/coi-serviceworker/master/coi-serviceworker.js`
Expected: a JS file a few hundred lines long. Skim it to confirm it registers itself and reloads the page once to become cross-origin-isolated — that's the behavior `app.js`'s compatibility check (Step 4) waits on.

- [ ] **Step 2: Write the HTML shell**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>transcribr-web</title>
  <script src="/coi-serviceworker.js"></script>
  <script src="/shared.js"></script>
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  <h1>transcribr-web</h1>
  <p class="subtitle">Local transcription + speaker diarization, entirely in your browser. Desktop Chrome or Edge only.</p>

  <div id="compat-banner" class="banner banner-error" hidden></div>
  <div id="download-banner" class="banner banner-info" hidden></div>

  <section id="picker">
    <input type="file" id="file-input" accept="audio/*,video/*" multiple />
    <div id="dropzone">Drop audio/video files here, or use the picker above.</div>
  </section>

  <section id="options">
    <label>Speakers (0 = auto): <input type="number" id="num-speakers" min="0" value="0" /></label>
    <label>Language (blank = auto): <input type="text" id="language" placeholder="auto" /></label>
  </section>

  <ul id="job-list"></ul>

  <script type="module" src="/app.js"></script>
</body>
</html>
```

- [ ] **Step 3: Write a minimal stylesheet**

```css
/* styles.css */
:root {
  color-scheme: light dark;
  font-family: system-ui, sans-serif;
}
body {
  max-width: 800px;
  margin: 2rem auto;
  padding: 0 1rem;
}
.subtitle {
  color: #666;
}
.banner {
  padding: 0.75rem 1rem;
  border-radius: 6px;
  margin: 1rem 0;
}
.banner-error {
  background: #fde2e2;
  color: #7a1f1f;
}
.banner-info {
  background: #e2f0fd;
  color: #1f4a7a;
}
#dropzone {
  border: 2px dashed #999;
  border-radius: 8px;
  padding: 2rem;
  text-align: center;
  margin-top: 0.5rem;
}
#options {
  display: flex;
  gap: 1.5rem;
  margin: 1rem 0;
}
#job-list {
  list-style: none;
  padding: 0;
}
.job {
  border: 1px solid #ccc;
  border-radius: 6px;
  padding: 0.75rem 1rem;
  margin-bottom: 0.75rem;
}
.job-name {
  font-weight: 600;
}
.job-error {
  color: #b00020;
}
.job-exports button {
  margin-right: 0.5rem;
}
.job-transcript {
  white-space: pre-wrap;
  max-height: 300px;
  overflow-y: auto;
  background: rgba(127, 127, 127, 0.08);
  padding: 0.5rem;
  border-radius: 4px;
}
.job-warning {
  background: #fff4e2;
  color: #7a5a1f;
  padding: 0.5rem;
  border-radius: 4px;
  margin-top: 0.5rem;
}
.job-warning button {
  margin-right: 0.5rem;
}
```

- [ ] **Step 4: Write `app.js`**

```js
// app.js -- main thread: compatibility check, audio decode, file queue,
// worker coordination, transcript rendering, export buttons.
import { downloadCsv } from "./export/csv.js";
import { downloadJson } from "./export/json.js";
import { downloadSrt } from "./export/srt.js";
import { downloadDocx } from "./export/docx.js";

const LONG_RECORDING_WARN_SEC = 60 * 60; // soft warning threshold, see spec

const compatBanner = document.getElementById("compat-banner");
const downloadBanner = document.getElementById("download-banner");
const fileInput = document.getElementById("file-input");
const dropzone = document.getElementById("dropzone");
const jobList = document.getElementById("job-list");
const numSpeakersInput = document.getElementById("num-speakers");
const languageInput = document.getElementById("language");

function checkCompat() {
  const hasSAB = typeof SharedArrayBuffer !== "undefined" && self.crossOriginIsolated === true;
  const isChromium = /Chrome|Edg\//.test(navigator.userAgent);
  if (!hasSAB || !isChromium) {
    compatBanner.hidden = false;
    compatBanner.textContent = !hasSAB
      ? "This browser can't run transcribr-web (missing SharedArrayBuffer / cross-origin isolation) -- try desktop Chrome or Edge."
      : "transcribr-web is built for desktop Chrome or Edge. It may not work correctly in this browser.";
  }
  // Only SharedArrayBuffer support actually blocks running -- the Chromium
  // check is a softer "not the tested target" warning, not a hard stop.
  if (!hasSAB) {
    fileInput.disabled = true;
    dropzone.textContent = "Unsupported browser -- see message above.";
    dropzone.style.opacity = "0.5";
  }
  return hasSAB;
}

const worker = new Worker("worker.js");
const jobs = new Map();
let queue = [];
let running = false;

function newJobId() {
  return Math.random().toString(36).slice(2, 10);
}

async function decodeFileTo16kMono(file) {
  const arrayBuffer = await file.arrayBuffer();
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const decoded = await ctx.decodeAudioData(arrayBuffer);
  await ctx.close();
  const targetRate = 16000;
  const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * targetRate), targetRate);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start(0);
  const rendered = await offline.startRendering();
  return { samples: rendered.getChannelData(0), durationSec: decoded.duration };
}

function renderJob(jobId) {
  const job = jobs.get(jobId);
  job.el.querySelector(".job-status").textContent = `${job.status} — ${job.stage} (${Math.round((job.progress || 0) * 100)}%)`;
  if (job.status === "error") {
    job.el.querySelector(".job-error").textContent = job.error;
    // worker.js's fetchCachedBlobUrl throws "download failed (...): url"
    // when the ~250-300MB engine download itself fails (network drop,
    // quota) -- offer a visible retry rather than leaving the job dead,
    // per spec's error handling. Any other error is a processing failure
    // (bad file, decode error) that a retry can't fix.
    const retryEl = job.el.querySelector(".job-retry");
    if (job.error && job.error.startsWith("download failed")) {
      retryEl.hidden = false;
      retryEl.onclick = () => {
        job.status = "queued";
        job.stage = "queued";
        job.progress = 0;
        job.error = "";
        retryEl.hidden = true;
        queue.push(jobId);
        renderJob(jobId);
        runNext();
      };
    } else {
      retryEl.hidden = true;
    }
  }
  if (job.status === "done") {
    const exportsEl = job.el.querySelector(".job-exports");
    exportsEl.hidden = false;
    const baseName = job.name.replace(/\.[^.]+$/, "");
    exportsEl.querySelector(".export-csv").onclick = () => downloadCsv(job.rows, `${baseName}_transcript.csv`);
    exportsEl.querySelector(".export-json").onclick = () => downloadJson(job.name, job.durationSec, job.rows, `${baseName}_transcript.json`);
    exportsEl.querySelector(".export-srt").onclick = () => downloadSrt(job.rows, `${baseName}_transcript.srt`);
    exportsEl.querySelector(".export-docx").onclick = () => downloadDocx(baseName, job.rows, `${baseName}_transcript.docx`);
    const transcriptEl = job.el.querySelector(".job-transcript");
    transcriptEl.hidden = false;
    transcriptEl.textContent = toTurns(job.rows).map((r) => `${r.speaker_id}: ${r.transcribed_text}`).join("\n\n");
  }
}

function addJobToDom(name) {
  const li = document.createElement("li");
  li.className = "job";
  li.innerHTML = `
    <div class="job-name"></div>
    <div class="job-status"></div>
    <div class="job-error"></div>
    <button class="job-retry" hidden>Retry</button>
    <div class="job-exports" hidden>
      <button class="export-csv">CSV</button>
      <button class="export-json">JSON</button>
      <button class="export-srt">SRT</button>
      <button class="export-docx">DOCX</button>
    </div>
    <pre class="job-transcript" hidden></pre>
  `;
  li.querySelector(".job-name").textContent = name;
  jobList.appendChild(li);
  return li;
}

function waitForUserChoice(job) {
  return new Promise((resolve) => {
    const warn = document.createElement("div");
    warn.className = "job-warning";
    warn.innerHTML = `
      <p>Recordings over about an hour may be slow or run out of memory in this browser tab.</p>
      <button class="proceed">Process anyway</button>
      <button class="skip">Skip this file</button>
    `;
    job.el.appendChild(warn);
    warn.querySelector(".proceed").onclick = () => { warn.remove(); resolve(true); };
    warn.querySelector(".skip").onclick = () => { warn.remove(); resolve(false); };
  });
}

async function runNext() {
  if (running) return;
  const jobId = queue.shift();
  if (!jobId) return;
  running = true;
  const job = jobs.get(jobId);
  job.status = "processing";
  job.stage = "decoding audio";
  job.progress = 0.05;
  renderJob(jobId);
  try {
    const { samples, durationSec } = await decodeFileTo16kMono(job.file);
    job.durationSec = durationSec;
    if (durationSec > LONG_RECORDING_WARN_SEC) {
      const proceed = await waitForUserChoice(job);
      if (!proceed) {
        job.status = "error";
        job.stage = "skipped";
        job.error = "skipped (recording too long)";
        renderJob(jobId);
        running = false;
        runNext();
        return;
      }
    }
    const numSpeakers = parseInt(numSpeakersInput.value, 10) || 0;
    const language = languageInput.value.trim();
    worker.postMessage({ jobId, samples, durationSec, numSpeakers, language }, [samples.buffer]);
  } catch (err) {
    job.status = "error";
    job.stage = "failed";
    job.error = "could not decode this file: " + (err && err.message ? err.message : err);
    renderJob(jobId);
    running = false;
    runNext();
  }
}

worker.onmessage = (ev) => {
  const { jobId, ...patch } = ev.data;
  const job = jobs.get(jobId);
  if (!job) return;
  Object.assign(job, patch);
  renderJob(jobId);
  if (patch.status === "done" || patch.status === "error") {
    running = false;
    runNext();
  }
};

function queueFiles(fileList) {
  if (fileInput.disabled) return; // compat check failed -- see checkCompat()
  for (const file of Array.from(fileList)) {
    const jobId = newJobId();
    const el = addJobToDom(file.name);
    jobs.set(jobId, { name: file.name, file, status: "queued", stage: "queued", progress: 0, el });
    queue.push(jobId);
  }
  runNext();
}

fileInput.addEventListener("change", () => queueFiles(fileInput.files));
dropzone.addEventListener("dragover", (e) => e.preventDefault());
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  queueFiles(e.dataTransfer.files);
});

if (checkCompat()) {
  downloadBanner.hidden = false;
  downloadBanner.textContent = "First use downloads the transcription/diarization engines (~250-300MB) and caches them for next time.";
}
```

- [ ] **Step 5: Manual end-to-end smoke test**

Run a local server with COOP/COEP headers (any of the small `node:http` servers already written for `engine-build-pipeline`'s Task 3/4 test harnesses works as a template), open the page in Chrome, drop in `engines-build/fixtures/two-speaker.wav`, and confirm: the compat banner doesn't show an error, the download banner appears, the job progresses through its stages, and a two-speaker transcript with working CSV/JSON/SRT/DOCX export buttons appears. This is the point referenced by Task 5 Step 3 — fix `engines/sherpa.js` here if needed. Also check this plan's Global Constraints risk #3 (pthread workers spawned from a `blob:`-loaded glue script) here: open the browser's DevTools console while this runs and confirm no worker-spawn errors appear and the job actually reaches "done" rather than hanging at "diarizing speakers" or "transcribing" — if it hangs or errors there, follow that risk note's fallback (same-origin-host the two JS glue files).

- [ ] **Step 6: Commit**

```bash
git add index.html styles.css app.js coi-serviceworker.js
git commit -m "Add app shell: compatibility check, file queue, UI, exports"
```

---

### Task 7: Automated end-to-end check

**Files:**
- Create: `package.json` (repo root)
- Create: `test/e2e.spec.mjs`

**Interfaces:**
- Consumes: the whole app (Tasks 1-6), `engines-build/fixtures/two-speaker.wav` + `expected-words.json` (from the `engine-build-pipeline` plan).
- Produces: the automated check `deploy-pages.yml` (Task 8) gates on.

- [ ] **Step 1: Write the root package.json**

```json
{
  "name": "transcribr-web",
  "private": true,
  "devDependencies": {
    "playwright": "^1.48.0"
  }
}
```

- [ ] **Step 2: Write the end-to-end check**

```js
// test/e2e.spec.mjs
// Full end-to-end check: loads the real app against a local server (with
// the COOP/COEP headers GitHub Pages can't set, replicated here), feeds it
// a real fixture file through the actual file input, and asserts a real
// transcript with the expected speaker count comes back plus all four
// exports produce non-empty downloads -- the browser equivalent of the
// desktop app's --selftest. Nothing is mocked: engine downloads hit the
// real Hugging Face URLs in engines/manifest.json. A persistent browser
// profile is used so repeat CI runs reuse the ~250MB download via the
// browser's own Cache Storage instead of re-fetching it every time -- see
// .github/workflows/deploy-pages.yml's actions/cache step.
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const expected = JSON.parse(
  readFileSync(path.join(repoRoot, "engines-build", "fixtures", "expected-words.json"), "utf8")
);

const contentTypes = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".css": "text/css", ".wav": "audio/wav" };
const server = createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split("?")[0]);
  const filePath = path.normalize(path.join(repoRoot, urlPath === "/" ? "/index.html" : urlPath));
  if (!filePath.startsWith(repoRoot)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = readFileSync(filePath);
    res.writeHead(200, {
      "Content-Type": contentTypes[path.extname(filePath)] || "application/octet-stream",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
server.listen(8090);

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("server did not come up in time");
}

const profileDir = path.join(repoRoot, ".playwright-profile");
if (!existsSync(profileDir)) mkdirSync(profileDir, { recursive: true });

try {
  await waitForServer("http://localhost:8090/index.html", 15_000);

  const context = await chromium.launchPersistentContext(profileDir, { headless: true });
  const page = await context.newPage();
  page.on("console", (msg) => console.log("[page]", msg.text()));
  await page.goto("http://localhost:8090/index.html");

  await page.waitForFunction(() => self.crossOriginIsolated === true, { timeout: 15_000 });

  const fixturePath = path.join(repoRoot, "engines-build", "fixtures", "two-speaker.wav");
  const fileInput = await page.$("#file-input");
  await fileInput.setInputFiles(fixturePath);

  await page.waitForSelector(".job-transcript:not([hidden])", { timeout: 300_000 });
  const transcript = await page.textContent(".job-transcript");
  const speakerLines = new Set(transcript.split("\n\n").map((line) => line.split(":")[0]).filter(Boolean));
  assert.equal(
    speakerLines.size,
    expected.twoSpeaker.expectedSpeakerCount,
    `expected ${expected.twoSpeaker.expectedSpeakerCount} distinct speakers, got ${speakerLines.size}: ${transcript}`
  );

  for (const cls of [".export-csv", ".export-json", ".export-srt", ".export-docx"]) {
    const [download] = await Promise.all([page.waitForEvent("download"), page.click(cls)]);
    const stream = await download.createReadStream();
    let size = 0;
    await new Promise((resolve) => {
      stream.on("data", (chunk) => (size += chunk.length));
      stream.on("end", resolve);
    });
    assert.ok(size > 0, `${cls} produced an empty download`);
  }

  console.log("PASS: transcript has", speakerLines.size, "speakers, all four export formats produced non-empty files");
  await context.close();
} finally {
  server.close();
}
```

- [ ] **Step 3: Run it and verify**

Run: `npm install && npx playwright install chromium && node test/e2e.spec.mjs`
Expected: `[page] ...` console lines while the engines download and run, then `PASS: transcript has 2 speakers, all four export formats produced non-empty files`. First run downloads the real ~250-300MB engine bundle from the `engines-v1` release, so allow real time; the profile in `.playwright-profile/` makes subsequent runs fast.

- [ ] **Step 4: Commit**

```bash
git add package.json test/e2e.spec.mjs
echo ".playwright-profile/" >> .gitignore
echo "node_modules/" >> .gitignore
git add .gitignore
git commit -m "Add automated end-to-end check"
```

---

### Task 8: Deploy to GitHub Pages

**Files:**
- Create: `.github/workflows/deploy-pages.yml`
- Create: `README.md`

**Interfaces:**
- Consumes: everything from Tasks 1-7.
- Produces: a live GitHub Pages site, redeployed on every push to `main`/`master` that passes the Task 7 check.

- [ ] **Step 1: Write the workflow**

```yaml
# .github/workflows/deploy-pages.yml
name: Deploy to GitHub Pages

on:
  push:
    branches: [main, master]

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  test-and-deploy:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - uses: actions/checkout@v4

      - name: Hash engines manifest for cache key
        id: manifest
        run: echo "hash=${{ hashFiles('engines/manifest.json') }}" >> "$GITHUB_OUTPUT"

      - name: Restore cached browser profile (avoids re-downloading the ~250-300MB engines every run)
        uses: actions/cache@v4
        with:
          path: .playwright-profile
          key: playwright-profile-${{ steps.manifest.outputs.hash }}

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install test dependencies
        run: npm install

      - name: Install Chromium
        run: npx playwright install --with-deps chromium

      - name: Run end-to-end check
        run: node test/e2e.spec.mjs

      - name: Stage deploy files
        run: |
          mkdir -p _site
          cp index.html styles.css app.js worker.js shared.js merge.js coi-serviceworker.js NOTICE.md _site/
          cp -r engines export _site/

      - name: Upload Pages artifact
        uses: actions/upload-pages-artifact@v3
        with:
          path: _site

      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
```

- [ ] **Step 2: Write a short README**

```markdown
# transcribr-web

Local, in-browser audio/video transcription with basic speaker
diarization — no server, no install, works for anyone who can open a URL
in desktop Chrome or Edge. Runs entirely client-side (whisper.cpp +
sherpa-onnx compiled to WebAssembly); nothing you transcribe ever leaves
your machine.

Exports: CSV, JSON, SRT, DOCX — the CSV/JSON schema matches the companion
desktop app ("BMS Lab Transcribr"), so output from either is interchangeable
in the same analysis workflow.

See `docs/superpowers/specs/2026-08-13-transcribr-web-app-design.md` for
the full design, and `docs/superpowers/plans/` for how it was built.
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/deploy-pages.yml README.md
git commit -m "Add GitHub Pages deploy workflow gated on the end-to-end check"
```

- [ ] **Step 4: Enable Pages and verify the deploy**

In the GitHub repo's Settings → Pages, set Source to "GitHub Actions" (one-time, manual — confirm with the user before changing repo settings). Push to `main`/`master`, then:

```bash
gh run watch
```

Expected: the run goes green and prints a Pages URL in the deployment step's output. Open it in Chrome and repeat Task 6 Step 5's manual smoke test against the live URL to confirm GitHub Pages itself (not just the local dev server) serves everything correctly, including `coi-serviceworker.js` actually achieving cross-origin isolation on Pages' real response headers.
