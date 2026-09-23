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
