import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { compareOrdinal, digestRecords, listFiles, sha256 } from "./release-source.mjs";

export const RUNTIME_MODEL_MANIFESTS = Object.freeze([
  Object.freeze({
    manifestPath: "assets/research-ai/manifest.json",
    assetBase: "assets/research-ai",
  }),
  Object.freeze({
    manifestPath: "assets/research-ai/model-free-manifest.json",
    assetBase: "assets/research-ai",
  }),
  Object.freeze({
    manifestPath: "assets/research-ai/transfer-v1/manifest.json",
    assetBase: "assets/research-ai",
  }),
  Object.freeze({
    manifestPath: "assets/research-ai/multiplayer-v1/manifest.json",
    assetBase: "assets/research-ai/multiplayer-v1",
  }),
]);

function fromPosix(root, relative) {
  return path.join(root, ...relative.split("/"));
}
function pointerToken(value) {
  return String(value).replaceAll("~", "~0").replaceAll("/", "~1");
}

function collectAssetObjects(value, pointer = "", found = []) {
  if (!value || typeof value !== "object") return found;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectAssetObjects(entry, `${pointer}/${index}`, found));
    return found;
  }
  const hasAsset = Object.prototype.hasOwnProperty.call(value, "asset");
  const hasSha = Object.prototype.hasOwnProperty.call(value, "asset_sha256");
  if (hasAsset || hasSha) {
    if (!hasAsset || !hasSha) {
      throw new Error(`${pointer || "/"}: asset and asset_sha256 must be provided together.`);
    }
    found.push({ value, pointer: pointer || "/" });
  }
  for (const [key, child] of Object.entries(value)) {
    collectAssetObjects(child, `${pointer}/${pointerToken(key)}`, found);
  }
  return found;
}

function safeRelativeAsset(value, label) {
  if (typeof value !== "string" || !value.length) {
    throw new Error(`${label}: asset must be a non-empty relative path.`);
  }
  if (value.includes("\\")) throw new Error(`${label}: backslashes are forbidden in asset paths.`);
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    throw new Error(`${label}: absolute asset paths are forbidden.`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`${label}: asset path contains an empty, dot, or parent segment.`);
  }
  if (path.posix.normalize(value) !== value) {
    throw new Error(`${label}: asset path is not normalized.`);
  }
  return value;
}

function ensureInside(root, relative, label) {
  const absoluteRoot = path.resolve(root);
  const absolute = path.resolve(fromPosix(absoluteRoot, relative));
  const back = path.relative(absoluteRoot, absolute);
  if (!back || back.startsWith(`..${path.sep}`) || back === ".." || path.isAbsolute(back)) {
    if (!back) return absolute;
    throw new Error(`${label}: asset resolves outside the runtime root.`);
  }
  return absolute;
}

function looksLikeLfsPointer(bytes) {
  return bytes.subarray(0, 160).toString("utf8")
    .startsWith("version https://git-lfs.github.com/spec/v1\n");
}

async function loadRuntimeSelectionContract(runtimeRoot) {
  const cacheKey = `?itch-model-audit=${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const load = (name) => import(`${pathToFileURL(path.join(runtimeRoot, name)).href}${cacheKey}`);
  const [research, localModes, multiplayer] = await Promise.all([
    load("ResearchAIOptions.js"),
    load("LocalAIModes.js"),
    load("MultiplayerRuntime.js"),
  ]);
  const legacy = research.RESEARCH_FAMILIES
    .map((family) => research.researchProfile(family, "legacy").modelId);
  const transfer = research.RESEARCH_FAMILIES.flatMap((family) => research.TRANSFER_SEEDS
    .map((seed) => research.researchProfile(family, String(seed)).modelId));
  const modelFree = localModes.LOCAL_PLAYER_CHOICES
    .map((choice) => localModes.localPlayerProfile({ choice }, 2, 5, "triangle"))
    .filter((profile) => profile?.strategy === "model-free")
    .map((profile) => profile.modelId);
  const uiMultiplayer = localModes.MULTIPLAYER_AI_CHOICES
    .map((choice) => `multiplayer-${choice.slice(3)}-v1`);
  const runtimeMultiplayer = [...multiplayer.MULTIPLAYER_MODEL_IDS];
  const sort = (values) => [...new Set(values)].sort(compareOrdinal);
  if (JSON.stringify(sort(uiMultiplayer)) !== JSON.stringify(sort(runtimeMultiplayer))) {
    throw new Error("Multiplayer UI choices and runtime model IDs disagree.");
  }
  // Only Easy and Ultimate have assets in the multiplayer manifest; Medium
  // and Hard reuse the three-player/hex runtimes. Keep the packaging closure
  // tied to the current manifest instead of requiring the gameplay runtime to
  // export a release-tool-only list.
  const multiplayerManifestDocument = JSON.parse(await readFile(
    path.join(runtimeRoot, "assets", "research-ai", "multiplayer-v1", "manifest.json"),
    "utf8",
  ));
  const multiplayerManifest = (multiplayerManifestDocument.models ?? []).map((model) => model?.id);
  if (!multiplayerManifest.length || multiplayerManifest.some((id) => typeof id !== "string" || !id)) {
    throw new Error("Invalid multiplayer manifest model IDs.");
  }
  if (multiplayerManifest.some((id) => !runtimeMultiplayer.includes(id))) {
    throw new Error("A multiplayer manifest model is not reachable through the multiplayer runtime.");
  }
  return Object.freeze({
    "assets/research-ai/manifest.json": sort(legacy),
    "assets/research-ai/model-free-manifest.json": sort(modelFree),
    "assets/research-ai/transfer-v1/manifest.json": sort(transfer),
    "assets/research-ai/multiplayer-v1/manifest.json": sort(multiplayerManifest),
  });
}

export async function validateModelAssets({
  runtimeRoot,
  manifests = RUNTIME_MODEL_MANIFESTS,
  f32Root = "assets/research-ai",
  requireAllF32Referenced = true,
  expectedModelIdsByManifest = null,
} = {}) {
  if (!runtimeRoot) throw new Error("runtimeRoot is required.");
  const manifestRecords = [];
  const assetRecords = [];
  const referenced = new Set();

  for (const definition of manifests) {
    const manifestPath = safeRelativeAsset(definition.manifestPath, "manifestPath");
    const assetBase = safeRelativeAsset(definition.assetBase, `${manifestPath}: assetBase`);
    const manifestBytes = await readFile(ensureInside(runtimeRoot, manifestPath, manifestPath));
    let parsed;
    try {
      parsed = JSON.parse(manifestBytes.toString("utf8"));
    } catch (error) {
      throw new Error(`${manifestPath}: invalid JSON (${error.message}).`);
    }
    const entries = collectAssetObjects(parsed);
    if (!entries.length) throw new Error(`${manifestPath}: no asset identities were found.`);
    const modelIds = Array.isArray(parsed.models)
      ? parsed.models.map((model) => model?.id)
      : [];
    if (modelIds.some((id) => typeof id !== "string" || !id.length)) {
      throw new Error(`${manifestPath}: every model entry must have a non-empty string id.`);
    }
    if (new Set(modelIds).size !== modelIds.length) {
      throw new Error(`${manifestPath}: duplicate model id.`);
    }
    const expectedModelIds = expectedModelIdsByManifest?.[manifestPath];
    if (expectedModelIds) {
      const actual = [...modelIds].sort(compareOrdinal);
      const expected = [...expectedModelIds].sort(compareOrdinal);
      const missing = expected.filter((id) => !actual.includes(id));
      const unexpected = actual.filter((id) => !expected.includes(id));
      if (missing.length || unexpected.length) {
        throw new Error(`${manifestPath}: UI/runtime model closure failed; missing [${missing.join(", ")}], unexpected [${unexpected.join(", ")}].`);
      }
    }
    manifestRecords.push({
      path: manifestPath,
      bytes: manifestBytes.byteLength,
      sha256: sha256(manifestBytes),
      model_ids: [...modelIds].sort(compareOrdinal),
      referenced_asset_count: entries.length,
    });

    for (const entry of entries) {
      const label = `${manifestPath}${entry.pointer}`;
      const asset = safeRelativeAsset(entry.value.asset, label);
      const expectedSha = entry.value.asset_sha256;
      if (typeof expectedSha !== "string" || !/^[0-9a-f]{64}$/i.test(expectedSha)) {
        throw new Error(`${label}: asset_sha256 must be 64 hexadecimal characters.`);
      }
      const runtimePath = path.posix.join(assetBase, asset);
      if (referenced.has(runtimePath)) {
        throw new Error(`${label}: duplicate runtime asset reference ${runtimePath}.`);
      }
      referenced.add(runtimePath);
      let bytes;
      try {
        bytes = await readFile(ensureInside(runtimeRoot, runtimePath, label));
      } catch (error) {
        if (error?.code === "ENOENT") {
          throw new Error(`${label}: missing model payload ${runtimePath}; restore approved release assets or run git lfs pull.`);
        }
        throw error;
      }
      if (looksLikeLfsPointer(bytes)) {
        throw new Error(`${label}: ${runtimePath} is only a Git LFS pointer; run git lfs pull before building.`);
      }
      const actualSha = sha256(bytes);
      if (actualSha !== expectedSha.toLowerCase()) {
        throw new Error(`${label}: SHA-256 mismatch for ${runtimePath}; expected ${expectedSha.toLowerCase()}, got ${actualSha}.`);
      }
      const floatCount = entry.value.float_count;
      if (floatCount !== undefined) {
        if (!Number.isSafeInteger(floatCount) || floatCount < 0) {
          throw new Error(`${label}: float_count must be a non-negative safe integer.`);
        }
        if (bytes.byteLength !== floatCount * 4) {
          throw new Error(`${label}: ${runtimePath} has ${bytes.byteLength} bytes, expected float_count * 4 = ${floatCount * 4}.`);
        }
      }
      assetRecords.push({
        path: runtimePath,
        manifest_path: manifestPath,
        json_pointer: entry.pointer,
        model_id: typeof entry.value.id === "string" ? entry.value.id : null,
        bytes: bytes.byteLength,
        sha256: actualSha,
        float_count: floatCount ?? null,
      });
    }
  }

  const allF32 = (await listFiles(fromPosix(runtimeRoot, f32Root)))
    .filter((relative) => relative.toLowerCase().endsWith(".f32"))
    .map((relative) => path.posix.join(f32Root, relative));
  if (requireAllF32Referenced) {
    const unreferenced = allF32.filter((relative) => !referenced.has(relative));
    if (unreferenced.length) {
      throw new Error(`Unreferenced packaged .f32 payloads: ${unreferenced.join(", ")}.`);
    }
  }
  const missingFromScan = [...referenced].filter((relative) => !allF32.includes(relative));
  if (missingFromScan.length) {
    throw new Error(`Referenced assets are outside the runtime .f32 inventory: ${missingFromScan.join(", ")}.`);
  }

  manifestRecords.sort((a, b) => compareOrdinal(a.path, b.path));
  assetRecords.sort((a, b) => compareOrdinal(a.path, b.path));
  return {
    schema: "lifeline-runtime-model-assets-v1",
    manifest_count: manifestRecords.length,
    asset_count: assetRecords.length,
    total_bytes: assetRecords.reduce((sum, entry) => sum + entry.bytes, 0),
    identity_sha256: digestRecords([...manifestRecords, ...assetRecords]),
    manifests: manifestRecords,
    assets: assetRecords,
  };
}

export async function validateRuntimeModelAssets(runtimeRoot) {
  const expectedModelIdsByManifest = await loadRuntimeSelectionContract(runtimeRoot);
  return validateModelAssets({ runtimeRoot, expectedModelIdsByManifest });
}
