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
        
        # Initialize grid points
        self._init_grid()
        
        # Set initial positions
        self.grid[(0, 0)] = PointState.BLACK_NODE
        self.grid[(8, 0)] = PointState.WHITE_NODE
        
        # Game clock
        self.clock = pygame.time.Clock()
        
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
        """Handle blocking and elimination when a new node is placed"""
        opponent = Player.WHITE if player == Player.BLACK else Player.BLACK
        opponent_node = PointState.WHITE_NODE if player == Player.BLACK else PointState.BLACK_NODE
        opponent_line = PointState.WHITE_LINE if player == Player.BLACK else PointState.BLACK_LINE
        
        # If the new node was placed on an opponent line, remove segments between white nodes
        if original_state == opponent_line:
            # Find all opponent nodes
            opponent_nodes = [pos for pos, state in self.grid.items() if state == opponent_node]
            
            # Find pairs of opponent nodes that form a line through the new position
            for i in range(len(opponent_nodes)):
                for j in range(i + 1, len(opponent_nodes)):
                    node1, node2 = opponent_nodes[i], opponent_nodes[j]
                    if self._can_connect(node1, node2):
                        line_points = self._get_line_points(node1, node2)
                        if new_pos in line_points:
                            # Only remove the line segment between these two specific nodes
                            for point in line_points:
                                if point != node1 and point != node2 and self.grid[point] == opponent_line:
                                    self.grid[point] = PointState.EMPTY
        
        # Remove disconnected components
        self._remove_disconnected_components(opponent)
    
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
    
    def handle_click(self, pos: Tuple[int, int]):
        """Handle mouse click at screen position"""
        if self.game_over:
            return
        
        grid_pos = self._get_grid_pos(pos[0], pos[1])
        if grid_pos and self._add_node(grid_pos):
            self._switch_player()
    
    def draw(self):
        """Draw the game state"""
        self.screen.fill(self.WHITE)
        
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
        font = pygame.font.Font(None, 36)
        player_text = "Blue's Turn" if self.current_player == Player.BLACK else "Red's Turn"
        color = self.BLUE if self.current_player == Player.BLACK else self.RED
        text_surface = font.render(player_text, True, color)
        self.screen.blit(text_surface, (10, 10))
        
        
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