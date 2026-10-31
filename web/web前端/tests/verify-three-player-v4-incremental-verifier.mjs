import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cp, readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "../../tools/three-player-arena-lib.mjs";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const args = process.argv.slice(2), index = args.indexOf("--arena-root");
assert.ok(index >= 0 && args[index + 1], "Supply a completed small v4 RECOVERY_TEST arena");
const arena = resolve(root, args[index + 1]);
const directory = resolve(root, `local_artifacts/three-v4-incremental-verifier-recovery-${Date.now()}`);
await mkdir(directory, { recursive: true });
const verifier = resolve(root, "web/tools/verify-three-player-v4-arena-v2.mjs");
const argv = (name, extra = []) => [verifier, "--run-root", arena, "--verify-root", resolve(directory, name), ...extra];
const run = (name, code, extra = []) => {
  const output = spawnSync(process.execPath, argv(name, extra), { encoding: "utf8", timeout: 30000, windowsHide: true });
  assert.equal(output.status, code, output.stderr); return output;
};
const json = async (path) => JSON.parse(await readFile(path));
run("clean", 0);
const clean = await json(resolve(directory, "clean", "verification.json"));
assert.equal(clean.verifiedGames, 7);
run("orphan", 91, ["--fault", "after-proof"]);
const orphanName = (await readdir(resolve(directory, "orphan", "verified-games"))).find((name) => name.endsWith(".json"));
const orphanPath = resolve(directory, "orphan", "verified-games", orphanName);
const orphanBytes = await readFile(orphanPath), orphanMtime = (await stat(orphanPath)).mtimeMs;
run("orphan", 0);
assert.deepEqual(await readFile(orphanPath), orphanBytes); assert.equal((await stat(orphanPath)).mtimeMs, orphanMtime);
const adopted = await json(resolve(directory, "orphan", "verification.json"));
assert.equal(adopted.restoredGames, 1); assert.equal(adopted.freshGames, 6);
const child = spawn(process.execPath, argv("killed", ["--test-progress-hold-ms", "1000"]), { stdio: "ignore", windowsHide: true });
const done = new Promise((finish) => child.once("exit", finish));
let firstProof;
try {
  for (let poll = 0; poll < 200; poll++) {
    try {
      const state = await json(resolve(directory, "killed", "progress.json"));
      if (state.progress_units >= 1 && state.status === "RUNNING") { firstProof = state.last_verified_game; break; }
    } catch {}
    await new Promise((finish) => setTimeout(finish, 50));
  }
  assert.ok(firstProof); child.kill("SIGKILL"); await done;
  const proofPath = resolve(directory, "killed", "verified-games", `${firstProof}.json`);
  const bytes = await readFile(proofPath), mtime = (await stat(proofPath)).mtimeMs;
  run("killed", 0);
  assert.deepEqual(await readFile(proofPath), bytes); assert.equal((await stat(proofPath)).mtimeMs, mtime);
  const resumed = await json(resolve(directory, "killed", "verification.json"));
  assert.ok(resumed.restoredGames >= 1); assert.equal(resumed.restoredGames + resumed.freshGames, 7);
  for (const key of ["identity", "verifiedGames", "verifiedActions", "verifiedDecisions", "verifiedSearchActions", "gameHashesSha256", "promotionPass"])
    assert.deepEqual(resumed[key], clean[key]);
} finally { child.kill("SIGKILL"); }
const proofDirectory = resolve(directory, "orphan", "verified-games");
await writeFile(resolve(proofDirectory, "incomplete.json.tmp-fixture"), '{"partial":');
run("orphan", 0);
assert.equal((await readdir(resolve(directory, "orphan", "interrupted"))).length, 1);
const changed = JSON.parse(await readFile(orphanPath)); changed.gameSha256 = "0".repeat(64);
await writeFile(orphanPath, JSON.stringify(changed));
run("orphan", 78);
for (const target of ["game", "proof"]) {
  const copiedArena = resolve(directory, `mutation-${target}-arena`), verificationRoot = resolve(directory, `mutation-${target}-verification`);
  await cp(arena, copiedArena, { recursive: true });
  const worker = spawn(process.execPath, [verifier, "--run-root", copiedArena, "--verify-root", verificationRoot,
    "--test-progress-hold-ms", "500"], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  let stderr = ""; worker.stderr.on("data", (bytes) => { stderr += bytes; });
  const exit = new Promise((finish) => worker.once("close", finish));
  try {
    let unitId;
    for (let poll = 0; poll < 300; poll++) {
      try { const progress = await json(resolve(verificationRoot, "progress.json")); if (progress.progress_units >= 1) { unitId = progress.last_verified_game; break; } } catch {}
      await new Promise((finish) => setTimeout(finish, 25));
    }
    assert.ok(unitId);
    const changedPath = target === "game" ? resolve(copiedArena, "games", `${unitId}.json`)
      : resolve(verificationRoot, "verified-games", `${unitId}.json`);
    await writeFile(changedPath, `${await readFile(changedPath, "utf8")} `);
    assert.equal(await exit, 78, stderr);
    assert.match(stderr, target === "game" ? /GAME_MISMATCH finish/ : /PROOF_MISMATCH finish/);
  } finally { worker.kill("SIGKILL"); }
}
const receipt = { status: "PASS_INCREMENTAL_V4_VERIFIER", directory, arena,
  checks: ["all-policy-decisions", "real-kill-resume", "verified-proof-bytes-and-mtime-preserved", "orphan-proof-adoption",
    "no-completed-game-reverification", "partial-write-isolation", "corrupt-proof-rejected", "post-verification-game-mutation-rejected",
    "post-verification-proof-mutation-rejected"],
  verifier_sha256: sha256(await readFile(verifier)), test_sha256: sha256(await readFile(fileURLToPath(import.meta.url))) };
await writeFile(resolve(directory, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify(receipt));
