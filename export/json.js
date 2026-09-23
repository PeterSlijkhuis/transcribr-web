// export/json.js
import { triggerDownload } from "./download.js";
import { toTurns, speakerCount } from "../shared.js";

/// meta: {model, translated} describing how the transcript was produced.
export function toJsonString(sourceFileName, durationSec, rows, meta = {}) {
  const payload = {
    source_file: sourceFileName,
    duration_sec: durationSec,
    whisper_model: `whisper.cpp ${meta.model || "ggml-base"} (wasm)`,
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
