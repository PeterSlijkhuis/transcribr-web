// export/srt.js
import { triggerDownload } from "./download.js";

function srtTime(sec) {
  const totalMs = Math.round(Math.max(0, sec) * 1000);
  const h = Math.floor(totalMs / 3600000);
  const m = Math.floor((totalMs % 3600000) / 60000);
  const s = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
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
