import assert from "node:assert/strict";
import GameEngine, { RootMode, TerritoryRulesVersion } from "../GameEngine.js";
import Renderer from "../Renderer.js";

const watchers = [];
globalThis.Vue = {
  ref: (value) => ({ value }),
  computed: (read) => ({ get value() { return read(); } }),
  watch: (source, callback) => watchers.push({ source, callback }),
};
const { default: StartingPointSetup } = await import("../StartingPointSetup.js");

const texts = {
  localBluePlayer: "Blue", localRedPlayer: "Red", localPurplePlayer: "Purple",
  localGreenPlayer: "Green", localOrangePlayer: "Orange", localCyanPlayer: "Cyan",
};
for (const language of ["zh", "en"]) {
  const props = { playerCount: 2, boardShape: "triangle", gridSize: 9, selection: {}, language, texts, locked: false };
  const emitted = [];
  const ui = StartingPointSetup.setup(props, { emit: (_event, selection) => {
    emitted.push(structuredClone(selection));
    props.selection = selection;
  } });
  for (const mode of [RootMode.CLASSIC, RootMode.FIXED_DOUBLE, RootMode.RELOCATE, RootMode.ADD]) {
    ui.chooseRootMode(mode);
    const selection = emitted.at(-1);
    assert.equal(selection.rootMode ?? RootMode.CLASSIC, mode);
    assert.equal(ui.rootMode.value, mode);
    const expectedRoots = mode === RootMode.FIXED_DOUBLE ? 2 : 1;
    for (const side of ui.sides.value) assert.equal(side.roots.length, expectedRoots);
    assert.match(ui.copy.value.note, language === "zh"
      ? new RegExp(`开局有${expectedRoots === 2 ? "两个" : "一个"}起点`)
      : new RegExp(`begins? with ${expectedRoots === 2 ? "two" : "one"} roots?`));
  }
  assert.match(ui.copy.value.rootNote, language === "zh" ? /完整一回合/ : /full turn/);
}
assert.match(StartingPointSetup.template, /data-root-mode/);
assert.match(StartingPointSetup.template, /rootMode !== 'classic'/);

const engine = new GameEngine({ gridSize: 9, playerCount: 2, rulesVersion: TerritoryRulesVersion.V3, rootMode: RootMode.FIXED_DOUBLE });
const snapshot = engine.getSnapshot();
const arcs = [], dashes = [];
const ctx = {
  save() {}, restore() {}, beginPath() {}, stroke() {},
  arc: (...args) => arcs.push(args), setLineDash: (dash) => dashes.push([...dash]),
};
const renderer = Object.assign(Object.create(Renderer.prototype), {
  ctx,
  _getPlayerStyle: (player) => player,
  _gridToPixel: (x, y) => [x * 10, y * 10],
});
renderer._drawStartingPoints(snapshot, { lineWidth: 4, pointRadius: 5 });
const rootCount = Object.values(snapshot.roots).flat().length;
assert.ok(arcs.length >= rootCount * 2, "every current root must receive two visible rings");
assert.ok(dashes.some((dash) => dash.length === 2), "protection circles must use a distinct dashed treatment");
assert.ok(dashes.some((dash) => dash.length === 0), "root rings must restore a solid stroke");

console.log("verify-multi-start-ui: PASS (four modes, bilingual copy, multi-root preview and protection rendering)");
