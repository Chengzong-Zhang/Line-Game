# AI 功能实现提示词

各 Task 之间的依赖关系：
- **Task 1 必须最先完成**，其余三个 Task 都依赖它
- Task 2A、2B、2C 在 Task 1 完成后可**并行**执行

---

## Task 1：创建 AIEngine.js

> 将以下提示词粘贴给 AI，让它实现 Task 1。

---

你需要为一个三角格棋盘游戏（网页版）创建 AI 引擎模块。

**项目背景：**
这是一个三角形网格策略棋盘游戏，两人或三人对战。游戏核心逻辑的网页端实现在 `web/web前端/GameEngine.js`，Python 桌面版有一个 Minimax AI 实现在 `AI/ai_engine.py` 和 `AI/ai_game.py`。你的任务是把这个 AI 移植为可在浏览器 Web Worker 中运行的 JS 模块。

**第一步：阅读以下文件（不要先写代码）：**

1. `AI/ai_engine.py` — MinimaxAI 类，含 minimax + alpha-beta 剪枝、get_legal_moves、order_moves、get_top_moves
2. `AI/ai_game.py` 第 37~130 行 — evaluate 函数、_fast_territory_bfs、_save_state、_restore_state、_apply_move_for_ai
3. `web/web前端/GameEngine.js` — 了解 JS 端 GameEngine 的接口，重点看：
   - 构造函数参数：`new GameEngine({ gridSize, playerCount, startPlayer })`
   - 属性：`engine.validPositions`（`[x,y][]`）、`engine.grid`（`Map<"x,y", PointState>`）、`engine.edges`（`{BLACK: Set, WHITE: Set, PURPLE: Set}`）、`engine.historyHashes`（`Set<string>`）、`engine.currentPlayer`、`engine.gameOver`、`engine.consecutiveSkips`、`engine.activePlayers`
   - 方法：`engine.getLegalMoves(player)` 返回 `{point:[x,y], state, isAttack}[]`、`engine.playMove(point)` 返回 `{success, snapshot, reason}`、`engine.skipTurn()`、`engine.getAdjacentPositions(point)`、`engine._getPlayerNodes(player)`、`engine._getPlayerLines(player)`、`engine._getPlayerStates(player)` 返回 `{node:PointState, line:PointState}`、`engine._isConnectedToInitial(point, player)`、`engine._getState(point)`、`engine._setState(point, state)`、`engine._computeStateHash(player)`

**第二步：创建文件 `web/web前端/AIEngine.js`，实现以下内容：**

**（一）saveState / restoreState（替代 Python 的 _save_state/_restore_state）：**

```js
function saveState(engine) {
  return {
    grid: new Map(engine.grid),
    edges: {
      BLACK: new Set(engine.edges.BLACK),
      WHITE: new Set(engine.edges.WHITE),
      PURPLE: new Set(engine.edges.PURPLE),
    },
    historyHashes: new Set(engine.historyHashes),
    consecutiveSkips: engine.consecutiveSkips,
    currentPlayer: engine.currentPlayer,
    gameOver: engine.gameOver,
  };
}

function restoreState(engine, snapshot) {
  engine.grid = new Map(snapshot.grid);
  engine.edges = {
    BLACK: new Set(snapshot.edges.BLACK),
    WHITE: new Set(snapshot.edges.WHITE),
    PURPLE: new Set(snapshot.edges.PURPLE),
  };
  engine.historyHashes = new Set(snapshot.historyHashes);
  engine.consecutiveSkips = snapshot.consecutiveSkips;
  engine.currentPlayer = snapshot.currentPlayer;
  engine.gameOver = snapshot.gameOver;
}
```

**（二）applyMoveForAI（替代 Python 的 _apply_move_for_ai）：**

调用 `engine.playMove(point)`。若 `result.success === false` 且原因是 superko（reason 含 "SUPERKO" 或 "REPEAT"），视为非法但不报错，直接 return。若成功，不需要额外操作（playMove 内部已更新 currentPlayer）。

**（三）fastTerritoryBFS（移植自 ai_game.py._fast_territory_bfs）：**

从玩家所有棋子（node + line）出发做 BFS，遇到对手棋子（任意颜色对手的 node 或 line）停止扩展，统计可达格子总数。返回 number。
- 用 `engine._getPlayerStates(player)` 获取己方和对手的 PointState 值
- 用 `engine._getOpponents ? engine.activePlayers.filter(p => p !== player) : ...` 获取所有对手

**（四）evaluate（移植自 ai_game.py.evaluate）：**

```
score = 15 * node_advantage
      + 8  * coverage_advantage
      + 20 * territory_advantage
      + 12 * attack_threats
      + 10 * connection_quality
```

- `node_advantage`：己方 nodes 数量 − 对手 nodes 数量（2人局只有一个对手；3人局对手是所有非己方玩家的总和）
- `coverage_advantage`：(己方 nodes+lines 总数) − (对手 nodes+lines 总数)
- `territory_advantage`：fastTerritoryBFS(engine, player) − fastTerritoryBFS(engine, opponent)（3人局取主要对手，即棋子最多的那个）
- `attack_threats`：对手所有 line 格子中，己方合法落点的数量（即能攻击对手连线的点数）
- `connection_quality`：己方每个 node 调用 `engine._isConnectedToInitial(node, player)`，连通则 +1，不连通则 -1，求和

**（五）orderMoves（移植自 ai_engine.py.order_moves）：**

输入 moves 是 `[x,y][]`，按三层优先级排序后返回最多 20 个：
- Tier 0（最高优先级）：该格子当前状态是对手的 LINE（可截断对手连线）
- Tier 1：该格子邻接己方 LINE 格子（紧贴己方连线扩展）
- Tier 2：其他格子
- 三层各自内部不排序，直接 concat，最终 `[:20]`

**（六）MinimaxAI 类（移植自 ai_engine.py.MinimaxAI）：**

```js
export class MinimaxAI {
  constructor(depth = 3) {
    this.depth = depth;
  }

  // 返回 [x,y][]，从 engine.getLegalMoves(player) 提取 .point 字段
  getLegalMoves(engine, player) { ... }

  // 与 Python 版完全一致的 alpha-beta minimax
  // 注意：engine.getLegalMoves(engine.currentPlayer) 每层调用一次即可
  minimax(engine, depth, alpha, beta, maximizingPlayer, aiPlayer) { ... }

  // 返回 [{point: [x,y], score: number}, ...]，按 score 降序，最多 topN 个
  getTopMoves(engine, aiPlayer, topN = 5) { ... }
}
```

minimax 中处理无合法落点的情况：存档 → consecutiveSkips += 1 → 若 >= activePlayers.length（2人局>=2，3人局>=3）则 gameOver=true，否则切换 currentPlayer → 递归 → 还原。

**重要约束：**
- 文件中不能有任何 `window`、`document`、`canvas`、Vue 相关代码（必须能在 Web Worker 中运行）
- 不要修改任何现有文件
- 文件顶部 import：`import { GameEngine, Player, PointState } from "./GameEngine.js";`
- 文件底部导出：`export { MinimaxAI, evaluate, fastTerritoryBFS, saveState, restoreState };`
- 3人局的 evaluate 中，`territory_advantage` 对手取 `activePlayers` 中棋子（nodes）最多的那个，避免多对手求和导致评分失去方向性

---

## Task 2A：棋盘舱 AI 对战

> **前置条件：Task 1 已完成（AIEngine.js 存在）。** 将以下提示词粘贴给 AI。

---

你需要在一个三角格棋盘游戏的网页端本地对局模式中加入 AI 对手功能。

**项目背景：**
- 前端用 Vue 3（CDN 版，composition API via `globalThis.Vue`），主入口：`web/web前端/OnlineApp.js`
- 游戏逻辑：`web/web前端/GameEngine.js`，控制层：`web/web前端/GameController.js`
- AI 引擎：`web/web前端/AIEngine.js`（已完成，导出 `MinimaxAI`）
- i18n：`web/web前端/OnlineAppI18n.js`（中英双语）
- 本地对局模式（棋盘舱）和联机模式都在 `OnlineApp.js` 中，本任务**只修改本地对局相关部分，联机代码一行不动**

**第一步：阅读以下文件：**

1. `web/web前端/OnlineApp.js` — 完整阅读，重点找：
   - 本地对局（棋盘舱）的设置面板在哪里（找 `boardDock`、`gameSettings` 或类似结构）
   - `GameController` 的创建和 `resetGame()` / `setGameConfig()` 的调用位置
   - 游戏状态监听：`onStateChange` 回调，状态对象的结构（`currentPlayer`、`gameOver` 等）
   - 棋盘点击如何处理（找 canvas 点击 → controller 的调用链）
2. `web/web前端/GameController.js` — 了解 `controller.engine`、`controller._applyMove(point)`、`controller.skipTurn()`、`controller.multiplayerEnabled`
3. `web/web前端/AIEngine.js` — 了解 `MinimaxAI.getTopMoves(engine, player, topN)` 接口
4. `web/web前端/OnlineAppState.js` — 了解 `normalizeGameSettings` 和 settings 存储结构

**第二步：创建文件 `web/web前端/AIWorker.js`（Web Worker）：**

```js
// AIWorker.js — 在 Web Worker 线程中运行 minimax，避免阻塞 UI
// 接收消息格式：
// { type: 'COMPUTE', serializedState: {...}, aiPlayer: 'WHITE'|'BLACK'|'PURPLE', depth: number, topN: number }
// 发送消息格式：
// { type: 'RESULT', moves: [{point:[x,y], score:number}, ...] }
// { type: 'ERROR', message: string }
```

Worker 逻辑：
1. 接收 `serializedState`，用它重建 `GameEngine` 实例
2. 用 `restoreState(engine, serializedState)` 恢复棋盘状态（注意：需先 `new GameEngine(...)` 初始化结构，再 restoreState 覆盖动态状态）
3. 运行 `new MinimaxAI(depth).getTopMoves(engine, aiPlayer, topN)`
4. postMessage 结果

序列化 GameEngine 状态的函数（在 OnlineApp.js 中实现，传给 Worker）：

```js
function serializeEngineState(engine) {
  return {
    gridSize: engine.gridSize,
    playerCount: engine.playerCount,
    startPlayer: engine.startPlayer,
    activePlayers: [...engine.activePlayers],
    // 动态状态（restoreState 会覆盖这些）：
    gridEntries: [...engine.grid.entries()], // [[key, state], ...]
    edgesBlack: [...engine.edges.BLACK],
    edgesWhite: [...engine.edges.WHITE],
    edgesPurple: [...engine.edges.PURPLE],
    historyHashes: [...engine.historyHashes],
    consecutiveSkips: engine.consecutiveSkips,
    currentPlayer: engine.currentPlayer,
    gameOver: engine.gameOver,
  };
}
```

Worker 中重建：先 `new GameEngine({ gridSize, playerCount, startPlayer })`，再用 `restoreState` 把序列化的动态状态写回（restoreState 需要从 serializedState 的数组格式重建 Map 和 Set）。

**第三步：修改 `web/web前端/OnlineApp.js`（只改棋盘舱相关）：**

**3.1 设置区新增 AI 模式选项**

在本地对局设置面板中（紧跟玩家数量选项之后），新增：
- **AI 对手**：下拉或单选按钮，选项由 i18n key 映射：
  - `aiModeNone`（`'none'`）—— 默认
  - `aiModeWhite`（`'ai_white'`）—— 我执黑，AI 执白
  - `aiModeBlack`（`'ai_black'`）—— AI 执黑，我执白
- **AI 难度**（仅 aiMode !== 'none' 时显示）：
  - `aiDifficultyEasy` → depth=2
  - `aiDifficultyMedium` → depth=3（默认）
  - `aiDifficultyHard` → depth=4
- 以上设置存入已有的 settings 响应式对象：`settings.aiMode`、`settings.aiDepth`

3人局时 aiMode 禁用（强制 `'none'`），因为 AI 只支持 2 人对战。

**3.2 游戏状态监听——检测是否轮到 AI**

在 `onStateChange` 回调中（或 watch `currentPlayer`），当满足以下条件时触发 AI 落子：
```
!gameState.gameOver
&& !multiplayerEnabled（本地模式）
&& aiMode !== 'none'
&& gameState.currentPlayer === aiPlayer（根据 aiMode 推断：ai_white→WHITE，ai_black→BLACK）
&& !aiThinking（防止重复触发）
```

**3.3 AI 落子流程**

```
aiThinking = true
→ 锁定棋盘点击（canvas pointer-events: none 或 controller 层面的 interactionLocked）
→ 启动 Worker：postMessage({ type:'COMPUTE', serializedState, aiPlayer, depth, topN:5 })
→ Worker 返回 RESULT：
    如果 moves.length > 0：
      取 moves[0].point，调用 controller._applyMove(point)
    else：
      调用 controller.skipTurn()
→ aiThinking = false
→ 解锁棋盘
```

Worker 在游戏开始时创建（`new Worker('./AIWorker.js', { type:'module' })`），游戏结束或模式切换时 terminate。

**3.4 UI 反馈**

- AI 思考时，在状态显示区域（显示"轮到谁"的位置）旁边显示 i18n key `aiThinking` 的文字（"AI 思考中…"）
- AI 思考时棋盘 `cursor: not-allowed`

**3.5 重置游戏时**

`resetGame()` 调用后，同时 terminate 旧 Worker 并重建新 Worker（如果 aiMode !== 'none'）。

**约束：**
- 联机模式（multiplayerEnabled === true）时，AI 相关代码全部不运行
- 不修改 `GameController.js`、`GameEngine.js`、`Renderer.js`
- `settings.aiMode` 和 `settings.aiDepth` 不持久化到 localStorage（每次进入页面默认 `'none'`）

---

## Task 2B：棋盘舱 AI 提示按钮

> **前置条件：Task 1 已完成（AIEngine.js 存在）。** 将以下提示词粘贴给 AI。

---

你需要在一个三角格棋盘游戏网页端的本地对局模式中，新增一个 AI 提示按钮，点击后在棋盘上高亮显示推荐落点。

**项目背景：**
- 前端用 Vue 3（CDN 版），主入口：`web/web前端/OnlineApp.js`
- 游戏逻辑：`web/web前端/GameEngine.js`，控制层：`web/web前端/GameController.js`
- 渲染：`web/web前端/Renderer.js`，负责 Canvas 绘制
- AI 引擎：`web/web前端/AIEngine.js`（已完成，导出 `MinimaxAI, saveState, restoreState`）
- i18n：`web/web前端/OnlineAppI18n.js`
- 本任务**仅修改本地对局（棋盘舱）部分，联机代码一行不动**

**第一步：阅读以下文件：**

1. `web/web前端/OnlineApp.js` — 找到本地对局状态显示区域（显示"轮到谁"的模板位置）；找 skip 按钮的实现作为参考样式
2. `web/web前端/Renderer.js` — 了解 `render(snapshot)` 方法，Canvas 绘制逻辑，以及 `getPointPixelCoordinates(point)` 方法（用于把格点坐标转换为像素坐标）
3. `web/web前端/GameController.js` — 了解 `controller.engine`（直接访问 GameEngine 实例）、`controller.getGameState()`
4. `web/web前端/AIEngine.js` — 了解 `MinimaxAI(depth).getTopMoves(engine, player, topN)` 接口，以及 `saveState`、`restoreState`

**第二步：修改 `web/web前端/Renderer.js`**

在 Renderer 类中新增提示点高亮功能：

```js
// 新增属性（在 constructor 中初始化）
this.hintPoint = null;           // [x, y] 或 null
this._hintPulsePhase = 0;        // 动画相位 0~1 循环
this._lastHintTimestamp = 0;

// 新增公共方法
setHintPoint(point) {
  this.hintPoint = point ? [point[0], point[1]] : null;
  this._hintPulsePhase = 0;
}
clearHintPoint() {
  this.hintPoint = null;
}
```

在每帧渲染中（`render(snapshot)` 方法末尾，或专门的 `_drawHint(timestamp)` 方法），若 `this.hintPoint !== null`：
1. 用 `getPointPixelCoordinates(this.hintPoint)` 获取像素坐标
2. 绘制脉冲圆圈：半径在 `cellSize * 0.25` ~ `cellSize * 0.4` 之间随时间振荡（用 `Date.now()` 或 `requestAnimationFrame` 的 timestamp 做正弦波），颜色 `rgba(255, 215, 0, 0.7)`（金色半透明），描边 `rgba(255, 165, 0, 0.9)`，线宽 2px
3. 使 render 在 hintPoint 存在时每帧都被调用（而不是只在落子时调用）

**第三步：修改 `web/web前端/OnlineApp.js`（只改本地对局相关）**

**3.1 组件 data 中新增：**
```js
hintRemainingCount: 3,   // 每局初始3次，每次使用扣1
hintThinking: false,     // 正在计算提示时为 true
```

每局重置（`resetGame` 调用时）：`hintRemainingCount = 3`

**3.2 提示按钮 UI**

在本地对局状态区域（显示当前玩家/回合信息的位置），新增一个小按钮：
- 文字：用 i18n key `hintRemaining`，传入 `{n: hintRemainingCount}`（格式如 "提示 (3)"）
- 仅在以下条件下**可点击**：
  ```
  !gameState.gameOver
  && !multiplayerEnabled
  && hintRemainingCount > 0
  && !hintThinking
  && （当前不是 AI 回合，或 aiMode === 'none'）
  ```
- 次数用完（`hintRemainingCount === 0`）时：按钮变灰，文字改为 i18n key `hintExhausted`（"提示已用完"）
- 样式参考 skip 按钮，但更小（`font-size: 0.85em`，`padding: 4px 10px`）

**3.3 点击提示按钮的处理函数 `requestHint()`：**

```js
async function requestHint() {
  if (hintRemainingCount <= 0 || hintThinking) return;

  hintThinking = true;
  const currentPlayer = controller.engine.currentPlayer;

  // 用 saveState 深拷贝当前 engine 状态，再在拷贝上运行 AI
  // 直接在 controller.engine 上运行会破坏状态，必须克隆
  const snapshot = saveState(controller.engine);
  
  // 创建临时 engine 实例，还原状态，再运行 AI
  const tempEngine = new GameEngine({
    gridSize: controller.engine.gridSize,
    playerCount: controller.engine.playerCount,
    startPlayer: controller.engine.startPlayer,
  });
  restoreState(tempEngine, snapshot);

  const ai = new MinimaxAI(2); // depth=2 保证速度
  let moves = [];
  try {
    moves = ai.getTopMoves(tempEngine, currentPlayer, 1);
  } catch (e) {
    // 忽略错误
  }

  hintThinking = false;

  if (moves.length === 0) {
    // 显示短暂提示文字"暂无推荐落点"，不扣次数
    showHintNoMoves(); // 用已有的 toast/状态消息机制，或直接 console
    return;
  }

  hintRemainingCount -= 1;
  const hintPoint = moves[0].point;
  controller.renderer.setHintPoint(hintPoint);

  // 4秒后自动清除
  setTimeout(() => {
    controller.renderer.clearHintPoint();
  }, 4000);
}
```

**3.4 落子后清除高亮**

在 `onStateChange` 回调中（每次棋盘状态变化时），调用 `controller.renderer.clearHintPoint()`。

**3.5 Renderer 持续渲染**

当 `hintPoint` 不为 null 时，Renderer 需要持续重绘以显示动画。在 Renderer 中增加一个 `_animationFrameId`，当 `setHintPoint` 被调用时启动 `requestAnimationFrame` 循环调用 `_renderHintAnimation()`；当 `clearHintPoint` 被调用时取消循环。`_renderHintAnimation` 只重绘提示层（不重绘完整棋盘），或直接调用完整 `render(lastSnapshot)`（需要缓存最近一次 snapshot）。

**约束：**
- 联机模式下提示按钮不显示（用 `v-if="!multiplayerEnabled"` 控制）
- 不修改 `GameController.js`、`GameEngine.js`
- `hintRemainingCount` 不持久化

---

## Task 2C：国际化文字

> **可与 Task 2A、2B 并行执行。** 将以下提示词粘贴给 AI。

---

你需要为一个三角格棋盘游戏网页端的 i18n 模块新增 AI 功能相关的中英文文字。

**第一步：阅读 `web/web前端/OnlineAppI18n.js`**

完整阅读该文件，了解：
- `EN_TEXTS` 和 `ZH_TEXTS`（或类似命名）两个对象的结构
- 已有 key 的命名风格（camelCase）
- `getTexts(language)` 或类似函数的返回方式
- 是否有辅助函数（如 `formatPlayerName`）可作为参考

**第二步：在 `EN_TEXTS` 和 `ZH_TEXTS` 中分别添加以下 key**

AI 对战模式选择相关：
| Key | 中文值 | 英文值 |
|-----|--------|--------|
| `aiOpponent` | `"AI 对手"` | `"AI Opponent"` |
| `aiModeNone` | `"人人对战"` | `"Human vs Human"` |
| `aiModeWhite` | `"我执黑 vs AI"` | `"Me (Black) vs AI"` |
| `aiModeBlack` | `"AI vs 我执白"` | `"AI vs Me (White)"` |
| `aiDifficulty` | `"AI 难度"` | `"AI Difficulty"` |
| `aiDifficultyEasy` | `"简单"` | `"Easy"` |
| `aiDifficultyMedium` | `"普通"` | `"Medium"` |
| `aiDifficultyHard` | `"困难"` | `"Hard"` |
| `aiThinking` | `"AI 思考中…"` | `"AI thinking…"` |

AI 提示按钮相关：
| Key | 中文值 | 英文值 |
|-----|--------|--------|
| `hintButton` | `"提示"` | `"Hint"` |
| `hintRemaining` | `"提示 ({n})"` | `"Hint ({n})"` |
| `hintExhausted` | `"提示已用完"` | `"No hints left"` |
| `hintNoMoves` | `"暂无推荐落点"` | `"No suggestion available"` |

`hintRemaining` 中的 `{n}` 是占位符，调用方会传入剩余次数。对照文件中已有的占位符替换函数（如 `replace(/{(\w+)}/g, ...)`）保持一致。如果文件中没有这种机制，就新增一个简单的辅助函数：
```js
export function formatHintRemaining(texts, n) {
  return texts.hintRemaining.replace('{n}', n);
}
```

**约束：**
- 只修改 `OnlineAppI18n.js`，不修改其他文件
- 新增的 key 插入到各文本对象末尾，保持与已有风格一致（相同缩进、引号风格）
- 如果文件中存在导出函数（`getTexts` 等），不要改动这些函数的签名或逻辑
