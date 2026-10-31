import GameEngine, { PointState } from "./GameEngine.js?v=20261013-sync1";

const move = (player, point) => Object.freeze({ type: "move", player, point: Object.freeze(point) });

// The authored line is a witness that a challenge can be solved. Runtime
// completion is decided by evaluateChallengeResult's engine-state predicates,
// never by comparing a player's move to this line.
const CHALLENGE_BASE_LEVELS = Object.freeze([
  Object.freeze({
    id: "C01-hub-connection",
    category: "connection",
    gridSize: 6,
    playerCount: 2,
    startPlayer: "BLACK",
    rulesVersion: "territory-v2",
    prefix: Object.freeze([
      move("BLACK", [0, 5]), move("WHITE", [1, 4]),
      move("BLACK", [0, 4]), move("WHITE", [2, 3]),
      move("BLACK", [2, 2]), move("WHITE", [4, 1]),
    ]),
    referenceSolution: Object.freeze([move("BLACK", [0, 2])]),
    replyPreferences: Object.freeze([]),
    maxPlayerMoves: 1,
    goal: Object.freeze({ type: "connection-growth", minimumNewEdges: 4 }),
    designIntentZh: "把三段分散前线汇入同一枢纽，观察一次落子生成多条蓝线的效果。",
    designIntentEn: "Join three separated fronts at one hub and see how one move can add several Blue links.",
    titleZh: "汇成生命枢纽",
    titleEn: "Build a Lifeline Hub",
    promptZh: "用一步把分散的蓝色前线接成枢纽，新增至少四条蓝线。",
    promptEn: "Link Blue’s separated fronts in one move, adding at least four Blue edges.",
    successZh: "多条前线已经汇入同一枢纽。",
    successEn: "The separate fronts now meet at one hub.",
  }),
  Object.freeze({
    id: "C02-sever-outpost",
    category: "cut",
    gridSize: 6,
    playerCount: 2,
    startPlayer: "BLACK",
    rulesVersion: "territory-v2",
    prefix: Object.freeze([move("BLACK", [0, 2]), move("WHITE", [1, 4])]),
    referenceSolution: Object.freeze([move("BLACK", [3, 2])]),
    replyPreferences: Object.freeze([]),
    maxPlayerMoves: 1,
    goal: Object.freeze({ type: "cut-opponent", minimumRemovedNodes: 1, minimumRemovedEdges: 1 }),
    designIntentZh: "找到红色前哨唯一依赖的补给边，让规则引擎清除失联节点。",
    designIntentEn: "Find the supply link Red depends on and let the engine clear the disconnected outpost.",
    titleZh: "切断孤立前哨",
    titleEn: "Sever the Outpost",
    promptZh: "红色前哨离出生点只靠一条补给线。切断后，失联节点与边将被清除。",
    promptEn: "The Red outpost depends on one supply link. Cut it to clear the disconnected group.",
    successZh: "红色补给线已断，失联前哨被清除。",
    successEn: "The Red supply line is cut and the disconnected outpost is cleared.",
  }),
  Object.freeze({
    id: "C03-close-corner",
    category: "territory",
    gridSize: 6,
    playerCount: 2,
    startPlayer: "BLACK",
    rulesVersion: "territory-v2",
    prefix: Object.freeze([move("BLACK", [0, 1]), move("WHITE", [0, 5])]),
    referenceSolution: Object.freeze([move("BLACK", [2, 0])]),
    replyPreferences: Object.freeze([]),
    maxPlayerMoves: 1,
    goal: Object.freeze({ type: "territory-gain", minimumAreaGain: 4 }),
    designIntentZh: "补齐角部边界，比较闭合前后的精确领土变化。",
    designIntentEn: "Complete the corner boundary and compare exact territory before and after.",
    titleZh: "封住角地",
    titleEn: "Close the Corner",
    promptZh: "在角部补上边界，使蓝方领土至少增加四格。",
    promptEn: "Complete the corner boundary to gain at least four territory points for Blue.",
    successZh: "角部已经封闭，蓝方领土增加。",
    successEn: "The corner is closed and Blue has gained territory.",
  }),
  Object.freeze({
    id: "C04-defend-supply",
    category: "defense",
    gridSize: 6,
    playerCount: 2,
    startPlayer: "BLACK",
    rulesVersion: "territory-v2",
    prefix: Object.freeze([
      move("BLACK", [3, 0]), move("WHITE", [1, 4]),
      move("BLACK", [3, 2]), move("WHITE", [4, 0]),
      move("BLACK", [1, 2]), move("WHITE", [3, 1]),
    ]),
    referenceSolution: Object.freeze([move("BLACK", [1, 0]), move("WHITE", [2, 1])]),
    replyPreferences: Object.freeze([[2, 1]]),
    maxPlayerMoves: 1,
    goal: Object.freeze({ type: "preserve-starting-nodes" }),
    designIntentZh: "先预判红方切入，再验证应手后所有既有蓝点是否存活。",
    designIntentEn: "Anticipate Red’s cut and verify that every existing Blue node survives the reply.",
    titleZh: "护住补给线",
    titleEn: "Protect the Supply Line",
    promptZh: "红方下一步可以切入蓝线。先补出可靠连接；一轮防守后，所有蓝色既有节点都应仍在棋盘上。",
    promptEn: "Red threatens a cut into Blue’s line. Reinforce first; after the reply, every existing Blue node must remain on the board.",
    successZh: "防守成功：红方应手后，蓝方既有节点全部存活。",
    successEn: "Defense holds: every existing Blue node survives Red’s reply.",
  }),
  Object.freeze({
    id: "C05-two-move-area",
    category: "limited-turns",
    gridSize: 6,
    playerCount: 2,
    startPlayer: "BLACK",
    rulesVersion: "territory-v2",
    prefix: Object.freeze([move("BLACK", [0, 1]), move("WHITE", [1, 4])]),
    referenceSolution: Object.freeze([
      move("BLACK", [2, 0]), move("WHITE", [3, 0]), move("BLACK", [3, 1]),
    ]),
    replyPreferences: Object.freeze([[3, 0], [2, 2]]),
    maxPlayerMoves: 2,
    goal: Object.freeze({ type: "territory-threshold", minimumArea: 7 }),
    designIntentZh: "在红方逐手应对下规划两步圈地，而非依赖静态边界。",
    designIntentEn: "Plan a two-turn enclosure while Red replies after each move.",
    titleZh: "两步抢占七格",
    titleEn: "Claim Seven in Two Moves",
    promptZh: "红方会回应你的每一步。最多两步，让蓝方领土达到七格。",
    promptEn: "Red replies after each turn. Reach seven Blue territory points in no more than two moves.",
    successZh: "限步达成：蓝方领土已达到七格。",
    successEn: "Goal reached within the limit: Blue now controls at least seven points.",
  }),
  Object.freeze({
    id: "C06-cut-and-enclose",
    category: "multi-step",
    gridSize: 6,
    playerCount: 2,
    startPlayer: "BLACK",
    rulesVersion: "territory-v2",
    prefix: Object.freeze([move("BLACK", [0, 2]), move("WHITE", [0, 5])]),
    referenceSolution: Object.freeze([
      move("BLACK", [1, 0]), move("WHITE", [2, 0]), move("BLACK", [3, 2]),
    ]),
    replyPreferences: Object.freeze([[2, 0], [1, 4]]),
    maxPlayerMoves: 2,
    goal: Object.freeze({ type: "cut-and-territory", minimumRemovedNodes: 1, minimumArea: 8 }),
    designIntentZh: "用先手铺垫诱发应手，再切断红方并同时达到领土门槛。",
    designIntentEn: "Set up the line, draw a reply, then cut Red while meeting the territory threshold.",
    titleZh: "断线并圈地",
    titleEn: "Cut and Enclose",
    promptZh: "这是一道两步综合题：先铺路，再利用红方应手完成切断，并让蓝方领土达到八格。",
    promptEn: "A two-turn combination: set up a route, then cut through Red’s reply and reach eight Blue territory points.",
    successZh: "综合目标完成：红色失联节点已清除，蓝方领土达到八格。",
    successEn: "Combination complete: a disconnected Red node is cleared and Blue has eight territory points.",
  }),
]);

function makeVariant(base, suffix, goal, titleZh, titleEn, promptZh, promptEn) {
  const intent = {
    "connection-growth": `考查一次落子能否新增 ${goal.minimumNewEdges} 条蓝线。`,
    "connection-and-territory": `需要同时新增至少 ${goal.minimumNewEdges} 条蓝线，并增加 ${goal.minimumAreaGain} 格领土。`,
    "cut-opponent": "以切断红方联络为主，按引擎清除的节点与边判定。",
    "cut-and-connect": `切断红方的同时，还要新增 ${goal.minimumNewEdges} 条蓝线。`,
    "cut-and-survive": "检查切断后蓝方既有节点是否仍在棋盘上。",
    "territory-gain": `在当前局面上直接增加至少 ${goal.minimumAreaGain} 格领土。`,
    "clean-territory-gain": `增加至少 ${goal.minimumAreaGain} 格领土，并保留红方现有节点。`,
    "preserve-starting-nodes": "在红方应手之后保住所有既有蓝点。",
    "territory-threshold": `用不超过两步把蓝方领土推到 ${goal.minimumArea} 格。`,
    "cut-and-territory": `切断红方节点，并在结算时控制至少 ${goal.minimumArea} 格。`,
  }[goal.type] ?? "按当前棋盘上的规则目标寻找一着有效解。";
  return Object.freeze({
    ...base,
    id: `${base.id}-${suffix}`,
    goal: Object.freeze(goal),
    titleZh: `${base.titleZh} · ${titleZh}`,
    titleEn: `${base.titleEn} · ${titleEn}`,
    promptZh,
    promptEn,
    designIntentZh: intent,
    designIntentEn: promptEn,
  });
}

function lineFromNotation(notation) {
  return Object.freeze(notation.split(" ").map((token) => move(token[0] === "B" ? "BLACK" : "WHITE", [Number(token[1]), Number(token[2])])))
}

function makeTacticalVariant(base, suffix, options) {
  const level = makeVariant(base, suffix, options.goal, options.titleZh, options.titleEn, options.promptZh, options.promptEn);
  return Object.freeze({
    ...level,
    prefix: lineFromNotation(options.prefix),
    referenceSolution: lineFromNotation(options.solution),
    replyPreferences: Object.freeze([]),
    maxPlayerMoves: options.maxPlayerMoves ?? 1,
    designIntentZh: options.designIntentZh,
    designIntentEn: options.designIntentEn,
  });
}

const challengeVariants = [
  makeTacticalVariant(CHALLENGE_BASE_LEVELS[2], "upper-basin-five", {
    prefix: "B30 W41 B31 W14 B02 W05", solution: "B04", goal: { type: "territory-gain", minimumAreaGain: 5 },
    titleZh: "沿上沿扩成五格", titleEn: "Extend the Upper Boundary for Five",
    promptZh: "蓝方已沿上沿布局，向西北扩展边界，一步新增至少五格领土。", promptEn: "Blue has formed an upper line. Extend it northwest to gain at least five territory points in one move.",
    designIntentZh: "[0,4] 扩出五格；同一局面 [1,3] 是较小的干净圈地解，不能达到本题门槛。", designIntentEn: "[0,4] gains five points; [1,3] is a smaller clean-enclosure move from the same position and misses this threshold.",
  }),
  makeTacticalVariant(CHALLENGE_BASE_LEVELS[0], "west-basin-nine", {
    prefix: "B02 W23 B03 W22 B05 W41", solution: "B30", goal: { type: "connection-and-territory", minimumNewEdges: 2, minimumAreaGain: 11 },
    titleZh: "接线并圈住十一格", titleEn: "Connect and Enclose Eleven",
    promptZh: "同一前线要兼顾连通与大块领土：一步至少新增两条蓝线、十一格领土。", promptEn: "Connect the fronts and secure a large area in one move: add two Blue links and eleven territory points.",
    designIntentZh: "落在 [3,0] 接通中央前线并围出十二格；[2,0] 的九格边界不够大。", designIntentEn: "[3,0] links the central fronts and encloses twelve points; the nine-point boundary at [2,0] is too small.",
  }),
  makeTacticalVariant(CHALLENGE_BASE_LEVELS[0], "west-basin-twelve", {
    prefix: "B03 W40 B10 W13 B12 W22 B05 W20 B21 W11", solution: "B32", goal: { type: "clean-territory-gain", minimumAreaGain: 3 },
    titleZh: "圈地时保留红点", titleEn: "Enclose without Removing Red",
    promptZh: "同一局面有切断红线和干净圈地两条路线。本题要求新增三格领土且不能清除红点。", promptEn: "This position offers a cut and a clean enclosure. Gain three territory points without removing a Red node.",
    designIntentZh: "[3,2] 连接下方蓝线并取得三格，同时保留红方；[3,0] 虽能大幅切断，却违反保留目标。", designIntentEn: "[3,2] connects the lower Blue line and gains three points while preserving Red; the larger cut at [3,0] violates the goal.",
  }),
  makeTacticalVariant(CHALLENGE_BASE_LEVELS[1], "cross-cut-two", {
    prefix: "B05 W40 B32 W13 B04 W20 B10 W12", solution: "B31", goal: { type: "cut-and-connect", minimumRemovedNodes: 2, minimumRemovedEdges: 2, minimumNewEdges: 2 },
    titleZh: "横切并接回两线", titleEn: "Cut Across and Reconnect",
    promptZh: "红方两处节点依赖相连。切除它们，同时把蓝方两条前线接起来。", promptEn: "Two Red nodes depend on their link. Remove them while joining two Blue fronts.",
    designIntentZh: "[3,1] 同时清除两个红点并新增两条蓝线，是切断与连通的合并题。", designIntentEn: "[3,1] clears two Red nodes and adds two Blue links, combining a cut with a connection.",
  }),
  makeTacticalVariant(CHALLENGE_BASE_LEVELS[5], "cross-cut-fourteen", {
    prefix: "B04 W05 B30 W23 B13 W21", solution: "B32", goal: { type: "cut-and-territory", minimumRemovedNodes: 3, minimumArea: 15 },
    titleZh: "切穿东线占十五格", titleEn: "Sever the East and Claim Fifteen",
    promptZh: "红方东线依赖三处连接。向东侧切入，清除至少三个红点，并在结算后控制十五格。", promptEn: "Red’s eastern line depends on three connected nodes. Cut from the east, clear at least three Red nodes, and hold fifteen points after settlement.",
    designIntentZh: "[3,2] 同时清除三个红点并留下十五格蓝地；它不是中央交叉口的两点切断题。", designIntentEn: "[3,2] clears three Red nodes and leaves fifteen Blue points; this is a three-node eastern cut, not the central two-node crossing.",
  }),
  makeTacticalVariant(CHALLENGE_BASE_LEVELS[0], "upper-bridge-four", {
    prefix: "B10 W40 B03 W23 B12 W22", solution: "B30", goal: { type: "connection-and-territory", minimumNewEdges: 4, minimumAreaGain: 3 },
    titleZh: "搭起四线桥", titleEn: "Build a Four-Link Bridge",
    promptZh: "上方蓝点互不连通；一步新增四条蓝线才能把前线汇合。", promptEn: "The upper Blue stones are disconnected. Join the fronts with four new links in one move.",
    designIntentZh: "[3,0] 一步把四条蓝边汇入同一节点，其他常见落点只新增两条。", designIntentEn: "[3,0] joins four Blue edges at one node; common alternatives add only two.",
  }),
  makeTacticalVariant(CHALLENGE_BASE_LEVELS[1], "lower-cut-reconnect", {
    prefix: "B02 W20 B05 W23 B10 W03", solution: "B13", goal: { type: "cut-opponent", minimumRemovedNodes: 1, minimumRemovedEdges: 1, minimumBlackEdges: 1 },
    titleZh: "切断下链并接应", titleEn: "Cut the Lower Link and Reconnect",
    promptZh: "从 [1,3] 切断红链，同时确保蓝线在同一步接应。", promptEn: "Cut the Red chain at [1,3] while adding a Blue link in the same move.",
    designIntentZh: "下侧红节点只有在切断后才会消失；单纯扩张蓝线或单纯增加领土都不满足目标。", designIntentEn: "The lower Red node is removed only by the cut; a Blue extension or territory gain alone cannot solve it.",
  }),
  makeTacticalVariant(CHALLENGE_BASE_LEVELS[0], "east-pocket-three", {
    prefix: "B05 W14 B02 W12 B10 W40 B03 W21", solution: "B30", goal: { type: "clean-territory-gain", minimumAreaGain: 3 },
    titleZh: "保留红点并圈三格", titleEn: "Enclose Three without a Capture",
    promptZh: "东侧有两条可行战术：圈地而不清除红点，或切断红链。此题只接受前者。", promptEn: "Two tactics are available on the east: enclose territory without clearing Red, or cut the chain. This goal requires the first.",
    designIntentZh: "[3,0] 从上方连接并新增三格，同时保留红点；[1,3] 虽切断红链却不满足保留条件。", designIntentEn: "[3,0] connects from above and gains three points while preserving Red; [1,3] cuts the chain and fails the preservation condition.",
  }),
  makeTacticalVariant(CHALLENGE_BASE_LEVELS[1], "east-pocket-cut", {
    prefix: "B05 W14 B02 W12 B10 W40 B03 W21", solution: "B13", goal: { type: "cut-and-territory", minimumRemovedNodes: 2, minimumArea: 10 },
    titleZh: "切断东侧并稳住十格", titleEn: "Cut the East and Hold Ten",
    promptZh: "红方东侧链条可被切断；蓝方最终还须控制十格领土。", promptEn: "Sever the eastern Red chain and finish with ten Blue territory points.",
    designIntentZh: "[1,3] 从下侧切入会清除两个红点并达到十格；[3,0] 是连通圈地解，两题要求不同。", designIntentEn: "[1,3] cuts from below, clears two Red nodes, and reaches ten points; [3,0] is the connect-and-enclose solution.",
  }),
  makeTacticalVariant(CHALLENGE_BASE_LEVELS[1], "lower-cross-cut", {
    prefix: "B04 W41 B31 W23", solution: "B32", goal: { type: "cut-opponent", minimumRemovedNodes: 1, minimumRemovedEdges: 2 },
    titleZh: "从下线切断", titleEn: "Sever from Below",
    promptZh: "从 [3,2] 落子切断红方下方补给，至少清除一节点和两条边。", promptEn: "Play [3,2] to cut Red’s lower supply route, clearing a node and two edges.",
    designIntentZh: "红方前哨位于低位；在 [3,2] 断开两条补给边，不能用上方圈地的走法替代。", designIntentEn: "The Red outpost is low on the board; [3,2] removes two supply links, unlike an upper enclosure move.",
  }),
  makeTacticalVariant(CHALLENGE_BASE_LEVELS[5], "south-cut-twelve", {
    prefix: "B02 W40 B05 W14", solution: "B32", goal: { type: "cut-and-territory", minimumRemovedNodes: 1, minimumArea: 12 },
    titleZh: "断线并占十二格", titleEn: "Cut and Claim Twelve",
    promptZh: "红方下侧节点孤立时，从 [3,2] 切断并取得十二格蓝色领土。", promptEn: "With a Red node isolated below, cut at [3,2] and claim twelve Blue territory points.",
    designIntentZh: "先读出右侧孤点的唯一补给，再用切断同时完成大面积围合。", designIntentEn: "Spot the isolated eastern supply first; the cut also closes a large Blue area.",
  }),
  makeTacticalVariant(CHALLENGE_BASE_LEVELS[5], "center-cut-ten", {
    prefix: "B04 W40 B30 W13 B02 W05 B14 W03", solution: "B22", goal: { type: "cut-and-territory", minimumRemovedNodes: 2, minimumArea: 10 },
    titleZh: "中心切入并控十格", titleEn: "Cut through the Center and Hold Ten",
    promptZh: "从中心切入，清除依赖该补给线的两个红点，并让蓝方最终控制十格。", promptEn: "Cut through the center, clear the two Red nodes that depend on the supply link, and finish with ten Blue territory points.",
    designIntentZh: "[2,2] 同时完成双点切除与十格控地；只在下侧扩展无法达到该结算目标。", designIntentEn: "[2,2] clears two Red nodes and secures ten points; a lower-side extension cannot meet this final-state goal.",
  }),
  makeTacticalVariant(CHALLENGE_BASE_LEVELS[2], "lower-pocket-three", {
    prefix: "B02 W20 B05 W23 B10 W03", solution: "B22", goal: { type: "territory-gain", minimumAreaGain: 3 },
    titleZh: "封住下侧三格", titleEn: "Close the Lower Three",
    promptZh: "不要追逐接线；找到能在一步内新增三格蓝方领土的封口。", promptEn: "Do not chase a connection. Find the one-move closure that gains three Blue territory points.",
    designIntentZh: "[2,2] 以一条边切断并新增三格，和 [1,3] 的清除红点目标不同。", designIntentEn: "[2,2] gains three points with one link, unlike [1,3], which clears the Red node.",
  }),
  makeTacticalVariant(CHALLENGE_BASE_LEVELS[5], "paired-clean-six", {
    prefix: "B20 W05 B22 W32", solution: "B30", goal: { type: "clean-territory-gain", minimumAreaGain: 6 },
    titleZh: "守住红点并围六格", titleEn: "Keep Red and Enclose Six",
    promptZh: "蓝方可以向下切断红点，也可以向右围地；本题只接受保留红点并新增六格的圈地解。", promptEn: "Blue can cut Red below or enclose to the right. Solve by gaining six points while leaving Red on the board.",
    designIntentZh: "[3,0] 一步得到六格且不清除红点；[2,3] 虽能切断红线，却不满足干净圈地目标。", designIntentEn: "[3,0] gains six points without clearing Red; [2,3] cuts Red but fails the clean-enclosure goal.",
  }),
  makeTacticalVariant(CHALLENGE_BASE_LEVELS[1], "paired-cut-two-links", {
    prefix: "B20 W05 B22 W32", solution: "B23", goal: { type: "cut-and-connect", minimumRemovedNodes: 1, minimumRemovedEdges: 2, minimumNewEdges: 2 },
    titleZh: "切断下链并接起蓝线", titleEn: "Cut Below and Connect Blue",
    promptZh: "与圈地解共用局面，但这次必须切掉红色下链并同时新增两条蓝线。", promptEn: "From the same position as the enclosure puzzle, remove Red’s lower chain and add two Blue links.",
    designIntentZh: "落在 [2,3] 会清除红点和两条红边，并新增两条蓝边；向右圈地不会切断。", designIntentEn: "[2,3] clears a Red node and two Red edges while adding two Blue edges; the right-side enclosure does not cut.",
  }),
  makeTacticalVariant(CHALLENGE_BASE_LEVELS[5], "south-cut-ten", {
    prefix: "B10 W23 B30 W03 B12 W40", solution: "B32", goal: { type: "cut-and-territory", minimumRemovedNodes: 2, minimumArea: 10 },
    titleZh: "切除两点并守住十格", titleEn: "Clear Two Nodes and Hold Ten",
    promptZh: "找到下方切入点，一步清除两个红点，并保有十格蓝方领土。", promptEn: "Find the lower cut that clears two Red nodes and leaves Blue with ten territory points.",
    designIntentZh: "[3,2] 切除两点后仍占十格；只扩蓝线或只圈地都不够。", designIntentEn: "[3,2] removes two nodes and leaves ten points; a Blue-only extension or enclosure falls short.",
  }),
  makeTacticalVariant(CHALLENGE_BASE_LEVELS[2], "upper-pocket-clean-three", {
    prefix: "B30 W41 B31 W14 B02 W05", solution: "B13", goal: { type: "clean-territory-gain", minimumAreaGain: 3 },
    titleZh: "上侧围三格不吃子", titleEn: "Enclose Three without a Capture",
    promptZh: "沿上侧补边新增三格领土，同时让红方节点全部留在棋盘上。", promptEn: "Complete the upper boundary for three new territory points while leaving every Red node on the board.",
    designIntentZh: "[1,3] 完成干净圈地；[3,2] 能切除红链，但违反保留节点的条件。", designIntentEn: "[1,3] completes a clean enclosure; [3,2] cuts Red but violates the node-preservation condition.",
  }),
  makeTacticalVariant(CHALLENGE_BASE_LEVELS[2], "middle-basin-clean-three", {
    prefix: "B10 W40 B02 W14 B12 W05", solution: "B30", goal: { type: "clean-territory-gain", minimumAreaGain: 3 },
    titleZh: "中腹收边保留红链", titleEn: "Close the Middle and Keep Red",
    promptZh: "从中腹连接蓝方边界，增加三格领土但不能清除红色节点。", promptEn: "Connect Blue’s middle boundary, gain three territory points, and keep the Red nodes in play.",
    designIntentZh: "[3,0] 是安全收边；[3,2] 则切断红链，面积虽增加但不符合本题目标。", designIntentEn: "[3,0] safely closes the boundary; [3,2] cuts Red and fails even though it also gains area.",
  }),
];

export const CHALLENGE_LEVELS = Object.freeze([...CHALLENGE_BASE_LEVELS, ...challengeVariants]);

function countState(snapshot, state) {
  return (snapshot?.boardMatrix ?? []).flat().filter((point) => point === state).length;
}

export function snapshotChallengeMetrics(before, after) {
  if (!before || !after) return null;
  const removedNodes = { BLACK: 0, WHITE: 0, PURPLE: 0 };
  const removedEdges = { BLACK: 0, WHITE: 0, PURPLE: 0 };
  const playerNodes = {
    BLACK: PointState.BLACK_NODE,
    WHITE: PointState.WHITE_NODE,
    PURPLE: PointState.PURPLE_NODE,
  };
  for (const [player, nodeState] of Object.entries(playerNodes)) {
    const previous = before.boardMatrix.flat();
    const current = after.boardMatrix.flat();
    removedNodes[player] = previous.reduce((count, value, index) => count + (value === nodeState && current[index] !== nodeState ? 1 : 0), 0);
    const oldEdges = new Set(before.edges?.[player] ?? []);
    const newEdges = new Set(after.edges?.[player] ?? []);
    removedEdges[player] = [...oldEdges].filter((edge) => !newEdges.has(edge)).length;
  }
  return {
    addedEdges: Object.fromEntries(Object.keys(playerNodes).map((player) => {
      const oldEdges = new Set(before.edges?.[player] ?? []);
      return [player, (after.edges?.[player] ?? []).filter((edge) => !oldEdges.has(edge)).length];
    })),
    removedEdges,
    removedNodes,
    territoryGain: Object.fromEntries(Object.keys(playerNodes).map((player) => [player, (after.territories?.[player]?.area ?? 0) - (before.territories?.[player]?.area ?? 0)])),
    territory: Object.fromEntries(Object.keys(playerNodes).map((player) => [player, after.territories?.[player]?.area ?? 0])),
  };
}

function emptyChallengeMetrics() {
  const zero = { BLACK: 0, WHITE: 0, PURPLE: 0 };
  return { addedEdges: { ...zero }, removedEdges: { ...zero }, removedNodes: { ...zero }, territoryGain: { ...zero }, territory: { ...zero } };
}

function accumulateChallengeMetrics(total, next) {
  for (const field of ["addedEdges", "removedEdges", "removedNodes"]) {
    for (const player of Object.keys(total[field])) total[field][player] += next[field][player];
  }
  for (const player of Object.keys(total.territoryGain)) total.territoryGain[player] += next.territoryGain[player];
  total.territory = next.territory;
  return total;
}

export function evaluateChallengeResult(level, metrics, startingOwnNodes = [], afterOpponentReply = null, currentSnapshot = afterOpponentReply) {
  if (!level || !metrics) return false;
  if (!Number.isInteger(metrics.playerMoves) || metrics.playerMoves < 1 || metrics.playerMoves > level.maxPlayerMoves) return false;
  const goal = level.goal;
  if (goal.type === "connection-growth") return metrics.addedEdges.BLACK >= goal.minimumNewEdges;
  if (goal.type === "connection-and-territory") return metrics.addedEdges.BLACK >= goal.minimumNewEdges && metrics.territoryGain.BLACK >= goal.minimumAreaGain;
  if (goal.type === "cut-opponent") return metrics.removedNodes.WHITE >= goal.minimumRemovedNodes && metrics.removedEdges.WHITE >= goal.minimumRemovedEdges
    && (!goal.minimumBlackEdges || metrics.addedEdges.BLACK >= goal.minimumBlackEdges);
  if (goal.type === "cut-and-connect") return metrics.removedNodes.WHITE >= goal.minimumRemovedNodes && metrics.removedEdges.WHITE >= goal.minimumRemovedEdges
    && metrics.addedEdges.BLACK >= goal.minimumNewEdges;
  if (goal.type === "cut-and-survive") {
    const board = currentSnapshot?.boardMatrix;
    return metrics.removedNodes.WHITE >= goal.minimumRemovedNodes && metrics.removedEdges.WHITE >= goal.minimumRemovedEdges
      && Array.isArray(board) && startingOwnNodes.length > 0
      && startingOwnNodes.every(([x, y]) => board[y]?.[x] === PointState.BLACK_NODE);
  }
  if (goal.type === "territory-gain") return metrics.territoryGain.BLACK >= goal.minimumAreaGain;
  if (goal.type === "clean-territory-gain") return metrics.territoryGain.BLACK >= goal.minimumAreaGain && metrics.removedNodes.WHITE === 0;
  if (goal.type === "preserve-starting-nodes") {
    const board = afterOpponentReply?.boardMatrix;
    return Array.isArray(board) && startingOwnNodes.length > 0
      && metrics.opponentReplies > 0
      && startingOwnNodes.every(([x, y]) => board[y]?.[x] === PointState.BLACK_NODE)
      && (!goal.minimumNewEdges || metrics.addedEdges.BLACK >= goal.minimumNewEdges);
  }
  if (goal.type === "territory-threshold") return metrics.territory.BLACK >= goal.minimumArea;
  if (goal.type === "cut-and-territory") return metrics.removedNodes.WHITE >= goal.minimumRemovedNodes && metrics.territory.BLACK >= goal.minimumArea;
  return false;
}

export function validateChallengeReference(level) {
  const engine = new GameEngine({ gridSize: level.gridSize, playerCount: level.playerCount, startPlayer: level.startPlayer, rulesVersion: level.rulesVersion });
  const apply = (action) => {
    if (engine.getCurrentPlayer() !== action.player) return false;
    return (action.type === "skip" ? engine.skipTurn() : engine.playMove(action.point)).success;
  };
  for (const action of level.prefix) if (!apply(action)) return { valid: false, stage: "prefix", action };
  const before = engine.getSnapshot();
  const startingOwnNodes = before.boardMatrix.flatMap((row, y) => row.flatMap((value, x) => value === PointState.BLACK_NODE ? [[x, y]] : []));
  let after = before;
  let afterOpponentReply = null;
  let metrics = emptyChallengeMetrics();
  let playerMoves = 0;
  let opponentReplies = 0;
  for (const action of level.referenceSolution) {
    if (action.player === "BLACK") playerMoves += 1;
    if (playerMoves > level.maxPlayerMoves || !apply(action)) return { valid: false, stage: "solution", action };
    if (action.player === "WHITE") opponentReplies += 1;
    const previous = after;
    after = engine.getSnapshot();
    metrics = accumulateChallengeMetrics(metrics, snapshotChallengeMetrics(previous, after));
    if (action.player === "WHITE") afterOpponentReply = after;
  }
  metrics.playerMoves = playerMoves;
  metrics.opponentReplies = opponentReplies;
  const result = {
    valid: evaluateChallengeResult(level, metrics, startingOwnNodes, afterOpponentReply, after),
    stage: "goal",
    metrics,
    playerMoves,
    startingOwnNodes,
    finalSnapshot: after,
  };
  return result;
}
