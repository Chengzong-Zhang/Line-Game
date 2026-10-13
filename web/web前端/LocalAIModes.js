export const LOCAL_AI_MODES = Object.freeze(["none", "ai_black", "ai_white", "ai_duel"]);

export function resolveAIPlayer(mode, currentPlayer) {
  if (mode === "ai_duel") return currentPlayer;
  if (mode === "ai_black") return "BLACK";
  if (mode === "ai_white") return "WHITE";
  return null;
}

export function localAIActors(mode, profile, playerCount = 2) {
  const aiActor = { kind: "ai" };
  for (const key of ["strategy", "modelId", "seed", "simulations", "cPuct", "depth"]) {
    if (profile[key] !== undefined) aiActor[key] = profile[key];
  }
  const colors = ["BLACK", "WHITE", ...(playerCount === 3 ? ["PURPLE"] : [])];
  return Object.fromEntries(colors.map((player) => [player,
    playerCount === 2 && (mode === "ai_duel" || resolveAIPlayer(mode, player) === player)
      ? { ...aiActor } : { kind: "human" }]));
}
