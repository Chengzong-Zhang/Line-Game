export const TUTORIAL_LEVELS = Object.freeze([
  Object.freeze({
    id: "L1-connect",
    gridSize: 6,
    playerCount: 2,
    startPlayer: "BLACK",
    rulesVersion: "territory-v3",
    prefix: Object.freeze([
      Object.freeze({ type: "move", player: "BLACK", point: Object.freeze([1, 0]) }),
      Object.freeze({ type: "move", player: "WHITE", point: Object.freeze([4, 0]) }),
    ]),
    objective: Object.freeze({ type: "move", player: "BLACK", point: Object.freeze([3, 0]) }),
    focusEdges: Object.freeze([Object.freeze({ player: "BLACK", edge: "0,0|1,0" })]),
    titleZh: "第一关：连成第一条生命线",
    titleEn: "Lesson 1: Build your first lifeline",
    instructionZh: "先看蓝方 [1,0]、红方 [4,0] 各走一步。现在点 [3,0]，继续延长蓝方生命线。",
    instructionEn: "Blue has played [1,0] and Red [4,0]. Click [3,0] to extend Blue’s lifeline again.",
    successZh: "蓝方又接出一段生命线。",
    successEn: "Blue has extended its lifeline again.",
  }),
  Object.freeze({
    id: "L2-close-territory",
    gridSize: 6,
    playerCount: 2,
    startPlayer: "BLACK",
    rulesVersion: "territory-v3",
    prefix: Object.freeze([
      Object.freeze({ type: "move", player: "BLACK", point: Object.freeze([3, 0]) }),
      Object.freeze({ type: "skip", player: "WHITE" }),
    ]),
    objective: Object.freeze({ type: "move", player: "BLACK", point: Object.freeze([0, 3]) }),
    focusEdges: Object.freeze([
      Object.freeze({ player: "BLACK", edge: "0,0|3,0" }),
      Object.freeze({ player: "BLACK", edge: "0,0|0,3" }),
      Object.freeze({ player: "BLACK", edge: "0,3|3,0" }),
    ]),
    titleZh: "第二关：围出第一块领土",
    titleEn: "Lesson 2: Close your first territory",
    instructionZh: "蓝方已有一条边。点击高亮节点 [0,3]，新增两条连接，围出闭合领土。",
    instructionEn: "Blue has one edge. Click the highlighted node [0,3] to add two connections and close a territory.",
    successZh: "边界闭合了！只有闭合区域才会产生领土分数。",
    successEn: "The boundary is closed! Only closed regions produce territory score.",
  }),
  Object.freeze({
    id: "L3-cut-and-clear",
    gridSize: 6,
    playerCount: 2,
    startPlayer: "BLACK",
    rulesVersion: "territory-v3",
    prefix: Object.freeze([
      Object.freeze({ type: "move", player: "BLACK", point: Object.freeze([3, 0]) }),
      Object.freeze({ type: "move", player: "WHITE", point: Object.freeze([2, 3]) }),
      Object.freeze({ type: "skip", player: "BLACK" }),
      Object.freeze({ type: "move", player: "WHITE", point: Object.freeze([1, 4]) }),
    ]),
    objective: Object.freeze({ type: "move", player: "BLACK", point: Object.freeze([3, 2]) }),
    focusEdges: Object.freeze([
      Object.freeze({ player: "WHITE", edge: "2,3|5,0" }),
      Object.freeze({ player: "WHITE", edge: "1,4|5,0" }),
      Object.freeze({ player: "WHITE", edge: "1,4|2,3" }),
    ]),
    titleZh: "第三关：切断补给线",
    titleEn: "Lesson 3: Cut the supply line",
    instructionZh: "红方线后面还有两个节点。点高亮处 [3,2] 切断，后面的红点和线会全部清掉。",
    instructionEn: "Red has two nodes behind this line. Cut at [3,2]; every disconnected Red node and line will disappear.",
    successZh: "切断成功：红方后面的节点和线都清掉了。",
    successEn: "Cut complete: the Red nodes and lines behind it are gone.",
  }),
  Object.freeze({
    id: "L4-three-point-limit",
    gridSize: 6,
    playerCount: 2,
    startPlayer: "BLACK",
    rulesVersion: "territory-v3",
    prefix: Object.freeze([
      Object.freeze({ type: "move", player: "BLACK", point: Object.freeze([0, 3]) }),
      Object.freeze({ type: "move", player: "WHITE", point: Object.freeze([4, 1]) }),
      Object.freeze({ type: "move", player: "BLACK", point: Object.freeze([1, 2]) }),
      Object.freeze({ type: "move", player: "WHITE", point: Object.freeze([1, 1]) }),
    ]),
    restriction: Object.freeze({ point: Object.freeze([2, 2]) }),
    objective: Object.freeze({ type: "move", player: "BLACK", point: Object.freeze([2, 1]) }),
    focusEdges: Object.freeze([
      Object.freeze({ player: "BLACK", edge: "0,0|0,3" }),
      Object.freeze({ player: "BLACK", edge: "0,3|1,2" }),
    ]),
    allowedFocusEdges: Object.freeze([
      Object.freeze({ player: "BLACK", edge: "0,0|0,3" }),
      Object.freeze({ player: "BLACK", edge: "0,3|1,2" }),
      Object.freeze({ player: "WHITE", edge: "1,1|4,1" }),
    ]),
    titleZh: "第四关：认识三点限制",
    titleEn: "Lesson 4: Learn the three-point limit",
    instructionZh: "先点红叉 [2,2]：这不是红线，普通落子会被三点限制挡住。",
    instructionEn: "First try the red cross [2,2]. It is not on Red’s line, so the three-point limit blocks this ordinary move.",
    allowedInstructionZh: "其他位置不能这样落子。现在点红线 [2,1] 切断；这里连成蓝方连续三子也允许。",
    allowedInstructionEn: "That ordinary move was blocked. Now cut Red’s line at [2,1]; three connected Blue nodes are allowed at this cut.",
    successZh: "切断成功：直接切红线时，切断处可以连成蓝方三子。",
    successEn: "Cut complete: a direct cut may create three connected Blue nodes.",
  }),
  Object.freeze({
    id: "L5-settle-score",
    gridSize: 6,
    playerCount: 2,
    startPlayer: "BLACK",
    rulesVersion: "territory-v3",
    prefix: Object.freeze([
      Object.freeze({ type: "move", player: "BLACK", point: Object.freeze([2, 0]) }),
      Object.freeze({ type: "move", player: "WHITE", point: Object.freeze([2, 3]) }),
      Object.freeze({ type: "move", player: "BLACK", point: Object.freeze([1, 1]) }),
      Object.freeze({ type: "move", player: "WHITE", point: Object.freeze([4, 0]) }),
      Object.freeze({ type: "move", player: "BLACK", point: Object.freeze([2, 2]) }),
      Object.freeze({ type: "move", player: "WHITE", point: Object.freeze([0, 5]) }),
      Object.freeze({ type: "move", player: "BLACK", point: Object.freeze([3, 2]) }),
    ]),
    objective: Object.freeze({ type: "skip", player: "BLACK" }),
    focusEdges: Object.freeze([
      Object.freeze({ player: "BLACK", edge: "0,0|2,0" }),
      Object.freeze({ player: "BLACK", edge: "1,1|2,0" }),
      Object.freeze({ player: "BLACK", edge: "2,0|2,2" }),
      Object.freeze({ player: "BLACK", edge: "2,2|3,2" }),
    ]),
    titleZh: "第五关：让引擎结算",
    titleEn: "Lesson 5: Let the engine settle",
    instructionZh: "红方已经无棋可走，系统已自动跳过红方。蓝方再点“跳过回合”，马上按领土结算。",
    instructionEn: "Red has no legal moves and was passed automatically. Click “Skip Turn” for Blue to settle the territory score.",
    successZh: "结算完成：红方无棋可走，蓝方获胜。",
    successEn: "Settled: Red had no legal moves, and Blue won.",
  }),
]);

export function getTutorialLevel(index = 0) {
  return TUTORIAL_LEVELS[index] ?? TUTORIAL_LEVELS[0];
}

export function isTutorialTarget(level, action = null) {
  if (!level || !action || action.type !== level.objective?.type) {
    return false;
  }
  if (level.objective.type === "skip") {
    return true;
  }
  return Array.isArray(action.point)
    && action.point[0] === level.objective.point[0]
    && action.point[1] === level.objective.point[1];
}

export function isTutorialRestrictionAttempt(level, action = null) {
  return Boolean(level?.restriction && action?.type === "move"
    && action.success === false && action.reason === "INVALID_MOVE"
    && action.player === level.objective.player
    && Array.isArray(action.point)
    && action.point[0] === level.restriction.point[0]
    && action.point[1] === level.restriction.point[1]);
}

export function getTutorialEngineSettings(level = getTutorialLevel()) {
  return {
    playerCount: level.playerCount,
    gridSize: level.gridSize,
    startPlayer: level.startPlayer,
    rulesVersion: level.rulesVersion,
    protectionRule: "duel-first-unprotected-v1",
    turnTimerEnabled: false,
    turnTimeLimitSeconds: 60,
    hintEnabled: false,
    hintMaxCount: 0,
  };
}

// The result overlay comes from the real before/after snapshots, including
// removed edges and cleared points. It never changes the teaching position.
export function getTutorialInspectionOverlay(level, before, after = before, success = false, restrictionObserved = false) {
  if (!level || !before || !after) return null;
  const addedEdges = [];
  const removedEdges = [];
  const capturedPoints = [];
  if (success) {
    for (const [player, edges] of Object.entries(after.edges ?? {})) {
      const previous = new Set(before.edges?.[player] ?? []);
      const current = new Set(edges);
      addedEdges.push(...edges.filter((edge) => !previous.has(edge)).map((edge) => ({ player, edge })));
      removedEdges.push(...[...previous].filter((edge) => !current.has(edge)).map((edge) => ({ player, edge })));
    }
    for (let y = 0; y < before.boardMatrix.length; y += 1) {
      for (let x = 0; x < before.boardMatrix[y].length; x += 1) {
        if (before.boardMatrix[y][x] > 0 && after.boardMatrix[y]?.[x] === 0) {
          capturedPoints.push([x, y]);
        }
      }
    }
  }
  return {
    tutorial: true,
    selectedPoint: level.objective.type === "move"
      ? [...(level.restriction && !restrictionObserved ? level.restriction.point : level.objective.point)]
      : null,
    blockedPoint: level.restriction && !success ? [...level.restriction.point] : null,
    addedEdges: success && level.objective.type === "move" ? addedEdges
      : (restrictionObserved && level.allowedFocusEdges ? level.allowedFocusEdges : level.focusEdges),
    removedEdges,
    capturedPoints,
  };
}
