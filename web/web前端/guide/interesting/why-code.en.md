## Talk is Cheap, Show Me the Code

## Engineering Scale

GitHub repository:

```text
https://github.com/Chengzong-Zhang/Line-Game
```

Current project statistics, excluding `.git` and `__pycache__`, measured from the current working tree:

| Metric | Value |
|---|---:|
| Total files | 47 |
| Text source files | 32 |
| Code files | 20 |
| Total code lines | 11,548 |
| Documentation and text lines | 13,228 |
| Project size | About 7.6 MB |

Notes:

- Code files include `.py`, `.js`, `.html`, `.css`, `.ps1`, and `.bat`.
- Text source files include code files, Markdown documents, scripts, and text configuration.
- Images, compressed samples, Git metadata, and Python caches are not counted.

This document explains the core rule engine, topological model, territory calculation, forbidden-move system, and Web architecture boundary of LIFELINE / TriAxis.

The game runs on a triangular lattice. The player sees nodes, lines, and territory; the code handles discrete coordinates, state enums, explicit edge sets, BFS connectivity, flood-fill coverage sets, historical position hashes, and a turn state machine.

Core implementation goals:

- Use discrete coordinates instead of screen geometry.
- Use explicit edge sets instead of visual lines.
- Use BFS to decide whether a node still connects back to its starting point.
- Use flood fill to calculate covered territory points.
- Use snapshot rollback and hash sets to implement Superko.
- Keep the Web responsibility boundary as "front-end rule engine + back-end room synchronization".

## Project Scope

The core algorithm sample is located at:

```text
core algorithm/triangular_game.py
```

The current Web path is:

```text
web/web前端/GameEngine.js
web/web前端/Renderer.js
web/web前端/GameController.js
web/web前端/NetworkManager.js
web/web后端/server.py
```

The core algorithm notes use a `9x9` triangular grid as the reference board. The Web client supports configurable board side lengths from `6` to `15`; the data structures and algorithmic strategy are the same.

## Board Coordinate Model

The triangular board uses discrete coordinates `(x, y)`. When the side length is `N`, row `y` has `N - y` legal points:

```python
0 <= y < N
0 <= x < N - y
x + y <= N - 1
```

Initialization:

```python
def _init_grid(self):
    for y in range(self.GRID_SIZE):
        for x in range(self.GRID_SIZE - y):
            self.grid[(x, y)] = PointState.EMPTY
```

In the code, `self.grid` is the physical board layer:

```python
self.grid: dict[tuple[int, int], PointState]
```

It stores the current occupancy state of every coordinate point. Each key is a legal triangular coordinate, and each value is a `PointState`.

Screen coordinates are only for rendering:

```python
def _get_screen_pos(self, grid_x, grid_y):
    offset_x = grid_y * self.cell_size // 2
    screen_x = self.grid_start_x + grid_x * self.cell_size + offset_x
    screen_y = self.grid_start_y + grid_y * self.cell_size * 0.866
    return int(screen_x), int(screen_y)
```

Rule calculation does not depend on pixel coordinates. Click detection maps a screen point back to the nearest lattice point, but legality is still decided by `self.grid` and the rule functions.

## Six-Direction Adjacency

Each lattice point in the triangular grid has at most six adjacent points. The implementation uses a six-direction adjacency list:

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

Only legal points that exist in `self.grid` are returned:

```python
def _get_adjacent_positions(self, pos):
    x, y = pos
    adjacent = []

    for adj_pos in possible_adjacent:
        if adj_pos in self.grid:
            adjacent.append(adj_pos)

    return adjacent
```

The adjacency helper is reused by:

- flood fill in `_get_covered_points`
- shortest-path search in `_get_all_shortest_grid_paths`
- outer-contour tracing in `_get_outer_contour`
- the three-point restriction check
- disconnected-region cleanup

## State Enums

Board point states are defined by `PointState`:

```python
class PointState(Enum):
    EMPTY = 0
    BLACK_NODE = 1
    BLACK_LINE = 2
    WHITE_NODE = 3
    WHITE_LINE = 4
```

Players are represented by:

```python
class Player(Enum):
    BLACK = 1
    WHITE = 2
```

State meanings:

- `EMPTY`: an unoccupied point.
- `BLACK_NODE` / `WHITE_NODE`: a node actively placed by a player, used as a vertex in the topological graph.
- `BLACK_LINE` / `WHITE_LINE`: an automatically generated line point between nodes, used for rendering and blocking detection.

The distinction between nodes and line points matters:

- Nodes participate in the explicit edge set.
- Line points are not graph vertices.
- Line points can be attacked and deleted.
- Connectivity is checked only through explicit edges between nodes.

Initial state:

```python
self.grid[(0, 0)] = PointState.BLACK_NODE
self.grid[(8, 0)] = PointState.WHITE_NODE
```

## Two-Layer Data Structure

The rule engine is split into two layers.

### Grid Physical Layer

```python
self.grid: dict[tuple[int, int], PointState]
```

Responsibilities:

- Store point occupancy.
- Support Canvas / Pygame rendering.
- Support move legality checks.
- Support midpoint blocking checks.
- Support line-point deletion during attacks.

### Logical Topology Layer

```python
self.black_edges: set[frozenset[tuple[int, int]]]
self.white_edges: set[frozenset[tuple[int, int]]]
```

Each edge is represented as `frozenset({node_a, node_b})`. `frozenset` removes endpoint order, so `(a, b)` and `(b, a)` normalize to the same undirected edge.

Responsibilities:

- Store explicit connections between nodes.
- Build temporary adjacency lists.
- Run BFS connectivity checks.
- Participate in position-hash serialization.
- Stay synchronized after attacks, node deletion, and reconnection.

Design constraints:

- `grid` may display continuous line points.
- `edges` is the actual source of legal node connectivity.
- Connectivity is not inferred by scanning same-color `grid` points.

## Straight-Line Connection Rules

Two nodes can connect if and only if they lie on one of the three line families of the triangular coordinate system:

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

The three directions are:

- same column: `x1 == x2`
- same row: `y1 == y2`
- same anti-diagonal: `x1 + y1 == x2 + y2`

Intermediate lattice points are extracted by `_get_line_points`:

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
        # Generate discrete lattice points along the anti-diagonal direction.
        ...

    return points
```

Blocking detection is handled by `_can_connect_with_blocking`:

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

This function asks whether an enemy node or enemy line point lies on the straight path. It does not reject friendly line points, because friendly line points may already be part of an existing connection.

## Move Entry Point

The core move function is `_add_node`. It owns the full single-move transaction.

Main stages:

1. Coordinate existence check.
2. Target point state check.
3. Protection-zone check.
4. Three-point restriction check.
5. Snapshot save.
6. New node write.
7. Automatic connection.
8. Attack resolution.
9. Superko hash check.
10. Commit or rollback.

Entry checks:

```python
if pos not in self.grid:
    return False

original_state = self.grid[pos]
if original_state not in [PointState.EMPTY, PointState.WHITE_LINE, PointState.BLACK_LINE]:
    return False
```

A move may be placed only on an empty point or on an enemy line point. Existing nodes cannot be overwritten, and friendly nodes cannot be replayed.

Protection-zone restriction:

```python
if self._is_in_protection_zone(pos, self.current_player):
    return False
```

Three-point restriction:

```python
opponent_line = PointState.WHITE_LINE if self.current_player == Player.BLACK else PointState.BLACK_LINE
is_attacking_move = original_state == opponent_line

if not is_attacking_move and not self._check_three_point_limitation(pos, self.current_player):
    return False
```

An attacking move may bypass the three-point restriction. Ordinary expansion must pass the formation constraint.

Transaction snapshot:

```python
grid_snapshot = dict(self.grid)
black_edges_snapshot = set(self.black_edges)
white_edges_snapshot = set(self.white_edges)
```

The snapshot is used to restore the position if the move violates Superko. A shallow copy is enough here because keys and values are immutable coordinates and enum values, and edge-set elements are `frozenset` objects.

## Automatic Connection

After the new node is written, the engine scans all existing friendly nodes:

```python
self.grid[pos] = node_state

existing_nodes = self._get_player_nodes(self.current_player)
existing_nodes.remove(pos)
```

For each existing node, it checks whether a connection is possible:

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

Details:

- Intermediate empty points become friendly `LINE` points.
- Both endpoints remain `NODE` points.
- Existing friendly line points may be reused.
- Each successful connection is written into `black_edges` or `white_edges`.
- If no connection succeeds, the move fails and restores the original state.

Connection-failure rollback:

```python
if not connected:
    self.grid[pos] = original_state
    return False
```

## Attack Trigger

When the new node is placed on an enemy line point, `_handle_blocking_attack` is triggered:

```python
self._handle_blocking_attack(pos, self.current_player, original_state)
```

Attack condition:

```python
opponent = Player.WHITE if player == Player.BLACK else Player.BLACK
opp_line = PointState.WHITE_LINE if player == Player.BLACK else PointState.BLACK_LINE

if original_state != opp_line:
    return
```

The function executes in a fixed order:

1. Delete the enemy line points that were cut.
2. Clean broken topological edges.
3. Delete enemy nodes that no longer connect back to their starting point.
4. Clean enemy line points with no surviving endpoint support.
5. Rebuild legal connections for both attacker and defender.

## Cascading Line-Point Deletion

The attack point scans in six straight directions:

```python
directions = [(1, 0), (-1, 0), (0, 1), (0, -1), (1, -1), (-1, 1)]
```

Only directions whose adjacent point is an enemy line point are processed:

```python
nx, ny = x0 + dx, y0 + dy
if (nx, ny) not in self.grid or self.grid[(nx, ny)] != opp_line:
    continue
```

Enemy line points are collected continuously:

```python
cells_to_delete = []
while (nx, ny) in self.grid and self.grid[(nx, ny)] == opp_line:
    cells_to_delete.append((nx, ny))
    nx += dx
    ny += dy
```

The collected line points are deleted only if the scan ends at an enemy node:

```python
if (nx, ny) in self.grid and self.grid[(nx, ny)] == opp_node_state:
    for cell in cells_to_delete:
        self.grid[cell] = PointState.EMPTY
```

This distinguishes two cases:

- continuous line points on the attacked connection
- other line points created by crossings or adjacency in different directions

If the scan ends at an empty point or the board boundary, that direction is left untouched, avoiding accidental deletion of line points that do not belong to the current connection segment.

## Topological Edge Cleanup

After line points are deleted, the physical layer and topological layer may disagree. `_cleanup_broken_edges` scans a player's edge set and removes edges whose physical paths are no longer intact.

Core logic:

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

Implementation goals:

- Both endpoints of an edge must still be nodes owned by that player.
- Intermediate points on the edge path must still be that player's line points or nodes.
- If any path point is occupied by the enemy or cleared, the edge is invalid.

This step is a precondition for the later BFS connectivity check.

## Connectivity BFS

`_is_connected_to_initial` decides whether a node can still reach its starting point through the explicit edge set.

Implementation steps:

1. Get `black_edges` or `white_edges` for the player.
2. Convert `set[frozenset]` into a temporary adjacency list.
3. Start BFS from the player's starting point.
4. If the target node is visited, it is connected.

Pseudocode:

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

Data-structure terms:

- `adjacency list`: adjacency list
- `visited set`: visited set
- `queue`: BFS queue
- `connected component`: connected component
- `root node`: starting point

The function does not scan same-color points in `grid`, preventing visual continuity from being mistaken for topological connectivity.

## Enclave Node Deletion

An attack may split the enemy graph. During resolution, the engine traverses every enemy node:

```python
opp_start = (8, 0) if player == Player.BLACK else (0, 0)
deleted_nodes = set()

for node in self._get_player_nodes(opponent):
    if node != opp_start and not self._is_connected_to_initial(node, opponent):
        self.grid[node] = PointState.EMPTY
        deleted_nodes.add(node)
        self._remove_node_edges(node, opponent)
```

Rules:

- The starting point is never deleted.
- A node that cannot connect back to its starting point becomes `EMPTY`.
- Every explicit edge incident to that node is removed at the same time.

`_remove_node_edges` preserves edge-set consistency:

```python
def _remove_node_edges(node, player):
    edges(player).difference_update(
        edge for edge in edges(player) if node in edge
    )
```

## Orphan Line-Point Cleanup

After node deletion, enemy line points may remain. A line point is retained only if it lies on a complete connection whose two endpoints both survived.

Check flow:

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

Conditions:

- The line point must lie on a legal straight line between a pair of surviving nodes.
- Every point on that line must still belong to the enemy.
- Otherwise it is an orphan line point and is cleared.

This step removes physical leftovers after an attack, preventing the renderer from displaying line points that no longer have topological meaning.

## Defensive Reconnection

Attack resolution ends with `_reconnect_player_nodes`. It rescans every pair of nodes for a specified player:

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

It is run for both sides:

```python
self._reconnect_player_nodes(player)
self._reconnect_player_nodes(opponent)
```

Reasons for reconnection:

- The attacker's new node may open new connections.
- After defender nodes are deleted, remaining nodes may form new unobstructed connections.
- Cleared line points may free straight paths that used to be blocked.

Complexity characteristics:

- Node-pair enumeration is `O(V^2)`.
- Each connection check scans path points.
- The board is small enough that direct enumeration is acceptable.

## Territory Calculation Flow

Territory is calculated by `_compute_inner_hull(player)`.

Inputs:

- current player
- player's node set
- player's line-point set
- opponent node set
- opponent line-point set

Outputs:

- `screen_polygon`: screen-coordinate polygon for rendering
- `area`: discrete territory point count from flood fill

Main flow:

```python
def _compute_inner_hull(self, player):
    friendlies = set(self._get_player_nodes(player) + self._get_player_lines(player))
    enemies = set(self._get_player_nodes(opp) + self._get_player_lines(opp))
    friendly_nodes = set(self._get_player_nodes(player))

    current_poly = self._get_outer_contour(player)

    while True:
        # Enumerate anchor pairs, build candidate contours, and validate by flood fill.
        ...

    final_covered = self._get_covered_points(current_poly)
    screen_polygon = [self._get_screen_pos(*p) for p in final_closed]
    area = len(final_covered)
    return screen_polygon, area
```

Implementation features:

- The outer contour is a sequence of discrete points, not a continuous geometric curve.
- Perimeter is approximated by contour point count, namely grid-path length.
- Area is the number of covered points, not the Shoelace formula.
- Candidate contours must pass enemy-avoidance and friendly-node containment checks.

## Outer Contour Tracing

`_get_outer_contour(player)` uses a right-hand wall-following method.

Key variables:

- `friendlies`: friendly nodes plus friendly line points
- `start`: lexicographically smallest friendly point
- `backtrack`: reverse direction index for entering the current point
- `first_out_dir`: first outgoing direction, used to detect closure
- `contour`: output contour-point list
- `max_steps`: safety cap against abnormal loops

Implementation skeleton:

```python
DIRS = self._DIRS_CW
friendlies = set(self._get_player_nodes(player) + self._get_player_lines(player))
start = min(friendlies, key=lambda p: (p[0], p[1]))

backtrack = 3
current = start
first_out_dir = None
max_steps = len(friendlies) * 6 + 10
```

Clockwise scan for the next friendly point:

```python
for i in range(6):
    d = (backtrack + 1 + i) % 6
    dx, dy = DIRS[d]
    nxt = (current[0] + dx, current[1] + dy)

    if nxt in friendlies:
        out_dir = d
        break
```

Closure condition:

```python
if first_out_dir is None:
    first_out_dir = out_dir
    contour.append(current)
elif current == start and out_dir == first_out_dir:
    break
else:
    contour.append(current)
```

The algorithm returns an implicitly closed ring without repeating the first point at the end. Rendering adds the first point back through `get_closed`.

## Shortest-Path Candidates

`_get_all_shortest_grid_paths(start, end, enemies, max_paths)` uses BFS to find equal-length shortest paths that avoid enemy points.

Data structures:

- `queue`: path queue; each item is a full path list
- `shortest_paths`: candidate shortest paths
- `min_length`: shortest length discovered so far
- `visited_at_depth`: shallowest depth at which each point has appeared

Implementation skeleton:

```python
queue = [[start]]
shortest_paths = []
min_length = float("inf")
visited_at_depth = {start: 0}
```

Search rules:

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

This function is used for contour trimming, not for player moves. It produces candidate grid paths that may replace an existing contour arc.

## Dynamic Greedy Trimming

The outer contour may contain redundant line points. The trimming phase enumerates two anchor points `i` and `j` on the contour and replaces part of the contour with a shortest path.

Current-contour baseline:

```python
cur_perim = len(current_poly)
cur_area = len(self._get_covered_points(current_poly))

best_overall_cand = None
best_cand_perim = cur_perim
best_cand_area = cur_area
```

Anchor enumeration:

```python
for i in range(n):
    for j in range(n - 1, i + 1, -1):
        if j - i <= 1:
            continue
```

Candidate generation:

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

Candidate filters:

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

Optimization goals:

1. Prefer shorter perimeter.
2. If perimeter ties, prefer smaller covered area.
3. Ensure all friendly nodes remain inside the covered region.
4. Ensure the covered region contains no enemy point.

Convergence condition:

```python
if best_overall_cand is not None:
    current_poly = best_overall_cand
else:
    break
```

This is local search with greedy updates, not a global optimum polygon solver. It fits the current small board sizes and interactive calculation needs.

## Flood-Fill Covered Points

`_get_covered_points(polygon)` computes the discrete point set covered by a polygon with flood fill.

Input:

- `polygon`: contour point list

Output:

- `set[tuple[int, int]]`: every lattice point enclosed by the contour, including the contour points themselves

Implementation steps:

1. Convert contour points into `wall_set`.
2. Enqueue non-wall points on the three board boundaries.
3. Use BFS to expand all externally reachable points.
4. Subtract the externally reachable set from the full lattice set to get the covered set.

Code skeleton:

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

Algorithm properties:

- It is a Flood Fill / Region Filling method.
- It uses a BFS queue.
- It does not rely on ray casting.
- It does not rely on continuous geometric area.
- Even under a self-intersecting contour, the result is decided by lattice reachability.

## Superko Position Hash

Superko prevents global shape repetition. The implementation has two parts:

- `history_hashes: set[str]`
- `_compute_state_hash(next_player)`

The initial position is inserted during initialization:

```python
self.history_hashes = set()
self.history_hashes.add(self._compute_state_hash(Player.BLACK))
```

Serialized content:

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

Field meanings:

- `next_player.value`: the player to move after resolution.
- `grid_entries`: all non-empty lattice points and their state values.
- `black_edge_list`: normalized black edge set.
- `white_edge_list`: normalized white edge set.
- `SHA-256`: fixed-length digest for set lookup.

Post-move check:

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

Important details:

- Hash checking happens after attack resolution and reconnection.
- On violation, `grid` and both edge sets are restored.
- `_is_legal_move` additionally snapshots `history_hashes` and `current_player`, so legality probes cannot pollute the real game state.

## Turns and Endgame

Player switching:

```python
def _switch_player(self):
    self.current_player = Player.WHITE if self.current_player == Player.BLACK else Player.BLACK
```

Legality probing:

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

This function decides whether a player has any legal action. Transaction rollback ensures the probe does not modify the real position.

Automatic skip:

```python
def _has_valid_moves(self, player):
    for pos in self.grid:
        if self._is_legal_move(pos, player):
            return True
    return False
```

End conditions:

- If the current player has no legal move, that player is skipped automatically.
- If both players skip consecutively, the game ends.
- A player-initiated skip also increments `consecutive_skips`.

```python
if self.consecutive_skips >= 2:
    self.game_over = True
```

The winner is decided by comparing both players' territory point counts.

## Rendering and Caching

The Pygame sample renders in this order:

- clear background
- semi-transparent territory overlays
- node-to-node line drawing
- lattice point drawing
- current player text
- skip button
- game-over overlay

Territory cache:

```python
self._hull_black: tuple[Optional[list], float] = (None, 0.0)
self._hull_white: tuple[Optional[list], float] = (None, 0.0)
```

Update after state changes:

```python
def _update_hulls(self):
    self._hull_black = self._compute_inner_hull(Player.BLACK)
    self._hull_white = self._compute_inner_hull(Player.WHITE)
```

Design purpose:

- Avoid repeating contour tracing, shortest-path enumeration, and flood fill on every frame.
- Let render frames read only cached results.
- Keep rule calculation separate from drawing.

Line drawing does not simply draw adjacent line points. It enumerates node pairs and validates ownership of the entire segment:

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

This prevents the renderer from accidentally drawing extra connections at corners.

## Web Front-End Architecture

Current real entry path:

```text
index.html -> main.js -> OnlineApp.js
```

Core modules:

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

Responsibilities:

- `main.js`: loads the Vue runtime, mounts the app, and handles startup failure states.
- `OnlineApp.js`: main application orchestration layer for local mode, online mode, room flow, and page layout.
- `OnlineAppState.js`: default settings, session-storage keys, authentication data, and locally persisted state.
- `OnlineAppI18n.js`: Chinese/English text, titles, scores, states, and error formatting.
- `GameController.js`: interaction-control layer connecting the rule engine, renderer, and network layer.
- `GameEngine.js`: rule-calculation layer maintaining the board, moves, turns, territory, scores, and end state.
- `Renderer.js`: Canvas drawing layer for board, nodes, lines, territory, highlights, and responsive sizing.
- `NetworkManager.js`: WebSocket client wrapper for request sending, event subscription, heartbeat, and error handling.
- `styles.css`: page layout, responsive strategy, collapsible information docks, and mobile adaptation.

Architecture constraints:

- The current rule source of truth is the front-end `GameEngine.js`.
- The back end does not adjudicate triangular-board rules.
- Rendering performance issues should be handled first in `Renderer.js`.
- New text should usually be added to `OnlineAppI18n.js`.

## Web Back-End Architecture

Current back-end main service:

```text
web/web后端/server.py
```

Back-end responsibilities:

- FastAPI application entry.
- Static asset hosting.
- User registration and login.
- `bcrypt + sha256` password hashing.
- JWT issuing and validation.
- WebSocket authentication and connection.
- Room creation, joining, and leaving.
- Player identity, color, host, and ready-state management.
- Match-start countdown.
- Online reset voting.
- Room action log.
- Heartbeat detection.
- Disconnection recovery.
- Room timeout cleanup.

The back end does not handle:

- move legality adjudication
- territory calculation
- endgame winner adjudication
- replacing the front-end rule engine

The repository also contains:

```text
web/web后端/game_router.py
```

That file belongs to an experimental or historical back-end rule direction; it is not the current Web main path.

## WebSocket Data Flow

Online mode uses the pattern "server synchronizes actions, clients replay rules".

Move data flow:

```text
User clicks the board
-> GameController receives the interaction
-> GameEngine executes local rules
-> Renderer refreshes the local view
-> NetworkManager sends player_move
-> server.py broadcasts to other room members
-> other clients replay the action with their local GameEngine
```

Main client messages:

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

Main server events:

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

Room constants:

- Room code length: `4`
- Room timeout cleanup: `300` seconds
- Heartbeat timeout: `35` seconds
- Heartbeat sweep interval: `5` seconds
- Start countdown: `3` seconds
- Board side-length range: `6` to `15`
- Supported player count: `2` or `3`

## UI Requirements

The current UI treats the board as the main operation surface.

Main constraints:

- The first screen shows the title and central board.
- The board must be fully visible on both desktop and mobile.
- Page scrolling is mainly vertical.
- The board area does not contain long explanatory text.
- Current turn and local actions remain below the board.
- The board dock is collapsed by default, with a summary showing player count and side length.
- The online dock is collapsed by default, with a summary showing local status or room code.
- The Chinese title is `生命线`.
- The English title is `LIFELINE`.
- New text is maintained centrally in `OnlineAppI18n.js`.

## Modification Entry Points

Common modification paths:

- Rules and moves: `GameEngine.js`, with `core algorithm/triangular_game.py` as reference.
- Territory, node deletion, connectivity: compare the core algorithm document and sample implementation first.
- Rendering performance: `Renderer.js`.
- Page structure: `OnlineApp.js`.
- Default settings and local session: `OnlineAppState.js`.
- Text and language: `OnlineAppI18n.js`.
- Online protocol: `NetworkManager.js` and `server.py`.
- Back-end room logic: `server.py`.

Suggested verification items:

- Two-player local game can start, place moves, skip, and end normally.
- Three-player game has correct colors, turns, and territory statistics.
- Side lengths `6`, `10`, and `15` display completely.
- After attacking a line point, broken-edge cleanup, enclave deletion, orphan-line cleanup, and reconnection are consistent.
- Superko violations roll the position back.
- Online room creation, joining, ready flow, start, and move synchronization work normally.
- Host setting changes reset ready states.
- Online reset requires confirmation from every player.
- After disconnection, room context can be restored.

## GitHub

Repository:

```text
https://github.com/Chengzong-Zhang/Line-Game
```
