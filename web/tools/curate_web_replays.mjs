// Offline curation: replay under Web rules, keep explicit reviewed human moves.
import { createHash } from "node:crypto";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import GameEngine from "../web前端/GameEngine.js";
import { encodeResearchPosition, researchRelations } from "../web前端/ResearchAI.js";
import { canonicalize, serializeRuleState } from "../web前端/ReplayCodec.js";
import { validateContribution, engineSources } from "./validate_contribution.mjs";

export async function curate(inbox, reviews, output, { minimumMoves = 8 } = {}) {
  if (reviews?.policy !== "human-review-v1" || !Array.isArray(reviews.approved_game_ids)
    || !reviews.approved_game_ids.every((id) => /^[a-f0-9]{64}$/.test(id))) throw new Error("Explicit reviewed game IDs required");
  const approved = new Set(reviews.approved_game_ids); const seen = new Set(); const rows = []; const decisions = [];
  const sources = await engineSources();
  const files = (await readdir(inbox)).filter((file) => /^[a-f0-9]{64}\.json$/.test(file)).sort();
  for (const file of files) {
    const record = JSON.parse(await readFile(resolve(inbox, file), "utf8"));
    const { game_id: id, replay: doc, context } = record;
    const decision = { game_id: id, accepted: false, reason: "unreviewed" }; decisions.push(decision);
    const validated = await validateContribution({ format: "lifeline-training-contribution", version: 1, consent: true, consent_policy: record.consent_policy, replay: doc, context });
    if (`${id}.json` !== file || validated.game_id !== id || canonicalize(record.engine_sources) !== canonicalize(sources)) throw new Error("Inbox ID/source mismatch");
    if (seen.has(id)) { decision.reason = "duplicate"; continue; } seen.add(id);
    if (!approved.has(id)) continue;
    if (doc.rulesVersion !== "territory-v2" || doc.config.playerCount !== 2) { decision.reason = "unsupported_training_rules"; continue; }
    if (context.mixedProfiles || context.hintsEnabled || doc.config.hintEnabled || doc.config.turnTimerEnabled) { decision.reason = "mixed_or_assisted_or_timed"; continue; }
    if (doc.actions.filter((e) => e.type === "move").length < minimumMoves) { decision.reason = "too_short"; continue; }
    if (!Object.values(context.actors).some((a) => a.kind === "human")) { decision.reason = "no_human"; continue; }
    const split = parseInt(id.slice(0, 8), 16) % 5 === 0 ? "validation" : "train";
    const engine = new GameEngine({ ...doc.config, deferTerritoryUpdates: false });
    for (const event of doc.actions) {
      if (event.type !== "resign" && context.actors[event.actor]?.kind === "human") {
        const encoded = encodeResearchPosition(engine); const nodeCount = encoded.passIndex;
        const action = event.type === "skip" ? nodeCount : engine._keyToIdx.get(event.point.join(","));
        const legal = [...encoded.legal, nodeCount];
        if (!legal.includes(action)) throw new Error("Training action illegal");
        rows.push({ game_id: id, split, seq: event.seq, board_size: engine.gridSize, player: encoded.player,
          pre_state_hash: event.preStateHash, history_size: engine.historyHashes.size,
          features: [...encoded.features], relations: researchRelations(engine, encoded.player, true), legal,
          action, value: doc.terminal.winner === null ? 0 : (doc.terminal.winner === encoded.player ? 1 : -1),
          policy_label: "reviewed_human_action", value_label: "web_terminal_outcome" });
      }
      const result = event.type === "move" ? engine.playMove(event.point) : event.type === "skip" ? engine.skipTurn() : engine.resignPlayer(event.actor);
      if (!result.success) throw new Error("Replay diverged during feature extraction");
    }
    decision.accepted = true; decision.reason = "reviewed_complete_web_replay"; decision.split = split;
  }
  if (approved.size && [...approved].some((id) => !seen.has(id))) throw new Error("Approved ID not present in inbox");
  await mkdir(output, { recursive: false });
  const raw = rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : "");
  await writeFile(resolve(output, "samples.jsonl"), raw, { flag: "wx" });
  const manifest = { schema: "lifeline-reviewed-web-training-v1", rules_version: "territory-v2", engine_sources: sources,
    sample_sha256: createHash("sha256").update(raw).digest("hex"), reviews_sha256: createHash("sha256").update(canonicalize(reviews)).digest("hex"),
    samples: rows.length, games: decisions.filter((d) => d.accepted).length,
    train_games: decisions.filter((d) => d.accepted && d.split === "train").length, validation_games: decisions.filter((d) => d.accepted && d.split === "validation").length,
    decisions, evidence_tier: "pilot", formal_ready: false, limitations: ["Actor roles are client declarations; approval is required", "Review is selection, not a strength certificate", "No Python rule equivalence assumed", "Validation is grouped by whole gameplay ID"] };
  await writeFile(resolve(output, "manifest.json"), JSON.stringify(manifest, null, 2), { flag: "wx" });
  return manifest;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [inbox, reviewsFile, output] = process.argv.slice(2);
    if (!inbox || !reviewsFile || !output) throw new Error("Usage: node curate_web_replays.mjs INBOX REVIEWS_JSON NEW_OUTPUT");
    const manifest = await curate(inbox, JSON.parse(await readFile(reviewsFile, "utf8")), output);
    process.stdout.write(JSON.stringify({ games: manifest.games, samples: manifest.samples, train_games: manifest.train_games, validation_games: manifest.validation_games, formal_ready: false }));
  } catch (error) { process.stderr.write(error.stack); process.exitCode = 1; }
}
