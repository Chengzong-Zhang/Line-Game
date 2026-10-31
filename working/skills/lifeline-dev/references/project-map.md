# 项目入口与规则验证

2026-10-25 核对。文件路径相对选定仓库根目录；主树与平台工作树可能处于不同版本。以下是定位地图，不是功能、线上或验证状态报告。路径不存在时用 `rg --files` 定向查找，不扫描整个实验产物树。

## 产品资料和架构

主工作树的产品规范位于 `working/docs/product/`，任务位于 `working/task/`；较旧 checkout 可能仍在 `docs/`；其中旧 v1/v2 基线仅用于理解历史，不能覆盖当前源码与新版本契约。

| 判断内容 | 入口 |
| --- | --- |
| 启动、架构与当前功能 | `README.md`；`web/start/` 的实际启动入口 |
| Play / Replay / Lab / About | `working/docs/product/LIFELINE_LAB_PLAN.md`、`LIFELINE_TASK_LEDGER.md` |
| 教学、棋谱和保存恢复 | `working/docs/product/LIFELINE_TUTORIAL_SPEC.md`、`LIFELINE_REPLAY_SPEC.md` |
| 模型适用范围、研究展品 | `working/docs/product/LIFELINE_AI_COMPATIBILITY.md`、`LIFELINE_RESEARCH_EXHIBITS.md` |
| 发布证据分类 | `working/docs/product/LIFELINE_RELEASE_GATE.md`，结合本次候选与渠道验收 |
| 棋盘与多人配置 | `working/docs/product/LIFELINE_HEX_BOARD_20261020.md`、当前引擎和设置规范 |
| 联机设置/悔棋历史反例 | `working/docs/verification/online-settings-undo-20261024.md`，只作回归入口 |

首局尽量不依赖注册，教学先操作再解释且可重玩/跳过。无效落子保留状态并解释原因；AI 等待、取消、重试或降级可见；确认行动后保存。手机关注棋盘点击精度、触控尺寸、布局溢出、前后台和减少动态效果。已有成熟功能按本次范围保留。

### Web 模块

以下模块位于 `web/web前端/`，复用其职责，不继续把所有功能堆进 `OnlineApp.js`。

| 模块 | 职责 |
| --- | --- |
| `GameEngine.js` | Web 规则真源：节点/边、合法步、切断与断联、历史、PASS/认输、计分和终局 |
| `GameController.js`、`Renderer.js` | 对局编排、输入、Canvas、默认设置与实际反馈 |
| `OnlineApp.js`、`OnlineAppState.js`、`OnlineAppI18n.js` | 应用状态、设置入口和中英文业务文案 |
| `NetworkManager.js`、`OnlineRoomSync.js` | 房间归属、事件顺序、设置与重连 |
| `AIEngine.js`、`AIWorker.js`、`AIStateProtocol.js` | 搜索、完整 Worker 状态和请求有效性 |
| `MultiplayerRuntime.js`、`MultiplayerStandardDefense.js` | 多人档位实际路由、模型加载和攻防/PASS 相关策略 |
| `LocalAIWorkerFactory.js`、`MultiplayerHardAIWorker.bundle.mjs` 及 manifest | 本地/打包 Worker 路由；修改依赖后同步重建和校验 |
| `HintWorkerSession.js`、`TerritoryWorkerSession.js`、`TerritoryWorker.js` | 提示/领土任务调度、取消、超时、缓存和过期响应 |
| `LocalGameSession.js`、`ReplayCodec.js`、`TutorialRunner.js` | 存档、版本化棋谱、隔离重放和教学 |
| `ResearchAI.js`、`ModelFreeAI.js`、`assets/research-ai/manifest.json` | 模型接入及来源；同时查看本次实际采用的模型 manifest |
| `GuideContent.js`、`GuideImplementation.js`、`guide/` | 规则短文、数学说明、Code 文章及其生成源 |
| `index.html`、`main.js`、`styles.css` | 入口、装配、样式和资源缓存版本 |

后端从 `web/web后端/server.py`、`game_router.py` 进入。设置、行动日志、房间归属、重连与悔棋投票必须沿客户端到服务端检查。旧转发式联机不能据此宣称具备完整服务端规则裁决/防作弊。先确认实际服务、端口和当前 handler，再按任务验证。

Python/Pygame 入口为 `core algorithm/triangular_game.py`、`algorithm-requirements.md` 和 `AI/`。当前已包含 v3 计分相关修复，但不能推断与 Web 的全部规则/状态逐步等价。研究环境位于 `research/iclr2027/lifeline_rl/`，遵守各自冻结协议，不能随产品规则更新自动改写。

拓扑棋盘与完整多起点/顺序另见 [拓扑与完整状态](topology-and-state.md)，不能将常规 v3 的边界泛洪公式直接套用到闭合曲面。指南/仓库整理见 [仓库与指南维护](repository-maintenance.md)。

## v3 计分及版本

令 `F_i` 为己方节点和线覆盖的格点集合。在当前有效棋盘图中移去 `F_i`，从棋盘边界泛洪；剩余不与外界连通的分量逐个检查。令 `B_i` 为其中不含任何敌方节点/线点的分量并集，则：

`area_i = |F_i| + |B_i|`

- 单节点、单线和开放链的己方点始终计分；多个安全空腔、甜甜圈内孔分别计入，同点不重复。
- 含敌方元素的空腔整块排除，不能只减敌方点数。依赖当前棋盘邻接和边界，不按画面像素判断。
- `GameEngine.js::_computeOwnedWallArea` 与 Python `_compute_owned_wall_area` 是定位入口；检查无闭环返回分支和最终分数都采用正式计分。
- `displayArea`、鞋带面积、收紧轮廓和 AI 快速估值用于不同目的。正式分数正确不证明多空腔填色正确；绘制与比分分别验收。
- 2026-10-25 主树 `GameController.js` 和 `server.py` 新局默认为 v3，裸引擎仍默认 v1。核对新本地局、新房间、旧房退出/注销后重开；恢复/重放保留所存规则。目标平台和线上另查，不沿用主树结论。

规则变更同步：规则真源 → 平台副本/构建输入 → Python 对应实现 → 固定测试 → 规则短文/数学/Code 双语生成源与输出。使用现有生成器而非只编辑生成文件：

~~~powershell
node web/tools/sync-implementation-guides.mjs
node web/tools/sync-implementation-guides.mjs --check
node --unhandled-rejections=strict web/web前端/tests/verify-guide-content.mjs
~~~

这些命令修改/验证所选 checkout 的四篇双语实现文章，不会自动更新其他工作树或已发布包。语义核验仍须检查“闭环才计分”等旧规则是否残留。

## 起点、棋盘、悔棋和联机

- 2–6 人、三角/六角形、默认/随机/自定义起点按当前功能矩阵覆盖。用户原定布局：三角形前三席占顶点，4–6 席依次占外边中点；六边形两席为 1/4、三席为 1/3/5。偶数边中点选择需确定且预览一致。
- 断联清理按显式逻辑连接能否到达该方配置起点判断；不是视觉相邻，也不固定追溯旧角点。核对起点保护、切断和重放。
- 房间随机起点只生成一次并随权威房间设置同步；加入者/重连者不能各自重抽。形状、尺寸、人数、起点、规则、AI 席位与悔棋额度保持一致，非房主不可越权改设置。
- 本地悔棋的用户语义是自己下第 k+1 手前撤回第 k 手及其后回应，保留额度，取消旧 AI 并恢复计时；UI 与提示/读秒同组。当前联机协议是所有真人同意后撤销服务端动作日志最近一步，两种语义不能混用。
- 联机悔棋覆盖同意、拒绝、掉线、重复/过期确认和重连；投票中动作、额度消耗、历史与回合应一致。已有对局和其他玩家房间不能被自动释放。
- 比较跨实现/回放时固定同一版本、形状、尺寸、玩家、起点和动作编码；逐步比较节点、逻辑边、行动方、历史、连续 PASS、认输、终局、离散分数和赢家。缓存、revision 计数和 Worker 时序不要求跨实现相同。

## 按改动选测试

下表脚本在 `web/web前端/tests/`，先读输入/副作用；不是每次全部执行。

| 范围 | 入口 |
| --- | --- |
| v1/v2 兼容与 v3 正式计分 | `verify-territory-v2.mjs`、`verify-territory-v3.mjs`、`verify-territory-v3-hard-worker.mjs` |
| 棋盘、起点、保存恢复 | `verify-board-shapes.mjs`、`verify-starting-points.mjs`、`verify-starting-point-session.mjs` |
| 本地与联机悔棋 | `verify-local-undo.mjs`、`verify-online-start-undo.mjs`；后端 `web/tests/test_online_start_undo.py` |
| 联机消息、断线恢复 | `verify-online-recovery.mjs`；相关真实 HTTP/WebSocket 场景 |
| AI 回合与 PASS | `verify-ai-control-flow.mjs`、`verify-multiplayer-safe-pass.mjs` |
| 防守、搜索及完整状态 | `verify-multiplayer-standard-defense.mjs`、`verify-minimax-defense.mjs`、`verify-minimax-defense-invariants.mjs`、`verify-ai-search-15.mjs` |
| 多人模型身份与准入 | `verify-multiplayer-runtime-metadata.mjs`、`verify-multiplayer-runtime-admission.mjs` |
| 领土调度/增量依赖 | `verify-territory-worker.mjs`、`verify-territory-pool.mjs`、`verify-territory-dependency-r3.mjs`、`verify-territory-integration-r3.mjs` |
| 提示、存档、棋谱 | `verify-hint-worker.mjs`、`verify-local-game-session.mjs`、`verify-replay-codec.mjs` |
| 复盘/模型比较与源状态 | `verify-ai-comparison.mjs`、`verify-research-ai.mjs`；本次 manifest 与 fixtures |
| 双语指南 | `verify-guide-content.mjs` 和上面的生成器 `--check` |

涉及 UI/联机时，用实际浏览器走触发路径、重开/取消/刷新、双方加入/重连；平台构建验收见 [多平台同步](platform-sync.md)。研究测试先检查 `research/iclr2027/pyproject.toml`、`ENVIRONMENT.md` 和任务协议；不要把完整研究测试误用为普通产品回归。

PowerShell 路径含空格时引用；命令失败检查 `$LASTEXITCODE`，不要被后续成功命令掩盖。中文验证使用 UTF-8；先复用合适的现有解释器和工具链。
