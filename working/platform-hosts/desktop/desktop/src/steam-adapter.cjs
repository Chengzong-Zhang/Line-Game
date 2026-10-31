function createSteamAdapter(implementation = null) {
  if (!implementation) {
    return Object.freeze({
      configured: false,
      status: () => ({ available: false, configured: false, reason: "steamworks-account-and-app-id-not-configured" }),
      getIdentity: async () => null,
      unlockAchievement: async () => ({ ok: false, reason: "steamworks-not-configured" }),
      syncCloud: async () => ({ ok: false, reason: "steam-cloud-not-configured" })
    });
  }
  return implementation;
}

module.exports = { createSteamAdapter };
