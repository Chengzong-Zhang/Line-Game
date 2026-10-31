import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

// Sequential actual-window regression: each child owns and closes its profile
// and app. Raw output stays local; the receipt records exact commands and hashes.
const root = fileURLToPath(new URL("../../", import.meta.url));
const archive = path.join(root, "desktop/release/win-unpacked/resources/app.asar");
const hash = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const evidence = fs.mkdtempSync(path.join(root, "local_artifacts/parent-final-suite-"));
const receipt = { status: "RUNNING", evidence, packageSha256: hash(archive), checks: [] };
const commands = [
  ["parent-tutorial-ui.mjs"],
  ["parent-tutorial-ui.mjs", "--english", "--compact"],
  ["parent-guide-ui.mjs"],
  ["parent-challenge-ui.mjs", "--all-levels"],
  ["parent-challenge-ui.mjs", "--all-levels", "--english", "--compact"],
  ["parent-profile-boundaries.mjs"],
  ["parent-desktop-ux.mjs"],
  ["parent-save-boundaries.mjs"],
];
const persist = () => fs.writeFileSync(path.join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2));
persist();
try {
  for (const [index, [script, ...args]] of commands.entries()) {
    assert.equal(hash(archive), receipt.packageSha256, "package must remain immutable across the suite");
    const argv = ["--unhandled-rejections=strict", `desktop/tests/${script}`, ...args];
    console.log(`START ${script} ${args.join(" ")}`);
    const result = spawnSync(process.execPath, argv, { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    const log = path.join(evidence, `${index + 1}-${script}.log`);
    fs.writeFileSync(log, `${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    const jsonLine = result.stdout?.trim().split(/\r?\n/).findLast(line => line.startsWith("{"));
    const output = jsonLine ? JSON.parse(jsonLine) : null;
    const record = { command: `node ${argv.join(" ")}`, exitCode: result.status, status: output?.status,
      evidence: output?.evidence, rawLogSha256: hash(log), testSha256: hash(path.join(root, "desktop/tests", script)) };
    receipt.checks.push(record);
    persist();
    console.log(JSON.stringify(record));
    assert.equal(result.status, 0, result.error?.message ?? `${script} exited unsuccessfully`);
    assert.ok(output?.status?.endsWith("PASS"), `an unqualified pass is required: ${output?.status}`);
    assert.equal(output.packageSha256, receipt.packageSha256);
  }
  receipt.status = "FINAL_PACKAGE_REGRESSION_PASS";
} catch (error) {
  receipt.status = "FAIL";
  receipt.error = String(error.stack ?? error);
  process.exitCode = 1;
} finally {
  persist();
  console.log(JSON.stringify(receipt));
}
