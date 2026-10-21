import { validateProtocol as originalValidate } from "./hex-posttrain-protocol.mjs";
export { rawAtomic, readModel, sealModel, modelBody, trainingSpecs, arenaSpecs, pairedRows, arenaSummary } from "./hex-posttrain-protocol.mjs";
export const SOURCE_FILES = ["web/tools/run-hex-distillation-v3-final.mjs", "web/tools/hex-distill-v3-final-protocol.mjs",
  "web/tools/hex-posttrain-protocol.mjs", "web/tools/hex-posttrain-core.mjs", "web/tools/linear-three-v3-core.mjs",
  "web/tools/three-player-arena-lib.mjs", "web/web前端/GameEngine.js", "web/web前端/AIEngine.js", "web/web前端/HexPlayerAI.js"];
export function validateProtocol(c) {
  if (c.mode !== "FINAL" || c.modelId !== "hex-player-policy-v3" || c.seedNamespace !== "hex-v3-round-FINAL-20261021-unopened-r1") {
    throw new Error("Unexpected v3 FINAL protocol");
  }
  originalValidate({ ...c, modelId: "hex-player-policy-v2" });
  return c;
}
