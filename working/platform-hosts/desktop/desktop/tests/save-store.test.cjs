const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createSaveStore, SAVE_FORMAT, SAVE_SCHEMA_VERSION } = require("../src/save-store.cjs");

function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
}
function envelope(payload, schemaVersion = SAVE_SCHEMA_VERSION) {
  return JSON.stringify({ format: SAVE_FORMAT, schemaVersion, writtenAt: new Date(0).toISOString(), sha256: crypto.createHash("sha256").update(canonicalize(payload), "utf8").digest("hex"), payload });
}
function session(actions = []) {
  return { format: "lifeline-local-session", schemaVersion: 1, savedAt: 1, settings: { playerCount: 2, gridSize: 9, startPlayer: "BLACK", rulesVersion: "territory-v2" }, actions };
}
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lifeline-save-test-"));
  t.after(() => {
    const resolved = path.resolve(directory);
    const tempRoot = `${path.resolve(os.tmpdir())}${path.sep}`;
    if (path.basename(resolved).startsWith("lifeline-save-test-") && resolved.startsWith(tempRoot)) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  });
  return { directory, store: createSaveStore(directory), file: path.join(directory, "current.json"), backup: path.join(directory, "current.json.bak") };
}

test("writes a durable current save and rotates the previous save to backup", (t) => {
  const { store, file, backup } = fixture(t);
  assert.equal(store.write(JSON.stringify(session([{ type: "player_skip" }]))).ok, true);
  assert.equal(store.write(JSON.stringify(session([{ type: "player_skip" }, { type: "player_resign", color: "WHITE" }]))).ok, true);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).payload.actions.length, 2);
  assert.equal(JSON.parse(fs.readFileSync(backup, "utf8")).payload.actions.length, 1);
  assert.equal(JSON.parse(store.read().value).actions.length, 2);
});

test("upgrades a v1 desktop save without changing its payload and retains its exact backup", (t) => {
  const { store, file, backup } = fixture(t);
  const payload = session([{ type: "player_skip" }]);
  const legacy = envelope(payload, 1);
  fs.writeFileSync(file, legacy, "utf8");
  assert.deepEqual(JSON.parse(store.read().value), payload);
  assert.equal(store.write(JSON.stringify(payload)).ok, true);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).schemaVersion, 2);
  assert.equal(fs.readFileSync(backup, "utf8"), legacy);
  assert.deepEqual(JSON.parse(createSaveStore(path.dirname(file)).read().value), payload);
});

test("preserves a damaged main file and restores the readable backup", (t) => {
  const { store, file, backup, directory } = fixture(t);
  store.write(JSON.stringify(session([{ type: "player_skip" }])));
  store.write(JSON.stringify(session([{ type: "player_skip" }, { type: "player_skip" }])));
  fs.writeFileSync(file, "{broken", "utf8");
  const result = store.read();
  assert.equal(result.status, "recovered-backup");
  assert.equal(JSON.parse(result.value).actions.length, 1);
  assert.equal(fs.existsSync(backup), true);
  assert.equal(fs.readdirSync(directory).some((name) => name.startsWith("current.json.corrupt-")), true);
});

test("refuses to overwrite a future save schema and clear also fails closed", (t) => {
  const { store, file } = fixture(t);
  fs.writeFileSync(file, envelope(session(), SAVE_SCHEMA_VERSION + 1), "utf8");
  assert.equal(store.read().status, "unsupported-version");
  assert.equal(store.write(JSON.stringify(session([{ type: "player_skip" }]))).status, "write-blocked");
  assert.equal(store.clear().status, "write-blocked");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).schemaVersion, SAVE_SCHEMA_VERSION + 1);
});

test("a future inner session schema is preserved and reported as unsupported", (t) => {
  const { store, file, directory } = fixture(t);
  const future = { ...session(), schemaVersion: 2 };
  fs.writeFileSync(file, envelope(future), "utf8");
  assert.equal(store.read().status, "unsupported-version");
  assert.equal(fs.readdirSync(directory).some((name) => name.includes("corrupt-")), false);
});

test("round-trips a large accepted session without escaping it a second time", (t) => {
  const { store, file } = fixture(t);
  const large = session(Array.from({ length: 80_000 }, () => ({ type: "player_skip" })));
  const serialized = JSON.stringify(large);
  assert.ok(Buffer.byteLength(serialized) < 2_000_000);
  assert.equal(store.write(serialized).status, "saved");
  const loaded = store.read();
  assert.equal(loaded.status, "saved");
  assert.equal(JSON.parse(loaded.value).actions.length, large.actions.length);
  assert.ok(fs.statSync(file).size <= 2_004_096);
});

test("rejects an oversized next save before replacing the durable copy", (t) => {
  const { store, file } = fixture(t);
  const saved = JSON.stringify(session([{ type: "player_skip" }]));
  assert.equal(store.write(saved).ok, true);
  const before = fs.readFileSync(file);
  const oversized = session([{ type: "player_skip", note: "x".repeat(2_100_000) }]);
  assert.equal(store.write(JSON.stringify(oversized)).status, "too-large");
  assert.deepEqual(fs.readFileSync(file), before);
});

test("a backup write failure does not escape IPC or replace the primary", (t) => {
  const { store, file } = fixture(t);
  store.write(JSON.stringify(session([{ type: "player_skip" }])));
  const before = fs.readFileSync(file);
  const originalOpen = fs.openSync;
  fs.openSync = function (target, ...args) {
    if (String(target).endsWith(".tmp")) throw new Error("injected disk failure");
    return originalOpen.call(this, target, ...args);
  };
  try {
    const result = store.write(JSON.stringify(session([{ type: "player_skip" }, { type: "player_skip" }])));
    assert.equal(result.status, "write-failed");
  } finally { fs.openSync = originalOpen; }
  assert.deepEqual(fs.readFileSync(file), before);
});
