import assert from "node:assert/strict";
import { Player } from "../GameEngine.js";
import { ALL_PLAYERS, PLAYER_COUNT_OPTIONS, normalizeGameSettings } from "../OnlineAppState.js";
import { getTexts, formatPlayerName, formatWinner } from "../OnlineAppI18n.js";
import { localMatchActors, localAIPlayer, localMatchMode, localPlayerProfile, normalizeLocalPlayers } from "../LocalAIModes.js";
import LocalPlayerSetup from "../LocalPlayerSetup.js";

globalThis.Vue = {
  computed: (read) => ({ get value() { return read(); } }),
};
const { default: App } = await import("../OnlineApp.js");
assert.deepEqual(PLAYER_COUNT_OPTIONS, [2, 3, 4, 5, 6]);
assert.deepEqual(ALL_PLAYERS, ["BLACK", "WHITE", "PURPLE", "GREEN", "ORANGE", "CYAN"]);

const priorAISelection = Object.fromEntries(ALL_PLAYERS.map((player) => [player, { choice: "three-player" }]));
for (const count of [4, 5, 6]) {
  const active = ALL_PLAYERS.slice(0, count);
  for (const size of [5, 9, 15]) {
    const settings = normalizeGameSettings({ playerCount: count, gridSize: size, startPlayer: active.at(-1), botCount: 2 });
    assert.equal(settings.playerCount, count);
    assert.equal(settings.boardShape, "hexagon");
    assert.equal(settings.gridSize, size);
    assert.equal(settings.startPlayer, active.at(-1));
    assert.equal(settings.botCount, 2, "hexagon rooms allow multiple AI opponents");
    assert.equal(normalizeGameSettings({ playerCount: count, botCount: 99 }).botCount, count - 1, "online rooms retain at least one human seat");
  }
  const players = normalizeLocalPlayers(priorAISelection, count);
  assert.equal(localMatchMode(players, count), "none");
  const actors = localMatchActors(players, count);
  assert.deepEqual(Object.keys(actors), active, "saved actors must include every active seat");
  assert.ok(Object.values(actors).every(({ kind }) => kind === "human"));
  for (const player of active) assert.equal(localAIPlayer(priorAISelection, count, player), null);
  for (const aiSeat of active) {
    const oneAI = normalizeLocalPlayers({ [aiSeat]: { choice: "hex-player" } }, count);
    assert.equal(localMatchMode(oneAI, count), "mixed", `AI may control ${aiSeat}`);
    assert.equal(localAIPlayer(oneAI, count, aiSeat), aiSeat);
    assert.deepEqual(localPlayerProfile(oneAI[aiSeat], count), { strategy: "hex-player", modelId: "hex-player-policy-v1" });
    assert.equal(Object.values(localMatchActors(oneAI, count)).filter(({ kind }) => kind === "ai").length, 1);
  }
  const allAI = Object.fromEntries(active.map((color) => [color, { choice: "hex-player" }]));
  assert.equal(localMatchMode(allAI, count), "ai_duel");
  assert.ok(Object.values(localMatchActors(allAI, count)).every(({ strategy, modelId }) => strategy === "hex-player" && modelId === "hex-player-policy-v1"));
  for (const humanSeat of active) {
    const mixed = { ...allAI, [humanSeat]: { choice: "human" } };
    assert.equal(localMatchMode(mixed, count), "mixed");
    assert.equal(localAIPlayer(mixed, count, humanSeat), null);
    assert.equal(Object.values(localMatchActors(mixed, count)).filter(({ kind }) => kind === "ai").length, count - 1);
  }

  for (const language of ["zh", "en"]) {
    const texts = getTexts(language);
    const setup = LocalPlayerSetup.setup({ texts, players, playerCount: count });
    assert.deepEqual(setup.sides.value.map(({ color }) => color), active);
    assert.deepEqual(setup.sides.value.map(({ vertex }) => vertex), count === 4 ? [1, 2, 4, 5] : Array.from({ length: count }, (_, index) => index + 1));
    assert.deepEqual(setup.choices.value, ["human", "hex-player"]);
    assert.equal(typeof setup.choiceLabel("hex-player"), "string");
    assert.equal(typeof texts.aiModelDescriptions["hex-player"], "string");
    assert.ok(texts.roomBotOption(count, count - 1).includes("1"));
    assert.ok(setup.sides.value.every(({ name }) => typeof name === "string" && name.length));
    assert.ok(texts.boardGeometry(count).includes(language === "zh" ? "正六边形" : "hexagon"));

    const scores = Object.fromEntries(active.map((player, index) => [player, index + 2]));
    const gameState = { players: active, playerCount: count, scores, currentPlayer: active.at(-1), winner: active.at(-1) };
    const panel = App.components.ScorePanel.setup({ gameState, session: {}, roomPlayers: [], language, uiStyle: "casual" });
    assert.deepEqual(panel.scoreCards.value.map(({ value }) => value), active.map((_, index) => index + 2), "each seat must show its own score");
    assert.equal(new Set(panel.scoreCards.value.map(({ className }) => className)).size, count);
    assert.notEqual(panel.winnerLabel.value, texts.inProgress);
    for (const player of active) {
      assert.notEqual(formatPlayerName(player, language), texts.unassigned);
      assert.notEqual(formatWinner(player, language), texts.inProgress);
      assert.ok(formatPlayerName(player, language, "academic").length);
    }
  }
}

assert.equal(normalizeGameSettings({ playerCount: 3 }).boardShape, "triangle");
assert.equal(normalizeGameSettings({ playerCount: 2, startPlayer: Player.CYAN }).startPlayer, Player.BLACK);
assert.equal(localMatchMode({ BLACK: { choice: "minimax" } }, 2), "ai_black");
assert.equal(localMatchMode({ BLACK: { choice: "three-player" } }, 3), "mixed");
console.log("verify-hex-player-setup: PASS (4–6 seats, any human/AI seat, mixed/all AI, correct profiles, bot limits, vertices, bilingual names, scores/winners; two/three-player preserved)");
