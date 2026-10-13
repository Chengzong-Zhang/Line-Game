# 复盘退出、双 AI 与棋谱上传合并验证

状态：本地主工作区实现与验证通过；本任务未部署生产网站、未启动训练。

主工作区：`C:\coding\py\line game`，分支 `codex/territory-v2-page-correctness`。
原有未提交修改保留。此前 AI 对战和棋谱贡献来自独立发布工作区，当前复盘主工作区缺少这些模块；本次选择性恢复功能，未覆盖当前复盘/教学/布局代码。

实现：

- 复盘时间轴旁直接提供中英文退出按钮，沿用原对局恢复流程。
- AI 选项增加 AI 对战，双方使用当前模型和难度。主界面提供暂停/继续，暂停时阻止人工落子和跳过。
- Worker 结果校验绑定请求、引擎身份、局面 revision、规则版本与行动方；重置、暂停、切换模式及复盘拒绝旧结果。创建复盘文档时先停止 AI，失败则恢复调度。
- 恢复“自愿贡献匿名棋谱”、本地上传队列、失败重试、原有接收/校验/筛选工具。保留既有默认开启及显式关闭后记住选择的行为。只提交完整本地对局，教学和复盘不采集。
- AI 对战双方标记为 AI，避免混入人类示范；服务器收件状态为 `awaiting_review`，不等于已加入训练或更新模型。

来源：独立发布分支 `codex/ai-duel-layout-20261013` 的 `81469b4` 下既有 `LocalAIModes.js`、`TrainingContribution.js`、接收/筛选模块及相关测试。本次重新验证，不继承旧发布的通过状态。

本次自动验证（均退出 0）：

```powershell
node --unhandled-rejections=strict 'web/web前端/tests/verify-ai-duel.mjs'
node --unhandled-rejections=strict 'web/web前端/tests/verify-local-ai-session.mjs'
node --unhandled-rejections=strict 'web/web前端/tests/verify-replay-codec.mjs'
node --unhandled-rejections=strict 'web/web前端/tests/verify-training-contribution.mjs'
node --unhandled-rejections=strict 'web/web前端/tests/verify-local-game-session.mjs'
node --unhandled-rejections=strict 'web/web前端/tests/verify-tutorial-session.mjs'
node --unhandled-rejections=strict 'web/web前端/tests/verify-board-input.mjs'
node --unhandled-rejections=strict 'web/web前端/tests/verify-territory-v2.mjs'
uv run --no-project --python 'C:\Users\zcz\AppData\Roaming\uv\python\cpython-3.13.7-windows-x86_64-none\python.exe' --with fastapi --with httpx --with uvicorn python -m unittest discover -s web/tests -p test_training_contributions.py
```

默认终端 Python 没有 FastAPI；后端验证使用临时依赖环境通过 5 个测试，未改系统解释器或账号数据库。

真实浏览器验收：独立本地预览 `127.0.0.1:8876`，真实 Vue/Canvas/AI Worker 与收件接口。Minimax 深度 3、边长 5，自动完成 10 步，蓝方 8、红方 6；服务器收件 1 局，重复完整对局未新增副本。两方角色均为 `kind=ai`。实际点击暂停显示“继续对战”，恢复后继续至终局；复盘跳至起点后退出，恢复原终局与比分。

响应式检查：1280×720 与 390×844 均无页面水平溢出。退出按钮分别为 100×47.5 和约 145.4×44 像素。此为浏览器视口验证，手机实机触摸及生产交互未运行。

截图仅留本地：`local_artifacts/replay6-verification-20261013/settings-desktop.jpg`、`replay-desktop.jpg`、`replay-mobile.jpg`。紧凑源码哈希见 `verification/replay-ai-contribution-20261013/receipt.json`。
