// Explicit replicate choice shared by local play and the comparison panel.
export const TRANSFER_SEEDS = Object.freeze([2026092201, 2026092202, 2026092203]);
export const RESEARCH_FAMILIES = Object.freeze(["padded-cnn", "grid-gnn", "topology-gnn"]);
export const DEFAULT_RESEARCH_VERSION = "2026092201";
export const RESEARCH_SELECTION_KEY = "lifeline-research-model-version-v1";

export function researchProfile(family, version = DEFAULT_RESEARCH_VERSION) {
  if (!RESEARCH_FAMILIES.includes(family) || !["legacy", ...TRANSFER_SEEDS.map(String)].includes(version)) {
    throw new Error("Unknown research model family or seed.");
  }
  const legacy = version === "legacy";
  return {
    strategy: "neural-puct", modelId: legacy ? `${family}-d14-s20260825-g200` : `${family}-transfer-v1-seed${version}`,
    simulations: 16, cPuct: 1.5, seed: legacy ? 20260825 : Number(version),
    label: `${family} · seed ${legacy ? 20260825 : version} · ${legacy ? "5/7/9 · legacy" : "PILOT_ONLY"} · PUCT-16 · c_puct=1.5 · COMPATIBILITY_TRIAL`,
  };
}

export function loadResearchSelection(storage = globalThis.localStorage) {
  try {
    const value = storage?.getItem(RESEARCH_SELECTION_KEY);
    if (["legacy", ...TRANSFER_SEEDS.map(String)].includes(value)) return value;
  } catch (_) { /* unavailable storage */ }
  return DEFAULT_RESEARCH_VERSION;
}

export function persistResearchSelection(value, storage = globalThis.localStorage) {
  researchProfile(RESEARCH_FAMILIES[0], value);
  try { storage?.setItem(RESEARCH_SELECTION_KEY, value); } catch (_) { /* visible selection still works */ }
}
