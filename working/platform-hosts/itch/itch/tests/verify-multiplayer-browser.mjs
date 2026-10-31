import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

const itchRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(itchRoot, "..");
const chromePath = process.env.LIFELINE_CHROME_PATH
  ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

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
  const child = spawn(process.execPath, [path.join(itchRoot, "tools", "serve-runtime-validation.mjs")], {
    cwd: repoRoot,
    env: { ...process.env, LIFELINE_RUNTIME_VALIDATION_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`runtime validation server timeout: ${stderr}`)), 10_000);
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`runtime validation server exited ${code}: ${stderr}`));
    });
    child.stdout.on("data", (chunk) => {
      if (chunk.toString().includes("LIFELINE_RUNTIME_VALIDATION_SERVER_READY")) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
  return child;
}

async function runMatrix(page, selector, expectedTiers, expectedColdWorkers) {
  await page.goto(page.url(), { waitUntil: "domcontentloaded" });
  await page.locator(selector).click();
  await page.locator("#status").filter({ hasText: /^(?:验证通过|验证失败：)/ }).waitFor({
    state: "visible",
    timeout: 8 * 60_000,
  });
  const receipt = JSON.parse(await page.locator("#report").innerText());
  assert.equal(receipt.status, "PASS", receipt.errors.join("; "));
  assert.deepEqual(receipt.tiers, expectedTiers);
  assert.equal(receipt.coldWorkers, expectedColdWorkers);
  assert.equal(receipt.errors.length, 0);
  assert.ok(receipt.rows.length > 0);
  assert.ok(receipt.rows.every((row) => row.readyElapsedMs !== null));
  return receipt;
}

const port = await availablePort();
const server = await startServer(port);
let browser;
try {
  browser = await chromium.launch({ executablePath: chromePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const consoleIssues = [];
  const pageErrors = [];
  const failedRequests = [];
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
  await page.goto(`http://127.0.0.1:${port}/tests/multiplayer-browser.html`, { waitUntil: "domcontentloaded" });
  const full = await runMatrix(page, "#all", ["easy", "medium", "hard", "ultimate"], false);
  const cold = await runMatrix(page, "#cold", ["hard", "ultimate"], true);
  assert.deepEqual(consoleIssues, []);
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(failedRequests, []);
  console.log("PASS_MULTIPLAYER_BROWSER_MATRIX", JSON.stringify({
    fullRows: full.rows.length,
    fullMaximumMs: full.maximumMs,
    fullUnderOneSecond: full.underOneSecond,
    coldRows: cold.rows.length,
    coldMaximumMs: cold.maximumMs,
    coldUnderOneSecond: cold.underOneSecond,
    userAgent: full.userAgent,
  }));
} finally {
  await browser?.close();
  server.kill();
}
