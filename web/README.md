# LIFELINE Web

网页前端是各安装候选的共用产品来源之一，微信小游戏保留原生 Canvas/API 适配。本分支以已完成的 Web/Mini 来源加本轮指南改进整合；源码、设备、服务与公开状态分别看本轮平台矩阵。

## 本地运行

从仓库根目录执行：

```powershell
python -m pip install -r "web/web后端/requirements.txt"
python -m uvicorn server:app --app-dir "web/web后端" --host 127.0.0.1 --port 8000
```

打开 <http://127.0.0.1:8000/>。页面首次加载 Vue/MathJax CDN 需要联网；平台离线包使用各自的本地资源流程。账号、房间和匿名棋谱涉及服务端，本地静态预览不替代联机服务。

## 能力与模块

- 常规引擎支持 2–15 人，7–15 人使用随机/自定义起点；拓扑为 2–6 人。棋盘形状、模型和 AI 档位依实际模式适配。
- 支持本地对局、教学、提示/计时/悔棋、存档恢复、棋谱导入导出及复盘；房间设置、完整行动顺序与恢复由共享协议约束。
- `web前端/GameEngine.js` 与 `TopologyGameEngine.js` 分别维护常规与拓扑规则；不要用显示面积决定胜负。
- `OnlineApp.js`、`GameController.js`、`Renderer.js` 分别负责应用、对局与绘制；平台适配不应覆盖规则核心。
- Worker 路由包含 `frozen-workers/` 和顶层 `.mjs`；打包必须沿静态/动态依赖完整收录，不能只复制顶层 `.js`。
- 指南由 Guide 模块生成。数学和 Code 各有四章，拓扑理论与旧锚点保持唯一来源。

人类/Minimax 可先用于本地验证。模型资产需按实际 manifest 下载或复用受控已有资产并核对哈希；旧试用模型、固定棋盘模型不能冒充跨规则或通用拓扑棋力。详见 [模型契约](../working/docs/product/LIFELINE_AI_COMPATIBILITY.md)。

## 验证与维护

```powershell
node web/tools/sync-implementation-guides.mjs --check
node --unhandled-rejections=strict web/web前端/tests/verify-guide-content.mjs
node --unhandled-rejections=strict web/web前端/tests/verify-territory-v3.mjs
```

在仓库根目录按改动选择测试。浏览器、微信真机、原生生命周期和跨端房间还需实际验收，自动化检查不替代这些阶段。

[主 README](../README.md) · [文档导航](../working/docs/README.md) · [维护与构建审计](../working/docs/maintenance/alignment-20261031/)
