const crypto = require("node:crypto");
const fs = require("node:fs");
const { CHALLENGE_IDS } = require("./achievement-store.cjs");

const FORMAT = "lifeline-progress-backup";
const SCHEMA_VERSION = 1;
const MAX_BACKUP_BYTES = 16_384;
const CHALLENGE_ID_SET = new Set(CHALLENGE_IDS);
const PAYLOAD_FIELDS = Object.freeze(["completedChallenges", "tutorialComplete"]);
const ENVELOPE_FIELDS = Object.freeze(["format", "payload", "schemaVersion", "sha256"]);

function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
}

function checksum(value) {
  return crypto.createHash("sha256").update(canonicalize(value), "utf8").digest("hex");
}

function isPlainRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function hasExactFields(value, fields) {
  return isPlainRecord(value) && Object.keys(value).length === fields.length
    && fields.every((field) => Object.prototype.hasOwnProperty.call(value, field));
}

function normalizeProgress(value) {
  if (!hasExactFields(value, PAYLOAD_FIELDS) || typeof value.tutorialComplete !== "boolean"
    || !Array.isArray(value.completedChallenges) || value.completedChallenges.length > CHALLENGE_IDS.length
    || value.completedChallenges.some((id) => typeof id !== "string" || !CHALLENGE_ID_SET.has(id))
    || new Set(value.completedChallenges).size !== value.completedChallenges.length) return null;
  return { tutorialComplete: value.tutorialComplete, completedChallenges: [...value.completedChallenges] };
}

function encodeProgressBackup(progress) {
  const payload = normalizeProgress(progress);
  if (!payload) throw new TypeError("Invalid progress backup payload.");
  const document = { format: FORMAT, schemaVersion: SCHEMA_VERSION, payload, sha256: checksum(payload) };
  const serialized = `${JSON.stringify(document, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_BACKUP_BYTES) throw new RangeError("Progress backup is too large.");
  return serialized;
}

function decodeProgressBackup(serialized) {
  if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > MAX_BACKUP_BYTES) {
    return { ok: false, status: "file-too-large" };
  }
  let document;
  try { document = JSON.parse(serialized); } catch { return { ok: false, status: "invalid-backup" }; }
  if (!isPlainRecord(document) || document.format !== FORMAT) return { ok: false, status: "invalid-format" };
  if (!Number.isSafeInteger(document.schemaVersion) || document.schemaVersion !== SCHEMA_VERSION) {
    return { ok: false, status: "unsupported-version" };
  }
  if (!hasExactFields(document, ENVELOPE_FIELDS) || typeof document.sha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(document.sha256)) return { ok: false, status: "invalid-backup" };
  const progress = normalizeProgress(document.payload);
  if (!progress || checksum(progress) !== document.sha256) return { ok: false, status: "invalid-backup" };
  return { ok: true, progress };
}

function readHealthyProfile(profileStore) {
  const result = typeof profileStore.readForProgressImport === "function"
    ? profileStore.readForProgressImport()
    : profileStore.read();
  if (!result?.ok || !["saved", "empty", "backup-only"].includes(result.status) || typeof result.value !== "string") {
    return { ok: false, status: "profile-unhealthy" };
  }
  let profile;
  try { profile = JSON.parse(result.value); } catch { return { ok: false, status: "profile-unhealthy" }; }
  if (!isPlainRecord(profile) || !isPlainRecord(profile.progress)
    || typeof profile.progress.tutorialComplete !== "boolean" || !Array.isArray(profile.progress.completedChallenges)
    || profile.progress.completedChallenges.some((id) => typeof id !== "string")) return { ok: false, status: "profile-unhealthy" };
  return { ok: true, profile };
}

function unionProgress(current, imported) {
  const completedChallenges = [...new Set([...current.completedChallenges, ...imported.completedChallenges])];
  if (completedChallenges.length > 256) return null;
  return { tutorialComplete: current.tutorialComplete || imported.tutorialComplete, completedChallenges };
}

function createProgressBackupService(profileStore, dialog, getParentWindow = () => null) {
  async function exportBackup() {
    let choice;
    try {
      choice = await dialog.showSaveDialog(getParentWindow(), {
        title: "Export LIFELINE progress backup",
        defaultPath: "lifeline-progress.json",
        filters: [{ name: "LIFELINE progress backup", extensions: ["json"] }],
      });
    } catch { return { ok: false, status: "dialog-failed" }; }
    if (choice.canceled || !choice.filePath) return { ok: false, status: "cancelled" };

    const saved = readHealthyProfile(profileStore);
    if (!saved.ok) return saved;
    const progress = {
      tutorialComplete: saved.profile.progress.tutorialComplete,
      completedChallenges: [...new Set(saved.profile.progress.completedChallenges.filter((id) => CHALLENGE_ID_SET.has(id)))],
    };
    let serialized;
    try { serialized = encodeProgressBackup(progress); } catch { return { ok: false, status: "profile-unhealthy" }; }
    const temporary = `${choice.filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    let descriptor;
    try {
      descriptor = fs.openSync(temporary, "wx", 0o600);
      fs.writeFileSync(descriptor, serialized, "utf8");
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporary, choice.filePath);
      return { ok: true, status: "saved" };
    } catch (error) {
      return { ok: false, status: "write-failed", message: String(error?.message ?? error) };
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch { /* Keep failed export evidence. */ }
    }
  }

  async function importBackup() {
    let choice;
    try {
      choice = await dialog.showOpenDialog(getParentWindow(), {
        title: "Import LIFELINE progress backup",
        properties: ["openFile"],
        filters: [{ name: "LIFELINE progress backup", extensions: ["json"] }],
      });
    } catch { return { ok: false, status: "dialog-failed" }; }
    if (choice.canceled || !choice.filePaths?.[0]) return { ok: false, status: "cancelled" };

    let descriptor;
    let serialized;
    try {
      descriptor = fs.openSync(choice.filePaths[0], "r");
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile()) return { ok: false, status: "read-failed" };
      if (stat.size > MAX_BACKUP_BYTES) return { ok: false, status: "file-too-large" };
      const buffer = Buffer.alloc(MAX_BACKUP_BYTES + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const count = fs.readSync(descriptor, buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (count === 0) break;
        bytesRead += count;
      }
      if (bytesRead > MAX_BACKUP_BYTES) return { ok: false, status: "file-too-large" };
      serialized = buffer.subarray(0, bytesRead).toString("utf8");
    } catch { return { ok: false, status: "read-failed" }; }
    finally { if (descriptor !== undefined) { try { fs.closeSync(descriptor); } catch { /* Preserve the read result. */ } } }
    const decoded = decodeProgressBackup(serialized);
    if (!decoded.ok) return decoded;

    const saved = readHealthyProfile(profileStore);
    if (!saved.ok) return saved;
    const current = {
      tutorialComplete: saved.profile.progress.tutorialComplete,
      completedChallenges: [...saved.profile.progress.completedChallenges],
    };
    const progress = unionProgress(current, decoded.progress);
    if (!progress) return { ok: false, status: "progress-limit" };
    const unchanged = progress.tutorialComplete === current.tutorialComplete
      && progress.completedChallenges.length === current.completedChallenges.length
      && progress.completedChallenges.every((id, index) => id === current.completedChallenges[index]);
    if (unchanged) return { ok: true, status: "unchanged", progress };

    if (typeof profileStore.writeProgress !== "function") return { ok: false, status: "profile-unhealthy" };
    const written = profileStore.writeProgress(progress);
    if (!written?.ok) return { ok: false, status: "write-failed" };
    return { ok: true, status: "imported", progress };
  }

  return { exportBackup, importBackup };
}

module.exports = { BACKUP_FORMAT: FORMAT, BACKUP_SCHEMA_VERSION: SCHEMA_VERSION, MAX_BACKUP_BYTES,
  createProgressBackupService, decodeProgressBackup, encodeProgressBackup };
