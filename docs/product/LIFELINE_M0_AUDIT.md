# LIFELINE Lab M0 基线审计

审计日期：2026-09-21  
范围：`C:\coding\py\line game` 当前检出。只读取根 README、Web 前端入口、`GameEngine`、`GameController`、`OnlineApp`、AI Worker、`GuideContent`、现有测试、`docs/LIFELINE_LAB_PLAN.md` 与 `docs/LIFELINE_TASK_LEDGER.md`。  
执行边界：未启动服务器，未访问或核验线上页面，未训练，未启动长任务，未修改游戏源代码，未运行测试脚本；本报告是静态代码/文档审计，不把测试源码中的断言当作当前运行通过证据。

## 1. 结论摘要

当前仓库能支持的真实 Web 基线是：打开一个依赖 Vue/MathJax CDN 的页面，进行 `territory-v2` 本地双人或三人对局；双人局可选择浏览器内 Minimax AI 先手/后手，另有一次性提示 Worker；规则引擎包含切断、断联清除、领土、Superko、跳过、认输和终局计分；客户端还实现了账号、房间、准备、倒计时、动作同步、重置投票/重置和重连恢复的协议路径。证据见 `README.md:11-17,23-29,100-109,128-158`、`web/web前端/index.html:21-26`、`web/web前端/main.js:1-10,67-123`、`web/web前端/GameController.js:13-18,274-365`、`web/web前端/OnlineApp.js:2506-2607,3198-3370,3529-3659`。

当前不能据仓库宣称的能力包括：交互式教学关卡、用户可见棋谱/时间轴复盘、棋谱导入导出、每步自动保存并刷新恢复、神经网络 AI 已接入 Web、线上部署与当前仓库同版本。计划本身将这些列为待办或待确认，代码也没有对应用户流程入口。证据见 `docs/LIFELINE_LAB_PLAN.md:33-46,69-88,94-116,242-249`、`web/web前端/OnlineAppState.js:118-153`、`web/web前端/GameController.js:777-947`、`web/web前端/OnlineApp.js:1661-1689,4472-4701`。

## 2. 当前真实可用能力

| 能力 | 静态基线 | 证据 |
|---|---|---|
| 页面入口 | `index.html → main.js → OnlineApp.js`；先从多个 CDN 加载 Vue，再动态导入应用模块。页面还通过 MathJax CDN 加载公式渲染。 | `web/web前端/index.html:7-26`；`web/web前端/main.js:1-10,67-123` |
| 本地规则对局 | `GameEngine` 支持 2/3 人、5–15 边长；页面设置实际只给 6–15；控制器默认 `territory-v2`、双人、边长 9。 | `web/web前端/GameEngine.js:1-8,168-227,230-242`；`web/web前端/OnlineAppState.js:8-18,20-47`；`web/web前端/GameController.js:13-18` |
| 规则动作 | 落子连接、敌方线切断、断联清除、三点限制、起点保护、Superko、自动跳过、认输、离散 area 终局计分。 | `web/web前端/GameEngine.js:575-621,783-865,1452-1497,1623-1707,1824-1917` |
| 本地对手 AI | 仅双人本地 AI 对手；Worker 中运行 Minimax/Alpha-Beta，界面提供深度 2/3/4，搜索最多保留前 20 个候选。 | `web/web前端/OnlineApp.js:769-839,2506-2607`；`web/web前端/AIEngine.js:183-207,209-322`；`README.md:111-132` |
| 提示 | 本地、非 AI 回合可请求一次性提示；默认深度 2、返回 Top-1，并有可配置次数。提示 Worker 有请求/引擎/版本/回合校验。 | `web/web前端/OnlineApp.js:3419-3527`；`web/web前端/AIStateProtocol.js:25-61`；`web/web前端/tests/verify-hint-worker.mjs:387-407` |
| 联机客户端流程 | 有登录/注册 HTTP 请求、WebSocket 连接、创建/加入房间、准备、开始倒计时、移动/跳过/认输/重置/聊天事件、断线重连与房间快照恢复代码。 | `web/web前端/OnlineApp.js:151-195,3529-3659,4193-4353`；`web/web前端/NetworkManager.js:40-59,208-305,477-604` |
| 联机恢复 | 进入临时引擎批量回放；完整成功后才替换当前引擎；失败保留旧盘并锁定联机交互。只支持内部 `player_move/player_skip/player_resign` 动作恢复。 | `web/web前端/GameController.js:777-947` |
| 规则说明 | 有中英文规则、战争叙事、数学/理论和致谢内容；规则图片存在于 `web/web前端/guide/guide-images/`，页面以阅读器弹窗展示。 | `web/web前端/GuideContent.js:279-465,486-638,714-910`；`web/web前端/OnlineApp.js:2197-2293,4650-4674` |
| 现有验证基础 | 有 territory-v2、AI 控制流、提示 Worker、联机恢复、领土 Worker 等脚本；脚本的最终输出是断言摘要。 | `web/web前端/tests/verify-territory-v2.mjs:675-694`；`verify-ai-control-flow.mjs:305-318`；`verify-online-recovery.mjs:883-895`；`verify-territory-worker.mjs:642-672` |

“可用”在本表中表示代码路径和静态测试入口存在，不表示本审计已经证明浏览器、生产服务器、移动端或当前线上资源可用。

## 3. 代码与 README/计划的不一致

1. **品牌仍然混用 LIFELINE 与 TriAxis。** 根 README 使用 LIFELINE；启动失败文案、应用组件名和本地存储键仍使用 TriAxis。启动失败时用户会看到 TriAxis，且旧存储键可能继续影响会话/语言。证据：`README.md:1`；`web/web前端/main.js:27-43,101-119`；`web/web前端/OnlineApp.js:2383-2385,2616-2622`；`web/web前端/OnlineAppState.js:5-7`。建议列为 P1 发布一致性问题。

2. **README 的“三人局当前不启用 AI”与提示路径不完全一致。** AI 对手按钮确实在非双人时禁用，且自动对手只允许 `playerCount === 2`；但提示 UI 只按 `hintEnabled` 显示，`getCurrentHintEngine()` 没有排除三人局，仍可将三人局交给普通 Minimax。若产品意图是三人完全没有 AI，这会是行为与文档不一致；若允许三人提示，则 README 需要明确“无 AI 对手、可选提示”，并确认评估语义不是误称为双人 Minimax。证据：`README.md:128-132`；`web/web前端/OnlineApp.js:769-839,3450-3467,1461-1469`。

3. **计划的用户闭环尚未在页面实现。** 计划要求“打开网站 → 交互教学 → 和 AI 下一局 → 看懂结果 → 回放关键一步 → 规则解释 → 导出棋谱”，但页面当前只有棋盘、设置、联机、指南阅读器和结果弹窗；没有 `TutorialRunner`、Replay 页面、时间轴或导出按钮。内部 `replayBatch`/`restoreMatchState` 是事务与联机恢复接口，不是用户复盘产品。证据：`docs/LIFELINE_LAB_PLAN.md:29,67-88,92-116,163-173`；`web/web前端/OnlineApp.js:2197-2293,4472-4701`；`web/web前端/GameController.js:777-947`。这是 M0 必须先定范围的 P0 产品缺口。

4. **计划要求的本地对局自动保存/刷新恢复尚未实现。** `persistSession()` 保存的是 URL、房间 ID、玩家 ID、颜色和设置；`syncSession()` 也只组装设置。没有本地 action log、棋盘快照或 Superko 历史的保存入口。刷新本地对局会重新创建引擎。证据：`docs/LIFELINE_LAB_PLAN.md:84-88,94-98`；`web/web前端/OnlineAppState.js:118-153`；`web/web前端/OnlineApp.js:2795-2811,3435-3448`。这是 P0。

5. **规则指南的数学部分没有标明版本，也只写双人 Black/White 锚点。** 当前引擎支持 Purple 和三人出生点；指南数学段落却把游戏定义为双人，并只定义两个锚点。它可以作为双人理论说明，但不能直接当作三人 `territory-v2` 的完整规则契约。证据：`web/web前端/GuideContent.js:320-363,422-465`；对照 `web/web前端/GameEngine.js:70-83,184-191` 与 `README.md:100-107`。建议 P1 修正文案并显式注明适用版本。

6. **资源缓存版本不统一，存在线上拿到混合版本的风险。** `index.html` 的 CSS 查询串为 `20260611a`，入口模块为 `20260910d`；应用又按 `20260508a` 请求指南 Markdown，内部模块还分别使用 `20260910c`、`20260830a`、`20260430d`。这不一定是功能错误，但发布时必须用部署清单/哈希确认整套资源属于同一提交。证据：`web/web前端/index.html:7,26`；`web/web前端/main.js:6,90-93`；`web/web前端/OnlineApp.js:1-45`。建议 P1。

## 4. 规则版本边界

| 层 | 当前边界 | 审计判断 |
|---|---|---|
| Web 页面/新建房间 | 页面状态默认 `territory-v2`；控制器默认也是 v2；设置允许传入 v1 或 v2。 | 这是首版应冻结的产品规则入口。证据：`web/web前端/OnlineAppState.js:17-47`；`web/web前端/GameController.js:13-18,255-271`。 |
| 裸引擎 | `new GameEngine()` 未传版本时默认 `territory-v1`，版本创建后不可写；v1/v2 的领土计算分支不同。 | 任何直接调用、旧测试、Worker 快照都必须带 `rulesVersion`，不能以裸构造器代表 Web 页面规则。证据：`web/web前端/GameEngine.js:168-186,1452-1476`。 |
| 规则状态 | 有效状态至少包括棋盘、显式边、行动方、认输集合、跳过计数、终局标志、回合数和 Superko 历史；Worker 协议保留主要字段。 | 棋谱/恢复不能只存棋盘图。证据：`web/web前端/GameEngine.js:193-227,1718-1768`；`web/web前端/AIStateProtocol.js:5-22`。 |
| Superko | 哈希包含下一行动方、认输集合、非空格点和各方显式边；`skipTurn()` 不写历史哈希，`turnCount`/`consecutiveSkips`/`gameOver` 不在哈希中。 | 这是当前实现边界，不应在用户文案中笼统写成“所有完整状态都进入 Superko”。证据：`web/web前端/GameEngine.js:1479-1497,1873-1888,1891-1917`。 |
| 几何/棋盘 | 引擎合法点为 `x + y < gridSize`；引擎接受边长 5–15，但页面选项是 6–15，默认 9。 | `5` 是底层兼容/测试能力，不是当前页面公开选项。证据：`web/web前端/GameEngine.js:1-3,230-242,277-290`；`web/web前端/OnlineAppState.js:8-10,38-47`。 |
| Python/Pygame 与研究 | README 将 Python/Pygame 标为 legacy v1 lineage，研究目录不随页面升级自动迁移。 | 旧棋谱、旧模型、研究 witness 不得直接贴到 Web v2。证据：`README.md:100-107`；`docs/LIFELINE_LAB_PLAN.md:48,108-116`。 |

## 5. 首局五条用户流程风险

计划定义的五项首轮任务是“不听指导完成教学、下一局、说明胜负、找到一次切断的回放、导出并恢复棋谱”（`docs/LIFELINE_LAB_PLAN.md:200-216`）。按当前仓库逐项审计如下：

| 流程 | 当前状态与主要风险 | 证据 |
|---|---|---|
| 1. 不听口头指导完成教学 | **高风险/不可完成为计划意义上的教学。** 当前是指南阅读器和静态图文，没有逐动作关卡、可跳过/重玩、真实引擎验证的教学 runner。 | `docs/LIFELINE_LAB_PLAN.md:67-73`；`web/web前端/OnlineApp.js:2197-2293,4650-4666`；`web/web前端/GuideContent.js:279-465` |
| 2. 下一局：和 AI 完成一局 | **代码路径存在，真实体验未证实。** 仅双人本地 AI 对手可用；AI Worker 出错时主要 `console.error` 后终止，没有页面级重试/降级提示；首屏还依赖 CDN。三人只能本地对局，不能启用 AI 对手。 | `web/web前端/OnlineApp.js:2506-2607`；`web/web前端/index.html:21-26`；`README.md:128-132` |
| 3. 看懂结果并说明胜负 | **可显示结果，但解释深度不足。** 引擎能算离散 area、winner/draw，结果弹窗能展示比分/认输摘要；没有“哪一步造成了什么”或可核验的规则事件解释。 | `web/web前端/GameEngine.js:476-505`；`web/web前端/OnlineApp.js:1585-1689`；计划要求见 `docs/LIFELINE_LAB_PLAN.md:94-100` |
| 4. 找到一次切断的回放 | **当前不可作为用户流程完成。** 引擎和控制器能内部回放动作并恢复联机快照，但页面没有动作历史、回放入口、时间轴或切断事件列表。 | `web/web前端/GameController.js:777-947`；`web/web前端/OnlineApp.js:4472-4701`；计划要求见 `docs/LIFELINE_LAB_PLAN.md:92-116` |
| 5. 导出并恢复棋谱 | **当前不可完成。** 没有导出/导入 UI 或 ReplayCodec；localStorage 仅保存联机会话与设置，不能恢复本地棋局的 action/historyHashes。 | `web/web前端/OnlineAppState.js:118-153`；`web/web前端/OnlineApp.js:2795-2811`；计划要求见 `docs/LIFELINE_LAB_PLAN.md:94-98,116` |

## 6. 总控需要先验证的线上/仓库差异

本次没有访问线上，因此以下不是“线上故障结论”，而是上线前必须由总控用同一时间点证据关闭的差异项：

1. **部署身份与资源哈希：** 仓库没有固定生产 URL；WebSocket 默认从当前页面 host 推导（`web/web前端/NetworkManager.js:40-59`）。需要记录线上 HTML、`main.js`、`OnlineApp.js`、`GameEngine.js` 及 CSS/指南资源的 URL、响应哈希、构建时间和 Git commit，并与当前检出比较。否则不能把仓库能力当作线上能力。
2. **线上是否仍是 v2：** 对线上新建本地局和房间分别读取实际快照/设置，确认 `rulesVersion`、默认边长、玩家数和出生点；重点排除线上旧 bundle 仍使用 v1 或旧评分逻辑。仓库边界见 `web/web前端/GameEngine.js:174-186`、`web/web前端/OnlineAppState.js:20-47`。
3. **线上联机闭环：** 用两个独立浏览器完成注册/登录、建房/入房、准备、倒计时、双方落子、跳过/认输、重置投票、离房、断线后恢复，并保存每个事件 payload 与双方最终状态。客户端只是事件协议路径；根 README 明确后端转发动作而不裁决三角棋盘规则（`README.md:134-158`）。
4. **线上仓库差异与陈旧缓存：** 校验线上是否加载了 `index.html:7,26` 和当前模块查询串；如果 HTML、入口、Worker、指南资源来自不同发布批次，需先确定一个完整资源集合再做功能判断。代码中的多版本串见 `web/web前端/OnlineApp.js:1-45`。
5. **神经网络 AI 的真实位置：** 计划只记录了历史 Topology-GNN + PUCT 部署线索，同时明确当前检出未见对应前端模块（`docs/LIFELINE_LAB_PLAN.md:39-46`）。总控应分别检查线上路由/静态资源、仓库分支、模型文件哈希、模型规则版本和浏览器调用链；在没有这些证据前，当前能力只能写 Minimax，不得写成已接入神经网络 AI。
6. **真实浏览器与移动端覆盖：** 现有联机恢复脚本把前端源码改写成 data URL，并用 Renderer/Network/Worker stub（`web/web前端/tests/verify-online-recovery.mjs:31-80`）；领土 Worker 测试使用 `FakeWorker`（`web/web前端/tests/verify-territory-worker.mjs:15-38`），其自身也注明不覆盖真实浏览器 Worker-thread/canvas timing（`verify-territory-worker.mjs:642-672`）。总控必须另做 Chrome/Edge 和至少一台真实手机浏览器检查。
7. **测试当前提交状态：** README 列出验证脚本（`README.md:233-245`），但本审计未运行它们；总控在确认源码/线上身份后再运行与版本对应的脚本，并保存命令、Node/Python 版本、完整输出和时间戳。

## 7. 建议排序

### P0：在对外宣称闭环前完成

1. **冻结 Web 首版规则契约。** 明确 Web 只用 `territory-v2` 还是保留 v1 兼容入口；把规则版本、棋盘范围、Superko key、跳过/认输语义写进一份可测试契约，并修正三人指南的适用边界。证据：`web/web前端/GameEngine.js:174-186,1479-1497`；`docs/LIFELINE_LAB_PLAN.md:48,94-106`。
2. **把五条首局流程标成“已实现/未实现”，不要以内部接口代替产品能力。** 若 M0 后立即做 M1/M2，应优先实现教学第一关、动作历史、版本化棋谱、导出/导入和本地刷新恢复；若暂不实现，应从当前发布描述中删除复盘/导出/恢复承诺。证据：`docs/LIFELINE_LAB_PLAN.md:29,86,94-116`；`web/web前端/OnlineAppState.js:118-153`。
3. **关闭线上身份门。** 在没有线上 commit/资源哈希、双端联机记录和 v2 快照证据前，不发布“线上可用”或“神经网络 AI 已上线”。证据：`docs/LIFELINE_LAB_PLAN.md:39-46,242-244`；`README.md:23-45`。
4. **补 AI 可见失败状态。** Worker 超时、异常、取消、空结果要有用户可见状态和重试/降级；保留已有 request/revision/rules/player 防旧结果落子的保护。证据：`web/web前端/OnlineApp.js:2515-2557`；`web/web前端/AIStateProtocol.js:25-61`；`web/web前端/tests/verify-hint-worker.mjs:387-407`。

### P1：核心闭环稳定后处理

1. **统一 LIFELINE/TriAxis 品牌和存储键迁移策略。** 证据：`README.md:1`；`web/web前端/main.js:27-43`；`web/web前端/OnlineAppState.js:5-7`。
2. **决定三人提示的产品语义。** 禁用三人提示，或实现并明确三人评估/候选含义；不能同时写“Web 三人不启用 AI”又开放未说明的 Minimax 提示。证据：`README.md:128-132`；`web/web前端/OnlineApp.js:769-839,3450-3467`。
3. **固定资源依赖和 cache-busting 发布清单。** 至少把 Vue/MathJax、入口、Worker、指南 Markdown 和图片绑定到可回滚版本。证据：`web/web前端/index.html:7-26`；`web/web前端/main.js:1-6,88-106`；`web/web前端/OnlineApp.js:1-45,2637-2654`。
4. **做真实端到端联机与移动端验收。** 现有脚本适合回归协议边界，不足以证明真实 WebSocket、Canvas、浏览器 Worker 与网络抖动下的体验。证据：`web/web前端/tests/verify-online-recovery.mjs:31-80`；`web/web前端/tests/verify-territory-worker.mjs:15-38,642-672`。

### P2：当前不阻塞首局

1. **神经网络 AI、PUCT/Topology-GNN 线上接入和三人神经网络 AI**：先完成模型来源、规则兼容、浏览器性能和可解释字段核验，再决定是否开放。证据：`docs/LIFELINE_LAB_PLAN.md:120-130,190,194-196`。
2. **云端棋谱库、公开排位、防作弊、用户自定义规则、在线训练和移动原生 App**：计划已经列为 P2；当前后端只转发联机动作，不足以承担公开竞争裁决。证据：`docs/LIFELINE_LAB_PLAN.md:175,192-198`；`README.md:148-158`。
3. **实验室检查器和精选研究展品**：等版本化棋谱和只读快照契约稳定后接入，研究 v1 witness 必须显式标注，不能混入 Web v2 对局。证据：`docs/LIFELINE_LAB_PLAN.md:102-116`。

## 8. M0 状态

M0 的静态仓库基线已形成；线上能力、当前部署版本、真实浏览器/手机首局和现有测试在当前提交上的实际运行结果仍是 **未验证**。因此当前最安全的首版表述是：

> 仓库包含 `territory-v2` Web 规则引擎、本地双人/三人对局、双人 Minimax AI、提示 Worker、指南阅读器和联机客户端代码；用户教学、保存/恢复、棋谱复盘/导出、神经网络 AI 与线上同版本状态尚未由本 M0 审计确认。

