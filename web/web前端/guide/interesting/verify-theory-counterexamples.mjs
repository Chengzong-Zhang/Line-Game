import fs from "node:fs/promises";

const engineUrl = new URL("../../GameEngine.js", import.meta.url);
const source = await fs.readFile(engineUrl, "utf8");
const { GameEngine, Player, PointState } = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
);

const B = Player.BLACK;
const W = Player.WHITE;
const theta = ([x, y], n) => [n - 1 - x - y, y];
const swapPlayer = (player) => ({ [B]: W, [W]: B })[player];
const swapState = (state) => ({
  [PointState.EMPTY]: PointState.EMPTY,
  [PointState.BLACK_NODE]: PointState.WHITE_NODE,
  [PointState.BLACK_LINE]: PointState.WHITE_LINE,
  [PointState.WHITE_NODE]: PointState.BLACK_NODE,
  [PointState.WHITE_LINE]: PointState.BLACK_LINE,
})[state];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function areas(game) {
  return Object.fromEntries(
    [B, W].map((player) => [player, game.cachedTerritories[player].area]),
  );
}

function playMoves(game, moves, label) {
  moves.forEach((point, index) => {
    const result = game.playMove(point);
    assert(result.success, `${label}: move ${index + 1} ${point} failed: ${result.reason}`);
  });
}

function finishByPasses(game, label) {
  assert(game.skipTurn().success, `${label}: first Pass failed`);
  assert(game.skipTurn().success, `${label}: second Pass failed`);
  assert(game.gameOver, `${label}: two Passes did not end the game`);
}

function reflectEdgeKey(edgeKey, n) {
  const reflected = edgeKey.split("|").map((key) => {
    const point = key.split(",").map(Number);
    return theta(point, n).join(",");
  });
  reflected.sort();
  return reflected.join("|");
}

function reflectHash(hash, n) {
  const [nextPlayer, resignedPlayers, gridEntries, edgeLists] = JSON.parse(hash);
  const reflectedGrid = gridEntries
    .map(([x, y, state]) => [...theta([x, y], n), swapState(state)])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const reflectedEdges = [
    edgeLists[1].map((edge) => reflectEdgeKey(edge, n)).sort(),
    edgeLists[0].map((edge) => reflectEdgeKey(edge, n)).sort(),
  ];
  const reflectedResigned = resignedPlayers.map(swapPlayer).sort(
    (a, b) => [B, W].indexOf(a) - [B, W].indexOf(b),
  );
  return JSON.stringify([
    swapPlayer(nextPlayer),
    reflectedResigned,
    reflectedGrid,
    reflectedEdges,
  ]);
}

function territoryAreasAcrossContourRepresentations(game, player) {
  const contour = game._getOuterContour(player);
  const savedOuterContour = game._getOuterContour;
  const areasByRepresentation = [];
  try {
    for (const oriented of [contour, [...contour].reverse()]) {
      for (let offset = 0; offset < contour.length; offset += 1) {
        const representation = [
          ...oriented.slice(offset),
          ...oriented.slice(0, offset),
        ];
        game._getOuterContour = () => representation.map((point) => [...point]);
        areasByRepresentation.push(game._computeTerritory(player).area);
      }
    }
  } finally {
    game._getOuterContour = savedOuterContour;
  }
  return {
    contourLength: contour.length,
    initialArea: game._getCoveredPoints(contour).size,
    counts: Object.fromEntries(
      [...new Set(areasByRepresentation)]
        .sort((a, b) => a - b)
        .map((area) => [area, areasByRepresentation.filter((value) => value === area).length]),
    ),
  };
}

const symmetryMoves = [
  [1, 0], [5, 1], [4, 0], [2, 1], [0, 5],
  [2, 3], [1, 2], [1, 4], [0, 3], [0, 4],
];

const original = new GameEngine({ gridSize: 7, playerCount: 2, startPlayer: B });
playMoves(original, symmetryMoves, "original symmetry counterexample");
assert(JSON.stringify(areas(original)) === JSON.stringify({ [B]: 10, [W]: 10 }), "unexpected original areas");
assert(original.currentPlayer === B, "original should have BLACK to Pass first");

const mirroredMoves = symmetryMoves.map((point) => theta(point, 7));
const mirrored = new GameEngine({ gridSize: 7, playerCount: 2, startPlayer: W });
playMoves(mirrored, mirroredMoves, "mirrored symmetry counterexample");
assert(JSON.stringify(areas(mirrored)) === JSON.stringify({ [B]: 11, [W]: 10 }), "unexpected mirrored areas");
assert(mirrored.currentPlayer === W, "mirror should have WHITE to Pass first");

for (const point of original.validPositions) {
  assert(
    swapState(original.getStateAt(point)) === mirrored.getStateAt(theta(point, 7)),
    `mirrored physical state differs at ${point}`,
  );
}
for (const [sourcePlayer, targetPlayer] of [[B, W], [W, B]]) {
  const reflectedEdges = [...original.edges[sourcePlayer]]
    .map((edge) => reflectEdgeKey(edge, 7))
    .sort();
  assert(
    JSON.stringify(reflectedEdges) === JSON.stringify([...mirrored.edges[targetPlayer]].sort()),
    `mirrored ${sourcePlayer} edge set differs`,
  );
}
const reflectedHistory = [...original.historyHashes].map((hash) => reflectHash(hash, 7)).sort();
assert(
  JSON.stringify(reflectedHistory) === JSON.stringify([...mirrored.historyHashes].sort()),
  "mirrored Superko history differs",
);
const blackContourBasins = territoryAreasAcrossContourRepresentations(original, B);
const whiteContourBasins = territoryAreasAcrossContourRepresentations(original, W);
assert(
  JSON.stringify(whiteContourBasins) === JSON.stringify({
    contourLength: 15,
    initialArea: 9,
    counts: { 10: 11, 11: 19 },
  }),
  "expected the WHITE contour's 30 representations to split 11/19 between areas 10/11",
);
const symmetricScores = {
  playerBaseCanonical: {
    original: { [B]: areas(original)[B], [W]: areas(mirrored)[B] },
    mirrored: { [B]: areas(mirrored)[B], [W]: areas(original)[B] },
  },
  bidirectionalMinimum: {
    original: {
      [B]: Math.min(areas(original)[B], areas(mirrored)[W]),
      [W]: Math.min(areas(original)[W], areas(mirrored)[B]),
    },
    mirrored: {
      [B]: Math.min(areas(mirrored)[B], areas(original)[W]),
      [W]: Math.min(areas(mirrored)[W], areas(original)[B]),
    },
  },
  orbitSum: {
    original: {
      [B]: areas(original)[B] + areas(mirrored)[W],
      [W]: areas(original)[W] + areas(mirrored)[B],
    },
    mirrored: {
      [B]: areas(mirrored)[B] + areas(original)[W],
      [W]: areas(mirrored)[W] + areas(original)[B],
    },
  },
};
assert(
  JSON.stringify(symmetricScores) === JSON.stringify({
    playerBaseCanonical: {
      original: { [B]: 10, [W]: 11 },
      mirrored: { [B]: 11, [W]: 10 },
    },
    bidirectionalMinimum: {
      original: { [B]: 10, [W]: 10 },
      mirrored: { [B]: 10, [W]: 10 },
    },
    orbitSum: {
      original: { [B]: 20, [W]: 21 },
      mirrored: { [B]: 21, [W]: 20 },
    },
  }),
  "symmetrized scores did not exchange exactly",
);

finishByPasses(original, "original symmetry counterexample");
assert(original.getWinner() === "DRAW", "original should be DRAW");
finishByPasses(mirrored, "mirrored symmetry counterexample");
assert(mirrored.getWinner() === B, "mirrored state should be a BLACK win");

// The mirrored physical state is also reachable from the default BLACK-start
// game: BLACK first Passes, then the WHITE-start mirrored sequence is played.
const mirroredFromDefault = new GameEngine({ gridSize: 7, playerCount: 2 });
assert(mirroredFromDefault.skipTurn().success, "leading Pass failed");
playMoves(mirroredFromDefault, mirroredMoves, "default-start mirrored counterexample");
assert(JSON.stringify(areas(mirroredFromDefault)) === JSON.stringify({ [B]: 11, [W]: 10 }), "default-start mirror areas differ");
assert(mirroredFromDefault.currentPlayer === W && mirroredFromDefault.consecutiveSkips === 0, "unexpected default-start mirror turn state");
finishByPasses(mirroredFromDefault, "default-start mirrored counterexample");
assert(mirroredFromDefault.getWinner() === B, "default-start mirror should also be a BLACK win");

const pressurePrefix = [
  [1, 0], [2, 0], [1, 2], [2, 1],
  [0, 2], [1, 1], [0, 4], [1, 3],
];

function makePressureState() {
  const game = new GameEngine({ gridSize: 5, playerCount: 2 });
  playMoves(game, pressurePrefix, "Pass-pressure prefix");
  assert(game.skipTurn().success, "BLACK Pass in pressure prefix failed");
  return game;
}

const pressure = makePressureState();
assert(pressure.currentPlayer === W && pressure.consecutiveSkips === 1, "unexpected pressure decision state");
assert(JSON.stringify(areas(pressure)) === JSON.stringify({ [B]: 7, [W]: 8 }), "unexpected pressure areas");
assert(pressure.historyHashes.size === 9, "pressure state should have nine history keys");
assert(JSON.stringify(pressure.getLegalMoves().map((move) => move.point)) === JSON.stringify([[0, 3]]), "WHITE should have one legal placement");

const pressurePass = makePressureState();
assert(pressurePass.skipTurn().success && pressurePass.getWinner() === W, "WHITE Pass should win");

function makeAfterPressurePlace() {
  const game = makePressureState();
  assert(game.playMove([0, 3]).success, "WHITE's only placement failed");
  return game;
}

const pressureBlackPass = makeAfterPressurePlace();
assert(pressureBlackPass.skipTurn().success, "BLACK Pass after WHITE's only placement failed");
assert(pressureBlackPass.gameOver && pressureBlackPass.getWinner() === W, "BLACK Pass should auto-skip WHITE and let WHITE win");

const pressureBlackResign = makeAfterPressurePlace();
assert(pressureBlackResign.resignPlayer().success, "BLACK Resign failed");
assert(pressureBlackResign.getWinner() === W, "BLACK Resign should let WHITE win");

const pressurePlace = makeAfterPressurePlace();
assert(JSON.stringify(pressurePlace.getLegalMoves().map((move) => move.point)) === JSON.stringify([[2, 2]]), "BLACK should have one legal placement");
assert(pressurePlace.playMove([2, 2]).success, "BLACK reply failed");
assert(pressurePlace.currentPlayer === B && pressurePlace.consecutiveSkips === 1, "WHITE should have auto-passed");
assert(JSON.stringify(areas(pressurePlace)) === JSON.stringify({ [B]: 6, [W]: 5 }), "unexpected post-reply areas");
assert(pressurePlace.skipTurn().success && pressurePlace.getWinner() === B, "BLACK Pass should finish a BLACK win");

function makeTempoPrefix() {
  const game = new GameEngine({ gridSize: 7, playerCount: 2 });
  playMoves(game, [[1, 0], [2, 4], [1, 3], [4, 0]], "tempo/Col witness prefix");
  return game;
}

const tempo = makeTempoPrefix();
assert(JSON.stringify(areas(tempo)) === JSON.stringify({ [B]: 5, [W]: 8 }), "unexpected tempo prefix areas");
const u = [0, 4];
const v = [1, 4];
for (const player of [B, W]) {
  assert(tempo._evaluateMove(u, player).legal, `u should be legal for ${player}`);
  assert(tempo._evaluateMove(v, player).legal, `v should be legal for ${player}`);
}

const tempoBlackPass = makeTempoPrefix();
finishByPasses(tempoBlackPass, "BLACK Pass in tempo witness");
assert(tempoBlackPass.getWinner() === W, "BLACK Pass should let WHITE win 8:5");

assert(tempo.playMove(u).success, "BLACK u in tempo witness failed");
assert(JSON.stringify(areas(tempo)) === JSON.stringify({ [B]: 9, [W]: 8 }), "unexpected areas after BLACK u");
assert(!tempo._evaluateMove(v, B).legal && tempo._evaluateMove(v, W).legal, "u should forbid same-color v only");

const tempoWhitePass = makeTempoPrefix();
assert(tempoWhitePass.playMove(u).success, "BLACK u in tempo Pass branch failed");
finishByPasses(tempoWhitePass, "WHITE Pass in tempo witness");
assert(tempoWhitePass.getWinner() === B, "WHITE Pass should let BLACK win 9:8");

assert(tempo.playMove(v).success, "WHITE v in tempo witness failed");
assert(JSON.stringify(areas(tempo)) === JSON.stringify({ [B]: 9, [W]: 11 }), "unexpected areas after WHITE v");

console.log(JSON.stringify({
  symmetryCounterexample: {
    original: { area: { [B]: 10, [W]: 10 }, winner: "DRAW" },
    mirrored: { area: { [B]: 11, [W]: 10 }, winner: B },
    fullThetaStateVerified: true,
    defaultBlackStartReachable: true,
    contourRepresentationBasins: {
      BLACK: blackContourBasins,
      WHITE: whiteContourBasins,
    },
    symmetricScores,
  },
  passPressure: {
    decision: { player: W, consecutiveSkips: 1, area: { [B]: 7, [W]: 8 }, legalPlacements: [[0, 3]] },
    passWinner: W,
    uniquePlaceReplyWinner: B,
    allImmediateBlackAlternativesChecked: true,
  },
  tempoAndColWitness: {
    prefixArea: { [B]: 5, [W]: 8 },
    afterBlackU: { [B]: 9, [W]: 8 },
    afterWhiteV: { [B]: 9, [W]: 11 },
    sameColorAdjacentMoveForbidden: true,
    oppositeColorAdjacentMoveAllowed: true,
    passPenaltyAtBothDecisionStates: true,
  },
}, null, 2));
