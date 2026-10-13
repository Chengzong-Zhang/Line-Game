import assert from "node:assert/strict";
import Renderer from "../Renderer.js";
import GameController from "../GameController.js";
import GameEngine, { TerritoryRulesVersion } from "../GameEngine.js";

// Reproduce a desktop canvas that retains its inline size after the frame
// shrinks to phone width. It must also grow again without a page reload.
const previousWindow = globalThis.window;
globalThis.window = { innerWidth: 390, devicePixelRatio: 2 };
const frame = { clientWidth: 351, clientHeight: 307 };
const canvas = {
  parentElement: frame,
  style: { width: "890px", height: "667px" },
  width: 1780,
  height: 1334,
  getBoundingClientRect: () => ({ left: 12, top: 68, width: 890, height: 667 }),
};
const renderer = Object.assign(Object.create(Renderer.prototype), {
  canvas,
  ctx: { setTransform() {} },
  minCssWidth: 220,
  minCssHeight: 180,
  paddingRatio: 0.025,
  _lastMeasuredWidth: 890,
  _lastMeasuredHeight: 667,
  _lastMeasuredDpr: 2,
});
try {
  assert.equal(renderer.resize(), true);
  assert.equal(canvas.style.width, "351px");
  assert.equal(canvas.style.height, "307px");
  assert.equal(canvas.width, 702);
  assert.equal(canvas.height, 614);
  frame.clientWidth = 1000;
  frame.clientHeight = 875;
  assert.equal(renderer.resize(), true);
  assert.equal(canvas.style.width, "1000px");
  assert.equal(canvas.style.height, "875px");
  assert.equal(renderer.resize(), false);
  frame.clientWidth = 160;
  frame.clientHeight = 100;
  assert.equal(renderer.resize(), true);
  assert.equal(canvas.style.width, "160px", "a short viewport must not overflow the actual frame");
  assert.equal(canvas.style.height, "100px");
} finally {
  if (previousWindow === undefined) delete globalThis.window;
  else globalThis.window = previousWindow;
}

for (const width of [286, 351, 740, 1000, 1388]) {
  for (const gridSize of [5, 6, 9, 12, 15]) {
    renderer._lastMeasuredWidth = width;
    renderer._lastMeasuredHeight = Math.round(width * 7 / 8);
    renderer.layout = renderer._computeLayout({ gridSize });
    const layout = renderer.layout;
    // The border extends furthest at the three corners. Keep it visible
    // while spending most of the available width on the playable grid.
    const border = layout.pointRadius * 1.6;
    const topLeft = renderer.getPointPixelCoordinates(0, 0);
    const topRight = renderer.getPointPixelCoordinates(gridSize - 1, 0);
    const bottom = renderer.getPointPixelCoordinates(0, gridSize - 1);
    assert.ok(topLeft.x - Math.sqrt(3) * border >= 1);
    assert.ok(topRight.x + Math.sqrt(3) * border <= width - 1);
    assert.ok(topLeft.y - border >= 1);
    assert.ok(bottom.y + border * 2 <= layout.cssHeight - 1);

    const engine = new GameEngine({ gridSize, rulesVersion: TerritoryRulesVersion.V2 });
    const controller = Object.assign(Object.create(GameController.prototype), {
      renderer,
      engine,
      _validGridPoints: renderer._getValidPoints(gridSize),
    });
    const target = renderer.getPointPixelCoordinates(1, 0);
    assert.deepEqual(controller._findNearestGridPoint(target.x + layout.scale * 0.4, target.y), [1, 0]);
    assert.deepEqual(controller._findNearestGridPoint(topLeft.x, topLeft.y), [0, 0],
      "an occupied point must not redirect the click to a legal neighbor");
    assert.equal(controller._findNearestGridPoint(-width, -width), null);
  }
}

renderer._lastMeasuredWidth = 351;
renderer._lastMeasuredHeight = 359;
renderer.topInset = 52;
renderer.layout = renderer._computeLayout({ gridSize: 9 });
const insetLayout = renderer.layout;
renderer.topInset = 0;
renderer._lastMeasuredHeight = 307;
const originalLayout = renderer._computeLayout({ gridSize: 9 });
assert.equal(insetLayout.scale, originalLayout.scale, "putting controls inside the canvas must preserve playable spacing");
assert.equal(insetLayout.offsetY, originalLayout.offsetY + 52);
assert.ok(insetLayout.offsetY - insetLayout.pointRadius > 52, "corner controls must not cover top-row stones");

renderer.layout = { cssWidth: 400, cssHeight: 350 };
const scaledController = Object.assign(Object.create(GameController.prototype), {
  renderer,
  canvas: { getBoundingClientRect: () => ({ left: 20, top: 30, width: 200, height: 175 }) },
});
assert.deepEqual(scaledController._getCanvasRelativePosition(120, 117.5), { x: 200, y: 175 });
console.log("verify-board-input: PASS (resize, corner bounds, nearest-point input, scaled coordinates)");
