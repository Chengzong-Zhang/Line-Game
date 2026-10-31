import { execFileSync } from "node:child_process";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";

import { validateRuntimeModelAssets } from "./model-assets.mjs";
import {
  collectReleaseSourceRecords,
  compareOrdinal,
  digestRecords,
  fileRecords,
  listFiles,
  sha256,
} from "./release-source.mjs";

const itchRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(itchRoot, "..");
const webRoot = path.join(repoRoot, "web", "web前端");
const artifactRoot = path.join(repoRoot, "local_artifacts", "itch-html5");
const distRoot = path.join(artifactRoot, "dist");
const config = JSON.parse(await readFile(path.join(itchRoot, "config", "release.json"), "utf8"));
const zipPath = path.join(artifactRoot, `${config.candidate_id}.zip`);
const receiptPath = path.join(artifactRoot, `${config.candidate_id}-build-receipt.json`);

async function copyRuntime() {
  const entries = await readdir(webRoot, { withFileTypes: true });
  const topLevelFiles = entries
    .filter((entry) => entry.isFile())
    .filter((entry) => entry.name !== "smoke-test.html")
    .filter((entry) => /\.(?:css|html|js)$/i.test(entry.name))
    .sort((a, b) => compareOrdinal(a.name, b.name));
  for (const entry of topLevelFiles) {
    await cp(path.join(webRoot, entry.name), path.join(distRoot, entry.name));
  }
  for (const directory of ["assets", "guide"]) {
    await cp(path.join(webRoot, directory), path.join(distRoot, directory), { recursive: true });
  }
}

async function patchDocument() {
  const indexPath = path.join(distRoot, "index.html");
  const source = await readFile(indexPath, "utf8");
  const mathJaxPattern = /<script defer src="https:\/\/cdn\.jsdelivr\.net\/npm\/mathjax@3\/es5\/tex-chtml\.js"><\/script>/;
  const mainPattern = /<script type="module" src="\.\/main\.js\?v=[^"]+"><\/script>/;
  const viewportPattern = /(<meta name="viewport"[^>]+>)/;
  const mainTag = source.match(mainPattern)?.[0];
  if (!mathJaxPattern.test(source) || !mainTag || !viewportPattern.test(source)) {
    throw new Error("The current Web document no longer matches the reviewed itch patch points.");
  }
  const patched = source
    .replace(viewportPattern, '$1\n    <link rel="icon" href="data:," />')
    .replace(mathJaxPattern, '<script defer src="./vendor/mathjax/es5/tex-chtml.js"></script>')
    .replace(mainPattern, [
      '<script src="./vendor/vue.global.prod.js"></script>',
      '<script src="./itch-config.js"></script>',
      mainTag,
    ].join("\n    "));
  if (/<(?:script|link)\b[^>]+(?:src|href)="https?:\/\//i.test(patched)) {
    throw new Error("The itch entry document still depends on a remote runtime asset.");
  }
  await writeFile(indexPath, patched, "utf8");
}

async function patchFonts() {
  const stylesPath = path.join(distRoot, "styles.css");
  const original = await readFile(stylesPath, "utf8");
  const withoutRemoteImport = original.replace(
    /^@import url\("https:\/\/fonts\.googleapis\.com\/css2\?family=Cormorant\+Garamond[^\n]*\r?\n/m,
    "",
  );
  if (withoutRemoteImport === original) {
    throw new Error("The reviewed Google Fonts import was not found in styles.css.");
  }
  const fontImports = [400, 500, 600, 700]
    .map((weight) => `@import url("./fonts/manrope-${weight}.css");`)
    .concat([500, 600, 700].map((weight) => `@import url("./fonts/cormorant-${weight}.css");`));
  await writeFile(stylesPath, `${fontImports.join("\n")}\n${withoutRemoteImport}`, "utf8");

  const copyFontFace = async (packageName, sourceName, targetName) => {
    const packageRoot = path.join(itchRoot, "node_modules", "@fontsource", packageName);
    const css = await readFile(path.join(packageRoot, sourceName), "utf8");
    const references = [...css.matchAll(/url\((?:"|')?\.\/files\/([^)'"\s]+)(?:"|')?\)/g)]
      .map((match) => match[1]);
    if (!references.length) throw new Error(`No font files found in ${packageName}/${sourceName}.`);
    await mkdir(path.join(distRoot, "fonts"), { recursive: true });
    await writeFile(path.join(distRoot, "fonts", targetName), css, "utf8");
    for (const name of references) {
      const target = path.join(distRoot, "fonts", "files", name);
      await mkdir(path.dirname(target), { recursive: true });
      await cp(path.join(packageRoot, "files", name), target);
    }
  };
  for (const weight of [400, 500, 600, 700]) {
    await copyFontFace("manrope", `latin-${weight}.css`, `manrope-${weight}.css`);
  }
  for (const weight of [500, 600, 700]) {
    await copyFontFace("cormorant-garamond", `latin-${weight}.css`, `cormorant-${weight}.css`);
  }
}

async function copyVendorAssets() {
  await mkdir(path.join(distRoot, "vendor"), { recursive: true });
  await cp(
    path.join(itchRoot, "node_modules", "vue", "dist", "vue.global.prod.js"),
    path.join(distRoot, "vendor", "vue.global.prod.js"),
  );
  await cp(
    path.join(itchRoot, "node_modules", "mathjax", "es5"),
    path.join(distRoot, "vendor", "mathjax", "es5"),
    { recursive: true },
  );
}

async function writeLegalNotices() {
  const packages = [
    { name: "vue", version: "3.5.44", license: "MIT", source: ["vue", "LICENSE"] },
    { name: "mathjax", version: "3.2.2", license: "Apache-2.0", source: ["mathjax", "LICENSE"] },
    { name: "@fontsource/manrope", version: "5.3.0", license: "OFL-1.1", source: ["@fontsource", "manrope", "LICENSE"] },
    { name: "@fontsource/cormorant-garamond", version: "5.3.0", license: "OFL-1.1", source: ["@fontsource", "cormorant-garamond", "LICENSE"] },
  ];
  const licenseRoot = path.join(distRoot, "legal", "licenses");
  await mkdir(licenseRoot, { recursive: true });
  const records = [];
  for (const item of packages) {
    const bytes = await readFile(path.join(itchRoot, "node_modules", ...item.source));
    const filename = `${item.name.replaceAll("@", "").replaceAll("/", "-")}.txt`;
    await writeFile(path.join(licenseRoot, filename), bytes);
    records.push({ ...item, source: undefined, path: `licenses/${filename}`, bytes: bytes.byteLength, sha256: sha256(bytes) });
  }
  const escape = (value) => String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
  const sections = [];
  for (const item of records) {
    const text = await readFile(path.join(distRoot, "legal", item.path), "utf8");
    sections.push(`<section><h2>${escape(item.name)} ${escape(item.version)}</h2><p>${escape(item.license)} · SHA-256 ${item.sha256}</p><pre>${escape(text)}</pre></section>`);
  }
  const html = `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LIFELINE third-party notices</title><style>body{max-width:70rem;margin:auto;padding:1.5rem;background:#f4ede1;color:#2a2118;font:16px/1.55 system-ui,sans-serif}a{color:#173e8f}section{padding:1rem;margin:1rem 0;background:#fffaf0;border:1px solid #cfbfa6;border-radius:1rem}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:.78rem}</style></head><body><p><a href="../index.html">← LIFELINE / 生命线</a></p><h1>Third-party notices / 第三方软件声明</h1>${sections.join("")}<p>Source package versions are pinned in <code>itch/package-lock.json</code>.</p></body></html>\n`;
  await writeFile(path.join(distRoot, "legal", "THIRD_PARTY_NOTICES.html"), html, "utf8");
  await writeFile(path.join(distRoot, "legal", "license-manifest.json"), `${JSON.stringify({ schema: "lifeline-itch-third-party-licenses-v1", packages: records }, null, 2)}\n`, "utf8");
}

function currentCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch (_error) {
    return null;
  }
}

const sourceModelAssets = await validateRuntimeModelAssets(webRoot);
await rm(distRoot, { recursive: true, force: true });
await rm(zipPath, { force: true });
await mkdir(distRoot, { recursive: true });
await copyRuntime();
await patchDocument();
await patchFonts();
await copyVendorAssets();
await writeLegalNotices();
await writeFile(path.join(distRoot, "itch-config.js"), [
  `globalThis.__LIFELINE_RUNTIME_CONFIG__ = Object.freeze(${JSON.stringify(config.runtime)});`,
  `globalThis.__LIFELINE_ITCH_BUILD__ = Object.freeze(${JSON.stringify({ candidateId: config.candidate_id, version: config.version })});`,
  "",
].join("\n"), "utf8");

const packagedModelAssets = await validateRuntimeModelAssets(distRoot);
if (packagedModelAssets.identity_sha256 !== sourceModelAssets.identity_sha256) {
  throw new Error("Packaged model asset identity differs from the validated source inventory.");
}
const sourceRecords = await collectReleaseSourceRecords({ repoRoot, itchRoot });
const sourceTreeSha256 = digestRecords(sourceRecords);
await writeFile(path.join(distRoot, "build-info.json"), `${JSON.stringify({
  schema: "lifeline-itch-build-info-v1",
  candidate_id: config.candidate_id,
  version: config.version,
  channel: config.channel,
  rules_version: config.rules_version,
  asset_version: config.asset_version,
  source_tree_sha256: sourceTreeSha256,
}, null, 2)}\n`, "utf8");

const packageFilesBeforeManifest = await listFiles(distRoot);
const packageRecords = await fileRecords(distRoot, packageFilesBeforeManifest);
const caseFolded = new Map();
for (const entry of packageRecords) {
  if (entry.path.length > config.itch_limits.max_path_characters) throw new Error(`itch path limit exceeded: ${entry.path}`);
  if (entry.bytes > config.itch_limits.max_file_bytes) throw new Error(`itch per-file limit exceeded: ${entry.path}`);
  const folded = entry.path.toLowerCase();
  if (caseFolded.has(folded)) throw new Error(`Case-insensitive path collision: ${entry.path} / ${caseFolded.get(folded)}`);
  caseFolded.set(folded, entry.path);
}
await writeFile(path.join(distRoot, "asset-manifest.json"), `${JSON.stringify({
  schema: "lifeline-itch-asset-manifest-v1",
  candidate_id: config.candidate_id,
  source_tree_sha256: sourceTreeSha256,
  runtime_model_assets: packagedModelAssets,
  files: packageRecords,
}, null, 2)}\n`, "utf8");

const finalFiles = await listFiles(distRoot);
const finalRecords = await fileRecords(distRoot, finalFiles);
const totalBytes = finalRecords.reduce((sum, entry) => sum + entry.bytes, 0);
if (finalRecords.length > config.itch_limits.max_files) throw new Error(`itch file count limit exceeded: ${finalRecords.length}`);
if (totalBytes > config.itch_limits.max_total_bytes) throw new Error(`itch total size limit exceeded: ${totalBytes}`);
if (!finalRecords.some((entry) => entry.path === "index.html")) throw new Error("The package root must contain index.html.");

const zipEntries = {};
for (const entry of finalRecords) {
  const bytes = await readFile(path.join(distRoot, ...entry.path.split("/")));
  zipEntries[entry.path] = [new Uint8Array(bytes), { mtime: new Date(1980, 0, 1, 0, 0, 0) }];
}
const zipBytes = zipSync(zipEntries, { level: 9 });
await writeFile(zipPath, zipBytes);
const receipt = {
  schema: "lifeline-itch-html5-build-receipt-v1",
  status: "PASS_PACKAGE_CURRENT",
  candidate_id: config.candidate_id,
  version: config.version,
  channel: config.channel,
  rules_version: config.rules_version,
  source_git_commit: currentCommit(),
  source_tree_sha256: sourceTreeSha256,
  runtime_model_assets: packagedModelAssets,
  file_count: finalRecords.length,
  total_uncompressed_bytes: totalBytes,
  maximum_file_bytes: Math.max(...finalRecords.map((entry) => entry.bytes)),
  maximum_path_characters: Math.max(...finalRecords.map((entry) => entry.path.length)),
  manifest_sha256: finalRecords.find((entry) => entry.path === "asset-manifest.json")?.sha256,
  zip_path: path.relative(repoRoot, zipPath).replaceAll(path.sep, "/"),
  zip_bytes: zipBytes.byteLength,
  zip_sha256: sha256(zipBytes),
  dist_path: path.relative(repoRoot, distRoot).replaceAll(path.sep, "/"),
  limits: config.itch_limits,
};
await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
console.log(JSON.stringify(receipt));
