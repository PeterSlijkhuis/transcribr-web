import assert from "node:assert/strict";
import { test } from "node:test";
import { newFiles, newerVersion, changedModels } from "../scripts/check-models.mjs";

test("newFiles lists only files the known list lacks", () => {
  assert.deepEqual(newFiles(["a.bin", "b.bin", "c.bin"], ["a.bin", "c.bin"]), ["b.bin"]);
  assert.deepEqual(newFiles(["a.bin"], ["a.bin", "gone.bin"]), []);
});

test("changedModels reports a changed hash, and only records a file seen for the first time", () => {
  const seen = { "a.bin": "new", "b.bin": "same", "c.bin": "first" };
  assert.deepEqual(changedModels(seen, { "a.bin": "old", "b.bin": "same" }), [{ file: "a.bin", sha: "new" }]);
  assert.deepEqual(changedModels(seen, {}), []);
});

test("newerVersion compares dotted versions numerically", () => {
  assert.equal(newerVersion("1.13.9", "1.13.8"), true);
  assert.equal(newerVersion("1.13.10", "1.13.9"), true);
  assert.equal(newerVersion("1.13.8", "1.13.8"), false);
  assert.equal(newerVersion("1.9", "1.13.8"), false);
  assert.equal(newerVersion("2", "1.13.8"), true);
});

test("latestMajor picks the highest vN tag and ignores the rest", async () => {
  const { latestMajor } = await import("../scripts/update-actions.mjs");
  assert.equal(latestMajor(["v1", "v4", "v10", "v4.2.1", "main", "v9-beta"]), 10);
  assert.equal(latestMajor(["main", "v1.2.3"]), null);
});
