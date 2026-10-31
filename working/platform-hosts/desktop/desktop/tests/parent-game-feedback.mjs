import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright-core";

const root = fileURLToPath(new URL("../../", import.meta.url));
const executable = path.join(root, "desktop/release/win-unpacked/LIFELINE.exe");
const archive = path.join(path.dirname(executable), "resources/app.asar");
const hash = () => createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
const evidence = fs.mkdtempSync(path.join(root, "local_artifacts/parent-game-feedback-"));
const english = !process.argv.includes("--chinese");
const receipt = { status: "RUNNING", evidence, language: english ? "en" : "zh", packageSha256: hash(), events: [], errors: [], badResponses: [], externalRequests: [] };
let app, page;
let phase = "startup";
const label = (zh, en) => english ? en : zh;
const state = () => page.evaluate(() => {
  const vm = document.querySelector("#app")._vnode.component.proxy;
  return { snapshot: vm.controller.engine.getSnapshot(), action: vm.gameState.lastAction,
    feedback: vm.actionFeedback, audio: [...globalThis.__parentAudio], challengeStatus: vm.challengeStatus };
});
const click = async point => {
  const target = await page.evaluate(point => {
    const vm = document.querySelector("#app")._vnode.component.proxy;
    const renderer = vm.controller.renderer;
    const pixel = renderer.getPointPixelCoordinates(point);
    const rect = renderer.canvas.getBoundingClientRect();
    return { x: rect.left + pixel.x * rect.width / renderer.layout.cssWidth,
      y: rect.top + pixel.y * rect.height / renderer.layout.cssHeight, revision: vm.gameState.positionRevision };
  }, point);
  await page.mouse.click(target.x, target.y);
  await page.waitForFunction(revision => document.querySelector("#app")._vnode.component.proxy.gameState.positionRevision > revision, target.revision);
};
const clearAudio = () => page.evaluate(() => { globalThis.__parentAudio.length = 0; });
const inspectEvent = async (before, context, expectedKind) => {
  const after = await state();
  const pairs = s => Object.entries(s.edges).flatMap(([owner, edges]) => edges.map(edge => JSON.stringify([owner, edge])));
  const a = pairs(before.snapshot), b = pairs(after.snapshot);
  const connected = b.filter(edge => !a.includes(edge)).length;
  const cut = a.filter(edge => !b.includes(edge)).length;
  const nodes = before.snapshot.boardMatrix.flatMap((row, r) => row.map((value, c) => ({ value, next: after.snapshot.boardMatrix[r][c] })))
    .filter(({ value, next }) => [1, 3, 5].includes(value) && next !== value).length;
  const text = await page.locator(".action-feedback").innerText();
  assert.equal(text.trim(), after.feedback.trim(), "the actual visible status must contain the game event");
  assert.equal(await page.locator(".action-feedback").isVisible(), true);
  assert.equal(await page.locator(".action-feedback").getAttribute("aria-live"), "polite");
  if (connected) assert.ok(text.includes(label(`新增 ${connected} 条连线`, `Connected ${connected} new`)), text);
  if (cut) assert.ok(text.includes(label(`切断 ${cut} 条连线`, `Cut ${cut} `)), text);
  for (const [value, zh, en] of [[1, "蓝方", "Blue"], [3, "红方", "Red"], [5, "紫方", "Purple"]]) {
    const count = before.snapshot.boardMatrix.flatMap((row, r) => row.map((old, c) => old === value && after.snapshot.boardMatrix[r][c] !== value)).filter(Boolean).length;
    if (count) assert.ok(text.includes(label(`${zh}失去 ${count} 个节点`, `${en} lost ${count} `)), text);
  }
  if (!nodes) assert.doesNotMatch(text, /lost \d+ nodes?|失去 \d+ 个节点/, "line removal cannot masquerade as node removal");
  const territory = {};
  for (const player of after.snapshot.players) {
    const delta = after.snapshot.territories[player].area - before.snapshot.territories[player].area;
    if (delta) {
      territory[player] = delta;
      const name = { BLACK: label("蓝方", "Blue"), WHITE: label("红方", "Red"), PURPLE: label("紫方", "Purple") }[player];
      assert.ok(text.includes(`${name} ${delta > 0 ? "+" : ""}${delta}`), text);
    }
  }
  const frequency = { connect: 580, clear: 250, territory: 740 }[expectedKind];
  assert.ok(after.audio.some(node => node.frequency === frequency), `real native sound for ${context}: ${JSON.stringify(after.audio)}`);
  receipt.events.push({ context, connected, cut, nodes, territory, text, audio: after.audio });
  await page.screenshot({ path: path.join(evidence, `${context}.png`) });
};
try {
  const env = { ...process.env, LIFELINE_TEST_USER_DATA: path.join(evidence, "profile") };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({ executablePath: executable, env, timeout: 60_000 });
  page = await app.firstWindow();
  page.on("pageerror", error => receipt.errors.push(error.message));
  page.on("request", request => { if (/^(https?|wss?):/i.test(request.url())) receipt.externalRequests.push(request.url()); });
  page.on("response", response => { if (response.status() >= 400) receipt.badResponses.push({ url: response.url(), status: response.status() }); });
  await page.waitForFunction(() => document.querySelector("#app")?._vnode?.component?.proxy?.controller?.renderer?.layout);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 720));
  await page.locator(".welcome-overlay").getByRole("button", { name: english ? "English" : "简体中文", exact: true }).click();
  await page.getByRole("button", { name: label("跳过教学", "Skip tutorial"), exact: true }).click();
  await page.evaluate(() => {
    globalThis.__parentAudio = [];
    const proto = (globalThis.AudioContext ?? globalThis.webkitAudioContext).prototype;
    const native = proto.createOscillator;
    proto.createOscillator = function (...args) {
      const node = native.apply(this, args);
      const start = node.start;
      node.start = function (...startArgs) {
        globalThis.__parentAudio.push({ frequency: node.frequency.value, type: node.type });
        return start.apply(this, startArgs);
      };
      return node;
    };
  });
  for (const item of [{ index: 0, point: [0, 2], kind: "connect" }, { index: 1, point: [3, 2], kind: "clear" }, { index: 2, point: [2, 0], kind: "territory" }, { index: 5, point: [3, 2], kind: "clear" }]) {
    phase = `C${item.index + 1}`;
    if (!await page.locator(".utility-overlay-campaign").isVisible()) await page.locator(".dock-launcher-campaign").click();
    await page.locator(".campaign-level-card").nth(item.index).click();
    await page.locator(".utility-overlay-campaign").waitFor({ state: "detached" });
    await page.waitForFunction(index => document.querySelector("#app")._vnode.component.proxy.activeChallengeIndex === index, item.index);
    if (item.index === 5) {
      await click([1, 0]);
      await page.waitForFunction(() => {
        const vm = document.querySelector("#app")._vnode.component.proxy;
        return vm.gameState.positionRevision >= 4 && vm.gameState.currentPlayer === "BLACK";
      });
    }
    const before = await state();
    await clearAudio();
    await click(item.point);
    await page.waitForFunction(() => document.querySelector("#app")._vnode.component.proxy.challengeStatus === "won");
    await inspectEvent(before, phase, item.kind);
    await page.getByRole("button", { name: label("返回关卡", "Back to levels"), exact: true }).click();
  }
  phase = "terminal skip";
  await page.locator(".utility-overlay-campaign .utility-close").click();
  await page.locator(".dock-launcher-board").click();
  await page.locator("#local-player-BLACK").selectOption("human");
  await page.locator("#local-player-WHITE").selectOption("human");
  await page.locator(".utility-overlay-board .utility-close").click();
  await page.locator(".duel-actions .action-button-secondary").click();
  await page.waitForFunction(() => !document.querySelector("#app")._vnode.component.proxy.localSetupPending);
  await page.getByRole("button", { name: label("跳过回合", "Skip Turn"), exact: true }).click();
  await clearAudio();
  await page.getByRole("button", { name: label("跳过回合", "Skip Turn"), exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#app")._vnode.component.proxy.gameState.gameOver);
  const terminal = await state();
  assert.ok(terminal.feedback.includes(label("本局结束：", "Game over:")), terminal.feedback);
  assert.ok(terminal.audio.some(node => node.frequency === 660));
  receipt.events.push({ context: phase, text: terminal.feedback, winner: terminal.snapshot.winner, audio: terminal.audio });
  assert.deepEqual(receipt.errors, []);
  assert.deepEqual(receipt.externalRequests, []);
  assert.deepEqual(receipt.badResponses, []);
  assert.equal(hash(), receipt.packageSha256);
  receipt.status = "PACKAGED_GAME_FEEDBACK_PASS";
} catch (error) {
  receipt.status = "FAIL";
  receipt.phase = phase;
  receipt.error = String(error.stack ?? error);
  if (page) await page.screenshot({ path: path.join(evidence, "failure.png"), fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  if (app) await app.close().catch(() => {});
  fs.writeFileSync(path.join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt));
}
