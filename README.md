# LIFELINE（生命线）

LIFELINE 是一款运行在三角网格上的圈地策略游戏。玩家通过节点与自动生成的连线扩张领土，也可以切断敌方防线，使失去初始节点连接的结构立即消失。

项目包含完整的浏览器版本、Python/Pygame 桌面版本，以及基于 Minimax 与 Alpha-Beta 剪枝的人机对战 AI。

## 项目特点

- 自定义三角网格圈地规则，节点、连线与领土共同参与博弈。
- 支持切断攻击、断联结构清除、初始点保护、三点限制和 Superko 全局同形禁手。
- Web 端支持本地双人、三人、可调棋盘大小、人机对战和 AI 提示。
- Web 联机支持账号、房间、准备、倒计时、动作同步、重置投票与断线恢复。
- Pygame 端提供原始双人版本和可视化 AI Demo。
- Minimax AI 支持搜索深度调节、走法排序、启发式评估和非阻塞计算。
- 中英文界面、响应式布局和 Canvas 渲染。

## 快速开始

### Web 版

Web 版是当前功能最完整的入口。它需要 Python 后端来托管页面并提供账号与联机服务；本地对局和 AI 规则计算均在浏览器中完成。

环境要求：

- Python 3.10 或更高版本
- 现代浏览器
- 首次加载页面时可访问互联网，以获取 Vue 与 MathJax CDN 资源

安装依赖：

```powershell
python -m pip install -r ".\web\web后端\requirements.txt"
```

启动：

```powershell
powershell -ExecutionPolicy Bypass -File ".\web\start\start_online_server.ps1"
```

脚本会在 `8000` 至 `8004` 中选择可用端口，后台启动服务并打开浏览器。

进入人机对战：选择本地模式和 `2` 人局，在棋盘设置中选择 AI 先手或后手，再选择简单、普通或困难难度。

### Pygame AI 版

安装依赖：

```powershell
python -m pip install pygame
```

将核心规则目录加入 Python 模块搜索路径：

```powershell
$env:PYTHONPATH = (Resolve-Path ".\core algorithm").Path
```

启动带 AI 的版本：

```powershell
python ".\core algorithm\AI\main_ai.py"
```

启动原始双人版本：

```powershell
python ".\core algorithm\triangular_game.py"
```

运行 AI 无头测试：

```powershell
$env:PYTHONPATH = (Resolve-Path ".\core algorithm").Path
python ".\core algorithm\AI\test_ai_headless.py"
```

## 游戏规则

### 扩张

每名玩家从自己的初始节点出发。新落下的节点必须能连接到己方已有节点，并会自动连接同行、同列或 `x + y` 相同斜线方向上所有无遮挡的己方节点。

### 切断与连通

玩家可以把节点落在敌方连线上发动攻击。连线被切断后，无法再通过逻辑边连接到敌方初始节点的节点与连线会被清除。一次攻击可能改变大范围棋盘结构，因此连接安全与扩张收益同样重要。

### 强制限制

- 对方初始节点附近设有保护区。
- 普通扩张不能主动形成三个两两相邻的己方节点；攻击落子例外。
- Superko 禁止棋局返回任意历史局面，避免无限循环。

### 领土与终局

由己方节点和连线闭合、且内部没有敌方元素的区域视为领土。玩家无合法走法时会自动跳过；所有仍在场玩家连续跳过后对局结束，领土最多者获胜。

## AI 系统

AI 使用 Minimax 对抗搜索和 Alpha-Beta 剪枝选择行动，搜索前会优先排列攻击走法和贴近己方连线的扩张走法。
为控制分支规模，每个节点最多继续搜索前 `20` 个候选。

启发式评估综合考虑：

- 节点数量优势
- 节点与连线覆盖优势
- BFS 领土近似
- 可攻击敌方连线的威胁数量
- 节点与初始节点的连通质量

AI 提供搜索深度 `2`、`3`、`4` 三档难度。精确领土算法只用于真实棋局结算，搜索树使用快速 BFS 近似以保持响应速度。

Web 端通过 Web Worker 执行 AI 搜索；Pygame 端通过后台线程执行搜索。两种方式都避免在 AI 思考时阻塞主界面。

当前 AI 使用范围：

- Web：本地双人局，可选择 AI 先手或后手，并可请求推荐落点。
- Pygame：双人人机对战，可显示 AI Top-5 候选和推荐理由。
- 联机局和 Web 三人局当前不启用 AI。

## Web 架构

Web 主线遵循“前端负责规则与渲染，后端负责账号、房间与同步”的边界。

```text
index.html
  -> main.js
  -> OnlineApp.js
       -> GameController.js
            -> GameEngine.js
            -> Renderer.js
       -> AIEngine.js / AIWorker.js
       -> NetworkManager.js

server.py
  -> HTTP 注册、登录与静态资源
  -> JWT 鉴权
  -> WebSocket 房间、准备、同步与断线恢复
```

- `GameEngine.js` 是 Web 规则计算真源。
- `Renderer.js` 负责 Canvas 绘制。
- `GameController.js` 连接规则、渲染、输入与网络。
- `AIEngine.js` 和 `AIWorker.js` 负责浏览器内 AI。
- `server.py` 转发联机动作，不裁决三角棋盘规则。

## 核心算法

- **物理网格与逻辑边分离**：格点状态用于渲染和占用判断，显式边集合用于连通性判断。
- **BFS 断联清理**：攻击后保留与初始节点相连的最大连通结构，删除飞地。
- **领土流水线**：右手摸墙获取外轮廓，动态贪心修剪边界，泛洪法判定真实覆盖格点。
- **Superko 哈希**：将棋盘、逻辑边、认输状态和下一行动方纳入历史状态判断。
- **搜索状态恢复**：AI 搜索递归中完整保存与恢复棋盘、边、历史哈希、回合和终局状态。

详细规则与实现说明见：

- [核心算法需求文档](./core%20algorithm/algorithm-requirements.md)
- [Web 前后端需求与架构说明](./web/WEB前后端需求与架构说明.md)
- [AI Coding 使用总结](./core%20algorithm/AI/AI_CODING_SUMMARY.md)

## 目录结构

```text
line game/
├── README.md
├── core algorithm/
│   ├── triangular_game.py
│   ├── algorithm-requirements.md
│   └── AI/
│       ├── README.md
│       ├── AI_CODING_SUMMARY.md
│       ├── ai_engine.py
│       ├── ai_game.py
│       ├── main_ai.py
│       └── test_ai_headless.py
└── web/
    ├── README-WEB.md
    ├── WEB前后端需求与架构说明.md
    ├── start/
    ├── web前端/
    │   ├── index.html
    │   ├── OnlineApp.js
    │   ├── GameEngine.js
    │   ├── Renderer.js
    │   ├── AIEngine.js
    │   ├── AIWorker.js
    │   └── NetworkManager.js
    └── web后端/
        ├── server.py
        ├── database.py
        ├── models.py
        └── requirements.txt
```

## 开发与验证

修改规则时，应同时检查 Python 核心和 Web `GameEngine.js` 的行为是否仍符合规则说明。修改 Web 端后，至少验证：

- 本地双人局和三人局可以正常开始、落子、跳过和结算。
- Web AI 先手、后手和三档难度可以运行。
- 切断攻击、断联清除、保护区、三点限制和 Superko 行为正确。
- 边长 `6`、`9`、`15` 下棋盘能够显示和交互。
- 注册、登录、建房、入房、准备、动作同步、重置和断线恢复可用。
- 中文与英文界面、桌面端与移动端布局正常。
