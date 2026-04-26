# TriAxis

TriAxis 是一个基于三角网格的圈地策略游戏，支持本地模式与基于 WebSocket 的联机模式。

## 文档

- `docs/algorithm-requirements.md`
  三角网格圈地博弈游戏核心算法需求文档
- `web/README.md`
  Web 端文档与目录入口
- `web/WEB前后端需求与架构说明.md`
  当前 Web 前后端需求、架构、数据流与开发约束说明
- `web/新的需求.md`
  本轮 Web UI 与交互调整需求记录

## 当前能力

- 支持双人或三人对战
- 支持棋盘边长 5 到 15 的整数配置
- 本地模式与联机模式共用同一套前端引擎
- 联机房间由 FastAPI WebSocket 服务负责同步
- 三人模式支持紫方、三方领地统计与三方终局展示
- 联机重置采用全员确认机制，最后确认者记为该轮获胜方

## Web 前端结构

- `web/web前端/index.html`
  页面壳，加载 `main.js`
- `web/web前端/main.js`
  前端启动器，负责加载 Vue 运行时并挂载应用
- `web/web前端/OnlineApp.js`
  在线版主应用，负责组件编排、房间流程、联机状态同步
- `web/web前端/OnlineAppState.js`
  对局设置、会话存储、默认状态等共享状态工具
- `web/web前端/OnlineAppI18n.js`
  文案、语言切换、比分格式化、错误文案映射
- `web/web前端/GameController.js`
  前端控制层，衔接引擎、渲染器与网络层
- `web/web前端/GameEngine.js`
  游戏模型层，负责规则、回合、落子、面积与终局状态
- `web/web前端/Renderer.js`
  Canvas 渲染层，负责节点、连线、领地与棋盘绘制
- `web/web前端/NetworkManager.js`
  WebSocket 客户端封装，负责请求发送、事件订阅与会话恢复
- `web/web前端/styles.css`
  前端样式
- `web/web前端/smoke-test.html`
  前端基础冒烟测试页
- `web/web前端/app.js`
  历史兼容占位文件，真实入口已迁移到 `main.js`

## Web 后端结构

- `web/web后端/server.py`
  FastAPI + WebSocket 房间服务，负责建房、入房、同步操作、重置投票与断线重连

## 启动方式

### 前端

直接打开：

```bash
web/web前端/index.html
```

如果你要联机，建议先启动后端服务，再访问前端页面。

### 后端

```bash
cd web/web后端
pip install -r requirements.txt
python -m uvicorn server:app --host 0.0.0.0 --port 8000
```

也可以使用仓库里的启动脚本：

- `web/start/start_online_server.bat`
- `web/start/start_online_server.ps1`

## 最近整理内容

- 把对局设置统一收敛到顶部单独模块
- 把语言选择整合进对局设置
- 清掉了失效的 `LanguageSwitcher` 组件与隐藏设置区
- 把文案与共享状态从 `OnlineApp.js` 中拆到独立模块
- 修正了部分中文乱码与旧入口文案
- 明确了当前真实入口链路：`index.html -> main.js -> OnlineApp.js`

## 本地验证建议

- 打开 `web/web前端/index.html`，检查本地模式下语言、人数、棋盘边长切换
- 启动后端后，用两个或三个浏览器窗口验证建房、入房、同步落子与全员确认重置
- 如需快速检查前端基础交互，可打开 `web/web前端/smoke-test.html`
