import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  TrainingContribution, CONTRIBUTION_STORAGE, CONTRIBUTION_POLICY,
  LEGACY_CONTRIBUTION_POLICY, normalizeContributionV3Context, supportsContributionActors,
} from "../TrainingContribution.js";
import { validateContribution } from "../../tools/validate_contribution.mjs";
import { curate } from "../../tools/curate_web_replays.mjs";
import { syntheticContribution } from "./fixtures/create-training-fixture.mjs";
import { syntheticV3Contribution } from "./fixtures/create-training-v3-fixture.mjs";

const payload = await syntheticContribution(1);
const values = new Map(); const storage = { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) };
let requests = 0; let failure = true;
const fetcher = async (_url, options) => {
  requests++; assert.equal(options.credentials, "omit");
  if (failure) throw new Error("offline");
  const verified = await validateContribution(JSON.parse(options.body));
  return { ok: true, json: async () => ({ status: "awaiting_review", game_id: verified.game_id }) };
};
const client = new TrainingContribution({ storage, fetcher });
assert.equal(client.enabled, true, "new visitors contribute by default");
client.setEnabled(false);
assert.equal(await client.enqueue(payload.replay.config, payload.replay.actions, payload.context), false);
await client.flush(); assert.equal(requests, 0);
client.setEnabled(true);
assert.equal(await client.enqueue(payload.replay.config, payload.replay.actions.slice(0, 1), payload.context), false);
assert.equal(await client.enqueue(payload.replay.config, payload.replay.actions, payload.context), true);
assert.equal(await client.enqueue(payload.replay.config, payload.replay.actions, payload.context), false);
await client.flush(); assert.equal(client.queue.length, 1); assert.equal(client.status, "retry");
const restored = new TrainingContribution({ storage, fetcher }); assert.equal(restored.queue.length, 1);
failure = false; await restored.flush(); assert.equal(restored.status, "received"); assert.equal(restored.queue.length, 0);
assert.equal(await restored.enqueue(payload.replay.config, payload.replay.actions, payload.context), false);
restored.setEnabled(false); assert.equal(JSON.parse(values.get(CONTRIBUTION_STORAGE)).enabled, false);
assert.equal(new TrainingContribution({ storage, fetcher }).enabled, false, "an explicit opt-out survives refresh");

// A protocol upgrade preserves both an old explicit opt-out and queued v1
// payloads. Only games completed after the upgrade are encoded as v3.
const oldOptOutValues = new Map([[CONTRIBUTION_STORAGE, JSON.stringify({ policy: "unknown-future-policy", enabled: false,
  queue: [{ id: "must-not-return", payload }] })]]);
const oldOptOut = new TrainingContribution({ storage: { getItem: key => oldOptOutValues.get(key), setItem: (key, value) => oldOptOutValues.set(key, value) } });
assert.equal(oldOptOut.enabled, false); assert.equal(oldOptOut.queue.length, 0);
const legacyValues = new Map([[CONTRIBUTION_STORAGE, JSON.stringify({ policy: LEGACY_CONTRIBUTION_POLICY, enabled: true,
  queue: [{ id: payload.replay.integrity.canonicalDocumentHash, payload }], lastReceipt: null })]]);
let migratedBody = null;
const migrated = new TrainingContribution({ storage: { getItem: key => legacyValues.get(key), setItem: (key, value) => legacyValues.set(key, value) },
  fetcher: async (_url, options) => {
    migratedBody = JSON.parse(options.body); const verified = await validateContribution(migratedBody);
    return { ok: true, json: async () => ({ status: "awaiting_review", game_id: verified.game_id }) };
  } });
assert.equal(migrated.queue.length, 1); await migrated.flush();
assert.equal(migratedBody.version, 1); assert.equal(migratedBody.consent_policy, LEGACY_CONTRIBUTION_POLICY);
assert.equal(JSON.parse(legacyValues.get(CONTRIBUTION_STORAGE)).policy, CONTRIBUTION_POLICY);

const v3Fixture = await syntheticV3Contribution({ playerCount: 15, boardShape: "hexagon", gridSize: 5,
  startingPointMode: "custom", profile: "multiplayer-hard-v1" });
const v3Settings = { ...v3Fixture.replay.config, boardShape: "hexagon", undoEnabled: true, undoMaxCount: 3 };
const v3Actions = v3Fixture.replay.actions.map(({ type, actor, point }) => ({ type, actor, ...(point ? { point } : {}) }));
const v3Actors = Object.fromEntries(v3Fixture.replay.config.players.map(player => [player, { kind: "human" }]));
v3Actors.WHITE = { kind: "ai", strategy: "multiplayer", modelId: "multiplayer-hard-v1" };
const v3Context = { source: "local", actors: v3Actors, mixedProfiles: false,
  // Deliberately inconsistent input: the sanitizer must bind this field to
  // replay.config.hintEnabled instead of hint/undo activity.
  hintsEnabled: true, undo: { enabled: true, maxCount: 3, usedCount: 1 } };
const normalizedV3 = normalizeContributionV3Context(v3Settings, v3Context);
assert.equal(normalizedV3.hintsEnabled, false); assert.deepEqual(normalizedV3.actors.WHITE,
  { kind: "ai", profile: "multiplayer-hard-v1" });
assert.equal(normalizedV3.undo.usedCount, 1);
assert.equal(supportsContributionActors(v3Actors, v3Settings), true);
assert.equal(supportsContributionActors({ ...v3Actors, WHITE: { kind: "ai", strategy: "multiplayer", modelId: "multiplayer-medium-v1" } }, v3Settings), false,
  "7-15 seats must reject unsupported medium/ultimate profiles");
let v3Body = null;
const v3Client = new TrainingContribution({ storage: { getItem: () => null, setItem: () => {} }, fetcher: async (_url, options) => {
  v3Body = JSON.parse(options.body); const verified = await validateContribution(v3Body);
  return { ok: true, json: async () => ({ status: "awaiting_review", game_id: verified.game_id }) };
} });
assert.equal(await v3Client.enqueue(v3Settings, v3Actions.slice(0, 1), v3Context), false, "incomplete v3 games stay local");
assert.equal(await v3Client.enqueue(v3Settings, v3Actions, v3Context), true);
assert.equal(v3Client.queue[0].payload.version, 3); assert.equal(v3Client.queue[0].payload.consent_policy, CONTRIBUTION_POLICY);
assert.deepEqual(v3Client.queue[0].payload.context, normalizedV3);
await v3Client.flush(); assert.equal(v3Body.version, 3); assert.equal(v3Client.queue.length, 0);
await assert.rejects(validateContribution({ ...payload, consent: false }));
await assert.rejects(validateContribution({ ...payload, replay: { ...payload.replay, terminal: { ...payload.replay.terminal, winner: "FAKE" } } }));
// Revocation during an in-flight request must not recreate pending records.
let finish;
const raceValues = new Map(); const raceStorage = { getItem: (key) => raceValues.get(key), setItem: (key, value) => raceValues.set(key, value) };
const racing = new TrainingContribution({ storage: raceStorage, fetcher: () => new Promise((done) => { finish = done; }) });
racing.setEnabled(true); await racing.enqueue(payload.replay.config, payload.replay.actions, payload.context);
const inFlight = racing.flush(); racing.setEnabled(false);
finish({ ok: true, json: async () => ({ status: "awaiting_review", game_id: "a".repeat(64) }) }); await inFlight;
assert.equal(racing.queue.length, 0); assert.equal(racing.lastReceipt, null); assert.equal(racing.status, "off");

const root = process.argv[2] ? resolve(process.argv[2]) : await mkdtemp(resolve(tmpdir(), "lifeline-contribution-"));
await mkdir(root, { recursive: true }); const inbox = resolve(root, "inbox"); await mkdir(inbox);
const approved = []; const claimed = new Map();
for (let seed = 1; seed <= 20; seed++) {
  const item = await syntheticContribution(seed, seed <= 10 ? 5 : 6); const verified = await validateContribution(item);
  if (claimed.has(verified.game_id)) continue;
  claimed.set(verified.game_id, item);
  approved.push(verified.game_id);
  await writeFile(resolve(inbox, `${verified.game_id}.json`), JSON.stringify({ ...verified, context: item.context, consent_policy: item.consent_policy, status: "awaiting_review" }));
}
const reviews = { policy: "human-review-v1", approved_game_ids: approved };
await writeFile(resolve(root, "reviews.json"), JSON.stringify(reviews));
const empty = await curate(inbox, { ...reviews, approved_game_ids: [] }, resolve(root, "unreviewed")); assert.equal(empty.samples, 0);
const manifest = await curate(inbox, reviews, resolve(root, "dataset"));
assert.ok(manifest.train_games > 0 && manifest.validation_games > 0);
const rows = (await readFile(resolve(root, "dataset/samples.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
assert.ok(rows.every((row) => row.player === "BLACK" && row.legal.includes(row.action)));
assert.ok(rows.some((row) => row.action === row.board_size * (row.board_size + 1) / 2));
const splitById = new Map(); for (const row of rows) { assert.ok(!splitById.has(row.game_id) || splitById.get(row.game_id) === row.split); splitById.set(row.game_id, row.split); }
assert.ok(rows.every((row) => row.features.length === row.board_size * (row.board_size + 1) / 2 * 11));
// Approved but assisted records still fail selection.
const assisted = structuredClone(claimed.values().next().value); assisted.context.hintsEnabled = true;
const safe = await validateContribution(assisted); const assistedInbox = resolve(root, "assisted"); await mkdir(assistedInbox);
await writeFile(resolve(assistedInbox, `${safe.game_id}.json`), JSON.stringify({ ...safe, context: assisted.context, consent_policy: assisted.consent_policy }));
const filtered = await curate(assistedInbox, { policy: "human-review-v1", approved_game_ids: [safe.game_id] }, resolve(root, "filtered")); assert.equal(filtered.samples, 0);
const bots = structuredClone(claimed.values().next().value);
bots.context.actors.BLACK = { kind: "ai", strategy: "minimax", depth: 1 };
const botRecord = await validateContribution(bots); const botInbox = resolve(root, "ai-duel"); await mkdir(botInbox);
await writeFile(resolve(botInbox, `${botRecord.game_id}.json`), JSON.stringify({ ...botRecord, context: bots.context, consent_policy: bots.consent_policy }));
const excluded = await curate(botInbox, { policy: "human-review-v1", approved_game_ids: [botRecord.game_id] }, resolve(root, "bot-filtered"));
assert.equal(excluded.samples, 0); assert.equal(excluded.decisions[0].reason, "no_human");
process.stdout.write(JSON.stringify({ status: "PASS", synthetic_only: true, completed_games: manifest.games, train_games: manifest.train_games, validation_games: manifest.validation_games, samples: rows.length, consent_off_zero_requests: true, retry_restore: true, revoked_inflight: true, legacy_queue_migrated: true, legacy_opt_out_preserved: true, v3_15_player_verified: true, bot_moves_excluded: true, pass_verified: true, grouped_split: true, output: root }) + "\n");
