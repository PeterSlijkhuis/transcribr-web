// test/e2e.mjs -- full end-to-end check: loads the real app in Chromium,
// feeds both fixture files through the real file input, and asserts that
// the single-speaker file's transcript contains the expected words, the
// two-speaker file comes back with two speakers, and all four exports
// download with the right structure (including a renamed speaker). Then it
// switches to the "small" model and transcribes the single-speaker file
// again, to cover model switching and the quantized models. Nothing is mocked: the engines come
// from the Hugging Face URLs in engines/manifest.json. A persistent browser
// profile keeps the ~275MB engine download in Cache Storage between runs
// (CI caches .playwright-profile/ keyed on the manifest).
import { chromium } from "playwright";
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
  const statusLog = setInterval(async () => {
    const s = await page.$$eval(".job", (els) => els.map((e) => `${e.dataset.status}: ${e.querySelector(".job-status").textContent}`)).catch(() => []);
    const banner = await page.textContent("#engine-status").catch(() => "");
    console.log("[status]", s.join(" | "), "|", banner);
  }, 10_000);
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

// The transcript editor is a full-page view opened from a file's card.
async function openEditor(page, nth) {
  await page.click(`.job:nth-child(${nth}) .job-open`);
  await page.waitForSelector("#editor[open] .seg");
}

async function closeEditor(page) {
  await page.click("#editor .editor-back");
  await page.waitForFunction(() => !document.getElementById("editor").open);
}

const editorText = (page) => page.$$eval("#editor .seg-text", (els) => els.map((e) => e.value).join(" "));

async function assertNoErrors(page) {
  const errors = await page.$$eval(".job-error", (els) => els.map((e) => e.textContent).filter(Boolean));
  assert.deepEqual(errors, [], "jobs failed");
}

const server = await startServer(PORT);
const profileDir = path.join(repoRoot, ".playwright-profile");
if (!existsSync(profileDir)) mkdirSync(profileDir, { recursive: true });
const context = await chromium.launchPersistentContext(profileDir, { headless: true, acceptDownloads: true });

try {
  const page = await context.newPage();
  page.on("console", (msg) => console.log("[page]", msg.text()));
  page.on("pageerror", (err) => console.log("[pageerror]", err.message));
  await page.goto(`http://localhost:${PORT}/index.html`);
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
  await page.fill("#language", "en");
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

  // single-speaker.wav: expected words present.
  await openEditor(page, 1);
  const single = (await editorText(page)).toLowerCase();
  for (const w of expected.singleSpeaker.words) assert.ok(single.includes(w.toLowerCase()), `missing "${w}" in: ${single}`);
  await closeEditor(page);

  // two-speaker.wav: expected speaker count, from the editor's speaker list.
  await openEditor(page, 2);
  const speakers = await page.$$eval("#editor-speakers input", (els) => els.map((e) => e.dataset.speaker));
  assert.equal(speakers.length, expected.twoSpeaker.expectedSpeakerCount, `speakers: ${speakers.join(", ")}`);

  // Rename the first listed speaker (labels depend on diarization's cluster
  // ids, so don't assume which exist); the exports below must carry it.
  const renameInput = page.locator("#editor-speakers input").first();
  const renamedFrom = await renameInput.getAttribute("data-speaker");
  console.log("speakers:", speakers.join(", "), "| renaming", renamedFrom);
  await renameInput.fill("Interviewer");

  // Exports, from the editor's Download menu.
  const grab = async (cls) => {
    await page.click("#editor .menu summary");
    const [download] = await Promise.all([page.waitForEvent("download"), page.click(`#editor ${cls}`)]);
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

  // The file card's own Download menu works too.
  await closeEditor(page);
  await page.click(".job:nth-child(2) .menu summary");
  const [cardDownload] = await Promise.all([page.waitForEvent("download"), page.click(".job:nth-child(2) .export-csv")]);
  assert.match((await readDownload(cardDownload)).toString("utf8"), /\nInterviewer,/, "card download lacks the rename");
  await openEditor(page, 2);

  // Editing: reassign the first line's speaker and tweak its text; both
  // must show up in a re-export without re-processing the file.
  const segs = page.locator("#editor .seg");
  assert.ok((await segs.count()) > 0, "no editable lines rendered");
  const firstSelect = segs.first().locator(".seg-speaker");
  assert.equal(await firstSelect.locator("option").count(), speakers.length, "speaker select option count");
  const secondOption = firstSelect.locator("option").nth(1);
  const targetValue = await secondOption.getAttribute("value");
  const targetLabel = await secondOption.textContent();
  await firstSelect.selectOption(targetValue);
  const firstText = segs.first().locator(".seg-text");
  await firstText.fill((await firstText.inputValue()) + " EDITEDMARK");

  const editedCsv = (await grab(".export-csv")).toString("utf8");
  const editedLine = editedCsv.split("\n").find((l) => l.includes("EDITEDMARK"));
  assert.ok(editedLine, "edited line missing from re-exported CSV");
  assert.ok(editedLine.startsWith(`${targetLabel},`), `edited line not reassigned to "${targetLabel}": ${editedLine}`);

  // Speaker add/remove. Read the current count fresh: the reassignment
  // above may have folded every line onto one speaker.
  const speakerItems = page.locator("#editor-speakers li");
  const itemsBefore = await speakerItems.count();
  const optionsBefore = await segs.first().locator(".seg-speaker option").count();
  await page.click("#add-speaker");
  assert.equal(await speakerItems.count(), itemsBefore + 1, "add speaker did not add an entry");
  assert.equal(await segs.first().locator(".seg-speaker option").count(), optionsBefore + 1, "new speaker missing from a line's speaker picker");
  // It has no lines yet, so removing it again should just drop the entry.
  await page.locator("#editor-speakers .speaker-remove").last().click();
  assert.equal(await speakerItems.count(), itemsBefore, "remove speaker did not remove the entry");

  // Keyboard editing: Delete at the end of a line joins the next one,
  // Enter splits it again, Ctrl+Z undoes the split.
  const linesBefore = await segs.count();
  if (linesBefore > 1) {
    const firstTextBefore = await firstText.inputValue();
    await firstText.click();
    await firstText.evaluate((el) => el.setSelectionRange(el.value.length, el.value.length));
    await firstText.press("Delete");
    assert.equal(await segs.count(), linesBefore - 1, "Delete at line end did not join lines");
    const merged = await firstText.inputValue();
    assert.ok(merged.startsWith(firstTextBefore), "joined line lost its original text");

    await firstText.evaluate((el, mid) => el.setSelectionRange(mid, mid), firstTextBefore.length);
    await firstText.press("Enter");
    assert.equal(await segs.count(), linesBefore, "Enter did not split the line");
    await page.keyboard.press("Control+z");
    assert.equal(await segs.count(), linesBefore - 1, "Ctrl+Z did not undo the split");
    await page.click("#undo");
    assert.equal(await segs.count(), linesBefore, "Undo did not undo the join");
  }

  // Find & replace across every line.
  await page.keyboard.press("Control+f");
  await page.fill("#find-text", "EDITEDMARK");
  assert.match(await page.textContent("#find-count"), /^1 match/);
  await page.fill("#replace-text", "REPLACEDMARK");
  await page.click("#replace-all");
  assert.ok((await editorText(page)).includes("REPLACEDMARK"), "replace all did not change the text");

  // Esc closes find first, then the editor.
  await page.keyboard.press("Escape");
  assert.ok(await page.isHidden("#find-bar"), "Esc did not close find");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.getElementById("editor").open);

  // Same file again with the "medium" model, to exercise the model-swap
  // path in engines/whisper-worker.js (ensureModel only reloads when the
  // URL actually changes from the default). The model picker lives in the
  // Settings dialog.
  await page.click("#settings-open");
  await page.selectOption("#model", "medium");
  await page.click("#settings-dialog .btn");
  await page.setInputFiles("#file-input", path.join(fixtures, expected.singleSpeaker.file));
  await waitForJobs(page, 3);
  await assertNoErrors(page);
  assert.match(await page.textContent(".job:nth-child(3) .job-status"), /^Done/);
  await openEditor(page, 3);
  const medium = (await editorText(page)).toLowerCase();
  for (const w of expected.singleSpeaker.words) assert.ok(medium.includes(w.toLowerCase()), `medium model: missing "${w}" in: ${medium}`);
  const mediumJson = JSON.parse((await grab(".export-json")).toString("utf8"));
  assert.equal(mediumJson.whisper_model, "whisper.cpp ggml-medium-q5_0 (wasm)");

  console.log(`PASS: expected words found (small and medium); ${speakers.length} speakers; renamed speaker in exports; CSV/JSON/SRT/DOCX valid`);
} catch (err) {
  // Leave enough in the CI log to diagnose without a rerun.
  const html = await context.pages()[0]?.innerHTML("#job-list").catch(() => "(page gone)");
  console.log("[job-list at failure]", html);
  throw err;
} finally {
  await context.close();
  server.close();
}
