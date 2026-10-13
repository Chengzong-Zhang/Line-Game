# 本地对局：蓝红双方独立配置

状态：本地主工作区已实现并验证；未提交、未推送、未部署生产网站。

默认蓝方先手，可改为红方先手。双人对局各自从人类与九类 AI 中选择玩家；允许双方都是人类、不同 AI，或同一 AI 使用不同设置。Minimax 难度只显示在对应一方；PUCT 版本与种子在该方的高级设置中，保留实验模型的兼容性与棋力提示。三人模式保持人类对局。

双方选择、先手、尺寸和其他对局设置先作为待应用配置。修改配置或交换双方会停止待执行的 AI 请求并保留原棋局；点击“开始对局 / 开始新对局”后应用配置并重置棋盘。交换双方携带各自的难度、版本和种子，先手颜色保持当前选择。

AI 按当前行动方读取各自配置。结果同时绑定请求、引擎身份、局面 revision、规则版本、行动方与模型配置；重开、换边、改配置、暂停和复盘拒绝旧结果，包括已替换 Worker 的迟到错误。模型加载失败时只让失败的一方改用 Minimax；非法结果或 Worker 运行失败停止调度并显示重试提示。

本地存档保存双方配置、开始状态和暂停状态；追加棋谱动作时保留这些信息。旧版存档继续可读，无法推断的旧 AI 身份不猜测。匿名棋谱的两方角色分别记录实际模型配置，混合配置继续使用原有排除标记。

实现入口：`web/web前端/LocalPlayerSetup.js`（独立选择卡）、`LocalAIModes.js`（配置和角色）、`LocalGameSession.js`（兼容存档）、`OnlineApp.js`（开始、调度和恢复）、`OnlineAppI18n.js` 与 `styles.css`；入口资源版本更新为 `20261013-players1`。

## 自动验证

以下命令本次均退出 0。AI 会话测试使用真实规则与控制器、模拟 Worker；实际浏览器另行验证。

```powershell
node --unhandled-rejections=strict 'web/web前端/tests/verify-local-player-setup.mjs'
node --unhandled-rejections=strict 'web/web前端/tests/verify-local-ai-session.mjs'
node --unhandled-rejections=strict 'web/web前端/tests/verify-local-game-session.mjs'
node --unhandled-rejections=strict 'web/web前端/tests/verify-ai-duel.mjs'
node --unhandled-rejections=strict 'web/web前端/tests/verify-ai-control-flow.mjs'
node --unhandled-rejections=strict 'web/web前端/tests/verify-tutorial-session.mjs'
node --unhandled-rejections=strict 'web/web前端/tests/verify-replay-codec.mjs'
node --unhandled-rejections=strict 'web/web前端/tests/verify-training-contribution.mjs'
node --unhandled-rejections=strict 'web/web前端/tests/verify-online-recovery.mjs'
```

额外执行修改模块的 `node --check` 和定向 `git diff --check`，均退出 0。

## 浏览器验证

独立预览地址：`http://127.0.0.1:8880/`，实际 Vue、Canvas 与 AI Worker。蓝方 DQN、红方 Minimax 深度 2、边长 5、红方先手，完成 7 步，蓝方 4、红方 9；暂停后刷新保留角色和暂停状态。进入复盘、跳至起点、退出后恢复原终局与比分。人类蓝方先手时等待人工操作；人工跳过后红方 AI 落子，重新轮到蓝方。

中英文选项均显示十种玩家选择，先后手标记随所选颜色更新。键盘 Tab 可依次操作双方选择。320、390、768、1024、1440 像素宽度均无页面水平溢出，新选择框和按钮高度至少 44 像素。手机为浏览器视口检查，未做手机实机触摸验收；全部九类 AI 的棋力不在此次 UI 变更验证范围内。

浏览器预览中关闭匿名棋谱贡献，未向生产服务提交测试对局。截图与布局明细只留在 `local_artifacts/local-player-setup-20261013/`；紧凑来源哈希与检查收据见 `docs/verification/local-player-setup-20261013/receipt.json`。
