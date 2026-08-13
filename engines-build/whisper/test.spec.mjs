// engines-build/whisper/test.spec.mjs
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
).singleSpeaker.words;

// A plain static server isn't enough: libmain.js is built with
// USE_PTHREADS=1, which needs SharedArrayBuffer, which Chrome only grants
// in a cross-origin-isolated context (COOP/COEP headers). Hand-rolled
// node:http server instead of adding a static-server dependency.
const webRoot = path.join(repoRoot, "engines-build", "whisper");
const enginesRoot = path.join(repoRoot, "engines-build");
const contentTypes = { ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm", ".wav": "audio/wav", ".json": "application/json", ".bin": "application/octet-stream" };
const server = createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split("?")[0]);
  const root = urlPath.startsWith("/fixtures/") ? enginesRoot : webRoot;
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
server.listen(8081);

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
  await waitForServer("http://localhost:8081/test.html", 15_000);

  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("console", (msg) => console.log("[page]", msg.text()));
  await page.goto("http://localhost:8081/test.html");
  await page.click("#run");
  await page.waitForFunction(
    (words) => {
      const text = document.getElementById("log").textContent.toLowerCase();
      return text.includes("full_default returned") && words.every((w) => text.includes(w.toLowerCase()));
    },
    expected,
    { timeout: 120_000 }
  );
  const log = await page.textContent("#log");
  for (const word of expected) {
    assert.ok(log.toLowerCase().includes(word.toLowerCase()), `missing expected word: ${word}`);
  }
  console.log("PASS: all expected words found");
  await browser.close();
} finally {
  server.close();
}
