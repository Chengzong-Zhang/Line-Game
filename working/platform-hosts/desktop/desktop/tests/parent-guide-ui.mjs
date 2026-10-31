import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { _electron } from "playwright-core";

const root = fileURLToPath(new URL("../../", import.meta.url));
const executable = path.join(root, "desktop/release/win-unpacked/LIFELINE.exe");
const archive = path.join(path.dirname(executable), "resources/app.asar");
const packageHash = () => createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
fs.mkdirSync(path.join(root, "local_artifacts"), { recursive: true });
const evidence = fs.mkdtempSync(path.join(root, "local_artifacts/parent-guide-"));
const receipt = { status: "RUNNING", packageSha256: packageHash(), evidence, tabs: [], pageErrors: [], badResponses: [], externalRequests: [] };
let application;
let page;
try {
  const env = { ...process.env, LIFELINE_TEST_USER_DATA: path.join(evidence, "profile") };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await _electron.launch({ executablePath: executable, env, timeout: 60000 });
  page = await application.firstWindow();
  page.on("pageerror", error => receipt.pageErrors.push(error.message));
  page.on("response", response => { if (response.status() >= 400) receipt.badResponses.push({ url: response.url(), status: response.status() }); });
  page.on("request", request => { if (/^(https?|wss?):/i.test(request.url())) receipt.externalRequests.push(request.url()); });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("#app")?._vnode?.component?.proxy?.controller?.renderer?.layout);
  const welcome = page.locator(".welcome-overlay");
  if (await welcome.isVisible()) await welcome.getByRole("button", { name: "简体中文", exact: true }).click();
  await page.getByRole("button", { name: "跳过教学", exact: true }).click();
  await page.locator(".dock-launcher-guide").click();
  await page.locator(".guide-section-button").first().click();
  await page.locator(".guide-reader").waitFor({ state: "visible" });
  assert.equal(await page.locator(".guide-sub-tab").count(), 3);
  for (let index = 0; index < 3; index += 1) {
    await page.locator(".guide-sub-tab").nth(index).click();
    await page.waitForFunction(index => document.querySelectorAll(".guide-sub-tab")[index]?.getAttribute("aria-selected") === "true", index);
    await page.evaluate(() => MathJax.startup.promise);
    if (index === 2) await page.locator(".guide-reader mjx-container").first().waitFor({ state: "attached", timeout: 15000 });
    const tab = await page.evaluate(async index => {
      const images = await Promise.all([...document.querySelectorAll(".guide-reader img")].map(async img => {
        img.loading = "eager";
        try { await img.decode(); } catch {}
        return { src: img.src, width: img.naturalWidth, height: img.naturalHeight };
      }));
      await document.fonts.ready;
      return {
        index,
        title: document.querySelectorAll(".guide-sub-tab")[index].innerText,
        textLength: document.querySelector(".guide-reader-body").innerText.length,
        mathExpressions: document.querySelectorAll(".guide-reader mjx-container").length,
        mathErrors: [...document.querySelectorAll(".guide-reader mjx-merror")].map(node => node.textContent),
        images,
      };
    }, index);
    assert.ok(tab.textLength > 100, `guide tab ${index} must contain substantive content`);
    assert.deepEqual(tab.images.filter(img => img.width === 0), [], `guide tab ${index} must load its packaged illustrations`);
    assert.deepEqual(tab.mathErrors, [], `guide tab ${index} must typeset without MathJax errors`);
    receipt.tabs.push(tab);
  }
  await page.screenshot({ path: path.join(evidence, "abstract-guide.png"), fullPage: true });
  assert.deepEqual(receipt.pageErrors, []);
  assert.deepEqual(receipt.badResponses, []);
  assert.deepEqual(receipt.externalRequests, []);
  assert.equal(packageHash(), receipt.packageSha256);
  receipt.status = "PACKAGED_RULE_GUIDES_PASS";
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
