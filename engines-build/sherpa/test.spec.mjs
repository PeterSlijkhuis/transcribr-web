import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..", "..");
const expected = JSON.parse(
  readFileSync(path.join(__dirname, "..", "fixtures", "expected-words.json"), "utf8")
).twoSpeaker;

const webRoot = path.join(repoRoot, "engines-build", "sherpa");
const distRoot = path.join(webRoot, "dist");
const enginesRoot = path.join(repoRoot, "engines-build");
const contentTypes = { ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm", ".wav": "audio/wav", ".json": "application/json", ".data": "application/octet-stream", ".onnx": "application/octet-stream" };
const server = createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split("?")[0]);
  let root = webRoot;
  if (urlPath.startsWith("/fixtures/")) {
    root = enginesRoot;
  } else if (urlPath !== "/test.html") {
    root = distRoot;
  }
  const filePath = path.normalize(path.join(root, urlPath));
  if (!filePath.startsWith(enginesRoot)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = readFileSync(filePath);
    res.writeHead(200, {
      "Content-Type": contentTypes[path.extname(filePath)] || "application/octet-stream",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
server.listen(8082);

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("server did not come up in time");
}

try {
  await waitForServer("http://localhost:8082/test.html", 15_000);

  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("console", (msg) => console.log("[page]", msg.text()));
  await page.goto("http://localhost:8082/test.html");
  await page.click("#run");
  await page.waitForFunction(
    () => document.getElementById("log").textContent.includes("RESULT_JSON="),
    { timeout: 120_000 }
  );
  const log = await page.textContent("#log");
  const match = log.match(/RESULT_JSON=(\[.*\])/);
  assert.ok(match, "no RESULT_JSON found in log");
  const segments = JSON.parse(match[1]);
  const speakers = new Set(segments.map((s) => s.speaker));
  assert.equal(
    speakers.size,
    expected.expectedSpeakerCount,
    `expected ${expected.expectedSpeakerCount} distinct speakers, got ${speakers.size}: ${JSON.stringify(segments)}`
  );
  console.log("PASS: got", segments.length, "segments across", speakers.size, "speakers");
  await browser.close();
} finally {
  server.close();
}
