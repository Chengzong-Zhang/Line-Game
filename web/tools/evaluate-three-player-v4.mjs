import { readFile, writeFile, mkdir, rename, readdir, unlink } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import {
  sha256, canonical, atomic, exists, readChecked, validateConfig, buildUnits,
  loadRuntime, policyModel, newEngine, applyAction, createPrefix, terminalMetrics, summarize,
} from "./three-player-v4-arena-lib.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const runRoot = resolve(root, option("--run-root", "local_artifacts/three-player-v4-20261021/arena"));
const configPath = resolve(root, option("--config", "docs/verification/three-player-ai-v4/final-vs-v1.config.json"));
const candidatePath = option("--candidate") ? resolve(root, option("--candidate")) : null;
const baselinePath = resolve(root, option("--baseline", "web/web前端/assets/research-ai/three-player-policy-v1.json"));
const maximumSeconds = Number(option("--max-seconds", "120"));
const maxNewGames = Number(option("--max-new-games", "1000"));
const fault = option("--fault", "");
const testHoldMs = Number(option("--test-hold-ms", "0"));
const RULE_FILES = ["GameEngine.js", "AIEngine.js", "ThreePlayerAI.js", "ThreePlayerSearchAI.js"];
const TOOL_FILES = ["evaluate-three-player-v4.mjs", "three-player-v4-arena-lib.mjs", "three-player-arena-lib.mjs", "verify-three-player-v4-arena.mjs"];
const invocationStart = Date.now();
let lease, identity, checkpoint, config, units, records = [], chargedAt = Date.now(), baseElapsed = 0;

function charge() {
  const now = Date.now();
  checkpoint.elapsedMs += now - chargedAt;
  chargedAt = now;
}
async function progress(status, extra = {}) {
  if (checkpoint) {
    charge();
    await atomic(resolve(runRoot, "checkpoint.json"), checkpoint);
  }
  await atomic(resolve(runRoot, "progress.json"), {
    status, identity: identity?.id ?? null, progress_units: records.length,
    planned_units: units?.length ?? null, elapsed_ms: checkpoint?.elapsedMs ?? 0,
    pid: process.pid, updated_at: new Date().toISOString(), ...extra,
  });
}
async function controls() {
  if (await exists(resolve(runRoot, "STOP"))) return "STOPPED";
  if (await exists(resolve(runRoot, "PAUSE"))) return "PAUSED";
  const elapsed = checkpoint.elapsedMs + Date.now() - chargedAt;
  if (elapsed >= config.totalBudgetSeconds * 1000) return "BUDGET_EXHAUSTED";
  if (Date.now() - invocationStart >= maximumSeconds * 1000) return "YIELDED";
  return null;
}
async function saveActive(active) {
  charge();
  await atomic(resolve(runRoot, "active-game.json"), active);
  await atomic(resolve(runRoot, "checkpoint.json"), checkpoint);
}
async function initialize() {
  if (!candidatePath || !Number.isFinite(maximumSeconds) || maximumSeconds <= 0 || maximumSeconds > 1800
    || !Number.isInteger(maxNewGames) || maxNewGames < 0 || maxNewGames > 1000) throw new Error("INVALID CLI arguments");
  const configRaw = await readFile(configPath), candidateRaw = await readFile(candidatePath), baselineRaw = await readFile(baselinePath);
  config = validateConfig(JSON.parse(configRaw));
  if ((fault || testHoldMs) && config.stage !== "RECOVERY_TEST") throw new Error("INVALID fault injection outside recovery tests");
  units = buildUnits(config);
  await mkdir(runRoot, { recursive: true });
  lease = createServer((socket) => socket.destroy());
  const port = 35000 + Number.parseInt(sha256(runRoot.toLowerCase()).slice(0, 8), 16) % 25000;
  await new Promise((accept, reject) => {
    lease.once("error", reject);
    lease.listen({ host: "127.0.0.1", port, exclusive: true }, accept);
  });
  lease.unref();
  const toolHashes = Object.fromEntries(await Promise.all(TOOL_FILES.map(async (name) => [
    name, sha256(await readFile(resolve(root, "web/tools", name))),
  ])));
  const requested = {
    configSha256: sha256(configRaw), candidateSha256: sha256(candidateRaw), baselineSha256: sha256(baselineRaw),
    toolHashes,
  };
  const identityPath = resolve(runRoot, "identity.json");
  if (await exists(identityPath)) {
    identity = await readChecked(identityPath);
    for (const [key, value] of Object.entries(requested)) {
      if (canonical(identity[key]) !== canonical(value)) throw new Error(`IDENTITY_MISMATCH ${key}`);
    }
    for (const [name, hash] of Object.entries(identity.ruleHashes)) {
      if (sha256(await readFile(resolve(runRoot, "sources", name))) !== hash) throw new Error(`SOURCE_MISMATCH ${name}`);
    }
    for (const [name, hash] of [["config.json", requested.configSha256], ["candidate.json", requested.candidateSha256], ["baseline.json", requested.baselineSha256]]) {
      if (sha256(await readFile(resolve(runRoot, name))) !== hash) throw new Error(`IDENTITY_MISMATCH frozen ${name}`);
    }
  } else {
    if (await exists(resolve(runRoot, "checkpoint.json")) || await exists(resolve(runRoot, "games"))) throw new Error("CORRUPT missing identity");
    await mkdir(resolve(runRoot, "sources"), { recursive: true });
    const ruleHashes = {};
    for (const name of RULE_FILES) {
      const raw = await readFile(resolve(root, "web/web前端", name));
      ruleHashes[name] = sha256(raw);
      await writeFile(resolve(runRoot, "sources", name), raw);
    }
    await writeFile(resolve(runRoot, "config.json"), configRaw);
    await writeFile(resolve(runRoot, "candidate.json"), candidateRaw);
    await writeFile(resolve(runRoot, "baseline.json"), baselineRaw);
    identity = { ...requested, ruleHashes };
    identity.id = sha256(canonical(identity));
    await atomic(identityPath, identity);
  }
  await atomic(resolve(runRoot, "run.lock"), { pid: process.pid, port, identity: identity.id });
  await mkdir(resolve(runRoot, "games"), { recursive: true });
  // Preserve incomplete atomic writes from killed workers without trusting them.
  for (const directory of [runRoot, resolve(runRoot, "games")]) {
    for (const file of await readdir(directory)) if (file.includes(".tmp-")) {
      const destination = resolve(runRoot, "interrupted", `${Date.now()}-${file}`);
      await mkdir(dirname(destination), { recursive: true });
      await rename(resolve(directory, file), destination);
    }
  }
  const checkpointPath = resolve(runRoot, "checkpoint.json");
  checkpoint = await exists(checkpointPath) ? await readChecked(checkpointPath)
    : { identity: identity.id, completedGames: [], elapsedMs: 0 };
  if (checkpoint.identity !== identity.id || !Array.isArray(checkpoint.completedGames)
    || new Set(checkpoint.completedGames).size !== checkpoint.completedGames.length
    || !Number.isFinite(checkpoint.elapsedMs) || checkpoint.elapsedMs < 0) throw new Error("CORRUPT checkpoint semantics");
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  for (const file of (await readdir(resolve(runRoot, "games"))).filter((f) => f.endsWith(".json")).sort()) {
    const record = await readChecked(resolve(runRoot, "games", file));
    if (record.identity !== identity.id || file !== `${record.unit?.id}.json`
      || canonical(record.unit) !== canonical(byId.get(record.unit?.id))
      || !Array.isArray(record.actions) || !Number.isFinite(record.elapsedMs)
      || typeof record.terminal !== "boolean") throw new Error(`CORRUPT game ${file}`);
    records.push(record);
  }
  const completedIds = new Set(records.map((r) => r.unit.id));
  if (checkpoint.completedGames.some((id) => !completedIds.has(id))) throw new Error("CORRUPT missing committed game");
  // A crash after game commit but before checkpoint commit is recoverable.
  checkpoint.completedGames = units.filter((unit) => completedIds.has(unit.id)).map((unit) => unit.id);
  baseElapsed = checkpoint.elapsedMs;
  chargedAt = Date.now();
  return {
    runtime: await loadRuntime(resolve(runRoot, "sources")),
    candidate: JSON.parse(candidateRaw), baseline: JSON.parse(baselineRaw),
  };
}

async function run() {
  const { runtime, candidate, baseline } = await initialize();
  const candidateAI = new runtime.ThreePlayerSearchAI(candidate);
  const baselineAI = new runtime.ThreePlayerAI(policyModel(baseline, runtime.THREE_PLAYER_FEATURES));
  await progress("RUNNING");
  if (testHoldMs > 0) await new Promise((accept) => setTimeout(accept, testHoldMs));
  let newGames = 0;
  for (const unit of units) {
    if (checkpoint.completedGames.includes(unit.id)) continue;
    const control = await controls();
    if (control || newGames >= maxNewGames) {
      await progress(control === "BUDGET_EXHAUSTED" ? "FATAL" : control ?? "YIELDED",
        control === "BUDGET_EXHAUSTED" ? { reason: control } : {});
      return control === "BUDGET_EXHAUSTED" ? 78 : 75;
    }
    const prefix = createPrefix(runtime, unit, config);
    const activePath = resolve(runRoot, "active-game.json");
    let active = await exists(activePath) ? await readChecked(activePath) : null;
    if (active && checkpoint.completedGames.includes(active.unit?.id)) {
      await unlink(activePath); active = null;
    }
    if (active && (active.identity !== identity.id || canonical(active.unit) !== canonical(unit)
      || !Array.isArray(active.actions) || !Number.isFinite(active.elapsedMs) || active.elapsedMs < 0
      || canonical(active.actions.slice(0, prefix.length)) !== canonical(prefix))) throw new Error("CORRUPT active game");
    active ??= { identity: identity.id, unit, actions: [...prefix], elapsedMs: 0, candidateTimingsMs: [], simulatedActions: 0 };
    const engine = newEngine(runtime, unit);
    for (const action of active.actions) applyAction(engine, action);
    await saveActive(active);
    let reason = null;
    while (!engine.gameOver) {
      const state = await controls();
      if (state) {
        await saveActive(active);
        await progress(state === "BUDGET_EXHAUSTED" ? "FATAL" : state, state === "BUDGET_EXHAUSTED" ? { reason: state } : {});
        return state === "BUDGET_EXHAUSTED" ? 78 : 75;
      }
      if (active.actions.length >= config.maxActions) { reason = "ACTION_LIMIT"; break; }
      if (active.elapsedMs >= config.maxGameSeconds * 1000) { reason = "GAME_TIME_LIMIT"; break; }
      const started = Date.now();
      const ai = unit.candidateSeats.includes(engine.currentPlayer) ? candidateAI : baselineAI;
      const point = ai.getTopMoves(engine, engine.currentPlayer, 1)[0]?.point ?? null;
      if (ai === candidateAI) { active.candidateTimingsMs.push(Date.now() - started); active.simulatedActions += candidateAI.lastSearch?.simulatedActions ?? 0; }
      const action = { actor: engine.currentPlayer, type: point ? "move" : "skip", ...(point ? { point: [...point] } : {}) };
      applyAction(engine, action);
      active.actions.push(action);
      active.elapsedMs += Date.now() - started;
      await saveActive(active);
      if (fault === "after-action") process.exit(91);
    }
    const record = {
      ...active, terminal: engine.gameOver, truncationReason: reason,
      prefixLength: prefix.length, prefixSha256: sha256(canonical(prefix)),
      metrics: terminalMetrics(engine),
    };
    if (fault === "before-game-commit") {
      await writeFile(resolve(runRoot, "games", `${unit.id}.json.tmp-fault`), '{"partial":');
      process.exit(92);
    }
    await atomic(resolve(runRoot, "games", `${unit.id}.json`), record);
    if (fault === "after-game-commit") process.exit(93);
    records.push(record);
    checkpoint.completedGames.push(unit.id);
    await progress("RUNNING", { last_game: unit.id });
    await unlink(activePath);
    newGames += 1;
  }
  const summary = summarize(records, config);
  const summaryPath = resolve(runRoot, "summary.json");
  if (await exists(summaryPath)) {
    const { integrity: _, ...stored } = await readChecked(summaryPath);
    if (canonical(stored) !== canonical({ identity: identity.id, ...summary })) throw new Error("CORRUPT summary");
  } else await atomic(summaryPath, { identity: identity.id, ...summary });
  await progress("COMPLETE", { terminal_games: summary.terminalGames, truncated_games: summary.truncatedGames, promotion_pass: summary.promotionPass });
  console.log(JSON.stringify({ status: "COMPLETE", ...summary, runtimeSeconds: (checkpoint.elapsedMs - baseElapsed) / 1000 }));
  return 0;
}

try {
  process.exitCode = await run();
} catch (error) {
  const fatal = error instanceof SyntaxError || error.code === "ENOENT"
    || /CORRUPT|INVALID|IDENTITY_MISMATCH|SOURCE_MISMATCH/.test(String(error?.message));
  if (error.code === "EADDRINUSE") {
    console.error("DUPLICATE_WORKER: run directory already has an active loopback lease.");
    process.exitCode = 75;
  } else {
    // Do not rewrite a mismatched/corrupt checkpoint while reporting failure.
    await atomic(resolve(runRoot, "progress.json"), {
      status: fatal ? "FATAL" : "FAILED", progress_units: records.length,
      identity: identity?.id ?? null, reason: String(error?.message ?? error),
    }).catch(() => {});
    console.error(error.stack ?? error);
    process.exitCode = fatal ? 78 : 1;
  }
} finally {
  lease?.close();
}
