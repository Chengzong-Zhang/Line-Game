import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { filesIn, fileHash, verifyInventory, assertDistributionPaths, makeSteamScripts, safeRelative, assertExactPaths } from "../scripts/release-lib.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lifeline-release-contract-"));
  // This test owns this exact temporary directory; never clean caller paths.
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, "win-unpacked");
  fs.mkdirSync(path.join(app, "resources"), { recursive: true });
  fs.writeFileSync(path.join(app, "resources/app.asar"), "synthetic archive - not runtime evidence");
  fs.writeFileSync(path.join(root, "test-portable.exe"), "synthetic exe");
  const receipt = { format: "lifeline-release-candidate", schemaVersion: 1, status: "SNAPSHOT_COMPLETE", package: {
    version: "0.2.0", appAsarSha256: fileHash(path.join(app, "resources/app.asar")), inventory: filesIn(app)
  }, portable: { path: "test-portable.exe", bytes: 13, sha256: fileHash(path.join(root, "test-portable.exe")) } };
  fs.writeFileSync(path.join(root, "candidate.json"), JSON.stringify(receipt));
  return { root, app, receipt };
}
test("candidate verification rejects a modified, missing, or extra file", t => {
  const { app, receipt } = fixture(t);
  verifyInventory(app, receipt.package.inventory);
  fs.writeFileSync(path.join(app, "resources/app.asar"), "tampered");
  assert.throws(() => verifyInventory(app, receipt.package.inventory), /changed/);
  fs.writeFileSync(path.join(app, "unexpected.txt"), "extra");
  assert.throws(() => verifyInventory(app, receipt.package.inventory), /count/);
});
test("path traversal, duplicate case paths, secrets and local saves are rejected", t => {
  const { app, receipt } = fixture(t);
  for (const name of ["../secret", "C:/secret", "a\\b", "/root", "a/../b"]) assert.throws(() => safeRelative(name));
  assert.throws(() => verifyInventory(app, [...receipt.package.inventory, { ...receipt.package.inventory[0], path: "RESOURCES/app.asar" }]), /Duplicate/);
  for (const name of [".env", "certs/signing.pfx", "steam_appid.txt", "userData/progress.json", "saves/current.json", "test.log"]) {
    assert.throws(() => assertDistributionPaths([{ path: name }]), /Private/);
  }
});
test("Steam preview fails for absent IDs, Spacewar, duplicate IDs and changed candidate", t => {
  const { root, app } = fixture(t);
  const base = { format: "lifeline-steam-config", schemaVersion: 1, appId: 123456789, windowsDepotId: 123456790 };
  for (const override of [{ appId: null }, { appId: 480 }, { windowsDepotId: 123456789 }, { appId: "1\"\nSetLive default" }]) {
    assert.throws(() => makeSteamScripts({ ...base, ...override }, root));
  }
  const scripts = makeSteamScripts(base, root);
  assert.match(scripts.app, /"Preview" "1"/);
  assert.doesNotMatch(scripts.app, /SetLive|password|login/i);
  assert.match(scripts.depot, /"FileExclusion" "steam_appid.txt"/);
  fs.writeFileSync(path.join(app, "resources/app.asar"), "changed");
  assert.throws(() => makeSteamScripts(base, root), /changed/);
});
test("a missing guide or model cannot silently become the accepted resource inventory", () => {
  const expected = ["guide/rules.md", "guide/board.png", "assets/ai.f32"];
  assertExactPaths([...expected].reverse(), expected, "Fixture");
  assert.throws(() => assertExactPaths(expected.slice(0, 2), expected, "Fixture"), /missing=assets\/ai.f32/);
  assert.throws(() => assertExactPaths([...expected, "assets/secret.txt"], expected, "Fixture"), /extra=assets\/secret.txt/);
});
