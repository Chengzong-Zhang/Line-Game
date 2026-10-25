# 各方最新落点高亮（2026-10-25）

基于当前生产 `web-defense15-20261025-r1` / `5094e10` 增量实现，保留现有 2–15 人、棋盘、AI 与混合房间能力。

- Web 各方分别保留最新落点，沿用玩家颜色光圈及中心白点；该方显式或自动 PASS、认输后清除，起点和被切断节点不标记。
- 显示状态只跟随成功提交动作；无效落子不改变标记。重开清空，存档、复盘游标、悔棋和联机重连从完整动作前缀重建；失败重放或渲染异常保留旧状态。
- 小游戏使用隔离规则引擎恢复旧的无行动方日志，缓存已验证前缀；繁忙和领土异步更新时保留有效标记。现有显示开关控制全部玩家标记，中英文改为“各方最新落点”。
- Python/Pygame 双人源同步实际落子、手动/自动 PASS 与绘制；AI 搜索和合法性试探不更改标记。
- 修正 Web 原有高亮路径中 `beginPath` 被行注释吞掉的问题，避免多个光圈之间连接以及中心白点覆盖整个节点。

## 本次验证

工作目录为本报告所在仓库根目录。

| 检查 | 命令 / 证据 | 结果 |
| --- | --- | --- |
| 最新步与恢复语义 | `node web/web前端/tests/verify-latest-moves.mjs` | PASS；含重复认输不能复用先前 PASS 计数 |
| 自动 PASS 独立核对 | `node web/web前端/tests/verify-latest-moves-automatic.mjs` | PASS；2–15 人、430 行动、269 自动 PASS、25 认输、28 回滚 |
| 实际浏览器 | `node web/tools/verify-latest-moves-browser.mjs` | PASS；桌面/手机布局及15人，实际 Canvas 点击、白点像素、跳过、悔棋和重开；详见 `latest-moves-20261025/browser.json` |
| 本地悔棋/存档/棋谱/重连 | `verify-local-undo.mjs`、`verify-local-game-session.mjs`、`verify-replay-codec.mjs`、`verify-online-recovery.mjs`（均在 `web/web前端/tests/`） | PASS |
| 小游戏完整现有测试 | `npm --prefix wechat/minigame test` | 487/487 PASS；更新旧测试中“任意一方 PASS 清空所有标记”的过时预期 |
| Python headless | `python "core algorithm/test_latest_move_highlight.py"` | PASS；真实提交、Superko、PASS、搜索不污染、捕获过滤及重开 |

额外尝试的旧 `verify-ai-control-flow.mjs` 在 frozen CONTROL-SKIP 分值断言失败，`verify-online-start-undo.mjs` 在旧缓存版本的 mock 房间创建处失败；两者在未修改的 defense15 工作树复跑产生相同失败。本次没有修改冻结 AI 分值或测试预期，也没有改变 AI/规则/服务协议。项目地图提及的 `verify-starting-point-session.mjs` 在所选生产提交中不存在。

## 同步与交付

原工作区 `C:/coding/py/line game` 已按窄补丁同步 Controller、Renderer、Python 及相关测试，保留其他任务的未提交领土渲染改动。可复现的统一候选在本次 `codex/latest-move-highlight-20261025` 分支。

Web 计划仅覆盖 Controller/Renderer 及必要的入口缓存依赖，同时原子更新主站与微信服务的两份前端。其他运行资源、后端、数据库和服务进程不变；前驱树和后端哈希必须与现场快照相符，失败恢复前驱。新版本 `web-latest-moves-20261025-r1`，缓存 `20261025-latestmoves1`。

小游戏候选 `0.12.13` 通过独立双次构建和逐文件哈希验证；官方上传、网页激活及 GitHub 推送状态在后续 `latest-moves-20261025/delivery.json` 收据记录。上传开发代码与设置体验版、真机验收、提审和公开分别记录，不能互相替代。
