
import pygame
import sys
import math
from enum import Enum
from typing import Dict, List, Tuple, Optional


class PointState(Enum):
    EMPTY = 0
    BLACK_NODE = 1
    BLACK_LINE = 2
    WHITE_NODE = 3
    WHITE_LINE = 4

class Player(Enum):
    BLACK = 1
    WHITE = 2

class TriangularGame:
    def __init__(self):
        pygame.init()
        
        # Screen settings
        self.SCREEN_WIDTH = 800
        self.SCREEN_HEIGHT = 600
        self.screen = pygame.display.set_mode((self.SCREEN_WIDTH, self.SCREEN_HEIGHT))
        pygame.display.set_caption("Triangular Grid Connection Game")
        
        # Colors
        self.WHITE = (255, 255, 255)
        self.BLACK = (0, 0, 0)
        self.GRAY = (128, 128, 128)
        self.RED = (255, 0, 0)
        self.BLUE = (0, 0, 255)
        self.LIGHT_GRAY = (200, 200, 200)
        
        # Grid settings
        self.GRID_SIZE = 9
        self.POINT_RADIUS = 8
        self.LINE_WIDTH = 3
        
        # Calculate grid positioning
        self.grid_start_x = 100
        self.grid_start_y = 100
        self.cell_size = 50
        
        # Initialize game state
        self.grid = {}  # Dictionary to store point states: (x, y) -> PointState
        self.current_player = Player.BLACK
        self.game_over = False
        self.consecutive_skips = 0  # Counts consecutive skips; game ends when both players skip
        
        # Initialize grid points
        self._init_grid()
        
        # Set initial positions
        self.grid[(0, 0)] = PointState.BLACK_NODE
        self.grid[(8, 0)] = PointState.WHITE_NODE
        
        # Skip button
        self.skip_button_rect = pygame.Rect(650, 540, 120, 40)

        # Game clock
        self.clock = pygame.time.Clock()

        # Hull caches — only recomputed after each state change, not every frame
        self._hull_black: Tuple[Optional[list], float] = (None, 0.0)
        self._hull_white: Tuple[Optional[list], float] = (None, 0.0)

        # Pre-built fonts (Font() is slow; create once, reuse every frame)
        self._font_sm  = pygame.font.Font(None, 28)
        self._font_md  = pygame.font.Font(None, 32)
        self._font_lg  = pygame.font.Font(None, 36)
        self._font_xl  = pygame.font.Font(None, 72)

    def _init_grid(self):
        """Initialize the triangular grid with empty points"""
        for y in range(self.GRID_SIZE):
            for x in range(self.GRID_SIZE - y):
                self.grid[(x, y)] = PointState.EMPTY
    
    def _get_screen_pos(self, grid_x: int, grid_y: int) -> Tuple[int, int]:
        """Convert grid coordinates to screen coordinates"""
        # For triangular grid, each row is offset
        offset_x = grid_y * self.cell_size // 2
        screen_x = self.grid_start_x + grid_x * self.cell_size + offset_x
        screen_y = self.grid_start_y + grid_y * self.cell_size * 0.866  # sin(60°) ≈ 0.866
        return (int(screen_x), int(screen_y))
    
    def _get_grid_pos(self, screen_x: int, screen_y: int) -> Optional[Tuple[int, int]]:
        """Convert screen coordinates to grid coordinates"""
        for y in range(self.GRID_SIZE):
            for x in range(self.GRID_SIZE - y):
                pos_x, pos_y = self._get_screen_pos(x, y)
                distance = math.sqrt((screen_x - pos_x)**2 + (screen_y - pos_y)**2)
                if distance <= self.POINT_RADIUS + 5:  # Small tolerance
                    return (x, y)
        return None
    
    def _can_connect(self, pos1: Tuple[int, int], pos2: Tuple[int, int]) -> bool:
        """Check if two positions can be connected according to the rules"""
        x1, y1 = pos1
        x2, y2 = pos2
        
        # Same X axis
        if x1 == x2:
            return True
        
        # Same Y axis
        if y1 == y2:
            return True
        
        # Same diagonal (x + y = constant)
        if x1 + y1 == x2 + y2:
            return True
        
        return False
    
    def _can_connect_with_blocking(self, pos1: Tuple[int, int], pos2: Tuple[int, int], player: Player) -> bool:
        """Check if two positions can be connected without being blocked by opponent"""
        if not self._can_connect(pos1, pos2):
            return False
        
        # Get all points on the line between pos1 and pos2 (excluding endpoints)
        line_points = self._get_line_points(pos1, pos2)
        middle_points = [p for p in line_points if p != pos1 and p != pos2]
        
        # Check if any middle point is occupied by opponent
        opponent_node = PointState.WHITE_NODE if player == Player.BLACK else PointState.BLACK_NODE
        opponent_line = PointState.WHITE_LINE if player == Player.BLACK else PointState.BLACK_LINE
        
        for point in middle_points:
            if self.grid[point] in [opponent_node, opponent_line]:
                return False
        
        return True
    
    def _get_line_points(self, start: Tuple[int, int], end: Tuple[int, int]) -> List[Tuple[int, int]]:
        """Get all points on the line between start and end (inclusive)"""
        x1, y1 = start
        x2, y2 = end
        points = []
        
        if x1 == x2:  # Vertical line
            for y in range(min(y1, y2), max(y1, y2) + 1):
                if (x1, y) in self.grid:
                    points.append((x1, y))
        elif y1 == y2:  # Horizontal line
            for x in range(min(x1, x2), max(x1, x2) + 1):
                if (x, y1) in self.grid:
                    points.append((x, y1))
        elif x1 + y1 == x2 + y2:  # Diagonal line
            if x1 < x2:
                for i in range(x2 - x1 + 1):
                    x, y = x1 + i, y1 - i
                    if (x, y) in self.grid:
                        points.append((x, y))
            else:
                for i in range(x1 - x2 + 1):
                    x, y = x2 + i, y2 - i
                    if (x, y) in self.grid:
                        points.append((x, y))
        
        return points
    
    def _get_player_nodes(self, player: Player) -> List[Tuple[int, int]]:
        """Get all nodes belonging to a player"""
        target_state = PointState.BLACK_NODE if player == Player.BLACK else PointState.WHITE_NODE
        return [pos for pos, state in self.grid.items() if state == target_state]
    
    def _get_player_lines(self, player: Player) -> List[Tuple[int, int]]:
        """Get all line points belonging to a player"""
        target_state = PointState.BLACK_LINE if player == Player.BLACK else PointState.WHITE_LINE
        return [pos for pos, state in self.grid.items() if state == target_state]
    
    def _is_on_segment(self, p: Tuple[int, int], a: Tuple[int, int], b: Tuple[int, int]) -> bool:
        """检查点 p 是否在线段 ab 上（适用网格坐标）"""
        cross = (p[1] - a[1]) * (b[0] - a[0]) - (p[0] - a[0]) * (b[1] - a[1])
        if cross != 0: 
            return False
        return min(a[0], b[0]) <= p[0] <= max(a[0], b[0]) and min(a[1], b[1]) <= p[1] <= max(a[1], b[1])

    def _polygon_contains_all(self, polygon: List[Tuple[int, int]], friendlies: set) -> bool:
        """射线法结合边界检查，确保所有友方点都在多边形内或边界上"""
        n = len(polygon)
        if n < 3: 
            return False
            
        for pt in friendlies:
            if pt in polygon:
                continue
                
            on_boundary = False
            for i in range(n):
                if self._is_on_segment(pt, polygon[i], polygon[(i + 1) % n]):
                    on_boundary = True
                    break
            if on_boundary:
                continue
                
            x, y = pt
            inside = False
            p1x, p1y = polygon[0]
            for i in range(1, n + 1):
                p2x, p2y = polygon[i % n]
                if y > min(p1y, p2y):
                    if y <= max(p1y, p2y):
                        if x <= max(p1x, p2x):
                            if p1y != p2y:
                                xinters = (y - p1y) * (p2x - p1x) / (p2y - p1y) + p1x
                            if p1x == p2x or x <= xinters:
                                inside = not inside
                p1x, p1y = p2x, p2y
                
            if not inside:
                return False
                
        return True

    def _calculate_polygon_area(self, polygon: List[Tuple[int, int]]) -> float:
        """使用斜坐标系下的 Shoelace 公式，返回值恰好等于等边三角形的个数"""
        area = 0
        n = len(polygon)
        for i in range(n):
            x1, y1 = polygon[i]
            x2, y2 = polygon[(i + 1) % n]
            area += (x1 * y2 - x2 * y1)
        return float(abs(area))

    def _get_all_shortest_grid_paths(self, start: Tuple[int, int], end: Tuple[int, int],
                                     enemies: set, max_paths: int = 50) -> List[List[Tuple[int, int]]]:
        """BFS寻路：获取避开敌军的所有等长最短格点路径（上限 max_paths 条）"""
        if start == end:
            return [[start]]

        queue = [[start]]
        shortest_paths = []
        min_length = float('inf')
        visited_at_depth = {start: 0}

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

        return shortest_paths

    # ------------------------------------------------------------------
    # 右手摸墙法 + 拐点提取
    # ------------------------------------------------------------------
    # 6个方向向量，按屏幕坐标顺时针排列：E, SE, SW, W, NW, NE
    _DIRS_CW = [(1, 0), (0, 1), (-1, 1), (-1, 0), (0, -1), (1, -1)]

    def _get_outer_contour(self, player: Player) -> List[Tuple[int, int]]:
        """右手摸墙法：获取己方棋子的外轮廓点列表（闭合环路，不含重复终点）。
        起点 = x 最小（相同取 y 最小）的己方节点，假定从正左方进入。"""
        DIRS = self._DIRS_CW
        friendlies = set(self._get_player_nodes(player) + self._get_player_lines(player))
        if not friendlies:
            return []

        nodes = self._get_player_nodes(player)
        if not nodes:
            return []
        start = min(nodes, key=lambda p: (p[0], p[1]))

        if len(friendlies) == 1:
            return [start]

        backtrack = 3                       # 初始：从正左方（西）进入
        contour: List[Tuple[int, int]] = []
        current = start
        first_out_dir = None
        max_steps = len(friendlies) * 6 + 10   # 安全上限

        for _ in range(max_steps):
            # 从 (backtrack+1)%6 开始顺时针扫描 6 个方向
            out_dir = None
            for i in range(6):
                d = (backtrack + 1 + i) % 6
                dx, dy = DIRS[d]
                nxt = (current[0] + dx, current[1] + dy)
                if nxt in friendlies:
                    out_dir = d
                    break

            if out_dir is None:
                contour.append(current)     # 孤立点
                break

            # 终止条件：回到起点且准备迈出的方向与第一步完全相同
            if first_out_dir is None:
                first_out_dir = out_dir
                contour.append(current)
            elif current == start and out_dir == first_out_dir:
                break                       # 闭合完成
            else:
                contour.append(current)

            # 移动
            dx, dy = DIRS[out_dir]
            current = (current[0] + dx, current[1] + dy)
            backtrack = (out_dir + 3) % 6

        return contour

    def _extract_contour_vertices(self, contour: List[Tuple[int, int]]) -> List[Tuple[int, int]]:
        """从轮廓环路中提取拐点（方向变化的顶点），并去除半岛导致的重复。"""
        n = len(contour)
        if n <= 2:
            return contour[:]

        # 提取方向变化的拐点
        corners: List[Tuple[int, int]] = []
        for i in range(n):
            prev_pt = contour[(i - 1) % n]
            curr_pt = contour[i]
            next_pt = contour[(i + 1) % n]
            d_in  = (curr_pt[0] - prev_pt[0], curr_pt[1] - prev_pt[1])
            d_out = (next_pt[0] - curr_pt[0], next_pt[1] - curr_pt[1])
            if d_in != d_out:
                corners.append(curr_pt)

        if len(corners) < 3:
            return corners

        # 去重：只保留每个点的首次出现（处理半岛 / 窄桥回折）
        seen: set = set()
        deduped: List[Tuple[int, int]] = []
        for pt in corners:
            if pt not in seen:
                seen.add(pt)
                deduped.append(pt)

        return deduped

    # ------------------------------------------------------------------

    def _compute_inner_hull(self, player: Player):
        """核心：领土四步计算（右手摸墙 → 路由 → 面积 → 选路）"""
        opp = Player.WHITE if player == Player.BLACK else Player.BLACK
        friendlies = set(self._get_player_nodes(player) + self._get_player_lines(player))
        enemies    = set(self._get_player_nodes(opp)    + self._get_player_lines(opp))

        if len(friendlies) < 3:
            return None, 0.0

        # Step 1: 右手摸墙法 → 外轮廓 → 拐点
        contour = self._get_outer_contour(player)
        if len(contour) < 3:
            return None, 0.0

        hull_verts = self._extract_contour_vertices(contour)
        if len(hull_verts) < 3:
            return None, 0.0

        # Step 2: 路由 — 寻找相邻拐点之间的所有最短格点路径
        segments_paths: list = []
        n = len(hull_verts)
        for i in range(n):
            seg_s = hull_verts[i]
            seg_e = hull_verts[(i + 1) % n]
            paths = self._get_all_shortest_grid_paths(seg_s, seg_e, enemies)
            if not paths:
                return None, 0.0
            segments_paths.append(paths)

        # 限制组合总数，防止指数爆炸
        total = 1
        for sp in segments_paths:
            total *= len(sp)
            if total > 50000:
                break
        if total > 50000:
            segments_paths = [sp[:3] for sp in segments_paths]
            total = 1
            for sp in segments_paths:
                total *= len(sp)
        if total > 50000:
            segments_paths = [sp[:1] for sp in segments_paths]

        import itertools
        best_polygon = None
        min_area = float('inf')

        # Step 3 & 4: 遍历路径组合，取面积最小的合法多边形
        for combo in itertools.product(*segments_paths):
            polygon: List[Tuple[int, int]] = []
            for path in combo:
                polygon.extend(path[:-1])

            if not self._polygon_contains_all(polygon, friendlies):
                continue

            area = self._calculate_polygon_area(polygon)
            if area < min_area:
                min_area = area
                best_polygon = polygon

        if best_polygon is None:
            return None, 0.0

        screen_polygon = [self._get_screen_pos(*p) for p in best_polygon]
        return screen_polygon, min_area
    
    def _update_hulls(self):
        """Recompute both players' inner hull and cache the results.
        Call once after every state change instead of every frame."""
        self._hull_black = self._compute_inner_hull(Player.BLACK)
        self._hull_white = self._compute_inner_hull(Player.WHITE)

    def _draw_territory_hulls(self):
        """Render cached inner-convex-hull territory overlays with 50 % transparency."""
        overlay = pygame.Surface((self.SCREEN_WIDTH, self.SCREEN_HEIGHT), pygame.SRCALPHA)

        black_coords, black_area = self._hull_black
        white_coords, white_area = self._hull_white

        for coords, fill_col, border_col in [
            (black_coords, (30,  80, 255, 128), (0,   0, 200, 220)),
            (white_coords, (255, 50, 50,  128), (200, 0,   0, 220)),
        ]:
            if coords and len(coords) >= 3:
                pygame.draw.polygon(overlay, fill_col, coords)
                pygame.draw.polygon(overlay, border_col, coords, 2)

        self.screen.blit(overlay, (0, 0))

        # Area labels: Blue on left, Red on right
        if black_coords:
            label = self._font_sm.render(f"Blue territory: {black_area:.1f} △", True, (0, 0, 200))
            self.screen.blit(label, (10, self.SCREEN_HEIGHT - 30))
        if white_coords:
            label = self._font_sm.render(f"Red territory:  {white_area:.1f} △", True, (200, 0, 0))
            lw = label.get_width()
            self.screen.blit(label, (self.SCREEN_WIDTH - lw - 10, self.SCREEN_HEIGHT - 30))

    def _get_adjacent_positions(self, pos: Tuple[int, int]) -> List[Tuple[int, int]]:
        """Get all adjacent positions to a given position"""
        x, y = pos
        adjacent = []
        
        # Define the 6 possible adjacent positions for triangular grid
        possible_adjacent = [
            (x, y + 1),    # Down
            (x, y - 1),    # Up
            (x - 1, y),    # Left
            (x + 1, y),    # Right
            (x - 1, y + 1), # Down-left
            (x + 1, y - 1)  # Up-right
        ]
        
        # Filter to only include valid grid positions
        for adj_pos in possible_adjacent:
            if adj_pos in self.grid:
                adjacent.append(adj_pos)
        
        return adjacent
    
    def _check_three_point_limitation(self, new_pos: Tuple[int, int], player: Player) -> bool:
        """Check if adding a new node would violate the three-point limitation"""
        current_nodes = self._get_player_nodes(player)
        
        # Get adjacent positions to the new node
        new_adjacent_positions = self._get_adjacent_positions(new_pos)
        new_adjacent_nodes = [pos for pos in new_adjacent_positions if pos in current_nodes]
        
        # Check case 1: new node is adjacent to 2 or more existing nodes
        if len(new_adjacent_nodes) >= 2:
            return False
        
        # Check case 2: any existing node that's adjacent to the new node
        # is also adjacent to another existing node
        for adjacent_node in new_adjacent_nodes:
            adjacent_to_existing = self._get_adjacent_positions(adjacent_node)
            adjacent_existing_nodes = [pos for pos in adjacent_to_existing if pos in current_nodes]
            
            # If this existing node has another adjacent existing node, it violates the rule
            if len(adjacent_existing_nodes) >= 1:
                return False
        
        return True
    
    def _is_in_protection_zone(self, pos: Tuple[int, int], player: Player) -> bool:
        """Check if a position is in the opponent's protection zone"""
        # Get opponent's initial position
        opponent_initial = (8, 0) if player == Player.BLACK else (0, 0)
        
        # Get adjacent positions to opponent's initial node
        protected_positions = self._get_adjacent_positions(opponent_initial)
        
        return pos in protected_positions
    
    def _is_connected_to_initial(self, pos: Tuple[int, int], player: Player) -> bool:
        """Check if a position is connected to the initial node through a path"""
        initial_pos = (0, 0) if player == Player.BLACK else (8, 0)
        visited = set()
        stack = [initial_pos]
        
        player_node = PointState.BLACK_NODE if player == Player.BLACK else PointState.WHITE_NODE
        player_line = PointState.BLACK_LINE if player == Player.BLACK else PointState.WHITE_LINE
        
        while stack:
            current = stack.pop()
            if current == pos:
                return True
            
            if current in visited:
                continue
            visited.add(current)
            
            # Find all connected points
            for grid_pos, state in self.grid.items():
                if state in [player_node, player_line] and grid_pos not in visited:
                    if self._can_connect_with_blocking(current, grid_pos, player):
                        # Check if the line is not broken
                        line_points = self._get_line_points(current, grid_pos)
                        line_intact = True
                        for point in line_points:
                            if self.grid[point] not in [player_node, player_line]:
                                line_intact = False
                                break
                        if line_intact:
                            stack.append(grid_pos)
        
        return False
    
    def _restore_connections_after_removal(self, removed_positions: List[Tuple[int, int]], attacking_player: Player):
        """Restore connections for the attacking player after opponent nodes are removed"""
        attacking_nodes = self._get_player_nodes(attacking_player)
        attacking_line_state = PointState.BLACK_LINE if attacking_player == Player.BLACK else PointState.WHITE_LINE
        attacking_node_state = PointState.BLACK_NODE if attacking_player == Player.BLACK else PointState.WHITE_NODE
        
        # For each pair of attacking player's nodes, check if they can now connect
        for i in range(len(attacking_nodes)):
            for j in range(i + 1, len(attacking_nodes)):
                node1, node2 = attacking_nodes[i], attacking_nodes[j]
                
                if self._can_connect(node1, node2):
                    line_points = self._get_line_points(node1, node2)
                    
                    # Check if any of the removed positions are on this line
                    line_intersects_removal = any(pos in line_points for pos in removed_positions)
                    
                    if line_intersects_removal:
                        # Check if the line can now be established (no blocking)
                        can_establish = True
                        for point in line_points:
                            if point != node1 and point != node2:
                                current_state = self.grid[point]
                                # Check if there's still a blocking opponent piece
                                if current_state in [PointState.WHITE_NODE, PointState.WHITE_LINE, PointState.BLACK_NODE, PointState.BLACK_LINE]:
                                    if attacking_player == Player.BLACK and current_state in [PointState.WHITE_NODE, PointState.WHITE_LINE]:
                                        can_establish = False
                                        break
                                    elif attacking_player == Player.WHITE and current_state in [PointState.BLACK_NODE, PointState.BLACK_LINE]:
                                        can_establish = False
                                        break
                        
                        # If the line can be established, mark the points
                        if can_establish:
                            for point in line_points:
                                if point == node1 or point == node2:
                                    self.grid[point] = attacking_node_state
                                elif self.grid[point] == PointState.EMPTY:
                                    self.grid[point] = attacking_line_state
    
    def _remove_disconnected_components(self, player: Player):
        """Remove nodes and lines that are no longer connected to the initial node"""
        player_nodes = self._get_player_nodes(player)
        player_lines = self._get_player_lines(player)
        
        # Check each node for connectivity
        nodes_to_remove = []
        for node in player_nodes:
            if node != ((0, 0) if player == Player.BLACK else (8, 0)):  # Don't remove initial node
                if not self._is_connected_to_initial(node, player):
                    nodes_to_remove.append(node)
        
        # Remove disconnected nodes and their connected lines
        removed_positions = []
        for node in nodes_to_remove:
            self.grid[node] = PointState.EMPTY
            removed_positions.append(node)
            
            # Remove all lines connected to this node
            remaining_nodes = [n for n in player_nodes if n not in nodes_to_remove]
            for other_node in remaining_nodes:
                if self._can_connect(node, other_node):
                    line_points = self._get_line_points(node, other_node)
                    for point in line_points:
                        if point != node and point != other_node and self.grid[point] == (PointState.BLACK_LINE if player == Player.BLACK else PointState.WHITE_LINE):
                            self.grid[point] = PointState.EMPTY
                            if point not in removed_positions:
                                removed_positions.append(point)
        
        # Remove remaining orphaned lines
        lines_to_remove = []
        current_player_lines = self._get_player_lines(player)  # Get updated lines after node removal
        valid_nodes = [n for n in player_nodes if n not in nodes_to_remove]
        
        for line_pos in current_player_lines:
            connected_to_valid_nodes = 0
            for node in valid_nodes:
                if self._can_connect(line_pos, node):
                    line_points = self._get_line_points(line_pos, node)
                    if line_pos in line_points:
                        connected_to_valid_nodes += 1
                        if connected_to_valid_nodes >= 2:  # Connected to at least 2 nodes
                            break
            
            if connected_to_valid_nodes < 2:
                lines_to_remove.append(line_pos)
        
        for line_pos in lines_to_remove:
            self.grid[line_pos] = PointState.EMPTY
            if line_pos not in removed_positions:
                removed_positions.append(line_pos)
        
        # Restore connections for the opponent (attacking player)
        if removed_positions:
            attacking_player = Player.BLACK if player == Player.WHITE else Player.WHITE
            self._restore_connections_after_removal(removed_positions, attacking_player)
    
    def _handle_blocking_attack(self, new_pos: Tuple[int, int], player: Player, original_state: PointState):
        """Handle an attack: a new node placed on opponent's line.

        Step 1 – Delete line points: from the attack point, sweep each direction.
                 Skip the direction if the adjacent point is not an opponent line.
                 Otherwise delete consecutive opponent line points until hitting an
                 opponent NODE (preserve the node, stop there).
        Step 2 – Delete isolated nodes: remove opponent nodes that can no longer
                 reach their starting point via any path.
        Step 3 – Clean up orphaned lines: delete line segments whose BOTH endpoint
                 nodes were removed in step 2.
        Step 4 – Restore connections: re-establish valid direct connections for
                 both the attacker and the defender.
        """
        opponent = Player.WHITE if player == Player.BLACK else Player.BLACK
        opp_line = PointState.WHITE_LINE if player == Player.BLACK else PointState.BLACK_LINE

        if original_state != opp_line:
            return

        # ── Step 1 ──────────────────────────────────────────────────────────────
        # Sweep each direction. Only delete collected line cells if the sweep
        # terminates at an opponent NODE — that confirms they belong to the same
        # line segment being attacked. If the sweep ends at OOB/empty the cells
        # belong to a perpendicular segment and must NOT be deleted here.
        x0, y0 = new_pos
        opp_node_state = PointState.WHITE_NODE if player == Player.BLACK else PointState.BLACK_NODE
        directions = [(1, 0), (-1, 0), (0, 1), (0, -1), (1, -1), (-1, 1)]
        for dx, dy in directions:
            nx, ny = x0 + dx, y0 + dy
            if (nx, ny) not in self.grid or self.grid[(nx, ny)] != opp_line:
                continue  # no opponent line adjacent in this direction — skip
            cells_to_delete = []
            while (nx, ny) in self.grid and self.grid[(nx, ny)] == opp_line:
                cells_to_delete.append((nx, ny))
                nx += dx
                ny += dy
            # Only delete if sweep ended at an opponent node (same segment confirmed)
            if (nx, ny) in self.grid and self.grid[(nx, ny)] == opp_node_state:
                for cell in cells_to_delete:
                    self.grid[cell] = PointState.EMPTY

        # ── Step 2 ──────────────────────────────────────────────────────────────
        opp_start = (8, 0) if player == Player.BLACK else (0, 0)
        deleted_nodes: set = set()
        for node in self._get_player_nodes(opponent):
            if node != opp_start and not self._is_connected_to_initial(node, opponent):
                self.grid[node] = PointState.EMPTY
                deleted_nodes.add(node)

        # ── Step 3 ──────────────────────────────────────────────────────────────
        # Remove orphaned line points.
        # A line point is valid only if it lies on an intact segment between two
        # SURVIVING opponent nodes (all cells on that segment are still opp_node/opp_line).
        # This handles both the "both endpoints deleted" case and the "ray" case
        # (one endpoint deleted) without over-deleting lines still anchored to start.
        opp_node_state = PointState.WHITE_NODE if opponent == Player.WHITE else PointState.BLACK_NODE
        surviving_nodes = self._get_player_nodes(opponent)  # after Step 2

        for line_pt in list(self.grid.keys()):
            if self.grid[line_pt] != opp_line:
                continue
            protected = False
            for i in range(len(surviving_nodes)):
                if protected:
                    break
                for j in range(i + 1, len(surviving_nodes)):
                    n1, n2 = surviving_nodes[i], surviving_nodes[j]
                    if not self._can_connect(n1, n2):
                        continue
                    pts = self._get_line_points(n1, n2)
                    if line_pt not in pts:
                        continue
                    # Segment is intact if every cell on it is still opponent-owned
                    if all(self.grid[p] in (opp_node_state, opp_line) for p in pts):
                        protected = True
                        break
            if not protected:
                self.grid[line_pt] = PointState.EMPTY

        # ── Step 4 ──────────────────────────────────────────────────────────────
        self._reconnect_player_nodes(player)    # attacker may gain new connections
        self._reconnect_player_nodes(opponent)  # defender may regain connections after node removals
    
    def _reconnect_player_nodes(self, player: Player):
        """Re-establish connections between own nodes that became possible after an attack removed blocking pieces"""
        player_nodes = self._get_player_nodes(player)
        node_state = PointState.BLACK_NODE if player == Player.BLACK else PointState.WHITE_NODE
        line_state = PointState.BLACK_LINE if player == Player.BLACK else PointState.WHITE_LINE

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

    def _add_node(self, pos: Tuple[int, int]) -> bool:
        """Add a new node for the current player and handle auto-connection"""
        if pos not in self.grid:
            return False
        
        original_state = self.grid[pos]
        if original_state not in [PointState.EMPTY, PointState.WHITE_LINE, PointState.BLACK_LINE]:
            return False
        
        # Check protection zone - cannot place nodes in opponent's protection zone
        if self._is_in_protection_zone(pos, self.current_player):
            return False
        
        # Check three-point limitation (skip if attacking by placing on opponent line)
        opponent_line = PointState.WHITE_LINE if self.current_player == Player.BLACK else PointState.BLACK_LINE
        is_attacking_move = (original_state == opponent_line)
        
        if not is_attacking_move and not self._check_three_point_limitation(pos, self.current_player):
            return False
        
        # Set the new node
        node_state = PointState.BLACK_NODE if self.current_player == Player.BLACK else PointState.WHITE_NODE
        line_state = PointState.BLACK_LINE if self.current_player == Player.BLACK else PointState.WHITE_LINE
        
        self.grid[pos] = node_state
        
        # Find all existing nodes of the current player
        existing_nodes = self._get_player_nodes(self.current_player)
        existing_nodes.remove(pos)  # Remove the newly added node
        
        # Check for connections using blocking-aware connection check
        connected = False
        for node_pos in existing_nodes:
            if self._can_connect_with_blocking(pos, node_pos, self.current_player):
                connected = True
                # Mark all points on the line as player's line
                line_points = self._get_line_points(pos, node_pos)
                for point in line_points:
                    if self.grid[point] == PointState.EMPTY or self.grid[point] == line_state:
                        self.grid[point] = line_state
                    # Keep nodes as nodes
                    if point == pos or point == node_pos:
                        self.grid[point] = node_state
        
        if not connected:
            # Revert the node placement if no connection was made
            self.grid[pos] = original_state
            return False
        
        # Handle blocking and elimination after successful placement
        self._handle_blocking_attack(pos, self.current_player, original_state)

        return True
    
    def _switch_player(self):
        """Switch to the other player"""
        self.current_player = Player.WHITE if self.current_player == Player.BLACK else Player.BLACK

    def _has_valid_moves(self, player: Player) -> bool:
        """Return True if the given player has at least one legal move."""
        opponent_line = PointState.WHITE_LINE if player == Player.BLACK else PointState.BLACK_LINE
        existing_nodes = self._get_player_nodes(player)
        for pos, state in self.grid.items():
            if state not in [PointState.EMPTY, PointState.WHITE_LINE, PointState.BLACK_LINE]:
                continue
            if self._is_in_protection_zone(pos, player):
                continue
            is_attacking = (state == opponent_line)
            if not is_attacking and not self._check_three_point_limitation(pos, player):
                continue
            for node_pos in existing_nodes:
                if node_pos != pos and self._can_connect_with_blocking(pos, node_pos, player):
                    return True
        return False

    def _check_and_auto_skip(self):
        """If the current player has no valid moves, auto-skip them (up to game end)."""
        if self.game_over:
            return
        if not self._has_valid_moves(self.current_player):
            self.consecutive_skips += 1
            if self.consecutive_skips >= 2:
                self.game_over = True
            else:
                self._switch_player()
                self._check_and_auto_skip()  # check the newly active player too

    def handle_skip(self):
        """Current player skips their turn. If both players skip consecutively, game ends."""
        if self.game_over:
            return
        self.consecutive_skips += 1
        if self.consecutive_skips >= 2:
            self.game_over = True
        else:
            self._switch_player()
            self._check_and_auto_skip()
        self._update_hulls()

    def handle_click(self, pos: Tuple[int, int]):
        """Handle mouse click at screen position"""
        if self.game_over:
            return

        # Check skip button
        if self.skip_button_rect.collidepoint(pos[0], pos[1]):
            self.handle_skip()
            return

        grid_pos = self._get_grid_pos(pos[0], pos[1])
        if grid_pos and self._add_node(grid_pos):
            self.consecutive_skips = 0  # Reset skip counter on a real move
            self._switch_player()
            self._check_and_auto_skip()
            self._update_hulls()
    
    def draw(self):
        """Draw the game state"""
        self.screen.fill(self.WHITE)

        # Draw territory hulls behind everything else
        self._draw_territory_hulls()

        # Draw connections as direct lines between node pairs.
        # Iterating adjacent grid points would create spurious triangles at corners,
        # so instead we draw one segment per connected node pair with no intermediate nodes.
        for player_enum in [Player.BLACK, Player.WHITE]:
            p_nodes = self._get_player_nodes(player_enum)
            node_st = PointState.BLACK_NODE if player_enum == Player.BLACK else PointState.WHITE_NODE
            line_st = PointState.BLACK_LINE if player_enum == Player.BLACK else PointState.WHITE_LINE
            owned = [node_st, line_st]
            seg_color = self.BLUE if player_enum == Player.BLACK else self.RED

            for i in range(len(p_nodes)):
                for j in range(i + 1, len(p_nodes)):
                    n1, n2 = p_nodes[i], p_nodes[j]
                    if not self._can_connect(n1, n2):
                        continue
                    pts = self._get_line_points(n1, n2)
                    # Only draw if every point on the segment is owned by this player
                    if not all(self.grid[p] in owned for p in pts):
                        continue
                    # Skip if there's an intermediate node — that shorter pair will draw it
                    if any(self.grid[p] == node_st for p in pts if p != n1 and p != n2):
                        continue
                    pygame.draw.line(self.screen, seg_color,
                                     self._get_screen_pos(*n1),
                                     self._get_screen_pos(*n2),
                                     self.LINE_WIDTH)

        # Draw grid points
        for (x, y), state in self.grid.items():
            screen_x, screen_y = self._get_screen_pos(x, y)
            
            # Draw point based on state
            if state == PointState.EMPTY:
                pygame.draw.circle(self.screen, self.LIGHT_GRAY, (screen_x, screen_y), self.POINT_RADIUS)
                pygame.draw.circle(self.screen, self.GRAY, (screen_x, screen_y), self.POINT_RADIUS, 2)
            elif state == PointState.BLACK_NODE:
                pygame.draw.circle(self.screen, self.BLUE, (screen_x, screen_y), self.POINT_RADIUS)
            elif state == PointState.BLACK_LINE:
                pygame.draw.circle(self.screen, self.LIGHT_GRAY, (screen_x, screen_y), self.POINT_RADIUS // 2)
                pygame.draw.circle(self.screen, self.BLUE, (screen_x, screen_y), self.POINT_RADIUS // 2, 2)
            elif state == PointState.WHITE_NODE:
                pygame.draw.circle(self.screen, self.RED, (screen_x, screen_y), self.POINT_RADIUS)
            elif state == PointState.WHITE_LINE:
                pygame.draw.circle(self.screen, self.LIGHT_GRAY, (screen_x, screen_y), self.POINT_RADIUS // 2)
                pygame.draw.circle(self.screen, self.RED, (screen_x, screen_y), self.POINT_RADIUS // 2, 2)
        
        # Draw current player indicator
        player_text = "Blue's Turn" if self.current_player == Player.BLACK else "Red's Turn"
        color = self.BLUE if self.current_player == Player.BLACK else self.RED
        text_surface = self._font_lg.render(player_text, True, color)
        self.screen.blit(text_surface, (10, 10))

        # Draw skip button
        pygame.draw.rect(self.screen, self.GRAY, self.skip_button_rect, border_radius=6)
        pygame.draw.rect(self.screen, self.BLACK, self.skip_button_rect, 2, border_radius=6)
        skip_label = self._font_lg.render("Skip", True, self.WHITE)
        label_rect = skip_label.get_rect(center=self.skip_button_rect.center)
        self.screen.blit(skip_label, label_rect)

        # Draw game over overlay
        if self.game_over:
            overlay = pygame.Surface((self.SCREEN_WIDTH, self.SCREEN_HEIGHT), pygame.SRCALPHA)
            overlay.fill((0, 0, 0, 160))
            self.screen.blit(overlay, (0, 0))

            black_area = self._hull_black[1]
            white_area = self._hull_white[1]
            if black_area > white_area:
                winner_text, winner_color = "Blue Wins!", (120, 160, 255)
            elif white_area > black_area:
                winner_text, winner_color = "Red Wins!",  (255, 120, 120)
            else:
                winner_text, winner_color = "Draw!",      (200, 200, 200)

            over_text = self._font_xl.render("Game Over", True, self.WHITE)
            over_rect = over_text.get_rect(center=(self.SCREEN_WIDTH // 2, self.SCREEN_HEIGHT // 2 - 55))
            self.screen.blit(over_text, over_rect)

            winner_surf = self._font_xl.render(winner_text, True, winner_color)
            winner_rect = winner_surf.get_rect(center=(self.SCREEN_WIDTH // 2, self.SCREEN_HEIGHT // 2 + 10))
            self.screen.blit(winner_surf, winner_rect)

            area_text = f"Blue {black_area:.1f} △   vs   Red {white_area:.1f} △"
            area_surf = self._font_md.render(area_text, True, self.LIGHT_GRAY)
            area_rect = area_surf.get_rect(center=(self.SCREEN_WIDTH // 2, self.SCREEN_HEIGHT // 2 + 62))
            self.screen.blit(area_surf, area_rect)

        pygame.display.flip()
    
    def run(self):
        """Main game loop"""
        running = True
        while running:
            for event in pygame.event.get():
                if event.type == pygame.QUIT:
                    running = False
                elif event.type == pygame.MOUSEBUTTONDOWN:
                    if event.button == 1:  # Left mouse button
                        self.handle_click(event.pos)
            
            self.draw()
            self.clock.tick(60)
        
        pygame.quit()
        sys.exit()

if __name__ == "__main__":
    game = TriangularGame()
    game.run()

