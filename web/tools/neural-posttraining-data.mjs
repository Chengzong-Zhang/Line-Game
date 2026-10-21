// Web-rule data generation. No Python rule approximation enters teacher labels.
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { readFile, writeFile, mkdir, rename, readdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { GameEngine } from "../web前端/GameEngine.js";
import { MinimaxAI, saveState, restoreState } from "../web前端/AIEngine.js";
import { encodeResearchPosition, researchRelations } from "../web前端/ResearchAI.js";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const sealed = (body) => ({ ...body, integrity: sha(JSON.stringify(body)) });
export function unseal(value) {
  const { integrity, ...body } = value;
  if (integrity !== sha(JSON.stringify(body))) throw new Error("Corrupt evidence integrity");
  return body;
}
export async function atomic(path, body) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(body)}\n`);
  for (let n = 0; ; n++) {
    try { await rename(temp, path); return; }
    catch (e) {
      if (!["EPERM", "EBUSY", "EACCES"].includes(e.code) || n >= 7) throw e;
      await new Promise((done) => setTimeout(done, 20 * (n + 1)));
    }
  }
}
export async function readJson(path, optional = false) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (e) { if (optional && e.code === "ENOENT") return null; throw e; }
}
export async function lease(path) {
  const server = createServer((s) => s.destroy());
  const port = 40000 + parseInt(sha(resolve(path).toLowerCase()).slice(0, 8), 16) % 20000;
  await new Promise((done, fail) => {
    server.once("error", fail);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, done);
  });
  server.unref();
  return server;
}
export function rng(seed) {
  return { state: seed >>> 0, next() {
    this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0;
    return this.state / 4294967296;
  } };
}
export function replay(episode) {
  const engine = new GameEngine({ gridSize: episode.size, playerCount: 2,
    startPlayer: episode.start, rulesVersion: "territory-v2" });
  engine._isReplayingBatch = true;
  for (const action of episode.actions ?? []) {
    if (engine.gameOver || action.player !== engine.currentPlayer) throw new Error("Replay actor mismatch");
    const applied = action.point === null ? engine.skipTurn() : engine.playMove(action.point);
    if (!applied.success) throw new Error("Illegal replay action");
  }
  return engine;
}
export function modelFreeState(engine) {
  const encoded = encodeResearchPosition(engine), output = Array(842).fill(0);
  for (let i = 0; i < engine.validPositions.length; i++) {
    for (let f = 0; f < 7; f++) output[i * 7 + f] = encoded.features[i * 11 + f];
  }
  output[840] = Math.fround(engine.gridSize / 15);
  output[841] = Math.fround(Math.min(Math.max(engine.consecutiveSkips, 0), 2) / 2);
  return output;
}
export function teacherSample(engine, config, ply) {
  const encoded = encodeResearchPosition(engine);
  if (!encoded.legal.length) return null;
  const before = saveState(engine);
  let moves;
  try { moves = new MinimaxAI(config.teacherDepth).getTopMoves(engine, engine.currentPlayer, 999); }
  finally { restoreState(engine, before); }
  if (!moves.length || moves.some((m) => !Number.isFinite(m.score))) throw new Error("Invalid teacher");
  const maximum = Math.max(...moves.map((m) => m.score));
  const exps = moves.map((m) => Math.exp((m.score - maximum) / config.teacherTemperature));
  const total = exps.reduce((a, b) => a + b, 0);
  const target = Array(engine.validPositions.length).fill(0);
  for (const i of encoded.legal) target[i] = config.uniformTargetMix / encoded.legal.length;
  moves.forEach((m, i) => { target[engine._keyToIdx.get(m.point.join(","))] += (1 - config.uniformTargetMix) * exps[i] / total; });
  return { ply, player: engine.currentPlayer, features: Array.from(encoded.features),
    relations: researchRelations(engine, engine.currentPlayer, true), legal: encoded.legal,
    target, modelFreeState: modelFreeState(engine) };
}
export async function dataMain(args) {
  const opt = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
  const runRoot = resolve(root, opt("--run-root", "local_artifacts/all-ai-posttraining-20261021/neural-data"));
  const configPath = resolve(root, opt("--config", "web/tools/configs/neural-posttraining-data-20261021.json"));
  const maxUnits = Number(opt("--max-new-units", "1000000"));
  const maxSeconds = Number(opt("--max-seconds", "300"));
  const rawConfig = await readFile(configPath), config = JSON.parse(rawConfig);
  if (config.schema !== "lifeline-web-distillation-data-config-v1" || config.rulesVersion !== "territory-v2"
      || !config.sizes?.every((n) => Number.isInteger(n) && n >= 5 && n <= 15)
      || config.teacherDepth !== 2 || config.teacherTemperature <= 0
      || config.trainReplicates < 1 || config.validationReplicates < 1
      || config.maximumPlies < 2 || config.uniformTargetMix <= 0 || config.uniformTargetMix >= 1
      || config.teacherBehaviorProbability <= 0 || config.teacherBehaviorProbability >= 1) throw new Error("Invalid data protocol");
  await mkdir(runRoot, { recursive: true });
  const guard = await lease(runRoot);
  let cp, identity;
  const save = async (status) => {
    await atomic(resolve(runRoot, "checkpoint.json"), sealed(cp));
    await atomic(resolve(runRoot, "progress.json"), { status, identity, progress_units: cp.units,
      completed_episodes: cp.completed.length, total_episodes: plans.length, current_episode: cp.current?.id });
  };
  const plans = [];
  for (const size of config.sizes) for (const split of ["train", "validation"]) {
    for (let i = 0; i < (split === "train" ? config.trainReplicates : config.validationReplicates); i++) {
      const id = `n${size}-${split}-${i}`;
      plans.push({ id, size, split, start: i % 2 ? "WHITE" : "BLACK",
        seed: parseInt(sha(`${config.seedNamespace}/${id}`).slice(0, 8), 16) });
    }
  }
  try {
    // Incomplete atomic writes are evidence; preserve them separately.
    for (const name of await readdir(runRoot)) if (name.endsWith(".tmp")) {
      await rename(resolve(runRoot, name), resolve(runRoot, `${name}.interrupted-${Date.now()}`));
    }
    const sourcePaths = ["web/tools/neural-posttraining-data.mjs", "web/web前端/GameEngine.js",
      "web/web前端/AIEngine.js", "web/web前端/ResearchAI.js", "web/web前端/AIStateProtocol.js"];
    const source_hashes = Object.fromEntries(await Promise.all(sourcePaths.map(async (p) => [p, sha(await readFile(resolve(root, p)))])));
    const config_sha256 = sha(rawConfig);
    identity = sha(JSON.stringify({ source_hashes, config_sha256 }));
    const old = await readJson(resolve(runRoot, "checkpoint.json"), true);
    cp = old ? unseal(old) : { identity, completed: [], current: null, units: 0 };
    if (cp.identity !== identity) throw new Error("Source/config identity drift");
    for (const item of cp.completed) {
      const bytes = await readFile(resolve(runRoot, item.path));
      if (sha(bytes) !== item.sha256) throw new Error("Completed episode changed");
    }
    const started = Date.now();
    let newUnits = 0;
    while (cp.completed.length < plans.length) {
      for (const [file, status] of [["STOP", "STOPPED"], ["PAUSE", "PAUSED"]]) {
        try { await readFile(resolve(runRoot, file)); await save(status); return 75; }
        catch (e) { if (e.code !== "ENOENT") throw e; }
      }
      if (newUnits >= maxUnits || Date.now() - started >= maxSeconds * 1000) { await save("YIELDED"); return 75; }
      if (!cp.current) {
        const plan = plans[cp.completed.length];
        cp.current = { ...plan, actions: [], samples: [], rng: plan.seed };
        await save("RUNNING");
      }
      const ep = cp.current, engine = replay(ep);
      if (engine.gameOver || ep.actions.length >= config.maximumPlies) {
        const finished = { ...ep, terminal: engine.gameOver, truncated: !engine.gameOver,
          rulesVersion: "territory-v2", datasetIdentity: identity };
        const path = `episodes/${ep.id}.json`;
        await atomic(resolve(runRoot, path), finished);
        cp.completed.push({ id: ep.id, size: ep.size, start: ep.start, split: ep.split, path,
          sha256: sha(await readFile(resolve(runRoot, path))), samples: ep.samples.length,
          terminal: finished.terminal, truncated: finished.truncated });
        cp.current = null; cp.units++; newUnits++;
        await save("RUNNING"); continue;
      }
      const sample = teacherSample(engine, config, ep.actions.length);
      const random = rng(ep.rng);
      let point = null;
      if (sample) {
        let index;
        if (random.next() < config.teacherBehaviorProbability) {
          let draw = random.next();
          index = sample.legal.at(-1);
          for (const i of sample.legal) { draw -= sample.target[i]; if (draw <= 0) { index = i; break; } }
        } else index = sample.legal[Math.floor(random.next() * sample.legal.length)];
        point = [...engine.validPositions[index]];
        ep.samples.push(sample);
      }
      const player = engine.currentPlayer;
      const applied = point === null ? engine.skipTurn() : engine.playMove(point);
      if (!applied.success) throw new Error("Generated action illegal");
      ep.actions.push({ player, point }); ep.rng = random.state;
      cp.units++; newUnits++;
      await save("RUNNING");
    }
    const manifest = { schema: "lifeline-web-distillation-dataset-v1", rulesVersion: "territory-v2",
      identity, episodes: cp.completed, source_hashes, config_sha256,
      teacher: "Existing Web Minimax depth 2; heuristic root/reply shortlist capped at 20, not exhaustive minimax.",
      limitations: "Truncated prefixes are imitation data only, never treated as terminal outcomes." };
    await atomic(resolve(runRoot, "manifest.json"), manifest);
    await save("COMPLETE");
    console.log(JSON.stringify({ status: "COMPLETE", episodes: cp.completed.length,
      samples: cp.completed.reduce((n, ep) => n + ep.samples, 0), identity }));
    return 0;
  } finally { await new Promise((done) => guard.close(done)); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await dataMain(process.argv.slice(2)); }
  catch (e) { console.error(e.stack); process.exitCode = e.code === "EADDRINUSE" ? 76 : 78; }
}
