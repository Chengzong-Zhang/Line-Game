import { readFile, mkdir, readdir, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { atomic, exists, readChecked, canonical, sha256, seedFor } from "./three-player-arena-lib.mjs";
import { engineFor, apply, outcome, policy, rng, HEX_PLAYER_FEATURES } from "./hex-posttrain-core.mjs";
import { policyProbabilities, samplePolicy, ppoLossAndGradient, adamStep } from "./linear-three-v3-core.mjs";
import { SOURCE_FILES, rawAtomic, readModel, sealModel, modelBody, validateProtocol, trainingSpecs,
  arenaSpecs, pairedRows, arenaSummary } from "./hex-posttrain-protocol.mjs";
import { rejectRetiredTrainingEntry } from "./training-policy-v1.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const runRoot = resolve(root, option("--run-root", "local_artifacts/hex-player-posttrain-v2"));
const configPath = resolve(root, option("--config", "web/tools/configs/hex-player-policy-v2-train.json"));
const parentPath = resolve(root, option("--parent", "web/web前端/assets/research-ai/hex-player-policy-v1.json"));
const candidatePath = option("--candidate", null) ? resolve(root, option("--candidate")) : null;
const maxSeconds = Number(option("--max-seconds", "120"));
const maxUnits = Number(option("--max-new-units", "1000000"));
const fault = option("--fault", null);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
class Controlled extends Error { constructor(status) { super(status); this.status = status; } }
let state = null, identity = null, config, parent, candidate, lease = null, ownsLease = false, newUnits = 0;
const invocationStart = Date.now(), gameData = new Map();
const checkpointPath = resolve(runRoot, "checkpoint.json");
const gamePath = (id) => resolve(runRoot, "games", `${id}.json`);
const stagePath = (stage) => resolve(runRoot, "candidates", `stage-${stage}.json`);
async function progress(status, message = null) {
  await atomic(resolve(runRoot, "progress.json"), { identity, status, progress_units: state?.progressUnits ?? 0,
    completed_games: state?.games.length ?? 0, completed_updates: state?.optimizer?.step ?? 0,
    phase: state?.phase ?? "initializing", current_game: state?.current?.id ?? null,
    current_actions: state?.current?.actions.length ?? 0, message });
}
async function save(status = "RUNNING") {
  await atomic(checkpointPath, state);
  await progress(status);
  if (args.includes("--test-events")) console.log(`CHECKPOINT ${JSON.stringify({ phase: state.phase,
    games: state.games.length, steps: state.optimizer.step, actions: state.current?.actions.length ?? 0 })}`);
}
async function control() {
  if (await exists(resolve(runRoot, "STOP"))) throw new Controlled("STOPPED");
  if (await exists(resolve(runRoot, "PAUSE"))) throw new Controlled("PAUSED");
  if (Date.now() - invocationStart >= maxSeconds * 1000 || newUnits >= maxUnits) throw new Controlled("YIELDED");
}
async function inject(name, code) {
  if (fault === name) process.exit(code);
}
async function quarantineTemporary(directory) {
  if (!(await exists(directory))) return;
  for (const name of await readdir(directory)) if (/\.tmp(?:-|$)/.test(name)
      && (directory !== runRoot || /^(checkpoint|progress|worker|summary|hex-player-policy-v2)\.json\.tmp/.test(name))) {
    await mkdir(resolve(runRoot, "interrupted"), { recursive: true });
    await rename(resolve(directory, name), resolve(runRoot, "interrupted", `${Date.now()}-${name}`));
  }
}
async function play(spec, weights) {
  if (gameData.has(spec.id)) return gameData.get(spec.id);
  await control();
  if (state.current && state.current.id !== spec.id) throw new Error("In-flight game order mismatch.");
  state.current ??= { id: spec.id, actions: [], samples: [], rngState: spec.seed, elapsedMs: 0 };
  await save();
  const current = state.current;
  if (!(await exists(gamePath(spec.id)))) {
    const resumedAt = Date.now(), elapsedBefore = current.elapsedMs;
    const engine = engineFor(spec, current.actions), random = rng(current.rngState);
    while (!engine.gameOver && current.actions.length < config.maxActions && current.elapsedMs < config.maxGameSeconds * 1000) {
      await control();
      const actor = engine.currentPlayer, legal = engine.getLegalMoves();
      let point = null;
      if (legal.length) {
        if (current.actions.length < config.prefixMoves) point = legal[Math.floor(random.next() * legal.length)].point;
        else if (spec.kind === "train" && spec.seats.includes(actor)) {
          const choices = policy(engine, weights).sort((a, b) => a.point[1] - b.point[1] || a.point[0] - b.point[0]);
          const features = choices.map((c) => c.features), probabilities = policyProbabilities(features, weights, config.ppo.temperature);
          const action = samplePolicy(probabilities, () => random.next());
          current.samples.push({ ply: current.actions.length, actor, features, action, oldProb: probabilities[action],
            anchor: policyProbabilities(features, parent.model.weights, config.ppo.temperature) });
          point = choices[action].point;
        } else point = policy(engine, spec.seats.includes(actor) ? weights : parent.model.weights)[0].point;
      }
      const action = { actor, point: point ? [...point] : null };
      apply(engine, action); current.actions.push(action); current.rngState = random.state;
      current.elapsedMs = elapsedBefore + Date.now() - resumedAt; state.progressUnits++; newUnits++;
      await save();
      await inject(spec.kind === "train" ? "after-train-action" : "after-arena-action", 91);
    }
    const game = { identity, ...spec, ...current, terminal: engine.gameOver, outcome: engine.gameOver ? outcome(engine) : null };
    if (fault === "before-game-commit") {
      await writeFile(`${gamePath(spec.id)}.tmp-partial`, '{"interrupted":');
      process.exit(92);
    }
    await atomic(gamePath(spec.id), game);
    await inject("after-game-commit", 93);
  }
  const stored = await readChecked(gamePath(spec.id));
  if (stored.identity !== identity || stored.id !== spec.id || canonical(stored.actions) !== canonical(current.actions)
      || canonical(stored.samples) !== canonical(current.samples) || stored.rngState !== current.rngState) {
    throw new Error("Orphan game is inconsistent with the saved in-flight game.");
  }
  state.games.push({ id: spec.id, integrity: stored.integrity });
  gameData.set(spec.id, stored); state.current = null; state.progressUnits++; newUnits++;
  await save();
  console.log(`GAME ${state.games.length} ${spec.id} ${stored.actions.length} actions ${stored.terminal ? "TERMINAL" : "TRUNCATED"}`);
  return stored;
}
async function readStages() {
  return new Map(await Promise.all(state.candidates.map(async ({ stage, integrity }) => {
    const model = await readChecked(stagePath(stage));
    if (model.identity !== identity || model.integrity !== integrity) throw new Error("Stage candidate mismatch.");
    return [stage, model];
  })));
}

try {
  if (!(maxSeconds > 0 && maxSeconds <= 1800) || !Number.isInteger(maxUnits) || maxUnits < 0) throw new Error("Invalid invocation budget.");
  const configBytes = await readFile(configPath);
  config = validateProtocol(JSON.parse(configBytes));
  if (config.mode !== "FINAL") rejectRetiredTrainingEntry("run-hex-posttraining-v2");
  parent = await readModel(parentPath, "hex-player-policy-v1");
  if (canonical(parent.model.features) !== canonical(HEX_PLAYER_FEATURES)) throw new Error("Feature identity mismatch.");
  if (config.mode === "FINAL") {
    if (!candidatePath || candidatePath === parentPath) throw new Error("FINAL requires a distinct frozen candidate.");
    candidate = await readModel(candidatePath, "hex-player-policy-v2");
    if (candidate.model.lineage?.parent_sha256 !== parent.hash || canonical(candidate.model.features) !== canonical(HEX_PLAYER_FEATURES)) throw new Error("Candidate lineage mismatch.");
  }
  const sources = Object.fromEntries(await Promise.all(SOURCE_FILES.map(async (path) => [path, sha256(await readFile(resolve(root, path)))])));
  const identityData = { schema: "lifeline-hex-posttraining-identity-v1", config: sha256(configBytes),
    sources, parent: parent.hash, candidate: candidate?.hash ?? null };
  identity = sha256(canonical(identityData));
  await mkdir(resolve(runRoot, "games"), { recursive: true });
  await mkdir(resolve(runRoot, "candidates"), { recursive: true });
  lease = createServer((socket) => socket.destroy());
  const port = 40000 + seedFor(runRoot.toLowerCase()) % 20000;
  try { await new Promise((accept, reject) => { lease.once("error", reject); lease.listen({ host: "127.0.0.1", port, exclusive: true }, accept); }); }
  catch { lease = null; console.error("DUPLICATE_WORKER"); process.exitCode = 75; throw new Controlled("DUPLICATE"); }
  ownsLease = true; lease.unref();
  await atomic(resolve(runRoot, "worker.json"), { identity, pid: process.pid, port });
  for (const directory of [runRoot, resolve(runRoot, "games"), resolve(runRoot, "candidates")]) await quarantineTemporary(directory);
  state = { schema: "lifeline-hex-posttraining-checkpoint-v1", identity, identityData, config, parentPath, candidatePath,
    phase: "initializing", progressUnits: 0, games: [], current: null, behaviors: [], candidates: [],
    optimizer: { step: 0, weights: [...parent.model.weights], m: Array(16).fill(0), v: Array(16).fill(0) }, selectedStage: null, outputHash: null };
  if (await exists(checkpointPath)) {
    state = await readChecked(checkpointPath);
    if (state.identity !== identity) throw new Error("Source/config/model identity changed; use a new run root.");
    if (new Set(state.games.map((g) => g.id)).size !== state.games.length) throw new Error("Duplicate completed games.");
  }
  for (const entry of state.games) {
    const game = await readChecked(gamePath(entry.id));
    if (game.identity !== identity || game.integrity !== entry.integrity) throw new Error("Completed game integrity changed.");
    gameData.set(entry.id, game);
  }
  await readStages();
  if (state.phase === "complete") {
    const summary = await readChecked(resolve(runRoot, "summary.json"));
    if (summary.identity !== identity || summary.integrity !== state.summaryIntegrity) throw new Error("Completed summary changed.");
    if (state.outputHash && sha256(await readFile(resolve(runRoot, "hex-player-policy-v2.json"))) !== state.outputHash) throw new Error("Completed output changed.");
    await progress("COMPLETE"); process.exitCode = 0;
  } else {
    await control(); await save();
    if (option("--test-hold-ms", null)) await sleep(Number(option("--test-hold-ms")));
    if (config.mode !== "FINAL") {
      const specs = trainingSpecs(config);
      for (let stage = 1; stage <= config.stages; stage++) {
        state.phase = "training";
        if (!state.behaviors.some((b) => b.stage === stage)) { state.behaviors.push({ stage, weights: [...state.optimizer.weights] }); await save(); }
        const behavior = state.behaviors.find((b) => b.stage === stage).weights;
        for (const spec of specs.filter((s) => s.stage === stage)) {
          const game = await play(spec, behavior);
          if (!game.terminal) throw new Error("Training truncated: no terminal reward; promotion blocked.");
        }
        const samples = specs.filter((s) => s.stage === stage).flatMap((s) => {
          const game = gameData.get(s.id), counts = Object.fromEntries(s.seats.map((seat) => [seat, game.samples.filter((x) => x.actor === seat).length]));
          return game.samples.map((sample) => ({ ...sample, advantage: game.outcome.shares[sample.actor] - 1 / s.players,
            weight: 1 / counts[sample.actor] }));
        });
        state.phase = "optimization";
        while (state.optimizer.step < stage * config.optimizer.updatesPerStage) {
          await control();
          const objective = ppoLossAndGradient(samples, state.optimizer.weights, config.ppo);
          adamStep(state.optimizer, objective.gradient, config.optimizer);
          state.progressUnits++; newUnits++; await save(); await inject("after-update", 94);
        }
        if (!state.candidates.some((s) => s.stage === stage)) {
          const candidateState = { identity, stage, weights: [...state.optimizer.weights],
            objective: ppoLossAndGradient(samples, state.optimizer.weights, config.ppo), samples: samples.length };
          if (await exists(stagePath(stage))) {
            const { integrity, ...stored } = await readChecked(stagePath(stage));
            if (canonical(stored) !== canonical(candidateState)) throw new Error("Orphan candidate mismatch.");
          } else await atomic(stagePath(stage), candidateState);
          const stored = await readChecked(stagePath(stage));
          state.candidates.push({ stage, integrity: stored.integrity }); await save();
        }
      }
      state.phase = "development";
      const stages = await readStages(), devSpecs = arenaSpecs(config, true);
      for (const spec of devSpecs) {
        const game = await play(spec, stages.get(spec.stage)?.weights ?? parent.model.weights);
        if (!game.terminal) throw new Error("Development truncated: cannot select candidate.");
      }
      const games = devSpecs.map((s) => gameData.get(s.id));
      const scores = [...stages.values()].map((model) => {
        const rows = pairedRows(games, model.stage);
        return { stage: model.stage, meanDelta: rows.reduce((sum, row) => sum + row.delta, 0) / rows.length, anchorKl: model.objective.anchorKl };
      }).sort((a, b) => b.meanDelta - a.meanDelta || a.anchorKl - b.anchorKl || a.stage - b.stage);
      state.selectedStage = scores[0].stage;
      const output = sealModel({ ...modelBody(parent.model), id: config.modelId, weights: [...stages.get(state.selectedStage).weights],
        lineage: { parent_id: parent.model.id, parent_sha256: parent.hash, training_identity: identity },
        training: { method: "terminal-reward clipped PPO; fixed v1 KL anchor", sizes: config.sizes, player_counts: config.counts,
          completed_episodes: specs.length, optimizer_steps: state.optimizer.step, selected_stage: state.selectedStage,
          reward: config.reward, development_games: games.length, independent_final_required: true },
        release: { status: "CANDIDATE_NOT_PROMOTED", default: false } });
      const outputPath = resolve(runRoot, "hex-player-policy-v2.json");
      if (await exists(outputPath)) {
        if (canonical(JSON.parse(await readFile(outputPath, "utf8"))) !== canonical(output)) throw new Error("Existing output differs; never overwrite frozen output.");
      } else await rawAtomic(outputPath, output);
      state.outputHash = sha256(await readFile(outputPath));
      await atomic(resolve(runRoot, "summary.json"), { identity, mode: config.mode, status: "COMPLETE", trainingGames: specs.length,
        developmentGames: games.length, terminalGames: gameData.size, truncated: 0, optimizerSteps: state.optimizer.step,
        scores, selectedStage: state.selectedStage, outputSha256: state.outputHash, promotion: "REQUIRES_INDEPENDENT_FINAL" });
    } else {
      state.phase = "final";
      const specs = arenaSpecs(config);
      for (const spec of specs) await play(spec, candidate.model.weights);
      await atomic(resolve(runRoot, "summary.json"), { identity, candidateSha256: candidate.hash, parentSha256: parent.hash,
        ...arenaSummary(specs.map((s) => gameData.get(s.id)), config) });
    }
    state.summaryIntegrity = (await readChecked(resolve(runRoot, "summary.json"))).integrity;
    state.phase = "complete"; await save("COMPLETE"); process.exitCode = 0;
  }
} catch (error) {
  if (error instanceof Controlled) {
    if (ownsLease && state) await save(error.status);
    process.exitCode = 75;
  } else {
    console.error(error.stack ?? error);
    if (ownsLease && identity) await progress("FATAL", error.message);
    process.exitCode = 78;
  }
} finally { if (lease) await new Promise((done) => lease.close(done)); }
