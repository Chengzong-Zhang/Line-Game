# LIFELINE Web 架构

页面入口是 `web/web前端/index.html → main.js → OnlineApp.js`，后端入口是 `web/web后端/server.py`。源码、运行资源和发布工具集中在 `web/`，设计与历史资料统一从 [文档导航](../README.md) 进入。

## 当前功能

Web 支持本地双人/三人和账号房间联机。双人局通过 `LocalPlayerSetup.js` 分别设置蓝红双方的棋手、难度、模型版本与先手，支持人类、Minimax、三种神经 PUCT 与五种模型策略。

对局包含读秒与提示限次、保存恢复、规则教学、棋谱导入导出、复盘时间轴、局面检查器和 AI 对比。匿名完整棋谱由玩家自愿贡献，经收件与规则校验后进入独立的筛选流程。

## 前端模块

| 模块 | 职责 |
| --- | --- |
| `OnlineApp.js` / `OnlineAppState.js` / `OnlineAppI18n.js` | 页面编排、设置与本地状态、中英文文案 |
| `LocalPlayerSetup.js` / `LocalAIModes.js` | 双方棋手配置与 AI 回合归属 |
| `GameController.js` / `Renderer.js` | 输入、对局编排、Canvas 与比分显示 |
| `GameEngine.js` | 规则、完整状态、合法动作、攻击、领土与终局 |
| `AIEngine.js` / `AIWorker.js` / `AIStateProtocol.js` | Minimax、搜索快照与异步响应归属 |
| `ResearchAI.js` / `ModelFreeAI.js` / `ResearchAIOptions.js` | 神经模型推理、PUCT、种子与版本 |
| `HintWorkerSession.js` / `TerritoryWorkerSession.js` | 提示和领土计算的请求、取消与超时 |
| `ReplayCodec.js` / `LocalGameSession.js` | 版本化棋谱、隔离重放、本地保存与恢复 |
| `TutorialRunner.js` | 由真实规则引擎运行教学场景 |
| `NetworkManager.js` / `OnlineRoomSync.js` | 网络事件、房间归属、快照恢复与同步 |
| `GuideContent.js` / `guide/` | 规则、“妙处”文章、Markdown 解析与离线回退 |

## 规则与状态契约

页面和新建房间使用 `territory-v2`；裸 `GameEngine` 默认值保留 `territory-v1`。物理格点状态和显式逻辑边分别记录占用与真实连通关系，最终比分读取规则定义的离散 `area`。

`historyHashes` 是 Superko 状态的一部分。行动、搜索、Worker 快照、保存与复盘须保留规则决定字段，包括节点、边、下一行动方、连续跳过、认输和终局状态。缓存与显示用面积不能替代规则状态。

异步响应核对请求 ID、引擎身份、局面版本、规则版本和玩家；重开或新行动后丢弃旧结果。导入棋谱先在隔离引擎中重放，通过行动方、事件、哈希和终局校验后再替换页面状态。

详细约定见 [棋谱规范](../product/LIFELINE_REPLAY_SPEC.md)、[AI 兼容说明](../product/LIFELINE_AI_COMPATIBILITY.md)和[发布门槛](../product/LIFELINE_RELEASE_GATE.md)。

## 后端边界

`server.py`、`models.py` 与 `database.py` 提供账号、JWT、房间、准备、动作转发和重连服务；完整三角棋盘规则在前端执行。

`training_contributions.py` 提供匿名棋谱收件接口。`tools/validate_contribution.mjs` 与 `tools/curate_web_replays.mjs` 使用规则引擎校验与筛选棋谱，区别于公开棋谱的浏览器导入流程。

## 运行与验证

安装与模型权重下载见 [web/README.md](../../web/README.md)。前端自动回归位于 `web/web前端/tests/`，后端自动回归位于 `web/tests/`，测试源码保留在版本管理中。

页面、Canvas、真实 Worker 和实际网络行为用浏览器补充检查。研究环境沿用独立冻结协议，不从 Web 回归推断跨实现等价或正式棋力结论。

## 发布

`prepare_frontend_release.py` 生成运行资源清单、统一缓存版本与哈希绑定的发布包；`deploy_frontend_overlay.py` 核对前驱资源并执行原子目录交换，保留旧目录用于回滚；`verify_frontend_release.py` 核验公网资源哈希和服务健康。

[上线记录](../releases/)与[验证证据](../verification/)按日期和版本保留。旧课程资料与早期提示词集中在 [archive/](../archive/)，合并前的架构全文见[历史记录](../archive/web/architecture-before-consolidation.md)。
