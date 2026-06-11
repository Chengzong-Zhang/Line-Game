# Line Game（连线棋）

Line Game（连线棋）是一款运行在三角网格上的双人圈地策略棋盘游戏，支持本地人人对战和基于 Minimax 的人机对战。

Line Game is a two-player territory-building strategy game played on a triangular grid, with both local human-vs-human and Minimax-based human-vs-AI modes.

## 运行方法 / Getting Started

### 中文

运行环境：

- Python 3.8 或更高版本
- Pygame

安装依赖：

```bash
pip install pygame
```

运行原始人人对战版本：

```bash
python "core algorithm/triangular_game.py"
```

运行带 AI 的版本：

```bash
python AI/main_ai.py
```

### English

Requirements:

- Python 3.8 or later
- Pygame

Install the dependency:

```bash
pip install pygame
```

Start the original human-vs-human version:

```bash
python "core algorithm/triangular_game.py"
```

Start the AI-enabled version:

```bash
python AI/main_ai.py
```

## 操作说明 / Controls

### 中文

- **落子：** 使用鼠标左键点击棋盘上的合法格点。
- **跳过回合：** 点击窗口右下角的 `Skip` 按钮。双方连续跳过后，对局结束。
- **AI 模式选择：**
  - 按 `1`：人人对战。
  - 按 `2`：人类执蓝，对战执红 AI。
  - 按 `3`：执蓝 AI，对战执红人类。
- **AI 难度选择：**
  - 按 `E`：简单，搜索深度为 2。
  - 按 `M`：中等，搜索深度为 3。
  - 按 `H`：困难，搜索深度为 4。
- **开始游戏：** 完成模式和难度选择后，按 `Enter` 或空格键开始。

棋盘共有 9 行，第 `y` 行包含 `9-y` 个格点，共 45 个格点。蓝方从 `(0, 0)` 开始，红方从 `(8, 0)` 开始。玩家每回合在合法位置放置一个节点，新节点会自动连接到同行、同列或同斜线（`x+y` 相同）上的所有可达己方节点。

落子还需遵守以下规则：

- 可以落在敌方连线上发动攻击，并删除被截断的敌方棋子。
- 不能形成三个互相相邻的己方节点。
- 不能落在对方起始节点的相邻保护区内。
- Superko 规则禁止任何使棋盘回到历史局面的落子。

### English

- **Place a node:** Left-click a legal grid point.
- **Skip a turn:** Click the `Skip` button in the lower-right corner. The game ends after two consecutive skips.
- **Select an AI mode:**
  - Press `1` for human vs human.
  - Press `2` for human Blue vs AI Red.
  - Press `3` for AI Blue vs human Red.
- **Select AI difficulty:**
  - Press `E` for Easy, search depth 2.
  - Press `M` for Medium, search depth 3.
  - Press `H` for Hard, search depth 4.
- **Start the game:** Press `Enter` or `Space` after selecting the mode and difficulty.

The board has 9 rows. Row `y` contains `9-y` points, for a total of 45 points. Blue starts at `(0, 0)` and Red starts at `(8, 0)`. On each turn, a player places one node at a legal position. The new node automatically connects to every reachable friendly node on the same row, column, or diagonal where `x+y` is equal.

Moves must also follow these rules:

- A node may be placed on an enemy line to attack and remove disconnected enemy pieces.
- A move may not create three mutually adjacent friendly nodes.
- A player may not place a node in the protection zone adjacent to the opponent's starting node.
- The Superko rule forbids any move that recreates a previous board state.

## 胜负条件 / Winning Conditions

### 中文

当当前玩家没有合法落子时，系统会自动跳过其回合；当双方都无法落子，或双方连续主动跳过时，游戏结束。系统计算双方围成的领土面积，面积较大的一方获胜；面积相同则为平局。

### English

If the current player has no legal move, their turn is skipped automatically. The game ends when neither player can move or when both players skip consecutively. The player controlling the larger territory wins; equal territory results in a draw.

## AI 机制 / AI System

### 中文

AI 使用 **Minimax 搜索**和 **Alpha-Beta 剪枝**选择落子，并提供三档搜索深度：

| 难度 | 按键 | 搜索深度 |
| --- | --- | ---: |
| 简单 | `E` | 2 |
| 中等 | `M` | 3 |
| 困难 | `H` | 4 |

评估函数对以下因素进行加权求和：

- 节点数量优势
- 己方棋子与连线的覆盖优势
- 基于 BFS 的领土近似
- 可攻击敌方连线的威胁数量
- 节点与起始节点的连通质量

搜索前会进行走法排序，优先检查攻击走法，其次检查靠近己方连线的走法，从而提高 Alpha-Beta 剪枝效率。为控制搜索规模，每个节点最多继续搜索排序后的前 20 个候选走法。

AI 在独立线程中计算，主界面保持 60 FPS 刷新。AI 落子后会显示约 1.5 秒的 Top-5 候选点：

- 黄色大圆和星标：最佳候选
- 橙色圆圈：第 2 至第 3 候选
- 灰色圆圈：第 4 至第 5 候选

### English

The AI selects moves using **Minimax search** with **Alpha-Beta pruning** and offers three search depths:

| Difficulty | Key | Search Depth |
| --- | --- | ---: |
| Easy | `E` | 2 |
| Medium | `M` | 3 |
| Hard | `H` | 4 |

The evaluation function uses a weighted combination of:

- Node-count advantage
- Friendly-piece and line-coverage advantage
- BFS-based territory approximation
- Number of available attacks on enemy lines
- Connection quality between nodes and the starting node

Moves are ordered before searching. Attacking moves are checked first, followed by moves near friendly lines, improving Alpha-Beta pruning efficiency. To bound the search space, each search node explores at most the first 20 ordered moves.

AI calculations run in a separate thread so the UI can continue updating at 60 FPS. After the AI moves, its top five candidates are highlighted for about 1.5 seconds:

- Large yellow circle with a star: best candidate
- Orange circles: second and third candidates
- Gray circles: fourth and fifth candidates

## 文件结构 / File Structure

### 中文

```text
line game/
├── core algorithm/
│   ├── triangular_game.py       # 原始游戏、棋盘规则与人人对战入口
│   └── algorithm-requirements.md
├── AI/
│   ├── ai_engine.py             # MinimaxAI 搜索、走法排序与 Alpha-Beta 剪枝
│   ├── ai_game.py               # AI 游戏子类、评估函数、线程与候选点可视化
│   ├── main_ai.py               # AI 版本入口
│   └── minimax_ai_plan.md
└── README.md
```

### English

```text
line game/
├── core algorithm/
│   ├── triangular_game.py       # Core rules and human-vs-human entry point
│   └── algorithm-requirements.md
├── AI/
│   ├── ai_engine.py             # MinimaxAI search, move ordering, and Alpha-Beta pruning
│   ├── ai_game.py               # AI game subclass, evaluation, threading, and highlights
│   ├── main_ai.py               # AI-enabled entry point
│   └── minimax_ai_plan.md
└── README.md
```
