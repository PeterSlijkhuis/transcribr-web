// scripts/update-actions.mjs -- moves every `uses: owner/repo@vN` in
// .github/workflows to the newest major version tag of that action
// (.github/workflows/update-actions.yml runs it weekly). The pull request's
// own checks then show whether the new versions work.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/// The highest N among tags named exactly vN, or null.
export function latestMajor(tags) {
  const majors = tags.map((t) => /^v(\d+)$/.exec(t)).filter(Boolean).map((m) => Number(m[1]));
  return majors.length ? Math.max(...majors) : null;
}

function main() {
  const dir = ".github/workflows";
  const cache = {};
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".yml"))) {
    const text = readFileSync(`${dir}/${file}`, "utf8");
    const next = text.replace(/(uses: )([\w.-]+\/[\w.-]+)@v(\d+)\b/g, (whole, head, repo, current) => {
      if (!(repo in cache)) {
        const refs = execFileSync("git", ["ls-remote", "--tags", `https://github.com/${repo}`], { encoding: "utf8" });
        cache[repo] = latestMajor([...refs.matchAll(/refs\/tags\/(\S+)$/gm)].map((m) => m[1]));
      }
      const latest = cache[repo];
      if (latest === null || latest <= Number(current)) return whole;
      console.log(`${file}: ${repo} v${current} -> v${latest}`);
      return `${head}${repo}@v${latest}`;
    });
    if (next !== text) writeFileSync(`${dir}/${file}`, next);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
