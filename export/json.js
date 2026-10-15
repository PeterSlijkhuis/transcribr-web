// export/json.js
import { triggerDownload } from "./download.js";
import { toTurns, speakerCount } from "../shared.js";

/// meta: {model, translated} describing how the transcript was produced.
export function toJsonString(sourceFileName, durationSec, rows, meta = {}) {
  const model = meta.model || "ggml-base";
  const payload = {
    source_file: sourceFileName,
    duration_sec: durationSec,
    // GPU jobs name the ONNX repo, e.g. "onnx-community/whisper-small (GPU)".
    whisper_model: model.endsWith("(GPU)") ? `Transformers.js ${model}` : `whisper.cpp ${model} (wasm)`,
    translated_to_english: Boolean(meta.translated),
    diarization: "sherpa-onnx (pyannote segmentation-3.0 + TitaNet embedding)",
    generated_at: new Date().toISOString(),
    speaker_count: speakerCount(rows),
    segments: rows,
    turns: toTurns(rows),
  };
  return JSON.stringify(payload, null, 2);
}

export function downloadJson(sourceFileName, durationSec, rows, meta, filename) {
  triggerDownload(new Blob([toJsonString(sourceFileName, durationSec, rows, meta)], { type: "application/json" }), filename);
}
