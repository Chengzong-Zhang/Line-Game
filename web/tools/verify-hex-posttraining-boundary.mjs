// Small bounded legality/area audit of a halted FINAL. Policy scores are NOT recomputed.
// This never computes a promotion
// decision, overall delta or confidence interval from a selected partial set.
import assert from "node:assert/strict";
import { readFile, mkdir, readdir } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { atomic, exists, readChecked, canonical, sha256, seedFor } from "./three-player-arena-lib.mjs";
import { engineFor, apply, outcome, rng } from "./hex-posttrain-core.mjs";
import { readModel, validateProtocol, arenaSpecs } from "./hex-posttrain-protocol.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../.."), args = process.argv.slice(2);
const option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const source = resolve(root, option("--run-root")), output = resolve(root, option("--output-root"));
const maxSeconds = Number(option("--max-seconds", "120")), started = Date.now();
let identity, state, lease = null, owns = false;
async function save(status, message = null) {
  await atomic(resolve(output, "checkpoint.json"), state);
  await atomic(resolve(output, "progress.json"), { identity, status, progress_units: state.checked.length, message });
}
try {
  const supervisor = JSON.parse(await readFile(resolve(source, "supervisor-state.json"), "utf8"));
  assert.ok(["BUDGET_EXHAUSTED", "FATAL", "RETRY_EXHAUSTED", "STOPPED", "PAUSED", "INTERRUPTED"].includes(supervisor.status), "Partial audit requires a halted FINAL.");
  assert.equal(supervisor.worker_pid, null);
  const checkpointBytes = await readFile(resolve(source, "checkpoint.json"));
  const checkpoint = await readChecked(resolve(source, "checkpoint.json")), config = validateProtocol(checkpoint.config);
  assert.equal(config.mode, "FINAL");
  const parent = await readModel(checkpoint.parentPath, "hex-player-policy-v1");
  const candidate = await readModel(checkpoint.candidatePath, "hex-player-policy-v2");
  assert.equal(parent.hash, checkpoint.identityData.parent); assert.equal(candidate.hash, checkpoint.identityData.candidate);
  for (const [file, hash] of Object.entries(checkpoint.identityData.sources)) assert.equal(sha256(await readFile(resolve(root, file))), hash);
  identity = sha256(canonical({ sourceIdentity: checkpoint.identity, checkpoint: sha256(checkpointBytes),
    verifier: sha256(await readFile(fileURLToPath(import.meta.url))) }));
  await mkdir(output, { recursive: true });
  lease = createServer((socket) => socket.destroy());
  await new Promise((accept, reject) => { lease.once("error", reject); lease.listen({ host: "127.0.0.1", port: 40000 + seedFor(output.toLowerCase()) % 20000, exclusive: true }, accept); });
  owns = true; lease.unref();
  state = { identity, checked: [] };
  if (await exists(resolve(output, "checkpoint.json"))) { state = await readChecked(resolve(output, "checkpoint.json")); assert.equal(state.identity, identity); }
  const specs = arenaSpecs(config);
  assert.deepEqual(checkpoint.games.map((x) => x.id), specs.slice(0, checkpoint.games.length).map((x) => x.id));
  const units = await Promise.all(checkpoint.games.map(async (entry, index) => {
    const game = await readChecked(resolve(source, "games", `${entry.id}.json`));
    assert.equal(game.identity, checkpoint.identity); assert.equal(game.integrity, entry.integrity);
    return { spec: specs[index], game, indexed: true };
  }));
  if (checkpoint.current) {
    const spec = specs[checkpoint.games.length];
    assert.equal(checkpoint.current.id, spec.id);
    units.push({ spec, game: checkpoint.current, indexed: false });
  }
  const storedIds = (await readdir(resolve(source, "games"))).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5));
  const unindexed = storedIds.filter((id) => !checkpoint.games.some((g) => g.id === id));
  assert.ok(unindexed.every((id) => id === checkpoint.current?.id), "Unexpected unindexed evidence.");
  let status = "COMPLETE";
  for (const { spec, game, indexed } of units) {
    const unitHash = sha256(canonical(game)), prior = state.checked.find((x) => x.id === spec.id);
    if (prior) { assert.equal(prior.unitHash, unitHash); continue; }
    if (await exists(resolve(output, "STOP"))) { status = "STOPPED"; break; }
    if (await exists(resolve(output, "PAUSE"))) { status = "PAUSED"; break; }
    if (Date.now() - started >= maxSeconds * 1000) { status = "YIELDED"; break; }
    const engine = engineFor(spec), random = rng(spec.seed);
    let decisions = 0;
    for (let ply = 0; ply < game.actions.length; ply++) {
      const actor = engine.currentPlayer, legal = ply < config.prefixMoves ? engine.getLegalMoves() : [];
      assert.equal(game.actions[ply].actor, actor);
      if (ply < config.prefixMoves) {
        const prefixPoint = legal.length ? legal[Math.floor(random.next() * legal.length)].point : null;
        assert.deepEqual(game.actions[ply].point, prefixPoint);
      } else if (game.actions[ply].point !== null) decisions++;
      apply(engine, game.actions[ply]);
    }
    assert.equal(game.rngState, random.state); assert.equal(game.samples.length, 0);
    if (indexed) {
      assert.equal(engine.gameOver, game.terminal);
      if (game.terminal) assert.deepEqual(outcome(engine), game.outcome, "Fresh discrete terminal area");
      else { assert.equal(game.outcome, null); assert.ok(game.actions.length >= config.maxActions || game.elapsedMs >= config.maxGameSeconds * 1000); }
    }
    if (!indexed && unindexed.includes(spec.id)) {
      const orphan = await readChecked(resolve(source, "games", `${spec.id}.json`));
      assert.equal(orphan.identity, checkpoint.identity);
      assert.deepEqual(orphan.actions, game.actions); assert.equal(orphan.rngState, game.rngState);
      assert.equal(orphan.terminal, engine.gameOver);
      if (orphan.terminal) assert.deepEqual(orphan.outcome, outcome(engine));
      else assert.equal(orphan.outcome, null);
    }
    state.checked.push({ id: spec.id, unitHash, indexed, terminal: engine.gameOver, actions: game.actions.length, policyDecisions: decisions });
    await save("RUNNING");
  }
  if (status !== "COMPLETE") { await save(status); process.exitCode = 75; }
  else {
    const completed = state.checked.filter((x) => x.indexed);
    const report = { status: "PASS_LEGALITY_AREA_BOUNDARY_ONLY", identity, sourceIdentity: checkpoint.identity,
      sourceStopReason: supervisor.status, plannedGames: specs.length, indexedCompletedGames: completed.length,
      terminalGames: completed.filter((x) => x.terminal).length, truncatedGames: completed.filter((x) => !x.terminal).length,
      remainingGames: specs.length - completed.length, inFlight: state.checked.find((x) => !x.indexed) ?? null,
      validatedUnindexedGameIds: unindexed,
      actions: state.checked.reduce((sum, x) => sum + x.actions, 0), policyDecisionsRecomputed: 0, policyDecisionsNotRecomputed: state.checked.reduce((sum, x) => sum + x.policyDecisions, 0),
      promote: false, meanDelta: null, bootstrap95: null,
      scope: "halted FINAL legality, full history, seeded prefix and fresh terminal area only; policy scoring was NOT recomputed; no complete-arena result or strength conclusion" };
    await atomic(resolve(output, "report.json"), report); await save("COMPLETE");
    console.log(JSON.stringify(report)); process.exitCode = 0;
  }
} catch (error) {
  console.error(error.stack ?? error);
  if (owns && state) await save("FATAL", error.message);
  process.exitCode = 78;
} finally { if (lease?.listening) await new Promise((done) => lease.close(done)); }
