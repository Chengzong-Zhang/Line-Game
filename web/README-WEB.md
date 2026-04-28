# Web 目录说明

这个目录收纳了 LIFELINE Web 端的源码、启动脚本和需求文档。后续继续开发时，建议先从这里进入，而不是直接在多个说明文件之间来回查找。

## 文档入口

- `WEB前后端需求与架构说明.md`
  当前真实 Web 架构、功能需求、数据流、协议摘要与验证清单
- `WEB前后端需求和架构说明.mc`
  与上面内容同步的 `.mc` 版本
- `新的需求.md`
  本轮 UI/UX 调整需求记录

## 目录结构

- `web前端/`
  前端页面、Canvas 渲染、Vue 应用与样式
- `web后端/`
  FastAPI、WebSocket 房间服务与数据库模型
- `start/`
  本地启动后端的脚本

## 当前真实入口

- 前端入口：`web前端/index.html -> main.js -> OnlineApp.js`
- 后端入口：`web后端/server.py`

## 阅读建议

如果你要改：

- UI 与页面交互：先看 `web前端/OnlineApp.js` 和 `web前端/styles.css`
- 文案与语言：先看 `web前端/OnlineAppI18n.js`
- 默认设置与本地会话：先看 `web前端/OnlineAppState.js`
- 游戏规则：先看 `web前端/GameEngine.js`
- 渲染性能：先看 `web前端/Renderer.js`
- 联机流程：先看 `web前端/NetworkManager.js` 和 `web后端/server.py`

## 运行与验证

- 前端页面：`web前端/index.html`
- 前端冒烟页：`web前端/smoke-test.html`
- 后端启动脚本：`start/start_online_server.ps1`

## 临时文件约定

仓库内不应长期保留这些运行产物：

- `temp_test*.db`
- `root_test*.db`
- `scratch.db*`
- `game.recovered-*.db*`
- 浏览器临时 profile 或 crash 缓存
- Python `__pycache__`

这类文件可在调试后直接清理，不应作为源码结构的一部分长期保留。
