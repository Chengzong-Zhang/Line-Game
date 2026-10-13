import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { canonicalize, createReplayDocument, validateReplayDocument } from "../ReplayCodec.js";

const settings = {
  gridSize: 6,
  playerCount: 2,
  startPlayer: "BLACK",
  rulesVersion: "territory-v2",
  turnTimerEnabled: false,
  turnTimeLimitSeconds: 60,
  hintEnabled: false,
  hintMaxCount: 0,
};
const actions = [
  { type: "move", player: "BLACK", point: [1, 0] },
  { type: "skip", player: "WHITE", point: null },
];

const document = await createReplayDocument(settings, actions);
assert.equal(document.format, "lifeline-replay");
assert.equal(document.schemaVersion, 1);
assert.equal(document.actions.length, 2);

const verified = await validateReplayDocument(document);
assert.equal(verified.success, true);
assert.deepEqual(verified.actions, [
  { type: "player_move", point: [1, 0] },
  { type: "player_skip" },
]);

const tampered = structuredClone(document);
tampered.actions[1].point = [99, 99];
const rejected = await validateReplayDocument(tampered);
assert.equal(rejected.success, false);
assert.match(rejected.reason, /哈希|格式|动作/);

const fixturePath = fileURLToPath(new URL("./fixtures/replay-valid.json", import.meta.url));
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
const fixtureResult = await validateReplayDocument(fixture);
assert.equal(fixtureResult.success, true);
assert.equal(fixtureResult.eventCount, 2);

const cutFixture = JSON.parse(await readFile(fileURLToPath(new URL("./fixtures/replay-cut-case.json", import.meta.url)), "utf8"));
const cutResult = await validateReplayDocument(cutFixture);
assert.equal(cutResult.success, true);
assert.deepEqual(cutFixture.actions[2].effects.capturedPoints, [[4, 1], [2, 3]]);

const territoryFixture = JSON.parse(await readFile(fileURLToPath(new URL("./fixtures/replay-territory-case.json", import.meta.url)), "utf8"));
const territoryResult = await validateReplayDocument(territoryFixture);
assert.equal(territoryResult.success, true);
assert.equal(territoryFixture.actions[2].effects.territoryDelta.BLACK, 10);
assert.deepEqual(territoryFixture.actions[2].effects.addedEdgesByPlayer.BLACK, ["0,0|0,3", "3,0|0,3"]);

const hash = (value) => `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
function rehash(replay) {
  for (let i = 0; i < replay.actions.length; i++) {
    const event = replay.actions[i];
    if (i) event.prevEventHash = replay.actions[i - 1].eventHash;
    const { eventHash, ...body } = event;
    event.eventHash = hash(body);
  }
  replay.integrity.finalEventHash = replay.actions.at(-1)?.eventHash ?? null;
  replay.integrity.canonicalDocumentHash = hash({ ...replay, integrity: { ...replay.integrity, canonicalDocumentHash: null } });
  return replay;
}
assert.equal((await validateReplayDocument(rehash(structuredClone(document)))).success, true, "rehashing a valid replay must remain valid");
const falseActor = structuredClone(document);
falseActor.actions[0].actor = "WHITE";
assert.equal((await validateReplayDocument(rehash(falseActor))).success, false, "rehashed false actor must be rejected");
const falseEffects = structuredClone(document);
falseEffects.actions[0].effects.capturedPoints = [[5, 0]];
assert.equal((await validateReplayDocument(rehash(falseEffects))).success, false, "rehashed false captures must be rejected");
const complete = await createReplayDocument(settings, [{ type: "skip" }, { type: "skip" }]);
assert.equal((await validateReplayDocument(complete)).success, true);
const falseTerminal = structuredClone(complete);
falseTerminal.terminal.winner = "FAKE";
falseTerminal.terminal.scores = { BLACK: { area: 999999 } };
assert.equal((await validateReplayDocument(rehash(falseTerminal))).success, false, "rehashed false winner and scores must be rejected");
const missingTerminal = structuredClone(complete);
missingTerminal.terminal = null;
assert.equal((await validateReplayDocument(rehash(missingTerminal))).success, false);
console.log("verify-replay-codec: PASS (rule replay rejects rehashed actors, effects and terminal summaries)");
