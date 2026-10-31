import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import asar from "@electron/asar";
import { prepareApp, prepareHtml, prepareMain, prepareStyles } from "./prepare-renderer-assets.mjs";

export const workspace = fileURLToPath(new URL("../../", import.meta.url));
export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
export const fileHash = file => sha256(fs.readFileSync(file));
export const json = file => JSON.parse(fs.readFileSync(file, "utf8"));
const require = createRequire(import.meta.url);
const slash = value => value.replaceAll("\\", "/");
export function assert(condition, message) { if (!condition) throw new Error(message); }
export function safeRelative(value) {
  assert(typeof value === "string" && value.length > 0 && !/[\\:\x00-\x1f]/.test(value)
    && !value.startsWith("/") && value.split("/").every(p => p && p !== "." && p !== ".."), `Unsafe relative path: ${value}`);
  return value;
}
export function filesIn(directory) {
  assert(!fs.lstatSync(directory).isSymbolicLink(), `Linked directory rejected: ${directory}`);
  const entries = [];
  function visit(current, prefix) {
    for (const item of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(current, item.name), relative = prefix + item.name;
      assert(!fs.lstatSync(file).isSymbolicLink(), `Linked entry rejected: ${file}`);
      if (item.isDirectory()) visit(file, relative + "/");
      else {
        assert(item.isFile(), `Non-regular entry rejected: ${file}`);
        entries.push({ path: safeRelative(relative), bytes: fs.statSync(file).size, sha256: fileHash(file) });
      }
    }
  }
  visit(directory, "");
  return entries;
}
export function verifyInventory(directory, expected) {
  const actual = filesIn(directory);
  assert(Array.isArray(expected) && expected.length > 0, "Missing file inventory");
  const byPath = new Map();
  for (const entry of expected) {
    safeRelative(entry.path);
    assert(!byPath.has(entry.path.toLowerCase()), `Duplicate path: ${entry.path}`);
    assert(Number.isSafeInteger(entry.bytes) && entry.bytes >= 0 && /^[a-f0-9]{64}$/.test(entry.sha256), "Invalid inventory entry");
    byPath.set(entry.path.toLowerCase(), entry);
  }
  assert(actual.length === expected.length, "Candidate file count changed (missing or extra file)");
  for (const item of actual) {
    const original = byPath.get(item.path.toLowerCase());
    assert(original && item.bytes === original.bytes && item.sha256 === original.sha256, `Candidate changed: ${item.path}`);
  }
  return actual;
}
export function assertDistributionPaths(entries) {
  for (const { path: name } of entries) {
    safeRelative(name);
    assert(!/(^|\/)(\.git|\.env(?:\..*)?|user-data|userData|saves|profile|local_artifacts|steam_appid\.txt)(\/|$)/i.test(name)
      && !/\.(pem|pfx|p12|key|db|log|dmp|pdb)$/i.test(name), `Private/debug file in distribution: ${name}`);
  }
}
export function assertExactPaths(actual, expected, label) {
  const a = [...actual].sort(), e = [...expected].sort();
  assert(new Set(a).size === a.length && new Set(e).size === e.length, `Duplicate ${label} paths`);
  const missing = e.filter(p => !a.includes(p)), extra = a.filter(p => !e.includes(p));
  assert(!missing.length && !extra.length, `${label} file set differs: missing=${missing.join(",")} extra=${extra.join(",")}`);
}
export function localOutputRoot(relative) {
  safeRelative(relative);
  const root = fs.realpathSync(workspace);
  let current = workspace;
  for (const segment of relative.split("/")) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) fs.mkdirSync(current);
    assert(!fs.lstatSync(current).isSymbolicLink(), `Linked output directory rejected: ${current}`);
    assert(fs.realpathSync(current).toLowerCase().startsWith((root + path.sep).toLowerCase()), "Output directory escaped workspace");
  }
  return current;
}
export function inspectPackage(appDirectory) {
  const archive = path.join(appDirectory, "resources/app.asar");
  for (const required of ["LIFELINE.exe", "resources/app.asar", "LICENSE.electron.txt", "LICENSES.chromium.html", "resources/legal/THIRD_PARTY_NOTICES.md", "resources/legal/DEPENDENCY_LICENSES.txt"]) {
    assert(fs.statSync(path.join(appDirectory, required)).size > 0, `Missing ${required}`);
  }
  const inventory = filesIn(appDirectory);
  assertDistributionPaths(inventory);
  const packedPaths = asar.listPackage(archive).map(p => slash(p).replace(/^\//, ""))
    .filter(p => !asar.statFile(archive, path.normalize(p)).files);
  assertDistributionPaths(packedPaths.map(p => ({ path: p })));
  assert(!packedPaths.some(p => /^desktop\/renderer\/(tests|\.git)\//.test(p)), "Renderer test source included in app");
  const packed = name => asar.extractFile(archive, path.normalize(name));
  const sourcePackage = json(path.join(workspace, "package.json"));
  const packedPackage = JSON.parse(packed("package.json"));
  assert(packedPackage.version === sourcePackage.version && packedPackage.name === sourcePackage.name, "Package identity/version does not match source");
  const sourceFiles = [];
  const compare = (source, target = source, transform = null) => {
    const bytes = fs.readFileSync(path.join(workspace, source));
    const prepared = transform ? Buffer.from(transform(bytes.toString("utf8"))) : bytes;
    assert(sha256(packed(target)) === sha256(prepared), `Stale packaged source: ${source}`);
    sourceFiles.push({ path: source, sha256: sha256(bytes) });
  };
  for (const name of ["desktop/main.cjs", "desktop/preload.cjs", "desktop/package-metadata.json"]) compare(name);
  for (const item of filesIn(path.join(workspace, "desktop/src"))) compare(`desktop/src/${item.path}`);
  const frontend = "web/web前端";
  for (const name of fs.readdirSync(path.join(workspace, frontend)).filter(p => p.endsWith(".js"))) {
    compare(`${frontend}/${name}`, `desktop/renderer/${name}`, name === "main.js" ? prepareMain : name === "OnlineApp.js" ? prepareApp : null);
  }
  compare(`${frontend}/index.html`, "desktop/renderer/index.html", prepareHtml);
  compare(`${frontend}/styles.css`, "desktop/renderer/styles.css", prepareStyles);
  const expectedResources = [];
  for (const directory of ["assets/research-ai", "guide/rule", "guide/guide-images"]) {
    expectedResources.push(...filesIn(path.join(workspace, frontend, directory)).map(p => `desktop/renderer/${directory}/${p.path}`));
  }
  expectedResources.push(...fs.readdirSync(path.join(workspace, frontend, "guide")).filter(p => /^Thanks.*\.md$/.test(p)).map(p => `desktop/renderer/guide/${p}`));
  expectedResources.push(...fs.readdirSync(path.join(workspace, frontend, "guide/interesting")).filter(p => /^why-(talk|code|theory)\..*\.md$/.test(p)).map(p => `desktop/renderer/guide/interesting/${p}`));
  const packedResources = packedPaths.filter(p => p.startsWith("desktop/renderer/guide/") || p.startsWith("desktop/renderer/assets/"));
  assertExactPaths(packedResources, expectedResources, "Renderer resource");
  for (const file of expectedResources) {
    compare(file.replace("desktop/renderer", frontend), file);
    if (file.endsWith(".f32")) assert(!packed(file).subarray(0, 80).toString().startsWith("version https://git-lfs"), `LFS pointer in package: ${file}`);
  }
  for (const name of ["THIRD_PARTY_NOTICES.md", "DEPENDENCY_LICENSES.txt"]) {
    assert(fileHash(path.join(appDirectory, "resources/legal", name)) === fileHash(path.join(workspace, "desktop/legal", name)), `Stale notices: ${name}`);
  }
  for (const name of ["node_modules/vue/LICENSE", "node_modules/mathjax-full/LICENSE"]) assert(packed(name).length > 100, `Missing bundled license ${name}`);
  const git = args => execFileSync("git", args, { cwd: workspace, encoding: "utf8", windowsHide: true }).trim();
  return {
    format: "lifeline-package-preflight", schemaVersion: 1, status: "LOCAL_PACKAGE_PREFLIGHT_PASS",
    version: sourcePackage.version, appAsarSha256: fileHash(archive), executableSha256: fileHash(path.join(appDirectory, "LIFELINE.exe")),
    packedFileCount: packedPaths.length, modelCount: packedPaths.filter(p => p.endsWith(".f32")).length,
    source: { head: git(["rev-parse", "HEAD"]), branch: git(["branch", "--show-current"]),
      dirty: Boolean(git(["status", "--porcelain"])), lockSha256: fileHash(path.join(workspace, "package-lock.json")), files: sourceFiles },
    inventory, steamVerified: false, runtimeTests: "NOT_RUN_BY_PREFLIGHT", signature: "NOT_CHECKED_BY_PREFLIGHT"
  };
}
export function verifyCandidate(candidateDirectory) {
  const receipt = json(path.join(candidateDirectory, "candidate.json"));
  assert(receipt.format === "lifeline-release-candidate" && receipt.schemaVersion === 1 && receipt.status === "SNAPSHOT_COMPLETE", "Not a completed candidate");
  verifyInventory(path.join(candidateDirectory, "win-unpacked"), receipt.package.inventory);
  const archive = path.join(candidateDirectory, "win-unpacked/resources/app.asar");
  assert(fileHash(archive) === receipt.package.appAsarSha256, "Candidate archive mismatch");
  safeRelative(receipt.portable.path);
  assert(!receipt.portable.path.includes("/"), "Portable path must be a file name");
  const portable = path.join(candidateDirectory, receipt.portable.path);
  assert(fs.statSync(portable).size === receipt.portable.bytes && fileHash(portable) === receipt.portable.sha256, "Candidate portable changed");
  assertDistributionPaths(receipt.package.inventory);
  return receipt;
}
export async function inspectPortable(portable, packageReport) {
  const sevenZip = await require("app-builder-lib/out/toolsets/7zip").getPath7za();
  const listing = execFileSync(sevenZip, ["l", "-slt", portable], { encoding:"utf8", windowsHide:true, maxBuffer:4*1024*1024 });
  const records = listing.split(/----------\r?\n/).at(-1).split(/\r?\n\r?\n/).filter(record => record.startsWith("Path = "));
  const embedded = records.filter(record => !/^Attributes = D/m.test(record)).map(record => {
    assert(!/Symbolic Link|Hard Link/.test(record), "Linked file in portable payload");
    const name = slash(record.match(/^Path = (.+)/m)[1].trim());
    return { path:safeRelative(name), bytes:Number(record.match(/^Size = (\d+)/m)?.[1]) };
  });
  assertExactPaths(embedded.map(p=>p.path),packageReport.inventory.map(p=>p.path),"Portable payload");
  for(const entry of embedded) assert(entry.bytes===packageReport.inventory.find(p=>p.path===entry.path).bytes,`Portable size mismatch: ${entry.path}`);
  // Stream just the archive to stdout: no external executable is launched and
  // no archive path can write into the filesystem during this inspection.
  const extracted = spawnSync(sevenZip,["x","-so",portable,"resources/app.asar"],{windowsHide:true,maxBuffer:256*1024*1024});
  assert(extracted.status===0 && !extracted.error,`Cannot inspect portable archive: ${extracted.error?.message ?? extracted.stderr?.toString()}`);
  assert(sha256(extracted.stdout)===packageReport.appAsarSha256,"Portable contains a different app.asar than the tested unpacked package");
  return {status:"PORTABLE_ARCHIVE_AND_FILE_SET_MATCH",appAsarSha256:sha256(extracted.stdout),embeddedFileCount:embedded.length,
    boundary:"Exact app.asar bytes and all embedded file names/sizes checked. Portable runtime and signatures are separate checks."};
}
export function makeSteamScripts(config, candidateDirectory) {
  assert(config?.format === "lifeline-steam-config" && config.schemaVersion === 1, "Invalid Steam configuration");
  for (const [key, value] of [["appId", config.appId], ["windowsDepotId", config.windowsDepotId]]) {
    assert(Number.isSafeInteger(value) && value > 0 && value <= 4294967295 && value !== 480, `${key} requires your own numeric Steam ID; placeholders/Spacewar are rejected`);
  }
  assert(config.appId !== config.windowsDepotId, "AppID and depot ID must differ");
  const receipt = verifyCandidate(candidateDirectory);
  const quote = value => { assert(!/["\r\n\x00]/.test(value), "Unsafe VDF value"); return `"${slash(value)}"`; };
  const content = path.join(path.resolve(candidateDirectory), "win-unpacked");
  const app = `"AppBuild"\n{\n  "AppID" "${config.appId}"\n  "Desc" ${quote(`LIFELINE ${receipt.package.version} local preview ${receipt.package.appAsarSha256.slice(0, 12)}`)}\n  "Preview" "1"\n  "ContentRoot" ${quote(content)}\n  "BuildOutput" "./cache"\n  "Depots"\n  {\n    "${config.windowsDepotId}" "depot_windows.vdf"\n  }\n}\n`;
  const depot = `"DepotBuild"\n{\n  "DepotID" "${config.windowsDepotId}"\n  "FileMapping"\n  {\n    "LocalPath" "*"\n    "DepotPath" "."\n    "Recursive" "1"\n  }\n  "FileExclusion" "steam_appid.txt"\n  "FileExclusion" "*.pdb"\n  "FileExclusion" "*.log"\n}\n`;
  return { app, depot, appAsarSha256: receipt.package.appAsarSha256 };
}
