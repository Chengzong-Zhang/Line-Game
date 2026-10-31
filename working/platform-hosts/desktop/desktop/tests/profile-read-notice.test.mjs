import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { createDefaultPlayerProfile, loadPlayerProfile, loadPlayerProfileResult, getPlayerProfileReadNotice } from "../../web/web前端/LocalProfile.js";

const require = createRequire(import.meta.url);
const { createProfileStore } = require("../src/profile-store.cjs");

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lifeline-profile-notice-"));
  const store = createProfileStore(directory);
  const oldBridge = globalThis.lifelineDesktop;
  globalThis.lifelineDesktop = { isDesktop: true, readProfileSync: () => store.read() };
  t.after(() => {
    if (oldBridge === undefined) delete globalThis.lifelineDesktop;
    else globalThis.lifelineDesktop = oldBridge;
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`) && path.basename(resolved).startsWith("lifeline-profile-notice-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const profile = createDefaultPlayerProfile();
  profile.preferences.language = "zh";
  profile.progress.completedChallenges = ["C01-hub-connection"];
  assert.equal(store.write(JSON.stringify(profile)).ok, true);
  return { store, profile };
}

test("renderer load keeps readable progress and the native newer-version status together", t => {
  const { store } = fixture(t);
  fs.writeFileSync(store.paths.preferences.file, JSON.stringify({ format: "lifeline-profile-envelope", schemaVersion: 99, payload: {} }));
  const loaded = loadPlayerProfileResult();
  assert.equal(loaded.ok, false);
  assert.equal(loaded.status, "unsupported-version");
  assert.deepEqual(loaded.profile.progress.completedChallenges, ["C01-hub-connection"]);
  assert.deepEqual(loadPlayerProfile().progress, loaded.profile.progress);
  assert.match(getPlayerProfileReadNotice(loaded.status, "zh"), /较新版本.*只读/);
  assert.match(getPlayerProfileReadNotice(loaded.status, "en"), /newer version.*read-only/i);
});

test("an immediate successful preference write does not erase the startup recovery notice", t => {
  const { store, profile } = fixture(t);
  profile.progress.completedChallenges.push("C02-sever-outpost");
  assert.equal(store.write(JSON.stringify(profile)).ok, true);
  fs.writeFileSync(store.paths.progress.file, "{damaged");
  const loaded = loadPlayerProfileResult();
  assert.equal(loaded.ok, true);
  assert.equal(loaded.status, "recovered-backup");
  assert.deepEqual(loaded.profile.progress.completedChallenges, ["C01-hub-connection"]);
  assert.equal(store.write(JSON.stringify(loaded.profile)).ok, true);
  assert.equal(store.read().status, "saved");
  assert.match(getPlayerProfileReadNotice(loaded.status, "zh"), /备份恢复/);
  assert.match(getPlayerProfileReadNotice(loaded.status, "en"), /recovered.*backup/i);
});

test("backup-only recovery is reported even when the other domain is healthy", t => {
  const { store } = fixture(t);
  fs.renameSync(store.paths.progress.file, store.paths.progress.backup);
  const loaded = loadPlayerProfileResult();
  assert.equal(loaded.status, "backup-only");
  assert.deepEqual(loaded.profile.progress.completedChallenges, ["C01-hub-connection"]);
  assert.match(getPlayerProfileReadNotice(loaded.status), /备份恢复/);
});

test("normal startup has no warning", t => {
  fixture(t);
  const loaded = loadPlayerProfileResult();
  assert.equal(loaded.ok, true);
  assert.equal(getPlayerProfileReadNotice(loaded.status), "");
});
