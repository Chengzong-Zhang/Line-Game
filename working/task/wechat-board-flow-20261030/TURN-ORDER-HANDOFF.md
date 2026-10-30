# 行动顺序：实现、验证与交接

日期：2026-10-30。工作树 `wechat-topology-fix-20261030/line game`，基线 `7dc00a1d`。

## 合同

- 新局可携带 `turnOrder`：当前全部玩家颜色 ID 的完整无重复排列，`turnOrder[0]` 必须等于 `startPlayer`。颜色、起点及控制器不因排序交换。
- 没有字段的旧数据，沿原 `startPlayer` 与 canonical 玩家循环继续；旧规则状态及历史哈希不加入新字段。显式顺序进入完整状态、Superko 身份和回放配置；旧 v1–v3 棋谱或已冻结 ID/Worker/证据未改写。
- `validateTurnOrder(order, playerCount, startPlayer)` 对非法排列抛 `INVALID_TURN_ORDER`。`normalizeGameSettings`、两种引擎、棋谱及服务均校验；服务不得将新字段默默丢弃。
- `readPreferences` 对受损的活动顺序或人数草稿返回原始 `turnOrder` 和 `invalidTurnOrder: true`，保留其他有效设置。原始值可能是任意 JSON，包括非数组。主控需显式提示并禁止该草稿的新局/房间，直到用户重排或恢复默认，不能让该标志阻挡已保存的当前局恢复。
- 参与者人数变化时，UI 要过滤已经离场的玩家、保留其余相对顺序，并按 canonical 顺序追加新玩家；该行为由主控 UI 实现。

## 主要文件

- 普通与拓扑规则：`web/web前端/GameEngine.js`、`TopologyGameEngine.js`、`TopologyStateCodec.js` 和 Mini 对应副本。保存、replayBatch、跳过及认输沿同一排列选择下一行动方；旧字段缺席时使用原循环。
- 保存、重放、Worker：`ReplayCodec.js`、`LocalGameSession.js`、`AIStateProtocol.js`、`AIWorker.js`、`TerritoryWorker.js`、`GameController.js`、`OnlineApp.js`，对应 Mini compatibility 副本；Mini `state.js`、`session.js`、`preferences.js`、`worker-pass.js`。
- AI 隔离搜索：`MultiplayerSearch.js`、`BudgetedMinimaxAI.js`、`AIPassDisciplineV2.js`；Mini 兼容副本与兼容 manifest 分别绑定新源码和改造副本。`LocalAIWorkerFactory.js` 对显式顺序的原生多人 Hard 选 `MultiplayerHardWorkerEntry.js` 源码入口；无新字段仍使用旧冻结 bundle。`AIWorker.js` 在这一组合使用现有 Hard runtime adapter。
- 房间：`web/web后端/wechat_online.py`（共享 Mini/Web 房间）和 `server.py`（旧 WebSocket 服务器）。`ranked-setup.js`、`ranked-ai.mjs` 将显式排列保留在权威对局及评分 context，未携带字段时旧 context 格式保持。`training-contribution.js`、`web/tools/validate_contribution_v4.mjs` 保留字段并按真实规则重放验证。
- 源兼容 manifest 是本轮运行构建的来源绑定，不是对旧冻结 Worker 或旧准入证据的更新。实际打包还需主控在最终代码稳定后重新构建及验证来源绑定。

## 定向验证

在仓库根目录：

```powershell
node --test wechat/minigame/tests/turn-order.test.mjs
node --test wechat/minigame/tests/training-contribution-v4.test.mjs wechat/minigame/tests/topology-state-worker.test.mjs wechat/minigame/tests/web-compat.test.mjs
node --test wechat/minigame/tests/ranked-v3.test.mjs
node web/web前端/tests/verify-replay-codec.mjs
node web/web前端/tests/verify-local-game-session.mjs
node web/web前端/tests/verify-turn-order-hard-worker.mjs
C:/Users/zcz/anaconda3/python.exe -m pytest -q web/tests/test_turn_order_room.py web/tests/test_shared_room_seats.py
C:/Users/zcz/anaconda3/python.exe -m pytest -q web/tests/test_wechat_ladder_v3.py
```

本轮这些检查通过：新顺序测试 9/9；拓扑、v4、native compatibility 联合检查 22/22（其中顺序测试当时为 6 项）；ranked-v3 34/34；隔离房间与现有房间座位 14/14；排行榜服务 18/18；Web 旧 replay/local session 与 Hard Worker 源入口通过。房间测试使用隔离 FastAPI、临时 SQLite 和实际 Node 规则校验；Hard Worker 测试使用 Node 消息模拟及文件资源。自动 PASS 的定向测试人为控制无合法步条件，不能替代真实复杂棋局闭环。未测试微信真机及浏览器交互。

## 服务切换与兼容边界

顺序改变客户端与权威裁决协议，必须把 `wechat_online.py`、规则 Node bridge、相关 `wechat/minigame/src`、`web/web前端`、Mini compatibility 与 v4 validator 作为一致服务候选验证；具体生产部署路径与服务器当前状态须现场核对，不能由本文件推定。对共享房间用隔离 HTTP、真实规则、错误顺序拒绝、重连/悔棋/重赛及回滚演练后再激活；不向生产贡献收件箱发送合成棋谱。

`ranked-ai.mjs` 的运行时 fingerprint 覆盖依赖源码。部署变更后，旧版本进行中的 ranked AI 房间按既有 `AI_VERSION_CHANGED` 保护拒绝继续，不能假设无损。切换前应核对活动房间并等待结束、保留旧版本承载，或采用经过验证的版本隔离/回滚方案；不得静默清理或丢弃进行中对局。旧普通房间与 WebSocket 路径也需在候选检查兼容。

显式顺序的 Hard 源码路径实际加载相同 Hard runtime，定向 Worker 测试确认 READY/PROGRESS/RESULT 和合法动作，但不是浏览器调度、设备时延、模型强度或新顺序的准入评估；旧 bundle 的冻结性能/强度证据不自动适用于新源路径。当前证据支持其作为既有 Hard 的功能路径继续做集成测试，不支持宣称已完成新顺序强度准入。是否达到最终发布质量门槛应由主控结合实际发布合同评估，不能通过改写旧证据或静默降档消除这个缺口。
