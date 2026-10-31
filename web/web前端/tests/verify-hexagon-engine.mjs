import assert from "node:assert/strict";
import {
  GameEngine, Player, PLAYER_ORDER, PointState, TerritoryRulesVersion,
  getBoardVertices, getBoardPositions, isBoardPoint,
} from "../GameEngine.js";
import { MinimaxAI, saveState, restoreState } from "../AIEngine.js";

const key = (point) => point.join(",");
const create = (playerCount = 6, gridSize = 5) => new GameEngine({
  gridSize, playerCount, rulesVersion: TerritoryRulesVersion.V2,
});
// Independent cube-coordinate rotation oracle; the third coordinate is -q-r.
function rotate([x, y], radius, count) {
  let cube = [x - radius, y - radius, 2 * radius - x - y];
  for (let index = 0; index < (count + 6) % 6; index += 1) {
    cube = [-cube[1], -cube[2], -cube[0]];
  }
  return [cube[0] + radius, cube[1] + radius];
}

for (const count of [2, 3, 4, 5, 6]) {
  for (const size of [5, 9, 15]) {
    const game = create(count, size);
    const r = size - 1;
    const expectedCount = count >= 4 ? 3 * r * (r + 1) + 1 : size * (size + 1) / 2;
    assert.equal(game.validPositions.length, expectedCount);
    assert.deepEqual(game.validPositions, getBoardPositions(size, count));
    assert.deepEqual(game.boardVertices, getBoardVertices(size, count));
    assert.equal(game._boundaryIdxs.length, count >= 4 ? 6 * r : 3 * r);
    const snapshot = game.getSnapshot();
    const extent = count >= 4 ? 2 * r + 1 : size;
    assert.equal(snapshot.boardMatrix.length, extent);
    assert.equal(snapshot.boardShape, count >= 4 ? "hexagon" : "triangle");
    assert.equal(snapshot.boardMatrix.flat().filter((value) => value !== null).length, expectedCount);
    assert.equal(snapshot.boardMatrix.flat().filter((value) => value > 0).length, count);
    game.validPositions.forEach((point, index) => {
      assert.equal(game._pointToIndex(point), index);
      assert.equal(isBoardPoint(point, size, count), true);
    });
    for (const point of [[-1, r], [r, -1], [extent, r], [r, extent], [0.5, r], [NaN, r]]) {
      assert.equal(game._pointToIndex(point), -1);
    }
    if (count >= 4) {
      const seatIndices = count === 4 ? [0, 1, 3, 4] : [0, 1, 2, 3, 4, 5].slice(0, count);
      assert.deepEqual(
        game.activePlayers.map((player) => game.initialPositions[player]),
        seatIndices.map((index) => game.boardVertices[index]),
      );
      // Every edge has the same Euclidean length in the existing axial rendering.
      for (let index = 0; index < 6; index += 1) {
        const a = game.boardVertices[index];
        const b = game.boardVertices[(index + 1) % 6];
        const dx = a[0] - b[0];
        const dy = a[1] - b[1];
        assert.equal(dx * dx + dx * dy + dy * dy, r * r);
      }
    }
  }
}

for (const playerCount of [4, 5, 6]) {
  const game = create(playerCount);
  // One legal move per seat keeps the six-color state/turn path realistic.
  for (const player of game.activePlayers) {
    assert.equal(game.currentPlayer, player);
    const legal = game.getLegalMoves();
    assert.ok(legal.length);
    assert.equal(game.playMove(legal[0].point).success, true);
  }
  assert.equal(game.currentPlayer, Player.BLACK);
  assert.equal(game.turnCount, playerCount);
  const beforeInvalid = saveState(game);
  assert.equal(game.playMove([0, 0]).success, false);
  assert.deepEqual(saveState(game), beforeInvalid);
  for (let index = 0; index < playerCount; index += 1) {
    assert.equal(game.skipTurn().success, true);
    assert.equal(game.gameOver, index === playerCount - 1);
  }
  assert.equal(game.playMove([4, 4]).reason, "GAME_OVER");

  const resignation = create(playerCount);
  const lastPlayer = resignation.activePlayers.at(-1);
  for (const player of resignation.activePlayers.slice(0, -1)) {
    assert.equal(resignation.resignPlayer(player).success, true);
  }
  assert.equal(resignation.gameOver, true);
  assert.equal(resignation.getWinner(), lastPlayer);

  const reduced = create(playerCount);
  reduced.resignPlayer(Player.WHITE);
  for (let index = 0; index < playerCount - 1; index += 1) {
    assert.notEqual(reduced.currentPlayer, Player.WHITE);
    reduced.skipTurn();
    assert.equal(reduced.gameOver, index === playerCount - 2);
  }
}

const flood = create();
const boundary = flood._boundaryIdxs.map((index) => flood.validPositions[index]);
assert.equal(flood._getCoveredPoints(boundary).size, 61);
// Opening any of the six sides must admit the exterior flood. A three-side
// boundary implementation misses openings on the lower/right hexagon sides.
for (let side = 0; side < 6; side += 1) {
  const opening = rotate([6, 0], 4, side);
  const wall = boundary.filter((point) => key(point) !== key(opening));
  const covered = flood._getCoveredPoints(wall);
  assert.equal(covered.size, boundary.length - 1, `flood opening at side ${side + 1}`);
  assert.equal(covered.has("4,4"), false);
}

const topRing = [[5, 1], [4, 2], [3, 2], [3, 1], [4, 0], [5, 0]];
for (let vertex = 0; vertex < 6; vertex += 1) {
  const game = create();
  const player = game.activePlayers[vertex];
  const ring = topRing.map((point) => rotate(point, 4, vertex));
  for (const point of ring) game._setState(point, game._getPlayerStates(player).node);
  assert.equal(game._hasBoundaryCycle(ring), true);
  assert.equal(game._getCoveredPoints(ring).size, 7);
  const territory = game._computeTerritory(player);
  assert.equal(territory.area, 7, `closed territory at vertex ${vertex + 1}`);
  assert.equal(territory.displayArea, 6);
  assert.ok(territory.polygon.every((point) => game.isValidPosition(point)));
  assert.equal(game._getCoveredPoints(territory.polygon).size, 7);
}

// Full six-seat rotation/reflection equivariance on an asymmetric real prefix.
const original = create();
const prefix = [];
for (let index = 0; index < 16 && !original.gameOver; index += 1) {
  const moves = original.getLegalMoves();
  const point = moves[(index * 7 + 2) % moves.length].point;
  prefix.push({ player: original.currentPlayer, point });
  assert.equal(original.playMove(point).success, true);
}
for (const reflected of [false, true]) {
  for (let rotation = 0; rotation < 6; rotation += 1) {
    const transform = (point) => {
      const p = rotate(point, 4, rotation);
      return reflected ? [8 - p[0], p[0] + p[1] - 4] : p;
    };
    const vertices = getBoardVertices(5, 6);
    const playerMap = Object.fromEntries(PLAYER_ORDER.map((player, index) => [
      player, PLAYER_ORDER[vertices.findIndex((point) => key(point) === key(transform(vertices[index])))],
    ]));
    const transformed = create();
    for (const action of prefix) {
      // Reflections reverse the seat orientation; set the acting seat while
      // keeping the same rule-legal geometric prefix to compare score symmetry.
      transformed.currentPlayer = playerMap[action.player];
      assert.equal(transformed.playMove(transform(action.point)).success, true);
    }
    for (const player of PLAYER_ORDER) {
      assert.equal(
        transformed._computeTerritory(playerMap[player]).area,
        original._computeTerritory(player).area,
        `${player}: rotation ${rotation}, reflection ${reflected}`,
      );
    }
  }
}

// Cut a base-connected line and verify every color's detached pieces disappear.
// The fixture rotates through ORANGE_LINE=10 and CYAN_LINE=12 as well.
for (let rotation = 0; rotation < 6; rotation += 1) {
  const game = create();
  const victim = PLAYER_ORDER[(5 + rotation) % 6];
  const attacker = PLAYER_ORDER[(4 + rotation) % 6];
  const map = (point) => rotate(point, 4, rotation);
  const addEdge = (player, start, end) => {
    const states = game._getPlayerStates(player);
    for (const point of game.getLinePoints(map(start), map(end))) game._setState(point, states.line);
    game._setState(map(start), states.node);
    game._setState(map(end), states.node);
    game.edges[player].add(game._edgeKey(map(start), map(end)));
  };
  addEdge(victim, [0, 4], [4, 4]);
  addEdge(attacker, [0, 8], [2, 6]);
  game.currentPlayer = attacker;
  game.historyHashes = new Set([game._computeStateHash(attacker)]);
  const attackPoint = map([2, 4]);
  const move = game.getLegalMoves().find((candidate) => key(candidate.point) === key(attackPoint));
  assert.equal(move?.isAttack, true);
  assert.equal(game.playMove(attackPoint).success, true);
  assert.equal(game.getStateAt(attackPoint), game._getPlayerStates(attacker).node);
  assert.equal(game.getStateAt(map([4, 4])), PointState.EMPTY);
  assert.equal(game.getStateAt(game.initialPositions[victim]), game._getPlayerStates(victim).node);
  assert.equal(game.edges[victim].size, 0);
}

const aiGame = create();
aiGame.currentPlayer = Player.CYAN;
assert.equal(aiGame.playMove(aiGame.getLegalMoves()[0].point).success, true);
aiGame.currentPlayer = Player.CYAN;
const beforeAI = saveState(aiGame);
const publicBeforeAI = aiGame.getSnapshot();
const choices = new MinimaxAI(1).getTopMoves(aiGame, Player.CYAN, 3);
assert.ok(choices.length);
assert.deepEqual(saveState(aiGame), beforeAI);
assert.deepEqual(aiGame.getSnapshot(), publicBeforeAI);
for (const { point } of choices) assert.equal(aiGame._evaluateMove(point, Player.CYAN).legal, true);
aiGame.edges[Player.CYAN].clear();
restoreState(aiGame, beforeAI);
assert.deepEqual(saveState(aiGame), beforeAI);

// A prospective state already in history must be rejected without losing
// any of the six players' edges, even though current board state differs.
const superko = create();
superko.currentPlayer = Player.CYAN;
const point = superko.getLegalMoves()[0].point;
const initial = saveState(superko);
assert.equal(superko.playMove(point).success, true);
const futureHash = [...superko.historyHashes].at(-1);
restoreState(superko, initial);
superko.historyHashes.add(futureHash);
const banned = saveState(superko);
assert.equal(superko.playMove(point).reason, "SUPERKO_VIOLATION");
assert.deepEqual(saveState(superko), banned);

console.log(JSON.stringify({
  status: "PASS", playerCounts: [2, 3, 4, 5, 6], sideLengths: [5, 9, 15],
  coverage: ["vertices", "regular hex geometry", "six-side flood", "D6 territory symmetry",
    "turns", "skips", "resignation", "all-color cuts", "AI state preservation", "Superko"],
}));
