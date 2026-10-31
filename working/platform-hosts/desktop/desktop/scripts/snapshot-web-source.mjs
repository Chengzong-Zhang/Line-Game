import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

// Copy the public frontend, including current uncommitted product work, without
// changing the source checkout. A second hash pass rejects a moving snapshot.
const root = fileURLToPath(new URL("../../", import.meta.url));
const option = name => process.argv[process.argv.indexOf(name) + 1];
if (!process.argv.includes("--source") || !process.argv.includes("--output")) {
  throw new Error("Usage: node desktop/scripts/snapshot-web-source.mjs --source <repository> --output <new local_artifacts directory>");
}
const source = fs.realpathSync(option("--source"));
const frontend = path.join(source, "web", "web前端");
const output = path.resolve(option("--output"));
const localRoot = path.join(root, "local_artifacts");
if (!output.startsWith(`${localRoot}${path.sep}`) || fs.existsSync(output)) {
  throw new Error("Snapshot output must be a new directory inside this checkout's local_artifacts.");
}
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
function list(directory, prefix = "") {
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    if ([".test-tmp", ".git", "node_modules", "__pycache__"].includes(entry.name)) return [];
    if (entry.isSymbolicLink()) throw new Error(`Linked frontend entry: ${entry.name}`);
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return list(path.join(directory, entry.name), relative);
    if (!entry.isFile()) throw new Error(`Unsupported frontend entry: ${relative}`);
    if (/^(?:\.env(?:\..*)?|.*\.(?:pem|key|pfx))$/i.test(entry.name)) throw new Error(`Private file in public frontend: ${relative}`);
    return [relative];
  });
}
const names = list(frontend);
const files = names.map(relative => {
  const bytes = fs.readFileSync(path.join(frontend, relative));
  const destination = path.join(output, "frontend", relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, bytes, { flag: "wx" });
  return { path: relative, bytes: bytes.length, sha256: digest(bytes) };
});
if (JSON.stringify(names) !== JSON.stringify(list(frontend))) throw new Error("Frontend file inventory changed during snapshot; preserve this attempt and take another.");
for (const file of files) {
  if (digest(fs.readFileSync(path.join(frontend, file.path))) !== file.sha256) {
    throw new Error(`Frontend changed during snapshot: ${file.path}; preserve this attempt and take another.`);
  }
}
const receipt = {
  schemaVersion: 1, status: "SOURCE_SNAPSHOT_STABLE", capturedAtUtc: new Date().toISOString(),
  sourceHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8", windowsHide: true }).trim(),
  targetHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true }).trim(),
  sourceWorkingTreeIncluded: true, fileCount: files.length,
  inventorySha256: digest(JSON.stringify(files)), files,
};
fs.writeFileSync(path.join(output, "snapshot.json"), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify({ ...receipt, files: undefined, output }));
