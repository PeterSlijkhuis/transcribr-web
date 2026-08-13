# Engine Build Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A GitHub Actions workflow that builds whisper.cpp and sherpa-onnx to WebAssembly from source (via a pinned Emscripten SDK), verifies each build against a real audio fixture in a real browser, and publishes the result as assets on a GitHub Release — so the `transcribr-web` app (a separate plan) always has a tested, versioned, downloadable engine bundle to fetch at runtime, and updating the engine/model later is "push a tag, watch Actions run," not a manual local rebuild.

**Architecture:** Two vendored upstream C++ projects (whisper.cpp, sherpa-onnx), each built to WASM via their own official build scripts (not reinvented) on a pinned Emscripten SDK, each wrapped in a minimal hand-written HTML/JS test harness, each verified by a Playwright script that loads the harness in real Chromium and asserts output against a known fixture. This plan's code is adapted from an already-verified spike of the exact same build (`Wisprflow/web/engines/` in the sibling `Wisprflow` project, whose `API.md` documents the confirmed JS API both engines expose) — retargeted from "build once locally, keep output in a gitignored `dist/`" to "build in CI on every tagged run, publish the output to a GitHub Release."

**Tech Stack:** Emscripten SDK 4.0.23 (pinned), whisper.cpp (`ggml-org/whisper.cpp`, pinned commit `4523d0ce373ee4b2176b3251fff29fd4864fcf38`), sherpa-onnx (`k2-fsa/sherpa-onnx`, pinned commit `c29b1838c843f92c7ad58eb81e174ccb4c3508cf`), Playwright (Node, Chromium), GitHub Actions (`ubuntu-latest`), the `gh` CLI (preinstalled on GitHub-hosted runners) for publishing releases.

## Global Constraints

- Both engine builds use `-pthread`/`USE_PTHREADS=1` and therefore require `SharedArrayBuffer`, which requires the serving page to send `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` on every response, including the HTML itself. A plain static file server does not do this — verification harnesses use a small hand-rolled `node:http` server that sets these headers.
- Large, regenerable artifacts (vendored upstream source trees, the emsdk install, build output directories) are gitignored. Small deterministic fixtures (a few hundred KB of synthesized WAV) and all build/test scripts are committed.
- This plan only creates files under `engines-build/`, `.github/workflows/build-engines.yml`, and the repo-root `NOTICE.md`. It does not touch anything the sibling `transcribr-web-app` plan owns.
- The actual multi-GB Emscripten C++ compile is **not** run locally in this plan's steps — it is verified for real on GitHub Actions' Linux runner in Task 5. Attempting it locally on this Windows dev machine would hit the same class of environment-specific problems the original spike had to work around (no native `make`, a space in the repo's parent path breaking sherpa's unquoted `--preload-file` flag, Windows `MAX_PATH` limits on sherpa's deeply-nested checkout) for no lasting benefit, since production verification happens on the CI runner regardless. Tasks 3 and 4 write and commit the build/test scripts; Task 5 is where they are actually executed and verified.
- **Prerequisite before Task 5 can run for real:** a GitHub repository named `transcribr-web` under the user's account, with this local repo pushed to it as `origin`. Creating that remote repo and pushing are visible, account-level actions — confirm with the user before running `gh repo create` / `git push`, do not do it silently.

---

### Task 1: Repo bootstrap for the engine build tree

**Files:**
- Create: `engines-build/.gitignore`
- Create: `NOTICE.md`

**Interfaces:**
- Produces: the gitignore rules Tasks 2-5 rely on to keep vendored source/build output out of git; `NOTICE.md` at the repo root.

- [ ] **Step 1: Write the gitignore for the whole build tree**

```gitignore
# engines-build/.gitignore
emsdk/
whisper/src/
whisper/dist/
sherpa/src/
sherpa/build-wasm-simd-speaker-diarization/
sherpa/dist/
node_modules/
```

- [ ] **Step 2: Write the attribution notice**

```markdown
# Third-party attribution

This app distributes compiled WebAssembly builds of, and vendors build
scripts for, the following open-source projects:

- **whisper.cpp** — https://github.com/ggml-org/whisper.cpp — MIT License
- **sherpa-onnx** — https://github.com/k2-fsa/sherpa-onnx — Apache License 2.0
- **coi-serviceworker** — https://github.com/gzuidhof/coi-serviceworker — MIT License

The Whisper `base` speech model and the sherpa-onnx pyannote
segmentation-3.0 / NeMo TitaNet speaker-embedding models used by this app
are downloaded from their original publishers (Hugging Face / GitHub
Releases) at build time — see `engines-build/whisper/build.sh` and
`engines-build/sherpa/build.sh` for exact sources.
```

- [ ] **Step 3: Commit**

```bash
git add engines-build/.gitignore NOTICE.md
git commit -m "Bootstrap engine build tree: gitignore + attribution notice"
```

---

### Task 2: Test fixtures

**Files:**
- Create: `engines-build/fixtures/make-fixtures.ps1`
- Create: `engines-build/fixtures/expected-words.json`
- Test: running `make-fixtures.ps1` IS the test for this task — there's no separate assertion file, the fixtures either get produced correctly or the script throws.

**Interfaces:**
- Produces: `engines-build/fixtures/single-speaker.wav` (16kHz mono PCM16, one voice, ~15-20s), `engines-build/fixtures/two-speaker.wav` (16kHz mono PCM16, two voices, ~5-10s), `engines-build/fixtures/expected-words.json` shaped `{ singleSpeaker: { file: string, words: string[] }, twoSpeaker: { file: string, expectedSpeakerCount: number } }` — consumed by Tasks 3 and 4's test harnesses.
- These are synthesized via Windows SAPI text-to-speech from known text (not a real recording), so the exact spoken words are exactly known ground truth — no transcript-guessing needed, and no copyright/privacy concern from reusing a real lab recording.

- [ ] **Step 1: Write the fixture generator**

```powershell
# engines-build/fixtures/make-fixtures.ps1
# Synthesizes two small, license-free WAV fixtures via Windows SAPI
# text-to-speech: single-speaker.wav (one voice, known text) and
# two-speaker.wav (two voices, 1s silence gap). Both 16kHz/16-bit/mono.
# Run once locally; the output wavs are committed to git (a few hundred
# KB total), never regenerated in CI (SAPI is Windows-only).
Add-Type -AssemblyName System.Speech

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$voices = (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() |
    Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name }
if ($voices.Count -lt 2) {
    throw "Need at least 2 installed SAPI voices, found: $($voices -join ', ')"
}
$voiceA = $voices[0]
$voiceB = $voices[1]
Write-Host "voiceA=$voiceA voiceB=$voiceB"

function Speak-ToWav([string]$voice, [string]$text, [string]$path) {
    $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $synth.SelectVoice($voice)
    $synth.Rate = 0
    $fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
        16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
        [System.Speech.AudioFormat.AudioChannel]::Mono)
    $synth.SetOutputToWaveFile($path, $fmt)
    $synth.Speak($text)
    $synth.SetOutputToNull()
    $synth.Dispose()
}

# single-speaker.wav: one voice, four classic pangrams (distinctive,
# low-chance-of-coincidence substrings used as expected-words below).
$singleText = "The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquid jugs. How vexingly quick daft zebras jump. The five boxing wizards jump quickly."
Speak-ToWav $voiceA $singleText (Join-Path $dir "single-speaker.wav")
Write-Host "wrote $(Join-Path $dir 'single-speaker.wav')"

# two-speaker.wav: two distinct voices, 1s silence gap between them.
$aPath = Join-Path $dir "_a.wav"
$bPath = Join-Path $dir "_b.wav"
Speak-ToWav $voiceA "The quick brown fox jumps over the lazy dog." $aPath
Speak-ToWav $voiceB "Pack my box with five dozen liquid jugs." $bPath

Add-Type @"
using System;
using System.IO;

public static class WavConcat
{
    public static void Run(string outPath, string[] inputs, int silenceMs)
    {
        const int sampleRate = 16000;
        const int bytesPerSample = 2;
        int silenceBytes = (silenceMs * sampleRate / 1000) * bytesPerSample;

        using (var outStream = new FileStream(outPath, FileMode.Create))
        using (var writer = new BinaryWriter(outStream))
        {
            writer.Write(new byte[44]);

            long dataBytes = 0;
            for (int i = 0; i < inputs.Length; i++)
            {
                byte[] all = File.ReadAllBytes(inputs[i]);
                byte[] data = new byte[all.Length - 44];
                Array.Copy(all, 44, data, 0, data.Length);
                writer.Write(data);
                dataBytes += data.Length;

                if (i < inputs.Length - 1)
                {
                    writer.Write(new byte[silenceBytes]);
                    dataBytes += silenceBytes;
                }
            }

            outStream.Seek(0, SeekOrigin.Begin);
            writer.Write(System.Text.Encoding.ASCII.GetBytes("RIFF"));
            writer.Write((int)(36 + dataBytes));
            writer.Write(System.Text.Encoding.ASCII.GetBytes("WAVE"));
            writer.Write(System.Text.Encoding.ASCII.GetBytes("fmt "));
            writer.Write(16);
            writer.Write((short)1);
            writer.Write((short)1);
            writer.Write(sampleRate);
            writer.Write(sampleRate * bytesPerSample);
            writer.Write((short)bytesPerSample);
            writer.Write((short)16);
            writer.Write(System.Text.Encoding.ASCII.GetBytes("data"));
            writer.Write((int)dataBytes);
        }
    }
}
"@

$outPath = Join-Path $dir "two-speaker.wav"
[WavConcat]::Run($outPath, @($aPath, $bPath), 1000)
Remove-Item $aPath, $bPath
Write-Host "wrote $outPath"
```

- [ ] **Step 2: Write the expected-words manifest**

```json
{
  "singleSpeaker": {
    "file": "single-speaker.wav",
    "words": ["brown fox", "liquid jugs", "vexingly", "boxing wizards"]
  },
  "twoSpeaker": {
    "file": "two-speaker.wav",
    "expectedSpeakerCount": 2
  }
}
```

- [ ] **Step 3: Run it and verify**

Run (PowerShell): `engines-build/fixtures/make-fixtures.ps1`
Expected: prints `voiceA=... voiceB=...`, then `wrote .../single-speaker.wav`, then `wrote .../two-speaker.wav`. Both files exist and are each under ~1MB. If it throws "Need at least 2 installed SAPI voices", this machine needs a second TTS voice installed (Windows Settings → Time & Language → Speech) before retrying.

- [ ] **Step 4: Commit**

```bash
git add engines-build/fixtures/make-fixtures.ps1 engines-build/fixtures/expected-words.json engines-build/fixtures/single-speaker.wav engines-build/fixtures/two-speaker.wav
git commit -m "Add synthesized WASM engine test fixtures"
```

---

### Task 3: whisper.wasm build script and test harness

**Files:**
- Create: `engines-build/whisper/build.sh`
- Create: `engines-build/whisper/test.html`
- Create: `engines-build/whisper/package.json`
- Create: `engines-build/whisper/test.spec.mjs`

**Interfaces:**
- Consumes: `engines-build/fixtures/single-speaker.wav` + `expected-words.json` (Task 2), a pinned emsdk 4.0.23 at `engines-build/emsdk/` (installed in Task 5's CI job — this task doesn't install it).
- Produces (when `build.sh` is run against an activated emsdk): `engines-build/whisper/dist/libmain.js`, `engines-build/whisper/dist/libmain.wasm` — consumed by Task 5's packaging step.

- [ ] **Step 1: Write the build script**

```bash
#!/usr/bin/env bash
# engines-build/whisper/build.sh
# Builds whisper.cpp's official wasm example from source, pinned to the
# commit this pipeline's harness was verified against (bumping it means
# re-verifying test.spec.mjs still passes). Vendored source and build
# output are gitignored — regenerate via this script.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d src ]; then
  git clone https://github.com/ggml-org/whisper.cpp src
  git -C src checkout 4523d0ce373ee4b2176b3251fff29fd4864fcf38
fi

source ../emsdk/emsdk_env.sh

cd src
mkdir -p build-em
cd build-em
emcmake cmake -DWHISPER_WASM_SINGLE_FILE=OFF ..
emmake make -j"$(nproc)"

mkdir -p ../../dist
cp bin/libmain.js bin/libmain.wasm ../../dist/
echo "built to engines-build/whisper/dist/"
```

- [ ] **Step 2: Write the test harness page**

```html
<!doctype html>
<title>whisper.wasm engine build check</title>
<script>
  var Module = {
    print: function (text) { log(text); },
    printErr: function (text) { log("ERR: " + text); },
    onRuntimeInitialized: function () {
      document.getElementById("run").disabled = false;
      log("runtime ready");
    },
  };
  function log(msg) {
    document.getElementById("log").textContent += msg + "\n";
    console.log(msg);
  }

  var instance = null;
  const kSampleRate = 16000;

  async function loadModel() {
    const res = await fetch("./dist/models/ggml-base.bin");
    const buf = new Uint8Array(await res.arrayBuffer());
    try { Module.FS_unlink("whisper.bin"); } catch (e) {}
    Module.FS_createDataFile("/", "whisper.bin", buf, true, true);
    instance = Module.init("whisper.bin");
    log("init returned instance=" + instance);
  }

  async function decodeFixture(url) {
    const res = await fetch(url);
    const arr = await res.arrayBuffer();
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const decoded = await ctx.decodeAudioData(arr);
    const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * kSampleRate), kSampleRate);
    const src = offline.createBufferSource();
    src.buffer = decoded;
    src.connect(offline.destination);
    src.start(0);
    const rendered = await offline.startRendering();
    return rendered.getChannelData(0);
  }

  // Named runTest, not run: libmain.js (Emscripten, non-modularized) declares
  // its own global `function run()` for its runtime bootstrap, which would
  // otherwise collide with and shadow this one.
  async function runTest() {
    document.getElementById("run").disabled = true;
    await loadModel();
    const audio = await decodeFixture("../fixtures/single-speaker.wav");
    const ret = Module.full_default(instance, audio, "en", 4, false);
    log("full_default returned " + ret);
  }
</script>
<script src="./dist/libmain.js"></script>
<pre id="log"></pre>
<button id="run" onclick="runTest()" disabled>Run</button>
```

- [ ] **Step 3: Add Playwright, isolated to this check**

```json
{
  "name": "transcribr-web-engine-check-whisper",
  "private": true,
  "type": "module",
  "devDependencies": {
    "playwright": "^1.48.0"
  }
}
```

- [ ] **Step 4: Write the automated check**

```js
// engines-build/whisper/test.spec.mjs
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..", "..");
const expected = JSON.parse(
  readFileSync(path.join(__dirname, "..", "fixtures", "expected-words.json"), "utf8")
).singleSpeaker.words;

// A plain static server isn't enough: libmain.js is built with
// USE_PTHREADS=1, which needs SharedArrayBuffer, which Chrome only grants
// in a cross-origin-isolated context (COOP/COEP headers). Hand-rolled
// node:http server instead of adding a static-server dependency.
const webRoot = path.join(repoRoot, "engines-build", "whisper");
const enginesRoot = path.join(repoRoot, "engines-build");
const contentTypes = { ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm", ".wav": "audio/wav", ".json": "application/json", ".bin": "application/octet-stream" };
const server = createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split("?")[0]);
  const root = urlPath.startsWith("/fixtures/") ? enginesRoot : webRoot;
  const filePath = path.normalize(path.join(root, urlPath));
  if (!filePath.startsWith(enginesRoot)) {
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
server.listen(8081);

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

try {
  await waitForServer("http://localhost:8081/test.html", 15_000);

  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("console", (msg) => console.log("[page]", msg.text()));
  await page.goto("http://localhost:8081/test.html");
  await page.click("#run");
  await page.waitForFunction(
    (words) => {
      const text = document.getElementById("log").textContent.toLowerCase();
      return text.includes("full_default returned") && words.every((w) => text.includes(w.toLowerCase()));
    },
    expected,
    { timeout: 120_000 }
  );
  const log = await page.textContent("#log");
  for (const word of expected) {
    assert.ok(log.toLowerCase().includes(word.toLowerCase()), `missing expected word: ${word}`);
  }
  console.log("PASS: all expected words found");
  await browser.close();
} finally {
  server.close();
}
```

- [ ] **Step 5: Commit**

```bash
git add engines-build/whisper/build.sh engines-build/whisper/test.html engines-build/whisper/package.json engines-build/whisper/test.spec.mjs
git commit -m "Add whisper.wasm build script and test harness"
```

(No local run here — see Global Constraints. This is exercised for real in Task 5.)

---

### Task 4: sherpa-onnx wasm diarization build script and test harness

**Files:**
- Create: `engines-build/sherpa/build.sh`
- Create: `engines-build/sherpa/test.html`
- Create: `engines-build/sherpa/package.json`
- Create: `engines-build/sherpa/test.spec.mjs`

**Interfaces:**
- Consumes: `engines-build/fixtures/two-speaker.wav` + `expected-words.json` (Task 2), a pinned emsdk 4.0.23 at `engines-build/emsdk/`.
- Produces (when `build.sh` is run): `engines-build/sherpa/dist/` containing the Emscripten glue JS, wasm binary, and a `.data` file with the segmentation/embedding models baked in via `--preload-file` — consumed by Task 5's packaging step.

- [ ] **Step 1: Write the build script**

```bash
#!/usr/bin/env bash
# engines-build/sherpa/build.sh
# Builds sherpa-onnx's official wasm speaker-diarization example from
# source, using their documented build script rather than reinventing the
# CMake invocation. Pinned to the commit this pipeline's harness was
# verified against. Vendored source and build output are gitignored.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d src ]; then
  git clone -c core.longpaths=true https://github.com/k2-fsa/sherpa-onnx src
  git -C src checkout c29b1838c843f92c7ad58eb81e174ccb4c3508cf
fi

source ../emsdk/emsdk_env.sh

# The wasm speaker-diarization build bakes its onnx models into the wasm
# binary's .data file via Emscripten --preload-file at *build* time (there
# is no runtime fetch-and-mount step) -- its CMakeLists.txt hard-fails at
# configure time unless these two files already exist here first.
ASSETS_DIR=src/wasm/speaker-diarization/assets
mkdir -p "$ASSETS_DIR"
if [ ! -f "$ASSETS_DIR/segmentation.onnx" ]; then
  curl -L -o /tmp/segmentation.tar.bz2 https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2
  tar -xjf /tmp/segmentation.tar.bz2 -C /tmp
  find /tmp -iname 'model.onnx' -path '*segmentation*' -exec cp {} "$ASSETS_DIR/segmentation.onnx" \;
  rm -f /tmp/segmentation.tar.bz2
fi
if [ ! -f "$ASSETS_DIR/embedding.onnx" ]; then
  curl -L -o "$ASSETS_DIR/embedding.onnx" https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/nemo_en_titanet_large.onnx
fi
if [ ! -f "$ASSETS_DIR/segmentation.onnx" ]; then
  echo "error: segmentation.onnx missing after extracting the archive -- inspect /tmp for the real internal path and adjust the 'find' command above" >&2
  exit 1
fi

cd src
./build-wasm-simd-speaker-diarization.sh

mkdir -p ../dist
cp -r build-wasm-simd-speaker-diarization/install/bin/wasm/speaker-diarization/* ../dist/
echo "built to engines-build/sherpa/dist/"
```

- [ ] **Step 2: Write the test harness page**

```html
<!doctype html>
<title>sherpa-onnx wasm diarization engine build check</title>
<script>
  var Module = {
    print: function (text) { log(text); },
    printErr: function (text) { log("ERR: " + text); },
    onRuntimeInitialized: function () {
      document.getElementById("run").disabled = false;
      log("runtime ready");
    },
  };
  function log(msg) {
    document.getElementById("log").textContent += msg + "\n";
    console.log(msg);
  }

  async function decodeFixture(url, targetRate) {
    const res = await fetch(url);
    const arr = await res.arrayBuffer();
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const decoded = await ctx.decodeAudioData(arr);
    const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * targetRate), targetRate);
    const src = offline.createBufferSource();
    src.buffer = decoded;
    src.connect(offline.destination);
    src.start(0);
    const rendered = await offline.startRendering();
    return rendered.getChannelData(0);
  }

  // Named runTest, not run: sherpa-onnx-wasm-main-speaker-diarization.js
  // (Emscripten, non-modularized) declares its own global `function run()`
  // for its runtime bootstrap, which would otherwise collide with this one.
  async function runTest() {
    document.getElementById("run").disabled = true;
    const config = {
      segmentation: { pyannote: { model: "./segmentation.onnx" }, debug: 1 },
      embedding: { model: "./embedding.onnx", debug: 1 },
      clustering: { numClusters: 2, threshold: 0.5 },
      minDurationOn: 0.3,
      minDurationOff: 0.5,
    };
    const sd = createOfflineSpeakerDiarization(Module, config);
    log("sampleRate=" + sd.sampleRate);
    const audio = await decodeFixture("../fixtures/two-speaker.wav", sd.sampleRate);
    const result = sd.process(audio);
    log("RESULT_JSON=" + JSON.stringify(result));
  }
</script>
<script src="./sherpa-onnx-speaker-diarization.js"></script>
<script src="./sherpa-onnx-wasm-main-speaker-diarization.js"></script>
<pre id="log"></pre>
<button id="run" onclick="runTest()" disabled>Run</button>
```

- [ ] **Step 3: Add Playwright, isolated to this check**

```json
{
  "name": "transcribr-web-engine-check-sherpa",
  "private": true,
  "type": "module",
  "devDependencies": {
    "playwright": "^1.48.0"
  }
}
```

- [ ] **Step 4: Write the automated check**

```js
// engines-build/sherpa/test.spec.mjs
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..", "..");
const expected = JSON.parse(
  readFileSync(path.join(__dirname, "..", "fixtures", "expected-words.json"), "utf8")
).twoSpeaker;

const webRoot = path.join(repoRoot, "engines-build", "sherpa");
const distRoot = path.join(webRoot, "dist");
const enginesRoot = path.join(repoRoot, "engines-build");
const contentTypes = { ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm", ".wav": "audio/wav", ".json": "application/json", ".data": "application/octet-stream", ".onnx": "application/octet-stream" };
const server = createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split("?")[0]);
  let root = webRoot;
  if (urlPath.startsWith("/fixtures/")) {
    root = enginesRoot;
  } else if (urlPath !== "/test.html") {
    root = distRoot;
  }
  const filePath = path.normalize(path.join(root, urlPath));
  if (!filePath.startsWith(enginesRoot)) {
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
server.listen(8082);

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

try {
  await waitForServer("http://localhost:8082/test.html", 15_000);

  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("console", (msg) => console.log("[page]", msg.text()));
  await page.goto("http://localhost:8082/test.html");
  await page.click("#run");
  await page.waitForFunction(
    () => document.getElementById("log").textContent.includes("RESULT_JSON="),
    { timeout: 120_000 }
  );
  const log = await page.textContent("#log");
  const match = log.match(/RESULT_JSON=(\[.*\])/);
  assert.ok(match, "no RESULT_JSON found in log");
  const segments = JSON.parse(match[1]);
  const speakers = new Set(segments.map((s) => s.speaker));
  assert.equal(
    speakers.size,
    expected.expectedSpeakerCount,
    `expected ${expected.expectedSpeakerCount} distinct speakers, got ${speakers.size}: ${JSON.stringify(segments)}`
  );
  console.log("PASS: got", segments.length, "segments across", speakers.size, "speakers");
  await browser.close();
} finally {
  server.close();
}
```

- [ ] **Step 5: Commit**

```bash
git add engines-build/sherpa/build.sh engines-build/sherpa/test.html engines-build/sherpa/package.json engines-build/sherpa/test.spec.mjs
git commit -m "Add sherpa-onnx wasm diarization build script and test harness"
```

(No local run here — see Global Constraints. This is exercised for real in Task 5.)

---

### Task 5: CI workflow — build, verify, and publish to a GitHub Release

**Files:**
- Create: `.github/workflows/build-engines.yml`

**Interfaces:**
- Consumes: everything from Tasks 1-4.
- Produces: a GitHub Release (tag `engines-v1` for the first run) with these assets uploaded: `whisper-libmain.js`, `whisper-libmain.wasm`, `whisper-ggml-base.bin`, plus sherpa's compiled `.js`/`.wasm`/`.data` output copied under their built-in filenames. **The exact sherpa filenames are only known once this workflow actually runs** — record them (Step 4 below) for the `transcribr-web-app` plan's `engines/manifest.json` to reference.

- [ ] **Step 1: Write the workflow**

```yaml
# .github/workflows/build-engines.yml
name: Build engines

on:
  push:
    tags:
      - 'engines-v*'
  workflow_dispatch:
    inputs:
      tag:
        description: 'Release tag to publish to (e.g. engines-v1)'
        required: true
        default: 'engines-v1'

permissions:
  contents: write

jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 180
    steps:
      - uses: actions/checkout@v4

      - name: Determine release tag
        id: tag
        run: |
          if [ "${{ github.event_name }}" = "workflow_dispatch" ]; then
            echo "tag=${{ github.event.inputs.tag }}" >> "$GITHUB_OUTPUT"
          else
            echo "tag=${GITHUB_REF_NAME}" >> "$GITHUB_OUTPUT"
          fi

      - name: Install emsdk 4.0.23
        run: |
          git clone https://github.com/emscripten-core/emsdk.git engines-build/emsdk
          cd engines-build/emsdk
          ./emsdk install 4.0.23
          ./emsdk activate 4.0.23

      - name: Build whisper.wasm
        run: bash engines-build/whisper/build.sh

      - name: Fetch whisper base model (for the test harness and the release)
        run: |
          mkdir -p engines-build/whisper/dist/models
          curl -L -o engines-build/whisper/dist/models/ggml-base.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin

      - name: Test whisper.wasm
        run: |
          cd engines-build/whisper && npm install && npx playwright install --with-deps chromium && cd ../..
          node engines-build/whisper/test.spec.mjs

      - name: Build sherpa-onnx wasm diarization
        run: bash engines-build/sherpa/build.sh

      - name: Test sherpa-onnx wasm
        run: |
          cd engines-build/sherpa && npm install && npx playwright install --with-deps chromium && cd ../..
          node engines-build/sherpa/test.spec.mjs

      - name: Package release assets
        run: |
          mkdir -p release-assets
          cp engines-build/whisper/dist/libmain.js release-assets/whisper-libmain.js
          cp engines-build/whisper/dist/libmain.wasm release-assets/whisper-libmain.wasm
          cp engines-build/whisper/dist/models/ggml-base.bin release-assets/whisper-ggml-base.bin
          cp engines-build/sherpa/dist/*.js release-assets/
          cp engines-build/sherpa/dist/*.wasm release-assets/
          cp engines-build/sherpa/dist/*.data release-assets/
          ls -la release-assets

      - name: Create or update the release with these assets
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          TAG="${{ steps.tag.outputs.tag }}"
          gh release create "$TAG" release-assets/* --title "$TAG" --generate-notes || \
          gh release upload "$TAG" release-assets/* --clobber
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/build-engines.yml
git commit -m "Add CI workflow to build, verify, and publish the WASM engines"
```

- [ ] **Step 3: Confirm the remote repo with the user, then push**

Per Global Constraints, creating the remote GitHub repo and pushing are visible account-level actions — confirm with the user first. Once confirmed:

```bash
gh repo create transcribr-web --public --source=. --remote=origin
git push -u origin master
```

- [ ] **Step 4: Trigger the workflow for real and verify**

```bash
git tag engines-v1
git push origin engines-v1
gh run watch
```

Expected: the run completes with a green checkmark (this includes two full C++-to-WASM compiles plus two real Playwright checks in a real browser, so allow real time — check progress with `gh run watch` rather than assuming a fixed duration). If either `test.spec.mjs` step fails, the job log shows exactly which assertion failed (missing expected word, or wrong speaker count) — that means the build itself is fine but something about the fixture/config needs adjusting, not that the pipeline is broken.

Once green:

```bash
gh release view engines-v1 --json assets --jq '.assets[].name'
```

Expected: lists `whisper-libmain.js`, `whisper-libmain.wasm`, `whisper-ggml-base.bin`, and sherpa's `.js`/`.wasm`/`.data` files under their real built-in names. **Record this exact list and their download URLs** (`gh release view engines-v1 --json assets --jq '.assets[].url'`) — the `transcribr-web-app` plan's Task 1 (`engines/manifest.json`) needs them verbatim.
