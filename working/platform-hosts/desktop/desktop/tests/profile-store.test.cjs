const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createProfileStore, PROFILE_SCHEMA_VERSION } = require("../src/profile-store.cjs");

const profile = (completedChallenges = []) => ({
  format: "lifeline-player-profile",
  schemaVersion: PROFILE_SCHEMA_VERSION,
  preferences: { language: "zh", audioEnabled: true, reducedMotion: false },
  progress: { tutorialComplete: false, completedChallenges },
});

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lifeline-profile-test-"));
  t.after(() => {
    const resolved = path.resolve(directory);
    const tempRoot = `${path.resolve(os.tmpdir())}${path.sep}`;
    if (path.basename(resolved).startsWith("lifeline-profile-test-") && resolved.startsWith(tempRoot)) fs.rmSync(resolved, { recursive: true, force: true });
  });
  const store = createProfileStore(directory);
  return { directory, store, file: store.paths.progress.file, backup: store.paths.progress.backup, settingsFile: store.paths.preferences.file };
}

test("writes progress and preferences into separate durable files", (t) => {
  const { store, file, backup, settingsFile, directory } = fixture(t);
  assert.equal(store.write(JSON.stringify(profile())).status, "saved");
  const next = profile(["C01-hub-connection"]);
  next.preferences.language = "en";
  assert.equal(store.write(JSON.stringify(next)).status, "saved");
  assert.equal(JSON.parse(store.read().value).preferences.language, "en");
  assert.deepEqual(JSON.parse(store.read().value).progress.completedChallenges, ["C01-hub-connection"]);
  assert.equal(JSON.parse(fs.readFileSync(backup, "utf8")).payload.completedChallenges.length, 0);
  assert.equal(JSON.parse(fs.readFileSync(settingsFile, "utf8")).payload.language, "en");
  assert.equal(path.relative(directory, file).replaceAll("\\", "/"), "progress/profile.json");
  assert.equal(path.relative(directory, settingsFile).replaceAll("\\", "/"), "settings/preferences.json");
  assert.equal(fs.existsSync(path.join(directory, "saves", "current.json")), false);
});

test("preserves future profile schemas and refuses subsequent writes", (t) => {
  const { store, file } = fixture(t);
  const future = JSON.stringify({ format: "lifeline-profile-envelope", schemaVersion: PROFILE_SCHEMA_VERSION + 1, payload: { format: "lifeline-progress", schemaVersion: PROFILE_SCHEMA_VERSION + 1, tutorialComplete: false, completedChallenges: [] } });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, future, "utf8");
  assert.equal(store.read().status, "unsupported-version");
  assert.equal(store.write(JSON.stringify(profile(["C02-sever-outpost"]))).status, "unsupported-version");
  assert.equal(fs.readFileSync(file, "utf8"), future);
});

test("quarantines corrupt profiles and recovers the last valid backup", (t) => {
  const { store, file, backup, directory } = fixture(t);
  store.write(JSON.stringify(profile()));
  store.write(JSON.stringify(profile(["C01-hub-connection"])));
  fs.writeFileSync(file, "{broken", "utf8");
  const recovered = store.read();
  assert.equal(recovered.status, "recovered-backup");
  assert.deepEqual(JSON.parse(recovered.value).progress.completedChallenges, []);
  assert.equal(fs.existsSync(backup), true);
  assert.ok(fs.readdirSync(directory, { recursive: true }).some((name) => String(name).includes("profile.json.corrupt-")));
});

test("rejects malformed profile content without touching the current file", (t) => {
  const { store, file } = fixture(t);
  assert.equal(store.write(JSON.stringify(profile())).status, "saved");
  const before = fs.readFileSync(file);
  assert.equal(store.write(JSON.stringify({ ...profile(), progress: { tutorialComplete: false, completedChallenges: [5] } })).status, "invalid-profile");
  assert.deepEqual(fs.readFileSync(file), before);
});

test("a future settings schema preserves readable challenge progress and blocks writes", (t) => {
  const { store, file, settingsFile } = fixture(t);
  const saved = profile(["C01-hub-connection", "C02-sever-outpost"]);
  assert.equal(store.write(JSON.stringify(saved)).status, "saved");
  const progressBefore = fs.readFileSync(file);
  fs.writeFileSync(settingsFile, JSON.stringify({ format: "lifeline-profile-envelope", schemaVersion: PROFILE_SCHEMA_VERSION + 1,
    payload: { format: "lifeline-preferences", schemaVersion: PROFILE_SCHEMA_VERSION + 1 } }));
  const read = store.read();
  assert.equal(read.ok, false);
  assert.deepEqual(JSON.parse(read.value).progress.completedChallenges, saved.progress.completedChallenges);
  assert.equal(store.write(JSON.stringify(profile())).status, "unsupported-version");
  assert.deepEqual(fs.readFileSync(file), progressBefore);
});

test("a corrupt settings file without backup cannot erase valid progress", (t) => {
  const { store, file, settingsFile } = fixture(t);
  const saved = profile(["C01-hub-connection", "C02-sever-outpost"]);
  assert.equal(store.write(JSON.stringify(saved)).status, "saved");
  const progressBefore = fs.readFileSync(file);
  fs.writeFileSync(settingsFile, "{broken", "utf8");
  const read = store.read();
  assert.equal(read.ok, false);
  assert.deepEqual(JSON.parse(read.value).progress.completedChallenges, saved.progress.completedChallenges);
  assert.equal(store.write(JSON.stringify(profile())).status, "corrupt-quarantined");
  assert.deepEqual(fs.readFileSync(file), progressBefore);
});

test("progress import stays fail-closed after a corrupt profile was quarantined by an earlier process", (t) => {
  const { store, file, directory } = fixture(t);
  const damaged = Buffer.from("{damaged profile bytes");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, damaged);

  assert.equal(store.readForProgressImport().status, "corrupt-quarantined");
  const archive = fs.readdirSync(path.dirname(file)).find((name) => name.startsWith("profile.json.corrupt-"));
  assert.ok(archive);
  const archivePath = path.join(path.dirname(file), archive);
  assert.deepEqual(fs.readFileSync(archivePath), damaged);

  const restartedStore = createProfileStore(directory);
  const afterRestart = restartedStore.readForProgressImport();
  assert.equal(afterRestart.ok, false);
  assert.equal(afterRestart.status, "corrupt-quarantined");
  assert.deepEqual(fs.readFileSync(archivePath), damaged);
});

test("settings write failure leaves challenge progress byte-for-byte unchanged", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lifeline-profile-write-fail-"));
  t.after(() => {
    const resolved = path.resolve(directory);
    const tempRoot = `${path.resolve(os.tmpdir())}${path.sep}`;
    if (path.basename(resolved).startsWith("lifeline-profile-write-fail-") && resolved.startsWith(tempRoot)) fs.rmSync(resolved, { recursive: true, force: true });
  });
  const paths = { progress: path.join(directory, "progress", "profile.json"), settings: path.join(directory, "settings", "preferences.json") };
  const failSettings = (target, contents) => {
    if (target === paths.settings) throw new Error("injected settings disk failure");
    const dir = path.dirname(target); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(target, contents, "utf8");
  };
  const normalStore = createProfileStore(directory);
  const existing = profile(["C01-hub-connection", "C02-sever-outpost"]);
  assert.equal(normalStore.write(JSON.stringify(existing)).status, "saved");
  const progressBefore = fs.readFileSync(paths.progress);
  const store = createProfileStore(directory, { atomicWrite: failSettings });
  existing.preferences.language = "en";
  existing.progress.completedChallenges.push("C03-close-corner");
  assert.equal(store.write(JSON.stringify(existing)).status, "write-failed");
  assert.deepEqual(fs.readFileSync(paths.progress), progressBefore);
});

test("changing only a local preference does not rotate the challenge progress backup", (t) => {
  const { store, backup, file } = fixture(t);
  const saved = profile(["C01-hub-connection"]);
  assert.equal(store.write(JSON.stringify(saved)).status, "saved");
  const progressBytes = fs.readFileSync(file);
  assert.equal(store.write(JSON.stringify(saved)).status, "saved");
  assert.equal(fs.existsSync(backup), false);
  saved.preferences.audioEnabled = false;
  assert.equal(store.write(JSON.stringify(saved)).status, "saved");
  assert.deepEqual(fs.readFileSync(file), progressBytes);
  assert.equal(fs.existsSync(backup), false);
});
