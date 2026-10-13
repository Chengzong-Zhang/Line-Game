# LIFELINE Lab 任务台账

更新：2026-09-21（M3.3 检查器与棋盘叠加联动完成）。工作区：`C:\coding\py\line game`。当前状态：产品开发按个人项目计划继续；研究训练与自动重启仍暂停，源码、研究协议、正式结果、收据和用户修改均保留。

## 冻结记录

| 对象 | 当前状态 | 证据/位置 |
|---|---|---|
| 当前 Codex goal | 无活动 goal | `get_goal` 返回 `goal=null` |
| LIFELINE PUCT seed 101–105 | 已暂停 | 已有暂停/队列收据；seed 101 的重新拉起进程树已停止，run root 保留 `PAUSE_ACK.json`；queue guard status 为 `NO_SAFE_PUCT_ROOT_TO_RESTART` |
| LIFELINE sleep guard | 已随 worker 退出 | `aaai_sleep_guard_20260921T063000` |
| LIFELINE queue guard | 已退出 | `aaai_puct_queue_guard_20260921T072400/status.json` |
| AI4M Rethlas bounded cycle | 已中止并保留已有输出 | 初始进程树 PID 37444/41664/22700/48944，以及后续重新拉起的 PID 48656/54560/44824/18456/47204 已结束；Rethlas API 服务 PID 41380/44236 保留 |
| 遗留 Rethlas 示例测试 shell | 已停止 | 精确进程树根 PID 31804（含 61296/25276/55900）已结束 |
| 当前 Git 工作区 | 保留用户修改 | `AGENTS.md` 修改保留；`research/iclr2027/paper/aaai2027/` 未提交内容保留 |

## 任务表

| ID | 任务 | 输出 | 执行者 | 写入范围 | 状态 |
|---|---|---|---|---|---|
| M0 | 版本、线上能力和用户流程基线 | `docs/LIFELINE_M0_AUDIT.md` | Epicurus / `01a0c296-c6c7-75d3-89d2-fa74f6642a7b` | 仅该文件 | 已完成 |
| M1 | 新手教学与核心交互规格 | `docs/LIFELINE_TUTORIAL_SPEC.md` | Gauss / `01a0c296-c867-71b1-882b-62a127248472` | 仅该文件 | 已完成 |
| M2 | 棋谱、恢复和复盘协议 | `docs/LIFELINE_REPLAY_SPEC.md` | Confucius / `01a0c296-ca00-7651-9874-684121de0d97` | 仅该文件 | 已完成 |
| M3 | AI 版本兼容与浏览器接入审计 | `docs/LIFELINE_AI_COMPATIBILITY.md` | Carver / `01a0c296-cbbe-72d2-93e0-eac3f9f47377` | 仅该文件 | 已完成 |
| M4 | 研究证据整理和公开展品清单 | `docs/LIFELINE_RESEARCH_EXHIBITS.md` | Avicenna / `01a0c296-cd74-7813-9d5e-4bbd13f510de` | 仅该文件 | 已完成 |
| M5 | 现有回归入口和发布门槛复核 | `docs/LIFELINE_RELEASE_GATE.md` | Kuhn / `01a0c296-cf2f-7ed2-b99c-6fcb66bebbe1` | 仅该文件 | 已完成 |
| I0 | 整合六份报告，确定第一轮最小实现 | 当前总控 agent | `docs/LIFELINE_LAB_PLAN.md`、相关源文件 | 进行中 |
| I1 | M1.1 本地 AI 对局自动保存与刷新恢复 | 当前总控 agent | `web/web前端/LocalGameSession.js`、`OnlineApp.js`、对应测试 | 已实现，桌面浏览器已验收 |
| I2 | M1.2 第一关教学与核心棋盘反馈 | 当前总控 agent | `web/web前端/TutorialRunner.js`、`GameController.js`、`OnlineApp.js`、`styles.css` | 已实现，四关桌面浏览器已验收；待移动端与新人试用 |
| I3 | M2.1 版本化棋谱导出、隔离校验与逐步复盘 | 当前总控 agent | `web/web前端/ReplayCodec.js`、`OnlineApp.js`、`styles.css`、对应测试 | 已实现，桌面浏览器已验收；待导入文件与移动端验收 |
| I4 | M2.2 关键事件说明与只读规则检查器首个案例 | 当前总控 agent | `web/web前端/ReplayCodec.js`、`GameController.js`、`OnlineApp.js`、`styles.css`、固定样例 | 已实现，导入/切断案例/只读锁已浏览器验收；待移动端与更多机制案例 |
| I5 | M3.1 检查器候选点反馈与规则效果明细 | 当前总控 agent | `web/web前端/OnlineApp.js`、`styles.css`、`main.js`、`index.html` | 已实现，候选点只读点击、清除节点坐标、新增连线明细已浏览器验收 |
| I6 | M3.2 第二个规则案例：围地结算 | 当前总控 agent | `web/web前端/tests/fixtures/replay-territory-case.json`、`tests/verify-replay-codec.mjs` | 已实现，第三步展示蓝方 +10 领土、2 条新增连线并通过浏览器复盘验收 |
| I7 | M3.3 检查器与棋盘叠加联动、移动端触控适配 | 当前总控 agent | `web/web前端/Renderer.js`、`GameController.js`、`OnlineApp.js`、`styles.css` | 已实现，候选点/清除节点/新增连线在棋盘叠加显示，图例与 44px 触控目标已加入；桌面浏览器验收通过 |
| I8 | M3.4 多 AI 对手候选比较展品 | 当前总控 agent | `web/web前端/AIEngine.js`、`AIWorker.js`、`OnlineApp.js`、`styles.css`、`tests/verify-ai-comparison.mjs` | 已实现，复盘检查器比较规则贪心基线与 Minimax-2/3/4 的前三候选、耗时和启发式分数；源局面不变验证通过，浏览器验收待自动化连接恢复 |
| I9 | M3.5 研究 UCT-MCTS 对手接入 | 当前总控 agent | `web/web前端/AIEngine.js`、`AIWorker.js`、`OnlineApp.js`、`docs/LIFELINE_AI_COMPATIBILITY.md`、`tests/verify-ai-comparison.mjs` | 已实现 UCT-MCTS-64 复盘比较，展示 visits 与 rollout value；神经 PUCT 已由 I10 接入，GAN 等未发现可用资产 | 浏览器验收待自动化连接恢复 |
| I10 | M3.6 研究神经模型浏览器接入 | 当前总控 agent | `ResearchAI.js`、`AIWorker.js`、`OnlineApp.js`、`assets/research-ai/manifest.json`、导出脚本、`verify-research-ai.mjs` | 已导出 D14--D16 Padded-CNN/Grid-GNN/Topology-GNN step-200 权重；Web Worker PUCT-16 同时用于复盘比较与双人 5--15 本地实战。checkpoint 训练仍只覆盖 5/7/9，其他尺寸标为外推；初态 value parity、5--15 合法先验、15 边长 PUCT 和源局面不变均通过 | 浏览器验收待自动化连接恢复；公开发布需显式上传 F32 资产 |

子 agent 只做独立审计和规格产出，不直接修改游戏源代码；总控 agent 读取结果后再按不重叠文件范围实施。所有子 agent 使用 `gpt-5.6-luna`、`high`。

## 当前实施批次

2026-09-21 已完成 M1.1、M1.2、M2.1、M2.2、M3.1、M3.2、M3.3，并完成 M3.4--M3.6：棋谱事件现在记录清除节点、新增连线、领土变化和终局效果；两个固定样例可导入、逐步定位；检查器可展示局面结构并把候选点、清除节点和新增连线叠加到棋盘；AI 展品现在比较规则贪心、UCT-MCTS-64、Minimax-2/3/4 与 Padded-CNN/Grid-GNN/Topology-GNN + PUCT-16。神经模型从冻结 checkpoint 导出到 F32，使用 Web 引擎的完整状态编码和合法性复验；统计明确不称为胜率。候选不会修改源局面，PyTorch 初态 value parity 和目标脚本均通过。本轮浏览器连接不可用，M3.6 页面验收待下轮补齐。GAN/GAIL/PPO/SAC/DQN 仍未发现可加载训练资产。真实手机、新人试用和完整 v0.2 门槛仍未签署通过。

## 已保留的有效内容

- 根 README、Web 规则引擎、对局控制、Worker 状态协议、联机后端和现有测试入口。
- `research/iclr2027/` 下冻结协议、正式摘要、独立验证收据、状态混淆样例和当前论文内容稿。
- `local_artifacts/ijcai2027/aaai_dytopo_puct/` 下五个 seed 的运行目录；暂停哨兵保留，未删除训练进度。
- `docs/LIFELINE_LAB_PLAN.md`，作为产品路线和验收标准。

## 已清理范围

仅清理工作区根目录下明确命名的 Codex/pytest/reviewer 临时目录；不清理 `research/`、`local_artifacts/`、源码、论文、正式收据或未确认的普通目录。清理前记录路径与大小，删除后核验路径不存在。

## 最终进程复核

2026-09-21 最终复核未发现以下活动签名：`aaai_dytopo_puct`、`run_puct_managed.ps1`、queue/sleep guard、`problem-56d5e43dec25` bounded cycle、Rethlas generation 示例测试。Rethlas API 的 uvicorn 服务 PID 41380/44236 仍在运行，未作为研究任务停止。未启动新的 LIFELINE 实验、源码开发或子 agent。

## 结论边界

当前产品计划可以立即进入 M0–M3 的规格和审计阶段。研究训练保持暂停；任何新实验必须重新经过协议、检查点、恢复和独立验证门槛。当前论文仍是内容重构稿，不自动变成可投稿稿。
