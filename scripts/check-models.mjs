// scripts/check-models.mjs -- the weekly model check (.github/workflows/check-models.yml).
// Writes report.md when something needs a look, and nothing when all is well:
//   - a download link in engines/manifest.json no longer answers,
//   - the upstream Hugging Face repos list a model file we haven't seen
//     (scripts/known-models.json; add it there once looked at),
//   - sherpa-onnx has a newer release than the engine build in the manifest.
// It reports, and for one case it acts: when a model file the app already
// uses was replaced upstream under the same name (its hash changed), the
// manifest's modelsVersion is bumped. The site then offers visitors an
// "Update models" button instead of replacing what they have cached.
// Switching to a different model or engine stays a reviewed change.
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/// Files in `listed` that `known` doesn't have.
export function newFiles(listed, known) {
  const seen = new Set(known);
  return listed.filter((f) => !seen.has(f));
}

/// Models whose file changed upstream: [{ file, sha }]. `hashes` is what was
/// seen last time ({ file: sha256 }); a file seen for the first time is only
/// recorded, not reported as changed.
export function changedModels(files, hashes) {
  const changed = [];
  for (const [file, sha] of Object.entries(files)) {
    if (hashes[file] && hashes[file] !== sha) changed.push({ file, sha });
  }
  return changed;
}

/// True when dotted version `a` is newer than `b` ("1.13.9" > "1.13.8").
export function newerVersion(a, b) {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  }
  return false;
}

async function json(url) {
  const res = await fetch(url, { headers: { "User-Agent": "transcribr-web-model-check" } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

async function main() {
  const manifest = JSON.parse(readFileSync("engines/manifest.json", "utf8"));
  const known = JSON.parse(readFileSync("scripts/known-models.json", "utf8"));
  const out = [];

  const urls = [
    manifest.whisper.libJsUrl, manifest.whisper.wasmUrl, manifest.whisper.vadUrl,
    ...manifest.whisper.models.map((m) => m.url),
    ...Object.values(manifest.sherpa),
  ].filter((u) => typeof u === "string" && u.startsWith("http"));
  for (const url of urls) {
    try {
      const res = await fetch(url, { method: "HEAD", headers: { "User-Agent": "transcribr-web-model-check" } });
      if (!res.ok) out.push(`- **Download link broken** (HTTP ${res.status}): ${url}`);
    } catch (e) {
      out.push(`- **Download link unreachable** (${e.message}): ${url}`);
    }
  }

  const hashes = JSON.parse(readFileSync("scripts/model-hashes.json", "utf8"));
  const used = Object.fromEntries(manifest.whisper.models.map((m) => [`${m.name}.bin`, null]));
  for (const repo of Object.keys(known)) {
    try {
      const siblings = (await json(`https://huggingface.co/api/models/${repo}?blobs=true`)).siblings.filter((s) => s.rfilename.endsWith(".bin"));
      const added = newFiles(siblings.map((s) => s.rfilename), known[repo]);
      if (added.length) out.push(`- **New in ${repo}:** ${added.join(", ")}`);
      for (const s of siblings) if (s.rfilename in used && s.lfs) used[s.rfilename] = s.lfs.sha256;
    } catch (e) {
      out.push(`- Could not list ${repo}: ${e.message}`);
    }
  }

  const seen = Object.fromEntries(Object.entries(used).filter(([, sha]) => sha));
  const changed = changedModels(seen, hashes);
  if (changed.length) {
    const today = new Date().toISOString().slice(0, 10);
    const text = readFileSync("engines/manifest.json", "utf8");
    writeFileSync("engines/manifest.json", text.replace(/"modelsVersion": "[^"]*"/, `"modelsVersion": "${today}"`));
    const names = changed.map((c) => c.file).join(", ");
    writeFileSync("commit.txt", `Update the models: ${names} changed upstream\n\nThe weekly check saw a new file under the same name. modelsVersion moves to ${today}, so the site offers visitors an Update models button; what they have cached stays until they press it.\n`);
    out.push(`- **Updated on \`development\`:** ${names} (new modelsVersion ${today}). Open a pull request to publish it.`);
  }
  writeFileSync("scripts/model-hashes.json", JSON.stringify({ ...hashes, ...seen }, null, 2) + "\n");

  const sherpa = /sherpa-v([\d.]+)\//.exec(manifest.sherpa.mainJsUrl);
  if (sherpa) {
    try {
      const latest = (await json("https://api.github.com/repos/k2-fsa/sherpa-onnx/releases/latest")).tag_name.replace(/^v/, "");
      if (newerVersion(latest, sherpa[1])) out.push(`- **sherpa-onnx ${latest} is out** (the engine uses ${sherpa[1]})`);
    } catch (e) {
      out.push(`- Could not read the latest sherpa-onnx release: ${e.message}`);
    }
  }

  if (out.length) {
    writeFileSync(
      "report.md",
      `Weekly model check:\n\n${out.join("\n")}\n\nNew model files are added to \`scripts/known-models.json\` once looked at, so they stop being reported.\n`
    );
  }
  console.log(out.length ? out.join("\n") : "Nothing to report.");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
