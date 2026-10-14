# LIFELINE Web

浏览器版本包含本地双人/三人、独立棋手选择、联机、教学、保存恢复、棋谱复盘、局面检查和 AI 对比。蓝红双方可分别选择人类或 9 种 AI 策略。

## 启动

在仓库根目录执行：

```powershell
python -m pip install -r "web/web后端/requirements.txt"
python -m uvicorn server:app --app-dir "web/web后端" --host 127.0.0.1 --port 8000
```

访问 <http://127.0.0.1:8000/>。Windows 可改用 `web/start/start_online_server.ps1`，它会复用已有服务或选择 8000–8004 的空闲端口。

## 模型权重

Minimax 可直接运行。若要使用神经模型，下载 [Release 中的 17 个 `.f32` 文件](https://github.com/Chengzong-Zhang/Line-Game/releases/tag/web-ai-transfer-v1-20261013)，按文件名放入对应目录。已安装 GitHub CLI 时可执行：

```powershell
gh release download web-ai-transfer-v1-20261013 --repo Chengzong-Zhang/Line-Game --pattern "*-d14-*.f32" --pattern "*all-sizes*.f32" --dir "web/web前端/assets/research-ai"
gh release download web-ai-transfer-v1-20261013 --repo Chengzong-Zhang/Line-Game --pattern "*-transfer-v1-seed*.f32" --dir "web/web前端/assets/research-ai/transfer-v1"
```

版本、适用尺寸和 SHA-256 来自 `assets/research-ai/` 下的清单。迁移权重是兼容试用，独立棋力尚未评估。

## 从哪里改

| 功能 | 入口 |
| --- | --- |
| 页面、设置、中英文 | `web前端/OnlineApp.js`、`OnlineAppState.js`、`OnlineAppI18n.js` |
| 双方棋手与回合归属 | `LocalPlayerSetup.js`、`LocalAIModes.js` |
| 规则、Canvas 与输入 | `GameEngine.js`、`Renderer.js`、`GameController.js` |
| AI、提示、领土 Worker | `AIWorker.js`、`HintWorkerSession.js`、`TerritoryWorkerSession.js` |
| 棋谱与教学 | `ReplayCodec.js`、`LocalGameSession.js`、`TutorialRunner.js` |
| “妙处”文章 | `guide/interesting/why-code.zh.md`、`why-code.en.md`；加载与解析由 `GuideContent.js` 负责 |
| 账号与房间同步 | `web后端/server.py`、`NetworkManager.js`、`OnlineRoomSync.js` |
| 匿名棋谱收件与筛选 | `training_contributions.py`、`tools/validate_contribution.mjs`、`tools/curate_web_replays.mjs` |
| 发布与公网核验 | `tools/prepare_frontend_release.py`、`deploy_frontend_overlay.py`、`verify_frontend_release.py` |

完整架构见 [docs/web/architecture.md](../docs/web/architecture.md)，产品契约见 [docs/product](../docs/product/)，当前上线与验证记录见 [docs/releases](../docs/releases/) 和 [docs/verification](../docs/verification/)。

## 回归测试

前端测试位于 `web前端/tests/`，后端测试位于 `tests/`。从根目录运行：

```powershell
node --unhandled-rejections=strict "web/web前端/tests/verify-local-player-setup.mjs"
node --unhandled-rejections=strict "web/web前端/tests/verify-replay-codec.mjs"
python -m unittest discover -s web/tests -v
```

测试缓存、临时目录和数据库不进入 Git。真实浏览器操作补足脚本无法覆盖的 Canvas、触摸与实际网络路径。
