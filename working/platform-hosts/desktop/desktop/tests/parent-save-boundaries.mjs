import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright-core";

const root = fileURLToPath(new URL("../../", import.meta.url));
const executable = path.join(root, "desktop/release/win-unpacked/LIFELINE.exe");
const archive = path.join(path.dirname(executable), "resources/app.asar");
const hash = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
fs.mkdirSync(path.join(root, "local_artifacts"), { recursive: true });
const evidence = fs.mkdtempSync(path.join(root, "local_artifacts/parent-save-boundaries-"));
const receipt = { status: "RUNNING", packageSha256: hash(archive), evidence, milestones: [], errors: [], findings: [] };
let application;
let page;
let lockProcess;
let secondProcess;

const environment = profile => {
  const env = { ...process.env, LIFELINE_TEST_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
};
const launch = async profile => {
  application = await _electron.launch({ executablePath: executable, env: environment(profile), timeout: 60_000 });
  page = await application.firstWindow();
  page.on("pageerror", error => receipt.errors.push(error.message));
  await page.waitForFunction(() => document.querySelector("#app")?._vnode?.component?.proxy?.controller?.renderer?.layout, null, { timeout: 30_000 });
  const welcome = page.locator(".welcome-overlay");
  if (await welcome.isVisible()) await welcome.getByRole("button", { name: "简体中文", exact: true }).click();
};
const close = async () => {
  if (application) await application.close();
  application = null;
  page = null;
};
const skipTeaching = async () => {
  const skip = page.getByRole("button", { name: "跳过教学", exact: true });
  if (await skip.isVisible()) await skip.click();
  await page.waitForFunction(() => !document.querySelector("#app")._vnode.component.proxy.tutorialActive);
};
const startHumanMatch = async () => {
  await skipTeaching();
  await page.getByRole("button", { name: "棋盘舱", exact: true }).click();
  await page.locator("#grid-size").getByRole("radio", { name: "5", exact: true }).click();
  await page.locator("#local-player-BLACK").selectOption("human");
  await page.locator("#local-player-WHITE").selectOption("human");
  await page.locator(".utility-overlay-board .utility-close").click();
  await page.locator(".utility-overlay-board").waitFor({ state: "detached" });
  await page.getByRole("button", { name: "开始对局", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector("#app")._vnode.component.proxy.localSetupPending);
};
const snapshot = () => page.evaluate(() => {
  const vm = document.querySelector("#app")._vnode.component.proxy;
  const engine = vm.controller.engine;
  const s = engine.getSnapshot();
  return {
    actions: JSON.parse(JSON.stringify(vm.localGameActions)),
    revision: vm.gameState.positionRevision,
    notice: vm.localGameResumeNotice,
    status: window.lifelineDesktop.getLastSaveStatus(),
    ruleState: {
      gridSize: s.gridSize, playerCount: s.playerCount, startPlayer: s.startPlayer,
      currentPlayer: s.currentPlayer, rulesVersion: s.rulesVersion, gameOver: s.gameOver,
      consecutiveSkips: s.consecutiveSkips, resignedPlayers: [...s.resignedPlayers],
      turnCount: s.turnCount, boardMatrix: s.boardMatrix, edges: s.edges,
      territories: s.territories, historyHashes: [...engine.historyHashes].sort(),
    },
  };
});
const move = async index => {
  const target = await page.evaluate(index => {
    const vm = document.querySelector("#app")._vnode.component.proxy;
    const legal = vm.controller.engine.getSnapshot().legalMoves;
    const point = legal[index % legal.length].point;
    const pixel = vm.controller.renderer.getPointPixelCoordinates(point);
    const rect = vm.controller.renderer.canvas.getBoundingClientRect();
    return { x: rect.left + pixel.x, y: rect.top + pixel.y, revision: vm.gameState.positionRevision };
  }, index);
  await page.mouse.click(target.x, target.y);
  await page.waitForFunction(revision => document.querySelector("#app")._vnode.component.proxy.gameState.positionRevision > revision, target.revision);
  return snapshot();
};
const waitExit = (child, milliseconds = 15_000) => new Promise((resolve, reject) => {
  if (child.exitCode !== null) return resolve(child.exitCode);
  const timer = setTimeout(() => reject(new Error(`Test child ${child.pid} did not exit in time`)), milliseconds);
  child.once("exit", code => { clearTimeout(timer); resolve(code); });
  child.once("error", error => { clearTimeout(timer); reject(error); });
});
const lockTestFile = async file => {
  assert.ok(path.resolve(file).startsWith(`${path.resolve(evidence)}${path.sep}`));
  // Only this synthetic profile's file is locked. No ACLs or real saves change.
  const script = "$ErrorActionPreference='Stop'; $lockStream=[System.IO.File]::Open($env:LIFELINE_PARENT_LOCK_PATH,[System.IO.FileMode]::Open,[System.IO.FileAccess]::ReadWrite,[System.IO.FileShare]::None); try { [Console]::WriteLine('LOCK_READY'); [Console]::Out.Flush(); [Console]::ReadLine() | Out-Null } finally { $lockStream.Dispose() }";
  lockProcess = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true, env: { ...process.env, LIFELINE_PARENT_LOCK_PATH: file }, stdio: ["pipe", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("Synthetic save lock did not become ready")), 15_000);
    lockProcess.stdout.on("data", data => {
      output += data;
      if (output.includes("LOCK_READY")) { clearTimeout(timer); resolve(); }
    });
    lockProcess.stderr.on("data", data => { clearTimeout(timer); reject(new Error(String(data))); });
    lockProcess.once("error", error => { clearTimeout(timer); reject(error); });
  });
};
const releaseLock = async () => {
  if (!lockProcess) return;
  lockProcess.stdin.end("\n");
  assert.equal(await waitExit(lockProcess), 0);
  lockProcess = null;
};

try {
  // A newer save must survive both normal startup and explicit new-match UI.
  const futureProfile = path.join(evidence, "future-profile");
  const futureFile = path.join(futureProfile, "saves/current.json");
  fs.mkdirSync(path.dirname(futureFile), { recursive: true });
  const futureText = JSON.stringify({ format: "lifeline-desktop-save", schemaVersion: 99, payload: { marker: "preserve future data" } });
  fs.writeFileSync(futureFile, futureText);
  await launch(futureProfile);
  await skipTeaching();
  if (!/较新版本|只读/.test(await page.locator("body").innerText())) receipt.findings.push("Future save warning is not visible after leaving the startup tutorial.");
  await startHumanMatch();
  const futureState = await move(0);
  assert.equal(futureState.status.ok, false);
  assert.match(await page.locator("body").innerText(), /较新版本.*只读/);
  assert.equal(fs.readFileSync(futureFile, "utf8"), futureText);
  await page.screenshot({ path: path.join(evidence, "future-readonly.png"), fullPage: true });
  await close();
  assert.equal(fs.readFileSync(futureFile, "utf8"), futureText);
  receipt.milestones.push({ test: "future save preserved through start/move/close", status: futureState.status.status });

  const profile = path.join(evidence, "normal-profile");
  const current = path.join(profile, "saves/current.json");
  const backup = `${current}.bak`;
  await launch(profile);
  await startHumanMatch();
  const knownStates = new Map();
  let state = await snapshot();
  knownStates.set(JSON.stringify(state.actions), state.ruleState);
  for (const index of [0, 2]) {
    state = await move(index);
    assert.equal(state.status.ok, true);
    knownStates.set(JSON.stringify(state.actions), state.ruleState);
  }
  const beforeSecond = hash(current);
  secondProcess = spawn(executable, [], { env: environment(profile), windowsHide: true, stdio: "ignore" });
  assert.equal(await waitExit(secondProcess), 0, "second launch should exit cleanly");
  secondProcess = null;
  assert.equal(application.process().exitCode, null, "first application must remain alive");
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
  assert.equal(hash(current), beforeSecond, "second launch must not write progress");
  receipt.milestones.push("second instance exited cleanly; first instance and save unchanged");

  const beforeLock = fs.readFileSync(current, "utf8");
  await lockTestFile(current);
  state = await move(1);
  assert.equal(state.status.ok, false, "locked test file must fail save honestly");
  assert.match(await page.locator("body").innerText(), /尚未写入存档/);
  const failedActions = state.actions;
  await page.screenshot({ path: path.join(evidence, "save-failure-visible.png"), fullPage: true });
  await releaseLock();
  assert.equal(fs.readFileSync(current, "utf8"), beforeLock, "failed write preserves previous disk save");
  const failedStatus = state.status.status;
  state = await move(3);
  assert.equal(state.status.ok, true);
  assert.equal(state.actions.length, failedActions.length + 1);
  assert.deepEqual(state.actions.slice(0, failedActions.length), failedActions);
  assert.deepEqual(JSON.parse(fs.readFileSync(current, "utf8")).payload.actions, state.actions);
  knownStates.set(JSON.stringify(state.actions), state.ruleState);
  receipt.milestones.push({ test: "real file lock failure shown; later move persisted full history", failedStatus, actionCount: state.actions.length });

  const beforeClose = state;
  await close();
  await launch(profile);
  await skipTeaching();
  state = await snapshot();
  assert.deepEqual(state.actions, beforeClose.actions);
  assert.deepEqual(state.ruleState, beforeClose.ruleState);
  receipt.milestones.push({ test: "normal close/reopen exact rule-state restoration", actions: state.actions.length });
  await close();

  const backupText = fs.readFileSync(backup, "utf8");
  const backupPayload = JSON.parse(backupText).payload;
  const expectedBackupState = knownStates.get(JSON.stringify(backupPayload.actions));
  assert.ok(expectedBackupState, "backup must correspond to a previously observed engine state");
  const corruptText = '{"intentional-test-corruption":';
  fs.writeFileSync(current, corruptText);
  await launch(profile);
  await skipTeaching();
  state = await snapshot();
  assert.deepEqual(state.actions, backupPayload.actions);
  assert.deepEqual(state.ruleState, expectedBackupState);
  if (!/主存档损坏.*备份恢复/.test(await page.locator("body").innerText())) receipt.findings.push("Backup recovery warning is not visible after leaving the startup tutorial.");
  const quarantines = fs.readdirSync(path.dirname(current)).filter(name => name.startsWith("current.json.corrupt-"));
  assert.equal(quarantines.length, 1);
  assert.equal(fs.readFileSync(path.join(path.dirname(current), quarantines[0]), "utf8"), corruptText);
  assert.equal(fs.readFileSync(backup, "utf8"), backupText);
  await page.screenshot({ path: path.join(evidence, "backup-recovered.png"), fullPage: true });
  receipt.milestones.push({ test: "corrupt primary quarantined; backup restores full observed engine state", actions: state.actions.length, quarantine: quarantines[0] });
  assert.deepEqual(receipt.errors, []);
  assert.deepEqual(receipt.findings, [], "Every required storage warning must remain visible");
  assert.equal(hash(archive), receipt.packageSha256);
  receipt.status = "PACKAGED_SAVE_BOUNDARIES_PASS";
} catch (error) {
  receipt.status = "FAIL";
  receipt.error = String(error.stack ?? error);
  if (page) {
    receipt.failedState = await snapshot().catch(() => null);
    await page.screenshot({ path: path.join(evidence, "failure.png"), fullPage: true }).catch(() => {});
  }
  process.exitCode = 1;
} finally {
  if (lockProcess) await releaseLock().catch(error => { receipt.lockCleanupError = String(error); });
  if (secondProcess?.exitCode === null) secondProcess.kill();
  await close().catch(error => { receipt.closeError = String(error); });
  fs.writeFileSync(path.join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt));
}
