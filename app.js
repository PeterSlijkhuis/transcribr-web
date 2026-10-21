// app.js -- main thread: compatibility check, audio decode, file queue,
// engine coordination, the transcript editor and its downloads.
//
// Each engine runs in its own worker (engines/whisper-worker.js,
// engines/sherpa-worker.js). Jobs run one at a time: decode here, then
// diarize in the sherpa worker while transcribing in the whisper worker,
// merge here.
import { assignSpeakers } from "./merge.js";
import { speakerCount, fmtClock, renameSpeakers, timeLeft, estimate } from "./shared.js";
import { downloadCsv } from "./export/csv.js";
import { downloadJson } from "./export/json.js";
import { downloadSrt } from "./export/srt.js";
import { downloadDocx } from "./export/docx.js";
import { mountFlappyGame } from "./flappy.js";

const SAMPLE_RATE = 16000; // both engines take 16kHz mono
const LONG_RECORDING_WARN_SEC = 60 * 60; // soft warning threshold, see spec
// whisper.cpp's language codes (g_lang in its src/whisper.cpp). Any other
// code makes it log "unknown language" and return no text at all, so the
// language is picked from this list rather than typed.
const LANGUAGES = (
  "en zh de es ru ko fr ja pt tr pl ca nl ar sv it id hi fi vi he uk el ms cs ro da hu ta no th ur hr bg lt la mi ml cy sk te fa lv bn sr az sl kn et mk br eu is hy ne mn bs kk sq sw gl mr pa si km sn yo so af oc ka be tg sd gu am yi lo uz fo ht ps tk nn mt sa lb my bo tl mg as tt haw ln ha ba jw su yue"
).split(" ");

const compatBanner = document.getElementById("compat-banner");
const engineBanner = document.getElementById("engine-banner");
const engineStatus = document.getElementById("engine-status");
const engineProgress = document.getElementById("engine-progress");
const fileInput = document.getElementById("file-input");
const dropzone = document.getElementById("dropzone");
const jobList = document.getElementById("job-list");
const numSpeakersInput = document.getElementById("num-speakers");
const languageInput = document.getElementById("language");
const modelSelect = document.getElementById("model");
const modelHint = document.getElementById("model-hint");
const engineSelect = document.getElementById("engine");
const engineHint = document.getElementById("engine-hint");
const gpuPrefSelect = document.getElementById("gpu-pref");
const gpuPrefHint = document.getElementById("gpu-pref-hint");
const translateInput = document.getElementById("translate");

// Language names in the visitor's own language, sorted; the code is the
// fallback where the browser has no name for it. whisper.cpp says "jw" for
// Javanese, whose standard code is "jv".
{
  let names = null;
  try { names = new Intl.DisplayNames([navigator.language, "en"], { type: "language" }); } catch (e) {}
  const nameOf = (code) => {
    try { return (names && names.of(code === "jw" ? "jv" : code)) || code; } catch (e) { return code; }
  };
  LANGUAGES.map((code) => [code, nameOf(code)])
    .sort((a, b) => a[1].localeCompare(b[1]))
    .forEach(([code, name]) => languageInput.add(new Option(name, code)));
}

// ---- Compatibility -------------------------------------------------------

// Smallest module using a SIMD instruction (from wasm-feature-detect); both
// engines are SIMD builds.
const SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);

function disablePicker(text) {
  fileInput.disabled = true;
  dropzone.textContent = text;
  dropzone.style.opacity = "0.5";
}

function showCompatError(text) {
  compatBanner.hidden = false;
  compatBanner.textContent = text;
}

/// Returns true when the engines can run here.
function checkCompat() {
  let simd = false;
  try {
    simd = WebAssembly.validate(SIMD_PROBE);
  } catch (e) {}
  if (!simd) {
    showCompatError("This browser can't run Transcribr (no WebAssembly SIMD). Use a current desktop Chrome, Edge, Firefox or Safari.");
    disablePicker("Unsupported browser, see the message above.");
    return false;
  }
  if (!self.crossOriginIsolated || typeof SharedArrayBuffer === "undefined") {
    // coi-serviceworker.js reloads the page once to become isolated; only
    // report a failure if that hasn't happened after a few seconds.
    disablePicker("Setting up, the page may reload once...");
    setTimeout(() => {
      showCompatError(
        "This browser can't run Transcribr (no cross-origin isolation / SharedArrayBuffer). " +
          "Use a current desktop Chrome, Edge, Firefox or Safari, and make sure the page isn't opened from a file:// path."
      );
      disablePicker("Unsupported browser, see the message above.");
    }, 5000);
    return false;
  }
  return true;
}

// ---- Engines -------------------------------------------------------------

class Engine {
  constructor(script, name, type = "classic") {
    this.script = script;
    this.name = name;
    this.type = type;
    this.worker = null;
    this.loading = null;
    this.pending = null;
  }

  spawn() {
    this.worker = new Worker(this.script, { name: this.name, type: this.type });
    this.worker.onmessage = (ev) => this.onMessage(ev.data);
    this.worker.onerror = (ev) => {
      ev.preventDefault();
      this.crash(new Error(`${this.name} crashed: ${ev.message || "unknown error"}`));
    };
  }

  // A crashed or failed-to-load worker is thrown away; the next job gets a
  // fresh one (and the Cache API makes the reload cheap).
  crash(err) {
    if (this.worker) this.worker.terminate();
    this.worker = null;
    this.loading = null;
    const p = this.pending;
    this.pending = null;
    if (p) p.reject(err);
  }

  onMessage(msg) {
    const p = this.pending;
    if (!p) return;
    if (msg.type === "error" && msg.fatal) {
      // The engine's runtime aborted; only a fresh worker can recover.
      this.crash(new Error(msg.error));
    } else if (msg.type === "progress") {
      if (p.onProgress) p.onProgress(msg);
    } else if (msg.type === "error") {
      this.pending = null;
      p.reject(new Error(msg.error));
    } else {
      this.pending = null;
      p.resolve(msg);
    }
  }

  request(msg, transfer, onProgress) {
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject, onProgress };
      this.worker.postMessage(msg, transfer || []);
    });
  }

  load(manifest, onProgress, extra = {}) {
    if (!this.loading) {
      this.spawn();
      this.loading = this.request({ type: "load", manifest, version: manifest.version, ...extra }, [], onProgress).catch((err) => {
        this.crash(err);
        throw err;
      });
    }
    return this.loading;
  }
}

const whisper = new Engine("engines/whisper-worker.js", "whisper engine");
const sherpa = new Engine("engines/sherpa-worker.js", "diarization engine");
const gpu = new Engine("engines/gpu-worker.js", "GPU engine", "module");
let manifest = null;

// Cache names used by engines/fetch-cached.js, one per manifest version.
const ENGINE_CACHE_PREFIX = "transcribr-web-engines-";

async function pruneOldEngineCaches(version) {
  try {
    for (const name of await caches.keys()) {
      if (name.startsWith(ENGINE_CACHE_PREFIX) && name !== ENGINE_CACHE_PREFIX + version) await caches.delete(name);
    }
  } catch (e) {}
}

// The engine and GPU model downloads (Transformers.js keeps its own cache).
// The site shares its origin with other github.io pages of the same
// account, so only these caches are counted or deleted, never all of them.
function isOurCache(name) {
  return name.startsWith(ENGINE_CACHE_PREFIX) || name === "transformers-cache";
}

async function cachedBytes() {
  let total = 0;
  for (const name of (await caches.keys()).filter(isOurCache)) {
    const cache = await caches.open(name);
    for (const req of await cache.keys()) {
      const res = await cache.match(req);
      total += Number(res.headers.get("content-length")) || (await res.blob()).size;
    }
  }
  return total;
}

function mb(bytes) {
  return Math.round(bytes / 1e6);
}

function showEngineProgress({ label, loaded, total }) {
  engineBanner.hidden = false;
  engineStatus.textContent = total
    ? `Downloading ${label}: ${mb(loaded)} of ${mb(total)} MB (cached after the first time)`
    : `Downloading ${label}: ${mb(loaded)} MB (cached after the first time)`;
  engineProgress.hidden = !total;
  if (total) engineProgress.value = loaded / total;
}

async function loadManifest() {
  if (!manifest) {
    // Same wording as engines/fetch-cached.js, so the job offers Retry.
    const res = await fetch("engines/manifest.json").catch(() => {
      throw new Error("download failed (network error): engines/manifest.json");
    });
    if (!res.ok) throw new Error(`download failed (HTTP ${res.status}): engines/manifest.json`);
    manifest = await res.json();
    pruneOldEngineCaches(manifest.version);
  }
  return manifest;
}

// ---- Picking the fastest setup for this device ----------------------------

// What this device offers, detected once. A software ("fallback") WebGPU
// adapter is no faster than the CPU, so it doesn't count as a GPU.
const hardware = {
  cores: navigator.hardwareConcurrency || 4,
  memoryGb: navigator.deviceMemory, // Chrome/Edge only, capped at 8
  gpu: false,
};
// With a built-in and a dedicated card, the browser picks one by this
// preference; pages can't list cards or choose one by name.
function gpuPref() {
  return savedSetting("gpuPref") === "low-power" ? "low-power" : "high-performance";
}

async function detectGpu() {
  try {
    // Some systems answer a power preference with no adapter at all while a
    // plain request still gets one, so ask again without it.
    const a = navigator.gpu && ((await navigator.gpu.requestAdapter({ powerPreference: gpuPref() })) || (await navigator.gpu.requestAdapter()));
    hardware.gpu = Boolean(a) && !(a.isFallbackAdapter || (a.info && a.info.isFallbackAdapter));
    const info = (a && a.info) || {};
    hardware.gpuName = info.description || [info.vendor, info.architecture].filter(Boolean).join(" ");
  } catch (e) {}
}
const hardwareReady = detectGpu();
// How long the GPU worker may stay silent while downloading or preparing a
// model before it's treated as hung. ponytail: fixed guess; first-run shader
// compiles on slow GPUs could exceed it, tune if real users trip it.
const GPU_QUIET_LIMIT_MS = 180000;
// Set when the GPU engine fails on this device; Automatic then sticks to
// the CPU for the rest of the visit.
let gpuFailed = false;

function gpuAvailable() {
  return hardware.gpu && !gpuFailed;
}

// "auto" picks Standard where it runs at least about real time (a GPU, or
// 4+ cores with 4+ GB), else Fast. It never picks Accurate: on the CPU it's
// slower than the recording, and it has no GPU version.
function selectedModel(choice = modelSelect.value) {
  const models = manifest.whisper.models;
  if (choice !== "auto") return models.find((m) => m.id === choice) || models.find((m) => m.default);
  const strong = gpuAvailable() || (hardware.cores >= 4 && (hardware.memoryGb || 8) >= 4);
  return models.find((m) => m.id === (strong ? "small" : "tiny"));
}

// The GPU engine only covers tiers with an ONNX export (manifest `onnx`);
// anything else stays on whisper.cpp.
function useGpu(model, translate = translateInput.checked) {
  // large-v3-turbo was trained without translation data, so a tier marked
  // onnxNoTranslate goes to the CPU model when Translate is on.
  return engineSelect.value !== "cpu" && gpuAvailable() && Boolean(model.onnx) && !(translate && model.onnxNoTranslate);
}

function asrEngine(job) {
  const opts = job ? job.opts : {};
  return useGpu(selectedModel(opts.model), opts.translate) ? gpu : whisper;
}

// Seconds of audio handled per second, for the estimate shown before a file
// starts. ponytail: starting guesses from one tested laptop and the CI runs;
// each finished file replaces them with what this device actually did.
const DEFAULT_SPEED = { "tiny:cpu": 4, "tiny:gpu": 10, "small:cpu": 1, "small:gpu": 5, "medium:cpu": 0.7, "medium:gpu": 3, diar: 2 };

function speed(key) {
  return Number(savedSetting(`speed:${key}`)) || DEFAULT_SPEED[key];
}

function saveSpeed(key, audioSec, workSec) {
  if (workSec < 1) return;
  try { localStorage.setItem(`speed:${key}`, (audioSec / workSec).toFixed(2)); } catch (e) {}
}

function updateEstimate(li) {
  if (!manifest || !li.durationSec) return;
  const model = selectedModel(li.querySelector(".staged-model").value);
  const onGpu = useGpu(model, li.querySelector(".staged-translate").checked);
  li.querySelector(".staged-estimate").textContent =
    `Takes ${estimate(li.durationSec, speed(`${model.id}:${onGpu ? "gpu" : "cpu"}`), speed("diar"))} with ${model.label.split(" (")[0]} on the ${onGpu ? "graphics card" : "processor"}`;
}

function describeHardware() {
  const parts = [`${hardware.cores} CPU cores`];
  if (hardware.memoryGb) parts.push(`${hardware.memoryGb}${hardware.memoryGb >= 8 ? "+" : ""} GB memory`);
  parts.push(hardware.gpu ? "a WebGPU graphics card" : "no usable GPU in this browser");
  return parts.join(", ");
}

function updateModelHint() {
  if (!manifest) return;
  const model = selectedModel();
  const where = useGpu(model) ? "the graphics card" : "the processor";
  modelHint.textContent =
    modelSelect.value === "auto"
      ? `Using ${model.label.split(" (")[0]} on ${where}, picked for this device (${describeHardware()}).`
      : useGpu(model)
        ? `Runs on the graphics card (${model.onnx.split("/")[1]}).`
        : `Runs on the processor. Recommended hardware: ${model.hardware}`;
  gpuPrefHint.textContent = hardware.gpu
    ? `In use: ${hardware.gpuName || "a graphics card the browser doesn't name"}. If that's the wrong one, set your browser to "High performance" in Windows Settings > System > Display > Graphics.`
    : "No usable graphics card in this browser.";
  engineHint.textContent = !hardware.gpu
    ? "This browser has no usable GPU (WebGPU), so everything runs on the processor. A recent Chrome or Edge may have one. If it worked before, restart the browser: after a graphics card problem, Chrome switches it off for a site until then."
    : selectedModel().onnx
      ? "The graphics card was about 3x faster on a tested laptop. Its first run downloads a separate copy of the model."
      : "This model has no GPU version, so it runs on the processor.";
  for (const li of document.querySelectorAll(".staged")) updateEstimate(li);
}

// The model choice is remembered per browser, like the theme.
function savedModel() {
  try { return localStorage.getItem("model"); } catch (e) { return null; }
}

function savedSetting(key) {
  try { return localStorage.getItem(key); } catch (e) { return null; }
}

async function fillModelPicker(m) {
  if (!modelSelect.options.length) {
    modelSelect.add(new Option("Automatic (best for this device)", "auto"));
    for (const model of m.whisper.models) modelSelect.add(new Option(model.label, model.id));
    const saved = savedModel();
    if (m.whisper.models.some((x) => x.id === saved)) modelSelect.value = saved;
    if (["gpu", "cpu"].includes(savedSetting("engine"))) engineSelect.value = savedSetting("engine");
    for (const [select, key] of [[modelSelect, "model"], [engineSelect, "engine"]]) {
      select.addEventListener("change", () => {
        try { localStorage.setItem(key, select.value); } catch (e) {}
        updateModelHint();
      });
    }
  }
  await hardwareReady;
  gpuPrefSelect.value = gpuPref();
  engineSelect.querySelector('option[value="gpu"]').disabled = !hardware.gpu;
  if (!hardware.gpu && engineSelect.value === "gpu") engineSelect.value = "auto";
  updateModelHint();
}

// Loads the GPU engine on the preferred card. A worker started for the other
// card is replaced; the caller holds the transcription turn, so it's idle.
function loadGpu(onProgress) {
  if (gpu.loading && gpu.pref !== gpuPref() && !gpu.pending) gpu.crash(new Error("graphics card preference changed"));
  if (!gpu.loading) gpu.pref = gpuPref();
  return gpu.load(manifest, onProgress, { powerPreference: gpu.pref });
}

// If the GPU engine won't start (driver trouble, blocked WebGPU), fall back
// to the CPU engine rather than failing the job.
async function loadAsr(asr, onProgress) {
  if (asr !== gpu) return whisper.load(manifest, onProgress);
  try {
    await loadGpu(onProgress);
  } catch (err) {
    console.warn("GPU engine failed, using the CPU:", err);
    gpuFailed = true;
    updateModelHint();
    await whisper.load(manifest, onProgress);
  }
}

async function ensureEngines(job) {
  await fillModelPicker(await loadManifest());
  const asr = asrEngine(job);
  if (sherpa.loading && asr.loading) {
    // Already loaded by an earlier job (jobs run one at a time).
    await Promise.all([sherpa.loading, asr.loading]);
    return;
  }
  engineBanner.hidden = false;
  engineStatus.textContent = "Loading engines...";
  engineProgress.hidden = true;
  // The engine download reports real loaded/total bytes -- mirror that
  // onto the job's own bar too, not just the page-level banner.
  const onProgress = (p) => {
    showEngineProgress(p);
    if (job) setStatus(job, `Downloading ${p.label}`, p.total ? p.loaded / p.total : undefined);
  };
  try {
    // One at a time so the banner shows a single, meaningful progress bar.
    await sherpa.load(manifest, onProgress);
    await loadAsr(asr, onProgress);
  } catch (err) {
    engineStatus.textContent = "Loading the engines failed: " + err.message;
    engineProgress.hidden = true;
    if (job && job.cancelled) engineBanner.hidden = true;
    throw err;
  }
  engineBanner.hidden = true;
}

// ---- Jobs ----------------------------------------------------------------

const queue = [];
let active = 0;

// Speaker detection for several files at once. On the graphics card,
// transcription leaves the processor nearly idle and speaker detection
// becomes the slow step, so the next files diarize while one transcribes.
// On the processor whisper already takes all but one core, so it stays
// one file at a time. Each extra file costs a few hundred MB of memory.
const MAX_PARALLEL_FILES = 3;
const diarizers = [sherpa];

function parallelFiles(next) {
  if (!manifest || !next || !useGpu(selectedModel(next.opts.model), next.opts.translate)) return 1;
  return Math.max(1, Math.min(MAX_PARALLEL_FILES, hardware.cores - 2));
}

function takeDiarizer() {
  let d = diarizers.find((e) => !e.busy);
  if (!d) diarizers.push((d = new Engine("engines/sherpa-worker.js", "diarization engine")));
  d.busy = true;
  return d;
}

// Files transcribe one at a time, in the order they get here.
let asrQueue = Promise.resolve();
function asrTurn() {
  let release;
  const prev = asrQueue;
  asrQueue = new Promise((r) => (release = r));
  return prev.then(() => release);
}

async function decodeFileTo16kMono(file) {
  const arrayBuffer = await file.arrayBuffer();
  // Decoding straight to 16kHz (decodeAudioData resamples to the context's
  // rate) keeps a long 48kHz stereo recording from needing gigabytes.
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  let decoded;
  try {
    decoded = await ctx.decodeAudioData(arrayBuffer);
  } finally {
    ctx.close();
  }
  // Rendering through a 1-channel OfflineAudioContext downmixes to mono.
  const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * SAMPLE_RATE)), SAMPLE_RATE);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start(0);
  const rendered = await offline.startRendering();
  return { samples: rendered.getChannelData(0), durationSec: decoded.duration };
}

function setStatus(job, stage, fraction) {
  job.stage = stage;
  job.el.querySelector(".job-status").textContent =
    fraction === undefined ? stage : `${stage} (${Math.round(fraction * 100)}%)`;
  const bar = job.el.querySelector(".job-progress");
  bar.hidden = fraction === undefined;
  if (fraction !== undefined) bar.value = fraction;
}

// Decoding reports no progress of its own (the browser's AudioContext is a
// black box until it resolves), so estimate against a rough expected duration
// instead of leaving the bar hidden for the whole step. Eases toward 92%;
// past that the estimate was wrong, so it switches to an animated bar and
// an elapsed clock rather than sitting on a number that looks frozen.
function startEstimatedProgress(job, stage, estimatedMs) {
  stopEstimatedProgress(job);
  const start = performance.now();
  setStatus(job, stage, 0);
  job.estimateTimer = setInterval(() => {
    const elapsed = performance.now() - start;
    const fraction = 1 - Math.exp((-3 * elapsed) / estimatedMs);
    if (fraction < 0.92) return setStatus(job, stage, fraction);
    setStatus(job, `${stage}, still working (${fmtClock(elapsed / 1000)} so far)`);
    const bar = job.el.querySelector(".job-progress");
    bar.hidden = false;
    bar.removeAttribute("value");
  }, 200);
}

function stopEstimatedProgress(job) {
  if (job.estimateTimer) {
    clearInterval(job.estimateTimer);
    job.estimateTimer = null;
  }
}

function updateDoneStatus(job) {
  if (job.status !== "done") return;
  const n = speakerCount(job.rows);
  const took = job.tookSec ? `, took ${fmtClock(job.tookSec)}` : "";
  setStatus(job, job.rows.length ? `Done: ${n} speaker${n === 1 ? "" : "s"}, ${fmtClock(job.durationSec)} long${took}` : "Done: no speech found");
}

// ---- Downloads -------------------------------------------------------------
// One "Download" menu instead of four buttons; the same menu sits on the
// file's card and in the editor's toolbar.

function exportMenu(job, summaryClass) {
  const menu = document.createElement("details");
  menu.className = "menu";
  menu.innerHTML = `
    <summary class="${summaryClass}">Download</summary>
    <div class="menu-list">
      <button type="button" class="export-docx">Word document <small>.docx</small></button>
      <button type="button" class="export-srt">Subtitles <small>.srt</small></button>
      <button type="button" class="export-csv">Spreadsheet <small>.csv</small></button>
      <button type="button" class="export-json">Data <small>.json</small></button>
    </div>
  `;
  const baseName = job.name.replace(/\.[^.]+$/, "");
  const rows = () => renameSpeakers(job.rows, job.names);
  const actions = {
    docx: () => downloadDocx(baseName, rows(), `${baseName}_transcript.docx`, editorLayout.value === "lines"),
    srt: () => downloadSrt(rows(), `${baseName}_transcript.srt`),
    csv: () => downloadCsv(rows(), `${baseName}_transcript.csv`),
    json: () => downloadJson(job.name, job.durationSec, rows(), { model: job.model, translated: job.translate }, `${baseName}_transcript.json`),
  };
  for (const [kind, run] of Object.entries(actions)) {
    menu.querySelector(`.export-${kind}`).addEventListener("click", () => {
      menu.open = false;
      run();
    });
  }
  return menu;
}

// Menus close on a click elsewhere or Esc, like any app menu.
function closeMenus(except) {
  for (const m of document.querySelectorAll("details.menu[open]")) if (m !== except) m.open = false;
}
document.addEventListener("click", (e) => closeMenus(e.target.closest("details.menu")));

// ---- Editor ----------------------------------------------------------------
// A full-page view over the file list, with its own history entry so the
// browser's Back button closes it. The transcript is always editable, one
// text box per line, and the keyboard does the structural edits (Enter
// splits, Backspace joins), so there's no edit mode and no per-line buttons.
// Edits write straight into job.rows, which every export reads at download
// time.

const editor = document.getElementById("editor");
const editorName = document.getElementById("editor-name");
const editorMeta = document.getElementById("editor-meta");
const editorExport = document.getElementById("editor-export");
const editorSpeakers = document.getElementById("editor-speakers");
const editorTranscript = document.getElementById("editor-transcript");
const editorAudio = document.getElementById("editor-audio");
const editorSpeed = document.getElementById("editor-speed");
const editorLayout = document.getElementById("editor-layout");
editorLayout.value = savedSetting("layout") === "lines" ? "lines" : "turns";
editorLayout.addEventListener("change", () => {
  try { localStorage.setItem("layout", editorLayout.value); } catch (e) {}
  if (current) render(current);
});
const undoBtn = document.getElementById("undo");
const findToggle = document.getElementById("find-toggle");
const findBar = document.getElementById("find-bar");
const findText = document.getElementById("find-text");
const replaceText = document.getElementById("replace-text");
const findCount = document.getElementById("find-count");
let current = null; // the job open in the editor

function openEditor(job) {
  current = job;
  editorName.textContent = job.name;
  editorExport.replaceChildren(exportMenu(job, "btn btn-sm"));
  if (editorAudio.src !== job.url) editorAudio.src = job.url;
  editorAudio.playbackRate = +editorSpeed.value;
  undoBtn.disabled = !job.undo.length;
  findCount.textContent = "";
  if (!editor.open) {
    history.pushState({ editor: true }, "", "#transcript");
    editor.showModal();
  }
  // After showModal: the text boxes size themselves to the laid-out page.
  render(job);
  for (const el of editor.querySelectorAll(".editor-body, .editor-scroll")) el.scrollTop = 0;
}

// However it closes (the toolbar's Back, Esc, the browser's Back), drop the
// history entry openEditor pushed, if it's still there.
editor.addEventListener("close", () => {
  editorAudio.pause();
  current = null;
  if (history.state && history.state.editor) history.back();
});
window.addEventListener("popstate", () => {
  if (editor.open) editor.close();
});
// A reload can't bring the editor back (the file lived in memory), so drop
// a stale #transcript from the address.
if (location.hash === "#transcript") history.replaceState(null, "", location.pathname + location.search);

editor.querySelector(".editor-back").addEventListener("click", () => editor.close());
// Esc closes the innermost thing first: a menu, then the find bar, then the editor.
editor.addEventListener("cancel", (e) => {
  if (editor.querySelector("details.menu[open]")) {
    e.preventDefault();
    closeMenus();
  } else if (!findBar.hidden) {
    e.preventDefault();
    showFind(false);
  }
});

function render(job) {
  const n = speakerCount(job.rows);
  editorMeta.textContent = `${n} speaker${n === 1 ? "" : "s"} · ${fmtClock(job.durationSec)}`;
  renderSpeakers(job);
  renderTranscript(job);
}

// Re-render after any change to rows or speakers.
function changed(job) {
  updateDoneStatus(job);
  render(job);
}

// ---- Undo ------------------------------------------------------------------
// Snapshots of the whole edit state. Typing is grouped per line (a new
// group after a 2-second pause), so one Ctrl+Z undoes a burst of typing,
// not a single letter.

function checkpoint(job) {
  job.undo.push(structuredClone({ rows: job.rows, names: job.names, extraSpeakers: job.extraSpeakers }));
  if (job.undo.length > 200) job.undo.shift();
  job.typingKey = null;
  undoBtn.disabled = false;
}

function checkpointTyping(job, key) {
  const now = Date.now();
  if (job.typingKey !== key || now - job.typedAt > 2000) {
    checkpoint(job);
    job.typingKey = key;
  }
  job.typedAt = now;
}

function undo(job) {
  const snap = job.undo.pop();
  if (!snap) return;
  Object.assign(job, snap);
  job.typingKey = null;
  undoBtn.disabled = !job.undo.length;
  changed(job);
}
undoBtn.addEventListener("click", () => undo(current));

// ---- Speakers --------------------------------------------------------------

// Speakers actually used by a row, plus any added but not yet assigned to
// one -- so a freshly added speaker still shows up as a choice. Sorted, so
// the list (and Alt+1-9) keeps a stable order.
function allSpeakerIds(job) {
  return [...new Set([...job.rows.map((r) => r.speaker_id), ...job.extraSpeakers])].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true })
  );
}

function speakerHue(index) {
  return String((index * 137 + 210) % 360);
}

function addSpeaker(job) {
  checkpoint(job);
  const used = allSpeakerIds(job);
  let n = used.length + 1;
  while (used.includes(`Speaker ${n}`)) n++;
  job.extraSpeakers.push(`Speaker ${n}`);
  changed(job);
  editorSpeakers.querySelector(`input[data-speaker="Speaker ${n}"]`).focus();
}
document.getElementById("add-speaker").addEventListener("click", () => addSpeaker(current));

// Removing a speaker moves its lines onto whichever other speaker sorts
// first. The last remaining speaker can't be removed, so there's always
// somewhere for them to go.
function removeSpeaker(job, id) {
  const others = allSpeakerIds(job).filter((s) => s !== id);
  if (!others.length) return;
  checkpoint(job);
  for (const row of job.rows) {
    if (row.speaker_id === id) row.speaker_id = others[0];
  }
  delete job.names[id];
  job.extraSpeakers = job.extraSpeakers.filter((s) => s !== id);
  changed(job);
}

function renderSpeakers(job) {
  const ids = allSpeakerIds(job);
  editorSpeakers.replaceChildren(
    ...ids.map((id, i) => {
      const li = document.createElement("li");
      li.className = "speaker-item";
      li.style.setProperty("--hue", speakerHue(i));
      const input = document.createElement("input");
      input.type = "text";
      input.placeholder = id;
      input.dataset.speaker = id;
      input.value = job.names[id] || "";
      input.setAttribute("aria-label", `Name for ${id}`);
      input.addEventListener("input", () => {
        checkpointTyping(job, "name:" + id);
        job.names[id] = input.value;
        renderTranscript(job);
      });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "speaker-remove";
      remove.textContent = "×";
      remove.title = `Remove ${job.names[id] || id} (their lines go to another speaker)`;
      remove.disabled = ids.length < 2;
      remove.addEventListener("click", () => removeSpeaker(job, id));
      li.append(input, remove);
      return li;
    })
  );
}

// ---- Transcript ------------------------------------------------------------

function assignSpeaker(job, i, id) {
  if (!id || job.rows[i].speaker_id === id) return;
  checkpoint(job);
  job.rows[i].speaker_id = id;
  changed(job);
}

// Joins row i+1 onto row i, keeping row i's speaker.
function mergeRowWithNext(job, i) {
  const rows = job.rows;
  if (i + 1 >= rows.length) return;
  checkpoint(job);
  const a = rows[i];
  const b = rows[i + 1];
  a.transcribed_text = [a.transcribed_text, b.transcribed_text].filter(Boolean).join(" ");
  a.timestamp_end = b.timestamp_end;
  rows.splice(i + 1, 1);
  changed(job);
}

// Splits row i's text into two rows at a character offset. Whisper only
// gives a start/end for the whole segment, so the time boundary is
// estimated proportionally by text length -- close enough to navigate by,
// not a claim of exact timing.
function splitRow(job, i, splitAt) {
  const row = job.rows[i];
  const text = row.transcribed_text;
  const before = text.slice(0, splitAt).trim();
  const after = text.slice(splitAt).trim();
  if (!before || !after) return false;
  checkpoint(job);
  const mid = row.timestamp_start + (row.timestamp_end - row.timestamp_start) * (splitAt / text.length);
  job.rows.splice(
    i,
    1,
    { ...row, transcribed_text: before, timestamp_end: mid },
    { ...row, transcribed_text: after, timestamp_start: mid }
  );
  changed(job);
  return true;
}

function focusRow(i, offset) {
  const text = editorTranscript.querySelectorAll(".seg-text")[i];
  if (!text) return;
  text.focus();
  const at = offset === "end" ? text.value.length : offset;
  text.setSelectionRange(at, at);
}

function autosize(text) {
  text.style.height = "auto";
  text.style.height = text.scrollHeight + "px";
}
window.addEventListener("resize", () => editorTranscript.querySelectorAll(".seg-text").forEach(autosize));

// Word-processor keys on a line's text box.
function onLineKey(job, i, text, e) {
  const pos = text.selectionStart;
  const caret = pos === text.selectionEnd;
  const last = job.rows.length - 1;
  if (e.key === "Enter") {
    // Lines are paragraphs; a newline inside one would end up in exports.
    e.preventDefault();
    if (caret && splitRow(job, i, pos)) focusRow(i + 1, 0);
  } else if (e.key === "Backspace" && caret && pos === 0 && i > 0) {
    e.preventDefault();
    const above = job.rows[i - 1].transcribed_text;
    const join = above.length + (above && text.value ? 1 : 0);
    mergeRowWithNext(job, i - 1);
    focusRow(i - 1, join);
  } else if (e.key === "Delete" && caret && pos === text.value.length && i < last) {
    e.preventDefault();
    const join = pos + (text.value && job.rows[i + 1].transcribed_text ? 1 : 0);
    mergeRowWithNext(job, i);
    focusRow(i, join);
  } else if (e.key === "ArrowUp" && caret && pos === 0 && i > 0) {
    e.preventDefault();
    focusRow(i - 1, "end");
  } else if (e.key === "ArrowDown" && caret && pos === text.value.length && i < last) {
    e.preventDefault();
    focusRow(i + 1, 0);
  } else if (e.altKey && /^Digit[1-9]$/.test(e.code)) {
    e.preventDefault();
    assignSpeaker(job, i, allSpeakerIds(job)[+e.code.slice(5) - 1]);
    focusRow(i, pos);
  }
}

/// One paragraph per row: a gutter with the speaker (a picker, shown where
/// the speaker changes and on hover elsewhere) and a timestamp that plays
/// from there, then the editable text.
function renderTranscript(job) {
  const ids = allSpeakerIds(job);
  const frag = document.createDocumentFragment();
  job.rows.forEach((row, i) => {
    const seg = document.createElement("div");
    seg.className = "seg";
    if (editorLayout.value === "turns" && i > 0 && job.rows[i - 1].speaker_id === row.speaker_id) seg.classList.add("cont");
    seg.style.setProperty("--hue", speakerHue(ids.indexOf(row.speaker_id)));
    seg.dataset.start = row.timestamp_start;
    seg.dataset.end = row.timestamp_end;

    const gutter = document.createElement("div");
    gutter.className = "seg-gutter";
    const select = document.createElement("select");
    select.className = "seg-speaker";
    select.setAttribute("aria-label", "Speaker");
    for (const id of ids) select.add(new Option(job.names[id] || id, id, false, id === row.speaker_id));
    select.addEventListener("change", () => assignSpeaker(job, i, select.value));
    const when = document.createElement("button");
    when.type = "button";
    when.className = "seg-time";
    when.textContent = fmtClock(row.timestamp_start);
    when.title = "Play from here";
    when.addEventListener("click", () => {
      editorAudio.currentTime = row.timestamp_start;
      editorAudio.play();
    });
    gutter.append(select, when);

    const text = document.createElement("textarea");
    text.className = "seg-text";
    text.rows = 1;
    text.spellcheck = true;
    text.value = row.transcribed_text;
    text.setAttribute("aria-label", `Line ${i + 1}`);
    text.addEventListener("input", () => {
      checkpointTyping(job, row);
      row.transcribed_text = text.value;
      autosize(text);
      refreshFind();
    });
    text.addEventListener("keydown", (e) => onLineKey(job, i, text, e));

    // Find's highlights, drawn over the text in the same layout.
    const body = document.createElement("div");
    body.className = "seg-body";
    const marks = document.createElement("div");
    marks.className = "seg-marks";
    marks.setAttribute("aria-hidden", "true");
    body.append(text, marks);
    seg.append(gutter, body);
    frag.append(seg);
  });
  editorTranscript.replaceChildren(frag);
  editorTranscript.querySelectorAll(".seg-text").forEach(autosize);
  refreshFind();
  followPlayback();
}

// ---- Playback --------------------------------------------------------------
// The original file is still in memory, so the editor plays it. The line
// being played is highlighted and kept in view, unless you're typing.

function followPlayback() {
  const t = editorAudio.currentTime;
  if (!t) return;
  const view = editor.querySelector(".editor-body").getBoundingClientRect();
  for (const el of editorTranscript.children) {
    const on = t >= +el.dataset.start && t < +el.dataset.end;
    if (on === el.classList.contains("playing")) continue;
    el.classList.toggle("playing", on);
    if (on && !(document.activeElement && document.activeElement.classList.contains("seg-text"))) {
      const r = el.getBoundingClientRect();
      if (r.top < view.top || r.bottom > view.bottom) el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }
}
editorAudio.addEventListener("timeupdate", followPlayback);
editorSpeed.addEventListener("change", () => (editorAudio.playbackRate = +editorSpeed.value));

// Editor-wide keys: Ctrl+Space plays/pauses even while typing, Ctrl+Z is
// the editor's undo (it also covers speaker changes, splits and joins, which
// a text box's own undo can't), Ctrl+F opens find.
editor.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (e.ctrlKey && e.code === "Space") {
    e.preventDefault();
    if (editorAudio.paused) editorAudio.play();
    else editorAudio.pause();
  } else if (mod && !e.shiftKey && e.key.toLowerCase() === "z" && !findBar.contains(e.target)) {
    e.preventDefault();
    undo(current);
  } else if (mod && (e.key.toLowerCase() === "f" || e.key.toLowerCase() === "h")) {
    e.preventDefault();
    showFind(true);
    if (e.key.toLowerCase() === "h") replaceText.focus();
  }
});

// Edits and finished transcripts live only in this tab.
window.addEventListener("beforeunload", (e) => {
  if (jobList.querySelector('.job[data-status="done"]')) e.preventDefault();
});

// ---- Find & replace --------------------------------------------------------
// Every match is highlighted in a layer drawn over the text boxes (a
// textarea can't highlight part of its own text); the current one stands
// out. Enter/Shift+Enter step through them, Replace changes the current one
// and moves on.

const findCase = document.getElementById("find-case");
let matches = []; // { row, start, end }, in reading order
let matchAt = -1;

function findMatches(job) {
  const needle = findText.value;
  if (!needle || !job) return [];
  const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), findCase.checked ? "g" : "gi");
  const out = [];
  job.rows.forEach((r, row) => {
    for (const m of r.transcribed_text.matchAll(re)) out.push({ row, start: m.index, end: m.index + m[0].length });
  });
  return out;
}

function paintMatches() {
  for (const marks of editorTranscript.querySelectorAll(".seg-marks")) marks.replaceChildren();
  let prev = null;
  matches.forEach((m, k) => {
    const marks = editorTranscript.children[m.row]?.querySelector(".seg-marks");
    if (!marks) return;
    const text = current.rows[m.row].transcribed_text;
    const mark = document.createElement("mark");
    mark.textContent = text.slice(m.start, m.end);
    if (k === matchAt) mark.className = "current";
    marks.append(text.slice(prev && prev.row === m.row ? prev.end : 0, m.start), mark);
    prev = m;
  });
  findCount.textContent = !findText.value ? "" : matches.length ? `${matchAt + 1} of ${matches.length}` : "No matches";
  for (const id of ["find-prev", "find-next", "replace-one", "replace-all"]) document.getElementById(id).disabled = !matches.length;
}

// Re-find after the text changed. `from` keeps the place: the first match
// at or after that spot becomes the current one.
function refreshFind(from) {
  if (findBar.hidden || !current) return;
  matches = findMatches(current);
  if (!matches.length) matchAt = -1;
  else if (from) {
    const k = matches.findIndex((m) => m.row > from.row || (m.row === from.row && m.start >= from.start));
    matchAt = k < 0 ? 0 : k;
  } else matchAt = Math.min(Math.max(matchAt, 0), matches.length - 1);
  paintMatches();
}

function goToMatch(step) {
  if (!matches.length) return;
  matchAt = (matchAt + step + matches.length) % matches.length;
  paintMatches();
  const seg = editorTranscript.children[matches[matchAt].row];
  const view = editor.querySelector(".editor-body").getBoundingClientRect();
  const r = seg.getBoundingClientRect();
  if (r.top < view.top + 40 || r.bottom > view.bottom) seg.scrollIntoView({ block: "center" });
}

function showFind(show) {
  findBar.hidden = !show;
  findToggle.setAttribute("aria-expanded", String(show));
  if (show) {
    // Text selected in a line becomes the search, as in a word processor.
    const box = document.activeElement;
    if (box && box.classList.contains("seg-text") && box.selectionEnd > box.selectionStart) {
      findText.value = box.value.slice(box.selectionStart, box.selectionEnd);
    }
    findText.focus();
    findText.select();
    matchAt = -1;
    refreshFind();
    goToMatch(0);
  } else {
    // Leave the caret on the current match, so you can carry on typing there.
    const m = matches[matchAt];
    matches = [];
    paintMatches();
    const box = m && editorTranscript.children[m.row]?.querySelector(".seg-text");
    if (box) {
      box.focus();
      box.setSelectionRange(m.start, m.end);
    }
  }
}
findToggle.addEventListener("click", () => showFind(findBar.hidden));
document.getElementById("find-close").addEventListener("click", () => showFind(false));
document.getElementById("find-next").addEventListener("click", () => goToMatch(1));
document.getElementById("find-prev").addEventListener("click", () => goToMatch(-1));

// Typing a search jumps to its first match, like a browser's find.
for (const el of [findText, findCase]) {
  el.addEventListener("input", () => {
    matchAt = -1;
    refreshFind();
    goToMatch(0);
  });
}

findText.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  goToMatch(e.shiftKey ? -1 : 1);
});

function replaceCurrent() {
  const m = matches[matchAt];
  if (!m) return;
  const row = current.rows[m.row];
  checkpoint(current);
  row.transcribed_text = row.transcribed_text.slice(0, m.start) + replaceText.value + row.transcribed_text.slice(m.end);
  changed(current);
  // Carry on after the replacement, so it isn't found again.
  refreshFind({ row: m.row, start: m.start + replaceText.value.length });
  goToMatch(0);
}
document.getElementById("replace-one").addEventListener("click", replaceCurrent);
replaceText.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  replaceCurrent();
});

document.getElementById("replace-all").addEventListener("click", () => {
  const n = matches.length;
  if (!n) return;
  checkpoint(current);
  // Back to front, so earlier positions stay valid.
  for (const m of [...matches].reverse()) {
    const row = current.rows[m.row];
    row.transcribed_text = row.transcribed_text.slice(0, m.start) + replaceText.value + row.transcribed_text.slice(m.end);
  }
  changed(current);
  findCount.textContent = `Replaced ${n}`;
});

// ---- Finished jobs -----------------------------------------------------------

function finishJob(job) {
  job.status = "done";
  updateDoneStatus(job);
  job.el.dataset.status = "done";
  if (!job.rows.length) return;
  job.url = URL.createObjectURL(job.file);
  const actions = job.el.querySelector(".job-actions");
  actions.querySelector(".job-open").addEventListener("click", () => openEditor(job));
  actions.append(exportMenu(job, "btn btn-sm btn-ghost"));
  actions.hidden = false;
}

function failJob(job, message) {
  stopEstimatedProgress(job);
  job.status = "error";
  job.el.dataset.status = "error";
  setStatus(job, "Failed");
  job.el.querySelector(".job-error").textContent = message;
  // Download failures (network drop, storage quota) are worth retrying;
  // an undecodable file is not.
  const retryEl = job.el.querySelector(".job-retry");
  retryEl.hidden = !message.startsWith("download failed");
  retryEl.onclick = () => {
    retryEl.hidden = true;
    job.el.querySelector(".job-error").textContent = "";
    enqueue(job);
  };
}

function askLongRecording(job) {
  return new Promise((resolve) => {
    const warn = document.createElement("div");
    warn.className = "job-warning";
    warn.innerHTML = `
      <p>Recordings over about an hour may be slow or run out of memory in this browser tab.
      For longer files, consider splitting the file or using the desktop app.</p>
      <button class="btn btn-sm proceed">Process anyway</button>
      <button class="btn btn-sm btn-ghost skip">Skip this file</button>
    `;
    job.el.appendChild(warn);
    warn.querySelector(".proceed").onclick = () => { warn.remove(); resolve(true); };
    warn.querySelector(".skip").onclick = job.skipLong = () => { warn.remove(); resolve(false); };
  });
}

async function processJob(job) {
  job.status = "processing";
  job.el.dataset.status = "processing";
  const { language, numSpeakers } = job.opts;
  job.translate = job.opts.translate;
  const jobStart = performance.now();

  startEstimatedProgress(job, "Decoding audio", 1500);
  let decoded;
  try {
    decoded = await decodeFileTo16kMono(job.file);
  } catch (err) {
    stopEstimatedProgress(job);
    throw new Error("could not decode this file: " + ((err && err.message) || err));
  }
  stopEstimatedProgress(job);
  if (job.cancelled) return;
  const { samples, durationSec } = decoded;
  job.durationSec = durationSec;
  if (durationSec > LONG_RECORDING_WARN_SEC && !job.longOk) {
    setStatus(job, "Waiting for you");
    if (!(await askLongRecording(job))) {
      job.status = "skipped";
      job.el.dataset.status = "skipped";
      setStatus(job, "Skipped");
      return;
    }
    job.longOk = true;
  }

  setStatus(job, "Loading engines");
  await ensureEngines(job);
  if (job.cancelled) return;
  runQueue(); // the engines and this device are known now: start more files if it pays

  // Speaker detection runs alongside transcription: neither needs the
  // other's output, and whisper leaves one core free (or runs on the GPU).
  // It gets its own copy, since whisper takes the samples.
  // Its progress shows while the file waits for its turn to transcribe and
  // after transcription; during transcription it's only kept.
  const diarizer = takeDiarizer();
  job.diarizer = diarizer;
  const diarSamples = samples.slice();
  let diarFraction = 0;
  let diarStage = "Detecting speakers, transcribes next";
  let showDiar = true;
  const diarizing = diarizer.load(manifest).then(async () => {
    const start = performance.now();
    const result = await diarizer.request({ type: "diarize", samples: diarSamples, numSpeakers }, [diarSamples.buffer], (p) => {
      diarFraction = p.fraction;
      if (showDiar) setStatus(job, diarStage, diarFraction);
    });
    saveSpeed("diar", durationSec, (performance.now() - start) / 1000);
    return result;
  });
  diarizing.catch(() => {}); // awaited below; don't report it as unhandled meanwhile

  const transcribe = async () => {
    const model = selectedModel(job.opts.model);
    const onGpu = useGpu(model, job.translate);
    const engine = onGpu ? gpu : whisper;
    job.model = onGpu ? `${model.onnx} (GPU)` : model.name;
    setStatus(job, "Transcribing");
    let transcribeStart = null;
    // Preparing a model on some GPUs never finishes and never errors. If
    // the GPU worker goes quiet before transcription starts, kill it so the
    // CPU fallback below takes over.
    let watchdog = null;
    const arm = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => gpu.crash(new Error("the graphics card stopped responding while preparing the model")), GPU_QUIET_LIMIT_MS);
    };
    const onProgress = (p) => {
      if (onGpu) p.started ? clearTimeout(watchdog) : arm();
      if (p.label) {
        setStatus(job, `Downloading ${p.label}`, p.total ? p.loaded / p.total : undefined);
      } else if (p.preparing) {
        setStatus(job, "Preparing the model on the graphics card");
      } else if (p.started) {
        transcribeStart = performance.now();
        setStatus(job, "Transcribing");
      } else {
        transcribeStart ??= performance.now();
        const left = timeLeft((performance.now() - transcribeStart) / 1000, p.fraction);
        setStatus(job, left ? `Transcribing, ${left}` : "Transcribing", p.fraction);
      }
    };
    // Settings can change after ensureEngines, so this engine may not be
    // the one it loaded. load() is a no-op if it is.
    await (onGpu ? loadGpu(onProgress) : engine.load(manifest, onProgress));
    if (onGpu) arm();
    setGameAllowed(!onGpu);
    try {
      const result = await engine.request(
        { type: "transcribe", samples, language, translate: job.translate, modelUrl: onGpu ? model.onnx : model.url, dtype: model.onnxDtype },
        // Keep a copy while on the GPU, in case it fails and the CPU retries.
        onGpu ? [] : [samples.buffer],
        onProgress
      );
      if (transcribeStart) saveSpeed(`${model.id}:${onGpu ? "gpu" : "cpu"}`, durationSec, (performance.now() - transcribeStart) / 1000);
      return result;
    } finally {
      clearTimeout(watchdog);
      setGameAllowed(true);
    }
  };

  try {
    setStatus(job, diarStage);
    const release = await asrTurn();
    job.asrHeld = true;
    let tr;
    try {
      if (job.cancelled) return;
      showDiar = false;
      try {
        tr = await transcribe();
      } catch (err) {
        // A GPU that loaded but can't run the model (out of graphics memory,
        // a driver bug): finish this file on the CPU and stay there.
        if (job.cancelled || !job.model.endsWith("(GPU)") || engineSelect.value === "gpu") throw err;
        console.warn("GPU transcription failed, retrying on the CPU:", err);
        gpuFailed = true;
        updateModelHint();
        tr = await transcribe();
      }
    } finally {
      job.asrHeld = false;
      release();
    }

    showDiar = true;
    diarStage = "Detecting speakers";
    setStatus(job, diarStage, diarFraction);
    const diar = await diarizing;
    const dsegs = diar.segments.map((s) => ({ s: s.start, e: s.end, spk: s.speaker }));

    job.rows = assignSpeakers(tr.segments, dsegs);
    job.tookSec = (performance.now() - jobStart) / 1000;
    finishJob(job);
  } finally {
    // Let the diarization worker finish before another file uses it.
    await diarizing.catch(() => {});
    diarizer.busy = false;
    job.diarizer = null;
  }
}

function runQueue() {
  while (queue.length && active < parallelFiles(queue[0])) {
    const job = queue.shift();
    active++;
    processJob(job)
      .catch((err) => {
        if (!job.cancelled) failJob(job, String((err && err.message) || err));
      })
      .finally(() => {
        active--;
        // Extra speaker workers hold their models in memory; drop them when idle.
        if (!active && !queue.length) for (const d of diarizers.splice(1)) d.crash(new Error("idle"));
        runQueue();
      });
  }
}

function enqueue(job) {
  job.status = "queued";
  job.el.dataset.status = "queued";
  setStatus(job, "Queued");
  queue.push(job);
  runQueue();
}

// Removing a running file stops it: a worker can't be interrupted mid-call,
// so the engines it is using are thrown away and the next file reloads them
// (from the cache, so in seconds). Other files keep theirs.
function removeJob(job) {
  const i = queue.indexOf(job);
  if (i >= 0) queue.splice(i, 1);
  if (job.status === "processing") {
    job.cancelled = true;
    if (job.skipLong) job.skipLong();
    if (job.diarizer) job.diarizer.crash(new Error("cancelled"));
    if (job.asrHeld) for (const engine of [whisper, gpu]) engine.crash(new Error("cancelled"));
  }
  stopEstimatedProgress(job);
  if (job.url) URL.revokeObjectURL(job.url);
  job.el.remove();
}

function addJob(file, opts) {
  const li = document.createElement("li");
  li.className = "job";
  li.innerHTML = `
    <button type="button" class="btn btn-sm btn-ghost job-remove">Remove</button>
    <div class="job-name"></div>
    <div class="job-status"></div>
    <progress class="job-progress" max="1" value="0" hidden></progress>
    <div class="job-error"></div>
    <button class="btn btn-sm job-retry" hidden>Retry</button>
    <div class="job-actions" hidden>
      <button type="button" class="btn btn-sm job-open">Open transcript</button>
    </div>
  `;
  li.querySelector(".job-name").textContent = file.name;
  jobList.appendChild(li);
  const job = { name: file.name, file, opts, el: li, rows: [], names: {}, extraSpeakers: [], durationSec: 0, undo: [] };
  li.job = job;
  li.querySelector(".job-remove").setAttribute("aria-label", `Remove ${file.name}`);
  li.querySelector(".job-remove").onclick = () => removeJob(job);
  enqueue(job);
}

// Collapsing an element animates (CSS grid-rows trick on .collapsible-inner)
// instead of an instant `hidden` toggle; `inert` keeps it out of the tab
// order and off-limits while collapsed, since layout alone doesn't.
function setCollapsed(el, collapsed) {
  el.toggleAttribute("data-collapsed", collapsed);
  el.toggleAttribute("inert", collapsed);
}

// Added files wait in step 1, each with its own speakers, language and
// translate choice (starting from the values above the list), until Start.
const stagedBox = document.getElementById("staged");
const stagedList = document.getElementById("staged-list");
const startButton = document.getElementById("start");

function updateStaged() {
  const n = stagedList.children.length;
  stagedBox.hidden = !n;
  startButton.textContent = `Start transcribing ${n} file${n === 1 ? "" : "s"}`;
}

function stageFile(file) {
  const li = document.createElement("li");
  li.className = "staged";
  li.innerHTML = `
    <div class="staged-name"><strong></strong><span class="hint"></span><span class="hint staged-estimate"></span></div>
    <label class="staged-field">Model </label>
    <label class="staged-field">Speakers <input type="number" class="staged-speakers" min="0" max="20" /></label>
    <label class="staged-field">Language </label>
    <label class="checkbox-label"><input type="checkbox" class="staged-translate" /> Translate</label>
    <button type="button" class="btn btn-sm btn-ghost">Remove</button>
  `;
  li.querySelector("strong").textContent = file.name;
  const info = li.querySelector(".hint");
  info.textContent = `${mb(file.size).toLocaleString()} MB`;
  // The length, when the browser can read it without decoding everything.
  const media = document.createElement("audio");
  media.preload = "metadata";
  media.src = URL.createObjectURL(file);
  media.onloadedmetadata = () => {
    if (Number.isFinite(media.duration)) {
      info.textContent = `${fmtClock(media.duration)} · ${info.textContent}`;
      li.durationSec = media.duration;
      updateEstimate(li);
    }
    URL.revokeObjectURL(media.src);
  };
  media.onerror = () => URL.revokeObjectURL(media.src);
  li.querySelector(".staged-speakers").value = numSpeakersInput.value;
  const language = languageInput.cloneNode(true);
  language.removeAttribute("id");
  language.className = "staged-language";
  language.value = languageInput.value;
  li.querySelectorAll(".staged-field")[2].appendChild(language);
  const model = modelSelect.cloneNode(true);
  model.removeAttribute("id");
  model.className = "staged-model";
  for (const o of model.options) o.textContent = o.textContent.split(" (")[0]; // the row has little room
  model.value = modelSelect.value;
  model.onchange = () => updateEstimate(li);
  li.querySelectorAll(".staged-field")[0].appendChild(model);
  li.querySelector(".staged-translate").checked = translateInput.checked;
  li.querySelector(".staged-translate").onchange = () => updateEstimate(li);
  li.querySelector("button").setAttribute("aria-label", `Remove ${file.name}`);
  li.querySelector("button").onclick = () => {
    li.remove();
    updateStaged();
  };
  li.file = file;
  stagedList.appendChild(li);
}

startButton.addEventListener("click", () => {
  for (const li of [...stagedList.children]) {
    addJob(li.file, {
      numSpeakers: Math.min(20, Math.max(0, parseInt(li.querySelector(".staged-speakers").value, 10) || 0)),
      language: li.querySelector(".staged-language").value || "auto",
      translate: li.querySelector(".staged-translate").checked,
      model: li.querySelector(".staged-model").value,
    });
    li.remove();
  }
  updateStaged();
});

function queueFiles(fileList) {
  if (fileInput.disabled) return;
  for (const file of fileList) stageFile(file);
  updateStaged();
}

fileInput.addEventListener("change", () => {
  queueFiles(fileInput.files);
  fileInput.value = "";
});
dropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropzone.classList.add("dragover");
});
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("dragover");
  queueFiles(e.dataTransfer.files);
});

document.querySelectorAll(".panel-toggle").forEach((toggle) => {
  toggle.addEventListener("click", () => {
    const body = document.getElementById(toggle.getAttribute("aria-controls"));
    const wasExpanded = toggle.getAttribute("aria-expanded") !== "false";
    toggle.setAttribute("aria-expanded", String(!wasExpanded));
    setCollapsed(body, wasExpanded);
  });
});

const settingsDialog = document.getElementById("settings-dialog");
const themeSelect = document.getElementById("theme");
document.getElementById("settings-open").addEventListener("click", () => {
  themeSelect.value = themePref(); // themePref/setTheme: inline script in index.html
  settingsDialog.showModal();
  showCacheSize();
});

const cacheSize = document.getElementById("cache-size");
const cacheClear = document.getElementById("cache-clear");
async function showCacheSize() {
  // Deleting mid-run would only make the running file download again.
  cacheClear.disabled = active > 0;
  try {
    const bytes = await cachedBytes();
    cacheSize.textContent = bytes ? `${mb(bytes).toLocaleString()} MB stored in this browser.` : "Nothing stored.";
    if (!bytes) cacheClear.disabled = true;
  } catch (e) {
    cacheSize.textContent = "This browser doesn't keep downloads (private window?).";
    cacheClear.disabled = true;
  }
}
cacheClear.addEventListener("click", async () => {
  try {
    for (const name of (await caches.keys()).filter(isOurCache)) await caches.delete(name);
  } catch (e) {}
  showCacheSize();
});

const clearDone = document.getElementById("clear-done");
const FINISHED = ["done", "skipped", "error"];
function finishedJobs() {
  return [...jobList.querySelectorAll(".job")].map((li) => li.job).filter((job) => job && FINISHED.includes(job.el.dataset.status));
}
function updateClearDone() {
  clearDone.hidden = !finishedJobs().length;
}
clearDone.addEventListener("click", () => {
  const jobs = finishedJobs();
  const n = jobs.length;
  if (!confirm(`Remove ${n} finished file${n === 1 ? "" : "s"}? Their transcripts are gone for good unless you downloaded them.`)) return;
  for (const job of jobs) removeJob(job);
  updateClearDone();
});
new MutationObserver(updateClearDone).observe(jobList, { subtree: true, attributes: true, attributeFilter: ["data-status"], childList: true });

// Everything lives in this tab, so ask before it closes with files in it.
window.addEventListener("beforeunload", (e) => {
  if (!jobList.querySelector(".job")) return;
  e.preventDefault();
  e.returnValue = "";
});
themeSelect.addEventListener("change", () => setTheme(themeSelect.value));

const gameToggle = document.getElementById("game-toggle");
const flappyCanvas = document.getElementById("flappy-canvas");
let stopGame = null;
gameToggle.addEventListener("click", () => {
  if (stopGame) {
    stopGame();
    stopGame = null;
    flappyCanvas.hidden = true;
    gameToggle.textContent = "\u{1F3AE} Play while you wait";
  } else {
    flappyCanvas.hidden = false;
    gameToggle.textContent = "Hide game";
    stopGame = mountFlappyGame(flappyCanvas);
    gameToggle.blur(); // so space flaps instead of pressing "Hide game"
  }
});

// The graphics card can't draw the game smoothly while it transcribes, so
// the game closes and its button hides until the file is done.
function setGameAllowed(allowed) {
  if (!allowed && stopGame) gameToggle.click();
  gameToggle.hidden = !allowed;
}

if (checkCompat()) {
  engineBanner.hidden = false;
  engineStatus.textContent =
    "The first file you add downloads the transcription and speaker engines (about 320 MB with the standard model). They are cached for next time.";
}
loadManifest().then(fillModelPicker).catch(() => {}); // ensureEngines retries and reports

translateInput.addEventListener("change", updateModelHint);
gpuPrefSelect.addEventListener("change", async () => {
  try { localStorage.setItem("gpuPref", gpuPrefSelect.value); } catch (e) {}
  await detectGpu();
  updateModelHint();
});
