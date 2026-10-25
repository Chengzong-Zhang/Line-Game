// Strict bridge from complete, source-bound defensive labels to existing neural encoders.
import { readFile, mkdir, readdir, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDefensiveDataset } from "./train-defensive-policy-v1.mjs";
import { engineFromTrainingState, assertSourceBoundDefensiveSample } from "./defensive-training-data-v1.mjs";
import { encodeResearchPosition, researchRelations } from "../web前端/ResearchAI.js";
import { modelFreeState, atomic, lease, readJson, root, sealed, unseal, sha } from "./neural-posttraining-data-v2.mjs";

const SOURCES = ["web/tools/export-defensive-neural-v2.mjs", "web/tools/train-defensive-policy-v1.mjs",
  "web/tools/defensive-training-data-v1.mjs", "web/tools/neural-posttraining-data-v2.mjs",
  "web/web前端/ResearchAI.js", "web/web前端/ModelFreeAI.js"];
const check = (condition, message) => { if (!condition) throw new Error(message); };
export function encodeDefensiveNeuralSample(value) {
  assertSourceBoundDefensiveSample(value);
  const engine = engineFromTrainingState(value.sourceState);
  check(engine.playerCount === 2 && engine.boardShape === "triangle" && engine.gridSize >= 5 && engine.gridSize <= 15,
    "Neural parents require two-player triangular positions, sizes 5..15");
  const encoded = encodeResearchPosition(engine), n = engine.validPositions.length;
  const target = Array(n + 1).fill(0), legal = [];
  for (const move of value.label.moves) {
    const index = move.point === null ? n : engine._keyToIdx.get(move.point.join(","));
    check(Number.isInteger(index) && index >= 0 && index <= n && !legal.includes(index), "Invalid complete neural action index");
    legal.push(index); target[index] = move.target;
  }
  legal.sort((a, b) => a - b);
  check(JSON.stringify(legal) === JSON.stringify([...encoded.legal, n].sort((a, b) => a - b)), "Encoder and exact teacher legal sets disagree");
  return { schema: "lifeline-defensive-neural-sample-v2", id: value.id, split: value.split,
    size: engine.gridSize, nodeN: n, rulesVersion: engine.rulesVersion, player: engine.currentPlayer,
    features: Array.from(encoded.features), relations: researchRelations(engine, engine.currentPlayer, true),
    modelFreeState: modelFreeState(engine), legal, target, passIndex: n,
    sourceEvidence: value, sourceReceipt: { sourceStateHash: value.sourceStateHash,
      labelSha256: sha(JSON.stringify(value.label)), contract: value.label.contract, search: value.label.search } };
}

export async function exportNeuralMain(args) {
  const opt = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
  check(opt("--data-root", null) && opt("--output", null), "Use --data-root complete-defensive-labels --output isolated-export");
  const dataRoot = resolve(opt("--data-root")), output = resolve(opt("--output"));
  check(output !== dataRoot && !output.startsWith(dataRoot + "/") && !output.startsWith(dataRoot + "\\"), "Keep neural export separate from frozen labels");
  const dataset = await loadDefensiveDataset(dataRoot);
  const selected = dataset.samples.filter(value => value.sourceState.playerCount === 2 && value.sourceState.boardShape === "triangle");
  check(selected.length > 0 && ["train", "validation"].every(split => selected.some(row => row.split === split)), "Two-player subset needs independent train and validation positions");
  const splitStates = new Map();
  for (const row of selected) {
    check(!splitStates.has(row.sourceStateHash) || splitStates.get(row.sourceStateHash) === row.split, "Neural train/validation full-position leakage");
    splitStates.set(row.sourceStateHash, row.split);
  }
  const source_hashes = { ...dataset.manifest.source_hashes,
    ...Object.fromEntries(await Promise.all(SOURCES.map(async name => [name, sha(await readFile(resolve(root, name)))]))) };
  const identityBody = { schema: "lifeline-defensive-neural-dataset-v2", sourceRoot: dataRoot,
    sourceManifestHash: dataset.manifestHash, sourceIdentity: dataset.manifest.identity, source_hashes,
    selectedIds: selected.map(row => row.id), passContract: "sample-nodeN; padded-graph-final-column; mlp-sample-nodeN" };
  const identity = sha(JSON.stringify(identityBody));
  if (args.includes("--verify")) {
    const manifest = await readJson(resolve(output, "manifest.json"));
    check(manifest.identity === identity && manifest.schema === identityBody.schema && manifest.status === "COMPLETE_DEFENSIVE_NEURAL_EXPORT"
      && JSON.stringify(manifest.source_hashes) === JSON.stringify(source_hashes)
      && manifest.samples?.length === selected.length, "Neural export identity/inventory mismatch");
    for (const [i, record] of manifest.samples.entries()) {
      check(record.id === selected[i].id && record.split === selected[i].split && record.path === `samples/${record.id}.json`, "Neural export record mismatch");
      const raw = await readFile(resolve(output, record.path));
      check(sha(raw) === record.sha256 && JSON.stringify(unseal(JSON.parse(raw))) === JSON.stringify(encodeDefensiveNeuralSample(selected[i])), "Neural export tensor/source evidence tampering");
    }
    return 0;
  }
  const maxUnits = Number(opt("--max-new-units", "1000000"));
  check(Number.isInteger(maxUnits) && maxUnits >= 0, "Invalid export unit budget");
  await mkdir(output, { recursive: true });
  const guard = await lease(output);
  try {
    for (const name of await readdir(output)) if (name.endsWith(".tmp")) await rename(resolve(output, name), resolve(output, `${name}.interrupted-${Date.now()}`));
    const prior = await readJson(resolve(output, "checkpoint.json"), true);
    const cp = prior ? unseal(prior) : { identity, completed: [], units: 0 };
    check(cp.identity === identity && cp.units === cp.completed.length && cp.units <= selected.length, "Neural export checkpoint corruption");
    const save = async status => {
      await atomic(resolve(output, "checkpoint.json"), sealed(cp));
      await atomic(resolve(output, "progress.json"), { identity, status, progress_units: cp.units, total_samples: selected.length });
    };
    for (const [i, record] of cp.completed.entries()) {
      check(record.id === selected[i].id && record.path === `samples/${record.id}.json`, "Neural completed export order corruption");
      const raw = await readFile(resolve(output, record.path));
      check(sha(raw) === record.sha256 && JSON.stringify(unseal(JSON.parse(raw))) === JSON.stringify(encodeDefensiveNeuralSample(selected[i])), "Completed neural sample changed");
    }
    let units = 0;
    while (cp.units < selected.length) {
      for (const [file, status] of [["STOP", "STOPPED"], ["PAUSE", "PAUSED"]]) {
        try { await readFile(resolve(output, file)); await save(status); return 75; }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      if (units >= maxUnits) { await save("YIELDED"); return 75; }
      const value = encodeDefensiveNeuralSample(selected[cp.units]), path = `samples/${value.id}.json`;
      const existing = await readJson(resolve(output, path), true);
      if (existing) check(JSON.stringify(unseal(existing)) === JSON.stringify(value), "Unindexed neural sample changed");
      else await atomic(resolve(output, path), sealed(value));
      if (args.includes("--fault-after-sample-write")) return 79;
      cp.completed.push({ id: value.id, split: value.split, size: value.size, nodeN: value.nodeN,
        rulesVersion: value.rulesVersion, path, sha256: sha(await readFile(resolve(output, path))) });
      cp.units++; units++; await save("RUNNING");
    }
    check((await loadDefensiveDataset(dataRoot)).manifestHash === dataset.manifestHash, "Defensive source changed during export");
    for (const [name, expected] of Object.entries(source_hashes)) check(sha(await readFile(resolve(root, name))) === expected, "Neural encoder source changed");
    await atomic(resolve(output, "manifest.json"), { ...identityBody, identity, samples: cp.completed,
      status: "COMPLETE_DEFENSIVE_NEURAL_EXPORT", strength_verified: false, runtime_admitted: false });
    await save("COMPLETE"); return 0;
  } finally { await new Promise(done => guard.close(done)); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await exportNeuralMain(process.argv.slice(2)); }
  catch (error) { console.error(error.stack); process.exitCode = error.code === "EADDRINUSE" ? 76 : 78; }
}
