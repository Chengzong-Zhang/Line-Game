import fs from "node:fs";
import path from "node:path";
import { workspace, assert, json, fileHash, inspectPackage, verifyCandidate, makeSteamScripts, verifyInventory, localOutputRoot, inspectPortable } from "./release-lib.mjs";

const [command, argument, configFile] = process.argv.slice(2);
const release = path.join(workspace, "desktop/release");
try {
  if (command === "preflight") {
    localOutputRoot("desktop/release");
    const report = inspectPackage(path.join(release, "win-unpacked"));
    const reportPath = path.join(release, "preflight.json");
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify({ status: report.status, version: report.version, appAsarSha256: report.appAsarSha256, reportPath }));
  } else if (command === "snapshot") {
    assert(/^[a-z0-9][a-z0-9.-]{2,70}$/.test(argument ?? ""), "Provide a new candidate ID (lowercase letters, digits, periods or hyphens)");
    const report = inspectPackage(path.join(release, "win-unpacked"));
    const portableName = `LIFELINE-${report.version}-x64-portable.exe`;
    const portable = path.join(release, portableName);
    assert(fs.statSync(portable).size > 1_000_000, "Build the portable executable first");
    const portableAgreement = await inspectPortable(portable,report);
    const base = localOutputRoot("desktop/release/candidates");
    assert(fs.realpathSync(base).toLowerCase().startsWith((fs.realpathSync(release) + path.sep).toLowerCase()), "Candidate directory escaped release root");
    const destination = path.join(base, argument);
    // Never overwrite a previous candidate, including incomplete evidence.
    fs.mkdirSync(destination);
    const receipt = { format: "lifeline-release-candidate", schemaVersion: 1, id: argument,
      createdAt: new Date().toISOString(), status: "SNAPSHOT_INCOMPLETE", package: report,
      portable: { path: portableName, bytes: fs.statSync(portable).size, sha256: fileHash(portable), agreement: portableAgreement },
      verification: "Hash/source preflight only. Bind runtime acceptance separately to this archive and portable hash." };
    const record = () => fs.writeFileSync(path.join(destination, "candidate.json"), JSON.stringify(receipt, null, 2) + "\n");
    record();
    const appCopy = path.join(destination, "win-unpacked");
    fs.mkdirSync(appCopy);
    for (const entry of report.inventory) {
      const output = path.join(appCopy, entry.path);
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.copyFileSync(path.join(release, "win-unpacked", entry.path), output, fs.constants.COPYFILE_EXCL);
    }
    fs.copyFileSync(portable, path.join(destination, portableName), fs.constants.COPYFILE_EXCL);
    verifyInventory(appCopy, report.inventory);
    assert(fileHash(path.join(destination, portableName)) === receipt.portable.sha256, "Portable copy mismatch");
    receipt.status = "SNAPSHOT_COMPLETE";
    record();
    verifyCandidate(destination);
    console.log(JSON.stringify({ status: receipt.status, destination, appAsarSha256: report.appAsarSha256, portableSha256: receipt.portable.sha256 }));
  } else if (command === "verify") {
    const receipt = verifyCandidate(path.resolve(argument));
    console.log(JSON.stringify({ status: "CANDIDATE_INTEGRITY_PASS", id: receipt.id, appAsarSha256: receipt.package.appAsarSha256, steamVerified: false }));
  } else if (command === "steam-preview") {
    assert(configFile, "Usage: steam-preview <candidate-directory> <local-config.json>");
    const scripts = makeSteamScripts(json(path.resolve(configFile)), path.resolve(argument));
    const output = path.join(localOutputRoot("desktop/release/steam-preview"), `${Date.now()}`);
    fs.mkdirSync(output);
    fs.writeFileSync(path.join(output, "app_build.vdf"), scripts.app, { flag: "wx" });
    fs.writeFileSync(path.join(output, "depot_windows.vdf"), scripts.depot, { flag: "wx" });
    console.log(JSON.stringify({ status: "PREVIEW_SCRIPTS_GENERATED_ONLY", output, appAsarSha256: scripts.appAsarSha256, steamcmdInvoked: false, uploaded: false }));
  } else throw new Error("Commands: preflight | snapshot <new-id> | verify <candidate-dir> | steam-preview <candidate-dir> <local-config.json>");
} catch (error) {
  console.error(JSON.stringify({ status: "FAIL", reason: error.message }));
  process.exitCode = 1;
}
