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
const evidence = fs.mkdtempSync(path.join(root, "local_artifacts/parent-profile-boundaries-"));
const receipt = { status: "RUNNING", evidence, packageSha256: hash(archive), milestones: [], findings: [], errors: [] };
let application;
let page;
let lockProcess;

const canonicalize = value => Array.isArray(value) ? `[${value.map(canonicalize).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`
    : JSON.stringify(value);
const envelope = payload => JSON.stringify({ format: "lifeline-profile-envelope", schemaVersion: 1, writtenAt: "2026-10-14T00:00:00.000Z",
  sha256: createHash("sha256").update(canonicalize(payload)).digest("hex"), payload });
const fixture = name => {
  const profile = path.join(evidence, name);
  const progress = path.join(profile, "profile/progress/profile.json");
  const settings = path.join(profile, "profile/settings/preferences.json");
  fs.mkdirSync(path.dirname(progress), { recursive: true });
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(progress, envelope({ format: "lifeline-progress", schemaVersion: 1, tutorialComplete: true,
    completedChallenges: ["C01-hub-connection", "C02-sever-outpost"] }));
  fs.writeFileSync(settings, envelope({ format: "lifeline-preferences", schemaVersion: 1, language: "zh", audioEnabled: true,
    audioVolume: 70, reducedMotion: false, fullscreen: false, uiScale: 1 }));
  return { profile, progress, settings };
};
const launch = async profile => {
  const env = { ...process.env, LIFELINE_TEST_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await _electron.launch({ executablePath: executable, env, timeout: 60_000 });
  page = await application.firstWindow();
  page.on("pageerror", error => receipt.errors.push(error.message));
  await page.waitForFunction(() => document.querySelector("#app")?._vnode?.component?.proxy?.controller?.renderer?.layout);
  const welcome = page.locator(".welcome-overlay");
  if (await welcome.isVisible()) await welcome.getByRole("button", { name: "简体中文", exact: true }).click();
  const skip = page.getByRole("button", { name: "跳过教学", exact: true });
  if (await skip.isVisible()) await skip.click();
  await page.waitForFunction(() => !document.querySelector("#app")._vnode.component.proxy.tutorialActive);
};
const close = async () => { if (application) await application.close(); application = null; page = null; };
const completed = () => page.evaluate(() => [...document.querySelector("#app")._vnode.component.proxy.completedChallenges]);
const settingsPanel = async () => {
  const summary = page.locator(".player-preferences > summary");
  if (!await page.locator(".player-preferences").getAttribute("open").then(value => value !== null)) await summary.click();
};
const waitLockExit = child => new Promise((resolve, reject) => {
  if (child.exitCode !== null) return resolve(child.exitCode);
  const timer = setTimeout(() => reject(new Error("Synthetic lock helper did not exit")), 15_000);
  child.once("exit", code => { clearTimeout(timer); resolve(code); });
  child.once("error", error => { clearTimeout(timer); reject(error); });
});
const lockFile = async file => {
  assert.ok(path.resolve(file).startsWith(`${path.resolve(evidence)}${path.sep}`));
  const script = "$ErrorActionPreference='Stop'; $lockStream=[System.IO.File]::Open($env:LIFELINE_PROFILE_LOCK_PATH,[System.IO.FileMode]::Open,[System.IO.FileAccess]::ReadWrite,[System.IO.FileShare]::None); try { [Console]::WriteLine('LOCK_READY'); [Console]::Out.Flush(); [Console]::ReadLine() | Out-Null } finally { $lockStream.Dispose() }";
  lockProcess = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true, env: { ...process.env, LIFELINE_PROFILE_LOCK_PATH: file }, stdio: ["pipe", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("Synthetic profile lock did not become ready")), 15_000);
    lockProcess.stdout.on("data", data => { output += data; if (output.includes("LOCK_READY")) { clearTimeout(timer); resolve(); } });
    lockProcess.stderr.on("data", data => { clearTimeout(timer); reject(new Error(String(data))); });
    lockProcess.once("error", error => { clearTimeout(timer); reject(error); });
  });
};
const unlock = async () => {
  if (!lockProcess) return;
  lockProcess.stdin.end("\n");
  assert.equal(await waitLockExit(lockProcess), 0);
  lockProcess = null;
};

try {
  const future = fixture("future-preferences");
  const validProgress = fs.readFileSync(future.progress, "utf8");
  const futureBytes = JSON.stringify({ format: "lifeline-profile-envelope", schemaVersion: 99,
    payload: { format: "lifeline-preferences", schemaVersion: 99, marker: "retain exact future data" } });
  fs.writeFileSync(future.settings, futureBytes);
  await launch(future.profile);
  assert.deepEqual(await completed(), ["C01-hub-connection", "C02-sever-outpost"]);
  const visibleFutureText = await page.locator("body").innerText();
  if (!/较新版本|更新版本|只读|newer version/i.test(visibleFutureText)) receipt.findings.push("Future preferences are preserved but no visible startup notice explains the newer-version/read-only condition.");
  await settingsPanel();
  await page.locator(".player-preferences input[type=checkbox]").nth(0).uncheck();
  await page.waitForFunction(() => Boolean(document.querySelector("#app")._vnode.component.proxy.profileSaveNotice));
  assert.ok(await page.locator(".player-preferences [role=status]").isVisible());
  assert.equal(fs.readFileSync(future.settings, "utf8"), futureBytes);
  assert.equal(fs.readFileSync(future.progress, "utf8"), validProgress);
  await page.screenshot({ path: path.join(evidence, "future-settings-warning.png"), fullPage: true });
  await close();
  assert.equal(fs.readFileSync(future.settings, "utf8"), futureBytes);
  assert.equal(fs.readFileSync(future.progress, "utf8"), validProgress);
  receipt.milestones.push("actual packaged loader/IPC retained healthy challenge progress and future settings through attempted UI write and close");

  const corrupt = fixture("corrupt-progress");
  const backupText = fs.readFileSync(corrupt.progress, "utf8");
  fs.writeFileSync(`${corrupt.progress}.bak`, backupText);
  const corruptBytes = '{"intentional-profile-corruption":';
  fs.writeFileSync(corrupt.progress, corruptBytes);
  await launch(corrupt.profile);
  assert.deepEqual(await completed(), ["C01-hub-connection", "C02-sever-outpost"]);
  const visibleRecoveryText = await page.locator("body").innerText();
  if (!/备份.*恢复|恢复.*备份|backup.*recover|recover.*backup/i.test(visibleRecoveryText)) receipt.findings.push("Corrupt challenge progress recovers from backup without a visible recovery notice.");
  const quarantines = fs.readdirSync(path.dirname(corrupt.progress)).filter(name => name.startsWith("profile.json.corrupt-"));
  assert.equal(quarantines.length, 1);
  assert.equal(fs.readFileSync(path.join(path.dirname(corrupt.progress), quarantines[0]), "utf8"), corruptBytes);
  assert.equal(fs.readFileSync(`${corrupt.progress}.bak`, "utf8"), backupText);
  await page.screenshot({ path: path.join(evidence, "recovered-progress.png"), fullPage: true });
  await close();
  receipt.milestones.push("actual packaged loader quarantined corrupt progress verbatim and recovered the valid two-level backup");

  const locked = fixture("locked-preferences");
  await launch(locked.profile);
  const beforeSettings = fs.readFileSync(locked.settings, "utf8");
  const beforeProgress = fs.readFileSync(locked.progress, "utf8");
  await settingsPanel();
  await lockFile(locked.settings);
  await page.locator(".player-preferences input[type=checkbox]").nth(0).uncheck();
  await page.waitForFunction(() => Boolean(document.querySelector("#app")._vnode.component.proxy.profileSaveNotice));
  assert.ok(await page.locator(".player-preferences [role=status]").isVisible());
  await page.screenshot({ path: path.join(evidence, "locked-settings-failure.png"), fullPage: true });
  await unlock();
  assert.equal(fs.readFileSync(locked.settings, "utf8"), beforeSettings);
  assert.equal(fs.readFileSync(locked.progress, "utf8"), beforeProgress);
  await page.locator(".player-preferences input[type=checkbox]").nth(0).check();
  await page.locator(".player-preferences input[type=checkbox]").nth(0).uncheck();
  await page.waitForFunction(() => !document.querySelector("#app")._vnode.component.proxy.profileSaveNotice);
  assert.equal(JSON.parse(fs.readFileSync(locked.settings, "utf8")).payload.audioEnabled, false);
  assert.equal(fs.readFileSync(locked.progress, "utf8"), beforeProgress);
  await close();
  receipt.milestones.push("real exclusive preferences-file lock caused visible UI failure without data loss; later actual toggle persisted after release");

  const lockedProgress = fixture("locked-challenge-progress");
  await launch(lockedProgress.profile);
  const originalProgress = fs.readFileSync(lockedProgress.progress, "utf8");
  const originalSettings = fs.readFileSync(lockedProgress.settings, "utf8");
  await page.locator(".dock-launcher-campaign").click();
  await page.locator(".campaign-level-card").nth(2).click();
  await page.locator(".utility-overlay-campaign").waitFor({ state: "detached" });
  await page.waitForFunction(() => document.querySelector("#app")._vnode.component.proxy.challengeStatus === "running");
  const solveCorner = async () => {
    const target = await page.evaluate(() => {
      const renderer = document.querySelector("#app")._vnode.component.proxy.controller.renderer;
      const pixel = renderer.getPointPixelCoordinates([3, 0]);
      const rect = renderer.canvas.getBoundingClientRect();
      return { x: rect.left + pixel.x * rect.width / renderer.layout.cssWidth, y: rect.top + pixel.y * rect.height / renderer.layout.cssHeight };
    });
    await page.mouse.click(target.x, target.y);
    await page.waitForFunction(() => document.querySelector("#app")._vnode.component.proxy.challengeStatus === "won");
  };
  await lockFile(lockedProgress.progress);
  await solveCorner();
  assert.match(await page.locator(".challenge-banner").innerText(), /进度保存失败|Progress could not be saved/i,
    "a won challenge with a failed write must visibly distinguish success from durable progress");
  await page.screenshot({ path: path.join(evidence, "locked-challenge-progress.png"), fullPage: true });
  await unlock();
  assert.equal(fs.readFileSync(lockedProgress.progress, "utf8"), originalProgress);
  assert.equal(fs.readFileSync(lockedProgress.settings, "utf8"), originalSettings);
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#app")._vnode.component.proxy.challengeStatus === "running");
  await solveCorner();
  const recoveredProgress = JSON.parse(fs.readFileSync(lockedProgress.progress, "utf8")).payload.completedChallenges;
  assert.deepEqual(recoveredProgress.sort(), ["C01-hub-connection", "C02-sever-outpost", "C03-close-corner"].sort());
  assert.doesNotMatch(await page.locator(".challenge-banner").innerText(), /进度保存失败|Progress could not be saved/i);
  await close();
  await launch(lockedProgress.profile);
  assert.deepEqual((await completed()).sort(), recoveredProgress.sort());
  await close();
  receipt.milestones.push("real challenge-progress lock preserved both domains and visibly reported the uncommitted win; actual retry after release durably saved one completion and survived restart");
  assert.deepEqual(receipt.errors, []);
  assert.equal(hash(archive), receipt.packageSha256);
  receipt.status = receipt.findings.length ? "PRESERVATION_PASS_WITH_WARNING_FINDINGS" : "PACKAGED_PROFILE_BOUNDARIES_PASS";
  if (receipt.findings.length) process.exitCode = 1;
} catch (error) {
  receipt.status = "FAIL";
  receipt.error = String(error.stack ?? error);
  if (page) await page.screenshot({ path: path.join(evidence, "failure.png"), fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  await unlock().catch(error => { receipt.lockCleanupError = String(error); });
  await close().catch(error => { receipt.closeError = String(error); });
  fs.writeFileSync(path.join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt));
}
