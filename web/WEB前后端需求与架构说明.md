# TriAxis Web 前后端需求与架构说明

本文档用于帮助新的开发者、AI 助手或运维同学快速理解当前 Web 版本的需求边界、模块职责与常见改动入口。

## 1. 项目目标

TriAxis 是一个基于三角网格的圈地策略游戏，目前 Web 版本包含：

- 本地模式
- WebSocket 联机模式
- 双人对战
- 三人对战
- 棋盘边长可配置，范围为 `5-15`
- 中英文切换

当前设计原则是：

- 几何规则由前端 `GameEngine` 计算
- 后端只做房间同步与动作转发
- 前端渲染、规则、联机、UI 状态尽量分层

## 2. 当前功能需求

### 2.1 对战模式

- 支持双人模式与三人模式
- 双人模式玩家为：蓝、红
- 三人模式玩家为：蓝、红、紫
- 本地模式和联机模式都要支持人数选择

### 2.2 棋盘配置

- 支持棋盘边长配置
- 有效范围是 `5-15` 的整数
- 本地模式可直接修改
- 联机模式中由创建房间者确定，加入方读取房间配置

### 2.3 联机房间

- 基于 WebSocket
- 后端维护房间、玩家连接状态、动作日志
- 支持断线重连
- 前端通过服务端返回的 `matchState.actions` 回放棋盘

### 2.4 结算与重置

- 双人模式：连续跳过 2 次结束
- 三人模式：连续跳过 3 次结束
- 结算时展示获胜方和最终领地比分
- 联机模式下重置需要全员确认
- 最后一位确认重置的玩家记为该轮获胜方

## 3. 架构总览

### 3.1 前端分层

- `web前端/GameEngine.js`
  规则模型层，负责棋盘状态、合法落点、连线、领地、回合与胜负
- `web前端/Renderer.js`
  Canvas 渲染层，负责把快照绘制成棋盘、节点、连线和领地
- `web前端/GameController.js`
  前端控制层，桥接引擎、渲染器和联机层，对 Vue 暴露统一接口
- `web前端/NetworkManager.js`
  WebSocket 客户端封装，负责连接、请求等待、事件派发、心跳和会话信息
- `web前端/OnlineApp.js`
  Vue 页面入口，负责组件编排、房间流程、联机状态和页面交互
- `web前端/OnlineAppState.js`
  前端共享状态工具，如默认状态、会话持久化、对局设置标准化
- `web前端/OnlineAppI18n.js`
  文案、多语言映射、比分格式化、错误提示本地化
- `web前端/main.js`
  启动器，只负责加载 Vue 运行时并挂载 `OnlineApp.js`

### 3.2 后端分层

- `web后端/server.py`
  FastAPI + WebSocket 房间服务，同时承载账号认证、静态资源托管和联机同步

## 4. 关键数据流

### 4.1 本地模式

1. 用户在页面选择语言、人数、棋盘边长
2. `OnlineApp` 调用 `GameController.setGameConfig(...)`
3. `GameController` 重建 `GameEngine`
4. `Renderer` 根据引擎快照重绘棋盘

### 4.2 联机模式

1. 用户连接 WebSocket 服务
2. 房主创建房间并携带 `playerCount / gridSize`
3. 服务端生成房间并记录设置
4. 其他玩家加入房间
5. 服务端在房间满员后广播 `ROOM_READY`
6. 前端根据 `matchState.actions` 回放棋盘
7. 后续落子/跳过/重置通过 WebSocket 同步

### 4.3 断线重连

1. 前端保留 `roomId / playerId / color / settings`
2. WebSocket 断开后进入重连流程
3. 重连成功后调用 `join_room(roomId, playerId)`
4. 服务端返回 `matchState`
5. 前端重新回放动作恢复棋盘

## 5. 核心文件职责说明

### 5.1 `web前端/GameEngine.js`

适合修改的场景：

- 玩家枚举扩展
- 回合轮换逻辑
- 终局判定
- 合法落点规则
- 领地统计

不建议在这里做的事：

- 直接操作 DOM
- 写 WebSocket 请求
- 管理按钮文案

### 5.2 `web前端/GameController.js`

适合修改的场景：

- 本地模式与联机模式切换
- 前端状态派生
- 远端动作回放
- 联机锁定原因判断

### 5.3 `web前端/NetworkManager.js`

适合修改的场景：

- 新增 WebSocket 消息类型
- 请求超时策略
- 心跳参数
- 会话恢复机制

### 5.4 `web前端/OnlineApp.js`

适合修改的场景：

- UI 组件布局
- 设置面板交互
- 房间流程
- 结果弹层展示

### 5.5 `web后端/server.py`

适合修改的场景：

- 房间容量与设置校验
- 重置投票规则
- 断线处理
- 房间清理策略
- WebSocket 消息协议
- 账号或鉴权接口

## 6. 当前 WebSocket 协议摘要

### 6.1 客户端 -> 服务端

- `create_room`
- `join_room`
- `player_move`
- `player_skip`
- `player_reset`
- `player_leave`
- `ping`

### 6.2 服务端 -> 客户端

- `ROOM_CREATED`
- `ROOM_JOINED`
- `ROOM_READY`
- `OPPONENT_MOVE`
- `TURN_SKIPPED`
- `RESET_STATUS`
- `MATCH_RESET`
- `PLAYER_LEFT`
- `PONG`
- `ERROR`

## 7. 最近架构整理结果

本轮已经完成的结构优化包括：

- 把 `OnlineApp.js` 中的共享状态逻辑拆到 `OnlineAppState.js`
- 把文案与格式化逻辑拆到 `OnlineAppI18n.js`
- 将语言选择并入顶部“对局设置”
- 清理旧的 `LanguageSwitcher` 路径
- 清理 `RoomPanel` 中隐藏且重复的设置区
- 明确真实入口链路为：

`index.html -> main.js -> OnlineApp.js`

## 8. 后续推荐改造方向

如果后面还要继续整理，建议按下面顺序推进：

1. 把 `OnlineApp.js` 中的 Vue 组件继续拆成独立文件
2. 为 `server.py` 增加更明确的协议类型定义或消息 schema
3. 增加一份前后端联调用的 smoke test
4. 为关键联机流程增加回归测试

## 9. 阅读顺序建议

第一次接手这个项目时，推荐按下面顺序阅读：

1. 本文档
2. `web前端/main.js`
3. `web前端/OnlineApp.js`
4. `web前端/GameController.js`
5. `web前端/GameEngine.js`
6. `web前端/NetworkManager.js`
7. `web后端/server.py`

## 10. 验证清单

每次修改后，至少确认以下几点：

- 本地模式可正常切换双人/三人
- 本地模式可正常切换棋盘边长
- 联机建房后设置会同步给加入者
- 三人模式下分数显示包含紫方
- 联机重置必须全员确认
- 断线重连后棋盘能恢复
- 语法检查通过
