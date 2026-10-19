// merge.js -- combine diarization turns with whisper segments into
// speaker-labeled rows. Ported from Wisprflow's src/Main/Merge.fs (the same
// max-overlap speaker-assignment algorithm the desktop app uses).
// whisper.wasm's embind API has no equivalent to whisper-cli's -ml/-sow
// segment-length cap, so splitAtBoundaries is the only mechanism
// apportioning a longer whisper segment across a speaker change inside it.
// It has no word timestamps either, so a cut's word position is estimated
// from time (evenly spaced words) and then snapped to nearby punctuation.

const SENTENCE_END = /[.?!\u2026\u3002\uff1f\uff01]["')\]]*$/;
const CLAUSE_END = /[,;:\u2014-]["')\]]*$/;
const SNAP_SEC = 1.5;
// A sentence with no end punctuation in sight still gets a new line at the
// next whisper segment end once it runs this long.
const MAX_LINE_SEC = 30;

// The word index to cut before, given the time-estimated one: the nearest
// sentence end within SNAP_SEC of speech, else the nearest clause end, else
// the estimate. A speaker change inside a sentence is rare; the estimate's
// error (diarization's boundary plus uneven speaking rate) usually isn't.
// Limit: a fixed window. Word timestamps (token-level whisper output) would
// remove the guessing if the mid-sentence cuts persist.
function snapCut(tokens, idx, lo, hi, wordsPerSec) {
  const reach = Math.max(2, Math.round(SNAP_SEC * wordsPerSec));
  for (const re of [SENTENCE_END, CLAUSE_END]) {
    for (let d = 0; d <= reach; d++) {
      for (const k of [idx - d, idx + d]) {
        if (k >= lo && k <= hi && re.test(tokens[k - 1])) return k;
      }
    }
  }
  return idx;
}

// Whisper's segments end where its timestamp tokens fall (roughly every few
// seconds of audio), not at punctuation, so one row per segment cuts most
// sentences in half. Re-cut each same-speaker run at sentence ends instead.
// Word times are spread evenly inside their source segment, the same
// estimate splitAtBoundaries uses.
// ponytail: "Dr." or "e.g." ends a line; an abbreviation list fixes that
// if it shows up in practice.
export function regroupSentences(rows) {
  const out = [];
  let cur = null;
  const flush = () => {
    if (cur) out.push({ spk: cur.spk, t0: cur.t0, t1: cur.t1, text: cur.words.join(" ") });
    cur = null;
  };
  for (const r of rows) {
    if (cur && (cur.spk !== r.spk || r.t0 - cur.t0 > MAX_LINE_SEC)) flush();
    const words = r.text.trim().split(/\s+/).filter((t) => t !== "");
    const step = (r.t1 - r.t0) / Math.max(1, words.length);
    words.forEach((word, k) => {
      if (!cur) cur = { spk: r.spk, t0: r.t0 + step * k, words: [] };
      cur.words.push(word);
      cur.t1 = r.t0 + step * (k + 1);
      if (SENTENCE_END.test(word)) flush();
    });
  }
  flush();
  return out;
}

function round3(x) {
  return Math.round(x * 1000) / 1000;
}

export function splitAtBoundaries(dsegs, w) {
  const dur = w.t1 - w.t0;
  if (dsegs.length < 2 || dur <= 0.4) return [w];

  const boundaries = [];
  for (let i = 0; i < dsegs.length - 1; i++) {
    const a = dsegs[i], b = dsegs[i + 1];
    if (a.spk !== b.spk) {
      const cut = (a.e + b.s) / 2;
      if (cut > w.t0 + dur * 0.15 && cut < w.t1 - dur * 0.15) boundaries.push(cut);
    }
  }
  const uniqSorted = [...new Set(boundaries)].sort((a, b) => a - b);
  if (uniqSorted.length === 0) return [w];

  const tokens = w.text.trim().split(" ").filter((t) => t !== "");
  if (tokens.length < 2) return [w];

  const pieces = [];
  let startT = w.t0;
  let startI = 0;
  for (const b of uniqSorted) {
    const raw = Math.round((tokens.length * (b - w.t0)) / dur);
    const lo = startI + 1, hi = tokens.length - 1;
    const idx = snapCut(tokens, Math.max(lo, Math.min(hi, raw)), lo, hi, tokens.length / dur);
    if (idx > startI) {
      pieces.push({ t0: startT, t1: b, text: tokens.slice(startI, idx).join(" ") });
      startT = b;
      startI = idx;
    }
  }
  if (startI < tokens.length) {
    pieces.push({ t0: startT, t1: w.t1, text: tokens.slice(startI).join(" ") });
  }
  return pieces;
}

/// Assign each whisper segment the speaker whose diarization turn overlaps
/// it the most; fall back to the nearest-midpoint turn when there is no
/// overlap. Ties favor whichever diarization segment comes first.
export function assignSpeakers(wsegs, dsegs) {
  function speakerOf(w) {
    if (dsegs.length === 0) return 0;
    let best = dsegs[0];
    let bestOverlap = -Infinity;
    for (const d of dsegs) {
      const overlap = Math.max(0, Math.min(w.t1, d.e) - Math.max(w.t0, d.s));
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        best = d;
      }
    }
    if (bestOverlap > 0) return best.spk;
    const mid = (w.t0 + w.t1) / 2;
    let nearest = dsegs[0];
    let nearestDist = Infinity;
    for (const d of dsegs) {
      const dist = Math.abs((d.s + d.e) / 2 - mid);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = d;
      }
    }
    return nearest.spk;
  }

  const sorted = [...wsegs].sort((a, b) => a.t0 - b.t0);
  const split = sorted.flatMap((w) => splitAtBoundaries(dsegs, w));
  // Number speakers by first appearance in the transcript: diarization's
  // cluster ids can skip values (a cluster with no speech assigned), which
  // would otherwise show "Speaker 2" and "Speaker 3" with no "Speaker 1".
  const order = new Map();
  const numberOf = (spk) => {
    if (!order.has(spk)) order.set(spk, order.size + 1);
    return order.get(spk);
  };
  const lines = regroupSentences(split.map((w) => ({ ...w, spk: speakerOf(w) })));
  return lines.map((w) => ({
    speaker_id: `Speaker ${numberOf(w.spk)}`,
    timestamp_start: round3(w.t0),
    timestamp_end: round3(w.t1),
    transcribed_text: w.text.trim(),
  }));
}
