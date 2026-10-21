// Independent replay/policy verifier. Aggregate fields are never accepted as
// evidence until every stored action and final discrete area is recomputed.
import { readFile, readdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PLAYERS, sha256, canonical, atomic, readChecked, validateConfig, buildUnits,
  loadRuntime, policyModel, newEngine, createPrefix, summarize, exists,
} from "./three-player-v4-arena-lib.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const runRoot = resolve(root, option("--run-root", "local_artifacts/three-player-v4-20261021/arena"));
const allowIncomplete = args.includes("--allow-incomplete");
const assert = (condition, message) => { if (!condition) throw new Error(message); };

try {
  const identity = await readChecked(resolve(runRoot, "identity.json"));
  const { id, integrity: _, ...identityBody } = identity;
  assert(id === sha256(canonical(identityBody)), "Identity digest mismatch");
  for (const [name, digest] of Object.entries(identity.toolHashes)) {
    assert(sha256(await readFile(resolve(root, "web/tools", name))) === digest, `Tool source differs: ${name}`);
  }
  for (const [name, digest] of Object.entries(identity.ruleHashes)) {
    assert(sha256(await readFile(resolve(runRoot, "sources", name))) === digest, `Frozen rule source differs: ${name}`);
  }
  const configRaw = await readFile(resolve(runRoot, "config.json"));
  const candidateRaw = await readFile(resolve(runRoot, "candidate.json"));
  const baselineRaw = await readFile(resolve(runRoot, "baseline.json"));
  assert(sha256(configRaw) === identity.configSha256 && sha256(candidateRaw) === identity.candidateSha256
    && sha256(baselineRaw) === identity.baselineSha256, "Frozen config/model hash mismatch");
  const config = validateConfig(JSON.parse(configRaw)), units = buildUnits(config);
  const unitMap = new Map(units.map((u) => [u.id, u]));
  const runtime = await loadRuntime(resolve(runRoot, "sources"));
  const candidate = new runtime.ThreePlayerSearchAI(JSON.parse(candidateRaw));
  const baseline = new runtime.ThreePlayerAI(policyModel(JSON.parse(baselineRaw), runtime.THREE_PLAYER_FEATURES));
  const records = [], gameHashes = {};
  let verifiedActions = 0, verifiedDecisions = 0, verifiedSearchActions = 0;
  for (const file of (await readdir(resolve(runRoot, "games"))).filter((f) => f.endsWith(".json")).sort()) {
    const path = resolve(runRoot, "games", file), record = await readChecked(path);
    assert(record.identity === id && file === `${record.unit?.id}.json`, `Game identity mismatch: ${file}`);
    assert(canonical(record.unit) === canonical(unitMap.get(record.unit.id)), `Unexpected game unit: ${file}`);
    assert(!records.some((r) => r.unit.id === record.unit.id), `Duplicate game: ${file}`);
    const prefix = createPrefix(runtime, record.unit, config);
    assert(record.prefixLength === prefix.length && record.prefixSha256 === sha256(canonical(prefix)), `Wrong prefix identity: ${file}`);
    assert(canonical(record.actions.slice(0, prefix.length)) === canonical(prefix), `Wrong random opening: ${file}`);
    assert(Number.isFinite(record.elapsedMs) && record.elapsedMs >= 0, `Invalid elapsed time: ${file}`);
    const engine = newEngine(runtime, record.unit);
    let candidateDecisions = 0, simulatedActions = 0;
    for (let index = 0; index < record.actions.length; index += 1) {
      const action = record.actions[index];
      assert(!engine.gameOver && action.actor === engine.currentPlayer, `Wrong action actor/terminal: ${file}:${index}`);
      if (index >= prefix.length) {
        const policy = record.unit.candidateSeats.includes(action.actor) ? candidate : baseline;
        const expected = policy.getTopMoves(engine, engine.currentPlayer, 1)[0]?.point ?? null;
        if (policy === candidate) { candidateDecisions++; simulatedActions += candidate.lastSearch?.simulatedActions ?? 0; }
        assert(expected ? action.type === "move" && canonical(action.point) === canonical(expected) : action.type === "skip",
          `Policy/budget mismatch: ${file}:${index}`);
        verifiedDecisions += 1;
      }
      const result = action.type === "move" ? engine.playMove(action.point)
        : action.type === "skip" ? engine.skipTurn() : { success: false };
      assert(result.success, `Illegal action: ${file}:${index}`);
      verifiedActions += 1;
    }
    assert(Array.isArray(record.candidateTimingsMs) && record.candidateTimingsMs.length === candidateDecisions
      && record.candidateTimingsMs.every((value) => Number.isFinite(value) && value >= 0), `Invalid timing telemetry: ${file}`);
    assert(record.simulatedActions === simulatedActions, `Search work count mismatch: ${file}`);
    verifiedSearchActions += simulatedActions;
    assert(engine.gameOver === record.terminal, `Terminal flag mismatch: ${file}`);
    if (engine.gameOver) {
      engine._isReplayingBatch = false;
      engine._updateTerritories();
      const areas = Object.fromEntries(PLAYERS.map((player) => [player, engine.cachedTerritories[player].area]));
      const winners = PLAYERS.filter((p) => areas[p] === Math.max(...Object.values(areas)));
      const sharedWin = Object.fromEntries(PLAYERS.map((p) => [p, winners.includes(p) ? 1 / winners.length : 0]));
      const pairwise = Object.fromEntries(PLAYERS.map((p) => [p, PLAYERS.filter((q) => q !== p)
        .reduce((sum, q) => sum + (areas[p] > areas[q] ? 1 : areas[p] === areas[q] ? 0.5 : 0), 0) / 2]));
      assert(canonical(record.metrics) === canonical({ areas, winners, sharedWin, pairwise }), `Terminal discrete area/score mismatch: ${file}`);
      assert(record.truncationReason === null, `Terminal marked truncated: ${file}`);
    } else {
      assert(record.metrics === null, `Truncation reported a win/score: ${file}`);
      assert(record.truncationReason === "ACTION_LIMIT" ? record.actions.length >= config.maxActions
        : record.truncationReason === "GAME_TIME_LIMIT" && record.elapsedMs >= config.maxGameSeconds * 1000,
      `Unjustified truncation: ${file}`);
    }
    records.push(record);
    gameHashes[record.unit.id] = sha256(await readFile(path));
  }
  assert(allowIncomplete || records.length === units.length, "Evaluation is incomplete");
  const checkpoint = await readChecked(resolve(runRoot, "checkpoint.json"));
  assert(checkpoint.identity === id && new Set(checkpoint.completedGames).size === checkpoint.completedGames.length,
    "Invalid checkpoint identity/completed-game list");
  assert(checkpoint.completedGames.every((game) => records.some((r) => r.unit.id === game)), "Checkpoint references missing game");
  assert(canonical(checkpoint.completedGames) === canonical(units.filter((unit) => records.some((r) => r.unit.id === unit.id)).map((unit) => unit.id)),
    "Completed index must exactly match all durable games in design order");
  const summary = summarize(records, config);
  if (await exists(resolve(runRoot, "summary.json"))) {
    const stored = await readChecked(resolve(runRoot, "summary.json"));
    const { integrity: _integrity, identity: summaryIdentity, ...body } = stored;
    assert(summaryIdentity === id && canonical(body) === canonical(summary), "Aggregate summary mismatch");
  } else assert(allowIncomplete, "Missing completed summary");
  const output = {
    status: records.length === units.length ? "PASS_APPLICATION_EVALUATION" : "PASS_PARTIAL_RECOVERY_ONLY",
    identity: id, verifiedGames: records.length, plannedGames: units.length,
    verifiedActions, verifiedDecisions, verifiedSearchActions, summaryFieldsVerified: "all", terminalGames: summary.terminalGames,
    truncatedGames: summary.truncatedGames, promotionPass: summary.promotionPass,
    gameHashesSha256: sha256(canonical(gameHashes)),
    sourceScope: "frozen rule sources; identical legal candidates, feature scoring and tie-break budgets",
  };
  await atomic(resolve(runRoot, "verification.json"), output);
  console.log(JSON.stringify(output));
} catch (error) {
  console.error(error.stack ?? error);
  process.exitCode = 78;
}
