import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { chromium } from "playwright-core";

const appPath = path.resolve(process.env.LIFELINE_SMOKE_APP_PATH ?? "desktop/release/win-unpacked/LIFELINE.exe");
const workspace = fileURLToPath(new URL("../../", import.meta.url));
const digest = contents => createHash("sha256").update(contents).digest("hex");
assert.ok(fs.existsSync(appPath), `Packaged executable is missing: ${appPath}`);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lifeline-desktop-smoke-"));
const userData = path.join(root, "user-data");
const portServer = await import("node:net").then(({ createServer }) => new Promise((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close((error) => error ? reject(error) : resolve(port));
  });
}));
const child = spawn(appPath, [`--remote-debugging-port=${portServer}`, "--disable-background-networking"], {
  cwd: path.dirname(appPath),
  env: { ...process.env, LIFELINE_TEST_USER_DATA: userData },
  windowsHide: true,
  stdio: "ignore",
});
let browser;
try {
  let versionResponse;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Packaged app exited early with code ${child.exitCode}.`);
    try {
      versionResponse = await fetch(`http://127.0.0.1:${portServer}/json/version`);
      if (versionResponse.ok) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(versionResponse?.ok, "Packaged app did not expose its test-only DevTools endpoint.");
  const version = await versionResponse.json();
  browser = await chromium.connectOverCDP(version.webSocketDebuggerUrl);
  const page = browser.contexts()[0].pages()[0];
  const externalRequests = [];
  const badResponses = [];
  const pageErrors = [];
  page.on("request", (request) => {
    if (/^https?:/i.test(request.url())) externalRequests.push(request.url());
  });
  page.on("response", (response) => {
    if (response.status() >= 400) badResponses.push({ status: response.status(), url: response.url() });
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("#app")?.children.length > 0, null, { timeout: 30_000 });
  await page.waitForTimeout(1500);
  const result = await page.evaluate(() => ({
    title: document.title,
    url: location.href,
    vue: Boolean(globalThis.Vue?.createApp),
    desktopBridge: Boolean(globalThis.lifelineDesktop?.isDesktop),
    saveRead: globalThis.lifelineDesktop?.readProgressSync?.(),
    bodyText: document.body.innerText.slice(0, 4000),
  }));
  assert.match(result.url, /^lifeline:\/\/app\//);
  assert.equal(result.vue, true, "bundled Vue should initialize");
  assert.equal(result.desktopBridge, true, "sandboxed desktop bridge should be available");
  assert.equal(result.saveRead?.ok, true, "save IPC must respond using the isolated profile");
  assert.doesNotMatch(result.bodyText, /联机舱|Lobby|京公网安备|ICP备案/,
    "desktop UI must hide the unconfigured online lobby and Web-only filing footer");
  assert.deepEqual(externalRequests, [], "renderer must not request network URLs");
  assert.deepEqual(badResponses, [], `renderer HTTP/protocol errors: ${JSON.stringify(badResponses)}`);
  assert.deepEqual(pageErrors, [], `renderer page errors: ${pageErrors.join("; ")}`);
  assert.ok(fs.existsSync(userData), "the isolated userData directory should be created");
  const featureState = await page.evaluate(async () => {
    const vm = document.querySelector("#app")._vnode.component.proxy;
    return { challenges: vm.challengeLevels.length, steam: await globalThis.lifelineDesktop.getSteamStatus(),
      achievements: await globalThis.lifelineDesktop.readAchievements() };
  });
  assert.equal(featureState.challenges, 24, "portable must contain the current full campaign");
  assert.equal(featureState.steam.configured, false);
  assert.equal(featureState.steam.available, false);
  assert.equal(featureState.achievements.ok, true);
  assert.equal(featureState.achievements.achievements.length, 5);
  assert.ok(featureState.achievements.achievements.every(item => item.unlocked === false));
  assert.equal(featureState.achievements.steam.configured, false);
  const loadedModuleHashes = {};
  for (const name of ["OnlineApp.js", "AIEngine.js", "AIWorker.js", "LocalAIModes.js", "GameFeedback.js", "ChallengeCampaign.js", "Renderer.js"]) {
    const contents = await page.evaluate(async name => {
      const response = await fetch(`lifeline://app/${name}`);
      if (!response.ok) throw new Error(`Cannot read packaged module ${name}: ${response.status}`);
      return response.text();
    }, name);
    loadedModuleHashes[name] = digest(contents);
    assert.equal(loadedModuleHashes[name], digest(fs.readFileSync(path.join(workspace, "desktop/renderer", name))),
      `actual launched package must contain the final prepared ${name}`);
  }
  Object.assign(result, { status: "PACKAGED_OFFLINE_SMOKE_PASS", featureState, loadedModuleHashes,
    executableSha256: digest(fs.readFileSync(appPath)), externalRequests, badResponses, pageErrors });
  fs.writeFileSync(path.join(root, "smoke-result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ status: "pass", result, externalRequests, badResponses, pageErrors, userData, evidence: path.join(root, "smoke-result.json") }));
} finally {
  // connectOverCDP.close() only disconnects this client. Stop the exact test
  // launcher tree so portable wrappers cannot leave their extracted Electron
  // child alive with the isolated profile or remote-debugging port.
  if (browser) {
    try {
      const session = await browser.newBrowserCDPSession();
      await session.send("Browser.close");
    } catch { /* Browser.close may close the CDP transport before replying. */ }
    await browser.close().catch(() => {});
  }
  if (child.exitCode === null) {
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 10_000)),
    ]);
  }
  if (child.exitCode === null) {
    try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); }
    catch { child.kill(); }
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      const timer = setTimeout(resolve, 10_000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
  if (child.exitCode === null) throw new Error(`Packaged smoke launcher ${child.pid} did not exit after Browser.close and tree cleanup.`);
}
