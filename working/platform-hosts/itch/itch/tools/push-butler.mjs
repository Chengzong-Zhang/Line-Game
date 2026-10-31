import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const itchRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(itchRoot, "..");
const config = JSON.parse(await readFile(path.join(itchRoot, "config", "release.json"), "utf8"));
const target = process.env.LIFELINE_ITCH_TARGET;
const butlerPath = process.env.LIFELINE_BUTLER_PATH || "butler";
if (!target || !/^[a-z0-9_-]+\/[a-z0-9_-]+:html5$/i.test(target)) {
  throw new Error("Set LIFELINE_ITCH_TARGET to the existing itch target, for example creator/lifeline:html5.");
}
const verification = spawnSync(process.execPath, [path.join(itchRoot, "tests", "verify-html5-build.mjs")], {
  cwd: repoRoot,
  encoding: "utf8",
  stdio: "inherit",
  shell: false,
});
if (verification.error) throw verification.error;
if (verification.status !== 0) {
  throw new Error(`Refusing to upload: package verification exited with status ${verification.status}.`);
}
const dist = path.join(repoRoot, "local_artifacts", "itch-html5", "dist");
const result = spawnSync(butlerPath, ["push", dist, target, "--userversion", config.version], {
  cwd: repoRoot,
  encoding: "utf8",
  stdio: "inherit",
  shell: false,
});
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`butler exited with status ${result.status}.`);
