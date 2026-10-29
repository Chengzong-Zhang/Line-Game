# 跨端成熟功能只读盘点（2026-10-29）


> **后续基线修正：** `ac02a48` 与 `b3ddf87` 自 `0c1b5fd` 分叉。复核发现 `ac02a48` 已包含 `01d2059` 房间切换恢复修复、`bee3f33` 菜单/规则/复盘收集、`c78eb3e` 双榜与 `1bbb4d1` 菱形；`b3ddf87` 不包含 `01d2059`，其 Mini 源码无未提交差异。应以 **ac02a48（需与 0.12.20 实包和收据核对）作为 Mini 宿主基线**，逐项整合 `8c0e427` 多根与 `aca4b84` 拓扑，并与实际已交付包/哈希再次绑定。以下原 b3 宿主建议被本段取代；b3 继续作为多根/拓扑功能取材源。其未提交 Web 改动涉及拓扑协议、房间同步、共享网络和渲染：`CrossPlatformNetwork.js` 中修改共享设置/悔棋并删除旧的 seq 回退检测，不能整体覆盖 ac 的恢复契约。最终候选必须重验房间切换、旧局恢复、撤回、各棋盘和贡献。
## 基线和方法

本记录只读核对 commit、工作树、源码和已有收据；不是本次构建、部署、上传或真机验收。主树 `44ee333171a69c22e43b2d02edf0daaab59326bc` 分支 `codex/project-layout-20261026`，origin 为 `https://github.com/Chengzong-Zhang/Line-Game.git`。主树 Web/后端 73 个跟踪文件有修改，并有大量未跟踪拓扑/多人模块。以**当前实际文件**作为 Web 待整合起点、逐功能合并，不以 HEAD 代替工作区；保留 Round 5 未跟踪文件。其 56 项 Node/受控检查最终通过；最后复盘变化信息与窄屏双片两项未完成 Chrome 复验。来源 `working/task/board-topology-20261026/ROUND5-RESULT-20261029.md`。

小游戏宿主建议从 `local_artifacts/topology-wechat-release`（HEAD `b3ddf87882cd3c3cc8c5218d978171c98cffeb12`）的**实际文件**出发，并逐项核验其未提交差异及所需依赖；其 `wechat/minigame` 跟踪文件本次检查无修改，但 Web 源有大量修改，构建读取同树 Web，故 HEAD 不代表构建完整输入。另 `local_artifacts/multi-start-wechat` HEAD `4e63dba76b63e2a8ec6f29aa2945d56d77eff8e3`，Web 工作区亦有大量修改；`4e63dba` 为 b3ddf87 祖先。检查并封存实际输入哈希，不能整目录覆盖。`working/tmp/topology-web-r3-full` HEAD `a1dc6d75aaa2a3afceedb60daf4aacdf70c5f8d4` 是旧 Web 发布候选与对照，不包含之后 Round 5，也不包含菱形工作树的提交。`local_artifacts/multi-start-integrated-base` HEAD `6d49806e4b03f4d9d1601a3e731fcebf4e51f0b1` 为多根隔离源；非主树 HEAD 的祖先。

可把 `1bbb4d1e166e486b8e7b8aebb4e8f3950b6a6ba8` 的整合分支作为成熟功能取材源：其历史含先手保护 `8b7e4d4`、桌面输入 `a78cf94`、菜单 `9677e63`、棋谱收集 `6eca3a7`/`ceb8a21`/`cdd1792`，这些是各功能原工作树提交的对应整合版本。并非说其树可覆盖主树或 Mini。各原工作树 HEAD 分别为 `e0940042b1427aa5827cf935382848918a358072`、`a6184b3088677100ffaf3aa97dc18c01ed859fb2`、`d2c72685f08d9e13544bfae467e5b40e2f503958`、`996bd346ac4924a98e061d9ce51b9fe39730257e`。这些 HEAD 均不是主树 HEAD 或 r3 HEAD 的祖先；需看内容，不以祖先关系断言功能缺失。

## 功能矩阵与移植范围

| 功能 | 当前观察与取材 | 证据、边界及动作 |
| --- | --- | --- |
| 菱形 | 主树 `GameEngine.js` 未发现 diamond；Mini b3ddf87 嵌入 `src/topology/GameEngine.js` 有 diamond，但 `src/preferences.js` 只接受 triangle/hexagon，普通设置尚未接通。取 `1bbb4d1`。 | 该分支 20 项 Web 脚本、后端 30 项、Mini 定向 53/53 和真实浏览器 Canvas/恢复/复盘通过；Mini 仅 BUILT_NOT_WECHAT_VERIFIED；全套 538/547。同步 `GameEngine.js`、`StartingPoints.js`/`StartingPointSetup.js`、AI/Worker/多人搜索、`GameController.js`、`OnlineApp*`、`OnlineRoomSettings.js`、`web后端/server.py`、`wechat_online.py`、`online_bot_bridge.mjs`/runtime，以及 Mini `compat/web`、`src/{app,board,cabins-ui,controllers,core,preferences,screens,session,state,worker-runtime,i18n}.js`、指南与对应测试；按 `git show --name-only 1bbb4d1` 查完整依赖，语义合并。多人菱形默认只允许随机/自定义；不将三角/六边形训练权重冒充菱形模型。 |
| 多根与拓扑 | 主树 Round 5 为最新实现，Mini `8c0e427`/`4e63dba` 有权威多根；Mini 和 Web 均需对齐协议、棋盘定义、完整根集和恢复。 | Round 2 多根 Worker、保存恢复通过；Round 5 局部真实浏览器与 56 项检查有上述边界。Mini 原生环境、双客户端仍需验证。不得覆盖旧存档规则，必须核对拓扑 v3 服务端权威能力而非据 JS/Python 编译推断支持。 |
| AI 菜单 | 主树 `LocalAIModes.js` 仍列 `ai-ultimate`，`LocalPlayerSetup.js` 未见同分支的普通档/实验室分离；`d2c7268` 或 `9677e63` 为成熟来源，保留旧 ID 恢复和实验模型隔离。 | 原证据 Web 菜单/旧局与实际浏览器通过，Mini 定向 58/58、构建通过、全量 498/506，不能把既有失败隐去。重点 `LocalAIModes.js`、`LocalPlayerSetup.js`、`OnlineApp.js`/I18n、styles、Mini `app/controllers/i18n/preferences/screens/session/storage/worker-runtime` 与测试；与 Round 5 新设置语义合并。 |
| 双榜与共享联机 | 主树已有 `SharedLadder.js` 和 `SharedLadderSession.js`，可探测同源服务并交换会话；实际账号/榜单尚未联调。主树缺 `SharedRoomClient.js`、`CrossPlatformNetwork.js` 和 `web后端/wechat_online.py`。Mini 4e63dba 祖先 `42fafe3`/`287914a`/`039936b` 有榜单和保守评分实现。 | 旧 Mini 天梯 v2 本地 113 项通过（排除一个旧登录桥失败）、UI 46/46、模拟身份下 HTTP/WS 浏览器闭环，非生产或真实账号验证；应核对最新版服务与客户端契约、迁移/数据保护及真实登录和跨端房间。拓扑 AI 为练习、不套用普通棋盘榜单、不伪造棋力。|
| 桌面微信与手机 Web | b3ddf87 Mini `src/input.js` 已含鼠标/触摸去重、MouseDown/Move/Up、Wheel 和取消，需保留且验证；Web 手机样式对照 `a6184b3`/`a78cf94`。 | 原收据小游戏 494/494、浏览器微信接口模拟 5/5、四种手机浏览器尺寸通过，非微信 PC/真机验证。重点 `src/input.js`、`src/platform.js`、`src/app.js`、Web `styles.css`、`verify-responsive-ui.mjs`、Mini `desktop-input.test.mjs`。 |
| 正式领土与先手保护 | 主树有 `territory-v3`、`duel-first-unprotected-v1`。Round 4 新双人三角按实际先手免保护，旧局缺字段保留 `symmetric-v1`；六边形、多人、拓扑保留保护。 | Round 4 71 个 Node 脚本及 Python 多组回归通过，最终文件须按本次候选重验；正式比分是离散 area，显示填色不代替结果。应保护 `GameEngine.js`、`GameController.js`、`LocalGameSession.js`、`ReplayCodec.js`、`OnlineAppState.js`、AI state/Worker、`server.py` 与对应测试。 |
| 棋谱收集 v3 | 主树 `TrainingContribution.js` 当前为 policy v1；Mini b3ddf87 文案明确只收 territory-v2、默认 v3 不上传。来源 `996bd34`/`6eca3a7`/`ceb8a21`/`cdd1792`。 | 联合移植 `web/web前端/TrainingContribution.js`/`OnlineApp.js`、`web后端/training_contributions.py`、`web/tools/training_contribution_schema.mjs`/`validate_contribution.mjs`、Mini `src/training-contribution.js`、app/指南及 `*contribution*v3*` 测试；保留自愿同意、旧队列、隐私与服务开关；数据接收不授权训练或模型晋级。 |
| 恢复、教程、复盘、双语 | 主树已有 Round 5 新复盘/指南与保存恢复；Mini 和 Web 独立源需逐条比对，不能从旧版整文件覆盖。 | Round 5 浏览器真实完整局和回放已通过，末次变化修复仅 Node；Round 2 刷新后状态保持。涉及 `ReplayCodec.js`、`OnlineRoomSync.js`、`NetworkManager.js`、`TutorialRunner.js`、`Guide*.js`、生成后中英文文章，及 Mini `replay-ui.js`、`storage.js`、`online.js`、`guide-content.js`。须重新生成指南与对应 bundle/manifest，并验证正常、刷新、断线、悔棋、导入和跨端。 |

Round 4 最终结果叙述的 `SharedLadderSession` 比早期 `ui-review.md` 中“没有身份桥”的中间状态更新；仍无真实共享服务验收，勿把中间文档当最终状态。未准入的 Ultimate 模型/拓扑 AI 棋力评价、新训练和未经证明的任意拓扑服务权威能力均不作为已成熟发布承诺。

## 本次关键工作区字节指纹（SHA-256）

- 主树 `web/web前端/GameEngine.js`：`5fd625f9b5d3a45055be00b57e7d6e3f6602c3f8f5263e088684ffd138bdc5bf`
- 主树 `web/web前端/OnlineApp.js`：`527890606a67465e8afce2e79863d478730eb8b4019bbf0c7462249f985aad84`
- 主树 `web/web前端/LocalAIModes.js`：`f10b3761a4579015564fa281678efb94f5e666bfba166c55cb12c1c0f7e34d3b`
- 主树 `web/web前端/TrainingContribution.js`：`fa5ae4c641620c626c99299da5c21a73ace44760324bf1fcef236c756aad10d8`
- Mini `src/preferences.js`：`ee3745e764dbdfe1657e1a42663386cb5af4615d0e7af4a0cb8da972628d389a`
- Mini `src/input.js`：`8a475a9e422dab84c2c69b03c6bfc77c84af4de939527cb8f804b279009b8419`

这些指纹是盘点时采样，不是候选全部闭包。后续整合过程中若有并发改动须重新计算。原证据 `diamond-board-20261026/RESULT.md`、`ai-menu-20261026.md`、`ui-adaptation-20261026.md`、`wechat-ladder-v2-20261026.md` 和主树 Round 4/5 结果仅说明各自当时的验证层次。
