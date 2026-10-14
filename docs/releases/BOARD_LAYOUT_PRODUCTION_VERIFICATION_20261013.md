# 棋盘布局上线独立核验 — 2026-10-13

状态：已上线；公网文件与服务 `PASS-CURRENT`；线上桌面布局快照 `PASS-CURRENT`。完整线上五关、手机实机触摸和 Safari 为 `NOT-RUN`，本记录不签署完整 v1.0 发布门。

- 网站：https://lifelinegame.cn/
- 发布身份：`web-tutorial-five-lessons-20261013`；静态资源版本：`20261013f`。
- 当前分支：`codex/territory-v2-page-correctness`。主工作区含其他未提交工作；线上版本来自独立合并候选 `local_artifacts/tutorial-release-20261013/frontend-v2`，不能把主工作区 E 版本当作完整线上 F 版本。
- 规则版本：`territory-v2`。本次前端增量保留现有模型与棋谱贡献功能，原游戏服务未重启。

## 验证结果

公网独立核验：7 个覆盖文件及保留的 `TrainingContribution.js` 共 8 项 SHA-256 全部匹配，`/api/health` 返回正常。原子目录切换收据为 `ATOMIC_SWITCH_OK`。对应清单、激活收据和独立公网检查见 [部署证据](../verification/tutorial-deploy-20261013/README.md)。

本次前序针对合并候选执行 `tests/verify-board-input.mjs`、`tests/verify-tutorial.mjs`、`tests/verify-replay-codec.mjs`，均退出 0。教学自动项覆盖三点限制拒绝后状态保持与合法重试；这些自动项不能替代真实手机触摸或线上教学操作。

13:38–13:40（Asia/Shanghai）取得正式网站截图和只读 DOM 布局记录。页面加载的 `main.js` 与 `styles.css` 均明确带版本 `20261013f`，正常视口为 1280×720：

- 页面实际宽高为 1280×720，无页面水平或垂直溢出。
- Canvas 与画框边界一致，区域为 1246×608，左上角为 (17,13)。三个面板入口位于画框角落。
- 回合栏宽 180px、高 44px。
- 10 个表情按钮同一行，均为 44×44px，顶部均为 639px。
- 当前已保存的用户会话未显示教学卡；未重置棋局或清空浏览器存储以强制重播教程。

截图：`local_artifacts/layout-release-verify-20261013/production-desktop.jpg`，SHA-256 `d06e8f573fd005de6362135db6d40472c6edd8e03fcd777379c8a4f06fce1f68`。只读布局原始数据见 [production-desktop-layout.json](../verification/layout-production-20261013/production-desktop-layout.json)。早期浏览器超时在直接截图路径下得到缓解；未完成的线上操作项仍保留为未运行。

## 回滚与范围

回滚目录：`/home/ubuntu/line-game/.deploy-artifacts/web-tutorial-five-lessons-20261013.rollback-web前端`。本次未执行回滚，未再次上传或切换生产目录，未提交或推送其他用户工作。现有本地布局/教学历史验收报告原样保留。
