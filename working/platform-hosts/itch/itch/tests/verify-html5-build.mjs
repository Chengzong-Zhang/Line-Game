import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";

import { validateRuntimeModelAssets } from "../tools/model-assets.mjs";
import {
  collectReleaseSourceRecords,
  digestRecords,
  sha256,
} from "../tools/release-source.mjs";

const itchRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(itchRoot, "..");
const config = JSON.parse(await readFile(path.join(itchRoot, "config", "release.json"), "utf8"));
const artifactRoot = path.join(repoRoot, "local_artifacts", "itch-html5");
const distRoot = path.join(artifactRoot, "dist");
const webRoot = path.join(repoRoot, "web", "web前端");
const receipt = JSON.parse(await readFile(path.join(artifactRoot, `${config.candidate_id}-build-receipt.json`), "utf8"));
const manifest = JSON.parse(await readFile(path.join(distRoot, "asset-manifest.json"), "utf8"));
const buildInfo = JSON.parse(await readFile(path.join(distRoot, "build-info.json"), "utf8"));
const currentSourceTreeSha256 = digestRecords(await collectReleaseSourceRecords({ repoRoot, itchRoot }));
const sourceModelAssets = await validateRuntimeModelAssets(webRoot);
const packagedModelAssets = await validateRuntimeModelAssets(distRoot);
const currentCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repoRoot,
  encoding: "utf8",
}).trim();

assert.equal(receipt.status, "PASS_PACKAGE_CURRENT");
assert.equal(receipt.candidate_id, config.candidate_id);
assert.equal(receipt.rules_version, "territory-v2");
assert.equal(receipt.source_git_commit, currentCommit, "build receipt must bind the current Git commit");
assert.equal(receipt.source_tree_sha256, currentSourceTreeSha256, "dist is stale relative to current release inputs");
assert.equal(manifest.source_tree_sha256, currentSourceTreeSha256, "asset manifest source identity");
assert.equal(buildInfo.source_tree_sha256, currentSourceTreeSha256, "build-info source identity");
assert.equal(Object.hasOwn(buildInfo, "source_git_commit"), false, "packaged build-info must not create commit-hash recursion");
assert.equal(packagedModelAssets.identity_sha256, sourceModelAssets.identity_sha256, "source/package model identity");
assert.deepEqual(manifest.runtime_model_assets, packagedModelAssets, "asset manifest model inventory");
assert.deepEqual(receipt.runtime_model_assets, packagedModelAssets, "build receipt model inventory");
assert.ok(receipt.file_count <= config.itch_limits.max_files);
assert.ok(receipt.total_uncompressed_bytes <= config.itch_limits.max_total_bytes);
assert.ok(receipt.maximum_file_bytes <= config.itch_limits.max_file_bytes);
assert.ok(receipt.maximum_path_characters <= config.itch_limits.max_path_characters);

const index = await readFile(path.join(distRoot, "index.html"), "utf8");
const styles = await readFile(path.join(distRoot, "styles.css"), "utf8");
const runtimeConfig = await readFile(path.join(distRoot, "itch-config.js"), "utf8");
assert.match(index, /\.\/vendor\/vue\.global\.prod\.js/);
assert.match(index, /\.\/vendor\/mathjax\/es5\/tex-chtml\.js/);
assert.match(index, /\.\/itch-config\.js/);
assert.match(index, /<link rel="icon" href="data:,"\s*\/>/);
assert.doesNotMatch(index, /<(?:script|link)\b[^>]+(?:src|href)="https?:\/\//i);
assert.doesNotMatch(styles, /https?:\/\//i);
assert.match(styles, /\.\/fonts\/manrope-400\.css/);
assert.match(runtimeConfig, /"offlineAssetsOnly":true/);
assert.match(runtimeConfig, /"networkEnabled":false/);
assert.match(runtimeConfig, /"trainingContributionEnabled":false/);
assert.match(runtimeConfig, /"showFilingFooter":false/);

const manifestPaths = new Set(manifest.files.map((entry) => entry.path));
assert.ok(manifestPaths.has("AIWorker.js"));
assert.ok(manifestPaths.has("TerritoryWorker.js"));
assert.ok(manifestPaths.has("assets/research-ai/model-free-manifest.json"));
assert.ok(manifestPaths.has("assets/research-ai/multiplayer-v1/manifest.json"));
assert.ok(manifestPaths.has("guide/rule/essential rule.md"));
for (const entry of manifest.files) {
  const bytes = await readFile(path.join(distRoot, ...entry.path.split("/")));
  assert.equal(bytes.byteLength, entry.bytes, `${entry.path}: byte count`);
  assert.equal(sha256(bytes), entry.sha256, `${entry.path}: SHA-256`);
}

const rootEntries = await readdir(distRoot);
assert.ok(rootEntries.includes("index.html"));
assert.ok(!rootEntries.includes("tests"));
assert.ok(!rootEntries.includes("smoke-test.html"));

const zipBytes = await readFile(path.join(artifactRoot, `${config.candidate_id}.zip`));
assert.equal(sha256(zipBytes), receipt.zip_sha256);
const zipped = unzipSync(new Uint8Array(zipBytes));
assert.equal(Object.keys(zipped).length, receipt.file_count);
for (const entry of [...manifest.files, {
  path: "asset-manifest.json",
  sha256: sha256(await readFile(path.join(distRoot, "asset-manifest.json"))),
}]) {
  assert.ok(zipped[entry.path], `${entry.path}: present in ZIP`);
  assert.equal(sha256(zipped[entry.path]), entry.sha256, `${entry.path}: ZIP hash`);
}

for (const name of ["GameController.js", "OnlineApp.js", "AIWorker.js"]) {
  const source = await readFile(path.join(distRoot, name), "utf8");
  for (const match of source.matchAll(/(?:from\s+|new URL\()(["'])(\.\/[^"']+)\1/g)) {
    const target = match[2].split("?")[0].replace(/^\.\//, "");
    assert.ok(manifestPaths.has(target), `${name}: missing case-sensitive dependency ${target}`);
  }
}

console.log(JSON.stringify({
  status: "PASS_ITCH_HTML5_BUILD",
  candidate_id: receipt.candidate_id,
  file_count: receipt.file_count,
  total_uncompressed_bytes: receipt.total_uncompressed_bytes,
  zip_bytes: receipt.zip_bytes,
  zip_sha256: receipt.zip_sha256,
  source_tree_sha256: receipt.source_tree_sha256,
  runtime_model_asset_count: packagedModelAssets.asset_count,
  runtime_model_assets_sha256: packagedModelAssets.identity_sha256,
  offline_runtime_assets: true,
  itch_runtime_network_disabled: true,
}));
