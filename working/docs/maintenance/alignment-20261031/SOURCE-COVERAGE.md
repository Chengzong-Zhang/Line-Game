# origin/main 与共同候选能力覆盖（2026-11-01）

> 本文为整合初审，所列缺口其后已处理。最终状态以 [源码覆盖](FINAL-COMMON-SOURCE-COVERAGE.json)、[理论与补源](THEORY-AND-SOURCE.md)、[平台交付](PLATFORM-DELIVERY.md)和任务 DELIVERY.md 为准；下文保留原调查证据与当时范围。

范围为当前 `origin/main`（6da96325）与 51e5782d + 指南 + 行动顺序 v3 的共同 Web 候选、后续微信工作树 / `wechat-final-01` 候选、主工作区 Python。分支祖先关系与文件数不能证明能力缺失；以下为实际入口只读核查和注明的局部测试，不是发布验收。

| 能力 | 观察与限制 |
| --- | --- |
| 普通 15 人、混合席位和随机起点 | 共同 `GameEngine.js:531` 接受 2–15 人、`OnlineRoomSettings.js` 保留每席 `playerSetup`；51e 的 `web/web后端/wechat_online.py` 定义15色并在约1088、1117、1136行验证人数、随机起点和席位，含真实服务运行的条件仍须另验。拓扑服务器限定2–6人。新顺序 v3 的 Mini `shared-web-ui.test.mjs` 使用真实 Web handler/规则、替身网络，全套13/13，其中六人间隔人机及创建别名均通过；这不是15人真实跨端联机通过。 |
| 最近落子 | Web 普通局 `GameController.js` 的 `lastMoves`、`Renderer.js` 绘制和回放动作重建存在；Mini 普通 `src/latest-moves.js` / `board.js` 存在。Mini拓扑目前 `app.js` 只向 `topology-board.js` 传单个 lastMove，缺每方标记；Web拓扑 `restoreTopologyState` 清空 lastMoves 且 renderer 优先空集合，重启/退出复盘后标记缺失。两者属于显示/恢复缺口，已分别交由对应任务修复，不能以普通局通过代表拓扑通过。 |
| Python 最近落子与 v3 | `origin/main` 的 `triangular_game.py` 有 last_moves；51e该文件没有。当前主工作区 dirty 文件已包含每方标记、`_compute_owned_wall_area` 的v3离散计分、起点保护和 `board_topology` 入口；`python "core algorithm/test_latest_move_highlight.py"` 在headless pygame替身下退出0。此文件与 51e/main 均有实质差异，不能整文件从main或51e覆盖。应以当前完整dirty源码为待审增量、保留用户改动，选择 last_moves 必要hunk及 `test_latest_move_highlight.py`（当前未跟踪）并分别核对 topology 依赖及现有v3测试；不改冻结研究目录。 |
| 三人 v4 与身份 | `ThreePlayerSearchOptions.js` 固定 `three-player-search-v4-round12` 和 SHA-256 `9b85f5fff27001d68407c30d6f707b461b1b468d657c8292339e97d23868c230`；共同候选对应模型文件实测 SHA 一致。`ThreePlayerModels.js` 绑定v1/v2模型哈希，`ThreePlayerRuntime.js` 标明 v4 继承v2、无新梯度更新；与 main 的这些模块除查询版本及 v4 的deadline/partial处理外保持相应结构。`LocalAIWorkerFactory.js` 的多人Hard走 `frozen-workers/web-topology-fix-20261030-r2`，不应误说所有三人模型都从该bundle路由。文件身份不等于棋力准入或所有宿主运行已验。 |
| v3 与完整状态 | 共同 `GameEngine.js` 的v3离散 area、历史/逻辑边、order和 `LocalGameSession` 恢复路径存在；移动双键实现与具体验证另见 `MOBILE-PERSISTENCE.md`。服务及拓扑另有独立状态/协议；文件存在不能替代真实跨端恢复。 |
| 合格防守教师及工具 | 共同前端有 `DefensiveTrainingTeacher.js`，与origin/main的该文件差异仅三条 import 查询版本；契约要求完成至少3层、两轮真实对手行动、全部合法根含PASS、精确值，预算不足不出标签。51e 缺 `web/tools/defensive-training-data-v1.mjs`、`train-defensive-policy-v1.mjs`、`training-policy-v1.mjs`、`neural-posttraining-data-v2.mjs` 及 `web/web前端/tests/verify-defensive-training-v1.mjs`，不能只复制Teacher就声称新训练入口完整。 |

## 防守训练补源依赖与不启动训练的检查

在 `working/tmp/alignment-20261031/source-supplement/` 隔离导出了 origin/main 的 13 项相关文件，与共同前端顶层 JS 合用，仅执行两个新工具的 ES module import，退出0；未生成标签、训练或晋级。最小运行闭包包括：两项新工具、`neural-posttraining-data-v2.mjs`（提供 atomic/lease/完整性助手）、`training-policy-v1.mjs`，以及前端 `DefensiveTrainingTeacher.js`、`GameEngine.js`、`AIEngine.js`、`AIStateProtocol.js`、`MultiplayerSearch.js`、`MultiplayerNativeGeometry.js`、`MultiplayerHardValue.js`、`ResearchAI.js` 及其递归依赖。数据工具会绑定上述来源哈希，必须以最终组合重建来源清单。

完整 `verify-defensive-training-v1.mjs` 还导入 `neural-posttraining-data.mjs`，并调用 `train-three-player-ai.mjs`、`train-hex-player-ai.mjs`、`run-hex-distillation-v3.mjs` 验证旧入口拒绝；测试本身会生成微型标签并执行3次候选拟合更新，因此本次遵照“不启动训练”未运行，不能报告该套通过。870f16bc 还为 `neural-terminal-rollout-data-r3.mjs`、`posttrain-neural-models.py`、`run-hex-posttraining.mjs`、`train_neural_terminal_head_r3.py` 等旧训练入口加退休保护；整合时应逐一保留这些保护与既有恢复控制，不用旧浅标签或 rollout 协议补缺。origin/main 对应防守验证说明在 `docs/verification/defensive-training-20261025.md/.json`，作为历史证据保留，不宣称对新组合重新验证。

## 理论文章活跃回退

`GuideContent.js` 的内联 WHY_THEORY 中英仍有旧的优越性、上界紧确和每步 |H| 递增说法。正常请求成功时 `OnlineApp.js` 用外部 `why-theory.zh/en.md` 覆盖，外部摘要明确 PASS 等不增加 H、使用复合秩并只给上界；但请求失败或非200时实际回退到旧内联文本，故并非死代码。外部文章声明 2026-08-26 的2/3人规则快照，应保留历史适用范围，不代表现行全平台。建议中英 fallback 同步替换成有界、安全的短说明，不从松上界推断跨游戏实际复杂度或紧确下界；该修复由父任务独立处理。
