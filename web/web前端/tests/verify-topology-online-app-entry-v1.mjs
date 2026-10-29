import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { compileBoard } from "../BoardCompiler.js";
import {
  normalizeGameSettings,
} from "../OnlineAppState.js";
import { CONCAVE_GAP_DEFINITION } from "./fixtures/board-topology-v1-fixtures.mjs";

/*
 * Application-entry contract
 * --------------------------
 *
 * OnlineRoomSync rejects invalid topology room snapshots, but the Vue app
 * owns `roomInfo` and used to commit it before asking that coordinator.  This
 * regression keeps that authority ordering visible without constructing Vue or
 * a browser DOM:
 *
 *  1. OnlineAppState must preserve a valid surface-v1/custom map verbatim;
 *     normalising it as a legacy triangle silently changes the game.
 *  2. OnlineApp must call validateTopologyRoomSnapshot before applyRoomPayload
 *     can assign roomInfo, and must retain map identity in the reconnect
 *     session settings.
 *  3. The application must explicitly give its topology capability to the
 *     NetworkManager, rather than relying on an incidental default.
 *
 * The static wiring checks are deliberately paired with the runtime settings
 * checks above.  RoomSync itself is covered independently by
 * verify-topology-online-v1.mjs.
 */

const compiled = compileBoard(CONCAVE_GAP_DEFINITION);
assert.equal(compiled.ok, true, JSON.stringify(compiled.errors));

const topologySettings = {
  playerCount: 2,
  gridSize: 9,
  boardShape: "custom",
  rulesVersion: "surface-v1",
  boardDefinition: structuredClone(compiled.value.definition),
  boardHash: compiled.value.boardHash,
  topologyProtocolVersion: "board-topology-v1",
  botCount: 0,
  startPlayer: "BLACK",
  turnTimerEnabled: false,
  hintEnabled: false,
  undoEnabled: true,
  undoMaxCount: 3,
};

const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

const normalized = normalizeGameSettings(topologySettings);
check(normalized.boardShape === "custom",
  "normalizeGameSettings must retain a topology boardShape instead of falling back to triangle.");
check(normalized.rulesVersion === "surface-v1",
  "normalizeGameSettings must retain surface-v1 instead of a legacy territory rules version.");
check(JSON.stringify(normalized.boardDefinition) === JSON.stringify(topologySettings.boardDefinition),
  "normalizeGameSettings must retain the full canonical boardDefinition.");
check(normalized.boardHash === topologySettings.boardHash,
  "normalizeGameSettings must retain the canonical boardHash.");
check(normalized.topologyProtocolVersion === "board-topology-v1",
  "normalizeGameSettings must retain the negotiated topology protocol version.");
check(normalized.botCount === 0,
  "Topology settings must not acquire a legacy bot slot while normalising.");

const appUrl = new URL("../OnlineApp.js", import.meta.url);
const appSource = await readFile(appUrl, "utf8");

// Topology setup materializes fixed canonical starts in an isolated engine.
// Keep this source-level guard because the panel path is normally exercised
// only in a browser, where an omitted default import would otherwise first
// appear as a user-facing ReferenceError.
if (appSource.includes("new GameEngine(")) {
  check(/import\s+GameEngine\s*,[\s\S]{0,240}?from\s*["']\.\/GameEngine\.js(?:\?[^"']*)?["']/.test(appSource),
    "OnlineApp materializes topology definitions with new GameEngine, so it must import GameEngine as the default binding.");
}

const topologyPanelStart = appSource.indexOf("<TopologySetupPanel");
check(topologyPanelStart >= 0,
  "OnlineApp must mount the topology setup panel rather than only registering its component.");
for (const handler of [
  "selectTopologyPreset",
  "generateTopologyBoard",
  "addTopologyDraftVertex",
  "closeTopologyDraft",
  "loadTopologyDefinitionText",
]) {
  const first = appSource.indexOf(handler);
  const last = appSource.lastIndexOf(handler);
  check(first >= 0 && last > first && last > topologyPanelStart,
    `OnlineApp topology setup must bind ${handler} from a real panel event.`);
}
check((appSource.match(/createSurfacePreset/g) ?? []).length >= 2,
  "A topology preset import is not enough: OnlineApp must invoke createSurfacePreset.");
check((appSource.match(/generateBoard/g) ?? []).length >= 2,
  "A random-board import is not enough: OnlineApp must invoke generateBoard.");

const syncSessionStart = appSource.indexOf("const syncSession =");
const syncSessionEnd = appSource.indexOf("const setAuthState =", syncSessionStart);
const syncSessionSource = syncSessionStart >= 0 && syncSessionEnd > syncSessionStart
  ? appSource.slice(syncSessionStart, syncSessionEnd)
  : "";
check(syncSessionSource.includes("boardDefinition") && syncSessionSource.includes("boardHash"),
  "OnlineApp syncSession must persist boardDefinition and boardHash for reconnect, not only legacy scalar settings.");

const applySettingsStart = appSource.indexOf("const applySettingsToController =");
const applySettingsEnd = appSource.indexOf("const loadTutorialLevel =", applySettingsStart);
const applySettingsSource = applySettingsStart >= 0 && applySettingsEnd > applySettingsStart
  ? appSource.slice(applySettingsStart, applySettingsEnd)
  : "";
const legacyStartsCall = applySettingsSource.indexOf("startingPointSettings(normalized)");
const topologyStartsGuard = /isTopologyGameSettings\(normalized\)|normalized\.boardShape\s*===\s*["']custom["']/.exec(
  legacyStartsCall >= 0 ? applySettingsSource.slice(0, legacyStartsCall) : applySettingsSource,
);
check(legacyStartsCall < 0 || Boolean(topologyStartsGuard),
  "OnlineApp must bypass legacy startingPointSettings for canonical topology start IDs before configuring the controller.");

const applySnapshotStart = appSource.indexOf("const applyRoomSnapshot =");
const applyRoomPayloadCall = appSource.indexOf("applyRoomPayload(", applySnapshotStart);
const topologyPreflight = appSource.indexOf("validateTopologyRoomSnapshot(", applySnapshotStart);
check(topologyPreflight > applySnapshotStart && topologyPreflight < applyRoomPayloadCall,
  "OnlineApp must validate a topology room snapshot before applyRoomPayload can change roomInfo.");
check(/import\s*\{[^}]*validateTopologyRoomSnapshot[^}]*\}\s*from\s*["']\.\/OnlineRoomSync\.js/.test(appSource),
  "OnlineApp must import validateTopologyRoomSnapshot from OnlineRoomSync.");

check(/import\s*\{[^}]*TOPOLOGY_ROOM_CAPABILITY[^}]*\}\s*from\s*["']\.\/NetworkManager\.js/.test(appSource)
  && /import\s+NetworkManager\s+from\s*["']\.\/CrossPlatformNetwork\.js/.test(appSource),
  "OnlineApp must import the topology capability constant used for negotiation.");
check(/new\s+NetworkManager\s*\(\s*\{[\s\S]{0,240}?topologyCapabilities\s*:/.test(appSource),
  "OnlineApp must explicitly pass topologyCapabilities when it constructs NetworkManager.");

assert.deepEqual(failures, [], failures.join("\n"));

console.log(JSON.stringify({
  status: "PASS",
  contract: "board-topology-online-app-entry-v1",
  coverage: [
    "surface-v1 custom settings preserve canonical board identity",
    "preset, seeded random, draft, seam and JSON setup events mount in the application",
    "room snapshot preflight precedes roomInfo commit",
    "reconnect session retains boardDefinition and boardHash",
    "application explicitly negotiates board-topology-v1 capability",
  ],
}));
