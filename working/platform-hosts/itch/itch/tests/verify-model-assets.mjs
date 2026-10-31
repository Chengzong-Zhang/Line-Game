import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateModelAssets, validateRuntimeModelAssets } from "../tools/model-assets.mjs";

const itchRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(itchRoot, "..");
const webRoot = path.join(repoRoot, "web", "web前端");
const source = await validateRuntimeModelAssets(webRoot);
assert.equal(source.manifest_count, 4);
assert.equal(source.asset_count, 18);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const definitions = [{
  manifestPath: "assets/research-ai/manifest.json",
  assetBase: "assets/research-ai",
}];

async function fixture({ asset = "model.f32", hash, floatCount = 1, extraF32 = false, lfsPointer = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "lifeline-model-assets-"));
  const modelRoot = path.join(root, "assets", "research-ai");
  await mkdir(modelRoot, { recursive: true });
  const payload = lfsPointer
    ? Buffer.from("version https://git-lfs.github.com/spec/v1\noid sha256:0000000000000000000000000000000000000000000000000000000000000000\nsize 4\n")
    : Buffer.from([0, 0, 0, 0]);
  if (!asset.includes("\\") && !asset.startsWith("/") && !asset.split("/").includes("..")) {
    const target = path.join(modelRoot, ...asset.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, payload);
  }
  const record = { id: "expected-model", asset, asset_sha256: hash ?? sha256(payload), float_count: floatCount };
  await writeFile(path.join(modelRoot, "manifest.json"), JSON.stringify({ models: [record] }));
  if (extraF32) await writeFile(path.join(modelRoot, "extra.f32"), Buffer.alloc(4));
  return { root, record };
}

async function expectFailure(options, pattern, mutate, validation = {}) {
  const item = await fixture(options);
  try {
    if (mutate) {
      await mutate(item);
      await writeFile(path.join(item.root, "assets", "research-ai", "manifest.json"), JSON.stringify({ models: [item.record] }));
    }
    await assert.rejects(
      validateModelAssets({ runtimeRoot: item.root, manifests: definitions, ...validation }),
      pattern,
    );
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
}

const valid = await fixture();
try {
  const result = await validateModelAssets({ runtimeRoot: valid.root, manifests: definitions });
  assert.equal(result.asset_count, 1);
  assert.equal(result.total_bytes, 4);
} finally {
  await rm(valid.root, { recursive: true, force: true });
}

await expectFailure({ hash: "0".repeat(64) }, /SHA-256 mismatch/);
await expectFailure({ floatCount: 2 }, /float_count \* 4/);
await expectFailure({ asset: "../escape.f32" }, /parent segment/);
await expectFailure({ asset: "nested\\model.f32" }, /backslashes are forbidden/);
await expectFailure({ extraF32: true }, /Unreferenced packaged \.f32/);
await expectFailure({ lfsPointer: true }, /only a Git LFS pointer/);
await expectFailure({}, /asset and asset_sha256 must be provided together/, ({ record }) => {
  delete record.asset_sha256;
});
await expectFailure({}, /UI\/runtime model closure failed/, null, {
  expectedModelIdsByManifest: {
    "assets/research-ai/manifest.json": ["expected-model", "missing-model"],
  },
});

console.log(JSON.stringify({
  status: "PASS_RUNTIME_MODEL_ASSETS",
  manifest_count: source.manifest_count,
  asset_count: source.asset_count,
  total_bytes: source.total_bytes,
  identity_sha256: source.identity_sha256,
  negative_cases: 8,
}));
