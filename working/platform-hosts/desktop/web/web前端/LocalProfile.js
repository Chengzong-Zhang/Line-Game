export const PLAYER_PROFILE_SCHEMA_VERSION = 1;
export const PLAYER_PROFILE_STORAGE_KEY = "lifeline-player-profile-v1";

const emptyProfile = () => ({
  format: "lifeline-player-profile",
  schemaVersion: PLAYER_PROFILE_SCHEMA_VERSION,
  preferences: { language: null, audioEnabled: true, audioVolume: 70, reducedMotion: false, fullscreen: false, uiScale: 1 },
  progress: { tutorialComplete: false, completedChallenges: [] },
});

export function normalizePlayerProfile(value) {
  if (!value || value.format !== "lifeline-player-profile" || value.schemaVersion !== PLAYER_PROFILE_SCHEMA_VERSION) return null;
  const preferences = value.preferences;
  const progress = value.progress;
  if (!preferences || !progress || ![null, "zh", "en"].includes(preferences.language)
    || typeof preferences.audioEnabled !== "boolean" || typeof preferences.reducedMotion !== "boolean"
    || (preferences.audioVolume !== undefined && (!Number.isInteger(preferences.audioVolume) || preferences.audioVolume < 0 || preferences.audioVolume > 100))
    || (preferences.fullscreen !== undefined && typeof preferences.fullscreen !== "boolean")
    || (preferences.uiScale !== undefined && ![0.9, 1, 1.1].includes(preferences.uiScale))
    || typeof progress.tutorialComplete !== "boolean" || !Array.isArray(progress.completedChallenges)
    || progress.completedChallenges.length > 256
    || progress.completedChallenges.some((id) => typeof id !== "string" || id.length > 80)) return null;
  return {
    format: "lifeline-player-profile",
    schemaVersion: PLAYER_PROFILE_SCHEMA_VERSION,
    preferences: { language: preferences.language, audioEnabled: preferences.audioEnabled, audioVolume: preferences.audioVolume ?? 70,
      reducedMotion: preferences.reducedMotion, fullscreen: preferences.fullscreen ?? false, uiScale: preferences.uiScale ?? 1 },
    progress: { tutorialComplete: progress.tutorialComplete, completedChallenges: [...new Set(progress.completedChallenges)].slice(0, 256) },
  };
}

export function createDefaultPlayerProfile() {
  return emptyProfile();
}

export function loadPlayerProfileResult(storage) {
  try {
    if (storage === undefined && globalThis.lifelineDesktop?.isDesktop) {
      const result = globalThis.lifelineDesktop.readProfileSync();
      // Keep any independently readable data if the other file is corrupt or
      // from a newer version. Retain the original read status separately: an
      // immediate preferences write must not erase a recovery/read-only notice.
      const profile = result?.value ? normalizePlayerProfile(JSON.parse(result.value)) : null;
      return { profile: profile ?? emptyProfile(), ok: Boolean(result?.ok), status: result?.status ?? "read-failed" };
    }
    storage ??= globalThis.localStorage;
    const raw = storage?.getItem?.(PLAYER_PROFILE_STORAGE_KEY);
    if (!raw) return { profile: emptyProfile(), ok: true, status: "empty" };
    const value = JSON.parse(raw);
    const profile = normalizePlayerProfile(value);
    return { profile: profile ?? emptyProfile(), ok: Boolean(profile),
      status: profile ? "saved" : value?.schemaVersion > PLAYER_PROFILE_SCHEMA_VERSION ? "unsupported-version" : "invalid-profile" };
  } catch { return { profile: emptyProfile(), ok: false, status: "read-failed" }; }
}

export function loadPlayerProfile(storage) {
  return loadPlayerProfileResult(storage).profile;
}

export function getPlayerProfileReadNotice(status, language = "zh") {
  const zh = language !== "en";
  if (status === "unsupported-version" || status === "unsupported-backup-version" || status === "write-blocked") {
    return zh
      ? "进度或设置来自较新版本，当前只读；原文件已保留。"
      : "Newer version: read-only. Original files preserved.";
  }
  if (status === "recovered-backup" || status === "backup-only") {
    return zh
      ? "已从备份恢复进度或设置；原文件已保留。"
      : "Recovered progress/settings from backup; originals kept.";
  }
  if (["corrupt-quarantined", "quarantine-failed", "backup-quarantine-failed", "invalid-profile", "read-failed"].includes(status)) {
    return zh
      ? "进度或设置读取失败，暂时不能保存；原文件已保留。"
      : "Progress/settings unreadable. Saving paused; files kept.";
  }
  return "";
}

export function persistPlayerProfile(profile, storage) {
  const normalized = normalizePlayerProfile(profile);
  if (!normalized) return { ok: false, status: "invalid-profile" };
  try {
    const serialized = JSON.stringify(normalized);
    if (storage === undefined && globalThis.lifelineDesktop?.isDesktop) {
      return globalThis.lifelineDesktop.writeProfileSync(serialized) ?? { ok: false, status: "profile-write-failed" };
    }
    storage ??= globalThis.localStorage;
    if (!storage?.setItem) return { ok: false, status: "storage-unavailable" };
    storage.setItem(PLAYER_PROFILE_STORAGE_KEY, serialized);
    return { ok: true, status: "saved" };
  } catch { return { ok: false, status: "profile-write-failed" }; }
}
