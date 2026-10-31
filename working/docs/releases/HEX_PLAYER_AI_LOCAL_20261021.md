# 4–6 人 AI 本地网页交付 · 2026-10-21

状态：`PASS-CURRENT`，范围为本地 Web 功能及下述验证。没有部署线上，也没有同步小程序。

## 试玩

独立本地预览：<http://127.0.0.1:8014/>。

打开“棋盘舱”，选择 4、5 或 6 人，为各席位选择“人类”或“六边形 AI”，设置边长和先手，然后关闭面板、点击“开始对局”。支持单个 AI、多个 AI 和全 AI 对局。原有 2/3 人配置仍保留。

“暂停 AI / 继续 AI”保留棋局；加载失败、非法返回或 15 秒超时会暂停并提供重试。刷新后按既有流程点击“跳过教学”，可回到保存的对局、席位和暂停状态。棋谱可以复盘和导出，六边形棋谱暂不进入旧三角训练贡献队列。

本地联机同样支持多个 AI：选择人数后在“联机舱”设置 AI 席位，最多为人数减一。AI 自动准备，真人准备后开局。服务器校验动作，重建完整历史；断线、换连接、重开会取消或拒绝旧请求。

本次预览使用 `local_artifacts/hex-ai-local-20261021/game.db`，与旧预览及生产数据库隔离。测试账号已退出，测试房间已离开。8014 服务保留供试玩；原有 8012/8013 服务未重启。后端需要 Python 依赖及 Node.js 18+，可用 `LIFELINE_NODE` 指定 Node 路径。

## 训练与能力边界

模型为 `hex-player-policy-v1`。先模仿已有双人 Minimax，再在真实 4/5/6 人六边形局面中模仿轻量教师。教师考虑自身相对所有对手的节点、覆盖和可达区域，并加入下一行动方的应手。模型按全部合法动作评分，保留 Superko 和当前规则状态。

| 项目 | 实际完成 |
| --- | --- |
| 生成轨迹单元 | 30/30，全为最多 8 步的截断轨迹 |
| 双人预训练样本 | 45 |
| 六边形训练样本 | 144，4/5/6 人各 48 |
| 独立留出样本 | 48，4/5/6 人各 16，按整条轨迹划分 |
| 训练尺寸 | 5、7、9 |
| 网页推理范围 | 4–6 人，边长 5–15 |
| 留出交叉熵 | 2.48019 → 1.25377 |
| 教师最高分动作一致率 | 29.17% → 75.00% |
| 最终训练用时 | 101.144 秒 |

训练和留出评估都在全部合法动作上归一化。教师只给选中的候选非零目标概率（六边形最多 4 个，双人最多 20 个）。上述数值是模仿指标，不是胜率；这是轻量初始应用模型，尚未独立评估棋力，也没有证明 10–15 边长上的棋力。

最终模型 SHA-256：
`74aa7f945c3ea7ff5ca3edc9e7bdc431dc0ec5ad56d2563ce6d6d24c0494162b`。

模型资产及训练收据位于 `web/web前端/assets/research-ai/`。原始样本、检查点和日志位于 `local_artifacts/hex-player-ai-v1b-20261021/`，不作为版本控制交付工件。第一次候选保留在原运行目录，最终候选使用新的运行目录和来源身份。

## 验证

独立模型校验重算了留出交叉熵，并核对四个训练源码哈希。48 个推理测试覆盖 4/5/6 人、5/9/15 边长及各席位，检查合法动作、概率归一化、异常后状态恢复和损坏模型拒绝。六人 15 边长的 24 步局面中，三个席位测得 584.5、683.7、767.2 毫秒；这是当前机器的固定局面数据。

4/5/6 人各执行 80 步合法 AI 行动，再连续跳过完成终局；这三局均没有在 80 步内自然终局。另验各人数的认输结算。不能把这些测试表述为自然结束的完整自对弈评估。

训练恢复演练通过：提交前后故障、监督重启、检查点半写隔离、防重复、STOP/PAUSE、损坏/源码变化拒绝、有界重试。恢复与无中断运行的模型逐项一致。校准与恢复模式默认输出到各自运行目录，不覆盖网页模型。

主要实际命令（均退出码 0）：

```powershell
node --unhandled-rejections=strict 'web/web前端/tests/verify-hex-player-training-recovery.mjs'
node --unhandled-rejections=strict 'web/web前端/tests/verify-hex-player-ai.mjs' './web/web前端/assets/research-ai/hex-player-policy-v1.json' './local_artifacts/hex-player-ai-v1b-20261021/checkpoint.json'
node --unhandled-rejections=strict 'web/web前端/tests/verify-hex-ai-session.mjs'
node --unhandled-rejections=strict 'web/web前端/tests/verify-hex-player-setup.mjs'
node --unhandled-rejections=strict 'web/web前端/tests/verify-hex-ai-persistence.mjs'
node --unhandled-rejections=strict 'web/web前端/tests/verify-hex-online-bot-bridge.mjs'
node --unhandled-rejections=strict 'web/web前端/tests/verify-online-bot-node-crypto.mjs'
node --unhandled-rejections=strict 'web/web前端/tests/verify-three-player-ai.mjs'
node --unhandled-rejections=strict 'web/web前端/tests/verify-local-ai-session.mjs'
node --unhandled-rejections=strict 'web/web前端/tests/verify-local-game-session.mjs'
node --unhandled-rejections=strict 'web/web前端/tests/verify-online-recovery.mjs'
node --unhandled-rejections=strict 'web/web前端/tests/verify-territory-v2.mjs'
node --unhandled-rejections=strict 'web/web前端/tests/verify-hex-render-worker.mjs'
node --unhandled-rejections=strict 'web/web前端/tests/verify-hex-replay-session.mjs'
node --unhandled-rejections=strict 'web/web前端/tests/verify-hint-worker.mjs'
python -m unittest discover -s web/tests -v
```

后端综合回归共 31 项；六边形 AI 房间专项 7 项包括认证 WebSocket 一真人对五 AI，正常模型动作明确验证没有降级。Node 缺少全局 Web Crypto 时也能通过标准库校验模型并落子。

Chrome 真实页面验收：

- 四人单 AI 任意先手，五人连续三个 AI，六人一真人对五 AI。
- 缺少模型时保局暂停，模型就绪后“继续 AI”恢复。
- 暂停后真人可行动，轮到 AI 时禁用手动输入；刷新保留五步历史、五个 AI 席位和暂停状态。
- 最终模型六人全 AI 连续行动 79 步，暂停、打开棋谱、退回一步及退出复盘均可用。
- 本地账号六人房间，五个 AI 自动准备、连续落子，刷新重连后真人跳过、五个 AI 再次应手。
- 中英文席位设置、六色棋盘、比分和回合显示。
- 本地 HTTP 返回的模型字节与最终资产哈希一致。

截图位于 `local_artifacts/hex-ai-local-20261021/`。紧凑模型校验数据与交付收据位于 `docs/verification/hex-ai-20261021/`。

本次没有做手机实机、生产网络、远程多客户端、后端整体重启后的房间持久化或独立棋力评测；已有内存房间生命周期不承诺跨后端重启恢复。发布到服务器前仍需对应环境的发布验收。

## 恢复入口与协作

本次最终训练命令如下。相同源码、协议和运行目录可恢复；不要删除检查点后“重试”。在运行目录创建 `PAUSE` 或 `STOP` 会在轨迹/训练 epoch 边界停止，移除标记后才可显式恢复。每次训练须使用独立监督进程。

```powershell
node 'web/tools/train-hex-player-ai.mjs' --supervise --profile release --run-root local_artifacts/hex-player-ai-v1b-20261021 --max-seconds 120
```

分支为 `codex/three-player-ai-web-20261020`。与三人 AI 后训练聊天协作，保留冻结的 `GameEngine.js`、`AIEngine.js`、`ThreePlayerAI.js`、旧三人训练脚本和资产。三人加载注册表由另一聊天维护；本次验收时默认仍是三人 v1。本次没有提交、推送、清理用户改动或修改 `mobile/`。
