import assert from "node:assert/strict";
import { LOCAL_LAB_MODELS, localPlayerChoices, localPlayerProfile, normalizeLocalPlayers, normalizeLocalPlayerDraft, prepareLocalPlayersForNewMatch } from "../LocalAIModes.js";
import LocalPlayerSetup from "../LocalPlayerSetup.js";
import { getTexts } from "../OnlineAppI18n.js";
import { createLocalGameSession, loadLocalGameSession, persistLocalGameSession } from "../LocalGameSession.js";
import { roomPlayerProfile } from "../OnlineRoomSettings.js";

globalThis.Vue = {
  computed: (read) => ({ get value() { return read(); } }),
  ref: (value) => ({ value }),
};

assert.equal(LOCAL_LAB_MODELS.length, 17);
assert.deepEqual(LOCAL_LAB_MODELS.filter(({ choice }) => ["padded-cnn", "grid-gnn", "topology-gnn"].includes(choice)).length, 12);
assert.deepEqual(LOCAL_LAB_MODELS.filter(({ version }) => version === "legacy").length, 3);
assert.deepEqual(LOCAL_LAB_MODELS.slice(-5).map(({ choice }) => choice), ["dqn", "ppo", "sac", "gail", "gan"]);

const layouts = [
  [2, "triangle", ["human", "minimax"]],
  [2, "hexagon", ["human", "greedy"]],
  [3, "triangle", ["human", "ai-easy", "ai-medium", "ai-hard"]],
  [3, "hexagon", ["human", "ai-easy", "ai-hard"]],
  [4, "hexagon", ["human", "ai-easy", "ai-medium", "ai-hard"]],
  [4, "triangle", ["human", "ai-easy", "ai-hard"]],
  [15, "hexagon", ["human", "ai-easy", "ai-hard"]],
];
for (const [playerCount, boardShape, expected] of layouts) {
  assert.deepEqual(localPlayerChoices(playerCount, boardShape), expected);
  for (const language of ["zh", "en"]) {
    const props = { texts: getTexts(language), language, players: {}, playerCount, boardShape, gridSize: 7, startPlayer: "BLACK" };
    const setup = LocalPlayerSetup.setup(props);
    assert.deepEqual(setup.choices.value, expected);
    assert.ok(expected.every(setup.choiceAvailable));
    assert.equal(setup.choiceAvailable("ai-ultimate"), false);
    assert.equal(setup.choiceAvailable("topology-gnn"), false);
    assert.equal(setup.choiceAvailable("dqn"), false);
    assert.equal(setup.difficultyLabel(2), props.texts.aiDifficultyEasy);
    assert.equal(setup.difficultyLabel(4), props.texts.aiDifficultyHard);
    assert.equal(setup.labApplicable.value, playerCount === 2 && boardShape === "triangle");
  }
}

const transitions = [
  [{ BLACK: { choice: "minimax", depth: 2 }, WHITE: { choice: "minimax", depth: 3 } }, 3, "triangle", "ai-easy", "ai-medium"],
  [{ BLACK: { choice: "minimax", depth: 4 }, WHITE: { choice: "topology-gnn", version: "legacy" } }, 3, "triangle", "ai-hard", "ai-medium"],
  [{ BLACK: { choice: "three-player" }, WHITE: { choice: "ai-easy" } }, 4, "hexagon", "ai-medium", "ai-easy"],
  [{ BLACK: { choice: "three-player" }, WHITE: { choice: "ai-medium" } }, 7, "hexagon", "ai-hard", "ai-hard"],
  [{ BLACK: { choice: "ai-medium" }, WHITE: { choice: "ai-hard" } }, 3, "hexagon", "ai-hard", "ai-hard"],
  [{ BLACK: { choice: "hex-player" }, WHITE: { choice: "ai-medium" } }, 3, "triangle", "ai-medium", "ai-medium"],
  [{ BLACK: { choice: "hex-player" }, WHITE: { choice: "ai-medium" } }, 4, "triangle", "ai-easy", "ai-hard"],
];
for (const [before, count, shape, black, white] of transitions) {
  const draft = normalizeLocalPlayerDraft(before, count, shape);
  assert.deepEqual([draft.BLACK.choice, draft.WHITE.choice], [black, white]);
  assert.ok(localPlayerChoices(count, shape).includes(draft.BLACK.choice));
  assert.ok(localPlayerChoices(count, shape).includes(draft.WHITE.choice));
}
const backToTwo = normalizeLocalPlayerDraft({ BLACK: { choice: "ai-easy" }, WHITE: { choice: "ai-hard" } }, 2, "triangle");
assert.deepEqual([backToTwo.BLACK.choice, backToTwo.BLACK.depth, backToTwo.WHITE.choice, backToTwo.WHITE.depth],
  ["minimax", 2, "minimax", 4]);

const archived = {
  BLACK: { choice: "minimax", depth: 4 },
  WHITE: { choice: "topology-gnn", version: "legacy" },
};
const settings = { playerCount: 2, boardShape: "triangle", gridSize: 7, startPlayer: "BLACK", rulesVersion: "territory-v3" };
const storage = new Map();
const adapter = { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) };
assert.equal(persistLocalGameSession(createLocalGameSession(settings, [], { players: archived, started: true, paused: false }), adapter), true);
const restored = loadLocalGameSession(adapter);
assert.equal(restored.match.players.WHITE.choice, "topology-gnn");
assert.equal(restored.match.players.WHITE.version, "legacy");
assert.equal(localPlayerProfile(restored.match.players.WHITE, 2, 7, "triangle").modelId, "topology-gnn-d14-s20260825-g200");
const fresh = prepareLocalPlayersForNewMatch(restored.match.players, 2, "triangle");
assert.equal(fresh.WHITE.choice, "minimax", "Starting a new match after restoration uses a current difficulty");
assert.equal(fresh.WHITE.depth, 3);
const explicit = prepareLocalPlayersForNewMatch(restored.match.players, 2, "triangle", new Set(["WHITE"]));
assert.equal(explicit.WHITE.choice, "topology-gnn", "Explicit lab selection keeps its model for one new match");
assert.equal(explicit.WHITE.version, "legacy");
const props = { texts: getTexts("zh"), language: "zh", players: restored.match.players, playerCount: 2,
  boardShape: "triangle", gridSize: 7, startPlayer: "BLACK", activePlayers: restored.match.players, started: true };
const setup = LocalPlayerSetup.setup(props);
assert.equal(setup.choiceAvailable("topology-gnn"), false);
assert.match(setup.modelLabel(setup.sides.value[1]), /D14/);
assert.equal(setup.modelLabel({ choice: "minimax", depth: 3, version: "2026092201" }), "Minimax · AI 难度 3");
assert.equal(normalizeLocalPlayers(archived, 2, "triangle").WHITE.choice, "topology-gnn");
const selections = [];
const lab = LocalPlayerSetup.setup(props, { emit: (name, detail) => selections.push({ name, detail }) });
lab.labModelId.value = "grid-gnn:2026092202";
lab.chooseLabModel();
assert.deepEqual(selections, [{ name: "select-lab-model", detail: { color: "WHITE", patch: { choice: "grid-gnn", version: "2026092202" } } }]);
const unavailableLab = LocalPlayerSetup.setup({ ...props, boardShape: "hexagon" }, { emit: (name) => selections.push({ name }) });
unavailableLab.chooseLabModel();
assert.equal(selections.length, 1);

const archivedRoom = { playerCount: 3, boardShape: "triangle", gridSize: 7,
  players: { BLACK: { choice: "human" }, WHITE: { choice: "three-player", version: "three-player-policy-v2" },
    PURPLE: { choice: "ai-medium" } } };
const roomSetup = LocalPlayerSetup.setup({ ...props, ...archivedRoom, online: true });
assert.equal(roomSetup.sides.value[1].choice, "three-player");
assert.equal(roomSetup.choiceAvailable("three-player"), false);
assert.equal(roomPlayerProfile(roomSetup.sides.value[1], archivedRoom).modelId, "three-player-policy-v2");

console.log("verify-ai-menu-simplification: PASS (board choices, draft transitions, hidden candidates, saved match/room identity)");
