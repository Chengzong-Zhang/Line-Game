import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash, webcrypto } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";
import { performance } from "node:perf_hooks";
import { nativeWebCompatibility } from "../../../wechat/minigame/tools/web-compat.mjs";

// Synthetic coefficients test real loader/ranking paths without replacing the
// in-progress training data or claiming that these fixtures are trained models.
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const web = path.join(repo, "web/web前端"), mini = path.join(repo, "wechat/minigame");
const { build } = createRequire(path.join(mini, "package.json"))("esbuild");
const sha = value => createHash("sha256").update(value).digest("hex");
const plain = value => JSON.parse(JSON.stringify(value));
const asset = async filename => JSON.parse(await readFile(path.join(web, "assets/research-ai", filename), "utf8"));
const parents = {
  easy: (await asset("multiplayer-v1/easy.json")).models[0],
  "three-v1": await asset("three-player-policy-v1.json"),
  "three-v4": await asset("three-player-search-v4-round12.json"),
  "hex-v1": await asset("hex-player-policy-v1.json"),
};
const dataPath = path.join(web, "PassTrainedPolicyData.js"), beforeData = sha(await readFile(dataPath));
const data = { schema: "lifeline-terminal-trained-policies-v4", revision: "synthetic-runtime-routing-test-only",
  activation: "EVALUATION_ONLY", reward: { gamma: 1, nonterminal_reward: 0, type: "terminal-outcome-native-margin-area-v1" },
  models: Object.fromEntries(Object.entries(parents).map(([alias, parent]) => [alias, {
    id: `synthetic-${alias}`, parent_id: parent.id, parent_weights: parent.weights,
    parent_temperature: parent.temperature, parent_sha256: sha(JSON.stringify(parent)),
    candidate_sha256: sha(`synthetic-candidate-${alias}`), training_identity: sha(`synthetic-identity-${alias}`),
    weights: [...Array(16).fill(0), 100], passBias: 100, updates: 1, naturally_completed_episodes: 1,
    truncated_episodes: 0, training_samples: 2, minimum_completed_depth: 3,
  }])) };
const inject = { name: "synthetic-terminal-policy-data", setup(build) {
  build.onLoad({ filter: /PassTrainedPolicyData\.js$/ }, () => ({
    contents: `export const PASS_TRAINED_POLICY_DATA=${JSON.stringify(data)};`, loader: "js" }));
} };
const queries = { name: "queries", setup(build) {
  build.onResolve({ filter: /\?v=/ }, args => ({ path: path.resolve(args.resolveDir, args.path.split("?")[0]) }));
} };
const exportsFor = native => `
export {GameEngine} from ${JSON.stringify(path.join(web, "GameEngine.js"))};
export {MinimaxAI} from ${JSON.stringify(path.join(web, "AIEngine.js"))};
export {loadMultiplayerRuntime,createMediumRuntime} from ${JSON.stringify(path.join(web, "MultiplayerRuntime.js"))};
${native ? `export {createEmbeddedThreePlayerAI} from ${JSON.stringify(path.join(mini, "src/three-player-ai.js"))};
export {createEmbeddedHexPlayerAI} from ${JSON.stringify(path.join(mini, "src/hex-player-ai.js"))};
export {createEmbeddedMultiplayerRuntime} from ${JSON.stringify(path.join(mini, "src/multiplayer-ai.js"))};`
  : `export {loadThreePlayerRuntime} from ${JSON.stringify(path.join(web, "ThreePlayerRuntime.js"))};
export {loadHexPlayerRuntime} from ${JSON.stringify(path.join(web, "HexPlayerRuntime.js"))};
export {prepareHardResources} from ${JSON.stringify(path.join(web, "MultiplayerHardResources.js"))};`}
`;

async function api(native) {
  const compatibility = await nativeWebCompatibility(repo, new Set());
  const compiled = await build({ stdin: { contents: exportsFor(native), resolveDir: repo }, bundle: true, write: false,
    format: "iife", globalName: "SUT", platform: "browser", target: "es2018", logLevel: "silent",
    define: { "import.meta.url": native ? "undefined" : JSON.stringify(new URL("../GameEngine.js", import.meta.url).href) },
    plugins: [queries, inject, ...(native ? [compatibility.plugin] : [])] });
  const globals = native ? { performance } : { performance, URL, Response, TextDecoder, TextEncoder, structuredClone, crypto: webcrypto,
    fetch: async input => new Response(await readFile(fileURLToPath(input instanceof URL ? input : new URL(input)))) };
  const context = vm.createContext(globals);
  vm.runInContext(compiled.outputFiles[0].text, context, { timeout: 10000 });
  return context.SUT;
}

const browser = await api(false), native = await api(true), rows = [];
const make = (sut, rulesVersion, playerCount, gridSize = 5) =>
  new sut.GameEngine({ rulesVersion, playerCount, gridSize, deferTerritoryUpdates: true });
const info = (modelInfo, alias, active, learned) => {
  assert.equal(Boolean(modelInfo.passDisciplineTraining), active);
  assert.equal(Boolean(modelInfo.terminalPolicyTraining), active);
  assert.equal(modelInfo.runtime_uses_learned_pass, learned && active);
  assert.equal(modelInfo.runtime_uses_trained_placement, active);
  if (active) assert.equal(modelInfo.terminalPolicyTraining.candidate_sha256, data.models[alias].candidate_sha256);
};

for (const rulesVersion of ["territory-v2", "territory-v3"]) {
  const active = rulesVersion === "territory-v3";
  for (const [alias, players, size, modelId] of [["three-v1", 3, 6, "three-player-policy-v1"],
    ["hex-v1", 4, 5, "hex-player-policy-v1"]]) {
    const source = make(browser, rulesVersion, players, size);
    const runtime = players === 3 ? await browser.loadThreePlayerRuntime(modelId, source) : await browser.loadHexPlayerRuntime(modelId, source);
    info(runtime.modelInfo, alias, active, true);
    assert.equal(runtime.ai.getTopMoves(source, source.currentPlayer, 1)[0].point === null, active,
      `${alias}: trained PASS must actually participate in the direct Web ranking`);
    const embedded = players === 3 ? native.createEmbeddedThreePlayerAI(modelId, rulesVersion)
      : await native.createEmbeddedHexPlayerAI(modelId, rulesVersion);
    const miniSource = make(native, rulesVersion, players, size);
    assert.equal(embedded.getTopMoves(miniSource, miniSource.currentPlayer, 1)[0].point === null, active,
      `${alias}: trained PASS must actually participate in the direct Mini ranking`);
    assert.equal(Boolean(embedded.model.spec.passDisciplineTraining), active);
    rows.push({ alias, rulesVersion, directWebAndMiniLearnedPass: active });
  }
  for (const [alias, players, size, profile, learned] of [["easy", 3, 5, "multiplayer-easy-v1", true],
    ["three-v4", 3, 5, "multiplayer-medium-v1", false], ["three-v1", 3, 6, "multiplayer-medium-v1", true],
    ["hex-v1", 4, 5, "multiplayer-medium-v1", true]]) {
    const source = make(browser, rulesVersion, players, size);
    const runtime = await browser.loadMultiplayerRuntime(profile, source);
    info(runtime.modelInfo, alias, active, learned);
    const moves = runtime.ai.getTopMoves(source, source.currentPlayer, 1);
    assert.ok(moves.length > 0);
    if (active && learned) assert.equal(runtime.ai.lastSearch.includesLearnedPass, true);
    if (!learned) assert.ok(Array.isArray(moves[0].point), "Original v4 search retains its placement-only root contract");
    const miniSource = make(native, rulesVersion, players, size);
    const embedded = await native.createEmbeddedMultiplayerRuntime(profile, miniSource);
    info(embedded.modelInfo, alias, active, learned);
    assert.ok(embedded.ai.getTopMoves(miniSource, miniSource.currentPlayer, 1).length > 0);
    if (active && learned) assert.equal(embedded.ai.lastSearch.includesLearnedPass, true);
    if (profile === "multiplayer-medium-v1") {
      const prepared = await browser.prepareHardResources(source);
      assert.equal(Boolean(prepared.medium.policySpec.passDisciplineTraining), active);
      if (active) assert.equal(prepared.medium.policySpec.passDisciplineTraining.candidate_sha256, data.models[alias].candidate_sha256);
    }
    rows.push({ alias, profile, rulesVersion, active, runtimeUsesLearnedPass: active && learned });
  }
}

// Same saved position and actual fixed depth, without device/browser claims.
const canonicalAI = await readFile(path.join(web, "AIEngine.js"), "utf8");
const compatibility = await nativeWebCompatibility(repo, new Set());
const nativeAI = (await compatibility.load({ path: path.join(web, "AIEngine.js") })).contents.toString("utf8");
const normalizeQueries = text => text.replace(/\?v=[^"']+/g, "?v=normalized").replace(/\r\n/g, "\n");
assert.equal(normalizeQueries(canonicalAI), normalizeQueries(nativeAI), "Mini AIEngine compatibility may change import versions only");
const timing = [];
for (const depth of [2, 4]) {
  const result = [];
  for (const [platform, sut] of [["Web-source", browser], ["Mini-native-adapter", native]]) {
    const source = make(sut, "territory-v3", 2);
    for (const point of [[1, 0], [3, 1]]) assert.equal(source.playMove(point).success, true);
    const before = JSON.stringify(source._captureReplayState()), started = performance.now();
    const moves = new sut.MinimaxAI(depth).getTopMoves(source, source.currentPlayer, 3);
    timing.push({ platform, depth, elapsedMs: performance.now() - started });
    assert.equal(JSON.stringify(source._captureReplayState()), before);
    result.push(plain(moves));
  }
  assert.deepEqual(result[0], result[1], `Depth ${depth}: exact Web/Mini Minimax result must match`);
}
assert.equal(sha(await readFile(dataPath)), beforeData, "Synthetic test must not alter real training data");
console.log(JSON.stringify({ status: "PASS_TRAINED_RUNTIME_V4_ROUTING", syntheticOverlayOnly: true,
  rows, minimaxSameFixture: { rulesVersion: "territory-v3", gridSize: 5, prefix: [[1, 0], [3, 1]],
    exactOutputsMatch: true, nativeAIEngineMatchesExceptImportVersions: true, timing,
    scope: "Node source/native-adapter comparison; not browser or phone latency" } }));
