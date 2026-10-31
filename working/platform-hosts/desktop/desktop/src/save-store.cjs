const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const SAVE_FORMAT = "lifeline-desktop-save";
// Envelope v2 prevents older desktop builds from silently reinterpreting new
// board shapes, starting points, six-seat matches and undo quotas. Session and
// public replay schemas remain unchanged; v1 envelopes are readable on upgrade.
const SAVE_SCHEMA_VERSION = 2;
const SESSION_FORMAT = "lifeline-local-session";
const SESSION_SCHEMA_VERSION = 1;
const MAX_SAVE_BYTES = 2_000_000;
const MAX_SAVE_FILE_BYTES = MAX_SAVE_BYTES + 4096;

function digest(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  return "null";
}

function parseEnvelope(text) {
  let envelope;
  try { envelope = JSON.parse(text); } catch { return { kind: "corrupt" }; }
  if (envelope?.format !== SAVE_FORMAT || !Number.isInteger(envelope.schemaVersion)) return { kind: "corrupt" };
  if (envelope.schemaVersion > SAVE_SCHEMA_VERSION) return { kind: "unsupported" };
  if (![1, SAVE_SCHEMA_VERSION].includes(envelope.schemaVersion) || !envelope.payload || typeof envelope.payload !== "object" || typeof envelope.sha256 !== "string") return { kind: "corrupt" };
  if (digest(canonicalize(envelope.payload)) !== envelope.sha256) return { kind: "corrupt" };
  const payload = envelope.payload;
  if (payload?.format === SESSION_FORMAT && Number.isInteger(payload.schemaVersion) && payload.schemaVersion > SESSION_SCHEMA_VERSION) return { kind: "unsupported" };
  if (payload?.format !== SESSION_FORMAT || payload.schemaVersion !== SESSION_SCHEMA_VERSION || !Array.isArray(payload.actions) || !payload.settings) return { kind: "corrupt" };
  return { kind: "valid", payload, envelope, serialized: text };
}

function ensureDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function atomicWrite(filePath, data) {
  const dir = path.dirname(filePath);
  ensureDirectory(dir);
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, data, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, filePath);
    try { const directoryDescriptor = fs.openSync(dir, "r"); fs.fsyncSync(directoryDescriptor); fs.closeSync(directoryDescriptor); } catch { /* Windows does not expose directory fsync. */ }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch { /* Leave no partial file behind when possible. */ }
  }
}

function createSaveStore(directory, options = {}) {
  const file = path.join(directory, "current.json");
  const backup = path.join(directory, "current.json.bak");
  let writeBlocked = false;
  let quarantined = false;
  const now = options.now ?? (() => new Date());

  function quarantine(filePath) {
    if (!fs.existsSync(filePath)) return true;
    const stamp = now().toISOString().replace(/[:.]/g, "-");
    try {
      fs.renameSync(filePath, `${filePath}.corrupt-${stamp}`);
      quarantined = true;
      return true;
    } catch { return false; }
  }

  function readOne(filePath) {
    if (!fs.existsSync(filePath)) return { kind: "missing" };
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile() || stat.size > MAX_SAVE_FILE_BYTES) return { kind: "corrupt" };
      return parseEnvelope(fs.readFileSync(filePath, "utf8"));
    } catch { return { kind: "corrupt" }; }
  }

  function read() {
    writeBlocked = false;
    const current = readOne(file);
    if (current.kind === "valid") return { ok: true, status: "saved", value: JSON.stringify(current.payload) };
    if (current.kind === "unsupported") { writeBlocked = true; return { ok: false, status: "unsupported-version" }; }
    if (current.kind === "corrupt" && !quarantine(file)) return { ok: false, status: "quarantine-failed" };
    const prior = readOne(backup);
    if (prior.kind === "valid") return { ok: true, status: current.kind === "corrupt" ? "recovered-backup" : "backup-only", value: JSON.stringify(prior.payload) };
    if (prior.kind === "unsupported") { writeBlocked = true; return { ok: false, status: "unsupported-backup-version" }; }
    if (prior.kind === "corrupt" && !quarantine(backup)) return { ok: false, status: "backup-quarantine-failed" };
    if (quarantined) return { ok: false, status: "corrupt-quarantined" };
    return { ok: true, status: "empty", value: null };
  }

  function makeEnvelope(payload) {
    return JSON.stringify({ format: SAVE_FORMAT, schemaVersion: SAVE_SCHEMA_VERSION, writtenAt: now().toISOString(), sha256: digest(canonicalize(payload)), payload });
  }

  function write(serialized) {
    if (writeBlocked) return { ok: false, status: "write-blocked" };
    if (typeof serialized !== "string") return { ok: false, status: "invalid-save" };
    if (Buffer.byteLength(serialized, "utf8") > MAX_SAVE_BYTES) return { ok: false, status: "too-large" };
    let session;
    try { session = JSON.parse(serialized); } catch { return { ok: false, status: "invalid-save" }; }
    if (session?.format !== SESSION_FORMAT || session.schemaVersion !== SESSION_SCHEMA_VERSION || !session.settings || !Array.isArray(session.actions)) return { ok: false, status: "invalid-save" };
    const nextEnvelope = makeEnvelope(session);
    if (Buffer.byteLength(nextEnvelope, "utf8") > MAX_SAVE_FILE_BYTES) return { ok: false, status: "too-large" };
    const current = readOne(file);
    if (current.kind === "unsupported") { writeBlocked = true; return { ok: false, status: "unsupported-version" }; }
    const prior = readOne(backup);
    if (prior.kind === "unsupported") { writeBlocked = true; return { ok: false, status: "unsupported-backup-version" }; }
    if (current.kind === "corrupt" && fs.existsSync(file) && !quarantine(file)) {
      return { ok: false, status: "quarantine-failed" };
    }
    if (prior.kind === "corrupt" && fs.existsSync(backup) && !quarantine(backup)) return { ok: false, status: "backup-quarantine-failed" };
    try {
      if (current.kind === "valid") atomicWrite(backup, current.serialized);
      atomicWrite(file, nextEnvelope);
    }
    catch (error) { return { ok: false, status: "write-failed", message: String(error?.message ?? error) }; }
    return { ok: true, status: "saved" };
  }

  function clear() {
    if (writeBlocked) return { ok: false, status: "write-blocked" };
    if (readOne(file).kind === "unsupported") { writeBlocked = true; return { ok: false, status: "unsupported-version" }; }
    if (readOne(backup).kind === "unsupported") { writeBlocked = true; return { ok: false, status: "unsupported-backup-version" }; }
    try {
      for (const target of [file, backup]) if (fs.existsSync(target)) fs.unlinkSync(target);
      quarantined = false;
      return { ok: true, status: "cleared" };
    } catch (error) { return { ok: false, status: "clear-failed", message: String(error?.message ?? error) }; }
  }

  function writeExport(targetPath, serialized) {
    const resolved = path.resolve(targetPath);
    atomicWrite(resolved, serialized);
  }

  return { read, write, clear, writeExport, paths: { file, backup } };
}

module.exports = { createSaveStore, parseEnvelope, SAVE_FORMAT, SAVE_SCHEMA_VERSION };
