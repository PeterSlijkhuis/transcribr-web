import assert from "node:assert/strict";
import { test } from "node:test";
import { assignSpeakers, regroupSentences, splitAtBoundaries } from "../merge.js";

test("assignSpeakers assigns by max overlap", () => {
  const wsegs = [
    { t0: 0, t1: 2, text: "hello there" },
    { t0: 2, t1: 4, text: "general kenobi" },
  ];
  const dsegs = [
    { s: 0, e: 2.1, spk: 0 },
    { s: 2.1, e: 5, spk: 1 },
  ];
  const rows = assignSpeakers(wsegs, dsegs);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].speaker_id, "Speaker 1");
  assert.equal(rows[1].speaker_id, "Speaker 2");
});

test("assignSpeakers falls back to nearest midpoint with no overlap, ties favor the first segment", () => {
  const rows = assignSpeakers(
    [{ t0: 10, t1: 11, text: "hi" }],
    [
      { s: 0, e: 1, spk: 0 },
      { s: 20, e: 21, spk: 1 },
    ]
  );
  assert.equal(rows[0].speaker_id, "Speaker 1");
});

test("assignSpeakers with no diarization segments assigns everything to Speaker 1", () => {
  const rows = assignSpeakers([{ t0: 0, t1: 1, text: "solo" }], []);
  assert.equal(rows[0].speaker_id, "Speaker 1");
});

test("splitAtBoundaries cuts a long segment at a speaker change inside it", () => {
  const w = { t0: 0, t1: 4, text: "one two three four" };
  const dsegs = [
    { s: 0, e: 1.9, spk: 0 },
    { s: 2.1, e: 4, spk: 1 },
  ];
  const pieces = splitAtBoundaries(dsegs, w);
  assert.deepEqual(pieces.map((p) => p.text), ["one two", "three four"]);
  const rows = assignSpeakers([w], dsegs);
  assert.deepEqual(rows.map((r) => r.speaker_id), ["Speaker 1", "Speaker 2"]);
});

test("splitAtBoundaries never emits an empty piece", () => {
  const w = { t0: 0, t1: 3, text: "a b" };
  const dsegs = [
    { s: 0, e: 0.9, spk: 0 },
    { s: 1.1, e: 1.9, spk: 1 },
    { s: 2.0, e: 3, spk: 0 },
  ];
  for (const p of splitAtBoundaries(dsegs, w)) assert.notEqual(p.text, "");
});

test("assignSpeakers numbers speakers by first appearance, whatever the cluster ids", () => {
  const rows = assignSpeakers(
    [
      { t0: 0, t1: 1, text: "a" },
      { t0: 1, t1: 2, text: "b" },
      { t0: 2, t1: 3, text: "c" },
    ],
    [
      { s: 0, e: 1, spk: 2 },
      { s: 1, e: 2, spk: 1 },
      { s: 2, e: 3, spk: 2 },
    ]
  );
  assert.deepEqual(rows.map((r) => r.speaker_id), ["Speaker 1", "Speaker 2", "Speaker 1"]);
});

test("splitAtBoundaries snaps a cut to the nearest sentence end", () => {
  // Time alone would cut after "you" (word 3 of 8); the sentence ends one word later.
  const w = { t0: 0, t1: 4, text: "how are you today? fine thanks, and you" };
  const dsegs = [
    { s: 0, e: 1.4, spk: 0 },
    { s: 1.6, e: 4, spk: 1 },
  ];
  assert.deepEqual(splitAtBoundaries(dsegs, w).map((p) => p.text), ["how are you today?", "fine thanks, and you"]);
});

test("splitAtBoundaries falls back to a comma, then to the time estimate", () => {
  const dsegs = [
    { s: 0, e: 1.9, spk: 0 },
    { s: 2.1, e: 4, spk: 1 },
  ];
  const comma = { t0: 0, t1: 4, text: "well I think, that we should go" };
  assert.deepEqual(splitAtBoundaries(dsegs, comma).map((p) => p.text), ["well I think,", "that we should go"]);
  const bare = { t0: 0, t1: 4, text: "one two three four" };
  assert.deepEqual(splitAtBoundaries(dsegs, bare).map((p) => p.text), ["one two", "three four"]);
});

test("regroupSentences re-cuts whisper segments at sentence ends, per speaker", () => {
  const rows = regroupSentences([
    { spk: 0, t0: 0, t1: 4, text: "So I went to the" },
    { spk: 0, t0: 4, t1: 8, text: "store. It was closed, so" },
    { spk: 0, t0: 8, t1: 10, text: "I left." },
    { spk: 1, t0: 10, t1: 12, text: "Really? Why" },
    { spk: 0, t0: 12, t1: 13, text: "Yes" },
  ]);
  assert.deepEqual(
    rows.map((r) => [r.spk, r.text]),
    [
      [0, "So I went to the store."],
      [0, "It was closed, so I left."],
      [1, "Really?"],
      [1, "Why"],
      [0, "Yes"],
    ]
  );
  assert.deepEqual([rows[0].t0, rows[0].t1], [0, 4.8]);
  assert.equal(rows[1].t0, 4.8);
});

test("regroupSentences breaks an unpunctuated run at a segment end after 30 s", () => {
  const segs = Array.from({ length: 10 }, (_, i) => ({ spk: 0, t0: i * 5, t1: i * 5 + 5, text: "and then" }));
  const rows = regroupSentences(segs);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].t0, 35);
});
