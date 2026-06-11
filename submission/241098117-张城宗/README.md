# LIFELINE（生命线）

课程方向：搜索与规划  
核心 AI：Minimax、Alpha-Beta 剪枝、走法排序与启发式评估

## 游戏说明

LIFELINE 是一款运行在三角网格上的回合制圈地策略游戏。玩家从初始节点出发落子，新节点会与同一直线方向上无遮挡的己方节点自动连接。玩家也可以把节点落在敌方连线上发动切断攻击，使无法连接到敌方初始节点的结构消失。

AI 会作为真实对手参与对局。玩家需要观察 AI 的扩张和攻击路线，在扩大领土的同时保护关键连接。

## 玩家操作

### Web AI Demo（推荐）

1. 启动页面后选择本地模式和 `2` 人局。
2. 选择 AI 先手或 AI 后手，并选择简单、普通或困难难度。
3. 点击合法格点落子。
4. 可使用跳过、重置和 AI 提示功能。
5. AI 回合会显示思考状态，计算完成后自动落子。

### Pygame AI Demo

- 鼠标左键：在合法格点落子。
- `1`：人人对战。
- `2`：人类蓝方对 AI 红方。
- `3`：AI 蓝方对人类红方。
- `E`、`M`、`H`：选择简单、普通、困难难度。
- `Enter` 或空格：开始游戏。
- 游戏中按 `H` 或点击提示按钮：显示 AI 推荐落点。

## 胜利与失败条件

- 当前玩家没有合法走法时，系统自动跳过。
- 所有仍在场玩家连续跳过后，对局结束。
- 由己方节点和连线闭合、且内部没有敌方元素的区域视为领土。
- 终局时领土格点数最多的玩家获胜，面积相同则平局。

## AI 机制与技术选择

AI 使用完整规则引擎生成合法走法，再通过 Minimax 模拟双方的最佳决策。Alpha-Beta 剪枝和走法排序用于减少搜索量；启发式评估综合节点数量、覆盖范围、BFS 领土近似、攻击机会和初始节点连通质量。

本游戏是确定性、完备信息、回合制对抗游戏，因此 Minimax 适合分析当前行动和对方反制。搜索深度提供 `2`、`3`、`4` 三档，能够直接展示决策质量与计算时间之间的权衡。

可观察的 AI 行为包括：

- AI 先手或后手。
- 三档搜索深度。
- 主动扩张、攻击和切断连线。
- AI 思考状态和推荐落点。
- Web Worker 或 Pygame 后台线程中的非阻塞搜索。

## 环境要求

- Windows 10/11
- Python 3.10 或更高版本
- 现代浏览器
- Web 版首次加载时需要联网获取 Vue 与 MathJax CDN 资源

项目不调用 LLM 或付费 API，不需要配置 API Key。

## 运行 Web AI Demo（推荐）

以下命令均在解压后的提交目录根目录执行。

安装依赖：

```powershell
python -m pip install -r ".\src\web\web后端\requirements.txt"
```

启动：

```powershell
powershell -ExecutionPolicy Bypass -File ".\src\web\start\start_online_server.ps1"
```

启动脚本会在 `8000` 至 `8004` 中选择可用端口并打开浏览器。进入本地模式后，选择双人局并启用 AI 对手。

## 运行 Pygame AI Demo

安装依赖：

```powershell
python -m pip install -r ".\src\requirements-pygame.txt"
```

启动：

```powershell
python ".\src\core algorithm\AI\main_ai.py"
```

## 验证 AI

运行无头测试：

```powershell
python ".\src\core algorithm\AI\test_ai_headless.py"
```

测试会让 AI 连续执行多次决策，并检查返回走法合法、棋盘状态发生变化且回合正确切换。

## 源码结构

```text
src/
├── requirements-pygame.txt
├── core algorithm/
│   ├── triangular_game.py
│   └── AI/
│       ├── ai_engine.py
│       ├── ai_game.py
│       ├── main_ai.py
│       └── test_ai_headless.py
└── web/
    ├── start/
    ├── web前端/
    └── web后端/
```

其中：

- `triangular_game.py`：三角网格、落子、切断、连通性与领土规则。
- `ai_engine.py`：Minimax、Alpha-Beta 剪枝和候选走法排序。
- `ai_game.py`：Pygame 人机对局、启发式评估与 AI 可视化。
- `GameEngine.js`：Web 规则引擎。
- `AIEngine.js`、`AIWorker.js`：浏览器中的 AI 搜索与独立线程执行。

