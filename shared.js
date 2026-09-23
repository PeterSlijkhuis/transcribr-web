// shared.js -- pure helpers used by the UI and the exporters. Ported from
// Wisprflow's src/Shared/Shared.fs (toTurns) and src/Main/Merge.fs
// (speakerCount).

/// mm:ss clock, used by the transcript view and the DOCX turn labels.
export function fmtClock(sec) {
  const s = Math.floor(sec);
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

/// Collapse consecutive same-speaker rows into conversational turns.
export function toTurns(rows) {
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

export function speakerCount(rows) {
  return new Set(rows.map((r) => r.speaker_id)).size;
}
