// v2 binds parent manifest bytes and adopts complete unindexed game evidence.
// Paired application screening uses exactly the currently shipped JS inference.
import { readFile, mkdir, rename, readdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { GameEngine } from "../web前端/GameEngine.js";
import { createResearchModel, NeuralPUCTAI } from "../web前端/ResearchAI.js";
import { loadModelFreeModel, ModelFreeAI } from "../web前端/ModelFreeAI.js";
import { atomic, readJson, root, sha, sealed, unseal, lease, rng, replay } from "./neural-posttraining-data.mjs";

const assetRoot = resolve(root, "web/web前端/assets/research-ai");
export async function loadArenaModels(candidateManifestPath, { parentManifestRoot = assetRoot } = {}) {
  parentManifestRoot = resolve(parentManifestRoot);
  const source_hashes = {};
  const parents = [];
  for (const p of ["manifest.json", "transfer-v1/manifest.json", "model-free-manifest.json"]) {
    const path = resolve(parentManifestRoot, p), bytes = await readFile(path);
    source_hashes[path] = sha(bytes);
    parents.push(...JSON.parse(bytes).models);
  }
  const candidateBytes = await readFile(candidateManifestPath);
  source_hashes[resolve(candidateManifestPath)] = sha(candidateBytes);
  const candidates = JSON.parse(candidateBytes).models;
  if (!Array.isArray(candidates) || !candidates.length) throw new Error("Empty candidate manifest");
  const entries = [...parents.map((spec) => ({ spec, base: assetRoot })),
    ...candidates.map((spec) => ({ spec, base: dirname(candidateManifestPath) }))];
  const byId = new Map(entries.map((e) => [e.spec.id, e]));
  if (byId.size !== entries.length) throw new Error("Model ID collision");
  const blobs = new Map();
  for (const e of entries) {
    const path = resolve(e.base, e.spec.asset), bytes = await readFile(path);
    if (sha(bytes) !== e.spec.asset_sha256) throw new Error(`Model hash mismatch: ${e.spec.id}`);
    e.bytes = bytes; source_hashes[path] = sha(bytes);
    const url = new URL(`../web前端/assets/research-ai/${e.spec.asset}`, import.meta.url).href;
    if (blobs.has(url)) throw new Error(`Asset URL collision: ${url}`);
    blobs.set(url, bytes);
  }
  // The shipped MLP module exposes only its loader. Route its two documented
  // asset requests to the already hash-checked local files; do not reimplement it.
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/model-free-manifest.json")) return { ok: true, json: async () => ({ schema: { name: "lifeline-web-model-free" }, models: entries.map((e) => e.spec) }) };
    const bytes = blobs.get(String(url));
    if (!bytes) throw new Error(`Unexpected local model request: ${url}`);
    return { ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
  };
  const policies = new Map();
  for (const candidate of candidates) {
    const parent = byId.get(candidate.parent_model_id);
    if (!parent || !parents.some((p) => p.id === parent.spec.id)) throw new Error("Missing parent model");
    for (const id of [candidate.id, candidate.parent_model_id]) {
      if (policies.has(id)) continue;
      const { spec, bytes } = byId.get(id);
      if (spec.model_kind) {
        const model = createResearchModel(spec, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        policies.set(id, new NeuralPUCTAI(model, { simulations: 16, cPuct: 1.5 }));
      } else policies.set(id, new ModelFreeAI(await loadModelFreeModel(id)));
    }
  }
  return { candidates, policies, source_hashes, parentManifestRoot };
}
export function prefix(size, seed, steps, start) {
  const ep = { size, start, actions: [] }, e = replay(ep), random = rng(seed);
  for (let i = 0; i < steps && !e.gameOver; i++) {
    const legal = e.getLegalMoves(e.currentPlayer), player = e.currentPlayer;
    const point = legal.length ? legal[Math.floor(random.next() * legal.length)].point : null;
    const applied = point === null ? e.skipTurn() : e.playMove(point);
    if (!applied.success) throw new Error("Invalid random prefix");
    ep.actions.push({ player, point });
  }
  return ep.actions;
}
export function outcome(engine, candidateSeat) {
  if (!engine.gameOver) return null;
  GameEngine.prototype._updateTerritories.call(engine);
  const scores = Object.fromEntries(["BLACK", "WHITE"].map((p) => [p, engine.cachedTerritories[p].area]));
  const maximum = Math.max(...Object.values(scores));
  const leaders = Object.keys(scores).filter((p) => scores[p] === maximum);
  return { scores, leaders, candidateScore: leaders.includes(candidateSeat) ? 1 / leaders.length : 0 };
}
export function aggregate(games, candidates) {
  return { status: "COMPLETE_APPLICATION_SCREEN", promotionPass: false,
    decision: "Retain shipped defaults. This small paired screen is not a release gate or a multiplicity-adjusted strength confirmation.",
    terminalGames: games.filter((g) => g.terminal).length,
    truncatedGames: games.filter((g) => !g.terminal).length,
    models: candidates.map((m) => {
      const rows = games.filter((g) => g.modelId === m.id), done = rows.filter((g) => g.terminal);
      return { id: m.id, parent_model_id: m.parent_model_id, plannedGames: rows.length,
        terminalGames: done.length, truncatedGames: rows.length - done.length,
        wins: done.filter((g) => g.outcome.candidateScore === 1).length,
        draws: done.filter((g) => g.outcome.candidateScore === 0.5).length,
        losses: done.filter((g) => g.outcome.candidateScore === 0).length,
        meanScore: done.length === rows.length ? done.reduce((n, g) => n + g.outcome.candidateScore, 0) / done.length : null,
        perSize: Object.fromEntries([...new Set(rows.map((g) => g.size))].map((size) => {
          const sized = rows.filter((g) => g.size === size);
          return [size, sized.every((g) => g.terminal) ? sized.reduce((n, g) => n + g.outcome.candidateScore, 0) / sized.length : null];
        })) };
    }) };
}
export async function arenaMain(args) {
  const opt = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
  const runRoot = resolve(root, opt("--run-root", "local_artifacts/all-ai-posttraining-20261021/neural-arena"));
  const candidateManifestPath = resolve(root, opt("--candidates", "local_artifacts/all-ai-posttraining-20261021/neural-training/candidate-manifest.json"));
  // Fixture manifests may be isolated while their weight assets remain read-only.
  const parentManifestRoot = resolve(root, opt("--parent-manifests-root", assetRoot));
  const configPath = resolve(root, opt("--config", "web/tools/configs/neural-posttraining-arena-20261021.json"));
  const maxUnits = Number(opt("--max-new-units", "1000000")), maxSeconds = Number(opt("--max-seconds", "300"));
  const configBytes = await readFile(configPath), config = JSON.parse(configBytes);
  if (config.schema !== "lifeline-web-neural-screen-v1" || config.autoPromote !== false
      || config.puctSimulations !== 16 || !config.sizes.every((n) => [5, 7, 9].includes(n))
      || config.prefixesPerSize < 1 || config.maximumPlies < 1) throw new Error("Invalid screening protocol");
  await mkdir(runRoot, { recursive: true });
  const guard = await lease(runRoot);
  let cp, identity;
  const plans = [];
  const save = async (status) => {
    await atomic(resolve(runRoot, "checkpoint.json"), sealed(cp));
    await atomic(resolve(runRoot, "progress.json"), { status, identity, progress_units: cp.units,
      completed_games: cp.completed.length, planned_games: plans.length, current_game: cp.current?.id });
  };
  try {
    for (const name of await readdir(runRoot)) if (name.endsWith(".tmp")) {
      await rename(resolve(runRoot, name), resolve(runRoot, `${name}.interrupted-${Date.now()}`));
    }
    const loaded = await loadArenaModels(candidateManifestPath, { parentManifestRoot });
    const { candidates, policies } = loaded;
    const source_hashes = { ...loaded.source_hashes };
    for (const p of ["web/tools/neural-posttraining-arena-v2.mjs", "web/tools/neural-posttraining-data.mjs",
      "web/web前端/GameEngine.js", "web/web前端/AIEngine.js", "web/web前端/ResearchAI.js", "web/web前端/ModelFreeAI.js",
      ]) source_hashes[p] = sha(await readFile(resolve(root, p)));
    source_hashes[configPath] = sha(configBytes);
    identity = sha(JSON.stringify(source_hashes));
    for (const m of candidates) for (const size of config.sizes) for (let i = 0; i < config.prefixesPerSize; i++) {
      const cluster = `n${size}-p${i}`, seed = parseInt(sha(`${config.seedNamespace}/${cluster}`).slice(0, 8), 16);
      for (const candidateSeat of ["BLACK", "WHITE"]) {
        plans.push({ id: `${m.id}-${cluster}-${candidateSeat}`, modelId: m.id, parentId: m.parent_model_id,
          cluster, size, seed, start: i % 2 ? "WHITE" : "BLACK", candidateSeat });
      }
    }
    const previous = await readJson(resolve(runRoot, "checkpoint.json"), true);
    cp = previous ? unseal(previous) : { identity, units: 0, completed: [], current: null };
    if (cp.identity !== identity) throw new Error("Screen source/model/config drift");
    const games = [];
    if (cp.completed.length > plans.length) throw new Error("Unexpected completed-game count");
    for (const [index, ref] of cp.completed.entries()) {
      if (ref.path !== `games/${plans[index].id}.json`) throw new Error("Completed-game index/order mismatch");
      const bytes = await readFile(resolve(runRoot, ref.path));
      if (sha(bytes) !== ref.sha256) throw new Error("Completed game evidence changed");
      const game = JSON.parse(bytes);
      for (const [key, value] of Object.entries(plans[index])) {
        if (JSON.stringify(game[key]) !== JSON.stringify(value)) throw new Error("Completed game plan mismatch");
      }
      games.push(game);
    }
    if (cp.current) for (const [key, value] of Object.entries(plans[cp.completed.length] ?? {})) {
      if (JSON.stringify(cp.current[key]) !== JSON.stringify(value)) throw new Error("In-flight game plan mismatch");
    }
    await atomic(resolve(runRoot, "identity.json"), {
      identity, source_hashes, config, plannedGames: plans.length, parentManifestRoot,
      candidateManifestPath, configPath,
    });
    let newUnits = 0; const started = Date.now();
    while (cp.completed.length < plans.length) {
      for (const [file, status] of [["STOP", "STOPPED"], ["PAUSE", "PAUSED"]]) {
        try { await readFile(resolve(runRoot, file)); await save(status); return 75; }
        catch (e) { if (e.code !== "ENOENT") throw e; }
      }
      if (newUnits >= maxUnits || Date.now() - started >= maxSeconds * 1000) { await save("YIELDED"); return 75; }
      if (!cp.current) {
        const p = plans[cp.completed.length], actions = prefix(p.size, p.seed, config.prefixPlies, p.start);
        cp.current = { ...p, actions, prefixLength: actions.length, activityMs: 0 };
        await save("RUNNING");
      }
      const game = cp.current, engine = replay(game);
      if (engine.gameOver || game.actions.length >= config.maximumPlies || game.activityMs >= config.maximumGameMs) {
        const result = { ...game, terminal: engine.gameOver, truncated: !engine.gameOver,
          outcome: outcome(engine, game.candidateSeat) };
        const path = `games/${game.id}.json`;
        const expectedBytes = Buffer.from(`${JSON.stringify(result)}\n`);
        let existingBytes = null;
        try { existingBytes = await readFile(resolve(runRoot, path)); }
        catch (e) { if (e.code !== "ENOENT") throw e; }
        if (existingBytes) {
          // A process can exit after the complete file but before its index.
          // Adopt identical bytes without rewriting; preserve discrepancies.
          if (!existingBytes.equals(expectedBytes)) throw new Error(`Unindexed completed game does not match checkpoint: ${path}`);
        } else await atomic(resolve(runRoot, path), result);
        cp.completed.push({ path, sha256: sha(expectedBytes) });
        games.push(result); cp.current = null; cp.units++; newUnits++; await save("RUNNING"); continue;
      }
      const current = engine.currentPlayer, modelId = current === game.candidateSeat ? game.modelId : game.parentId;
      const t = performance.now(), move = policies.get(modelId).getTopMoves(engine, current, 1)[0];
      const point = move?.point ?? null;
      const applied = point === null ? engine.skipTurn() : engine.playMove(point);
      if (!applied.success) throw new Error("Model chose illegal action");
      game.activityMs += performance.now() - t;
      game.actions.push({ player: current, point, modelId });
      cp.units++; newUnits++; await save("RUNNING");
    }
    for (const [path, digest] of Object.entries(source_hashes)) {
      if (sha(await readFile(resolve(root, path))) !== digest) throw new Error(`Frozen screen input changed: ${path}`);
    }
    await atomic(resolve(runRoot, "summary.json"), { identity, ...aggregate(games, candidates) });
    await save("COMPLETE"); console.log(JSON.stringify({ status: "COMPLETE", games: games.length, identity }));
    return 0;
  } finally { await new Promise((done) => guard.close(done)); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await arenaMain(process.argv.slice(2)); }
  catch (e) { console.error(e.stack); process.exitCode = e.code === "EADDRINUSE" ? 76 : 78; }
}
