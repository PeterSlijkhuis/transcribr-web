import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { toCsv } from "../export/csv.js";
import { toSrt } from "../export/srt.js";
import { toJsonString } from "../export/json.js";
import { buildDocx } from "../export/docx.js";

const rows = [
  { speaker_id: "Speaker 1", timestamp_start: 0, timestamp_end: 1.5, transcribed_text: "hello, world" },
  { speaker_id: "Speaker 2", timestamp_start: 1.5, timestamp_end: 3, transcribed_text: 'she said "hi" & <left>' },
];

test("toCsv quotes fields containing commas and quotes", () => {
  const csv = toCsv(rows);
  assert.match(csv, /^speaker_id,timestamp_start,timestamp_end,transcribed_text\n/);
  assert.match(csv, /"hello, world"/);
  assert.match(csv, /"she said ""hi"" & <left>"/);
});

test("toSrt emits SRT cue format with speaker prefix", () => {
  const srt = toSrt(rows);
  assert.match(srt, /^1\r\n00:00:00,000 --> 00:00:01,500\r\nSpeaker 1: hello, world\r\n/);
});

test("toSrt never rounds milliseconds up to 1000", () => {
  const srt = toSrt([{ speaker_id: "Speaker 1", timestamp_start: 59.9996, timestamp_end: 3599.9999, transcribed_text: "x" }]);
  assert.match(srt, /00:01:00,000 --> 01:00:00,000/);
});

test("toJsonString includes segments, turns and speaker count", () => {
  const obj = JSON.parse(toJsonString("a.wav", 3, rows, { model: "ggml-small-q5_1", translated: true }));
  assert.equal(obj.speaker_count, 2);
  assert.equal(obj.whisper_model, "whisper.cpp ggml-small-q5_1 (wasm)");
  assert.equal(obj.translated_to_english, true);
  assert.equal(obj.segments.length, 2);
  assert.equal(obj.turns.length, 2);
});

test("buildDocx produces a ZIP that unzip accepts, with escaped text inside", () => {
  const bytes = buildDocx("Test", rows);
  const dir = mkdtempSync(path.join(tmpdir(), "docx-"));
  const file = path.join(dir, "t.docx");
  writeFileSync(file, bytes);
  const listing = execFileSync("unzip", ["-l", file]).toString();
  for (const name of ["[Content_Types].xml", "_rels/.rels", "word/document.xml"]) assert.ok(listing.includes(name), name);
  execFileSync("unzip", ["-tq", file]); // throws on CRC mismatch
  const doc = execFileSync("unzip", ["-p", file, "word/document.xml"]).toString();
  assert.match(doc, /she said &quot;hi&quot; &amp; &lt;left&gt;/);
});
