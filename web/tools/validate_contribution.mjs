import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { canonicalize, createReplayDocument, validateReplayDocument } from "../web前端/ReplayCodec.js";
import {
  CONTRIBUTION_V2_POLICY,
  CONTRIBUTION_V2_MAX_ACTIONS,
  CONTRIBUTION_V3_POLICY,
  CONTRIBUTION_V3_MAX_ACTIONS,
  normalizeV2Context,
  normalizeV3Context,
} from "./training_contribution_schema.mjs";

const V2_PLAYERS = ["BLACK", "WHITE", "PURPLE", "GREEN", "ORANGE", "CYAN"];
const V3_PLAYERS = [...V2_PLAYERS, "PINK", "BROWN", "LIME", "NAVY", "GOLD", "TEAL", "MAGENTA", "SLATE", "CORAL"];

export async function engineSources(version = 1) {
  const sources = ["GameEngine.js", "ReplayCodec.js", "ResearchAI.js"].map(file => [file, `../web前端/${file}`]);
  if (version === 2 || version === 3) sources.push(["StartingPoints.js", "../web前端/StartingPoints.js"],
    ["training_contribution_schema.mjs", "./training_contribution_schema.mjs"], ["validate_contribution.mjs", "./validate_contribution.mjs"]);
  return Object.fromEntries(await Promise.all(sources.map(async ([file, path]) => [file, createHash("sha256").update(await readFile(new URL(path, import.meta.url))).digest("hex")])));
}
export async function validateContribution(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
    || canonicalize(Object.keys(payload).sort()) !== canonicalize(["format", "version", "consent", "consent_policy", "replay", "context"].sort())
    || payload.format !== "lifeline-training-contribution" || ![1, 2, 3].includes(payload.version) || payload.consent !== true
    || payload.consent_policy !== (payload.version === 3 ? CONTRIBUTION_V3_POLICY
      : payload.version === 2 ? CONTRIBUTION_V2_POLICY : "anonymous-replay-training-v1")) throw new Error("Contribution consent/schema required");
  const version = payload.version;
  const doc = payload.replay;
  const counts = version === 3 ? Array.from({ length: 14 }, (_, index) => index + 2)
    : version === 2 ? [2, 3, 4, 5, 6] : [2, 3];
  const maximumActions = version === 3 ? CONTRIBUTION_V3_MAX_ACTIONS : version === 2 ? CONTRIBUTION_V2_MAX_ACTIONS : 512;
  if (!Number.isInteger(doc?.config?.gridSize) || doc.config.gridSize < 5 || doc.config.gridSize > 15 || !counts.includes(doc.config.playerCount)
    || !Array.isArray(doc.actions) || doc.actions.length < 1 || doc.actions.length > maximumActions) throw new Error("Replay dimensions/actions invalid");
  const expectedPlayers = (version === 3 ? V3_PLAYERS : V2_PLAYERS).slice(0, doc.config.playerCount);
  if (!expectedPlayers.includes(doc.config.startPlayer)) throw new Error("Invalid starting player");
  if (canonicalize(doc.config.players) !== canonicalize(expectedPlayers) || doc.config.superko !== "enforce"
    || typeof doc.config.hintEnabled !== "boolean" || typeof doc.config.turnTimerEnabled !== "boolean"
    || !Number.isFinite(doc.config.turnTimeLimitSeconds) || doc.config.turnTimeLimitSeconds < 0 || doc.config.turnTimeLimitSeconds > 200
    || !Number.isInteger(doc.config.hintMaxCount) || doc.config.hintMaxCount < 0 || doc.config.hintMaxCount > 100) throw new Error("Replay settings invalid");
  if (version === 2 && (doc.rulesVersion !== "territory-v2" || doc.config.rulesVersion !== "territory-v2")) throw new Error("Unsupported v2 rules");
  if (version === 3 && (doc.rulesVersion !== "territory-v3" || doc.config.rulesVersion !== "territory-v3")) throw new Error("Unsupported v3 rules");
  const context = version === 3 ? normalizeV3Context(payload.context, doc.config)
    : version === 2 ? normalizeV2Context(payload.context, doc.config) : null;
  const verified = await validateReplayDocument(doc);
  if (!verified.success) throw new Error(verified.reason);
  // Recompute effects, actor order, winner and scores: client hashes prove consistency, not truth.
  const rebuilt = await createReplayDocument(doc.config, doc.actions);
  if (!rebuilt.terminal || canonicalize(doc) !== canonicalize(rebuilt)) throw new Error("Replay is incomplete or differs from authoritative replay");
  const actions = rebuilt.actions.map(({ type, actor, point }) => ({ type, actor, ...(point ? { point } : {}) }));
  // Keep historical v1 IDs stable. V2 binds every canonical setting, including
  // actual random/custom starts and non-default board shape, in a new namespace.
  const gameplay = version === 2 || version === 3
    ? { namespace: `lifeline-training-game-v${version}`, rules: rebuilt.rulesVersion, config: rebuilt.config, actions }
    : { rules: rebuilt.rulesVersion, size: rebuilt.config.gridSize, players: rebuilt.config.playerCount, start: rebuilt.config.startPlayer, actions };
  return { game_id: createHash("sha256").update(canonicalize(gameplay)).digest("hex"), replay: rebuilt,
    engine_sources: await engineSources(version), ...(version === 2 || version === 3 ? { protocol_version: version, context } : {}) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let input = ""; for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > 512000) throw new Error("Payload too large"); }
    process.stdout.write(JSON.stringify(await validateContribution(JSON.parse(input))));
  } catch (error) { process.stderr.write(String(error.message)); process.exitCode = 1; }
}
