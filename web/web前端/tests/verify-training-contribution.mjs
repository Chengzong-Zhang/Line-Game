import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { TrainingContribution, CONTRIBUTION_STORAGE } from "../TrainingContribution.js";
import { validateContribution } from "../../tools/validate_contribution.mjs";
import { curate } from "../../tools/curate_web_replays.mjs";
import { syntheticContribution } from "./fixtures/create-training-fixture.mjs";

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
assert.equal(client.enabled, false);
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
await assert.rejects(validateContribution({ ...payload, consent: false }));
await assert.rejects(validateContribution({ ...payload, replay: { ...payload.replay, terminal: { ...payload.replay.terminal, winner: "FAKE" } } }));
// Revocation during an in-flight request must not recreate pending records.
let finish;
const racing = new TrainingContribution({ storage, fetcher: () => new Promise((done) => { finish = done; }) });
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
process.stdout.write(JSON.stringify({ status: "PASS", synthetic_only: true, completed_games: manifest.games, train_games: manifest.train_games, validation_games: manifest.validation_games, samples: rows.length, consent_off_zero_requests: true, retry_restore: true, revoked_inflight: true, bot_moves_excluded: true, pass_verified: true, grouped_split: true, output: root }) + "\n");
