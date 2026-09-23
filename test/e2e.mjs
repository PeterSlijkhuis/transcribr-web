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

  // The verified engine harness ran diarization with 2 clusters; the
  // fixtures are synthesized TTS voices, so pin the count rather than rely
  // on the auto-detect threshold for them.
  await page.fill("#num-speakers", String(expected.twoSpeaker.expectedSpeakerCount));
  await page.fill("#language", "en");
  await page.setInputFiles("#file-input", [
    path.join(fixtures, expected.singleSpeaker.file),
    path.join(fixtures, expected.twoSpeaker.file),
  ]);

  await waitForJobs(page, 2);

  const jobs = await page.$$(".job");
  await assertNoErrors(page);

  // single-speaker.wav: expected words present, one speaker.
  const single = (await jobs[0].$eval(".job-transcript", (e) => e.textContent)).toLowerCase();
  for (const w of expected.singleSpeaker.words) assert.ok(single.includes(w.toLowerCase()), `missing "${w}" in: ${single}`);

  // two-speaker.wav: expected speaker count.
  const speakers = await jobs[1].$$eval(".turn-speaker", (els) => [...new Set(els.map((e) => e.textContent))]);
  assert.equal(speakers.length, expected.twoSpeaker.expectedSpeakerCount, `speakers: ${speakers.join(", ")}`);

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

  // Same file again with the "small" model.
  await page.selectOption("#model", "small");
  await page.setInputFiles("#file-input", path.join(fixtures, expected.singleSpeaker.file));
  await waitForJobs(page, 3);
  await assertNoErrors(page);
  const third = await page.$(".job:nth-child(3)");
  assert.match(await third.$eval(".job-status", (e) => e.textContent), /^Done/);
  const small = (await third.$eval(".job-transcript", (e) => e.textContent)).toLowerCase();
  for (const w of expected.singleSpeaker.words) assert.ok(small.includes(w.toLowerCase()), `small model: missing "${w}" in: ${small}`);
  const smallJson = JSON.parse((await grab(".export-json", 3)).toString("utf8"));
  assert.equal(smallJson.whisper_model, "whisper.cpp ggml-small-q5_1 (wasm)");

  console.log(`PASS: expected words found (base and small); ${speakers.length} speakers; renamed speaker in exports; CSV/JSON/SRT/DOCX valid`);
} catch (err) {
  // Leave enough in the CI log to diagnose without a rerun.
  const html = await context.pages()[0]?.innerHTML("#job-list").catch(() => "(page gone)");
  console.log("[job-list at failure]", html);
  throw err;
} finally {
  await context.close();
  server.close();
}
