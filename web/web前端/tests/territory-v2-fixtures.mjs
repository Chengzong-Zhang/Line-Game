function freezeMoves(moves) {
  return Object.freeze(moves.map((point) => Object.freeze([...point])));
}

function freezeFixture(fixture) {
  return Object.freeze({
    ...fixture,
    moves: freezeMoves(fixture.moves),
    expectedAreas: Object.freeze({ ...fixture.expectedAreas }),
    expectedPolygonKeys: Object.freeze({ ...fixture.expectedPolygonKeys }),
  });
}

const TWO_PLAYER_MIDGAME_MOVES = [
  [1, 0], [2, 0], [1, 5], [2, 4], [1, 7],
  [5, 0], [1, 4], [5, 2], [4, 4], [5, 3],
  [4, 0], [4, 2], [0, 8], [6, 0], [3, 3],
  [2, 2], [0, 2], [3, 4], [1, 2], [1, 6],
];

export const TERRITORY_V2_HOT_PATH_FIXTURES = Object.freeze([
  freezeFixture({
    name: "two-player-9-midgame",
    gridSize: 9,
    playerCount: 2,
    moves: TWO_PLAYER_MIDGAME_MOVES,
    expectedAreas: { BLACK: 26, WHITE: 18 },
    expectedPolygonKeys: {
      BLACK: "0,0|0,1|0,2|0,3|0,4|0,5|0,6|0,7|0,8|1,7|2,6|3,5|4,4|3,5|2,6|1,7|0,7|0,6|1,5|2,4|3,3|2,3|1,3|1,2|2,1|3,0|4,0|3,0|2,0|1,0",
      WHITE: "1,6|2,5|3,4|4,3|4,2|3,2|2,2|3,2|4,1|5,0|6,0|7,0|8,0|7,1|6,2|5,3|4,3|3,4|2,5",
    },
  }),
  freezeFixture({
    name: "two-player-15-midgame",
    gridSize: 15,
    playerCount: 2,
    moves: TWO_PLAYER_MIDGAME_MOVES,
    expectedAreas: { BLACK: 26, WHITE: 24 },
    expectedPolygonKeys: {
      BLACK: "0,0|0,1|0,2|0,3|0,4|0,5|0,6|0,7|0,8|1,7|2,6|3,5|4,4|3,5|2,6|1,7|0,7|0,6|1,5|2,4|3,3|2,3|1,3|1,2|2,1|3,0|4,0|3,0|2,0|1,0",
      WHITE: "1,6|2,5|3,4|4,3|4,2|3,2|2,2|3,2|4,1|5,0|6,0|7,0|8,0|9,0|10,0|11,0|12,0|13,0|14,0|13,0|12,0|11,0|10,0|9,0|8,0|7,1|6,2|5,3|4,3|3,4|2,5",
    },
  }),
  freezeFixture({
    name: "three-player-9-midgame",
    gridSize: 9,
    playerCount: 3,
    moves: [
      [4, 0], [2, 6], [7, 0], [0, 5], [2, 0], [3, 5],
      [1, 5], [1, 6], [2, 5], [2, 0], [2, 2], [1, 2],
      [4, 3], [1, 3], [5, 2], [4, 0], [3, 0], [2, 4],
    ],
    expectedAreas: { BLACK: 14, WHITE: 4, PURPLE: 23 },
    expectedPolygonKeys: {
      BLACK: "0,0|0,1|0,2|0,3|0,4|0,5|1,5|2,4|1,4|1,3|1,2|1,1|2,0|1,0",
      WHITE: "0,8|1,7|1,6|2,6|1,7",
      PURPLE: "2,2|3,1|3,0|4,0|5,0|6,0|7,0|8,0|7,1|6,2|5,3|4,4|3,5|2,5|3,4|3,3|3,2",
    },
  }),
  freezeFixture({
    name: "three-player-15-midgame",
    gridSize: 15,
    playerCount: 3,
    moves: [
      [4, 0], [2, 12], [13, 0], [0, 5], [2, 6],
      [9, 5], [1, 5], [1, 12], [8, 5], [2, 0],
      [2, 8], [11, 2], [4, 3], [1, 9], [9, 3],
    ],
    expectedAreas: { BLACK: 25, WHITE: 13, PURPLE: 13 },
    expectedPolygonKeys: {
      BLACK: "0,0|0,1|0,2|0,3|0,4|0,5|1,5|2,4|3,3|4,3|4,2|4,1|4,0|3,0|2,0|1,0",
      WHITE: "0,14|1,13|1,12|1,11|1,10|1,9|2,8|2,7|2,6|2,7|2,8|2,9|2,10|2,11|2,12|1,13",
      PURPLE: "10,3|11,2|12,1|13,0|14,0|13,1|12,2|11,3|10,4|9,5|8,5|9,4|9,3",
    },
  }),
]);
