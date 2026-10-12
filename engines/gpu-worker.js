// engines/gpu-worker.js -- module worker that runs Whisper on the GPU via
// WebGPU, using Transformers.js and the ONNX exports on Hugging Face. Opt-in
// from Settings; whisper-worker.js stays the default because WebGPU isn't
// everywhere and on weak integrated graphics it can lose to the CPU.
//
// Same protocol as whisper-worker.js, except modelUrl is an ONNX repo id
// (manifest whisper.models[].onnx), an optional dtype rides along, and
// there is no per-segment progress.
import { pipeline } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js";

let asr = null;
let repo = null;

// fp32 encoder + 4-bit decoder: the dtypes the Transformers.js Whisper
// WebGPU examples use, and what bench.html measured. A tier can override
// them (manifest `onnxDtype`), e.g. large-v3-turbo's fp32 encoder is 2.5 GB.
const DTYPE = { encoder_model: "fp32", decoder_model_merged: "q4" };

async function ensureModel(id, dtype) {
  if (id === repo) return;
  if (asr) await asr.dispose();
  asr = null;
  repo = null;
  // The model is several files downloading at once; report their sum so
  // the bar moves forward instead of jumping between files.
  const files = {};
  asr = await pipeline("automatic-speech-recognition", id, {
    device: "webgpu",
    dtype: dtype || DTYPE,
    progress_callback: (p) => {
      if (p.status !== "progress" || !p.total) return;
      files[p.file] = p;
      const all = Object.values(files);
      self.postMessage({
        type: "progress",
        label: "GPU model",
        loaded: all.reduce((n, f) => n + f.loaded, 0),
        total: all.reduce((n, f) => n + f.total, 0),
      });
    },
  });
  repo = id;
}

// Same non-speech filter as whisper-worker.js: "[BLANK_AUDIO]", "(music)", "*laughs*".
function isNoise(text) {
  return text === "" || /^\[[^\]]*\]$/.test(text) || /^\([^)]*\)$/.test(text) || /^\*[^*]*\*$/.test(text);
}

async function transcribe(samples, language, translate, id, dtype) {
  await ensureModel(id, dtype);
  self.postMessage({ type: "progress", started: true });
  const out = await asr(samples, {
    chunk_length_s: 30,
    stride_length_s: 5,
    return_timestamps: true,
    task: translate ? "translate" : "transcribe",
    ...(language && language !== "auto" ? { language } : {}),
  });
  const end = samples.length / 16000;
  return (out.chunks || [])
    .map((c) => ({ t0: c.timestamp[0] ?? 0, t1: c.timestamp[1] ?? end, text: c.text.trim() }))
    .filter((s) => !isNoise(s.text));
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  try {
    if (msg.type === "load") {
      if (!(navigator.gpu && (await navigator.gpu.requestAdapter()))) throw new Error("this browser has no usable GPU (WebGPU)");
      self.postMessage({ type: "loaded" });
    } else if (msg.type === "transcribe") {
      self.postMessage({ type: "result", segments: await transcribe(msg.samples, msg.language, msg.translate, msg.modelUrl, msg.dtype) });
    }
  } catch (err) {
    self.postMessage({ type: "error", error: String((err && err.message) || err) });
  }
};
