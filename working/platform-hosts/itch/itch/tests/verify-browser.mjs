import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

const itchRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(itchRoot, "..");
const artifactRoot = path.join(repoRoot, "local_artifacts", "itch-html5");
const browserRoot = path.join(artifactRoot, "browser-acceptance");
const config = JSON.parse(await readFile(path.join(itchRoot, "config", "release.json"), "utf8"));
const buildReceipt = JSON.parse(await readFile(path.join(artifactRoot, `${config.candidate_id}-build-receipt.json`), "utf8"));
const chromePath = process.env.LIFELINE_CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const edgePath = process.env.LIFELINE_EDGE_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

await mkdir(browserRoot, { recursive: true });

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}
async function startServer(port) {
  const child = spawn(process.execPath, [path.join(itchRoot, "tools", "serve-validation.mjs")], {
    cwd: repoRoot,
    env: { ...process.env, LIFELINE_VALIDATION_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`validation server timeout: ${stderr}`)), 10_000);
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`validation server exited ${code}: ${stderr}`)); });
    child.stdout.on("data", (chunk) => {
      if (chunk.toString().includes("LIFELINE_ITCH_VALIDATION_SERVER_READY")) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
  return child;
}

function monitor(page) {
  const consoleIssues = [];
  const pageErrors = [];
  const failedRequests = [];
  const responses = [];
  page.on("console", (message) => {
    if (["warning", "error"].includes(message.type())) {
      consoleIssues.push({ type: message.type(), text: message.text() });
    }
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) => failedRequests.push({
    url: request.url(),
    error: request.failure()?.errorText ?? "unknown",
  }));
  page.on("response", (response) => responses.push({ url: response.url(), status: response.status() }));
  return { consoleIssues, pageErrors, failedRequests, responses };
}

function candidateFrame(page) {
  return page.frameLocator('iframe[title*="LIFELINE"]');
}

async function loadHarness(page, url, { tutorialScreenshot = null } = {}) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const frame = candidateFrame(page);
  const tutorial = frame.getByRole("button", { name: "跳过教学", exact: true });
  await tutorial.waitFor({ state: "visible", timeout: 20_000 });
  if (tutorialScreenshot) await page.screenshot({ path: tutorialScreenshot, fullPage: true });
  if (await tutorial.isVisible()) await tutorial.click();
  await frame.getByRole("heading", { name: "生命线", exact: true }).waitFor({ state: "visible", timeout: 20_000 });
  return frame;
}

async function openSetup(frame) {
  const black = frame.locator("#local-player-BLACK");
  if (!await black.isVisible()) {
    await frame.getByRole("button", { name: "棋盘舱", exact: true }).click();
  }
  await black.waitFor({ state: "visible", timeout: 10_000 });
}

async function chooseRadio(frame, container, value) {
  const button = frame.locator(`${container} button`).filter({ hasText: new RegExp(`^\\s*${value}\\s*$`) });
  await button.click();
}

async function configureMatch(frame, { playerCount = 2, shape = "triangle", gridSize = 5, choices = [] } = {}) {
  await openSetup(frame);
  await chooseRadio(frame, "#player-count", playerCount);
  await frame.locator(`[data-board-shape="${shape}"]`).click();
  await chooseRadio(frame, "#grid-size", gridSize);
  const colors = ["BLACK", "WHITE", "PURPLE", "GREEN", "ORANGE", "CYAN"];
  for (let index = 0; index < playerCount; index += 1) {
    await frame.locator(`#local-player-${colors[index]}`).selectOption(choices[index] ?? "human");
  }
}

async function startConfiguredMatch(frame) {
  await frame.locator(".starting-point-start").click();
  await frame.locator(".panel-setup").waitFor({ state: "hidden", timeout: 10_000 });
}

function boardCoordinates(width, height, gx, gy, gridSize = 5) {
  const sqrt3Over2 = Math.sqrt(3) / 2;
  const logicalWidth = gridSize - 1;
  const logicalHeight = (gridSize - 1) * sqrt3Over2;
  const outerPadding = Math.max(12, Math.min(width, height) * 0.025);
  const scale = Math.min(
    Math.max(1, width - outerPadding * 2) / (logicalWidth + 0.9),
    Math.max(1, height - outerPadding * 2) / (logicalHeight + 0.9),
  );
  return {
    x: (width - logicalWidth * scale) * 0.5 + (gx + gy * 0.5) * scale,
    y: (height - logicalHeight * scale) * 0.5 + gy * sqrt3Over2 * scale,
  };
}

function assertClean(monitoring, label) {
  const harnessWarning = "An iframe which has both allow-scripts and allow-same-origin for its sandbox attribute can escape its sandboxing.";
  const unexpectedConsole = monitoring.consoleIssues.filter((entry) => entry.text !== harnessWarning);
  const badResponses = monitoring.responses.filter((entry) => entry.status >= 400);
  assert.deepEqual(unexpectedConsole, [], `${label}: unexpected console warnings/errors`);
  assert.deepEqual(monitoring.pageErrors, [], `${label}: page errors`);
  assert.deepEqual(monitoring.failedRequests, [], `${label}: failed requests`);
  assert.deepEqual(badResponses, [], `${label}: HTTP error responses`);
}

async function chromeJourney(baseUrl) {
  const browser = await chromium.launch({ executablePath: chromePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const page = await context.newPage();
  const observed = monitor(page);
  try {
    const frame = await loadHarness(page, `${baseUrl}/iframe/`, {
      tutorialScreenshot: path.join(browserRoot, "candidate-tutorial-chrome.png"),
    });
    await configureMatch(frame, {
      playerCount: 6,
      shape: "hexagon",
      gridSize: 5,
      choices: ["ai-hard", "ai-easy", "ai-easy", "ai-easy", "ai-easy", "ai-easy"],
    });
    await page.screenshot({ path: path.join(browserRoot, "candidate-settings-6p-ai.png"), fullPage: true });
    const turnLabel = frame.locator(".duel-turn-banner strong");
    const startingTurn = await turnLabel.innerText();
    const hardWorker = page.waitForResponse(
      (response) => response.url().includes("AIWorker.js") && response.status() === 200,
      { timeout: 30_000 },
    );
    const hardPolicy = page.waitForResponse(
      (response) => response.url().includes("hex-player-policy-v1.json") && response.status() === 200,
      { timeout: 30_000 },
    );
    await startConfiguredMatch(frame);
    await Promise.all([hardWorker, hardPolicy]);
    const turnDeadline = Date.now() + 20_000;
    let advancedTurn = startingTurn;
    while (Date.now() < turnDeadline && advancedTurn === startingTurn) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      advancedTurn = await turnLabel.innerText();
    }
    assert.notEqual(advancedTurn, startingTurn, "6-player Hard v3 must complete an actual opening move before the acceptance screenshot");
    const pause = frame.getByRole("button", { name: "暂停 AI", exact: true });
    await pause.waitFor({ state: "visible", timeout: 20_000 });
    await pause.click();
    await page.screenshot({ path: path.join(browserRoot, "candidate-board-6p-ai-paused.png"), fullPage: true });

    await configureMatch(frame, { playerCount: 2, shape: "triangle", gridSize: 5, choices: ["dqn", "ppo"] });
    await frame.locator("#language-select button").filter({ hasText: /^English$/ }).click();
    await frame.getByRole("heading", { name: "LIFELINE", exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    await page.screenshot({ path: path.join(browserRoot, "candidate-settings-2p-ai-en.png"), fullPage: true });
    await frame.locator("#language-select button").filter({ hasText: /^中文$/ }).click();
    await frame.getByRole("heading", { name: "生命线", exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    await startConfiguredMatch(frame);
    const resultDialog = frame.getByRole("dialog");
    await resultDialog.waitFor({ state: "visible", timeout: 120_000 });
    const resultTitle = await resultDialog.getByRole("heading").innerText();
    assert.match(resultTitle, /获胜|平局/);
    await page.screenshot({ path: path.join(browserRoot, "candidate-ai-finished-chrome.png"), fullPage: true });

    await resultDialog.getByRole("button", { name: "关闭提示框", exact: true }).click();
    await frame.getByRole("button", { name: "棋盘舱", exact: true }).click();
    await frame.getByRole("button", { name: "导出棋谱", exact: true }).click();
    await frame.getByText("棋谱已导出。", { exact: true }).waitFor({ state: "visible", timeout: 20_000 });

    // itch-like sandboxing can suppress a blob download event even when the
    // application successfully creates the replay. Verify that in-frame
    // success feedback first, then capture the same saved terminal replay from
    // the direct same-origin candidate page without weakening the sandbox.
    const directPage = await context.newPage();
    const directObserved = monitor(directPage);
    await directPage.goto(`${baseUrl}/candidate/`, { waitUntil: "domcontentloaded" });
    const directTutorial = directPage.getByRole("button", { name: /^(跳过教学|Skip tutorial)$/ });
    const directHeading = directPage.getByRole("heading", { name: /^(生命线|LIFELINE)$/ });
    await Promise.race([
      directTutorial.waitFor({ state: "visible", timeout: 20_000 }),
      directHeading.waitFor({ state: "visible", timeout: 20_000 }),
    ]);
    if (await directTutorial.isVisible()) await directTutorial.click();
    await directHeading.waitFor({ state: "visible", timeout: 20_000 });
    const directDialog = directPage.getByRole("dialog");
    await directDialog.waitFor({ state: "visible", timeout: 20_000 });
    await directDialog.getByRole("button", { name: /^(关闭提示框|Close Prompt|关闭结果|Close Result)$/ }).click();
    await directPage.getByRole("button", { name: /^(棋盘舱|Board)$/ }).click();
    const downloadPromise = directPage.waitForEvent("download", { timeout: 20_000 });
    await directPage.getByRole("button", { name: /^(导出棋谱|Export replay)$/ }).click();
    const download = await downloadPromise;
    const replayPath = path.join(browserRoot, "lifeline-terminal-replay.json");
    await download.saveAs(replayPath);
    const replayBytes = (await stat(replayPath)).size;
    assert.ok(replayBytes > 1000, "exported replay must contain a complete game");
    assertClean(directObserved, "Chrome direct-page replay download");
    await directPage.close();

    await frame.getByRole("button", { name: /^复盘本局/ }).click();
    const progress = frame.getByRole("slider", { name: "复盘进度", exact: true });
    await progress.waitFor({ state: "visible", timeout: 20_000 });
    const last = Number(await progress.getAttribute("max"));
    assert.ok(last > 0);
    assert.equal(Number(await progress.getAttribute("value")), last);
    await frame.getByRole("button", { name: "上一步", exact: true }).click();
    assert.equal(Number(await progress.getAttribute("value")), last - 1);
    await frame.getByRole("button", { name: "下一步", exact: true }).click();
    assert.equal(Number(await progress.getAttribute("value")), last);
    await page.screenshot({ path: path.join(browserRoot, "candidate-replay-chrome.png"), fullPage: true });
    await frame.getByRole("button", { name: "退出复盘", exact: true }).first().click();

    await page.reload({ waitUntil: "domcontentloaded" });
    const restoredFrame = candidateFrame(page);
    // Each new page load opens the tutorial while protecting the saved match.
    // Exit the tutorial before checking the tutorial-return notice and the
    // persisted terminal result itself.
    const restoredTutorial = restoredFrame.getByRole("button", { name: /^(跳过教学|Skip tutorial)$/ });
    await restoredTutorial.waitFor({ state: "visible", timeout: 20_000 });
    await restoredTutorial.click();
    await restoredFrame.getByText(/^(已回到原来的对局，可以继续下棋。|Your previous match is restored\. Continue playing\.)$/, { exact: true })
      .waitFor({ state: "visible", timeout: 20_000 });
    const restoredDialog = restoredFrame.getByRole("dialog");
    await restoredDialog.waitFor({ state: "visible", timeout: 20_000 });
    assert.equal(await restoredDialog.getByRole("heading").innerText(), resultTitle);
    await page.screenshot({ path: path.join(browserRoot, "candidate-restored-chrome.png"), fullPage: true });

    const required = ["AIWorker.js", "hex-player-policy-v1.json", "model-free-manifest.json", "dqn-all-sizes-e2000.f32", "ppo-all-sizes-e2000.f32"];
    const resourceResponses = Object.fromEntries(required.map((name) => [name, observed.responses
      .filter((entry) => entry.url.includes(name)).map((entry) => entry.status)]));
    for (const [name, statuses] of Object.entries(resourceResponses)) {
      assert.ok(statuses.includes(200), `${name} must load with HTTP 200 in Chrome`);
    }
    assertClean(observed, "Chrome desktop iframe journey");
    return {
      result_title: resultTitle,
      replay_actions: last,
      replay_bytes: replayBytes,
      sandbox_export_feedback: true,
      hard_v3_6p: { starting_turn: startingTurn, advanced_turn: advancedTurn, actual_move_observed: true, worker_http_200: true, policy_http_200: true },
      resource_responses: resourceResponses,
    };
  } finally {
    await context.close();
    await browser.close();
  }
}

async function storageDeniedJourney(baseUrl) {
  const browser = await chromium.launch({ executablePath: chromePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await context.newPage();
  const observed = monitor(page);
  try {
    const frame = await loadHarness(page, `${baseUrl}/storage-denied/`);
    const storageError = await frame.locator("body").evaluate(() => {
      try {
        localStorage.setItem("lifeline-storage-probe", "1");
        localStorage.removeItem("lifeline-storage-probe");
        return null;
      } catch (error) {
        return error?.name ?? String(error);
      }
    });
    assert.equal(storageError, "SecurityError");
    await configureMatch(frame, { playerCount: 2, shape: "triangle", gridSize: 5, choices: ["human", "human"] });
    await startConfiguredMatch(frame);
    const turnLabel = frame.locator(".duel-turn-banner strong");
    const startingTurn = await turnLabel.innerText();
    const canvas = frame.locator("canvas.game-canvas");
    const box = await canvas.boundingBox();
    assert.ok(box);
    await canvas.click({ position: boardCoordinates(box.width, box.height, 1, 0) });
    await frame.getByText(/浏览器未授权本地存储/).waitFor({ state: "visible", timeout: 10_000 });
    const turnDeadline = Date.now() + 10_000;
    let advancedTurn = startingTurn;
    while (Date.now() < turnDeadline && advancedTurn === startingTurn) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      advancedTurn = await turnLabel.innerText();
    }
    assert.notEqual(advancedTurn, startingTurn, "a valid move must advance the turn even when storage is denied");
    await page.screenshot({ path: path.join(browserRoot, "candidate-storage-denied-chrome.png"), fullPage: true });
    assertClean(observed, "Chrome opaque-origin storage-denied journey");
    return { local_storage_error: storageError, move_after_denial: true, warning_visible: true, starting_turn: startingTurn, advanced_turn: advancedTurn };
  } finally {
    await context.close();
    await browser.close();
  }
}

async function mobileTouchJourney(baseUrl) {
  const browser = await chromium.launch({ executablePath: chromePath, headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    screen: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  const observed = monitor(page);
  try {
    const frame = await loadHarness(page, `${baseUrl}/iframe/`);
    await configureMatch(frame, { playerCount: 2, shape: "triangle", gridSize: 5, choices: ["human", "human"] });
    await startConfiguredMatch(frame);
    const dimensions = await frame.locator("html").evaluate((element) => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    }));
    assert.ok(dimensions.scrollWidth <= dimensions.clientWidth + 1, `mobile horizontal overflow: ${JSON.stringify(dimensions)}`);
    const canvas = frame.locator("canvas.game-canvas");
    const box = await canvas.boundingBox();
    assert.ok(box);
    const turnLabel = frame.locator(".duel-turn-banner strong");
    const startingTurn = await turnLabel.innerText();
    const point = boardCoordinates(box.width, box.height, 1, 0);
    await page.touchscreen.tap(box.x + point.x, box.y + point.y);
    const turnDeadline = Date.now() + 10_000;
    let advancedTurn = startingTurn;
    while (Date.now() < turnDeadline && advancedTurn === startingTurn) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      advancedTurn = await turnLabel.innerText();
    }
    assert.notEqual(advancedTurn, startingTurn, "one legal touch must advance exactly one turn");
    await page.screenshot({ path: path.join(browserRoot, "candidate-mobile-390x844-emulated.png"), fullPage: true });
    assertClean(observed, "Chrome emulated mobile touch journey");
    return { viewport: "390x844", horizontal_overflow: false, single_touch_changed_one_turn: true, starting_turn: startingTurn, advanced_turn: advancedTurn };
  } finally {
    await context.close();
    await browser.close();
  }
}

async function edgeSmoke(baseUrl) {
  try {
    await stat(edgePath);
  } catch (_error) {
    return { status: "NOT_RUN", reason: `Edge executable not found at ${edgePath}` };
  }
  const browser = await chromium.launch({ executablePath: edgePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const observed = monitor(page);
  try {
    const frame = await loadHarness(page, `${baseUrl}/iframe/`);
    await configureMatch(frame, { playerCount: 2, shape: "triangle", gridSize: 5, choices: ["dqn", "ppo"] });
    const worker = page.waitForResponse((response) => response.url().includes("AIWorker.js") && response.status() === 200, { timeout: 30_000 });
    const manifest = page.waitForResponse((response) => response.url().includes("model-free-manifest.json") && response.status() === 200, { timeout: 30_000 });
    const weights = page.waitForResponse((response) => response.url().includes("dqn-all-sizes-e2000.f32") && response.status() === 200, { timeout: 30_000 });
    await startConfiguredMatch(frame);
    await Promise.all([worker, manifest, weights]);
    await page.screenshot({ path: path.join(browserRoot, "candidate-edge-worker-smoke.png"), fullPage: true });
    assertClean(observed, "Edge iframe/Worker smoke");
    return { status: "PASS_LOCAL_BROWSER_SMOKE", iframe: true, worker_http_200: true, model_http_200: true };
  } finally {
    await context.close();
    await browser.close();
  }
}

try {
  await stat(chromePath);
} catch (_error) {
  throw new Error(`Chrome executable not found at ${chromePath}; set LIFELINE_CHROME_PATH.`);
}

const port = await availablePort();
const server = await startServer(port);
const baseUrl = `http://127.0.0.1:${port}`;
try {
  const chrome = await chromeJourney(baseUrl);
  const storageDenied = await storageDeniedJourney(baseUrl);
  const mobileEmulation = await mobileTouchJourney(baseUrl);
  const edge = await edgeSmoke(baseUrl);
  const screenshotNames = [
    "candidate-tutorial-chrome.png",
    "candidate-settings-6p-ai.png",
    "candidate-board-6p-ai-paused.png",
    "candidate-settings-2p-ai-en.png",
    "candidate-ai-finished-chrome.png",
    "candidate-replay-chrome.png",
    "candidate-restored-chrome.png",
    "candidate-storage-denied-chrome.png",
    "candidate-mobile-390x844-emulated.png",
    ...(edge.status.startsWith("PASS") ? ["candidate-edge-worker-smoke.png"] : []),
  ];
  const receipt = {
    schema: "lifeline-itch-local-browser-acceptance-v1",
    status: "PASS_LOCAL_BROWSER_CURRENT",
    candidate_id: config.candidate_id,
    source_tree_sha256: buildReceipt.source_tree_sha256,
    chrome,
    storage_denied: storageDenied,
    mobile_emulation: mobileEmulation,
    edge,
    screenshots: screenshotNames.map((name) => `local_artifacts/itch-html5/browser-acceptance/${name}`),
    exported_replay: "local_artifacts/itch-html5/browser-acceptance/lifeline-terminal-replay.json",
    audio_first_gesture: { status: "N/A", reason: "The current Web runtime contains no Web Audio or HTML media playback." },
    application_fullscreen: { status: "N/A", reason: "The application contains no requestFullscreen flow; itch host fullscreen is separate." },
    itch_hosted_preview: { status: "NOT_RUN", reason: "Requires an uploaded itch project page." },
    real_device_touch: { status: "NOT_RUN", reason: "390x844 is Chromium device emulation, not a physical phone." },
  };
  await writeFile(path.join(browserRoot, `${config.candidate_id}-browser-receipt.json`), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(receipt));
} finally {
  server.kill();
}
