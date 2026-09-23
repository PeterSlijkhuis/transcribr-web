import assert from "node:assert/strict";
import { test } from "node:test";
import { fmtClock, toTurns, speakerCount, renameSpeakers } from "../shared.js";

test("fmtClock formats mm:ss", () => {
  assert.equal(fmtClock(65), "01:05");
  assert.equal(fmtClock(0), "00:00");
});

test("toTurns collapses consecutive same-speaker rows", () => {
  const rows = [
    { speaker_id: "Speaker 1", timestamp_start: 0, timestamp_end: 1, transcribed_text: "hello" },
    { speaker_id: "Speaker 1", timestamp_start: 1, timestamp_end: 2, transcribed_text: "world" },
    { speaker_id: "Speaker 2", timestamp_start: 2, timestamp_end: 3, transcribed_text: "hi" },
  ];
  const turns = toTurns(rows);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].transcribed_text, "hello world");
  assert.equal(turns[0].timestamp_end, 2);
  assert.equal(turns[1].speaker_id, "Speaker 2");
});

test("speakerCount counts distinct speakers", () => {
  const rows = [{ speaker_id: "Speaker 1" }, { speaker_id: "Speaker 1" }, { speaker_id: "Speaker 2" }];
  assert.equal(speakerCount(rows), 2);
});

test("renameSpeakers maps labels, keeps blanks, and lets toTurns merge speakers given one name", () => {
  const rows = [
    { speaker_id: "Speaker 1", timestamp_start: 0, timestamp_end: 1, transcribed_text: "a" },
    { speaker_id: "Speaker 2", timestamp_start: 1, timestamp_end: 2, transcribed_text: "b" },
    { speaker_id: "Speaker 3", timestamp_start: 2, timestamp_end: 3, transcribed_text: "c" },
  ];
  const renamed = renameSpeakers(rows, { "Speaker 1": " Interviewer ", "Speaker 2": "  " , "Speaker 3": "Speaker 2" });
  assert.deepEqual(renamed.map((r) => r.speaker_id), ["Interviewer", "Speaker 2", "Speaker 2"]);
  assert.equal(rows[0].speaker_id, "Speaker 1"); // input untouched
  assert.equal(toTurns(renamed).length, 2);
});
