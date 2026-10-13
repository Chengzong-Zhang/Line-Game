import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { canonicalize, createReplayDocument, validateReplayDocument } from "../web前端/ReplayCodec.js";

export async function engineSources() {
  return Object.fromEntries(await Promise.all(["GameEngine.js", "ReplayCodec.js", "ResearchAI.js"].map(async (file) => [file, createHash("sha256").update(await readFile(new URL(`../web前端/${file}`, import.meta.url))).digest("hex")])));
}
export async function validateContribution(payload) {
  if (payload?.format !== "lifeline-training-contribution" || payload.version !== 1 || payload.consent !== true || payload.consent_policy !== "anonymous-replay-training-v1") throw new Error("Contribution consent/schema required");
  const doc = payload.replay;
  if (!Number.isInteger(doc?.config?.gridSize) || doc.config.gridSize < 5 || doc.config.gridSize > 15 || ![2, 3].includes(doc.config.playerCount)
    || !["BLACK", "WHITE", ...(doc.config.playerCount === 3 ? ["PURPLE"] : [])].includes(doc.config.startPlayer)
    || !Array.isArray(doc.actions) || doc.actions.length < 1 || doc.actions.length > 512) throw new Error("Replay dimensions/actions invalid");
  const expectedPlayers = ["BLACK", "WHITE", ...(doc.config.playerCount === 3 ? ["PURPLE"] : [])];
  if (canonicalize(doc.config.players) !== canonicalize(expectedPlayers) || doc.config.superko !== "enforce"
    || typeof doc.config.hintEnabled !== "boolean" || typeof doc.config.turnTimerEnabled !== "boolean"
    || !Number.isFinite(doc.config.turnTimeLimitSeconds) || doc.config.turnTimeLimitSeconds < 0 || doc.config.turnTimeLimitSeconds > 200
    || !Number.isInteger(doc.config.hintMaxCount) || doc.config.hintMaxCount < 0 || doc.config.hintMaxCount > 100) throw new Error("Replay settings invalid");
  const verified = await validateReplayDocument(doc);
  if (!verified.success) throw new Error(verified.reason);
  // Recompute effects, actor order, winner and scores: client hashes prove consistency, not truth.
  const rebuilt = await createReplayDocument(doc.config, doc.actions);
  if (!rebuilt.terminal || canonicalize(doc) !== canonicalize(rebuilt)) throw new Error("Replay is incomplete or differs from authoritative replay");
  const gameplay = { rules: rebuilt.rulesVersion, size: rebuilt.config.gridSize, players: rebuilt.config.playerCount, start: rebuilt.config.startPlayer,
    actions: rebuilt.actions.map(({ type, actor, point }) => ({ type, actor, ...(point ? { point } : {}) })) };
  return { game_id: createHash("sha256").update(canonicalize(gameplay)).digest("hex"), replay: rebuilt, engine_sources: await engineSources() };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let input = ""; for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > 512000) throw new Error("Payload too large"); }
    process.stdout.write(JSON.stringify(await validateContribution(JSON.parse(input))));
  } catch (error) { process.stderr.write(String(error.message)); process.exitCode = 1; }
}
