import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const [snapshotDirectory, reportFile] = process.argv.slice(2);
assert.ok(snapshotDirectory && reportFile, "Pass a captured source snapshot directory and report path.");
const capture = path.resolve(snapshotDirectory);
const manifest = JSON.parse(fs.readFileSync(path.join(capture, "snapshot.json"), "utf8"));
assert.equal(manifest.status, "SOURCE_SNAPSHOT_STABLE");
const hash = value => createHash("sha256").update(value).digest("hex");
assert.equal(hash(JSON.stringify(manifest.files)), manifest.inventorySha256);
const hybrids = {
  "AIEngine.js": "Keep bounded desktop minimax search.",
  "AIWorker.js": "Keep desktop minimax time/node budgets alongside current multiplayer strategies.",
  "GameController.js": "Retain desktop input locks and game feedback.",
  "LocalAIModes.js": "Keep the desktop minimax budget configuration.",
  "LocalGameSession.js": "Retain native save IPC and retry revision handling.",
  "OnlineApp.js": "Merge current Web features with tutorials, campaign, profile, backup, milestones and safe saves.",
  "OnlineAppI18n.js": "Retain desktop opponent and budget labels.",
  "Renderer.js": "Keep desktop reduced-motion feedback.",
  "ReplayCodec.js": "Retain native replay export.",
  "TrainingContribution.js": "Keep desktop submission disabled and contribution controls locked.",
  "styles.css": "Keep desktop menus, progress transfer and achievements layout.",
};
const files = [];
for (const item of manifest.files.filter(file => !file.path.startsWith("tests/"))) {
  const source = fs.readFileSync(path.join(capture, "frontend", item.path));
  assert.equal(hash(source), item.sha256, `Captured source changed: ${item.path}`);
  const target = fs.readFileSync(path.join(root, "web/web前端", item.path));
  const equal = hash(source) === hash(target) || (/\.(js|css|html|md|json|tex)$/.test(item.path)
    && source.toString("utf8").replaceAll("\r\n", "\n") === target.toString("utf8").replaceAll("\r\n", "\n"));
  assert.ok(equal || hybrids[item.path], `Unreviewed source difference: ${item.path}`);
  if (item.path.endsWith(".f32")) {
    assert.ok(!target.subarray(0, 45).toString().startsWith("version https://git-lfs"), `Model is a pointer: ${item.path}`);
  }
  files.push({ path: item.path, sourceSha256: item.sha256, targetSha256: hash(target),
    status: equal ? "SOURCE_MATCH" : "REVIEWED_DESKTOP_MERGE",
    equalityMode: hash(source) === hash(target) ? "EXACT_BYTES" : equal ? "NORMALIZED_LF_TEXT" : "REVIEWED_DESKTOP_HYBRID",
    ...(equal ? {} : { reason: hybrids[item.path] }) });
}
const report = { status: "SOURCE_PARITY_PASS", sourceHead: manifest.sourceHead,
  snapshotSha256: manifest.inventorySha256, sourceWorkingTreeIncluded: true,
  sourceMatches: files.filter(file => file.status === "SOURCE_MATCH").length,
  reviewedDesktopMerges: files.filter(file => file.status === "REVIEWED_DESKTOP_MERGE").length,
  files, boundary: "Source/resource correspondence and reviewed hybrid differences; runtime acceptance is separate." };
fs.mkdirSync(path.dirname(path.resolve(reportFile)), { recursive: true });
fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ...report, files: undefined }));
