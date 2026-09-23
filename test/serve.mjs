// test/serve.mjs -- static server for local runs and the e2e check. Sends
// the COOP/COEP headers GitHub Pages can't (coi-serviceworker.js supplies
// them there). Usage: node test/serve.mjs [port]
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const contentTypes = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".css": "text/css",
  ".wav": "audio/wav",
};

export function startServer(port) {
  const server = createServer(async (req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const filePath = path.normalize(path.join(repoRoot, urlPath === "/" ? "/index.html" : urlPath));
    if (!filePath.startsWith(repoRoot + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(filePath);
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
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2]) || 8090;
  await startServer(port);
  console.log(`serving ${repoRoot} at http://localhost:${port}/`);
}
