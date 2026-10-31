# 2–15 人配置同步验证（2026-10-25）

新局允许 2–15 人；7–15 人只使用随机或自定义起点。Web 切换到 7 人以上时生成并显示随机起点，隐藏默认起点按钮。规则引擎拒绝没有实际起点的 7–15 人配置。权威互通服务拒绝该人数的默认模式；旧转发服务的设置规范化会生成随机起点。随机结果随房间、存档、重放保存，加入、重连与恢复不重抽，明确重开才生成新起点。

前六席标识与棋盘数值保持兼容，新增九席共用规则引擎 `PLAYER_ORDER` 与 `PlayerPalette.js`。Web 比分、先手选择、起点预览、悔棋、存档与棋谱包含全部席位。两种棋盘的最小边长仍为 5；三角形边长 5 有 15 格，可放满 15 个起点，此时没有空位可走，可通过 PASS 完成对局。

7–15 人提供真人、基础通用策略与困难通用搜索。基础档实际使用 Greedy，困难档使用完整合法根候选的 paranoid minimax，并报告已完成深度与预算状态；没有加载或宣称适用三人/六人训练权重。不开放该人数的中等/终极训练模型。Python/Pygame 双人原型不承担产品的多人设置；两个 Python 联机服务及其 JS 规则桥已同步 15 席。

验证命令（仓库根目录）：

```text
node --unhandled-rejections=strict web/web前端/tests/verify-fifteen-players.mjs
node --unhandled-rejections=strict web/web前端/tests/verify-replay-codec.mjs
node --unhandled-rejections=strict web/web前端/tests/verify-local-game-session.mjs
node --unhandled-rejections=strict web/web前端/tests/verify-local-undo.mjs
node --unhandled-rejections=strict web/web前端/tests/verify-online-recovery.mjs
node --unhandled-rejections=strict web/web前端/tests/verify-unified-room-ui.mjs
python -m unittest web.tests.test_fifteen_player_rooms web.tests.test_hex_rooms web.tests.test_shared_room_seats
```

结果：15 席专用 Node 回归通过 28 个人数/形状配置，并覆盖存档、悔棋、完整 PASS 终局棋谱、15 席房间哈希、实际第十五席 Bot 与 AI Worker；其余列出的 Node 回归通过。Python 组合 19 项中 18 项首次通过，跨客户端 fixture 在兼容文件同步期间读到中间状态产生语法失败；同步稳定后单独重跑该项通过（11.220 秒）。专用 Python 回归真实创建 15 人房间、逐席加入与准备、最后一席行动、满房拒绝、重连、SQLite 恢复、缩席保护和随机重开；临时数据库与日志不纳入版本控制。

补充验证：初次运行 `verify-online-room-settings.mjs` 时缺少历史 Padded-CNN 二进制资产；随后按已发布 manifest 逐文件校验哈希并补齐 18 个 `.f32` 资产，完整重跑通过，覆盖双人 research/model-free 路线。`verify-ai-control-flow.mjs` 存在继承的固定分数断言失败：旧期望值 376/303，当前 AI 对终局获胜 PASS 返回 1000000；在本任务基线 `f172750` 的原发布树运行同样失败，本次未改该断言。新增 15 席控制流、真实 Worker 与既有恢复回归均已通过。

边界：上述验证不代表真实微信设备、公开渠道或服务器部署验收。刷新进入教学是既有入口行为，跳过/离开教学会从保留的 `tutorialReturnSession` 恢复本地对局。
