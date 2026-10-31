import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { _electron } from "playwright-core";

const root = fileURLToPath(new URL("../../", import.meta.url));
const executable = path.join(root, "desktop/release/win-unpacked/LIFELINE.exe");
const archive = path.join(path.dirname(executable), "resources/app.asar");
fs.mkdirSync(path.join(root, "local_artifacts"), { recursive: true });
const evidence = fs.mkdtempSync(path.join(root, "local_artifacts/parent-tutorial-"));
const packageHash = () => createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
const english = process.argv.includes("--english");
const compact = process.argv.includes("--compact");
const receipt = { status: "RUNNING", language: english ? "en" : "zh", compact, packageSha256: packageHash(), evidence, lessons: [], errors: [], badResponses: [], externalRequests: [] };
let application;
let page;

try {
  const env = { ...process.env, LIFELINE_TEST_USER_DATA: path.join(evidence, "profile") };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await _electron.launch({ executablePath: executable, env, timeout: 60000 });
  page = await application.firstWindow();
  page.on("pageerror", error => receipt.errors.push(error.message));
  page.on("response", response => { if (response.status() >= 400) receipt.badResponses.push({ url: response.url(), status: response.status() }); });
  page.on("request", request => { if (/^(https?|wss?):/i.test(request.url())) receipt.externalRequests.push(request.url()); });
  await page.waitForLoadState("domcontentloaded");
  if (english) await page.evaluate(() => localStorage.setItem("triaxis-language", "en"));
  if (compact) await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 720));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("#app")?._vnode?.component?.proxy?.controller?.renderer?.layout);
  const welcome = page.locator(".welcome-overlay");
  if (await welcome.isVisible()) await welcome.getByRole("button", { name: english ? "English" : "简体中文", exact: true }).click();
  const initial = await page.evaluate(() => ({
    text: document.body.innerText,
    brokenImages: [...document.images].filter(img => !img.complete || img.naturalWidth === 0).map(img => img.src),
  }));
  assert.doesNotMatch(initial.text, /联机舱|Lobby|京公网安备|ICP备案/);
  assert.deepEqual(initial.brokenImages, []);

  const clickPoint = async (point) => {
    const target = await page.evaluate(point => {
      const vm = document.querySelector("#app")._vnode.component.proxy;
      const pixel = vm.controller.renderer.getPointPixelCoordinates(point);
      const rect = vm.controller.renderer.canvas.getBoundingClientRect();
      return { x: rect.left + pixel.x, y: rect.top + pixel.y };
    }, point);
    await page.mouse.click(target.x, target.y);
  };

  for (const id of ["L1-connect", "L2-close-territory", "L3-cut-and-clear", "L4-three-point-limit", "L5-settle-score"]) {
    const level = await page.evaluate(() => {
      const vm = document.querySelector("#app")._vnode.component.proxy;
      return { ...vm.currentTutorialLevel, revision: vm.gameState.positionRevision };
    });
    assert.equal(level.id, id);
    if (level.restriction) {
      await clickPoint(level.restriction.point);
      await page.waitForFunction(() => document.querySelector("#app")._vnode.component.proxy.tutorialRestrictionObserved);
      const revision = await page.evaluate(() => document.querySelector("#app")._vnode.component.proxy.gameState.positionRevision);
      assert.equal(revision, level.revision, "the rejected teaching move must not change the rule-state revision");
    }
    if (level.objective.type === "skip") await page.getByRole("button", { name: english ? "Skip Turn" : "跳过回合", exact: true }).click();
    else await clickPoint(level.objective.point);
    await page.waitForFunction(() => document.querySelector("#app")._vnode.component.proxy.tutorialSuccess);
    const result = await page.evaluate(() => {
      const vm = document.querySelector("#app")._vnode.component.proxy;
      return { id: vm.currentTutorialLevel.id, success: vm.tutorialSuccess, attempts: vm.tutorialAttempts, revision: vm.gameState.positionRevision, gameOver: vm.gameState.gameOver, winner: vm.gameState.winner, feedback: document.querySelector(".tutorial-success")?.innerText };
    });
    receipt.lessons.push(result);
    await page.screenshot({ path: path.join(evidence, `${id}.png`), fullPage: true });
    const nextLabel = id === "L5-settle-score" ? (english ? "Continue to a real match" : "进入实战") : (english ? "Next lesson" : "下一关");
    await page.getByRole("button", { name: nextLabel, exact: true }).click();
  }
  await page.waitForFunction(() => !document.querySelector("#app")._vnode.component.proxy.tutorialActive);
  receipt.final = await page.evaluate(() => {
    const vm = document.querySelector("#app")._vnode.component.proxy;
    return { tutorialActive: vm.tutorialActive, actionCount: vm.localGameActions.length, rulesVersion: vm.gameState.rulesVersion, language: vm.language, viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scrollWidth: document.documentElement.scrollWidth }, text: document.body.innerText.slice(0, 1500) };
  });
  assert.equal(receipt.final.language, english ? "en" : "zh");
  assert.ok(receipt.final.viewport.scrollWidth <= receipt.final.viewport.width, "page must not require horizontal scrolling");
  assert.equal(receipt.final.actionCount, 0, "teaching moves must not leak into the free-game save");
  assert.deepEqual(receipt.errors, []);
  assert.deepEqual(receipt.badResponses, []);
  assert.deepEqual(receipt.externalRequests, []);
  assert.equal(packageHash(), receipt.packageSha256, "package must remain unchanged throughout verification");
  receipt.status = "FIVE_LESSON_UI_PASS";
} catch (error) {
  receipt.status = "FAIL";
  receipt.error = String(error.stack ?? error);
  if (page) await page.screenshot({ path: path.join(evidence, "failure.png"), fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  if (application) await application.close().catch(error => { receipt.closeError = String(error); });
  fs.writeFileSync(path.join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt));
}
