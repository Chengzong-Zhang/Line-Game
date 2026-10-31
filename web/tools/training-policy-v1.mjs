export function rejectRetiredTrainingEntry(entry) {
  const error = new Error(`${entry} is a preserved historical training protocol. New training must use defensive-training-data-v1.mjs: complete minimax depth >=3, two actual opponent rounds, defensive/root-connected cut-chain labels. No old 1/2-ply or rollout-only labels may start new training.`);
  error.code = "RETIRED_SHALLOW_TRAINING_PROTOCOL";
  throw error;
}
