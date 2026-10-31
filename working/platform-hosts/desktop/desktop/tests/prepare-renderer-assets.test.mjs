import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { prepareApp, prepareHtml, prepareMain, prepareStyles } from "../scripts/prepare-renderer-assets.mjs";

const frontend = new URL("../../web/web前端/", import.meta.url);
const hash = (value) => createHash("sha256").update(value, "utf8").digest("hex");

test("desktop HTML preparation is offline, idempotent, and handles CRLF", () => {
  const original = fs.readFileSync(new URL("index.html", frontend), "utf8").replace(/\r?\n/g, "\r\n");
  const once = prepareHtml(original);
  const twice = prepareHtml(once);
  assert.equal(hash(once), hash(twice));
  assert.match(once, /vendor\/vue\/vue\.global\.prod\.js/);
  assert.match(once, /vendor\/mathjax\/tex-chtml\.js/);
  assert.doesNotMatch(once, /https:\/\/cdn\.jsdelivr\.net|unpkg\.com/);
  assert.ok(once.includes("\r\n"));
});

test("desktop bootstrap and styles stay offline after repeated preparation", () => {
  const originalMain = fs.readFileSync(new URL("main.js", frontend), "utf8");
  const mainOnce = prepareMain(originalMain);
  assert.equal(hash(mainOnce), hash(prepareMain(mainOnce)));
  assert.doesNotMatch(mainOnce, /https?:\/\//);
  const originalCss = fs.readFileSync(new URL("styles.css", frontend), "utf8");
  const cssOnce = prepareStyles(originalCss);
  assert.equal(hash(cssOnce), hash(prepareStyles(cssOnce)));
  assert.doesNotMatch(cssOnce, /fonts\.googleapis\.com/);
});

test("desktop preparation rebuilds isolated output, excludes temporary files, and leaves Web sources unchanged", () => {
  const sourcePaths = ["index.html", "main.js", "styles.css"].map((name) => new URL(name, frontend));
  const before = sourcePaths.map((sourcePath) => hash(fs.readFileSync(sourcePath, "utf8")));
  const rendererRoot = new URL("../renderer/", import.meta.url);
  fs.mkdirSync(rendererRoot, { recursive: true });
  fs.writeFileSync(new URL("stale.js", rendererRoot), "stale renderer content");
  const staleTestRoot = new URL("../renderer/tests/.test-tmp/", import.meta.url);
  fs.mkdirSync(staleTestRoot, { recursive: true });
  fs.writeFileSync(new URL("baseline.txt", staleTestRoot), "stale local test baseline");
  execFileSync(process.execPath, [fileURLToPath(new URL("../scripts/prepare-renderer-assets.mjs", import.meta.url))]);
  const after = sourcePaths.map((sourcePath) => hash(fs.readFileSync(sourcePath, "utf8")));
  assert.deepEqual(after, before);
  assert.equal(fs.existsSync(new URL("stale.js", rendererRoot)), false, "removed Web files must not remain in the generated renderer");
  assert.equal(fs.existsSync(staleTestRoot), false, "temporary test baselines must not enter the renderer output");
  for (const desktopModule of ["ChallengeCampaign.js", "GameFeedback.js", "LocalProfile.js"]) {
    assert.ok(fs.existsSync(new URL(desktopModule, rendererRoot)), `current frontend module ${desktopModule} should be copied`);
  }
  assert.match(fs.readFileSync(new URL("index.html", rendererRoot), "utf8"), /vendor\/vue\/vue\.global\.prod\.js/);
  assert.doesNotMatch(fs.readFileSync(new URL("main.js", rendererRoot), "utf8"), /https?:\/\//);
  const desktopApp = fs.readFileSync(new URL("OnlineApp.js", rendererRoot), "utf8");
  assert.match(desktopApp, /v-if="!replayMode && !desktopPlatform"\s+variant="network"/);
  assert.match(desktopApp, /<UtilityModal\s+v-if="!desktopPlatform"\s+variant="network"/);
  assert.doesNotMatch(desktopApp, /site-footer|beian\.mps\.gov\.cn/);
  assert.match(prepareApp(fs.readFileSync(new URL("OnlineApp.js", frontend), "utf8")), /v-if="!desktopPlatform"\s+variant="network"/);
});
