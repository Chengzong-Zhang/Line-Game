const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const SCHEMA_VERSION = 1;
const MAX_BYTES = 256_000;
const PROFILE_FORMAT = "lifeline-player-profile";

function canonicalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  return "null";
}
function digest(value) { return crypto.createHash("sha256").update(value, "utf8").digest("hex"); }

function normalizeProfile(value) {
  const p = value?.preferences;
  const g = value?.progress;
  if (value?.format !== PROFILE_FORMAT || value.schemaVersion !== SCHEMA_VERSION || !p || !g
    || ![null, "zh", "en"].includes(p.language) || typeof p.audioEnabled !== "boolean" || typeof p.reducedMotion !== "boolean"
    || (p.audioVolume !== undefined && (!Number.isInteger(p.audioVolume) || p.audioVolume < 0 || p.audioVolume > 100))
    || (p.fullscreen !== undefined && typeof p.fullscreen !== "boolean")
    || (p.uiScale !== undefined && ![0.9, 1, 1.1].includes(p.uiScale))
    || typeof g.tutorialComplete !== "boolean" || !Array.isArray(g.completedChallenges) || g.completedChallenges.length > 256
    || g.completedChallenges.some((id) => typeof id !== "string" || id.length > 80)) return null;
  return { format: PROFILE_FORMAT, schemaVersion: SCHEMA_VERSION,
    preferences: { language: p.language, audioEnabled: p.audioEnabled, audioVolume: p.audioVolume ?? 70,
      reducedMotion: p.reducedMotion, fullscreen: p.fullscreen ?? false, uiScale: p.uiScale ?? 1 },
    progress: { tutorialComplete: g.tutorialComplete, completedChallenges: [...new Set(g.completedChallenges)].slice(0, 256) } };
}

function atomicWrite(file, data) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, data, "utf8"); fs.fsyncSync(descriptor); fs.closeSync(descriptor); descriptor = undefined;
    fs.renameSync(temporary, file);
    try { const dir = fs.openSync(directory, "r"); fs.fsyncSync(dir); fs.closeSync(dir); } catch { /* Windows does not support directory fsync. */ }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch { /* Preserve leftover evidence. */ }
  }
}

function envelopeFor(payload, now) {
  return JSON.stringify({ format: "lifeline-profile-envelope", schemaVersion: SCHEMA_VERSION,
    writtenAt: now().toISOString(), sha256: digest(canonicalize(payload)), payload });
}

function createJsonStore(file, format, fields, defaults, now, writeFile = atomicWrite) {
  const backup = `${file}.bak`;
  let writeBlocked = false;
  let quarantined = false;
  const normalize = (value) => {
    if (value?.format !== format || value.schemaVersion !== SCHEMA_VERSION) return null;
    const result = { format, schemaVersion: SCHEMA_VERSION };
    for (const field of fields) {
      if (!Object.prototype.hasOwnProperty.call(value, field)) { result[field] = defaults[field]; continue; }
      if (field === "completedChallenges") {
        if (!Array.isArray(value[field]) || value[field].length > 256 || value[field].some((id) => typeof id !== "string" || id.length > 80)) return null;
        result[field] = [...new Set(value[field])].slice(0, 256);
      } else if ((field === "language" ? ![null, "zh", "en"].includes(value[field]) : typeof value[field] !== typeof defaults[field])) return null;
      else result[field] = value[field];
      if (field === "audioVolume" && (!Number.isInteger(value[field]) || value[field] < 0 || value[field] > 100)) return null;
      if (field === "uiScale" && ![0.9, 1, 1.1].includes(value[field])) return null;
    }
    return result;
  };
  const readOne = (target) => {
    if (!fs.existsSync(target)) return { kind: "missing" };
    try {
      const stat = fs.statSync(target);
      if (!stat.isFile() || stat.size > MAX_BYTES) return { kind: "corrupt" };
      const envelope = JSON.parse(fs.readFileSync(target, "utf8"));
      if (envelope?.format !== "lifeline-profile-envelope" || !Number.isInteger(envelope.schemaVersion)) return { kind: "corrupt" };
      if (envelope.schemaVersion > SCHEMA_VERSION || envelope.payload?.schemaVersion > SCHEMA_VERSION) return { kind: "unsupported" };
      if (envelope.schemaVersion !== SCHEMA_VERSION || typeof envelope.sha256 !== "string"
        || digest(canonicalize(envelope.payload)) !== envelope.sha256) return { kind: "corrupt" };
      const payload = normalize(envelope.payload);
      return payload ? { kind: "valid", payload } : { kind: "corrupt" };
    } catch { return { kind: "corrupt" }; }
  };
  const quarantine = (target) => {
    if (!fs.existsSync(target)) return true;
    const stamp = now().toISOString().replace(/[:.]/g, "-");
    try { fs.renameSync(target, `${target}.corrupt-${stamp}`); quarantined = true; return true; } catch { return false; }
  };
  const hasQuarantineArchive = () => {
    try {
      const base = path.basename(file);
      return fs.readdirSync(path.dirname(file)).some((name) => name.startsWith(`${base}.corrupt-`) || name.startsWith(`${base}.bak.corrupt-`));
    } catch { return false; }
  };
  const read = () => {
    writeBlocked = false;
    const current = readOne(file);
    if (current.kind === "unsupported") { writeBlocked = true; return { ok: false, status: "unsupported-version" }; }
    if (current.kind === "valid") return { ok: true, status: "saved", value: current.payload };
    if (current.kind === "corrupt" && !quarantine(file)) return { ok: false, status: "quarantine-failed" };
    const previous = readOne(backup);
    if (previous.kind === "unsupported") { writeBlocked = true; return { ok: false, status: "unsupported-backup-version" }; }
    if (previous.kind === "valid") return { ok: true, status: current.kind === "corrupt" ? "recovered-backup" : "backup-only", value: previous.payload };
    if (previous.kind === "corrupt" && !quarantine(backup)) return { ok: false, status: "backup-quarantine-failed" };
    return quarantined ? { ok: false, status: "corrupt-quarantined" } : { ok: true, status: "empty", value: null };
  };
  const write = (payload) => {
    if (writeBlocked) return { ok: false, status: "write-blocked" };
    const normalized = normalize(payload);
    if (!normalized || Buffer.byteLength(JSON.stringify(normalized), "utf8") > MAX_BYTES) return { ok: false, status: "invalid-profile" };
    const current = readOne(file), previous = readOne(backup);
    if (current.kind === "unsupported" || previous.kind === "unsupported") { writeBlocked = true; return { ok: false, status: "unsupported-version" }; }
    if (current.kind === "valid" && canonicalize(current.payload) === canonicalize(normalized)) return { ok: true, status: "saved" };
    if (current.kind === "corrupt" && !quarantine(file)) return { ok: false, status: "quarantine-failed" };
    if (previous.kind === "corrupt" && !quarantine(backup)) return { ok: false, status: "backup-quarantine-failed" };
    try {
      if (current.kind === "valid") writeFile(backup, envelopeFor(current.payload, now));
      writeFile(file, envelopeFor(normalized, now));
    } catch (error) { return { ok: false, status: "write-failed", message: String(error?.message ?? error) }; }
    writeBlocked = false;
    return { ok: true, status: "saved" };
  };
  return { read, write, hasQuarantineArchive, paths: { file, backup } };
}

function createProfileStore(userDataDirectory, options = {}) {
  const now = options.now ?? (() => new Date());
  const writeFile = options.atomicWrite ?? atomicWrite;
  const progressStore = createJsonStore(path.join(userDataDirectory, "progress", "profile.json"), "lifeline-progress",
    ["tutorialComplete", "completedChallenges"], { tutorialComplete: false, completedChallenges: [] }, now, writeFile);
  const settingsStore = createJsonStore(path.join(userDataDirectory, "settings", "preferences.json"), "lifeline-preferences",
    ["language", "audioEnabled", "audioVolume", "reducedMotion", "fullscreen", "uiScale"],
    { language: null, audioEnabled: true, audioVolume: 70, reducedMotion: false, fullscreen: false, uiScale: 1 }, now, writeFile);
  function read() {
    const progress = progressStore.read(), preferences = settingsStore.read();
    const p = preferences.value ?? { format: "lifeline-preferences", schemaVersion: SCHEMA_VERSION, language: null, audioEnabled: true, audioVolume: 70, reducedMotion: false, fullscreen: false, uiScale: 1 };
    const g = progress.value ?? { format: "lifeline-progress", schemaVersion: SCHEMA_VERSION, tutorialComplete: false, completedChallenges: [] };
    const failed = [progress, preferences].find((result) => !result.ok);
    return { ok: !failed, ...(failed ? { status: failed.status } : { status: [progress.status, preferences.status].find((s) => s === "recovered-backup" || s === "backup-only") ?? (progress.status === "saved" || preferences.status === "saved" ? "saved" : "empty") }),
      value: JSON.stringify(normalizeProfile({ format: PROFILE_FORMAT, schemaVersion: SCHEMA_VERSION,
        preferences: { language: p.language, audioEnabled: p.audioEnabled, audioVolume: p.audioVolume, reducedMotion: p.reducedMotion, fullscreen: p.fullscreen, uiScale: p.uiScale },
        progress: { tutorialComplete: g.tutorialComplete, completedChallenges: g.completedChallenges } })) };
  }
  function readForProgressImport() {
    const result = read();
    if (!result.ok) return result;
    if (progressStore.hasQuarantineArchive() || settingsStore.hasQuarantineArchive()) {
      return { ...result, ok: false, status: "corrupt-quarantined" };
    }
    return result;
  }
  function write(serialized) {
    if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > MAX_BYTES) return { ok: false, status: "invalid-profile" };
    let profile; try { profile = normalizeProfile(JSON.parse(serialized)); } catch { profile = null; }
    if (!profile) return { ok: false, status: "invalid-profile" };
    // Probe both domains before either is written. A future/corrupt domain
    // must never allow defaults from a partial read to erase healthy data.
    const progressProbe = progressStore.read(), preferencesProbe = settingsStore.read();
    if (!progressProbe.ok) return progressProbe;
    if (!preferencesProbe.ok) return preferencesProbe;
    // Write settings first so a settings I/O failure cannot rotate or replace
    // valid challenge/tutorial progress.
    const preferences = settingsStore.write({ format: "lifeline-preferences", schemaVersion: SCHEMA_VERSION, ...profile.preferences });
    if (!preferences.ok) return preferences;
    const progress = progressStore.write({ format: "lifeline-progress", schemaVersion: SCHEMA_VERSION, ...profile.progress });
    return progress.ok ? { ok: true, status: "saved" } : progress;
  }
  function writeProgress(progress) {
    const current = readForProgressImport();
    if (!current.ok) return current;
    if (!progress || typeof progress !== "object" || typeof progress.tutorialComplete !== "boolean"
      || !Array.isArray(progress.completedChallenges) || progress.completedChallenges.length > 256
      || progress.completedChallenges.some((id) => typeof id !== "string" || id.length > 80)) {
      return { ok: false, status: "invalid-profile" };
    }
    const saved = progressStore.write({ format: "lifeline-progress", schemaVersion: SCHEMA_VERSION,
      tutorialComplete: progress.tutorialComplete, completedChallenges: progress.completedChallenges });
    return saved.ok ? { ok: true, status: "saved" } : saved;
  }
  return { read, readForProgressImport, write, writeProgress,
    paths: { progress: progressStore.paths, preferences: settingsStore.paths } };
}

module.exports = { createProfileStore, PROFILE_SCHEMA_VERSION: SCHEMA_VERSION };
