const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { CHALLENGE_IDS } = require("../src/achievement-store.cjs");
const { createProfileStore } = require("../src/profile-store.cjs");
const { createProgressBackupService, decodeProgressBackup, encodeProgressBackup } = require("../src/progress-backup.cjs");

const makeProfile = (progress = { tutorialComplete: false, completedChallenges: [] }) => ({
  format: "lifeline-player-profile",
  schemaVersion: 1,
  preferences: { language: "zh", audioEnabled: true, audioVolume: 70, reducedMotion: false, fullscreen: false, uiScale: 1 },
  progress,
});

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lifeline-progress-backup-test-"));
  t.after(() => {
    const resolved = path.resolve(directory);
    const tempRoot = `${path.resolve(os.tmpdir())}${path.sep}`;
    if (path.basename(resolved).startsWith("lifeline-progress-backup-test-") && resolved.startsWith(tempRoot)) fs.rmSync(resolved, { recursive: true, force: true });
  });
  let saveChoice = { canceled: true };
  let openChoice = { canceled: true, filePaths: [] };
  const calls = [];
  const dialog = {
    showSaveDialog: async (...args) => { calls.push(["save", ...args]); return saveChoice; },
    showOpenDialog: async (...args) => { calls.push(["open", ...args]); return openChoice; },
  };
  const profileStore = createProfileStore(path.join(directory, "profile"));
  const service = createProgressBackupService(profileStore, dialog);
  return {
    directory, profileStore, service, calls,
    setSaveChoice: value => { saveChoice = value; },
    setOpenChoice: value => { openChoice = value; },
    progressFile: profileStore.paths.progress.file,
    settingsFile: profileStore.paths.preferences.file,
    backupPath: path.join(directory, "transfer.json"),
  };
}

function writeBackup(file, progress) {
  fs.writeFileSync(file, encodeProgressBackup(progress), "utf8");
}

test("export contains only versioned tutorial and known distinct challenge progress", async (t) => {
  const f = fixture(t);
  const profile = makeProfile({ tutorialComplete: true, completedChallenges: [CHALLENGE_IDS[0], "not-a-challenge", CHALLENGE_IDS[0]] });
  assert.equal(f.profileStore.write(JSON.stringify(profile)).status, "saved");
  f.setSaveChoice({ canceled: false, filePath: f.backupPath });

  const result = await f.service.exportBackup();

  assert.deepEqual(result, { ok: true, status: "saved" });
  const document = JSON.parse(fs.readFileSync(f.backupPath, "utf8"));
  assert.deepEqual(Object.keys(document).sort(), ["format", "payload", "schemaVersion", "sha256"]);
  assert.equal(document.format, "lifeline-progress-backup");
  assert.equal(document.schemaVersion, 1);
  assert.deepEqual(document.payload, { tutorialComplete: true, completedChallenges: [CHALLENGE_IDS[0]] });
  assert.deepEqual(decodeProgressBackup(fs.readFileSync(f.backupPath, "utf8")), { ok: true, progress: document.payload });
  assert.equal(JSON.stringify(document).includes("preferences"), false);
  assert.equal(JSON.stringify(document).includes("saves"), false);
  assert.deepEqual(f.calls[0][2].filters[0].extensions, ["json"]);
});

test("import unions progress without changing preferences, current game, or reward queue", async (t) => {
  const f = fixture(t);
  const current = makeProfile({ tutorialComplete: false, completedChallenges: [CHALLENGE_IDS[0]] });
  current.preferences.language = "en";
  current.preferences.audioEnabled = false;
  current.preferences.audioVolume = 35;
  assert.equal(f.profileStore.write(JSON.stringify(current)).status, "saved");
  const currentMatch = path.join(f.directory, "saves", "current.json");
  const queue = path.join(f.directory, "achievements", "pending.json");
  fs.mkdirSync(path.dirname(currentMatch), { recursive: true });
  fs.mkdirSync(path.dirname(queue), { recursive: true });
  fs.writeFileSync(currentMatch, "current-match-bytes");
  fs.writeFileSync(queue, "local-unbound-queue-bytes");
  const currentMatchBefore = fs.readFileSync(currentMatch);
  const queueBefore = fs.readFileSync(queue);
  writeBackup(f.backupPath, { tutorialComplete: true, completedChallenges: [CHALLENGE_IDS[0], CHALLENGE_IDS[1]] });
  f.setOpenChoice({ canceled: false, filePaths: [f.backupPath] });

  const result = await f.service.importBackup();

  assert.equal(result.ok, true);
  assert.equal(result.status, "imported");
  assert.deepEqual(result.progress, { tutorialComplete: true, completedChallenges: [CHALLENGE_IDS[0], CHALLENGE_IDS[1]] });
  const saved = JSON.parse(f.profileStore.read().value);
  assert.deepEqual(saved.progress, result.progress);
  assert.deepEqual(saved.preferences, current.preferences);
  assert.deepEqual(fs.readFileSync(currentMatch), currentMatchBefore);
  assert.deepEqual(fs.readFileSync(queue), queueBefore);
  assert.deepEqual(f.profileStore.readForProgressImport().ok, true);
});

test("export and import cancellation do not read, quarantine, or alter local profile bytes", async (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.dirname(f.progressFile), { recursive: true });
  const damaged = Buffer.from("{original damaged bytes");
  fs.writeFileSync(f.progressFile, damaged);

  assert.deepEqual(await f.service.exportBackup(), { ok: false, status: "cancelled" });
  assert.deepEqual(await f.service.importBackup(), { ok: false, status: "cancelled" });
  assert.deepEqual(fs.readFileSync(f.progressFile), damaged);
  assert.equal(fs.readdirSync(path.dirname(f.progressFile)).some(name => name.includes(".corrupt-")), false);
});

test("rejects malformed, future, oversized, and unrecognized backup documents without touching local state", async (t) => {
  const f = fixture(t);
  const profile = makeProfile({ tutorialComplete: false, completedChallenges: [CHALLENGE_IDS[0]] });
  assert.equal(f.profileStore.write(JSON.stringify(profile)).status, "saved");
  const progressBefore = fs.readFileSync(f.progressFile);
  const settingsBefore = fs.readFileSync(f.settingsFile);
  const valid = JSON.parse(encodeProgressBackup({ tutorialComplete: true, completedChallenges: [CHALLENGE_IDS[1]] }));
  const cases = [
    ["unknown format", "invalid-format", { ...valid, format: "other-format" }],
    ["future version", "unsupported-version", { ...valid, schemaVersion: 99 }],
    ["extra envelope field", "invalid-backup", { ...valid, preferences: profile.preferences }],
    ["bad checksum", "invalid-backup", { ...valid, payload: { ...valid.payload, tutorialComplete: false } }],
    ["unknown challenge", "invalid-backup", { ...valid, payload: { tutorialComplete: true, completedChallenges: ["C99-unknown"] } }],
    ["duplicate challenge", "invalid-backup", { ...valid, payload: { tutorialComplete: true, completedChallenges: [CHALLENGE_IDS[1], CHALLENGE_IDS[1]] } }],
    ["wrong payload type", "invalid-backup", { ...valid, payload: { tutorialComplete: 1, completedChallenges: [] } }],
  ];
  for (const [name, expectedStatus, value] of cases) {
    const input = path.join(f.directory, `${name.replaceAll(" ", "-")}.json`);
    fs.writeFileSync(input, JSON.stringify(value));
    f.setOpenChoice({ canceled: false, filePaths: [input] });
    const result = await f.service.importBackup();
    assert.equal(result.status, expectedStatus, name);
    assert.deepEqual(fs.readFileSync(f.progressFile), progressBefore, name);
    assert.deepEqual(fs.readFileSync(f.settingsFile), settingsBefore, name);
  }
  const oversized = path.join(f.directory, "oversized.json");
  fs.writeFileSync(oversized, Buffer.alloc(16_385, 0x20));
  f.setOpenChoice({ canceled: false, filePaths: [oversized] });
  assert.equal((await f.service.importBackup()).status, "file-too-large");
  assert.deepEqual(fs.readFileSync(f.progressFile), progressBefore);
  assert.deepEqual(fs.readFileSync(f.settingsFile), settingsBefore);
});

test("rejects a corrupt local profile and remains fail-closed after restarting its store", async (t) => {
  const f = fixture(t);
  const initial = makeProfile({ tutorialComplete: false, completedChallenges: [CHALLENGE_IDS[0]] });
  assert.equal(f.profileStore.write(JSON.stringify(initial)).status, "saved");
  const updated = makeProfile({ tutorialComplete: false, completedChallenges: [CHALLENGE_IDS[0], CHALLENGE_IDS[1]] });
  assert.equal(f.profileStore.write(JSON.stringify(updated)).status, "saved");
  const damaged = Buffer.from("{original current profile bytes");
  fs.writeFileSync(f.progressFile, damaged);
  const importFile = path.join(f.directory, "import.json");
  writeBackup(importFile, { tutorialComplete: true, completedChallenges: [CHALLENGE_IDS[2]] });
  f.setOpenChoice({ canceled: false, filePaths: [importFile] });

  const first = await f.service.importBackup();
  assert.deepEqual(first, { ok: false, status: "profile-unhealthy" });
  const archive = fs.readdirSync(path.dirname(f.progressFile)).find(name => name.startsWith("profile.json.corrupt-"));
  assert.ok(archive);
  assert.deepEqual(fs.readFileSync(path.join(path.dirname(f.progressFile), archive)), damaged);
  assert.equal(fs.existsSync(f.progressFile), false);

  const restartedStore = createProfileStore(path.join(f.directory, "profile"));
  const restartedService = createProgressBackupService(restartedStore, {
    showOpenDialog: async () => ({ canceled: false, filePaths: [importFile] }),
    showSaveDialog: async () => ({ canceled: true }),
  });
  assert.deepEqual(await restartedService.importBackup(), { ok: false, status: "profile-unhealthy" });
  assert.deepEqual(fs.readFileSync(path.join(path.dirname(f.progressFile), archive)), damaged);
  assert.equal(fs.existsSync(f.progressFile), false);
});

test("a future local profile schema blocks import and preserves its exact bytes", async (t) => {
  const f = fixture(t);
  const initial = makeProfile({ tutorialComplete: false, completedChallenges: [CHALLENGE_IDS[0]] });
  assert.equal(f.profileStore.write(JSON.stringify(initial)).status, "saved");
  const futureBytes = Buffer.from(JSON.stringify({
    format: "lifeline-profile-envelope",
    schemaVersion: 99,
    writtenAt: "future",
    sha256: "future-format-hash",
    payload: { format: "lifeline-progress", schemaVersion: 99, tutorialComplete: true, completedChallenges: [] },
  }));
  fs.writeFileSync(f.progressFile, futureBytes);
  const importFile = path.join(f.directory, "future-import.json");
  writeBackup(importFile, { tutorialComplete: true, completedChallenges: [CHALLENGE_IDS[1]] });
  f.setOpenChoice({ canceled: false, filePaths: [importFile] });

  const result = await f.service.importBackup();

  assert.deepEqual(result, { ok: false, status: "profile-unhealthy" });
  assert.deepEqual(fs.readFileSync(f.progressFile), futureBytes);
});

test("a backup file corrupted after creation fails its checksum without changing local files", async (t) => {
  const f = fixture(t);
  const current = makeProfile({ tutorialComplete: false, completedChallenges: [CHALLENGE_IDS[0]] });
  assert.equal(f.profileStore.write(JSON.stringify(current)).status, "saved");
  const progressBefore = fs.readFileSync(f.progressFile);
  const settingsBefore = fs.readFileSync(f.settingsFile);
  const corrupted = encodeProgressBackup({ tutorialComplete: true, completedChallenges: [CHALLENGE_IDS[1]] })
    .replace('"tutorialComplete": true', '"tutorialComplete": false');
  assert.notEqual(corrupted, encodeProgressBackup({ tutorialComplete: true, completedChallenges: [CHALLENGE_IDS[1]] }));
  const corruptFile = path.join(f.directory, "corrupted-on-disk.json");
  fs.writeFileSync(corruptFile, corrupted);
  f.setOpenChoice({ canceled: false, filePaths: [corruptFile] });

  const result = await f.service.importBackup();

  assert.deepEqual(result, { ok: false, status: "invalid-backup" });
  assert.deepEqual(fs.readFileSync(f.progressFile), progressBefore);
  assert.deepEqual(fs.readFileSync(f.settingsFile), settingsBefore);
});

test("an already imported backup is an unchanged union and writes no new profile version", async (t) => {
  const f = fixture(t);
  const current = makeProfile({ tutorialComplete: true, completedChallenges: [CHALLENGE_IDS[0], CHALLENGE_IDS[1]] });
  assert.equal(f.profileStore.write(JSON.stringify(current)).status, "saved");
  const currentBytes = fs.readFileSync(f.progressFile);
  writeBackup(f.backupPath, { tutorialComplete: false, completedChallenges: [CHALLENGE_IDS[0]] });
  f.setOpenChoice({ canceled: false, filePaths: [f.backupPath] });

  const result = await f.service.importBackup();

  assert.equal(result.status, "unchanged");
  assert.deepEqual(fs.readFileSync(f.progressFile), currentBytes);
});

test("import writes only progress when local preferences have never been saved", async (t) => {
  const f = fixture(t);
  const current = makeProfile({ tutorialComplete: false, completedChallenges: [CHALLENGE_IDS[0]] });
  assert.equal(f.profileStore.write(JSON.stringify(current)).status, "saved");
  fs.unlinkSync(f.settingsFile);
  writeBackup(f.backupPath, { tutorialComplete: true, completedChallenges: [CHALLENGE_IDS[1]] });
  f.setOpenChoice({ canceled: false, filePaths: [f.backupPath] });

  const result = await f.service.importBackup();

  assert.equal(result.status, "imported");
  assert.deepEqual(JSON.parse(f.profileStore.read().value).progress, result.progress);
  assert.equal(fs.existsSync(f.settingsFile), false);
});

test("a failed export replacement preserves the previously selected file", async (t) => {
  const f = fixture(t);
  assert.equal(f.profileStore.write(JSON.stringify(makeProfile())).status, "saved");
  const oldBytes = Buffer.from("keep this existing export");
  fs.writeFileSync(f.backupPath, oldBytes);
  f.setSaveChoice({ canceled: false, filePath: f.backupPath });
  const rename = fs.renameSync;
  fs.renameSync = (source, destination) => {
    if (destination === f.backupPath) throw new Error("injected destination replacement failure");
    return rename(source, destination);
  };
  try {
    const result = await f.service.exportBackup();
    assert.equal(result.status, "write-failed");
  } finally {
    fs.renameSync = rename;
  }
  assert.deepEqual(fs.readFileSync(f.backupPath), oldBytes);
  assert.equal(fs.readdirSync(f.directory).some(name => name.endsWith(".tmp")), false);
});
