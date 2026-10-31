# 三人 AI 本地网页交付 · 2026-10-20

状态：`PASS-CURRENT`，范围为本地 Web。用户已将交付范围改为“先完成本地网页，不上服务器”。
服务器部署、推送与小程序同步均为 `NOT-RUN`。

## 试玩

本次独立本地服务为 `http://127.0.0.1:8012/`。
在“棋盘舱”选择 3 人，分别为蓝、红、紫选择“人类”或“三人 AI”，关闭设置面板后开始对局。
支持两位真人配一个 AI、一位真人配两个 AI；先手可指定任意一方。
“暂停 AI / 继续 AI”保留棋局；加载失败或 15 秒超时后，可点击继续重试。

本地联机：选择 3 人后打开“联机舱”，登录本地账号，创建房间前选择 AI 席位数。
AI 自动准备，真人点击准备后开局。服务器复验动作并计算 AI，刷新重连恢复已接受的动作历史。
仅 AI 进程退出或超时会有限重试；损坏历史拒绝继续。模型不可用时使用合法基础动作并显示降级提示。
联机需要 Node.js 18+，可用 `LIFELINE_NODE` 指定可执行文件。

本次浏览器测试账号与数据库仅位于 `local_artifacts/three-player-local-20261020/`。
未读取或修改已有账号数据库，也未重启原有服务。8012 服务在本次测试后保留供试玩。
重新启动可使用仓库现有的 `web/start/start_online_server.ps1`。
页面沿用既有启动教学流程；刷新后点击“跳过教学”可回到保存的对局。

## 模型

以现有双人 Minimax 决策进行模仿预训练，再在三人规则下模仿 MaxN 教师微调。
最终生成 36 个轨迹单元（13 个终局、23 个截断），479 个局面；
训练使用 135 个双人、244 个三人局面，另有 67 个三人留出局面。
留出模仿交叉熵 1.8965 → 1.5376，不能解释为胜率或棋力提升。

这是轻量初始策略，训练尺寸为 5、7、9，支持 5–15 合法推理。
算法、协议、来源哈希与恢复入口详见 `docs/THREE_PLAYER_AI_V1.md` 和
`docs/verification/three-player-ai-20261020/ai-model-receipt.json`。

## 本次验证

以下命令均实际运行并以退出码 0 完成：

```powershell
node --unhandled-rejections=strict 'web/web前端/tests/verify-three-player-ai.mjs'
node --unhandled-rejections=strict 'web/web前端/tests/verify-three-player-training-recovery.mjs'
node --unhandled-rejections=strict 'web/web前端/tests/verify-online-bot-bridge.mjs'
node --unhandled-rejections=strict 'web/web前端/tests/verify-local-ai-session.mjs'
node --unhandled-rejections=strict 'web/web前端/tests/verify-local-player-setup.mjs'
node --unhandled-rejections=strict 'web/web前端/tests/verify-local-game-session.mjs'
node --unhandled-rejections=strict 'web/web前端/tests/verify-local-server-origin.mjs'
node --unhandled-rejections=strict 'web/web前端/tests/verify-online-recovery.mjs'
python -m unittest discover -s web/tests -v
```

后端整合共 23 项：13 项 AI 房间、7 项匿名棋谱收件、3 项同时开发的六边形房间回归。
AI 专项覆盖三座位、5/9/15 边长、六种单/双 AI 配置完整小盘对局、Superko、状态恢复、
真实 Worker 回包、训练来源哈希；恢复演练包含实际杀进程与无中断运行对照。

真实浏览器（Codex 内置浏览器，Windows）：

- 三人 9 边长，红方与紫方 AI 连续落子，回到蓝方真人，回合数与棋谱均为 2。
- 三人 5 边长，紫方单 AI 先手；暂停后两位真人可以行动，轮到 AI 时锁定手动输入；继续后 AI 正常落子。
- 刷新后返回原对局，保留三人棋手配置及动作。
- 中英文切换后仍可配置单/双 AI。
- 本地真实账号登录、2 AI 房间自动准备、倒数开局、服务器 AI 连续落子。
- 联机刷新重连后真人跳过，两个 AI 继续应手；测试完成后已退出房间与测试账号。

浏览器截图保留在 `local_artifacts/three-player-local-20261020/online-two-ai.png`。
未做手机实机、生产 WebSocket、服务器重启后房间持久化或棋力排名测试。
联机房间仍沿用现有内存生命周期，整个后端服务重启不承诺保留房间。

## 协同与变更边界

与同工作区的 4–6 人六边形开发协同，保留双方改动；三人 AI 仍仅适用于三角棋盘。
训练最终来源绑定后未再修改 `GameEngine.js`、`AIEngine.js`、`ThreePlayerAI.js` 和训练脚本。
共享工作区没有执行提交、推送或部署，原有未跟踪 `mobile/` 保留。
