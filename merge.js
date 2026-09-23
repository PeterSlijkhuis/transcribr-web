// merge.js -- combine diarization turns with whisper segments into
// speaker-labeled rows. Ported from Wisprflow's src/Main/Merge.fs (the same
// max-overlap speaker-assignment algorithm the desktop app uses).
// whisper.wasm's embind API has no equivalent to whisper-cli's -ml/-sow
// segment-length cap, so splitAtBoundaries is the only mechanism
// apportioning a longer whisper segment across a speaker change inside it.

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
    const idx = Math.max(startI + 1, Math.min(tokens.length - 1, raw));
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
  return split.map((w) => ({
    speaker_id: `Speaker ${numberOf(speakerOf(w))}`,
    timestamp_start: round3(w.t0),
    timestamp_end: round3(w.t1),
    transcribed_text: w.text.trim(),
  }));
}
