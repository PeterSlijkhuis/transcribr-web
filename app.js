// app.js -- main thread: compatibility check, audio decode, file queue,
// engine coordination, transcript rendering, export buttons.
//
// Each engine runs in its own worker (engines/whisper-worker.js,
// engines/sherpa-worker.js). Jobs run one at a time: decode here, diarize
// in the sherpa worker, transcribe in the whisper worker, merge here.
import { assignSpeakers } from "./merge.js";
import { toTurns, speakerCount, fmtClock, renameSpeakers } from "./shared.js";
import { downloadCsv } from "./export/csv.js";
import { downloadJson } from "./export/json.js";
import { downloadSrt } from "./export/srt.js";
import { downloadDocx } from "./export/docx.js";

const SAMPLE_RATE = 16000; // both engines take 16kHz mono
const LONG_RECORDING_WARN_SEC = 60 * 60; // soft warning threshold, see spec

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
const translateInput = document.getElementById("translate");

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
    showCompatError("This browser can't run transcribr-web (no WebAssembly SIMD). Use a current desktop Chrome or Edge.");
    disablePicker("Unsupported browser, see the message above.");
    return false;
  }
  if (!self.crossOriginIsolated || typeof SharedArrayBuffer === "undefined") {
    // coi-serviceworker.js reloads the page once to become isolated; only
    // report a failure if that hasn't happened after a few seconds.
    disablePicker("Setting up, the page may reload once...");
    setTimeout(() => {
      showCompatError(
        "This browser can't run transcribr-web (no cross-origin isolation / SharedArrayBuffer). " +
          "Use desktop Chrome or Edge, and make sure the page isn't opened from a file:// path."
      );
      disablePicker("Unsupported browser, see the message above.");
    }, 5000);
    return false;
  }
  if (!/Chrome|Edg\//.test(navigator.userAgent)) {
    showCompatError("transcribr-web is tested on desktop Chrome and Edge. It may not work correctly in this browser.");
  }
  return true;
}

// ---- Engines -------------------------------------------------------------

class Engine {
  constructor(script, name) {
    this.script = script;
    this.name = name;
    this.worker = null;
    this.loading = null;
    this.pending = null;
  }

  spawn() {
    this.worker = new Worker(this.script, { name: this.name });
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

  load(manifest, onProgress) {
    if (!this.loading) {
      this.spawn();
      this.loading = this.request({ type: "load", manifest, version: manifest.version }, [], onProgress).catch((err) => {
        this.crash(err);
        throw err;
      });
    }
    return this.loading;
  }
}

const whisper = new Engine("engines/whisper-worker.js", "whisper engine");
const sherpa = new Engine("engines/sherpa-worker.js", "diarization engine");
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
    const res = await fetch("engines/manifest.json");
    if (!res.ok) throw new Error(`download failed (HTTP ${res.status}): engines/manifest.json`);
    manifest = await res.json();
    pruneOldEngineCaches(manifest.version);
  }
  return manifest;
}

function updateModelHint(m) {
  const model = m.whisper.models.find((x) => x.id === modelSelect.value) || m.whisper.models.find((x) => x.default);
  modelHint.textContent = model && model.hardware ? "Recommended: " + model.hardware : "";
}

function fillModelPicker(m) {
  if (!modelSelect.options.length) {
    for (const model of m.whisper.models) {
      const opt = new Option(model.label, model.id, false, Boolean(model.default));
      modelSelect.add(opt);
    }
    modelSelect.addEventListener("change", () => updateModelHint(m));
  }
  updateModelHint(m);
}

async function ensureEngines() {
  fillModelPicker(await loadManifest());
  if (sherpa.loading && whisper.loading) {
    // Already loaded by an earlier job (jobs run one at a time).
    await Promise.all([sherpa.loading, whisper.loading]);
    return;
  }
  engineBanner.hidden = false;
  engineStatus.textContent = "Loading engines...";
  engineProgress.hidden = true;
  try {
    // One at a time so the banner shows a single, meaningful progress bar.
    await sherpa.load(manifest, showEngineProgress);
    await whisper.load(manifest, showEngineProgress);
  } catch (err) {
    engineStatus.textContent = "Loading the engines failed: " + err.message;
    engineProgress.hidden = true;
    throw err;
  }
  engineBanner.hidden = true;
}

// ---- Jobs ----------------------------------------------------------------

const queue = [];
let running = false;

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

function speakerHue(index) {
  return String((index * 137 + 210) % 360);
}

function updateDoneStatus(job) {
  if (job.status !== "done") return;
  const n = speakerCount(job.rows);
  setStatus(job, job.rows.length ? `Done: ${n} speaker${n === 1 ? "" : "s"}, ${fmtClock(job.durationSec)} long` : "Done: no speech found");
}

/// One text box per detected speaker; names flow into the transcript view
/// and every export.
function renderSpeakerNames(job) {
  const container = job.el.querySelector(".job-speakers");
  container.replaceChildren();
  const originals = [...new Set(job.rows.map((r) => r.speaker_id))].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true })
  );
  if (!originals.length) return;
  container.append("Rename speakers:");
  originals.forEach((orig, i) => {
    const label = document.createElement("label");
    label.style.setProperty("--hue", speakerHue(i));
    label.textContent = orig;
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = orig;
    input.dataset.speaker = orig;
    input.value = job.names[orig] || "";
    input.addEventListener("input", () => {
      job.names[orig] = input.value;
      renderTranscript(job);
    });
    label.append(input);
    container.append(label);
  });
  container.hidden = false;
}

function renderTranscript(job) {
  if (job.editing) return renderTranscriptEdit(job);
  const container = job.el.querySelector(".job-transcript");
  container.replaceChildren();
  const rows = renameSpeakers(job.rows, job.names);
  const speakers = [...new Set(rows.map((r) => r.speaker_id))];
  for (const turn of toTurns(rows)) {
    const p = document.createElement("p");
    p.className = "turn";
    p.style.setProperty("--hue", speakerHue(speakers.indexOf(turn.speaker_id)));
    const who = document.createElement("span");
    who.className = "turn-speaker";
    who.textContent = turn.speaker_id;
    const when = document.createElement("span");
    when.className = "turn-time";
    when.textContent = `${fmtClock(turn.timestamp_start)}-${fmtClock(turn.timestamp_end)}`;
    const text = document.createElement("span");
    text.className = "turn-text";
    text.textContent = turn.transcribed_text;
    p.append(who, when, text);
    container.append(p);
  }
  container.hidden = false;
}

/// Row-level edit view: reassign a sentence's speaker (this is how you
/// "merge" it into a neighboring turn -- toTurns collapses consecutive
/// same-speaker rows back together once they agree) and fix up its text.
/// Edits write straight into job.rows, which every export already reads
/// fresh at download time.
function renderTranscriptEdit(job) {
  const container = job.el.querySelector(".job-transcript");
  container.replaceChildren();
  const originals = [...new Set(job.rows.map((r) => r.speaker_id))];
  job.rows.forEach((row, i) => {
    const line = document.createElement("div");
    line.className = "edit-row";
    line.style.setProperty("--hue", speakerHue(originals.indexOf(row.speaker_id)));

    const select = document.createElement("select");
    select.className = "edit-row-speaker";
    for (const orig of originals) {
      select.add(new Option(job.names[orig] || orig, orig, false, orig === row.speaker_id));
    }
    select.addEventListener("change", () => {
      row.speaker_id = select.value;
      updateDoneStatus(job);
      renderSpeakerNames(job);
      renderTranscript(job);
    });

    const when = document.createElement("span");
    when.className = "turn-time edit-row-time";
    when.textContent = `${fmtClock(row.timestamp_start)}-${fmtClock(row.timestamp_end)}`;

    const text = document.createElement("textarea");
    text.className = "edit-row-text";
    text.rows = 1;
    text.value = row.transcribed_text;
    const resize = () => {
      text.style.height = "auto";
      text.style.height = text.scrollHeight + "px";
    };
    text.addEventListener("input", () => {
      row.transcribed_text = text.value;
      resize();
    });

    line.append(select, when, text);
    container.append(line);
    resize();
  });
  container.hidden = false;
}

function finishJob(job) {
  job.status = "done";
  updateDoneStatus(job);
  job.el.dataset.status = "done";

  const exportsEl = job.el.querySelector(".job-exports");
  exportsEl.hidden = false;
  const baseName = job.name.replace(/\.[^.]+$/, "");
  const rows = () => renameSpeakers(job.rows, job.names);
  exportsEl.querySelector(".export-csv").onclick = () => downloadCsv(rows(), `${baseName}_transcript.csv`);
  exportsEl.querySelector(".export-json").onclick = () =>
    downloadJson(job.name, job.durationSec, rows(), { model: job.model, translated: job.translate }, `${baseName}_transcript.json`);
  exportsEl.querySelector(".export-srt").onclick = () => downloadSrt(rows(), `${baseName}_transcript.srt`);
  exportsEl.querySelector(".export-docx").onclick = () => downloadDocx(baseName, rows(), `${baseName}_transcript.docx`);

  const editToggle = job.el.querySelector(".job-edit-toggle");
  editToggle.hidden = !job.rows.length;
  editToggle.onclick = () => {
    job.editing = !job.editing;
    editToggle.textContent = job.editing ? "Done editing" : "Edit transcript";
    renderTranscript(job);
  };

  renderSpeakerNames(job);
  renderTranscript(job);
}

function failJob(job, message) {
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
    warn.querySelector(".skip").onclick = () => { warn.remove(); resolve(false); };
  });
}

async function processJob(job) {
  job.status = "processing";
  job.el.dataset.status = "processing";
  const language = languageInput.value.trim().toLowerCase() || "auto";
  if (!/^(auto|[a-z]{2,3})$/.test(language)) {
    throw new Error(`"${languageInput.value}" is not a language code; use a code like en or nl, or leave it blank`);
  }

  setStatus(job, "Decoding audio");
  let decoded;
  try {
    decoded = await decodeFileTo16kMono(job.file);
  } catch (err) {
    throw new Error("could not decode this file: " + ((err && err.message) || err));
  }
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
  await ensureEngines();

  setStatus(job, "Detecting speakers");
  const numSpeakers = Math.max(0, parseInt(numSpeakersInput.value, 10) || 0);
  // Posted as a copy: the same samples go to whisper next.
  const diar = await sherpa.request({ type: "diarize", samples, numSpeakers });
  const dsegs = diar.segments.map((s) => ({ s: s.start, e: s.end, spk: s.speaker }));

  const model = manifest.whisper.models.find((m) => m.id === modelSelect.value) || manifest.whisper.models.find((m) => m.default);
  job.model = model.name;
  job.translate = translateInput.checked;
  setStatus(job, "Transcribing");
  const tr = await whisper.request(
    { type: "transcribe", samples, language, translate: job.translate, modelUrl: model.url },
    [samples.buffer],
    (p) => {
      if (p.label) {
        setStatus(job, `Downloading ${p.label}`, p.total ? p.loaded / p.total : undefined);
      } else if (p.started) {
        setStatus(job, "Transcribing");
      } else {
        setStatus(job, "Transcribing", p.fraction);
      }
    }
  );

  job.rows = assignSpeakers(tr.segments, dsegs);
  finishJob(job);
}

async function runQueue() {
  if (running) return;
  running = true;
  while (queue.length) {
    const job = queue.shift();
    try {
      await processJob(job);
    } catch (err) {
      failJob(job, String((err && err.message) || err));
    }
  }
  running = false;
}

function enqueue(job) {
  job.status = "queued";
  job.el.dataset.status = "queued";
  setStatus(job, "Queued");
  queue.push(job);
  runQueue();
}

function addJob(file) {
  const li = document.createElement("li");
  li.className = "job";
  li.innerHTML = `
    <div class="job-name"></div>
    <div class="job-status"></div>
    <progress class="job-progress" max="1" value="0" hidden></progress>
    <div class="job-error"></div>
    <button class="btn btn-sm job-retry" hidden>Retry</button>
    <div class="job-exports" hidden>
      <span class="job-exports-label">Download:</span>
      <button class="btn btn-sm export-csv">CSV</button>
      <button class="btn btn-sm export-json">JSON</button>
      <button class="btn btn-sm export-srt">SRT</button>
      <button class="btn btn-sm export-docx">DOCX</button>
      <button class="btn btn-sm btn-ghost job-edit-toggle" hidden>Edit transcript</button>
    </div>
    <div class="job-speakers" hidden></div>
    <div class="job-transcript" hidden></div>
  `;
  li.querySelector(".job-name").textContent = file.name;
  jobList.appendChild(li);
  const job = { name: file.name, file, el: li, rows: [], names: {}, durationSec: 0, editing: false };
  enqueue(job);
}

function queueFiles(fileList) {
  if (fileInput.disabled) return;
  for (const file of Array.from(fileList)) addJob(file);
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

if (checkCompat()) {
  engineBanner.hidden = false;
  engineStatus.textContent =
    "The first file you add downloads the transcription and speaker engines (about 320 MB with the standard model). They are cached for next time.";
}
loadManifest().then(fillModelPicker).catch(() => {}); // ensureEngines retries and reports

