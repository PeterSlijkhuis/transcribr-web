// export/json.js
import { triggerDownload } from "./download.js";
import { toTurns, speakerCount } from "../shared.js";

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
