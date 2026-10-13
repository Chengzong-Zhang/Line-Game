export const TUTORIAL_LEVELS = Object.freeze([
  Object.freeze({
    id: "L1-connect",
    gridSize: 6,
    playerCount: 2,
    startPlayer: "BLACK",
    rulesVersion: "territory-v2",
    prefix: Object.freeze([]),
    objective: Object.freeze({ type: "move", player: "BLACK", point: Object.freeze([1, 0]) }),
    titleZh: "第一关：连成第一条生命线",
    titleEn: "Lesson 1: Build your first lifeline",
    instructionZh: "蓝方先手。点击高亮的节点，把生命线向外扩张一步。",
    instructionEn: "Blue moves first. Click the highlighted node to extend your first lifeline.",
    successZh: "连接建立了！同色节点会自动形成生命线。",
    successEn: "Connection established! Same-color nodes automatically form a lifeline.",
  }),
  Object.freeze({
    id: "L2-close-territory",
    gridSize: 6,
    playerCount: 2,
    startPlayer: "BLACK",
    rulesVersion: "territory-v2",
    prefix: Object.freeze([
      Object.freeze({ type: "move", player: "BLACK", point: Object.freeze([3, 0]) }),
      Object.freeze({ type: "skip", player: "WHITE" }),
    ]),
    objective: Object.freeze({ type: "move", player: "BLACK", point: Object.freeze([0, 3]) }),
    titleZh: "第二关：围出第一块领土",
    titleEn: "Lesson 2: Close your first territory",
    instructionZh: "黑方已有两条边。点击高亮节点，闭合第三条边，让引擎计算领土。",
    instructionEn: "Black already has two sides. Click the highlighted node to close the triangle and claim territory.",
    successZh: "边界闭合了！只有闭合区域才会产生领土分数。",
    successEn: "The boundary is closed! Only closed regions produce territory score.",
  }),
  Object.freeze({
    id: "L3-cut-and-clear",
    gridSize: 6,
    playerCount: 2,
    startPlayer: "BLACK",
    rulesVersion: "territory-v2",
    prefix: Object.freeze([
      Object.freeze({ type: "move", player: "BLACK", point: Object.freeze([3, 0]) }),
      Object.freeze({ type: "move", player: "WHITE", point: Object.freeze([2, 3]) }),
    ]),
    objective: Object.freeze({ type: "move", player: "BLACK", point: Object.freeze([3, 2]) }),
    titleZh: "第三关：切断补给线",
    titleEn: "Lesson 3: Cut the supply line",
    instructionZh: "点击白色线段上的高亮节点。切断后，失去起点连通性的白方部分会一起清除。",
    instructionEn: "Click the highlighted point on the white line. Disconnected white parts will be cleared together.",
    successZh: "切断完成！切断不是吃掉一个点，而是清除整段断联结构。",
    successEn: "Cut complete! A cut removes the disconnected structure, not just one point.",
  }),
  Object.freeze({
    id: "L4-settle-score",
    gridSize: 6,
    playerCount: 2,
    startPlayer: "BLACK",
    rulesVersion: "territory-v2",
    prefix: Object.freeze([
      Object.freeze({ type: "move", player: "BLACK", point: Object.freeze([3, 0]) }),
      Object.freeze({ type: "skip", player: "WHITE" }),
      Object.freeze({ type: "move", player: "BLACK", point: Object.freeze([0, 3]) }),
      Object.freeze({ type: "skip", player: "WHITE" }),
    ]),
    objective: Object.freeze({ type: "skip", player: "BLACK" }),
    titleZh: "第四关：让引擎结算",
    titleEn: "Lesson 4: Let the engine settle",
    instructionZh: "现在练习结算。点击“跳过回合”，让连续跳过触发终局。",
    instructionEn: "Now practice settlement. Click “Skip Turn” to trigger the end of the match.",
    successZh: "本关结束！赢家和分数都由规则引擎结算。",
    successEn: "The lesson is over! The rules engine determines the winner and score.",
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

export function getTutorialEngineSettings(level = getTutorialLevel()) {
  return {
    playerCount: level.playerCount,
    gridSize: level.gridSize,
    startPlayer: level.startPlayer,
    rulesVersion: level.rulesVersion,
    turnTimerEnabled: false,
    turnTimeLimitSeconds: 60,
    hintEnabled: false,
    hintMaxCount: 0,
  };
}
