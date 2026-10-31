// Supervisor adapter for the frozen read-only verifier CLI. Its entry point
// runs in this same process so supervisor termination cannot orphan a child.
import { mkdir, readFile, realpath } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { atomic, readJson, sha, lease } from "./neural-posttraining-data.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const opt = (key) => { const index = args.indexOf(key); return index < 0 ? null : args[index + 1]; };
const runRoot = opt("--run-root") && resolve(root, opt("--run-root"));
const arenaRoot = opt("--arena-root") && resolve(root, opt("--arena-root"));
const candidates = opt("--candidates") && resolve(root, opt("--candidates"));
const verifier = resolve(root, "web/tools/verify-neural-posttraining-v2.mjs");
let guard, identity, verifierExitCode = null, durableUnits = 0, ownsRun = false;
async function save(status, units, message = null) {
  durableUnits = Math.max(durableUnits, units);
  await atomic(resolve(runRoot, "checkpoint.json"), { identity, status, progress_units: durableUnits, verifier_exit_code: verifierExitCode });
  await atomic(resolve(runRoot, "progress.json"), { identity, status, progress_units: durableUnits, message });
}
try {
  if (!runRoot || !arenaRoot || !candidates || runRoot === arenaRoot) throw new Error("Use separate verifier run-root plus arena-root and candidates.");
  await mkdir(runRoot, { recursive: true });
  const canonical = (value) => process.platform === "win32" ? value.toLowerCase() : value;
  const realRun = await realpath(runRoot), realArena = await realpath(arenaRoot);
  if (canonical(realRun) === canonical(realArena)) throw new Error("Verification and arena directories must differ.");
  guard = await lease(realRun);
  const arenaIdentityBytes = await readFile(resolve(arenaRoot, "identity.json"));
  const summaryBytes = await readFile(resolve(arenaRoot, "summary.json"));
  const verifierBytes = await readFile(verifier);
  const arenaIdentity = JSON.parse(arenaIdentityBytes);
  if ((await readJson(resolve(arenaRoot, "progress.json"))).status !== "COMPLETE") throw new Error("Arena is not complete.");
  identity = sha(JSON.stringify({ arena: sha(arenaIdentityBytes), summary: sha(summaryBytes),
    verifier: sha(verifierBytes), candidates: sha(await readFile(candidates)), adapter: sha(await readFile(fileURLToPath(import.meta.url))) }));
  const previous = await readJson(resolve(runRoot, "checkpoint.json"), true);
  if (previous && previous.identity !== identity) throw new Error("Verification input identity drift.");
  const progress = await readJson(resolve(runRoot, "progress.json"), true);
  if (progress && (!previous || progress.identity !== identity)) throw new Error("Verification progress identity drift.");
  for (const record of [previous, progress].filter(Boolean)) {
    if (!Number.isSafeInteger(record.progress_units) || record.progress_units < 0 || record.progress_units > 1) {
      throw new Error("Invalid verification progress units.");
    }
    durableUnits = Math.max(durableUnits, record.progress_units);
  }
  ownsRun = true;
  await save("RUNNING", 0);
  const command = [process.execPath, verifier, "--arena-root", arenaRoot, "--candidates", candidates];
  const started = Date.now();
  // Execute the unchanged CLI branch, including its own exit-code handling.
  process.argv = command;
  process.exitCode = 0;
  await import(pathToFileURL(verifier).href);
  verifierExitCode = process.exitCode ?? 0;
  const receipt = {
    schema: "lifeline-supervised-verification-receipt-v1", identity, command,
    execution: "Unchanged verifier CLI entry point in the supervisor-managed adapter process; no descendant worker.",
    verifier_exit_code: verifierExitCode, verifier_sha256: sha(verifierBytes), elapsed_ms: Date.now() - started,
    arena_identity: arenaIdentity.identity, arena_summary_sha256: sha(summaryBytes),
  };
  if (verifierExitCode === 0) {
    const report = await readJson(resolve(arenaRoot, "verification.json"));
    if (report.identity !== arenaIdentity.identity || report.status !== "PASS_APPLICATION_SCREEN_REPLAY"
        || report.games !== arenaIdentity.plannedGames || report.summaryFieldsVerified !== "all") {
      throw new Error("Verifier completion report does not match the frozen arena.");
    }
    receipt.verification_sha256 = sha(await readFile(resolve(arenaRoot, "verification.json")));
  }
  await atomic(resolve(runRoot, "verification-execution.json"), receipt);
  await save(verifierExitCode === 0 ? "COMPLETE" : "FATAL", verifierExitCode === 0 ? 1 : 0);
  if (verifierExitCode !== 0) process.exitCode = 78;
} catch (error) {
  if (ownsRun) await save("FATAL", 0, error.message);
  console.error(error.stack ?? error.message); process.exitCode = 78;
} finally {
  if (guard) await new Promise((done) => guard.close(done));
}
