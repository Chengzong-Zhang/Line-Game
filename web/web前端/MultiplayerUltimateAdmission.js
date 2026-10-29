// Product admission policy. Current unqualified Ultimate has no accepted release.
// Releases must come from reviewed application configuration, never a save,
// request, model manifest, or experiment result supplied by the caller's user.
// Receipt hashes identify reviewed evidence; this pure helper does not verify
// the scientific evidence or perform cryptographic file verification itself.
const SHA256 = /^[a-f0-9]{64}$/;
const PUBLIC_ID = /^multiplayer-ultimate-v[1-9]\d*$/;
const COLORS = ["BLACK", "WHITE", "PURPLE", "GREEN", "ORANGE", "CYAN"];
export const CURRENT_ULTIMATE_MODEL_ID = "multiplayer-ultimate-v1";
export const ACCEPTED_ULTIMATE_RELEASES = Object.freeze([]);

const denied = (code, restoring = false) => Object.freeze({
  allowed: false, applies: true, code, preserveSelection: true, preserveSave: true,
  message: restoring
    ? "此存档使用的终极 AI 尚未通过棋力与发布验收，AI 回合已暂停。存档和难度选择已保留。"
    : "终极 AI 尚未通过棋力与发布验收，暂不可使用。请手动选择其他难度。",
});
const notApplicable = () => Object.freeze({ allowed: true, applies: false, code: "NOT_ULTIMATE" });
const isUltimate = profile => profile?.choice === "ai-ultimate"
  || typeof profile?.modelId === "string" && profile.modelId.startsWith("multiplayer-ultimate-");
const validContext = c => Number.isInteger(c?.playerCount) && c.playerCount >= 3 && c.playerCount <= 6
  && Number.isInteger(c.gridSize) && c.gridSize >= 5 && c.gridSize <= 15
  && ["territory-v2", "territory-v3"].includes(c.rulesVersion) && c.boardShape === (c.playerCount === 3 ? "triangle" : "hexagon");

export function createUltimateAdmissionGuard(trustedReleases = ACCEPTED_ULTIMATE_RELEASES) {
  if (!Array.isArray(trustedReleases)) throw new TypeError("Expected reviewed Ultimate releases");
  // Copy now: later mutation of an input registry must not silently grant access.
  const releases = structuredClone(trustedReleases);
  const accepted = release => PUBLIC_ID.test(release?.modelId)
    && release.strengthStatus === "PASS" && release.promotionStatus === "PASS"
    && [release.assetSha256, release.trainingIdentity, release.strengthReceiptSha256,
      release.promotionReceiptSha256].every(value => typeof value === "string" && SHA256.test(value));

  function checkProfile(profile, context, modelSpec, { restoring = false } = {}) {
    if (!isUltimate(profile)) return notApplicable();
    const modelId = profile.modelId ?? CURRENT_ULTIMATE_MODEL_ID;
    if (!PUBLIC_ID.test(modelId)) return denied("ULTIMATE_EXPERIMENT_REQUIRES_ISOLATION", restoring);
    if (!validContext(context)) return denied("ULTIMATE_UNSUPPORTED_CONTEXT", restoring);
    const matches = releases.filter(release => accepted(release) && release.modelId === modelId);
    if (matches.length !== 1) return denied("ULTIMATE_NOT_QUALIFIED", restoring);
    const release = matches[0];
    if (!Array.isArray(release.contexts) || !release.contexts.some(c => validContext(c)
      && c.playerCount === context.playerCount && c.gridSize === context.gridSize
      && c.boardShape === context.boardShape && c.rulesVersion === context.rulesVersion))
      return denied("ULTIMATE_CONTEXT_NOT_QUALIFIED", restoring);
    if (modelSpec?.id !== modelId || modelSpec.asset_sha256 !== release.assetSha256
      || modelSpec.training?.identity !== release.trainingIdentity)
      return denied("ULTIMATE_MODEL_IDENTITY_MISMATCH", restoring);
    return Object.freeze({ allowed: true, applies: true, code: "ULTIMATE_QUALIFIED", modelId,
      assetSha256: release.assetSha256, trainingIdentity: release.trainingIdentity });
  }

  function checkSavedSession(session, modelSpecs = {}) {
    const context = session?.settings;
    // This helper only gates Ultimate; the ordinary session validator must run
    // independently. Inactive seats keep their saved preferences. Invalid
    // settings cannot hide an active Ultimate choice from this gate.
    const seats = validContext(context) ? COLORS.slice(0, context.playerCount) : COLORS;
    const blocked = seats.flatMap(color => {
      const player = session?.match?.players?.[color];
      if (!isUltimate(player)) return [];
      const modelId = player.modelId ?? CURRENT_ULTIMATE_MODEL_ID;
      const result = checkProfile(player, context, modelSpecs[modelId], { restoring: true });
      return result.allowed ? [] : [{ color, ...result }];
    });
    return Object.freeze({ allowed: blocked.length === 0, blocked: Object.freeze(blocked),
      preserveSave: true, preserveSelection: true });
  }
  return Object.freeze({ checkProfile, checkSavedSession });
}

// Separate experiment admission never grants a product/save admission. Its ID
// cannot pass the public-ID check, and its output must stay out of normal saves.
export function checkIsolatedUltimateResearch(request) {
  if (request?.entry !== "isolated-experiment" || request.isolated !== true
    || request.candidateOnly !== true || request.productionPromoted !== false
    || typeof request.experimentIdentity !== "string" || !SHA256.test(request.experimentIdentity)
    || typeof request.modelId !== "string"
    || !/^multiplayer-ultimate-[a-z0-9-]+-experiment$/.test(request.modelId))
    return denied("ULTIMATE_EXPERIMENT_REQUIRES_ISOLATION");
  return Object.freeze({ allowed: true, applies: true, code: "ISOLATED_RESEARCH_CANDIDATE_ONLY",
    modelId: request.modelId, experimentIdentity: request.experimentIdentity,
    productionPromoted: false, candidateOnly: true, persistAsProductChoice: false });
}
