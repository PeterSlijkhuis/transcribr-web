// test/e2e.mjs -- full end-to-end check: loads the real app in Chromium,
// feeds both fixture files through the real file input, and asserts that
// the single-speaker file's transcript contains the expected words, the
// two-speaker file comes back with two speakers, and all four exports
// download with the right structure (including a renamed speaker). Then it
// switches to the "small" model and transcribes the single-speaker file
// again, to cover model switching and the quantized models. Nothing is mocked: the engines come
// from the Hugging Face URLs in engines/manifest.json. A persistent browser
// profile keeps the ~275MB engine download in Cache Storage between runs
// (CI caches .playwright-profile-<browser>/ keyed on the manifest).
//
// BROWSER=chromium|firefox|webkit picks the engine (webkit is Safari's).
// The server sends no COOP/COEP headers, like GitHub Pages, so the page
// only works if coi-serviceworker.js isolates it, as in production.
import { chromium, firefox, webkit } from "playwright";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";
import { startServer } from "./serve.mjs";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = path.join(repoRoot, "engines-build", "fixtures");
const expected = JSON.parse(readFileSync(path.join(fixtures, "expected-words.json"), "utf8"));
const PORT = 8090;
const JOB_TIMEOUT_MS = Number(process.env.E2E_JOB_TIMEOUT_MS) || 15 * 60_000;

async function readDownload(download) {
  const chunks = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function waitForJobs(page, count) {
  // Log every change, so a failure shows which step it happened in.
  let last = "";
  const statusLog = setInterval(async () => {
    const s = await page.$$eval(".job", (els) => els.map((e) => `${e.dataset.status}: ${e.querySelector(".job-status").textContent}`)).catch(() => []);
    const banner = await page.textContent("#engine-status").catch(() => "");
    const line = `${s.join(" | ")} | ${banner}`.replace(/\d+%|\d+ of \d+ MB|\d+ MB|\d\d:\d\d so far/g, "#");
    if (line !== last) console.log("[status]", s.join(" | "), "|", banner);
    last = line;
  }, 1_000);
  try {
    await page.waitForFunction(
      (n) => {
        const jobs = [...document.querySelectorAll(".job")];
        return jobs.length === n && jobs.every((j) => j.dataset.status === "done" || j.dataset.status === "error");
      },
      count,
      { timeout: JOB_TIMEOUT_MS, polling: 1000 }
    );
  } finally {
    clearInterval(statusLog);
  }
}

async function assertNoErrors(page) {
  const errors = await page.$$eval(".job-error", (els) => els.map((e) => e.textContent).filter(Boolean));
  assert.deepEqual(errors, [], "jobs failed");
}

const browserName = process.env.BROWSER || "chromium";
const browserType = { chromium, firefox, webkit }[browserName];
process.env.PAGES = "1";
const server = await startServer(PORT);
const profileDir = path.join(repoRoot, `.playwright-profile-${browserName}`);
if (!existsSync(profileDir)) mkdirSync(profileDir, { recursive: true });
const context = await browserType.launchPersistentContext(profileDir, { headless: true, acceptDownloads: true });

try {
  const page = await context.newPage();
  page.on("console", (msg) => console.log("[page]", msg.text()));
  page.on("pageerror", (err) => console.log("[pageerror]", err.message));
  await page.goto(`http://localhost:${PORT}/index.html`);
  // The service worker reloads the page once to isolate it.
  await page.waitForFunction(() => self.crossOriginIsolated === true, null, { timeout: 15_000 });

  // The optional waiting-room game: doesn't touch transcription state, so
  // check it in isolation before anything else runs.
  await page.click("#game-toggle");
  assert.equal(await page.getAttribute("#flappy-canvas", "hidden"), null, "game canvas did not open");
  await page.click("#flappy-canvas"); // flap once, just to exercise the input handler
  await page.click("#game-toggle");
  assert.notEqual(await page.getAttribute("#flappy-canvas", "hidden"), null, "game canvas did not close");

  // The verified engine harness ran diarization with 2 clusters; the
  // fixtures are synthesized TTS voices, so pin the count rather than rely
  // on the auto-detect threshold for them.
  await page.fill("#num-speakers", String(expected.twoSpeaker.expectedSpeakerCount));
  await page.selectOption("#language", "en");
  await page.setInputFiles("#file-input", [
    path.join(fixtures, expected.singleSpeaker.file),
    path.join(fixtures, expected.twoSpeaker.file),
  ]);

  // Adding files should fold the File options panel out of the way (it's still
  // reachable, just not auto-folded twice).
  assert.equal(await page.getAttribute('[aria-controls="settings-body"]', "aria-expanded"), "false", "settings panel did not auto-fold");

  await waitForJobs(page, 2);

  const jobs = await page.$$(".job");
  await assertNoErrors(page);

  // single-speaker.wav: expected words present, one speaker.
  const single = (await jobs[0].$eval(".job-transcript", (e) => e.textContent)).toLowerCase();
  for (const w of expected.singleSpeaker.words) assert.ok(single.includes(w.toLowerCase()), `missing "${w}" in: ${single}`);

  // two-speaker.wav: expected speaker count.
  const speakers = await jobs[1].$$eval(".turn-speaker", (els) => [...new Set(els.map((e) => e.textContent))]);
  assert.equal(speakers.length, expected.twoSpeaker.expectedSpeakerCount, `speakers: ${speakers.join(", ")}`);

  // Only one job's result panel is expanded at a time; open job 2's before
  // interacting with anything inside it.
  await page.click(".job:nth-child(2) .job-view-toggle");
  assert.equal(await page.getAttribute(".job:nth-child(2) .job-result", "data-collapsed"), null, "job 2's result did not open");

  // Rename the first listed speaker (labels depend on diarization's cluster
  // ids, so don't assume which exist); the exports below must carry it.
  const renameInput = page.locator(".job:nth-child(2) .job-speakers input").first();
  const renamedFrom = await renameInput.getAttribute("data-speaker");
  console.log("speakers:", speakers.join(", "), "| renaming", renamedFrom);
  await renameInput.fill("Interviewer");

  // Exports, from the two-speaker job.
  const grab = async (cls, nth = 2) => {
    const [download] = await Promise.all([page.waitForEvent("download"), page.click(`.job:nth-child(${nth}) ${cls}`)]);
    return readDownload(download);
  };
  const csv = (await grab(".export-csv")).toString("utf8");
  assert.match(csv, /^speaker_id,timestamp_start,timestamp_end,transcribed_text\n/);
  assert.ok(csv.trim().split("\n").length >= 3, "CSV has fewer than 2 data rows");
  assert.match(csv, /\nInterviewer,/, "renamed speaker missing from CSV");
  const json = JSON.parse((await grab(".export-json")).toString("utf8"));
  assert.equal(json.speaker_count, expected.twoSpeaker.expectedSpeakerCount);
  const srt = (await grab(".export-srt")).toString("utf8");
  assert.match(srt, /^1\r\n\d\d:\d\d:\d\d,\d\d\d --> \d\d:\d\d:\d\d,\d\d\d\r\n(Speaker \d+|Interviewer): /);
  const docx = await grab(".export-docx");
  assert.equal(docx.subarray(0, 2).toString("latin1"), "PK");
  assert.ok(docx.includes(Buffer.from("word/document.xml")), "DOCX lacks word/document.xml");

  // Edit transcript: reassign the first row's speaker (this is how a user
  // "merges" a sentence into a neighboring turn) and tweak its text; both
  // must show up in a re-export without re-processing the file.
  await page.click(".job:nth-child(2) .job-edit-toggle");
  const editRows = page.locator(".job:nth-child(2) .edit-row");
  assert.ok((await editRows.count()) > 0, "no editable rows rendered");
  const firstSelect = editRows.first().locator(".edit-row-speaker");
  assert.equal(await firstSelect.locator("option").count(), speakers.length, "speaker select option count");
  const secondOption = firstSelect.locator("option").nth(1);
  const targetValue = await secondOption.getAttribute("value");
  const targetLabel = await secondOption.textContent();
  await firstSelect.selectOption(targetValue);
  const firstText = editRows.first().locator(".edit-row-text");
  await firstText.fill((await firstText.inputValue()) + " EDITEDMARK");
  await page.click(".job:nth-child(2) .job-edit-toggle"); // Done editing

  const editedCsv = (await grab(".export-csv")).toString("utf8");
  const editedLine = editedCsv.split("\n").find((l) => l.includes("EDITEDMARK"));
  assert.ok(editedLine, "edited row missing from re-exported CSV");
  assert.ok(editedLine.startsWith(`${targetLabel},`), `edited row not reassigned to "${targetLabel}": ${editedLine}`);

  // Speaker add/remove and row merge/split, back in edit mode. Read the
  // current speaker count fresh rather than reusing `speakers` from
  // earlier: the reassignment above may have consolidated every row onto
  // one speaker if the fixture only had one row per original speaker.
  await page.click(".job:nth-child(2) .job-edit-toggle");
  const speakerChips = page.locator(".job:nth-child(2) .job-speakers label");
  const chipsBefore = await speakerChips.count();
  const rowOptionsBefore = await editRows.first().locator(".edit-row-speaker option").count();
  await page.locator(".job:nth-child(2) .job-speakers button", { hasText: "Add speaker" }).click();
  assert.equal(await speakerChips.count(), chipsBefore + 1, "add speaker did not add a chip");
  assert.equal(
    await editRows.first().locator(".edit-row-speaker option").count(),
    rowOptionsBefore + 1,
    "new speaker missing from a row's speaker picker"
  );
  // It has no rows yet, so removing it again should just drop the chip.
  await page.locator(".job:nth-child(2) .job-speakers .speaker-remove").last().click();
  assert.equal(await speakerChips.count(), chipsBefore, "remove speaker did not remove the chip");

  const rowsBeforeMerge = await editRows.count();
  if (rowsBeforeMerge > 1) {
    const firstTextBefore = await editRows.first().locator(".edit-row-text").inputValue();
    await editRows.first().locator("button", { hasText: "Merge with next" }).click();
    assert.equal(await editRows.count(), rowsBeforeMerge - 1, "merge did not reduce the row count");
    const mergedText = await editRows.first().locator(".edit-row-text").inputValue();
    assert.ok(mergedText.startsWith(firstTextBefore), "merged row lost its original text");

    // Split it back apart at roughly the midpoint.
    const mergedTextarea = editRows.first().locator(".edit-row-text");
    await mergedTextarea.click();
    await mergedTextarea.evaluate((el, mid) => el.setSelectionRange(mid, mid), Math.floor(mergedText.length / 2));
    await editRows.first().locator("button", { hasText: "Split at cursor" }).click();
    assert.equal(await editRows.count(), rowsBeforeMerge, "split did not add a row back");
  }
  await page.click(".job:nth-child(2) .job-edit-toggle"); // Done editing

  // Same file again with Accurate (large-v3-turbo on the CPU), to exercise
  // the model-swap path in engines/whisper-worker.js (ensureModel only
  // reloads when the URL actually changes from the default). The model
  // picker lives in the Settings dialog. It's queued twice and the second
  // copy removed while it waits, which must leave three jobs.
  await page.click("#settings-open");
  await page.selectOption("#model", "medium");
  await page.click("#settings-dialog .btn");
  const singleFile = path.join(fixtures, expected.singleSpeaker.file);
  await page.setInputFiles("#file-input", [singleFile, singleFile]);
  await page.click(".job:nth-child(4) .job-remove");
  const accurateStart = Date.now();
  await waitForJobs(page, 3);
  console.log(`Accurate (CPU) job took ${((Date.now() - accurateStart) / 1000).toFixed(0)} s, model download included`);
  await assertNoErrors(page);
  const third = await page.$(".job:nth-child(3)");
  assert.match(await third.$eval(".job-status", (e) => e.textContent), /^Done/);
  const accurate = (await third.$eval(".job-transcript", (e) => e.textContent)).toLowerCase();
  for (const w of expected.singleSpeaker.words) assert.ok(accurate.includes(w.toLowerCase()), `Accurate model: missing "${w}" in: ${accurate}`);
  const accurateJson = JSON.parse((await grab(".export-json", 3)).toString("utf8"));
  assert.equal(accurateJson.whisper_model, "whisper.cpp ggml-large-v3-turbo-q5_0 (wasm)");

  console.log(`PASS (${browserName}): expected words found (small and large-v3-turbo); ${speakers.length} speakers; renamed speaker in exports; CSV/JSON/SRT/DOCX valid`);
} catch (err) {
  // Leave enough in the CI log to diagnose without a rerun.
  const html = await context.pages()[0]?.innerHTML("#job-list").catch(() => "(page gone)");
  console.log("[job-list at failure]", html);
  throw err;
} finally {
  await context.close();
  server.close();
}
