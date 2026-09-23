import assert from "node:assert/strict";
import { test } from "node:test";
import { assignSpeakers, splitAtBoundaries } from "../merge.js";

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
