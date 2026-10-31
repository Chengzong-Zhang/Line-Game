import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sha256 } from "../tools/release-source.mjs";

const itchRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(itchRoot, "..");
const config = JSON.parse(await readFile(path.join(itchRoot, "config", "release.json"), "utf8"));
const zipPath = path.join(repoRoot, "local_artifacts", "itch-html5", `${config.candidate_id}.zip`);
const buildScript = path.join(itchRoot, "tools", "build-html5.mjs");

function build() {
  const result = spawnSync(process.execPath, [buildScript], {
    cwd: itchRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`build exited with status ${result.status}`);
  return result.stdout.trim();
}

build();
const first = sha256(await readFile(zipPath));
build();
const second = sha256(await readFile(zipPath));
assert.equal(second, first, "two consecutive builds must produce byte-identical ZIP files");

console.log(JSON.stringify({
  status: "PASS_DETERMINISTIC_HTML5_ZIP",
  candidate_id: config.candidate_id,
  consecutive_builds: 2,
  zip_sha256: second,
}));
