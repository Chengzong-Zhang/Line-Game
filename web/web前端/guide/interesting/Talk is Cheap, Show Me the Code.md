## Talk is Cheap, Show Me the Code

## 工程规模

GitHub 仓库：

```text
https://github.com/Chengzong-Zhang/Line-Game
```

当前工程统计口径：排除 `.git` 与 `__pycache__`，按当前工作区文件计算。

| 指标 | 数值 |
|---|---:|
| 总文件数 | 47 |
| 文本源文件数 | 32 |
| 代码文件数 | 20 |
| 代码总行数 | 11,548 |
| 文档与文本总行数 | 13,228 |
| 工程体积 | 约 7.6 MB |

统计说明：

- 代码文件包含 `.py`、`.js`、`.html`、`.css`、`.ps1`、`.bat`。
- 文本源文件包含代码文件、Markdown 文档、脚本与配置文本。
- 图片、压缩样例、Git 元数据和 Python 缓存文件不计入行数。

本文说明 LIFELINE / TriAxis 的核心规则引擎、拓扑建模、领土计算、禁手机制与 Web 架构边界。

游戏运行在三角网格上。玩家看到的是节点、连线与领土；代码处理的是离散坐标、状态枚举、显式边集、BFS 连通性、泛洪覆盖集、历史局面哈希与回合状态机。

核心实现目标：

- 用离散坐标替代屏幕几何。
- 用显式边集合替代视觉连线。
- 用 BFS 判断节点是否连回出生点。
- 用泛洪法计算领土覆盖点集。
- 用快照回滚与哈希集合实现 Superko。
- Web 端保持“前端规则引擎 + 后端房间同步”的职责边界。

## 项目范围

核心算法样本位于：

```text
core algorithm/triangular_game.py
```

Web 主线位于：

```text
web/web前端/GameEngine.js
web/web前端/Renderer.js
web/web前端/GameController.js
web/web前端/NetworkManager.js
web/web后端/server.py
```

核心算法文档以 `9x9` 三角网格为基准说明。Web 端支持边长 `6` 到 `15` 的可配置棋盘，数据结构和算法策略一致。

## 棋盘坐标模型

三角棋盘使用离散坐标 `(x, y)`。边长为 `N` 时，第 `y` 行有 `N - y` 个合法点：

```python
0 <= y < N
0 <= x < N - y
x + y <= N - 1
```

初始化方式：

```python
def _init_grid(self):
    for y in range(self.GRID_SIZE):
        for x in range(self.GRID_SIZE - y):
            self.grid[(x, y)] = PointState.EMPTY
```

代码中的 `self.grid` 是棋盘物理层：

```python
self.grid: dict[tuple[int, int], PointState]
```

它保存所有坐标点当前的占用状态。每个 key 是合法三角坐标，每个 value 是 `PointState`。

屏幕坐标仅用于渲染：

```python
def _get_screen_pos(self, grid_x, grid_y):
    offset_x = grid_y * self.cell_size // 2
    screen_x = self.grid_start_x + grid_x * self.cell_size + offset_x
    screen_y = self.grid_start_y + grid_y * self.cell_size * 0.866
    return int(screen_x), int(screen_y)
```

规则计算不依赖像素坐标。点击检测会从屏幕点反查最近的格点，但合法性仍由 `self.grid` 和规则函数决定。

## 六向邻接

三角网格的每个格点最多有六个相邻点。实现中使用六向邻接表：

```python
possible_adjacent = [
    (x, y + 1),
    (x, y - 1),
    (x - 1, y),
    (x + 1, y),
    (x - 1, y + 1),
    (x + 1, y - 1),
]
```

只返回存在于 `self.grid` 的合法点：

```python
def _get_adjacent_positions(self, pos):
    x, y = pos
    adjacent = []

    for adj_pos in possible_adjacent:
        if adj_pos in self.grid:
            adjacent.append(adj_pos)

    return adjacent
```

邻接函数被以下模块复用：

- 泛洪法 `_get_covered_points`
- 最短路径搜索 `_get_all_shortest_grid_paths`
- 外轮廓追踪 `_get_outer_contour`
- 三点限制检查
- 断联区域清理

## 状态枚举

棋盘点状态由 `PointState` 定义：

```python
class PointState(Enum):
    EMPTY = 0
    BLACK_NODE = 1
    BLACK_LINE = 2
    WHITE_NODE = 3
    WHITE_LINE = 4
```

玩家枚举：

```python
class Player(Enum):
    BLACK = 1
    WHITE = 2
```

状态含义：

- `EMPTY`：未占用点。
- `BLACK_NODE` / `WHITE_NODE`：玩家主动落下的节点，作为拓扑图的顶点。
- `BLACK_LINE` / `WHITE_LINE`：节点之间自动生成的线点，作为渲染和阻挡检测中的物理占用。

节点与线点的区别：

- 节点参与显式边集合。
- 线点不作为图顶点。
- 线点可被攻击删除。
- 连通性只检查节点之间的显式边。

初始状态：

```python
self.grid[(0, 0)] = PointState.BLACK_NODE
self.grid[(8, 0)] = PointState.WHITE_NODE
```

## 双层数据结构

规则引擎拆分为两个层次。

### 网格物理层

```python
self.grid: dict[tuple[int, int], PointState]
```

职责：

- 保存点位占用状态。
- 支持 Canvas / Pygame 渲染。
- 支持落点合法性检查。
- 支持中间点阻挡判断。
- 支持攻击时线点删除。

### 逻辑拓扑层

```python
self.black_edges: set[frozenset[tuple[int, int]]]
self.white_edges: set[frozenset[tuple[int, int]]]
```

每条边使用 `frozenset({node_a, node_b})` 表示。`frozenset` 的作用是消除端点顺序差异，使 `(a, b)` 与 `(b, a)` 在集合中归一为同一条无向边。

职责：

- 保存节点之间的显式连接。
- 构建临时 adjacency list。
- 执行 BFS 连通性判断。
- 参与局面哈希序列化。
- 在攻击、删点、重连后同步更新。

设计约束：

- `grid` 可以显示线点连续。
- `edges` 才表示节点之间存在合法连接。
- 连通性不通过扫描同色 `grid` 点判断。

## 直线连接规则

两个节点可连接，当且仅当它们落在三角坐标系的三类直线上：

```python
def _can_connect(self, pos1, pos2):
    x1, y1 = pos1
    x2, y2 = pos2

    if x1 == x2:
        return True
    if y1 == y2:
        return True
    if x1 + y1 == x2 + y2:
        return True

    return False
```

三类方向：

- 同列：`x1 == x2`
- 同行：`y1 == y2`
- 同反对角线：`x1 + y1 == x2 + y2`

中间格点由 `_get_line_points` 提取：

```python
def _get_line_points(self, start, end):
    x1, y1 = start
    x2, y2 = end
    points = []

    if x1 == x2:
        for y in range(min(y1, y2), max(y1, y2) + 1):
            if (x1, y) in self.grid:
                points.append((x1, y))

    elif y1 == y2:
        for x in range(min(x1, x2), max(x1, x2) + 1):
            if (x, y1) in self.grid:
                points.append((x, y1))

    elif x1 + y1 == x2 + y2:
        # 沿 x 增、y 减的反对角方向生成离散格点
        ...

    return points
```

阻挡检测由 `_can_connect_with_blocking` 完成：

```python
def _can_connect_with_blocking(self, pos1, pos2, player):
    if not self._can_connect(pos1, pos2):
        return False

    line_points = self._get_line_points(pos1, pos2)
    middle_points = [p for p in line_points if p != pos1 and p != pos2]

    for point in middle_points:
        if self.grid[point] in opponent_states:
            return False

    return True
```

该函数处理的是“直线路径上是否存在敌方节点或敌方线点”。它不检查己方线点，因为己方线点可以作为已有连接的一部分。

## 落子入口

核心落子函数是 `_add_node`。它负责单步落子的完整事务流程。

主要阶段：

1. 坐标存在性检查。
2. 目标点状态检查。
3. 保护区检查。
4. 三点限制检查。
5. 快照保存。
6. 写入新节点。
7. 自动连线。
8. 攻击结算。
9. Superko 哈希检查。
10. 成功提交或回滚。

入口检查：

```python
if pos not in self.grid:
    return False

original_state = self.grid[pos]
if original_state not in [PointState.EMPTY, PointState.WHITE_LINE, PointState.BLACK_LINE]:
    return False
```

落点只能是空点或敌方线点。已有节点不可覆盖，己方节点不可重复落子。

保护区限制：

```python
if self._is_in_protection_zone(pos, self.current_player):
    return False
```

三点限制：

```python
opponent_line = PointState.WHITE_LINE if self.current_player == Player.BLACK else PointState.BLACK_LINE
is_attacking_move = original_state == opponent_line

if not is_attacking_move and not self._check_three_point_limitation(pos, self.current_player):
    return False
```

进攻落子可跳过三点限制。普通扩张必须通过阵型约束。

事务快照：

```python
grid_snapshot = dict(self.grid)
black_edges_snapshot = set(self.black_edges)
white_edges_snapshot = set(self.white_edges)
```

快照用于 Superko 违规时恢复。这里保存的是浅拷贝，因为 key/value 均为不可变坐标与枚举值，边集合元素为 `frozenset`。

## 自动连线

新节点写入后，引擎扫描所有己方已有节点：

```python
self.grid[pos] = node_state

existing_nodes = self._get_player_nodes(self.current_player)
existing_nodes.remove(pos)
```

对每个已有节点检查是否可以连接：

```python
connected = False

for node_pos in existing_nodes:
    if self._can_connect_with_blocking(pos, node_pos, self.current_player):
        connected = True
        line_points = self._get_line_points(pos, node_pos)

        for point in line_points:
            if self.grid[point] == PointState.EMPTY or self.grid[point] == line_state:
                self.grid[point] = line_state
            if point == pos or point == node_pos:
                self.grid[point] = node_state

        self._get_edges(self.current_player).add(frozenset({pos, node_pos}))
```

处理细节：

- 中间空点转为己方 `LINE`。
- 两端保持 `NODE`。
- 已有己方线点允许复用。
- 每条成功连接写入 `black_edges` 或 `white_edges`。
- 如果没有任何成功连接，本次落子失败并恢复原状态。

连接失败回滚：

```python
if not connected:
    self.grid[pos] = original_state
    return False
```

## 攻击触发

当新节点落在敌方线点上时，触发 `_handle_blocking_attack`：

```python
self._handle_blocking_attack(pos, self.current_player, original_state)
```

攻击触发条件：

```python
opponent = Player.WHITE if player == Player.BLACK else Player.BLACK
opp_line = PointState.WHITE_LINE if player == Player.BLACK else PointState.BLACK_LINE

if original_state != opp_line:
    return
```

函数内部按固定顺序执行：

1. 删除被切断的敌方线点。
2. 清理断裂拓扑边。
3. 删除不能连回出生点的敌方节点。
4. 清理无端点支撑的敌方线点。
5. 对攻守双方重新建立合法连接。

## 线点级联删除

攻击点向六个直线方向扫描：

```python
directions = [(1, 0), (-1, 0), (0, 1), (0, -1), (1, -1), (-1, 1)]
```

只处理相邻位置是敌方线点的方向：

```python
nx, ny = x0 + dx, y0 + dy
if (nx, ny) not in self.grid or self.grid[(nx, ny)] != opp_line:
    continue
```

连续收集敌方线点：

```python
cells_to_delete = []
while (nx, ny) in self.grid and self.grid[(nx, ny)] == opp_line:
    cells_to_delete.append((nx, ny))
    nx += dx
    ny += dy
```

只有扫描终点是敌方节点时，才删除已收集线点：

```python
if (nx, ny) in self.grid and self.grid[(nx, ny)] == opp_node_state:
    for cell in cells_to_delete:
        self.grid[cell] = PointState.EMPTY
```

该判断用于区分两类情况：

- 同一条被攻击线上的连续线点。
- 因交叉或邻接产生的其他方向线点。

如果扫描最终遇到空点或边界，本方向不删除，避免误删不属于当前连接段的线点。

## 拓扑边清理

线点删除后，物理层和拓扑层可能不一致。`_cleanup_broken_edges` 扫描玩家边集，删除已经不完整的边。

核心逻辑：

```python
def _cleanup_broken_edges(self, player):
    edges = self._get_edges(player)
    broken_edges = set()

    for edge in edges:
        n1, n2 = tuple(edge)
        points = self._get_line_points(n1, n2)

        if any(self.grid[p] not in owned_states(player) for p in points):
            broken_edges.add(edge)

    edges.difference_update(broken_edges)
```

实现目标：

- 边的两个端点必须仍为该玩家节点。
- 边路径上的中间点必须仍为该玩家线点或节点。
- 任意路径点被敌方占据或清空，则边失效。

该步骤是后续 BFS 判定的前置条件。

## 连通性 BFS

`_is_connected_to_initial` 判断指定节点是否仍能通过显式边集连回出生点。

实现步骤：

1. 根据玩家获取 `black_edges` 或 `white_edges`。
2. 将 `set[frozenset]` 转换为临时 adjacency list。
3. 从出生点启动 BFS。
4. 如果目标节点被访问到，则连通。

伪代码：

```python
def _is_connected_to_initial(self, pos, player):
    start = (0, 0) if player == Player.BLACK else (8, 0)
    adj = defaultdict(list)

    for edge in self._get_edges(player):
        a, b = tuple(edge)
        adj[a].append(b)
        adj[b].append(a)

    queue = deque([start])
    visited = {start}

    while queue:
        current = queue.popleft()
        if current == pos:
            return True

        for nxt in adj[current]:
            if nxt not in visited:
                visited.add(nxt)
                queue.append(nxt)

    return False
```

数据结构名词：

- `adjacency list`：邻接表。
- `visited set`：已访问集合。
- `queue`：BFS 队列。
- `connected component`：连通分量。
- `root node`：出生点。

该函数不扫描 `grid` 的同色点，避免把视觉连续误判为拓扑连通。

## 飞地节点删除

攻击可能使敌方图结构分裂。结算时遍历敌方所有节点：

```python
opp_start = (8, 0) if player == Player.BLACK else (0, 0)
deleted_nodes = set()

for node in self._get_player_nodes(opponent):
    if node != opp_start and not self._is_connected_to_initial(node, opponent):
        self.grid[node] = PointState.EMPTY
        deleted_nodes.add(node)
        self._remove_node_edges(node, opponent)
```

处理规则：

- 出生点不会被删除。
- 不能连回出生点的节点置为 `EMPTY`。
- 与该节点关联的所有显式边同步删除。

`_remove_node_edges` 的职责是维护边集一致性：

```python
def _remove_node_edges(node, player):
    edges(player).difference_update(
        edge for edge in edges(player) if node in edge
    )
```

## 孤立线点清理

节点删除后，敌方可能残留线点。线点只有在位于两端均幸存的完整连接上时才保留。

检查流程：

```python
for line_pt in list(self.grid.keys()):
    if self.grid[line_pt] != opp_line:
        continue

    protected = False

    for n1, n2 in all_surviving_node_pairs:
        if not self._can_connect(n1, n2):
            continue

        pts = self._get_line_points(n1, n2)
        if line_pt not in pts:
            continue

        if all(self.grid[p] in (opp_node_state, opp_line) for p in pts):
            protected = True
            break

    if not protected:
        self.grid[line_pt] = PointState.EMPTY
```

判定条件：

- 线点必须属于某对幸存节点之间的合法直线。
- 该直线上的所有格点仍归属敌方。
- 否则视为 orphan line point，置空。

该步骤清理攻击后的物理残留，防止渲染层显示已经没有拓扑意义的线点。

## 防线重连

攻击结算最后执行 `_reconnect_player_nodes`。它对指定玩家的所有节点对进行重新扫描：

```python
def _reconnect_player_nodes(self, player):
    player_nodes = self._get_player_nodes(player)

    for i in range(len(player_nodes)):
        for j in range(i + 1, len(player_nodes)):
            node1, node2 = player_nodes[i], player_nodes[j]

            if self._can_connect_with_blocking(node1, node2, player):
                line_points = self._get_line_points(node1, node2)

                for point in line_points:
                    if point == node1 or point == node2:
                        self.grid[point] = node_state
                    elif self.grid[point] == PointState.EMPTY:
                        self.grid[point] = line_state

                self._get_edges(player).add(frozenset({node1, node2}))
```

执行对象：

```python
self._reconnect_player_nodes(player)
self._reconnect_player_nodes(opponent)
```

重连原因：

- 攻击方新节点可能打开新的连接。
- 防守方删除部分节点后，剩余节点可能形成新的无遮挡连接。
- 清空线点可能释放原本被阻挡的直线路径。

复杂度特征：

- 节点对枚举为 `O(V^2)`。
- 每次连接检查需要扫描路径点。
- 棋盘规模较小，直接枚举可接受。

## 领土计算总流程

领土由 `_compute_inner_hull(player)` 计算。

输入：

- 当前玩家。
- 玩家节点集合。
- 玩家线点集合。
- 对手节点集合。
- 对手线点集合。

输出：

- `screen_polygon`：用于渲染的屏幕坐标多边形。
- `area`：泛洪法得到的离散领土点数。

主流程：

```python
def _compute_inner_hull(self, player):
    friendlies = set(self._get_player_nodes(player) + self._get_player_lines(player))
    enemies = set(self._get_player_nodes(opp) + self._get_player_lines(opp))
    friendly_nodes = set(self._get_player_nodes(player))

    current_poly = self._get_outer_contour(player)

    while True:
        # 枚举锚点对，生成候选轮廓，泛洪校验
        ...

    final_covered = self._get_covered_points(current_poly)
    screen_polygon = [self._get_screen_pos(*p) for p in final_closed]
    area = len(final_covered)
    return screen_polygon, area
```

实现特征：

- 外轮廓是离散点序列，不是连续几何曲线。
- 周长使用轮廓点数近似，即格点路径长度。
- 面积使用覆盖点数量，不使用 Shoelace 公式。
- 候选轮廓必须通过敌方避障和己方节点包含检查。

## 外轮廓追踪

`_get_outer_contour(player)` 使用右手摸墙法。

关键变量：

- `friendlies`：己方节点与线点集合。
- `start`：字典序最小的己方点。
- `backtrack`：进入当前点的反方向编号。
- `first_out_dir`：首步离开方向，用于闭合判定。
- `contour`：输出轮廓点列表。
- `max_steps`：防止异常循环的安全上限。

实现骨架：

```python
DIRS = self._DIRS_CW
friendlies = set(self._get_player_nodes(player) + self._get_player_lines(player))
start = min(friendlies, key=lambda p: (p[0], p[1]))

backtrack = 3
current = start
first_out_dir = None
max_steps = len(friendlies) * 6 + 10
```

顺时针扫描下一个己方点：

```python
for i in range(6):
    d = (backtrack + 1 + i) % 6
    dx, dy = DIRS[d]
    nxt = (current[0] + dx, current[1] + dy)

    if nxt in friendlies:
        out_dir = d
        break
```

闭合条件：

```python
if first_out_dir is None:
    first_out_dir = out_dir
    contour.append(current)
elif current == start and out_dir == first_out_dir:
    break
else:
    contour.append(current)
```

该算法返回的是首尾不重复的隐式闭合环。渲染前由 `get_closed` 补上首点。

## 最短路径候选

`_get_all_shortest_grid_paths(start, end, enemies, max_paths)` 用 BFS 获取避开敌方点的等长最短路径。

数据结构：

- `queue`：路径队列，元素是完整路径列表。
- `shortest_paths`：候选最短路径集合。
- `min_length`：当前已发现最短长度。
- `visited_at_depth`：记录某点出现过的最浅层数。

实现骨架：

```python
queue = [[start]]
shortest_paths = []
min_length = float("inf")
visited_at_depth = {start: 0}
```

搜索规则：

```python
while queue:
    path = queue.pop(0)
    current = path[-1]

    if len(path) > min_length:
        continue
    if len(shortest_paths) >= max_paths:
        break

    if current == end:
        shortest_paths.append(path)
        min_length = len(path)
        continue

    for nxt in self._get_adjacent_positions(current):
        if nxt in enemies:
            continue
        depth = len(path)
        if nxt not in visited_at_depth or visited_at_depth[nxt] >= depth:
            visited_at_depth[nxt] = depth
            queue.append(path + [nxt])
```

该函数用于轮廓修剪，不用于玩家落子。它生成的是可能替换原轮廓弧段的格点路径。

## 动态贪心修剪

外轮廓可能包含冗余线点。修剪阶段枚举轮廓上的两个锚点 `i` 和 `j`，用最短路径替换原来的部分轮廓。

当前轮廓基准：

```python
cur_perim = len(current_poly)
cur_area = len(self._get_covered_points(current_poly))

best_overall_cand = None
best_cand_perim = cur_perim
best_cand_area = cur_area
```

锚点枚举：

```python
for i in range(n):
    for j in range(n - 1, i + 1, -1):
        if j - i <= 1:
            continue
```

候选生成：

```python
paths = self._get_all_shortest_grid_paths(
    current_poly[i],
    current_poly[j],
    enemies,
    max_paths=100,
)

for path in paths:
    cand_A = current_poly[:i] + path + current_poly[j + 1:]
    cand_B = current_poly[i:j + 1] + path[::-1][1:-1]
```

候选过滤：

```python
cand = [p for k, p in enumerate(cand) if k == 0 or p != cand[k - 1]]

if len(cand) < 3:
    continue

if cand_perim > best_cand_perim:
    continue

covered = self._get_covered_points(cand)
cand_area = len(covered)

if cand_perim == best_cand_perim and cand_area >= best_cand_area:
    continue

if not friendly_nodes.issubset(covered):
    continue

if any(e in covered for e in enemies):
    continue
```

排序目标：

1. 优先减少轮廓周长。
2. 周长相同时减少覆盖点数。
3. 保证所有己方节点仍在覆盖区域内。
4. 保证覆盖区域不包含任何敌方点。

循环收敛条件：

```python
if best_overall_cand is not None:
    current_poly = best_overall_cand
else:
    break
```

这是局部搜索加贪心更新，不是全局最优多边形求解。它适合当前小规模棋盘与交互式计算。

## 泛洪覆盖点

`_get_covered_points(polygon)` 用泛洪法计算多边形覆盖的离散点集。

输入：

- `polygon`: 轮廓点列表。

输出：

- `set[tuple[int, int]]`: 被轮廓包围的所有格点，包含轮廓点本身。

实现步骤：

1. 将轮廓点转换为 `wall_set`。
2. 从棋盘三条边界的非墙点入队。
3. BFS 扩展所有外部可达点。
4. 用全集减去外部可达点，得到覆盖点集。

代码骨架：

```python
wall_set = set(polygon)
water_reached = set()
queue = deque()

for y in range(9):
    for x in range(9 - y):
        if x == 0 or y == 0 or x + y == 8:
            if (x, y) not in wall_set:
                water_reached.add((x, y))
                queue.append((x, y))

while queue:
    curr = queue.popleft()
    for nxt in self._get_adjacent_positions(curr):
        if nxt not in wall_set and nxt not in water_reached:
            water_reached.add(nxt)
            queue.append(nxt)

all_points = {(x, y) for y in range(9) for x in range(9 - y)}
return all_points - water_reached
```

算法属性：

- 属于 Flood Fill / Region Filling。
- 使用 BFS 队列。
- 不依赖射线法。
- 不依赖连续几何面积。
- 自交轮廓下仍按格点可达性判定。

## Superko 局面哈希

Superko 用于禁止全局同形再现。实现由两部分组成：

- `history_hashes: set[str]`
- `_compute_state_hash(next_player)`

初始化时写入初始局面：

```python
self.history_hashes = set()
self.history_hashes.add(self._compute_state_hash(Player.BLACK))
```

序列化内容：

```python
grid_entries = sorted(
    (x, y, state.value)
    for (x, y), state in self.grid.items()
    if state != PointState.EMPTY
)

black_edge_list = sorted(tuple(sorted(e)) for e in self.black_edges)
white_edge_list = sorted(tuple(sorted(e)) for e in self.white_edges)

raw = repr((next_player.value, grid_entries, black_edge_list, white_edge_list))
return hashlib.sha256(raw.encode()).hexdigest()
```

字段说明：

- `next_player.value`：结算后即将行棋方。
- `grid_entries`：所有非空格点与状态值。
- `black_edge_list`：规范化后的黑方边集合。
- `white_edge_list`：规范化后的白方边集合。
- `SHA-256`：固定长度摘要，用于集合查询。

落子后检查：

```python
next_player = Player.WHITE if self.current_player == Player.BLACK else Player.BLACK
state_hash = self._compute_state_hash(next_player)

if state_hash in self.history_hashes:
    self.grid = grid_snapshot
    self.black_edges = black_edges_snapshot
    self.white_edges = white_edges_snapshot
    raise SuperkoViolationError(...)

self.history_hashes.add(state_hash)
```

注意点：

- 哈希检查发生在攻击和重连完成之后。
- 违规时恢复 `grid` 与两方边集。
- `_is_legal_move` 会额外快照 `history_hashes` 与 `current_player`，用于合法性试算。

## 回合与终局

玩家切换：

```python
def _switch_player(self):
    self.current_player = Player.WHITE if self.current_player == Player.BLACK else Player.BLACK
```

合法性试算：

```python
def _is_legal_move(self, pos, player):
    grid_snapshot = dict(self.grid)
    black_edges_snapshot = set(self.black_edges)
    white_edges_snapshot = set(self.white_edges)
    history_hashes_snapshot = set(self.history_hashes)
    current_player_snapshot = self.current_player

    try:
        self.current_player = player
        return self._add_node(pos)
    except SuperkoViolationError:
        return False
    finally:
        self.grid = grid_snapshot
        self.black_edges = black_edges_snapshot
        self.white_edges = white_edges_snapshot
        self.history_hashes = history_hashes_snapshot
        self.current_player = current_player_snapshot
```

该函数用于判断玩家是否存在合法行动。它通过事务回滚保证试算不污染真实局面。

自动跳过：

```python
def _has_valid_moves(self, player):
    for pos in self.grid:
        if self._is_legal_move(pos, player):
            return True
    return False
```

终局条件：

- 当前玩家无合法落子时自动跳过。
- 双方连续跳过时结束。
- 玩家主动跳过也计入 `consecutive_skips`。

```python
if self.consecutive_skips >= 2:
    self.game_over = True
```

胜负由双方领土点数比较决定。

## 渲染与缓存

Pygame 样本中渲染分为：

- 背景清空。
- 领土半透明覆盖层。
- 节点对连线绘制。
- 格点绘制。
- 当前玩家文字。
- 跳过按钮。
- 终局覆盖层。

领土缓存：

```python
self._hull_black: tuple[Optional[list], float] = (None, 0.0)
self._hull_white: tuple[Optional[list], float] = (None, 0.0)
```

状态改变后更新：

```python
def _update_hulls(self):
    self._hull_black = self._compute_inner_hull(Player.BLACK)
    self._hull_white = self._compute_inner_hull(Player.WHITE)
```

设计目的：

- 避免每帧重复执行轮廓追踪、最短路径枚举和泛洪。
- 渲染帧只读取缓存结果。
- 规则计算与绘制逻辑分离。

连线绘制时不直接画相邻线点，而是枚举节点对并验证整段归属：

```python
for i in range(len(p_nodes)):
    for j in range(i + 1, len(p_nodes)):
        n1, n2 = p_nodes[i], p_nodes[j]
        if not self._can_connect(n1, n2):
            continue

        pts = self._get_line_points(n1, n2)
        if not all(self.grid[p] in owned for p in pts):
            continue

        if any(self.grid[p] == node_st for p in pts if p != n1 and p != n2):
            continue

        pygame.draw.line(...)
```

该策略避免在拐角处把相邻点误画成额外连接。

## Web 前端架构

当前真实入口：

```text
index.html -> main.js -> OnlineApp.js
```

核心模块：

```text
web/web前端/main.js
web/web前端/OnlineApp.js
web/web前端/OnlineAppState.js
web/web前端/OnlineAppI18n.js
web/web前端/GameController.js
web/web前端/GameEngine.js
web/web前端/Renderer.js
web/web前端/NetworkManager.js
web/web前端/styles.css
```

职责说明：

- `main.js`：加载 Vue 运行时，挂载应用，处理启动失败状态。
- `OnlineApp.js`：主应用编排层，管理本地模式、联机模式、房间流程和页面布局。
- `OnlineAppState.js`：默认配置、会话存储 Key、认证信息、本地持久化状态。
- `OnlineAppI18n.js`：中英文文案、标题、比分、状态和错误提示格式化。
- `GameController.js`：交互控制层，连接规则引擎、渲染器与网络层。
- `GameEngine.js`：规则计算层，维护棋盘、落子、回合、领地、比分和终局状态。
- `Renderer.js`：Canvas 绘制层，负责棋盘、节点、连线、领地、高亮和尺寸适配。
- `NetworkManager.js`：WebSocket 客户端封装，负责请求发送、事件订阅、心跳和错误处理。
- `styles.css`：页面布局、响应式策略、折叠信息仓和移动端适配。

架构约束：

- 当前规则真源在前端 `GameEngine.js`。
- 后端不裁决三角棋盘规则。
- 渲染性能问题优先在 `Renderer.js` 处理。
- 文案新增优先进入 `OnlineAppI18n.js`。

## Web 后端架构

当前后端主服务：

```text
web/web后端/server.py
```

后端职责：

- FastAPI 应用入口。
- 静态资源托管。
- 用户注册与登录。
- `bcrypt + sha256` 密码哈希。
- JWT 签发与校验。
- WebSocket 鉴权连接。
- 房间创建、加入、离开。
- 玩家身份、颜色、房主与准备状态管理。
- 开局倒计时。
- 联机重置投票。
- 房间动作记录。
- 心跳检测。
- 断线恢复。
- 房间超时清理。

后端不负责：

- 落子合法性裁决。
- 领土计算。
- 终局胜负裁决。
- 替代前端规则引擎。

仓库中存在：

```text
web/web后端/game_router.py
```

该文件属于实验性或历史性后端规则方向，不是当前 Web 主线。

## WebSocket 数据流

联机模式采用“服务端同步动作，客户端回放规则”的模式。

落子数据流：

```text
用户点击棋盘
-> GameController 接收交互
-> GameEngine 执行本地规则
-> Renderer 刷新本地画面
-> NetworkManager 发送 player_move
-> server.py 广播到房间其他成员
-> 其他客户端用本地 GameEngine 回放动作
```

主要客户端消息：

```text
create_room
join_room
player_move
player_skip
player_reset
player_ready
update_room_settings
update_start_player
player_leave
ping
```

主要服务端事件：

```text
ROOM_CREATED
ROOM_JOINED
ROOM_STATE
ROOM_COUNTDOWN
ROOM_READY
OPPONENT_MOVE
TURN_SKIPPED
RESET_STATUS
MATCH_RESET
PLAYER_LEFT
PONG
ERROR
```

房间关键常量：

- 房间号长度：`4`
- 房间超时清理：`300` 秒
- 心跳超时：`35` 秒
- 心跳巡检周期：`5` 秒
- 开始倒计时：`3` 秒
- 棋盘边长范围：`6` 到 `15`
- 支持人数：`2` 或 `3`

## UI 需求约束

当前 UI 以棋盘为主要操作对象。

主要约束：

- 首屏显示标题与中央棋盘。
- 棋盘在桌面端和移动端必须完整可见。
- 页面滚动方向以竖向为主。
- 棋盘区域不放说明性长文本。
- 棋盘下方保留当前回合与本地操作。
- 棋盘仓默认折叠，摘要显示人数和边长。
- 联机仓默认折叠，摘要显示本地状态或房间号。
- 中文标题为 `生命线`。
- 英文标题为 `LIFELINE`。
- 新增文案集中维护在 `OnlineAppI18n.js`。

## 修改入口

常见修改路径：

- 规则与落子：`GameEngine.js`，参考 `core algorithm/triangular_game.py`
- 领土、删点、连通性：优先对照核心算法文档与样本实现
- 渲染性能：`Renderer.js`
- 页面结构：`OnlineApp.js`
- 默认配置与本地会话：`OnlineAppState.js`
- 文案和语言：`OnlineAppI18n.js`
- 联机协议：`NetworkManager.js` 与 `server.py`
- 后端房间逻辑：`server.py`

建议验证项：

- 双人本地局可正常开始、落子、跳过、终局。
- 三人局颜色、回合和领地统计正常。
- 边长 `6`、`10`、`15` 显示完整。
- 攻击线点后，断边、飞地删除、孤线清理与重连一致。
- Superko 违规时局面回滚。
- 联机建房、入房、准备、开始、落子同步正常。
- 房主修改设置后准备状态重置。
- 联机重置采用全员确认。
- 断线后可恢复房间上下文。

## GitHub

仓库地址：

```text
https://github.com/Chengzong-Zhang/Line-Game
```
