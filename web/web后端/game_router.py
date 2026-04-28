"""
game_router.py — 三角网格圈地博弈 FastAPI 路由

架构原则：后端是唯一的真理来源（Single Source of Truth）。
前端收到响应后只需无脑渲染，不执行任何游戏逻辑计算。

依赖：pip install fastapi pydantic
引擎：从 triangular_game.py 提取的无 pygame 依赖的纯逻辑层。
"""

from __future__ import annotations

import hashlib
import uuid
from collections import deque
from enum import Enum
from typing import Dict, List, Optional, Set, Tuple

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

router = APIRouter(prefix="/game", tags=["game"])


# ─────────────────────────────────────────────────────────────────────────────
# 游戏引擎枚举 & 常量（与 triangular_game.py 保持一致）
# ─────────────────────────────────────────────────────────────────────────────

class PointState(str, Enum):
    EMPTY      = "EMPTY"
    BLACK_NODE = "BLACK_NODE"
    BLACK_LINE = "BLACK_LINE"
    WHITE_NODE = "WHITE_NODE"
    WHITE_LINE = "WHITE_LINE"


class PlayerSide(str, Enum):
    BLACK = "BLACK"
    WHITE = "WHITE"


# ─────────────────────────────────────────────────────────────────────────────
# Pydantic 数据模型
# ─────────────────────────────────────────────────────────────────────────────

class MoveRequest(BaseModel):
    """前端传来的落子请求"""
    player: PlayerSide = Field(..., description="落子方：BLACK（蓝）或 WHITE（红）")
    x: int             = Field(..., ge=0, le=8, description="网格 x 坐标")
    y: int             = Field(..., ge=0, le=8, description="网格 y 坐标")


class GridPoint(BaseModel):
    """单个网格点的完整状态"""
    x: int
    y: int
    state: PointState


class EdgeEntry(BaseModel):
    """一条逻辑拓扑边（玩家显式边集合中的元素）"""
    player: PlayerSide
    node_a: Tuple[int, int]   # frozenset 解包后的端点
    node_b: Tuple[int, int]


class GameStateResponse(BaseModel):
    """返回给前端的全量游戏状态"""
    game_id: str

    # ── 网格物理层 ──────────────────────────────────────────────────────
    grid: List[GridPoint] = Field(..., description="所有网格点的坐标与状态，前端直接渲染")

    # ── 逻辑拓扑层 ──────────────────────────────────────────────────────
    edges: List[EdgeEntry] = Field(
        ...,
        description="当前所有逻辑连接边（adj_list），供前端绘制连线或调试"
    )

    # ── 领土结果 ─────────────────────────────────────────────────────────
    black_territory: List[Tuple[int, int]] = Field(
        ..., description="蓝方领土点阵（网格坐标列表）"
    )
    white_territory: List[Tuple[int, int]] = Field(
        ..., description="红方领土点阵（网格坐标列表）"
    )
    black_score: int = Field(..., description="蓝方领土格点总数")
    white_score: int = Field(..., description="红方领土格点总数")

    # ── 流程控制 ─────────────────────────────────────────────────────────
    current_player: PlayerSide = Field(..., description="当前行棋方")
    game_over: bool
    winner: Optional[PlayerSide] = Field(None, description="胜者；平局时为 null")
    message: str = Field("", description="操作反馈文字（非法落子原因、游戏结束提示等）")


# ─────────────────────────────────────────────────────────────────────────────
# 自定义异常
# ─────────────────────────────────────────────────────────────────────────────

class SuperkoViolationError(Exception):
    """落子后局面哈希已存在于历史记录中，触发全局同形再现禁手（Superko Rule）。"""
    pass


# ─────────────────────────────────────────────────────────────────────────────
# 无渲染纯逻辑游戏引擎
# （从 triangular_game.py 剥离 pygame 依赖后的后端专用版本）
# ─────────────────────────────────────────────────────────────────────────────

class HeadlessGameEngine:
    """
    与 TriangularGame 共享完全相同的游戏规则与算法，
    但移除所有 pygame/屏幕依赖，仅保留纯 Python 数据结构。
    """

    GRID_SIZE = 9
    # 六个方向向量，顺时针：E, SE, SW, W, NW, NE
    _DIRS_CW: List[Tuple[int, int]] = [
        (1, 0), (0, 1), (-1, 1), (-1, 0), (0, -1), (1, -1)
    ]

    def __init__(self) -> None:
        self.grid: Dict[Tuple[int, int], PointState] = {}
        self.current_player = PlayerSide.BLACK
        self.game_over = False
        self.consecutive_skips = 0

        # 逻辑拓扑层：显式边集合，frozenset({node_a, node_b})
        self.black_edges: Set[frozenset] = set()
        self.white_edges: Set[frozenset] = set()

        # 领土缓存：(covered_set, score)
        self._hull_black: Tuple[Set[Tuple[int, int]], int] = (set(), 0)
        self._hull_white: Tuple[Set[Tuple[int, int]], int] = (set(), 0)

        # 全局同形再现禁手：记录历史局面哈希，防止打劫循环
        self.history_hashes: Set[str] = set()

        self._init_grid()
        self.grid[(0, 0)] = PointState.BLACK_NODE
        self.grid[(8, 0)] = PointState.WHITE_NODE

        # 将初始局面写入历史，防止任何操作回到起始状态
        self.history_hashes.add(self._compute_state_hash(PlayerSide.BLACK))

    # ── 初始化 ──────────────────────────────────────────────────────────

    def _init_grid(self) -> None:
        for y in range(self.GRID_SIZE):
            for x in range(self.GRID_SIZE - y):
                self.grid[(x, y)] = PointState.EMPTY

    # ── 局面哈希（Superko 用）────────────────────────────────────────────

    def _compute_state_hash(self, next_player: PlayerSide) -> str:
        """将当前棋盘状态 + 即将行棋方序列化为确定性哈希字符串。

        包含：
        - 所有非空格点的坐标与归属（排序后）
        - black_edges / white_edges 中的所有连线关系（排序后）
        - 即将行棋方（即落子方切换后的下一手玩家）

        哈希相等 ⟺ 局面完全相同（全局同形再现禁手判定依据）。
        """
        # 网格层：仅序列化非空点，(x, y, state_value) 升序排列
        grid_entries = sorted(
            (x, y, state.value)
            for (x, y), state in self.grid.items()
            if state != PointState.EMPTY
        )
        # 逻辑拓扑层：每条边规范化为 (min_node, max_node)，整体升序排列
        black_edge_list = sorted(tuple(sorted(e)) for e in self.black_edges)
        white_edge_list = sorted(tuple(sorted(e)) for e in self.white_edges)

        raw = repr((next_player.value, grid_entries, black_edge_list, white_edge_list))
        return hashlib.sha256(raw.encode()).hexdigest()

    # ── 坐标与邻接 ──────────────────────────────────────────────────────

    def _get_adjacent_positions(self, pos: Tuple[int, int]) -> List[Tuple[int, int]]:
        x, y = pos
        candidates = [
            (x+1, y), (x, y+1), (x-1, y+1),
            (x-1, y), (x, y-1), (x+1, y-1),
        ]
        return [p for p in candidates if p in self.grid]

    def _can_connect(self, p1: Tuple[int, int], p2: Tuple[int, int]) -> bool:
        x1, y1 = p1; x2, y2 = p2
        return x1 == x2 or y1 == y2 or (x1 + y1 == x2 + y2)

    def _get_line_points(self, start: Tuple[int, int], end: Tuple[int, int]) -> List[Tuple[int, int]]:
        x1, y1 = start; x2, y2 = end
        pts: List[Tuple[int, int]] = []
        if x1 == x2:
            for y in range(min(y1, y2), max(y1, y2) + 1):
                if (x1, y) in self.grid:
                    pts.append((x1, y))
        elif y1 == y2:
            for x in range(min(x1, x2), max(x1, x2) + 1):
                if (x, y1) in self.grid:
                    pts.append((x, y1))
        elif x1 + y1 == x2 + y2:
            base_x, base_y = (x1, y1) if x1 < x2 else (x2, y2)
            length = abs(x2 - x1)
            for i in range(length + 1):
                p = (base_x + i, base_y - i)
                if p in self.grid:
                    pts.append(p)
        return pts

    def _can_connect_with_blocking(self, p1: Tuple[int, int], p2: Tuple[int, int],
                                    player: PlayerSide) -> bool:
        if not self._can_connect(p1, p2):
            return False
        opp_node = PointState.WHITE_NODE if player == PlayerSide.BLACK else PointState.BLACK_NODE
        opp_line = PointState.WHITE_LINE if player == PlayerSide.BLACK else PointState.BLACK_LINE
        for pt in self._get_line_points(p1, p2):
            if pt != p1 and pt != p2 and self.grid[pt] in (opp_node, opp_line):
                return False
        return True

    # ── 玩家棋子查询 ─────────────────────────────────────────────────────

    def _get_player_nodes(self, player: PlayerSide) -> List[Tuple[int, int]]:
        target = PointState.BLACK_NODE if player == PlayerSide.BLACK else PointState.WHITE_NODE
        return [pos for pos, st in self.grid.items() if st == target]

    def _get_player_lines(self, player: PlayerSide) -> List[Tuple[int, int]]:
        target = PointState.BLACK_LINE if player == PlayerSide.BLACK else PointState.WHITE_LINE
        return [pos for pos, st in self.grid.items() if st == target]

    # ── 规则校验 ─────────────────────────────────────────────────────────

    def _check_three_point_limitation(self, new_pos: Tuple[int, int], player: PlayerSide) -> bool:
        nodes = set(self._get_player_nodes(player))
        adj_nodes = [p for p in self._get_adjacent_positions(new_pos) if p in nodes]
        if len(adj_nodes) >= 2:
            return False
        for an in adj_nodes:
            if any(p in nodes for p in self._get_adjacent_positions(an)):
                return False
        return True

    def _is_in_protection_zone(self, pos: Tuple[int, int], player: PlayerSide) -> bool:
        opp_initial = (8, 0) if player == PlayerSide.BLACK else (0, 0)
        return pos in self._get_adjacent_positions(opp_initial)

    # ── 逻辑拓扑层（边集合）操作 ─────────────────────────────────────────

    def _get_edges(self, player: PlayerSide) -> Set[frozenset]:
        return self.black_edges if player == PlayerSide.BLACK else self.white_edges

    def _cleanup_broken_edges(self, player: PlayerSide) -> None:
        node_st = PointState.BLACK_NODE if player == PlayerSide.BLACK else PointState.WHITE_NODE
        line_st = PointState.BLACK_LINE if player == PlayerSide.BLACK else PointState.WHITE_LINE
        valid = {node_st, line_st}
        broken = {e for e in self._get_edges(player)
                  if not all(self.grid.get(p) in valid
                              for p in self._get_line_points(*tuple(e)))}
        self._get_edges(player).difference_update(broken)

    def _remove_node_edges(self, node: Tuple[int, int], player: PlayerSide) -> None:
        self._get_edges(player).difference_update(
            {e for e in self._get_edges(player) if node in e}
        )

    def _is_connected_to_initial(self, pos: Tuple[int, int], player: PlayerSide) -> bool:
        initial = (0, 0) if player == PlayerSide.BLACK else (8, 0)
        if pos == initial:
            return True
        adj: Dict[Tuple[int, int], List[Tuple[int, int]]] = {}
        for edge in self._get_edges(player):
            a, b = tuple(edge)
            adj.setdefault(a, []).append(b)
            adj.setdefault(b, []).append(a)
        visited = {initial}
        q: deque = deque([initial])
        while q:
            curr = q.popleft()
            if curr == pos:
                return True
            for nxt in adj.get(curr, []):
                if nxt not in visited:
                    visited.add(nxt)
                    q.append(nxt)
        return False

    def _get_opponent_connected_pieces(self, opponent: PlayerSide) -> Set[Tuple[int, int]]:
        """以对手起始点为根，在物理棋盘（NODE + LINE 均视为图节点）上做 BFS，
        返回包含基点的极大连通分量中所有棋子格点的集合。
        不依赖 edges 集合——直接遍历 self.grid 上的实际状态。"""
        opp_node = PointState.BLACK_NODE if opponent == PlayerSide.BLACK else PointState.WHITE_NODE
        opp_line = PointState.BLACK_LINE if opponent == PlayerSide.BLACK else PointState.WHITE_LINE
        initial = (0, 0) if opponent == PlayerSide.BLACK else (8, 0)
        if self.grid.get(initial) != opp_node:
            return set()
        alive: Set[Tuple[int, int]] = {initial}
        q: deque = deque([initial])
        while q:
            curr = q.popleft()
            for nxt in self._get_adjacent_positions(curr):
                if nxt in alive:
                    continue
                if self.grid.get(nxt) in (opp_node, opp_line):
                    alive.add(nxt)
                    q.append(nxt)
        return alive

    # ── 进攻与结算 ───────────────────────────────────────────────────────

    def _handle_blocking_attack(self, new_pos: Tuple[int, int], player: PlayerSide,
                                 original_state: PointState) -> None:
        opponent = PlayerSide.WHITE if player == PlayerSide.BLACK else PlayerSide.BLACK
        opp_line = PointState.WHITE_LINE if player == PlayerSide.BLACK else PointState.BLACK_LINE
        opp_node = PointState.WHITE_NODE if player == PlayerSide.BLACK else PointState.BLACK_NODE

        if original_state != opp_line:
            return

        # Step 1：级联删除线点
        x0, y0 = new_pos
        for dx, dy in [(1,0),(-1,0),(0,1),(0,-1),(1,-1),(-1,1)]:
            nx, ny = x0 + dx, y0 + dy
            if (nx, ny) not in self.grid or self.grid[(nx, ny)] != opp_line:
                continue
            cells: List[Tuple[int, int]] = []
            cx, cy = nx, ny
            while (cx, cy) in self.grid and self.grid[(cx, cy)] == opp_line:
                cells.append((cx, cy))
                cx += dx; cy += dy
            if (cx, cy) in self.grid and self.grid[(cx, cy)] == opp_node:
                for cell in cells:
                    self.grid[cell] = PointState.EMPTY

        # Step 2：基于物理棋盘的 BFS 连通分量，一次性清理所有断联棋子（NODE + LINE）
        alive = self._get_opponent_connected_pieces(opponent)
        for pos in list(self.grid.keys()):
            if self.grid[pos] in (opp_node, opp_line) and pos not in alive:
                self.grid[pos] = PointState.EMPTY

        # Step 3：清空旧逻辑边，基于幸存盘面重建
        self._get_edges(opponent).clear()
        self._reconnect_player_nodes(player)
        self._reconnect_player_nodes(opponent)

    def _reconnect_player_nodes(self, player: PlayerSide) -> None:
        node_st = PointState.BLACK_NODE if player == PlayerSide.BLACK else PointState.WHITE_NODE
        line_st = PointState.BLACK_LINE if player == PlayerSide.BLACK else PointState.WHITE_LINE
        nodes = self._get_player_nodes(player)
        for i in range(len(nodes)):
            for j in range(i+1, len(nodes)):
                n1, n2 = nodes[i], nodes[j]
                if self._can_connect_with_blocking(n1, n2, player):
                    for pt in self._get_line_points(n1, n2):
                        if pt == n1 or pt == n2:
                            self.grid[pt] = node_st
                        elif self.grid[pt] == PointState.EMPTY:
                            self.grid[pt] = line_st
                    self._get_edges(player).add(frozenset({n1, n2}))

    # ── 落子主入口 ───────────────────────────────────────────────────────

    def add_node(self, pos: Tuple[int, int]) -> bool:
        if pos not in self.grid:
            return False
        original_state = self.grid[pos]
        if original_state not in (PointState.EMPTY, PointState.WHITE_LINE, PointState.BLACK_LINE):
            return False
        if self._is_in_protection_zone(pos, self.current_player):
            return False

        opp_line = PointState.WHITE_LINE if self.current_player == PlayerSide.BLACK else PointState.BLACK_LINE
        is_attack = (original_state == opp_line)
        if not is_attack and not self._check_three_point_limitation(pos, self.current_player):
            return False

        # ── 快照当前状态，用于 Superko 违规时回滚 ───────────────────────
        grid_snapshot = dict(self.grid)
        black_edges_snapshot = set(self.black_edges)
        white_edges_snapshot = set(self.white_edges)

        node_st = PointState.BLACK_NODE if self.current_player == PlayerSide.BLACK else PointState.WHITE_NODE
        line_st = PointState.BLACK_LINE if self.current_player == PlayerSide.BLACK else PointState.WHITE_LINE
        self.grid[pos] = node_st

        existing_nodes = [n for n in self._get_player_nodes(self.current_player) if n != pos]
        connected = False
        for node in existing_nodes:
            if self._can_connect_with_blocking(pos, node, self.current_player):
                connected = True
                for pt in self._get_line_points(pos, node):
                    if self.grid[pt] in (PointState.EMPTY, line_st):
                        self.grid[pt] = line_st
                    if pt == pos or pt == node:
                        self.grid[pt] = node_st
                self._get_edges(self.current_player).add(frozenset({pos, node}))

        if not connected:
            self.grid[pos] = original_state
            return False

        self._handle_blocking_attack(pos, self.current_player, original_state)

        # ── Superko 检查：计算结算后（切换玩家前）局面的哈希 ────────────
        next_player = (PlayerSide.WHITE
                       if self.current_player == PlayerSide.BLACK
                       else PlayerSide.BLACK)
        state_hash = self._compute_state_hash(next_player)
        if state_hash in self.history_hashes:
            # 局面重复 → 回滚所有变更，抛出禁手异常
            self.grid = grid_snapshot
            self.black_edges = black_edges_snapshot
            self.white_edges = white_edges_snapshot
            raise SuperkoViolationError(
                f"落子 {pos} 导致局面与历史某一手完全相同，触发全局同形再现禁手（Superko Rule）。"
            )

        self.history_hashes.add(state_hash)
        return True

    # ── 回合控制 ─────────────────────────────────────────────────────────

    def _switch_player(self) -> None:
        self.current_player = (PlayerSide.WHITE
                               if self.current_player == PlayerSide.BLACK
                               else PlayerSide.BLACK)

    def _is_legal_move(self, pos: Tuple[int, int], player: PlayerSide) -> bool:
        """在不提交状态的前提下，检查一步棋是否通过完整规则校验（含 Superko）。"""
        grid_snapshot = dict(self.grid)
        black_edges_snapshot = set(self.black_edges)
        white_edges_snapshot = set(self.white_edges)
        history_hashes_snapshot = set(self.history_hashes)
        current_player_snapshot = self.current_player

        try:
            self.current_player = player
            return self.add_node(pos)
        except SuperkoViolationError:
            return False
        finally:
            self.grid = grid_snapshot
            self.black_edges = black_edges_snapshot
            self.white_edges = white_edges_snapshot
            self.history_hashes = history_hashes_snapshot
            self.current_player = current_player_snapshot

    def _has_valid_moves(self, player: PlayerSide) -> bool:
        for pos in self.grid:
            if self._is_legal_move(pos, player):
                return True
        return False

    def _check_and_auto_skip(self) -> None:
        if self.game_over:
            return
        if not self._has_valid_moves(self.current_player):
            self.consecutive_skips += 1
            if self.consecutive_skips >= 2:
                self.game_over = True
            else:
                self._switch_player()
                self._check_and_auto_skip()

    def handle_skip(self) -> None:
        if self.game_over:
            return
        self.consecutive_skips += 1
        if self.consecutive_skips >= 2:
            self.game_over = True
        else:
            self._switch_player()
            self._check_and_auto_skip()
        self._update_hulls()

    # ── 领土计算（三阶段：右手摸墙 → 贪心修剪 → 泛洪判定）────────────────

    def _get_outer_contour(self, player: PlayerSide) -> List[Tuple[int, int]]:
        DIRS = self._DIRS_CW
        friendlies = set(self._get_player_nodes(player) + self._get_player_lines(player))
        if not friendlies:
            return []
        start = min(friendlies, key=lambda p: (p[0], p[1]))
        if len(friendlies) == 1:
            return [start]

        backtrack = 3
        contour: List[Tuple[int, int]] = []
        current = start
        first_out_dir: Optional[int] = None
        max_steps = len(friendlies) * 6 + 10

        for _ in range(max_steps):
            out_dir = None
            for i in range(6):
                d = (backtrack + 1 + i) % 6
                dx, dy = DIRS[d]
                nxt = (current[0] + dx, current[1] + dy)
                if nxt in friendlies:
                    out_dir = d
                    break
            if out_dir is None:
                contour.append(current)
                break
            if first_out_dir is None:
                first_out_dir = out_dir
                contour.append(current)
            elif current == start and out_dir == first_out_dir:
                break
            else:
                contour.append(current)
            dx, dy = DIRS[out_dir]
            current = (current[0] + dx, current[1] + dy)
            backtrack = (out_dir + 3) % 6
        return contour

    def _get_covered_points(self, polygon: List[Tuple[int, int]]) -> Set[Tuple[int, int]]:
        """泛洪法：从棋盘边缘注水，返回多边形真实覆盖的格点集合。"""
        wall = set(polygon)
        water: Set[Tuple[int, int]] = set()
        q: deque = deque()
        for y in range(9):
            for x in range(9 - y):
                if (x == 0 or y == 0 or x + y == 8) and (x, y) not in wall:
                    water.add((x, y))
                    q.append((x, y))
        while q:
            curr = q.popleft()
            for nxt in self._get_adjacent_positions(curr):
                if nxt not in wall and nxt not in water:
                    water.add(nxt)
                    q.append(nxt)
        all_pts = {(x, y) for y in range(9) for x in range(9 - y)}
        return all_pts - water

    def _get_all_shortest_grid_paths(self, start: Tuple[int, int], end: Tuple[int, int],
                                      enemies: Set[Tuple[int, int]],
                                      max_paths: int = 50) -> List[List[Tuple[int, int]]]:
        if start == end:
            return [[start]]
        queue: List[List[Tuple[int, int]]] = [[start]]
        results: List[List[Tuple[int, int]]] = []
        min_len = float('inf')
        depth_map: Dict[Tuple[int, int], int] = {start: 0}
        while queue:
            path = queue.pop(0)
            if len(path) > min_len or len(results) >= max_paths:
                continue
            curr = path[-1]
            if curr == end:
                results.append(path)
                min_len = len(path)
                continue
            for nxt in self._get_adjacent_positions(curr):
                if nxt in enemies:
                    continue
                depth = len(path)
                if nxt not in depth_map or depth_map[nxt] >= depth:
                    depth_map[nxt] = depth
                    queue.append(path + [nxt])
        return results

    def _compute_inner_hull(self, player: PlayerSide) -> Tuple[Set[Tuple[int, int]], int]:
        """核心：右手摸墙 → 动态贪心修剪（BFS 预计算 + 楔形泛洪）→ 泛洪判定。"""
        opp = PlayerSide.WHITE if player == PlayerSide.BLACK else PlayerSide.BLACK
        enemies = set(self._get_player_nodes(opp) + self._get_player_lines(opp))
        friendly_nodes = set(self._get_player_nodes(player))

        current_poly = self._get_outer_contour(player)
        if len(current_poly) < 3:
            return set(), 0

        def dedupe_adjacent(poly: List[Tuple[int, int]]) -> List[Tuple[int, int]]:
            return [p for k, p in enumerate(poly) if k == 0 or p != poly[k - 1]]

        def bfs_from_source(src: Tuple[int, int]) -> Tuple[Dict[Tuple[int, int], int], Dict[Tuple[int, int], List[Tuple[int, int]]]]:
            blocked = set(enemies)
            blocked.discard(src)
            dist: Dict[Tuple[int, int], int] = {src: 0}
            pred: Dict[Tuple[int, int], List[Tuple[int, int]]] = {}
            q: deque = deque([src])
            while q:
                curr = q.popleft()
                for nxt in self._get_adjacent_positions(curr):
                    if nxt in blocked:
                        continue
                    nd = dist[curr] + 1
                    if nxt not in dist:
                        dist[nxt] = nd
                        pred[nxt] = [curr]
                        q.append(nxt)
                    elif dist[nxt] == nd:
                        pred[nxt].append(curr)
            return dist, pred

        def reconstruct_paths(
            src: Tuple[int, int],
            tgt: Tuple[int, int],
            pred: Dict[Tuple[int, int], List[Tuple[int, int]]],
            limit: int = 100,
        ) -> List[List[Tuple[int, int]]]:
            if src == tgt:
                return [[src]]
            results: List[List[Tuple[int, int]]] = []

            def build(curr: Tuple[int, int], suffix: List[Tuple[int, int]]) -> None:
                if len(results) >= limit:
                    return
                if curr == src:
                    results.append([src] + suffix)
                    return
                for prev in pred.get(curr, []):
                    build(prev, [curr] + suffix)

            build(tgt, [])
            return results

        while True:
            n = len(current_poly)
            if n < 3:
                break
            cur_perim = n
            cur_covered = self._get_covered_points(current_poly)
            cur_area = len(cur_covered)
            best_cand = None
            best_perim = cur_perim
            best_area = cur_area

            bfs_cache = [bfs_from_source(current_poly[i]) for i in range(n)]

            for i in range(n):
                dist_i, pred_i = bfs_cache[i]
                for j in range(n - 1, i + 1, -1):
                    arc_len = j - i
                    if arc_len <= 1:
                        continue
                    shortest_dist = dist_i.get(current_poly[j])
                    if shortest_dist is None or shortest_dist >= arc_len:
                        continue
                    paths = reconstruct_paths(current_poly[i], current_poly[j], pred_i, limit=100)
                    for path in paths:
                        path_len = len(path)
                        path_interior = path[1:-1]
                        is_inward = all(p in cur_covered for p in path_interior)

                        if is_inward:
                            wedge = dedupe_adjacent(current_poly[i:j+1] + list(reversed(path_interior)))
                            if len(wedge) < 3:
                                continue
                            wedge_covered = self._get_covered_points(wedge)
                            wedge_area = len(wedge_covered)
                            path_set = set(path)

                            cand_a_area = cur_area - wedge_area + 2 * (path_len - 1)
                            cand_a_perim = cur_perim - arc_len + (path_len - 1)
                            if (
                                cand_a_perim <= best_perim
                                and not (cand_a_perim == best_perim and cand_a_area >= best_area)
                                and all(fn not in wedge_covered or fn in path_set for fn in friendly_nodes)
                            ):
                                cand_a = dedupe_adjacent(current_poly[:i] + path + current_poly[j+1:])
                                if len(cand_a) >= 3:
                                    best_perim = cand_a_perim
                                    best_area = cand_a_area
                                    best_cand = cand_a

                            cand_b_perim = len(wedge)
                            cand_b_area = wedge_area
                            if (
                                cand_b_perim <= best_perim
                                and not (cand_b_perim == best_perim and cand_b_area >= best_area)
                                and friendly_nodes.issubset(wedge_covered)
                                and not any(e in wedge_covered for e in enemies)
                            ):
                                best_perim = cand_b_perim
                                best_area = cand_b_area
                                best_cand = wedge
                        else:
                            cand_a = current_poly[:i] + path + current_poly[j+1:]
                            cand_b = current_poly[i:j+1] + list(reversed(path_interior))
                            for cand in (cand_a, cand_b):
                                cand = dedupe_adjacent(cand)
                                if len(cand) < 3:
                                    continue
                                cp = len(cand)
                                if cp > best_perim:
                                    continue
                                covered = self._get_covered_points(cand)
                                ca = len(covered)
                                if cp == best_perim and ca >= best_area:
                                    continue
                                if not friendly_nodes.issubset(covered):
                                    continue
                                if any(e in covered for e in enemies):
                                    continue
                                best_perim = cp
                                best_area = ca
                                best_cand = cand

            if best_cand is not None:
                current_poly = best_cand
            else:
                break

        if len(current_poly) < 3:
            return set(), 0
        covered = self._get_covered_points(current_poly)
        return covered, len(covered)

    def _update_hulls(self) -> None:
        self._hull_black = self._compute_inner_hull(PlayerSide.BLACK)
        self._hull_white = self._compute_inner_hull(PlayerSide.WHITE)

    # ── 序列化为 API 响应 ─────────────────────────────────────────────────

    def to_state_response(self, game_id: str, message: str = "") -> GameStateResponse:
        """将当前引擎状态序列化为前端可直接渲染的全量 JSON 响应。"""
        # 网格物理层
        grid_points = [
            GridPoint(x=x, y=y, state=state)
            for (x, y), state in self.grid.items()
        ]

        # 逻辑拓扑层（edges → 列表形式）
        edge_list: List[EdgeEntry] = []
        for player, edge_set in [(PlayerSide.BLACK, self.black_edges),
                                  (PlayerSide.WHITE, self.white_edges)]:
            for edge in edge_set:
                a, b = tuple(edge)
                edge_list.append(EdgeEntry(player=player, node_a=a, node_b=b))

        # 领土
        black_covered, black_score = self._hull_black
        white_covered, white_score = self._hull_white

        # 胜者判定
        winner: Optional[PlayerSide] = None
        if self.game_over:
            if black_score > white_score:
                winner = PlayerSide.BLACK
            elif white_score > black_score:
                winner = PlayerSide.WHITE
            # else: 平局，winner 保持 None

        return GameStateResponse(
            game_id=game_id,
            grid=grid_points,
            edges=edge_list,
            black_territory=sorted(black_covered),
            white_territory=sorted(white_covered),
            black_score=black_score,
            white_score=white_score,
            current_player=self.current_player,
            game_over=self.game_over,
            winner=winner,
            message=message,
        )


# ─────────────────────────────────────────────────────────────────────────────
# 游戏会话管理（内存级；生产环境替换为 Redis / DB）
# ─────────────────────────────────────────────────────────────────────────────

_sessions: Dict[str, HeadlessGameEngine] = {}


def _get_engine(game_id: str) -> HeadlessGameEngine:
    engine = _sessions.get(game_id)
    if engine is None:
        raise HTTPException(status_code=404, detail=f"游戏 {game_id!r} 不存在")
    return engine


# ─────────────────────────────────────────────────────────────────────────────
# FastAPI 路由定义
# ─────────────────────────────────────────────────────────────────────────────

@router.post(
    "/new",
    response_model=GameStateResponse,
    summary="创建新游戏",
    description="初始化一局新游戏，返回初始全量状态。",
)
def create_game() -> GameStateResponse:
    game_id = str(uuid.uuid4())
    engine = HeadlessGameEngine()
    engine._update_hulls()          # 计算初始（空）领土缓存
    _sessions[game_id] = engine
    return engine.to_state_response(game_id, message="游戏已创建，蓝方先手。")


@router.post(
    "/{game_id}/move",
    response_model=GameStateResponse,
    summary="执行落子",
    description=(
        "前端提交落子坐标与玩家身份。"
        "后端校验合法性、执行全部结算逻辑（攻击/BFS飞地/重缝/领土重算），"
        "返回更新后的全量状态。前端无需执行任何逻辑。"
    ),
)
def make_move(game_id: str, req: MoveRequest) -> GameStateResponse:
    engine = _get_engine(game_id)

    # 游戏已结束
    if engine.game_over:
        return engine.to_state_response(game_id, message="游戏已结束，无法继续落子。")

    # 玩家顺序校验
    if req.player != engine.current_player:
        raise HTTPException(
            status_code=400,
            detail=f"当前行棋方为 {engine.current_player}，而非 {req.player}。"
        )

    pos = (req.x, req.y)

    # 执行落子（引擎内部完成所有结算）
    try:
        success = engine.add_node(pos)
    except SuperkoViolationError as e:
        return engine.to_state_response(
            game_id,
            message=f"SUPERKO_VIOLATION: 落子 ({req.x}, {req.y}) 触发全局同形再现禁手，该手被拒绝。"
        )

    if not success:
        return engine.to_state_response(
            game_id,
            message=f"落子 ({req.x}, {req.y}) 不合法，请重新选择。"
        )

    # 落子成功：重置连续跳过计数、切换玩家、检查自动跳过、重算领土
    engine.consecutive_skips = 0
    engine._switch_player()
    engine._check_and_auto_skip()
    engine._update_hulls()

    msg = "落子成功。"
    if engine.game_over:
        b, w = engine._hull_black[1], engine._hull_white[1]
        msg = f"游戏结束！蓝方 {b} 分，红方 {w} 分。"

    return engine.to_state_response(game_id, message=msg)


@router.post(
    "/{game_id}/skip",
    response_model=GameStateResponse,
    summary="当前玩家跳过回合",
    description="若双方连续各跳过一次，游戏结束。",
)
def skip_turn(game_id: str, player: PlayerSide) -> GameStateResponse:
    engine = _get_engine(game_id)

    if engine.game_over:
        return engine.to_state_response(game_id, message="游戏已结束。")

    if player != engine.current_player:
        raise HTTPException(
            status_code=400,
            detail=f"当前行棋方为 {engine.current_player}，而非 {player}。"
        )

    engine.handle_skip()   # 内部已调用 _update_hulls
    return engine.to_state_response(game_id, message=f"{player} 选择跳过。")


@router.get(
    "/{game_id}/state",
    response_model=GameStateResponse,
    summary="查询当前全量状态",
    description="无副作用的幂等查询，返回当前引擎的完整快照。",
)
def get_state(game_id: str) -> GameStateResponse:
    engine = _get_engine(game_id)
    return engine.to_state_response(game_id)


@router.delete(
    "/{game_id}",
    summary="销毁游戏会话",
    description="从内存中移除游戏实例，释放资源。",
)
def delete_game(game_id: str) -> dict:
    if game_id not in _sessions:
        raise HTTPException(status_code=404, detail=f"游戏 {game_id!r} 不存在")
    del _sessions[game_id]
    return {"deleted": game_id}


# ─────────────────────────────────────────────────────────────────────────────
# 挂载示例（在 server.py 中 include_router 即可）
#
# from game_router import router as game_router
# app.include_router(game_router)
#
# 完整 API 端点列表：
#   POST   /game/new                  → 创建新游戏
#   POST   /game/{game_id}/move       → 落子（Body: MoveRequest）
#   POST   /game/{game_id}/skip       → 跳过（Query: player=BLACK|WHITE）
#   GET    /game/{game_id}/state      → 查询全量状态
#   DELETE /game/{game_id}            → 销毁会话
# ─────────────────────────────────────────────────────────────────────────────
