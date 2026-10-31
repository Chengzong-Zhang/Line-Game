// Incremental independent replay: durable per-game proofs bind exact input
// bytes. A restart rechecks those hashes, without repeating verified policies.
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, realpath, rename } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { lease } from "./neural-posttraining-data.mjs";
import { PLAYERS, sha256, canonical, atomic, readChecked, validateChecked, exists, validateConfig, buildUnits,
  loadRuntime, policyModel, newEngine, createPrefix, summarize } from "./three-player-v4-arena-lib.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2), opt = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const arena = opt("--run-root") && resolve(root, opt("--run-root"));
const output = opt("--verify-root") && resolve(root, opt("--verify-root"));
const maxSeconds = Number(opt("--max-seconds", "300")), fault = opt("--fault", "");
const holdMs = Number(opt("--test-progress-hold-ms", "0"));
const started = Date.now();
let guard, identity, trusted = false, completed = [], units = [], restoredGames = 0, freshGames = 0;
const check = (condition, message) => assert.ok(condition, message);
async function progress(status, extra = {}) {
  await atomic(resolve(output, "checkpoint.json"), { identity, completed, status });
  await atomic(resolve(output, "progress.json"), { identity, status, progress_units: completed.length,
    planned_units: units.length, restoredGames, freshGames, ...extra });
}
async function control() {
  if (await exists(resolve(output, "STOP"))) return "STOPPED";
  if (await exists(resolve(output, "PAUSE"))) return "PAUSED";
  if (Date.now() - started > maxSeconds * 1000) return "YIELDED";
  return null;
}
try {
  check(arena && output && Number.isFinite(maxSeconds) && maxSeconds > 0 && maxSeconds <= 1800, "INVALID verifier arguments");
  await mkdir(output, { recursive: true });
  const normalize = (path) => process.platform === "win32" ? path.toLowerCase() : path;
  check(normalize(await realpath(arena)) !== normalize(await realpath(output)), "INVALID verifier directory alias");
  guard = await lease(await realpath(output));
  const arenaIdentity = await readChecked(resolve(arena, "identity.json"));
  const { id, integrity: _, ...body } = arenaIdentity;
  check(id === sha256(canonical(body)), "CORRUPT arena identity");
  const hashes = {};
  for (const [name, hash] of Object.entries(arenaIdentity.toolHashes)) {
    const path = resolve(root, "web/tools", name); hashes[path] = sha256(await readFile(path));
    check(hashes[path] === hash, `SOURCE_MISMATCH ${name}`);
  }
  for (const [name, hash] of Object.entries(arenaIdentity.ruleHashes)) {
    const path = resolve(arena, "sources", name); hashes[path] = sha256(await readFile(path));
    check(hashes[path] === hash, `SOURCE_MISMATCH ${name}`);
  }
  for (const file of ["identity.json", "config.json", "candidate.json", "baseline.json", "summary.json", "checkpoint.json"]) {
    const path = resolve(arena, file); hashes[path] = sha256(await readFile(path));
  }
  hashes[fileURLToPath(import.meta.url)] = sha256(await readFile(fileURLToPath(import.meta.url)));
  hashes[resolve(root, "web/tools/neural-posttraining-data.mjs")] = sha256(await readFile(resolve(root, "web/tools/neural-posttraining-data.mjs")));
  check(hashes[resolve(arena, "config.json")] === arenaIdentity.configSha256
    && hashes[resolve(arena, "candidate.json")] === arenaIdentity.candidateSha256
    && hashes[resolve(arena, "baseline.json")] === arenaIdentity.baselineSha256, "IDENTITY_MISMATCH frozen model/config");
  check((await readChecked(resolve(arena, "progress.json"))).status === "COMPLETE", "Arena not complete");
  identity = sha256(canonical(hashes));
  const config = validateConfig(JSON.parse(await readFile(resolve(arena, "config.json"))));
  check((!fault && !holdMs) || config.stage === "RECOVERY_TEST", "INVALID fault outside fixture");
  check(Number.isFinite(holdMs) && holdMs >= 0 && holdMs <= 1000, "INVALID test hold");
  units = buildUnits(config);
  const unitMap = new Map(units.map((unit) => [unit.id, unit]));
  const previous = await exists(resolve(output, "checkpoint.json")) ? await readChecked(resolve(output, "checkpoint.json")) : null;
  if (previous) {
    check(previous.identity === identity, "IDENTITY_MISMATCH verification inputs");
    check(Array.isArray(previous.completed) && new Set(previous.completed).size === previous.completed.length
      && previous.completed.every((unitId) => unitMap.has(unitId)), "CORRUPT verifier checkpoint");
  }
  trusted = true;
  await mkdir(resolve(output, "verified-games"), { recursive: true });
  for (const directory of [output, resolve(output, "verified-games")]) {
    for (const name of await readdir(directory)) if (name.includes(".tmp-")) {
      await mkdir(resolve(output, "interrupted"), { recursive: true });
      await rename(resolve(directory, name), resolve(output, "interrupted", `${Date.now()}-${name}`));
    }
  }
  const files = (await readdir(resolve(arena, "games"))).filter((file) => file.endsWith(".json")).sort();
  check(files.length === units.length, "Incomplete arena games");
  const restored = new Map(), durableProofHashes = new Map();
  for (const file of (await readdir(resolve(output, "verified-games"))).filter((file) => file.endsWith(".json")).sort()) {
    const bytes = await readFile(resolve(output, "verified-games", file));
    const proof = validateChecked(JSON.parse(bytes), file);
    check(proof.identity === identity && file === `${proof.unitId}.json` && unitMap.has(proof.unitId), "CORRUPT verification proof");
    check(sha256(await readFile(resolve(arena, "games", file))) === proof.gameSha256, "CORRUPT previously verified game");
    restored.set(proof.unitId, proof);
    durableProofHashes.set(proof.unitId, sha256(bytes));
  }
  check((previous?.completed ?? []).every((unitId) => restored.has(unitId)), "CORRUPT missing verification proof");
  completed = files.filter((file) => restored.has(file.slice(0, -5))).map((file) => file.slice(0, -5));
  restoredGames = completed.length;
  await progress("RUNNING");
  const runtime = await loadRuntime(resolve(arena, "sources"));
  const candidate = new runtime.ThreePlayerSearchAI(JSON.parse(await readFile(resolve(arena, "candidate.json"))));
  const baseline = new runtime.ThreePlayerAI(policyModel(JSON.parse(await readFile(resolve(arena, "baseline.json"))), runtime.THREE_PLAYER_FEATURES));
  const records = [], gameHashes = {}, proofHashes = {};
  let verifiedActions = 0, verifiedDecisions = 0, verifiedSearchActions = 0;
  for (const file of files) {
    const path = resolve(arena, "games", file), gameBytes = await readFile(path);
    const record = validateChecked(JSON.parse(gameBytes), path), unitId = record.unit?.id;
    check(record.identity === id && file === `${unitId}.json` && canonical(record.unit) === canonical(unitMap.get(unitId)), `CORRUPT game identity ${file}`);
    check(Number.isFinite(record.elapsedMs) && record.elapsedMs >= 0, `Invalid elapsed time ${file}`);
    const gameSha256 = sha256(gameBytes);
    let proof = restored.get(unitId);
    if (!proof) {
      const requested = await control();
      if (requested) { await progress(requested); process.exitCode = 75; break; }
      const prefix = createPrefix(runtime, record.unit, config);
      check(record.prefixLength === prefix.length && record.prefixSha256 === sha256(canonical(prefix))
        && canonical(record.actions.slice(0, prefix.length)) === canonical(prefix), `Wrong prefix ${file}`);
      const engine = newEngine(runtime, record.unit);
      let candidateDecisions = 0, simulatedActions = 0;
      for (let index = 0; index < record.actions.length; index++) {
        const action = record.actions[index];
        check(!engine.gameOver && action.actor === engine.currentPlayer, `Wrong actor/terminal ${file}:${index}`);
        if (index >= prefix.length) {
          const policy = record.unit.candidateSeats.includes(action.actor) ? candidate : baseline;
          const point = policy.getTopMoves(engine, engine.currentPlayer, 1)[0]?.point ?? null;
          check(point ? action.type === "move" && canonical(action.point) === canonical(point) : action.type === "skip", `Policy mismatch ${file}:${index}`);
          if (policy === candidate) { candidateDecisions++; simulatedActions += candidate.lastSearch?.simulatedActions ?? 0; }
        }
        check((action.type === "move" ? engine.playMove(action.point) : action.type === "skip" ? engine.skipTurn() : {}).success,
          `Illegal action ${file}:${index}`);
      }
      check(record.terminal === engine.gameOver, `Terminal mismatch ${file}`);
      if (engine.gameOver) {
        runtime.GameEngine.prototype._updateTerritories.call(engine);
        const areas = Object.fromEntries(PLAYERS.map((p) => [p, engine.cachedTerritories[p].area]));
        const winners = PLAYERS.filter((p) => areas[p] === Math.max(...Object.values(areas)));
        const sharedWin = Object.fromEntries(PLAYERS.map((p) => [p, winners.includes(p) ? 1 / winners.length : 0]));
        const pairwise = Object.fromEntries(PLAYERS.map((p) => [p, PLAYERS.filter((q) => q !== p)
          .reduce((sum, q) => sum + (areas[p] > areas[q] ? 1 : areas[p] === areas[q] ? 0.5 : 0), 0) / 2]));
        check(canonical(record.metrics) === canonical({ areas, winners, sharedWin, pairwise }) && record.truncationReason === null,
          `Terminal discrete area/score mismatch ${file}`);
      } else check(record.metrics === null && (record.truncationReason === "ACTION_LIMIT" ? record.actions.length >= config.maxActions
        : record.truncationReason === "GAME_TIME_LIMIT" && record.elapsedMs >= config.maxGameSeconds * 1000), `Invalid truncation ${file}`);
      check(Array.isArray(record.candidateTimingsMs) && record.candidateTimingsMs.length === candidateDecisions
        && record.candidateTimingsMs.every((value) => Number.isFinite(value) && value >= 0), `Invalid timing telemetry ${file}`);
      check(record.simulatedActions === simulatedActions, `Search work mismatch ${file}`);
      proof = { identity, unitId, gameSha256, actions: record.actions.length,
        decisions: record.actions.length - prefix.length, searchActions: simulatedActions };
      await atomic(resolve(output, "verified-games", file), proof);
      const proofBytes = await readFile(resolve(output, "verified-games", file));
      const { integrity: _proofSeal, ...writtenProof } = validateChecked(JSON.parse(proofBytes), file);
      check(canonical(writtenProof) === canonical(proof), `CORRUPT committed proof ${file}`);
      durableProofHashes.set(unitId, sha256(proofBytes));
      if (fault === "after-proof") process.exit(91);
      completed.push(unitId); freshGames++;
      completed.sort(); await progress("RUNNING", { last_verified_game: unitId });
      if (holdMs) await new Promise((done) => setTimeout(done, holdMs));
    }
    check(proof.gameSha256 === gameSha256 && proof.actions === record.actions.length
      && proof.decisions === record.actions.length - record.prefixLength && proof.searchActions === record.simulatedActions, `CORRUPT proof counts ${file}`);
    records.push(record); gameHashes[unitId] = gameSha256;
    proofHashes[unitId] = durableProofHashes.get(unitId);
    verifiedActions += proof.actions; verifiedDecisions += proof.decisions; verifiedSearchActions += proof.searchActions;
  }
  if (process.exitCode !== 75) {
    const cp = await readChecked(resolve(arena, "checkpoint.json"));
    check(cp.identity === id && canonical(cp.completedGames) === canonical(units.map((unit) => unit.id)), "Completed game index mismatch");
    const summary = summarize(records, config), saved = await readChecked(resolve(arena, "summary.json"));
    const { identity: summaryIdentity, integrity: _seal, ...savedBody } = saved;
    check(summaryIdentity === id && canonical(savedBody) === canonical(summary), "Aggregate summary mismatch");
    for (const [path, digest] of Object.entries(hashes)) check(sha256(await readFile(path)) === digest, `SOURCE_MISMATCH finish ${path}`);
    for (const [unitId, digest] of Object.entries(gameHashes)) check(sha256(await readFile(resolve(arena, "games", `${unitId}.json`))) === digest, `GAME_MISMATCH finish ${unitId}`);
    for (const [unitId, digest] of Object.entries(proofHashes)) check(sha256(await readFile(resolve(output, "verified-games", `${unitId}.json`))) === digest, `PROOF_MISMATCH finish ${unitId}`);
    const report = { status: "PASS_APPLICATION_EVALUATION", identity: id, verificationIdentity: identity,
      verifiedGames: records.length, plannedGames: units.length, verifiedActions, verifiedDecisions, verifiedSearchActions,
      terminalGames: summary.terminalGames, truncatedGames: summary.truncatedGames, promotionPass: summary.promotionPass,
      summaryFieldsVerified: "all", gameHashesSha256: sha256(canonical(gameHashes)), proofHashesSha256: sha256(canonical(proofHashes)),
      verifierSha256: hashes[fileURLToPath(import.meta.url)], restoredGames, freshGames,
      sourceScope: "All actions, policy decisions, terminal areas, work counts and summary fields; valid per-game proofs resume without repeated policy evaluation." };
    await atomic(resolve(output, "verification.json"), report);
    await progress("COMPLETE"); console.log(JSON.stringify(report));
  }
} catch (error) {
  if (trusted) await atomic(resolve(output, "progress.json"), { identity, status: "FATAL", progress_units: completed.length, reason: error.message }).catch(() => {});
  console.error(error.stack ?? error); process.exitCode = 78;
} finally { if (guard) await new Promise((done) => guard.close(done)); }
