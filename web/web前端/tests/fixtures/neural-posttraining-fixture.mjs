import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GameEngine } from "../../GameEngine.js";
import { encodeResearchPosition, researchRelations, createResearchModel } from "../../ResearchAI.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const option = (key) => process.argv[process.argv.indexOf(key) + 1];
if (process.argv.includes("--create")) {
  const directory = resolve(option("--create"));
  await mkdir(resolve(directory, "episodes"), { recursive: true });
  const source = { "web/web前端/GameEngine.js": sha(await readFile(resolve(root, "web/web前端/GameEngine.js"))) };
  const identity = sha(JSON.stringify(source));
  const records = [];
  for (const [index, split] of ["train", "validation"].entries()) {
    const id = `fixture-${split}`, size = 5, start = index ? "WHITE" : "BLACK";
    const engine = new GameEngine({ gridSize: size, playerCount: 2, startPlayer: start, rulesVersion: "territory-v2" });
    const samples = [], actions = [];
    for (let ply = 0; ply < 5 && !engine.gameOver; ply++) {
      const encoded = encodeResearchPosition(engine), n = engine.validPositions.length;
      const features = [...encoded.features], legal = [...encoded.legal];
      const modelFreeState = Array(842).fill(0);
      for (let i = 0; i < n; i++) for (let j = 0; j < 7; j++) modelFreeState[i * 7 + j] = features[i * 11 + j];
      modelFreeState[840] = Math.fround(size / 15); modelFreeState[841] = features[10];
      const target = Array(n).fill(0);
      for (const action of legal) target[action] = 0.2 / legal.length;
      target[legal[0]] += 0.8;
      samples.push({ player: encoded.player, ply, features, relations: researchRelations(engine, encoded.player, true),
        legal, target, modelFreeState });
      const action = { player: engine.currentPlayer, point: engine.validPositions[legal[(ply + index) % legal.length]] };
      assert.equal(engine.playMove(action.point).success, true);
      actions.push(action);
    }
    const episode = { id, size, start, split, seed: index, actions, samples, terminal: engine.gameOver,
      truncated: !engine.gameOver, identity };
    const bytes = JSON.stringify(episode);
    const path = `episodes/${id}.json`;
    await writeFile(resolve(directory, path), bytes);
    records.push({ id, size, start, split, path, sha256: sha(bytes), samples: samples.length });
  }
  await writeFile(resolve(directory, "manifest.json"), JSON.stringify({
    schema: "lifeline-web-distillation-dataset-v1", rulesVersion: "territory-v2", identity,
    episodes: records, source_hashes: source, config_sha256: sha("fixture"),
  }));
  console.log(JSON.stringify({ status: "CREATED_BOUNDED_FIXTURE", directory }));
} else if (process.argv.includes("--parity")) {
  const probes = JSON.parse(await readFile(option("--parity"), "utf8"));
  const mlpSpecs = probes.filter((probe) => probe.spec.model_family);
  globalThis.fetch = async (url) => {
    const name = String(url).split("/").at(-1).split("?")[0];
    if (name === "model-free-manifest.json") return { ok: true, json: async () => ({
      schema: { name: "lifeline-web-model-free", version: 1 }, models: mlpSpecs.map((probe) => probe.spec),
    }) };
    const probe = mlpSpecs.find((item) => item.spec.asset.split("/").at(-1) === name);
    assert.ok(probe, `Unexpected model fetch: ${url}`);
    const raw = await readFile(probe.asset_path);
    return { ok: true, arrayBuffer: async () => raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) };
  };
  const { loadModelFreeModel } = await import("../../ModelFreeAI.js");
  let maxError = 0;
  for (const probe of probes) {
    const engine = new GameEngine({ gridSize: probe.size, playerCount: 2, startPlayer: probe.start, rulesVersion: "territory-v2" });
    for (const action of probe.actions) assert.equal(engine.playMove(action.point).success, true);
    let logits;
    if (probe.spec.model_kind) {
      const raw = await readFile(probe.asset_path);
      const model = createResearchModel(probe.spec, raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
      logits = [...model.evaluate(engine).pointScores];
    } else {
      const model = await loadModelFreeModel(probe.spec.id);
      logits = [...model.logits(Float32Array.from(probe.model_free_state))];
    }
    const legalLogits = probe.legal.map((i) => logits[i]), maximum = Math.max(...legalLogits);
    const exponentials = legalLogits.map((x) => Math.exp(x - maximum)), sum = exponentials.reduce((a, b) => a + b, 0);
    const probabilities = exponentials.map((x) => x / sum);
    probabilities.forEach((p, i) => {
      const error = Math.abs(p - probe.probabilities[i]);
      maxError = Math.max(error, maxError);
      assert.ok(error < 3e-5, `${probe.spec.id} Python/Web probability mismatch: ${error}`);
    });
  }
  console.log(JSON.stringify({ status: "PASS_PYTHON_WEB_F32_PARITY", probes: probes.length, max_probability_error: maxError }));
} else throw new Error("Use --create DATA_ROOT or --parity PROBES_JSON.");
