import assert from "node:assert/strict";
import "../TopologyGameEngine.js";
import { GameEngine } from "../GameEngine.js";
import { createSurfacePreset } from "../BoardPresets.js";
import { projectPath } from "../BoardView.js";
import { identifySurface, surfacePosition, buildSurfaceCells, DEFAULT_SURFACE_PALETTE, NEUTRAL_SURFACE_COLOR, surfaceShadow, initialSurfacePitch } from "../TopologySurface3D.js";

const near = (a, b) => assert.ok(a.every((v, i) => Math.abs(v - b[i]) < 1e-9), `${a} != ${b}`);
assert.equal(initialSurfacePitch(createSurfacePreset("torus")), 0.8);
assert.equal(initialSurfacePitch(createSurfacePreset("cylinder")), -0.3);
assert.equal(initialSurfacePitch(createSurfacePreset("mobius")), -0.3);
for (const name of ["cylinder", "torus", "mobius"]) {
  const definition = createSurfacePreset(name, { width: 5, height: 5 });
  const game = new GameEngine({ boardDefinition: definition });
  const snapshot = game.getSnapshot();
  assert.equal(identifySurface(definition).kind, name);
  const surface = identifySurface(definition);
  near(surfacePosition(surface, [0, 1], {}), surfacePosition(surface, [5, name === "mobius" ? 4 : 1], {}));
  if (name === "torus") near(surfacePosition(surface, [2, 0], {}), surfacePosition(surface, [2, 5], {}));
  const face = snapshot.topology.viewBoard.faces[0];
  const ids = face.canonicalVertexIds;
  snapshot.territories = { BLACK: { renderPoints: [ids[0]] }, WHITE: { renderPoints: [ids[1]] } };
  const data = buildSurfaceCells(snapshot, 1);
  assert.equal(data.cells.length, snapshot.topology.viewBoard.faces.length * 3);
  assert.deepEqual(data.cells.slice(0, 3).map((cell) => cell.player), [null, null, null], "isolated nodes do not create area");
  const fake = structuredClone(definition);
  fake.seamPairs[0].endpointMap.reverse();
  assert.equal(identifySurface(fake).kind, "atlas", "do not wrap modified identifications");
  const path = { vertices: [ids[0], ids[1]], edgeOccurrences: [snapshot.topology.viewBoard.displayEdges[0].id.slice(6)] };
  const segments = projectPath(snapshot.topology.viewBoard, path);
  assert.equal(segments.length, 1);
  assert.deepEqual(segments[0].copyIds, snapshot.topology.viewBoard.displayEdges[0].copyIds);
}
assert.equal(identifySurface(createSurfacePreset("klein-bottle", { width: 5, height: 5 })).kind, "atlas");
console.log("verify-topology-surface-visual-v1: PASS (verified preset identifications, glued coordinates, isolated samples unfilled, atlas fallback, local path edges)");

// A real traced torus path changes atlas copy at a seam; every drawn segment
// must still be a local edge from the compiler, never an across-chart chord.
const { compileBoardOrThrow } = await import("../BoardCompiler.js");
const { enumerateConnections } = await import("../BoardPaths.js");
const seamDefinition = createSurfacePreset("torus", { width: 4, height: 4 });
seamDefinition.topology.movementStrategy = "simple-rays-v2";
seamDefinition.startingVertices = { BLACK: "v:0,1", WHITE: "v:3,3" };
const seamBoard = compileBoardOrThrow(seamDefinition);
const start = seamBoard.rawVertexToCanonical["v:1,1"];
const target = seamBoard.rawVertexToCanonical["v:0,1"];
const seamPath = enumerateConnections(seamBoard, { coverageByPlayer: { BLACK: [target] } }, start, "BLACK").find((p) => p.seamCrossings.length);
assert.ok(seamPath, "a real ray crosses the torus seam");
const seamGame = new GameEngine({ boardDefinition: seamDefinition });
const seamSnapshot = seamGame.getSnapshot();
const view = seamSnapshot.topology.viewBoard;
const localSegments = projectPath(view, seamPath);
assert.ok(localSegments.length >= new Set(seamPath.edgeOccurrences).size);
for (const segment of localSegments) {
  assert.ok(Math.hypot(segment.points[0][0] - segment.points[1][0], segment.points[0][1] - segment.points[1][1]) < 1.01);
}
seamSnapshot.topologyPaths = { BLACK: [seamPath] };
const model = buildSurfaceCells(seamSnapshot, 1);
assert.equal(model.lines.filter((line) => line.player === "BLACK").length, localSegments.length * 4);
const uniqueEdges = new Set(view.faces.flatMap((face) => face.copyIds.map((copy, i) => [copy, face.copyIds[(i + 1) % 3]].sort().join("\0"))));
assert.equal(model.lines.filter((line) => !line.player).length, uniqueEdges.size * 4, "only actual triangle edges are grid lines");
assert.ok(model.nodes.some((node) => node.player === "BLACK" && node.start), "real BLACK_NODE state and start ring");
assert.ok(model.nodes.some((node) => node.player === "WHITE" && node.start), "real WHITE_NODE state and start ring");
assert.equal(DEFAULT_SURFACE_PALETTE.BLACK.line, "#1f4fba");
assert.equal(DEFAULT_SURFACE_PALETTE.WHITE.surface, "#ed9595");
assert.equal(DEFAULT_SURFACE_PALETTE.BLACK.surface, "#85aaf1");
assert.equal(NEUTRAL_SURFACE_COLOR, "#ded3bf");
const front = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]];
const sideways = [[0, 0, 0], [0, 1, 0], [0, 1, 1], [0, 0, 1]];
assert.notEqual(surfaceShadow(front), surfaceShadow(sideways), "different normals receive different light");
assert.equal(surfaceShadow(front), surfaceShadow([...front].reverse()), "both sides of a nonorientable surface are lit");
assert.equal(surfaceShadow([[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]]), 0, "degenerate cells cannot create invalid colors");
for (const face of [front, sideways]) assert.ok(surfaceShadow(face) >= 0.03 && surfaceShadow(face) <= 0.33);
console.log("verify-topology-surface-visual-v1: PASS (real seam-traversing path remains local)");

// Lightweight lifecycle check: mounting, language updates, reduced motion,
// controls and disposal do not depend on a browser animation continuing.
const { mountTopologySurface3D } = await import("../TopologySurface3D.js");
const old = { document: globalThis.document, matchMedia: globalThis.matchMedia, requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame };
const styles = [];
const contexts = new Proxy({}, { get: (target, key) => target[key] ?? (() => {}), set: (target, key, value) => { if (key === "fillStyle" || key === "strokeStyle") styles.push(value); target[key] = value; return true; } });
class Element {
  constructor(tag) { this.tag = tag; this.style = {}; this.children = []; this.events = new Map(); this.textContent = ""; }
  append(...items) { this.children.push(...items); }
  setAttribute(key, value) { this[key] = value; }
  addEventListener(name, fn) { this.events.set(name, fn); }
  removeEventListener(name) { this.events.delete(name); }
  getContext() { return contexts; }
  getBoundingClientRect() { return { width: 300, height: 220 }; }
  remove() { this.removed = true; }
}
const media = { matches: true, addEventListener(name, fn) { this.listener = fn; }, removeEventListener() { this.listener = null; } };
globalThis.document = { createElement: (tag) => new Element(tag) };
globalThis.matchMedia = () => media;
globalThis.requestAnimationFrame = () => 42;
let cancelled = null;
globalThis.cancelAnimationFrame = (id) => { cancelled = id; };
try {
  const container = new Element("div");
  const game = new GameEngine({ boardDefinition: createSurfacePreset("cylinder") });
  const viewer = mountTopologySurface3D(container, game.getSnapshot(), { language: "en" });
  const [label, canvas, out, pause] = container.children[0].children;
  assert.match(label.textContent, /Cylinder/);
  assert.equal(pause.textContent, "Start rotation");
  assert.equal(pause.className, "action-button action-button-secondary");
  assert.equal(out.className, "action-button action-button-secondary");
  assert.ok(styles.includes(NEUTRAL_SURFACE_COLOR), "neutral surface is filled opaquely");
  assert.ok(!styles.includes(DEFAULT_SURFACE_PALETTE.BLACK.surface), "an isolated start is not painted as territory");
  assert.ok(styles.some((style) => typeof style === "string" && style.startsWith("rgba(24, 29, 38,")), "face lighting is drawn");
  viewer.update(game.getSnapshot(), { language: "zh" });
  assert.match(label.textContent, /圆柱/);
  assert.equal(out.textContent, "缩小 −");
  viewer.update(seamSnapshot, { palette: { BLACK: { node: "#123456", line: "#abcdef", territory: "#999999" } } });
  assert.ok(styles.includes("#123456") && styles.includes("#abcdef"), "custom palette applies to nodes and lines");
  viewer.destroy();
  assert.equal(cancelled, 42);
  assert.equal(canvas.events.size, 0);
  assert.equal(media.listener, null);
  assert.equal(container.children[0].removed, true);
} finally {
  for (const [key, value] of Object.entries(old)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
}
console.log("verify-topology-surface-visual-v1: PASS (viewer lifecycle, language and reduced motion)");

// Production UI receives GameController's enriched state, whose raw board is
// nested under .snapshot. Exercise the exact value passed by both Vue entries.
const { GameController } = await import("../GameController.js");
const { readFile } = await import("node:fs/promises");
const uiGame = new GameEngine({ boardDefinition: createSurfacePreset("cylinder", { width: 5, height: 5 }) });
const move = uiGame.getLegalMoves()[0];
assert.ok(move, "fixture has a playable first action");
assert.equal(uiGame.playMove(move.point).success, true);
const controller = Object.assign(Object.create(GameController.prototype), {
  engine: uiGame, options: { engine: { playerCount: 2 } }, lastAction: null, lastMoves: {},
  multiplayerEnabled: false, localPlayer: null, roomReady: false, opponentConnected: false, readOnlyMode: false,
});
const uiState = controller._buildGameState();
assert.equal(uiState.isTopologyBoard, true);
assert.ok(uiState.snapshot?.topology?.viewBoard?.faces?.length);
const uiSurface = buildSurfaceCells(uiState.snapshot, 1);
assert.ok(uiSurface.cells.length > 0, "production snapshot creates territory cells");
assert.ok(uiSurface.nodes.length > 0, "production snapshot creates visible nodes");
assert.ok(uiSurface.lines.some((line) => line.player === null), "production snapshot creates triangular grid");
assert.ok(uiSurface.lines.some((line) => line.player === "BLACK"), "production snapshot creates actual played lines");
const onlineSource = await readFile(new URL("../OnlineApp.js", import.meta.url), "utf8");
assert.match(onlineSource, /<TopologySurfacePreview v-if="gameState\.isTopologyBoard" :snapshot="gameState\.snapshot"/);
assert.match(onlineSource, /<TopologySurfaceExpandable v-if="gameState\.isTopologyBoard" :snapshot="gameState\.snapshot"/);
console.log("verify-topology-surface-visual-v1: PASS (GameController UI state to 3D and both Vue production bindings)");
