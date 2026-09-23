// test/e2e.mjs -- full end-to-end check: loads the real app in Chromium,
// feeds both fixture files through the real file input, and asserts that
// the single-speaker file's transcript contains the expected words, the
// two-speaker file comes back with two speakers, and all four exports
// download with the right structure. Nothing is mocked: the engines come
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

  const statusLog = setInterval(async () => {
    const s = await page.$$eval(".job", (els) => els.map((e) => `${e.dataset.status}: ${e.querySelector(".job-status").textContent}`)).catch(() => []);
    const banner = await page.textContent("#engine-status").catch(() => "");
    console.log("[status]", s.join(" | "), "|", banner);
  }, 10_000);
  try {
    await page.waitForFunction(
      () => {
        const jobs = [...document.querySelectorAll(".job")];
        return jobs.length === 2 && jobs.every((j) => j.dataset.status === "done" || j.dataset.status === "error");
      },
      null,
      { timeout: JOB_TIMEOUT_MS, polling: 1000 }
    );
  } finally {
    clearInterval(statusLog);
  }

  const jobs = await page.$$(".job");
  const errors = await page.$$eval(".job-error", (els) => els.map((e) => e.textContent).filter(Boolean));
  assert.deepEqual(errors, [], "jobs failed");

  // single-speaker.wav: expected words present, one speaker.
  const single = (await jobs[0].$eval(".job-transcript", (e) => e.textContent)).toLowerCase();
  for (const w of expected.singleSpeaker.words) assert.ok(single.includes(w.toLowerCase()), `missing "${w}" in: ${single}`);

  // two-speaker.wav: expected speaker count.
  const speakers = await jobs[1].$$eval(".turn-speaker", (els) => [...new Set(els.map((e) => e.textContent))]);
  assert.equal(speakers.length, expected.twoSpeaker.expectedSpeakerCount, `speakers: ${speakers.join(", ")}`);

  // Exports, from the two-speaker job.
  const grab = async (cls) => {
    const [download] = await Promise.all([page.waitForEvent("download"), page.click(`.job:nth-child(2) ${cls}`)]);
    return readDownload(download);
  };
  const csv = (await grab(".export-csv")).toString("utf8");
  assert.match(csv, /^speaker_id,timestamp_start,timestamp_end,transcribed_text\n/);
  assert.ok(csv.trim().split("\n").length >= 3, "CSV has fewer than 2 data rows");
  const json = JSON.parse((await grab(".export-json")).toString("utf8"));
  assert.equal(json.speaker_count, expected.twoSpeaker.expectedSpeakerCount);
  const srt = (await grab(".export-srt")).toString("utf8");
  assert.match(srt, /^1\r\n\d\d:\d\d:\d\d,\d\d\d --> \d\d:\d\d:\d\d,\d\d\d\r\nSpeaker \d: /);
  const docx = await grab(".export-docx");
  assert.equal(docx.subarray(0, 2).toString("latin1"), "PK");
  assert.ok(docx.includes(Buffer.from("word/document.xml")), "DOCX lacks word/document.xml");

  console.log(`PASS: expected words found; ${speakers.length} speakers; CSV/JSON/SRT/DOCX exports valid`);
} finally {
  await context.close();
  server.close();
}
