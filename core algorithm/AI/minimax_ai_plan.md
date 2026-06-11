# Minimax + Alpha-Beta AI 对手实现计划

> **截止日期**：2026-06-14（周日）23:59  
> **总工时估算**：约 10-14 小时

---

## 核心原则：triangular_game.py 零改动

所有新代码分布在三个全新文件中，原文件只读不写：

```
line game/
├── core algorithm/
│   └── triangular_game.py      ← 【禁止修改】现有成熟代码，完全不动
└── AI/
    ├── ai_engine.py            ← 【新建】MinimaxAI 搜索引擎
    ├── ai_game.py              ← 【新建】AITriangularGame 子类（继承 TriangularGame）
    └── main_ai.py              ← 【新建】带 AI 的游戏入口
```

因为 `AI/` 和 `core algorithm/` 是兄弟目录，每个新文件顶部需要加路径注入：

```python
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'core algorithm'))
```

### 继承架构

```
TriangularGame（core algorithm/triangular_game.py，不动）
    │
    └── AITriangularGame（AI/ai_game.py，新建）
            ├── __init__()             ← super().__init__() + 新增 AI 字段
            ├── evaluate()             ← 快速启发式评估（新方法）
            ├── _fast_territory_bfs()  ← BFS领土近似（新方法）
            ├── _save_state()          ← 状态快照（新方法）
            ├── _restore_state()       ← 状态恢复（新方法）
            ├── _apply_move_for_ai()   ← AI专用落子（新方法）
            ├── _ai_compute_move()     ← 子线程计算（新方法）
            ├── run()                  ← override：加模式选择 + AI触发
            └── draw()                 ← override：super().draw() + AI可视化叠加
```

**运行原始游戏**：`python "core algorithm/triangular_game.py"`（人人对战，完全不受影响）  
**运行 AI 版本**：`python AI/main_ai.py`（新入口）

---

### 关键约束（所有提示词中必须遵守）

| 约束 | 原因 |
|------|------|
| `_compute_inner_hull()` **不能**在 Minimax 树节点中调用 | BFS轮廓收紧是 O(n²) 循环，每步约 20-200ms |
| `_get_covered_points()` **不能**在 Minimax 树节点中调用 | 泛洪 BFS 同样太慢 |
| 评估函数必须 < 1ms/次 | 搜索深度 3 时节点数约数万 |
| 合法走法用现有 `_is_legal_move(pos, player)` | 已含 Superko + 三点限制 + 保护区 |
| 状态快照必须含完整 6 个字段 | 缺任何一个都会导致规则失效 |

---

## Phase 1：ai_engine.py（Minimax 搜索引擎）

**新建文件**：`AI/ai_engine.py`  
**耗时估算**：3-4 小时  
**可并行**：任务 1A 和 1B 在同一文件但逻辑独立，建议先 1A 后 1B，或一个终端完成整个文件

---

### 任务 1A：MinimaxAI 类 + 走法生成器

**输出**：`MinimaxAI.__init__`、`get_legal_moves`、`order_moves`

**设计规格**：

走法排序优先级（降序）：
1. **攻击走法**：目标格点当前是对手线点（`WHITE_LINE` 或 `BLACK_LINE`），落子触发攻击
2. **扩张走法**：目标格点的任意相邻格点是己方线点
3. **普通走法**：其他合法落子

每层最多保留前 **20** 个走法（排序后截断），控制搜索宽度。

---

**📋 给 AI 的提示词（任务 1A）**

```
新建文件：AI/ai_engine.py

文件顶部必须加路径注入（因为 AI/ 和 core algorithm/ 是兄弟目录）：
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'core algorithm'))
from triangular_game import TriangularGame, Player, PointState

【game 对象的相关接口（只读，不要修改 TriangularGame 类）】
- game.grid: dict {(x,y): PointState}，所有格点状态
- game.current_player: Player
- game._is_legal_move(pos, player) → bool：合法性检查（含Superko，不修改状态）
- game._get_adjacent_positions(pos) → List[Tuple[int,int]]：pos 的有效相邻格点
- game._get_player_nodes(player) → List[Tuple]：己方节点坐标列表
- game._get_player_lines(player) → List[Tuple]：己方线点坐标列表

枚举值：
- Player.BLACK（蓝方）/ Player.WHITE（红方）
- PointState.EMPTY / BLACK_NODE / BLACK_LINE / WHITE_NODE / WHITE_LINE

【你的任务】
在 ai_engine.py 中创建 MinimaxAI 类，实现以下三个方法：

1. __init__(self, depth: int = 3)
   保存搜索深度参数。

2. get_legal_moves(self, game, player: Player) -> List[Tuple[int,int]]
   遍历 game.grid 中所有格点，返回 game._is_legal_move(pos, player) == True 的坐标列表。

3. order_moves(self, game, moves: List[Tuple[int,int]], player: Player) -> List[Tuple[int,int]]
   将 moves 分三类排序后截断至最多 20 个返回：
   
   - 类别0（最高优先）：攻击走法
     判断：game.grid[pos] 是对手线点
     对手线点：WHITE_LINE（player==BLACK时），BLACK_LINE（player==WHITE时）
   
   - 类别1（中优先）：扩张走法
     判断：game._get_adjacent_positions(pos) 中存在己方线点
     己方线点：BLACK_LINE（player==BLACK时），WHITE_LINE（player==WHITE时）
   
   - 类别2（低优先）：其余合法走法
   
   三类按顺序拼接，截断至 min(len, 20) 返回。

输出：完整的 ai_engine.py 文件内容（含 import 语句）。不要添加注释。
```

---

### 任务 1B：Minimax + Alpha-Beta 引擎

**输出**：`MinimaxAI.minimax`、`MinimaxAI.get_best_move`、`MinimaxAI.get_top_moves`

**设计规格**：

`minimax` 终止条件（依次检查）：
1. `game.game_over == True` → 返回 `game.evaluate(ai_player)`
2. `depth == 0` → 返回 `game.evaluate(ai_player)`
3. 无合法走法 → 模拟 skip（不落子，切换玩家，depth-1 递归）

`get_top_moves` 是 `get_best_move` 的扩展版，返回按分值降序排列的 top-N 个 `(pos, score)` 列表，供可视化使用。

> **注意**：`game.evaluate()`、`game._save_state()`、`game._restore_state()`、`game._apply_move_for_ai()` 这四个方法在 Phase 2 的 `AITriangularGame` 子类中定义，不在 `TriangularGame` 中。  
> 这里写代码时假设 `game` 已经拥有这些方法（即 `game` 是 `AITriangularGame` 实例），直接调用即可。

---

**📋 给 AI 的提示词（任务 1B）**

```
继续编辑 AI/ai_engine.py，在 MinimaxAI 类中追加以下三个方法。

已有方法（不要重复实现）：
- self.get_legal_moves(game, player)
- self.order_moves(game, moves, player)
- self.depth

game 对象接口（AITriangularGame 实例，已包含以下方法，直接调用）：
- game.current_player: Player
- game.game_over: bool
- game.consecutive_skips: int
- game.evaluate(player) → float：快速启发式评估（从 player 视角）
- game._save_state() → dict：保存完整状态快照（含 grid/edges/history_hashes/skips/current_player）
- game._restore_state(snapshot: dict)：完整恢复状态
- game._apply_move_for_ai(pos) → bool：落子+Superko检查+切换玩家，返回是否成功
- game._switch_player()：切换 current_player

枚举：Player.BLACK, Player.WHITE

【你的任务】追加三个方法：

1. minimax(self, game, depth: int, alpha: float, beta: float, maximizing_player: bool, ai_player: Player) -> float

   终止条件：
   a. game.game_over → return game.evaluate(ai_player)
   b. depth == 0 → return game.evaluate(ai_player)
   
   正常流程：
   c. legal_moves = self.get_legal_moves(game, game.current_player)
   d. 若 legal_moves 为空（须跳过）：
      - snapshot = game._save_state()
      - game.consecutive_skips += 1
      - if game.consecutive_skips >= 2: game.game_over = True
      - else: game._switch_player()
      - score = self.minimax(game, depth-1, alpha, beta, not maximizing_player, ai_player)
      - game._restore_state(snapshot)
      - return score
   e. ordered = self.order_moves(game, legal_moves, game.current_player)
   f. maximizing_player==True（AI方）：
      - best_val = float('-inf')
      - for pos in ordered: snapshot=_save_state(); _apply_move_for_ai(pos); recurse; _restore_state(snapshot)
      - alpha = max(alpha, best_val)；if beta <= alpha: break
      - return best_val
   g. maximizing_player==False（对手方）：
      - best_val = float('inf')，beta剪枝
      - return best_val

2. get_best_move(self, game, ai_player: Player) -> Optional[Tuple[int,int]]
   - legal_moves = self.get_legal_moves(game, ai_player)
   - 若为空返回 None
   - ordered = self.order_moves(game, legal_moves, ai_player)
   - 遍历 ordered，每个 pos：snapshot=_save_state()；_apply_move_for_ai(pos)；
     val = minimax(game, self.depth-1, float('-inf'), float('inf'), False, ai_player)；_restore_state(snapshot)
   - 返回分值最高的 pos

3. get_top_moves(self, game, ai_player: Player, top_n: int = 5) -> List[Tuple[Tuple[int,int], float]]
   与 get_best_move 相同逻辑，但收集所有 (pos, score) 对，
   按 score 从高到低排序后返回前 top_n 项。

输出：只输出这三个方法的代码（4空格缩进，追加到 MinimaxAI 类末尾）。
需要在文件顶部添加：from typing import Optional, List, Tuple（若尚未导入）。不要添加注释。
```

---

## Phase 2：ai_game.py（子类 + 全部新功能）

**新建文件**：`AI/ai_game.py`  
**耗时估算**：4-5 小时  
**可并行**：任务 2A（评估 + 状态管理）和 2B（UI override）独立，可两个终端同时写，最后合并到同一文件

---

### 任务 2A：AITriangularGame 子类 + 评估函数 + 状态管理

**输出**：`AITriangularGame` 类的 `__init__`、`evaluate`、`_fast_territory_bfs`、`_save_state`、`_restore_state`、`_apply_move_for_ai`、`_ai_compute_move`

**设计规格**：

评估函数 5 个加权子项：

| 子项 | 计算方式 | 权重 |
|------|----------|------|
| 节点优势 | `len(my_nodes) - len(opp_nodes)` | 15 |
| 棋子覆盖优势 | `(my_nodes+my_lines) - (opp_nodes+opp_lines)` 数量差 | 8 |
| 快速领土估算 | `_fast_territory_bfs(player) - _fast_territory_bfs(opponent)` | 20 |
| 攻击威胁 | 遍历对手线点，统计己方 `_is_legal_move(opp_line_pt, player)==True` 的数量 | 12 |
| 连通质量 | 己方节点中连通到起始节点的数量 - 不连通的数量 | 10 |

`_fast_territory_bfs`：从己方所有棋子出发 BFS，不越过敌方棋子，统计可达格点数（领土面积快速近似）。

状态快照必须完整包含 6 个字段：
- `self.grid`（dict，深拷贝）
- `self.black_edges`（set of frozenset，深拷贝）
- `self.white_edges`（set of frozenset，深拷贝）
- `self.history_hashes`（set of str，深拷贝）
- `self.consecutive_skips`（int）
- `self.current_player`（Player）

---

**📋 给 AI 的提示词（任务 2A）**

```
新建文件：AI/ai_game.py

你需要创建 AITriangularGame 类，继承自 TriangularGame，不修改父类任何代码。

导入方式（文件顶部必须加路径注入，因为 triangular_game.py 在兄弟目录 core algorithm/ 下）：
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'core algorithm'))
from triangular_game import TriangularGame, Player, PointState
from ai_engine import MinimaxAI
from collections import deque
import threading
from typing import Optional, List, Tuple

父类 TriangularGame 已有的方法（直接调用 self.xxx，不要重新实现）：
- self._get_player_nodes(player) → List[Tuple]
- self._get_player_lines(player) → List[Tuple]
- self._get_adjacent_positions(pos) → List[Tuple]
- self._is_legal_move(pos, player) → bool（含Superko，不修改状态）
- self._is_connected_to_initial(pos, player) → bool
- self._add_node(pos) → bool（会修改 self.grid/edges，由 current_player 决定归属）
- self._switch_player()
- self._compute_state_hash(next_player) → str
- self.handle_skip()
- self.handle_click(pos)（接收屏幕坐标）
- self._get_screen_pos(x, y) → (int, int)

父类已有的状态字段（直接读写）：
- self.grid: dict {(x,y): PointState}
- self.black_edges: set of frozenset
- self.white_edges: set of frozenset
- self.history_hashes: set[str]
- self.consecutive_skips: int
- self.current_player: Player
- self.game_over: bool

【你的任务】实现 AITriangularGame 类，包含以下方法：

1. __init__(self)
   调用 super().__init__()，然后添加字段：
   - self.ai_mode = 'human'       # 'human' / 'ai_white' / 'ai_black'
   - self.ai_player = None        # Player 或 None
   - self.ai = None               # MinimaxAI 实例或 None
   - self.ai_thinking = False
   - self.ai_move_result = None   # None | Tuple[int,int] | 'skip'
   - self.ai_candidates = []      # List[(pos, score)]，top-5候选
   - self._ai_candidate_show_until = 0  # 毫秒时间戳，候选点显示截止
   - self._ai_depth = 3           # 默认搜索深度

2. _fast_territory_bfs(self, player: Player) -> int
   从 player 所有己方棋子出发 BFS，不穿越敌方棋子，返回可达格点数。
   逻辑：
   - my_states = {BLACK_NODE, BLACK_LINE} if player==BLACK else {WHITE_NODE, WHITE_LINE}
   - opp_states = {WHITE_NODE, WHITE_LINE} if player==BLACK else {BLACK_NODE, BLACK_LINE}
   - frontier = 所有 self.grid[pos] in my_states 的 pos
   - BFS 扩展：跳过 opp_states 中的格点
   - 返回 visited 集合大小

3. evaluate(self, player: Player) -> float
   从 player 视角返回局面分值，加权求和：
   - 节点优势（权重15）：len(my_nodes) - len(opp_nodes)
   - 棋子覆盖优势（权重8）：len(my_nodes+my_lines) - len(opp_nodes+opp_lines)
   - 领土优势（权重20）：self._fast_territory_bfs(player) - self._fast_territory_bfs(opp)
   - 攻击威胁（权重12）：遍历对手所有线点，统计 self._is_legal_move(pt, player)==True 的数量
   - 连通质量（权重10）：统计己方节点中 self._is_connected_to_initial(n, player) 为True的数量
                         减去为False的数量

4. _save_state(self) -> dict
   返回包含以下6个字段深拷贝的字典：
   {'grid': dict(self.grid),
    'black_edges': {frozenset(e) for e in self.black_edges},
    'white_edges': {frozenset(e) for e in self.white_edges},
    'history_hashes': set(self.history_hashes),
    'consecutive_skips': self.consecutive_skips,
    'current_player': self.current_player}

5. _restore_state(self, snapshot: dict) -> None
   从快照恢复全部6个字段（直接赋值，无需深拷贝，因为 snapshot 已是独立拷贝）。

6. _apply_move_for_ai(self, pos: tuple) -> bool
   为 Minimax 树搜索设计的落子接口，不触发 UI 渲染：
   a. 保存 grid/edges 临时快照（用于Superko回滚）：
      tmp_grid = dict(self.grid)
      tmp_be = {frozenset(e) for e in self.black_edges}
      tmp_we = {frozenset(e) for e in self.white_edges}
   b. 调用 self._add_node(pos)，若返回 False → return False
   c. 计算 next_player 哈希：
      next_p = Player.WHITE if self.current_player==Player.BLACK else Player.BLACK
      h = self._compute_state_hash(next_p)
   d. 若 h in self.history_hashes：
      self.grid = tmp_grid; self.black_edges = tmp_be; self.white_edges = tmp_we
      return False
   e. self.history_hashes.add(h)
      self.consecutive_skips = 0
      self._switch_player()
      return True

7. _ai_compute_move(self) -> None
   在子线程中运行（不调用任何 pygame API）：
   - top = self.ai.get_top_moves(self, self.ai_player, top_n=5)
   - self.ai_candidates = top
   - self.ai_move_result = top[0][0] if top else 'skip'

输出：完整的 ai_game.py 文件内容，目前只包含 AITriangularGame 类和上述7个方法（run/draw 由任务2B补充）。不要添加注释。
```

---

### 任务 2B：run() 和 draw() 的 override

**输出**：`AITriangularGame.show_mode_selection`、`AITriangularGame.run`、`AITriangularGame.draw`

**设计规格**：

`show_mode_selection()`：全屏 Pygame 界面，键盘响应：
- `1`：人人对战
- `2`：人类(蓝) vs AI(红)
- `3`：AI(蓝) vs 人类(红)
- `E`/`M`/`H`：简单(depth=2) / 中等(depth=3) / 困难(depth=4)
- `ENTER` 或 `SPACE`：确认进入游戏

`draw()`：先调用 `super().draw()`（保留全部原有渲染），再叠加：
- 若 `ai_thinking==True`：顶部居中显示"AI 思考中..."（旋转省略号动画）
- 若候选点显示时间未到期：绘制 top-5 候选点圆圈（第1名黄色半径14+★，第2-3名橙色半径11，第4-5名灰色半径9）

`run()`：在原有事件循环基础上，增加：
1. 循环开始前调用 `show_mode_selection()`
2. 每帧在事件处理后，检查是否需要触发 AI 计算（启动 daemon 线程）
3. 检查 `ai_move_result` 是否就绪，若就绪则调用 `handle_skip()` 或 `handle_click()`

---

**📋 给 AI 的提示词（任务 2B）**

```
继续编辑 AI/ai_game.py，在 AITriangularGame 类中追加以下三个方法。

已有字段（任务2A已在 __init__ 中添加）：
- self.ai_mode / self.ai_player / self.ai / self.ai_thinking
- self.ai_move_result / self.ai_candidates / self._ai_candidate_show_until / self._ai_depth

已有方法（任务2A已实现，不要重复）：
- self._ai_compute_move()

父类已有（直接调用）：
- super().draw()：渲染完整游戏画面（包含 pygame.display.flip()）
- self.handle_click(screen_pos)：处理屏幕坐标点击
- self.handle_skip()
- self._get_screen_pos(x, y) → (int, int)
- self.game_over / self.current_player
- self._font_sm / self._font_md / self._font_lg / self._font_xl
- self.screen / self.SCREEN_WIDTH / self.SCREEN_HEIGHT / self.clock
- self.skip_button_rect

pygame 颜色常量（父类已有）：self.WHITE / self.BLACK / self.GRAY

【你的任务】追加三个方法：

1. show_mode_selection(self) -> None
   显示全屏模式选择界面，循环等待输入：
   - 背景白色，标题"Line Game — AI 对战模式" 居中（使用 self._font_xl）
   - 三行模式选项（使用 self._font_lg）：
     [1] 人人对战   [2] 人类(蓝) vs AI(红)   [3] AI(蓝) vs 人类(红)
   - 难度行：[E]简单  [M]中等  [H]困难，当前选中难度高亮（蓝色）
   - 提示行："按 ENTER 开始"（self._font_md，灰色）
   - 键盘响应：
     - '1'/'2'/'3' → 设置 self.ai_mode（'human'/'ai_white'/'ai_black'）
     - 'e'/'m'/'h'（不区分大小写）→ 设置 self._ai_depth（2/3/4）
     - ENTER 或 SPACE → 退出循环
     - QUIT 事件 → pygame.quit(); sys.exit()
   - 退出前根据 ai_mode 设置：
     if ai_mode=='ai_white': self.ai_player=Player.WHITE; self.ai=MinimaxAI(self._ai_depth)
     if ai_mode=='ai_black': self.ai_player=Player.BLACK; self.ai=MinimaxAI(self._ai_depth)

2. draw(self) -> None
   覆盖父类 draw()：
   a. 调用 super().draw()（执行全部原有渲染，包括 display.flip()）
   
   注意：super().draw() 已经调用了 pygame.display.flip()。
   所以 AI 叠加层要在 super().draw() 之前绘制，流程如下：
   
   实际上更简洁的方式：不调用 super().draw()，而是将所有 super().draw() 的内容复制过来再追加。
   但这样会改动父类代码逻辑。
   
   最简单的正确方式：
   a. 将父类 draw 中的 pygame.display.flip() 通过以下 trick 临时替换：
      在调用 super().draw() 之前不做任何处理。
   
   实际上最干净的方式：
   a. 直接调用 super().draw()（它会 flip）
   b. 然后在 self.screen 上绘制叠加层
   c. 再调用一次 pygame.display.flip()
   这样叠加层会在下一帧显示，有1帧延迟，但对于AI可视化完全可接受。
   
   按以下流程实现 draw(self)：
   
   步骤1：调用 super().draw()（完成基础渲染+第一次flip）
   
   步骤2：绘制 AI 思考动画（若 self.ai_thinking==True）：
   - frame = (pygame.time.get_ticks() // 400) % 4
   - dots = '' / '.' / '..' / '...'（按frame）
   - text = f"AI 思考中{dots}"
   - 用 self._font_md 渲染，颜色 (100,100,100)，居中显示在屏幕顶部 y=10 位置
   - blit 到 self.screen
   
   步骤3：绘制候选点可视化（若 pygame.time.get_ticks() < self._ai_candidate_show_until）：
   用 pygame.Surface((self.SCREEN_WIDTH, self.SCREEN_HEIGHT), pygame.SRCALPHA) 创建透明层：
   - 索引0（最优）：颜色(255,215,0,180)，半径14
     额外在圆心渲染"★"文字（self._font_sm，黑色）
   - 索引1-2：颜色(255,140,0,150)，半径11
   - 索引3-4：颜色(150,150,150,120)，半径9
   对每个候选 (pos, score)：screen_pos = self._get_screen_pos(*pos)，在透明层上画圆
   blit 透明层到 self.screen
   
   步骤4：若步骤2或步骤3有任何绘制，调用 pygame.display.flip()

3. run(self) -> None
   覆盖父类 run()：
   
   a. 调用 self.show_mode_selection()
   
   b. 主循环（while running）：
      - 事件处理（与父类相同：QUIT退出，MOUSEBUTTONDOWN调用self.handle_click，skip按钮）
      
      - AI 触发（在事件处理之后）：
        if (not self.game_over
            and self.ai_player is not None
            and self.current_player == self.ai_player
            and not self.ai_thinking
            and self.ai_move_result is None):
            self.ai_thinking = True
            threading.Thread(target=self._ai_compute_move, daemon=True).start()
      
      - AI 落子（检查结果是否就绪）：
        if self.ai_move_result is not None:
            result = self.ai_move_result
            self.ai_move_result = None
            self.ai_thinking = False
            self._ai_candidate_show_until = pygame.time.get_ticks() + 1500
            if result == 'skip':
                self.handle_skip()
            else:
                self.handle_click(self._get_screen_pos(*result))
      
      - self.draw()
      - self.clock.tick(60)

输出：只输出这三个方法的代码（追加到 ai_game.py 的 AITriangularGame 类末尾）。不要添加注释。
需要确认文件顶部有 import sys 和 import pygame。
```

---

## Phase 3：main_ai.py（新入口）

**新建文件**：`AI/main_ai.py`  
**耗时估算**：10 分钟  
**依赖**：Phase 2 全部完成

---

**📋 给 AI 的提示词（Phase 3）**

```
新建文件：AI/main_ai.py

内容极简，只做一件事：启动带 AI 的游戏。

import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'core algorithm'))
from ai_game import AITriangularGame

if __name__ == '__main__':
    game = AITriangularGame()
    game.run()

就这几行，不要添加任何其他代码或注释。
```

---

## Phase 4：文档

**耗时估算**：1-2 小时  
**依赖**：Phase 2 完成  
**可并行**：4A 和 4B 完全独立

---

### 任务 4A：README.md

**📋 给 AI 的提示词（任务 4A）**

```
为以下游戏编写 README.md。

【游戏信息】
名称：Line Game（连线棋）
类型：双人策略棋盘游戏，支持人机对战
运行环境：Python 3.8+，Pygame

游戏规则：
- 棋盘：9行三角网格，第y行有(9-y)个格点，共45个格点
- 蓝方起始节点(0,0)，红方起始节点(8,0)
- 每回合在空格点落一个节点，节点自动与所有可达己方节点连线
- 连线规则：同行(y相同) / 同列(x相同) / 同斜线(x+y相同)
- 攻击：可落子在敌方连线上，触发攻击（删除被截断的敌方棋子）
- 三点限制：不能形成三个互相相邻的己方节点
- 保护区：不能落子在对方起始节点的相邻格点
- Superko规则：禁止任何导致局面回到历史状态的落子
- 胜负：双方都无法落子时游戏结束，领土面积大者获胜

AI 功能：
- 算法：Minimax + Alpha-Beta 剪枝
- 难度：简单(depth=2)、中等(depth=3)、困难(depth=4)
- 评估函数：节点优势、棋子覆盖、BFS领土近似、攻击威胁、连通质量加权求和
- 走法排序：攻击走法优先，提升剪枝效率
- 可视化：AI top-5候选落子点用彩色圆圈高亮（黄/橙/灰），落子后显示1.5秒
- 非阻塞：AI在独立线程计算，UI保持60fps流畅

文件结构：
core algorithm/
├── triangular_game.py   原始游戏（人人对战）
├── ai_engine.py         MinimaxAI 搜索引擎
├── ai_game.py           AI版游戏子类
└── main_ai.py           带AI的游戏入口

运行原始游戏：python "core algorithm/triangular_game.py"
运行AI版本：  python AI/main_ai.py

依赖：pygame（pip install pygame）

【输出要求】
生成完整 README.md，包含章节：
1. 游戏名称和一句话描述
2. 运行方法（pip install 命令 + 两种启动命令）
3. 操作说明（鼠标点击、跳过按钮、AI模式选择键位）
4. 胜负条件
5. AI机制说明（技术选型、评估函数设计、可视化说明）
6. 文件结构

用中英双语（先中文后英文）写每个章节。Markdown格式，不使用emoji。
```

---

### 任务 4B：AI_CODING_SUMMARY.md

**📋 给 AI 的提示词（任务 4B）**

```
为游戏AI课程大作业编写 AI_CODING_SUMMARY.md（AI Coding 使用总结），500-700字，中文。

【背景】
项目：为现有三角网格连线棋游戏（Python + Pygame）添加 Minimax + Alpha-Beta 剪枝 AI 对手
工具：Claude Code（Anthropic）
策略：不修改原有成熟代码，用子类继承方式扩展

【需要体现的真实细节】
AI 帮助完成的工作：
- 阅读并分析现有代码架构，识别可复用的方法（_is_legal_move, _add_node, _get_adjacent_positions 等）
- 设计并生成快速启发式评估函数（BFS领土近似替代慢速ConvexHull算法）
- 生成 Minimax + Alpha-Beta 框架代码
- 生成走法排序逻辑（攻击走法优先提升剪枝效率）
- 生成 Pygame 子类代码（模式选择界面、AI可视化圆圈、线程集成）
- 识别 _compute_inner_hull 太慢不能在搜索树中使用这一关键约束

需要人工判断和修改的部分：
- 评估函数各子项权重的调整（AI初始版本偏保守，攻击威胁权重不足）
- 发现状态快照漏掉 history_hashes 字段导致 Superko 规则失效，人工补充
- 搜索深度与响应时间的权衡，最终改为可配置难度参数
- draw() override 中 pygame.display.flip() 的双重调用问题（叠加层时序）

AI 的局限：
- 对游戏的特定规则（三点限制、Superko、保护区）没有先验知识，必须在提示词中精确描述
- 生成的代码有时忽略线程安全细节（如 ai_move_result 置 None 的时机）
- 不了解 pygame 渲染管线细节（flip 调用顺序），需要人工调试

【分5个小节输出】：
1. 使用了哪些AI工具
2. AI帮你完成了哪些工作
3. 哪些部分AI做得不好，需要你自己判断、修改或调试
4. 你对"AI辅助开发游戏"的体会
5. 如果重做，你会如何更好地使用AI

语气真实、有具体细节。不要夸大AI的作用，体现你参与了设计和调试。
```

---

## 完整文件清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `core algorithm/triangular_game.py` | **不动** | 原始游戏，零改动 |
| `AI/ai_engine.py` | **新建** | MinimaxAI 搜索引擎 |
| `AI/ai_game.py` | **新建** | AITriangularGame 子类 |
| `AI/main_ai.py` | **新建** | 带AI的游戏入口 |
| `AI/README.md` | **新建** | 游戏说明文档 |
| `AI/AI_CODING_SUMMARY.md` | **新建** | AI工具使用总结 |

---

## 实施顺序

```
Day 1
├── 终端1: Phase 1 — ai_engine.py（任务1A + 1B，顺序完成）
└── 终端2: Phase 2 任务2A — ai_game.py 前半部分（__init__ 到 _ai_compute_move）

Day 2
├── 终端1: Phase 2 任务2B — ai_game.py 后半部分（show_mode_selection / draw / run）
├── 整合测试：python AI/main_ai.py，验证AI可以走棋
└── 调试评估函数权重（观察AI行为是否合理）

Day 3
├── 终端1: Phase 3 — main_ai.py（10分钟）
├── 终端2: Phase 4A — README.md
├── 终端3: Phase 4B — AI_CODING_SUMMARY.md
└── 录制 demo.mp4（2-3分钟），打包提交
```

---

## 快速验证脚本

Phase 1+2A 完成后，用此脚本验证 AI 可以正常走棋（无需 Pygame 窗口）：

```python
# test_ai_headless.py（放在 AI/ 目录下运行：python AI/test_ai_headless.py）
import os
os.environ['SDL_VIDEODRIVER'] = 'dummy'  # 无头模式
import pygame
pygame.init()

import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'core algorithm'))

from ai_game import AITriangularGame
from ai_engine import MinimaxAI
from triangular_game import Player

game = AITriangularGame()
ai = MinimaxAI(depth=2)

for i in range(5):
    move = ai.get_best_move(game, Player.WHITE)
    print(f"Step {i+1}: AI(WHITE) → {move}, score={game.evaluate(Player.WHITE):.1f}")
    if move is None:
        game.handle_skip()
    else:
        game.handle_click(game._get_screen_pos(*move))
    if game.game_over:
        break

print("验证通过")
```
