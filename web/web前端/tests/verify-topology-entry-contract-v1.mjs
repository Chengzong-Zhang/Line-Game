import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import "../TopologyGameEngine.js";
import { GameEngine, TopologyRulesVersion } from "../GameEngine.js";
import {
  createCylinderBoardDefinition,
  createKleinBottleBoardDefinition,
  createMobiusBoardDefinition,
  createTorusBoardDefinition,
} from "../BoardPresets.js";
import {
  addBoundaryVertex,
  closeBoundaryDraft,
  createBoardDraft,
} from "../BoardEditor.js";
import { generateBoard } from "../RandomBoard.js";
import { describeTopologyAI, TOPOLOGY_AI_ROUTE } from "../TopologyAIAdapter.js";
import "../BoardView.js";

const topologyFactory = globalThis[Symbol.for("lifeline.topology-game-engine-factory.v1")];
const boardViewRuntime = globalThis[Symbol.for("lifeline.topology-board-view-runtime.v1")];
assert.equal(typeof topologyFactory, "function", "topology engine must register before custom-board construction");
assert.equal(typeof boardViewRuntime?.projectBoard, "function", "BoardView must expose the production rendering runtime");
assert.equal(typeof boardViewRuntime?.projectPath, "function");
assert.equal(typeof boardViewRuntime?.hitTestBoard, "function");

function openTopologyBoard(definition, label) {
  const engine = new GameEngine({
    boardDefinition: definition,
    rulesVersion: TopologyRulesVersion.SURFACE_V1,
    playerCount: 2,
  });
  const snapshot = engine.getSnapshot();
  assert.equal(engine.isTopologyBoard, true, label + " must create a topology engine");
  assert.equal(engine.rulesVersion, TopologyRulesVersion.SURFACE_V1, label + " must use surface-v1");
  assert.equal(snapshot.isTopologyBoard, true, label + " snapshot must retain its topology identity");
  assert.equal(snapshot.boardDefinition.schemaVersion, 1, label + " snapshot must carry a full board definition");
  assert.equal(typeof snapshot.boardHash, "string", label + " snapshot must carry boardHash");
  assert.ok(snapshot.boardHash.length > 0, label + " boardHash must be non-empty");
  const ai = describeTopologyAI(engine.compiledBoard);
  assert.equal(ai.route, TOPOLOGY_AI_ROUTE, label + " exposes only the generic topology route");
  assert.equal(ai.fixedShapeModelsAllowed, false, label + " must reject fixed-shape models");
  return engine;
}

const presets = [
  ["cylinder", createCylinderBoardDefinition()],
  ["mobius", createMobiusBoardDefinition()],
  ["torus", createTorusBoardDefinition()],
  ["klein", createKleinBottleBoardDefinition()],
];
for (const [label, definition] of presets) openTopologyBoard(definition, label);

const random = generateBoard({
  width: 5,
  height: 5,
  playerCount: 2,
  roughness: 0.5,
  minimumChannelWidth: 2,
  minStartDistance: 2,
  maxAttempts: 32,
}, "topology-entry-contract-seed");
assert.equal(random.ok, true, JSON.stringify(random.errors));
const randomEngine = openTopologyBoard(random.definition, "seeded random board");
assert.equal(randomEngine.compiledBoard.definition.generator.seed, "topology-entry-contract-seed");

let draft = createBoardDraft();
for (const coordinate of [[0, 0], [1, 0], [2, 0], [2, 1], [2, 2], [1, 2], [0, 2], [0, 1]]) {
  const result = addBoundaryVertex(draft, coordinate);
  assert.equal(result.ok, true, JSON.stringify(result));
  draft = result.draft;
}
const custom = closeBoundaryDraft(draft);
assert.equal(custom.ok, true, JSON.stringify(custom));
openTopologyBoard(custom.definition, "editor custom board");

const mainUrl = new URL("../main.js", import.meta.url);
const mainSource = await readFile(fileURLToPath(mainUrl), "utf8");
const indexUrl = new URL("../index.html", import.meta.url);
const indexSource = await readFile(fileURLToPath(indexUrl), "utf8");
const assetVersion = mainSource.match(/APP_ASSET_VERSION = "([^"]+)"/)?.[1];
assert.ok(assetVersion && assetVersion.slice(0, 8) >= "20261029",
  "the repair must invalidate caches from the earlier topology entry");
assert.ok(indexSource.includes("styles.css?v=" + assetVersion),
  "the production stylesheet and bootstrap must share the current asset version");
assert.ok(indexSource.includes("main.js?v=" + assetVersion),
  "the production entry and bootstrap must share the current asset version");
assert.match(mainSource, /TopologyGameEngine\.js/, "main entry must load the topology engine before the Vue app");
assert.match(mainSource, /BoardView\.js/, "main entry must load BoardView so the renderer can use its registered topology projection");
const bootstrapInstallIndex = mainSource.indexOf("await installTopologyRuntime();");
const bootstrapAppImportIndex = mainSource.indexOf("await importAppModule();");
assert.ok(bootstrapInstallIndex >= 0 && bootstrapAppImportIndex >= 0
  && bootstrapInstallIndex < bootstrapAppImportIndex,
"topology runtime installation must finish before the application module is imported");

console.log(JSON.stringify({
  status: "PASS",
  coverage: [
    "topology engine and BoardView runtime registration",
    "cylinder, mobius, torus and klein surface-v1 entry payloads",
    "seeded random and editor-produced custom BoardDefinition payloads",
    "topology-generic AI capability without fixed-shape models",
    "production main entry dependencies",
  ],
}));
