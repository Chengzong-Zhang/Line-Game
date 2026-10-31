const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const FORMAT = "lifeline-achievement-queue";
const SCHEMA_VERSION = 1;
const CHALLENGE_IDS = Object.freeze([
  "C01-hub-connection", "C02-sever-outpost", "C03-close-corner", "C04-defend-supply", "C05-two-move-area", "C06-cut-and-enclose",
  "C03-close-corner-upper-basin-five", "C01-hub-connection-west-basin-nine", "C01-hub-connection-west-basin-twelve",
  "C02-sever-outpost-cross-cut-two", "C06-cut-and-enclose-cross-cut-fourteen", "C01-hub-connection-upper-bridge-four",
  "C02-sever-outpost-lower-cut-reconnect", "C01-hub-connection-east-pocket-three", "C02-sever-outpost-east-pocket-cut",
  "C02-sever-outpost-lower-cross-cut", "C06-cut-and-enclose-south-cut-twelve", "C06-cut-and-enclose-center-cut-ten",
  "C03-close-corner-lower-pocket-three", "C06-cut-and-enclose-paired-clean-six", "C02-sever-outpost-paired-cut-two-links",
  "C06-cut-and-enclose-south-cut-ten", "C03-close-corner-upper-pocket-clean-three", "C03-close-corner-middle-basin-clean-three",
]);
const CHALLENGE_ID_SET = new Set(CHALLENGE_IDS);
const ACHIEVEMENTS = Object.freeze([
  { id: "tutorial-complete", titleZh: "初识生命线", titleEn: "First Steps", descriptionZh: "完成新手教学。", descriptionEn: "Complete the tutorial." },
  { id: "challenge-first", titleZh: "初试身手", titleEn: "First Challenge", descriptionZh: "完成 1 个挑战。", descriptionEn: "Complete 1 challenge." },
  { id: "challenge-6", titleZh: "战术入门", titleEn: "Tactical Learner", descriptionZh: "完成 6 个不同挑战。", descriptionEn: "Complete 6 distinct challenges." },
  { id: "challenge-12", titleZh: "战术熟手", titleEn: "Tactical Regular", descriptionZh: "完成 12 个不同挑战。", descriptionEn: "Complete 12 distinct challenges." },
  { id: "challenge-24", titleZh: "生命线大师", titleEn: "Lifeline Master", descriptionZh: "完成全部 24 个不同挑战。", descriptionEn: "Complete all 24 distinct challenges." },
]);
const ACHIEVEMENT_IDS = new Set(ACHIEVEMENTS.map(({ id }) => id));

function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
}
function digest(value) { return crypto.createHash("sha256").update(value, "utf8").digest("hex"); }
function envelope(payload) {
  return JSON.stringify({ format: "lifeline-achievement-envelope", schemaVersion: SCHEMA_VERSION,
    sha256: digest(canonicalize(payload)), payload });
}
function atomicWrite(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, contents, "utf8"); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch { /* retain evidence */ }
  }
}

function createQueueStore(userDataDirectory, options = {}) {
  const file = path.join(userDataDirectory, "achievements", "pending.json");
  const backup = `${file}.bak`;
  const writeFile = options.atomicWrite ?? atomicWrite;
  const now = options.now ?? (() => new Date());
  let writeBlocked = false;
  let blockedStatus = "write-blocked";
  let quarantined = false;
  const readOne = (target) => {
    if (!fs.existsSync(target)) return { kind: "missing" };
    try {
      const stat = fs.statSync(target);
      if (!stat.isFile() || stat.size > 64_000) return { kind: "corrupt" };
      const value = JSON.parse(fs.readFileSync(target, "utf8"));
      if (value?.format !== "lifeline-achievement-envelope" || !Number.isInteger(value.schemaVersion)) return { kind: "corrupt" };
      if (value.schemaVersion > SCHEMA_VERSION || value.payload?.schemaVersion > SCHEMA_VERSION) return { kind: "unsupported" };
      if (value.schemaVersion !== SCHEMA_VERSION || value.payload?.format !== FORMAT
        || value.payload?.schemaVersion !== SCHEMA_VERSION
        || !Array.isArray(value.payload.pendingIds) || value.payload.pendingIds.length > ACHIEVEMENTS.length
        || value.payload.pendingIds.some((id) => !ACHIEVEMENT_IDS.has(id))
        || new Set(value.payload.pendingIds).size !== value.payload.pendingIds.length
        || digest(canonicalize(value.payload)) !== value.sha256) return { kind: "corrupt" };
      return { kind: "valid", ids: value.payload.pendingIds };
    } catch { return { kind: "corrupt" }; }
  };
  const quarantine = (target) => {
    if (!fs.existsSync(target)) return true;
    const stamp = now().toISOString().replace(/[:.]/g, "-");
    try { fs.renameSync(target, `${target}.corrupt-${stamp}`); quarantined = true; return true; } catch { return false; }
  };
  const hasQuarantineArchive = () => {
    try { return fs.readdirSync(path.dirname(file)).some((name) => /^pending\.json(?:\.bak)?\.corrupt-/.test(name)); }
    catch { return false; }
  };
  const read = () => {
    writeBlocked = false;
    blockedStatus = "write-blocked";
    const current = readOne(file);
    if (current.kind === "unsupported") { writeBlocked = true; blockedStatus = "unsupported-version"; return { ok: false, status: blockedStatus, pendingIds: [] }; }
    if (current.kind === "valid") return { ok: true, status: "saved", pendingIds: current.ids };
    if (current.kind === "corrupt" && !quarantine(file)) return { ok: false, status: "quarantine-failed", pendingIds: [] };
    const previous = readOne(backup);
    if (previous.kind === "unsupported") { writeBlocked = true; blockedStatus = "unsupported-backup-version"; return { ok: false, status: blockedStatus, pendingIds: [] }; }
    if (previous.kind === "valid") return { ok: true, status: current.kind === "corrupt" ? "recovered-backup" : "backup-only", pendingIds: previous.ids };
    if (previous.kind === "corrupt" && !quarantine(backup)) return { ok: false, status: "backup-quarantine-failed", pendingIds: [] };
    if (quarantined || hasQuarantineArchive()) { writeBlocked = true; blockedStatus = "corrupt-quarantined"; return { ok: false, status: blockedStatus, pendingIds: [] }; }
    return { ok: true, status: "empty", pendingIds: [] };
  };
  const merge = (ids) => {
    if (writeBlocked) return { ok: false, status: blockedStatus };
    if (!Array.isArray(ids) || ids.some((id) => !ACHIEVEMENT_IDS.has(id))) return { ok: false, status: "invalid-achievement" };
    const current = readOne(file), previous = readOne(backup);
    if (current.kind === "unsupported" || previous.kind === "unsupported") {
      writeBlocked = true;
      blockedStatus = previous.kind === "unsupported" ? "unsupported-backup-version" : "unsupported-version";
      return { ok: false, status: blockedStatus };
    }
    if (current.kind === "corrupt") {
      if (!quarantine(file)) return { ok: false, status: "quarantine-failed" };
      if (previous.kind !== "valid") { writeBlocked = true; blockedStatus = "corrupt-quarantined"; return { ok: false, status: blockedStatus }; }
    }
    if (previous.kind === "corrupt") {
      if (!quarantine(backup)) return { ok: false, status: "backup-quarantine-failed" };
      if (current.kind !== "valid") { writeBlocked = true; blockedStatus = "corrupt-quarantined"; return { ok: false, status: blockedStatus }; }
    }
    if (current.kind === "missing" && previous.kind === "missing" && hasQuarantineArchive()) {
      writeBlocked = true;
      blockedStatus = "corrupt-quarantined";
      return { ok: false, status: blockedStatus };
    }
    const existing = current.kind === "valid" ? current.ids : previous.kind === "valid" ? previous.ids : [];
    const pendingIds = [...new Set([...existing, ...ids])].filter((id) => ACHIEVEMENT_IDS.has(id));
    if (existing.length === pendingIds.length && existing.every((id) => pendingIds.includes(id))) return { ok: true, status: "saved", pendingIds };
    const payload = { format: FORMAT, schemaVersion: SCHEMA_VERSION, pendingIds };
    try {
      if (current.kind === "valid") writeFile(backup, envelope({ ...payload, pendingIds: current.ids }));
      writeFile(file, envelope(payload));
    } catch (error) { return { ok: false, status: "write-failed", message: String(error?.message ?? error) }; }
    return { ok: true, status: "saved", pendingIds };
  };
  return { read, merge, paths: { file, backup } };
}

function deriveUnlocked(progress) {
  if (!progress || typeof progress.tutorialComplete !== "boolean" || !Array.isArray(progress.completedChallenges)) return null;
  const completed = new Set(progress.completedChallenges.filter((id) => CHALLENGE_ID_SET.has(id)));
  const count = completed.size;
  const unlocked = new Set();
  if (progress.tutorialComplete) unlocked.add("tutorial-complete");
  if (count >= 1) unlocked.add("challenge-first");
  if (count >= 6) unlocked.add("challenge-6");
  if (count >= 12) unlocked.add("challenge-12");
  if (count >= 24) unlocked.add("challenge-24");
  return unlocked;
}

function createAchievementService(userDataDirectory, profileStore, steam) {
  const queue = createQueueStore(userDataDirectory);
  return {
    read() {
      const savedProfile = profileStore.read();
      if (!savedProfile?.ok || !["saved", "empty", "recovered-backup", "backup-only"].includes(savedProfile.status)
        || typeof savedProfile.value !== "string") return { ok: false, status: savedProfile?.status ?? "profile-unavailable", achievements: [], pendingCount: 0, steam: steam.status() };
      let profile;
      try { profile = JSON.parse(savedProfile.value); } catch { return { ok: false, status: "invalid-saved-profile", achievements: [], pendingCount: 0, steam: steam.status() }; }
      const unlocked = deriveUnlocked(profile?.progress);
      if (!unlocked) return { ok: false, status: "invalid-saved-profile", achievements: [], pendingCount: 0, steam: steam.status() };
      const pending = queue.merge([...unlocked]);
      if (!pending.ok) return { ok: false, status: pending.status, achievements: [], pendingCount: 0, steam: steam.status() };
      return { ok: true, status: savedProfile.status,
        achievements: ACHIEVEMENTS.map((achievement) => ({ ...achievement, unlocked: unlocked.has(achievement.id), pending: pending.pendingIds.includes(achievement.id) })),
        pendingCount: pending.pendingIds.length, steam: steam.status() };
    },
  };
}

module.exports = { ACHIEVEMENTS, CHALLENGE_IDS, createAchievementService, createQueueStore, deriveUnlocked };
