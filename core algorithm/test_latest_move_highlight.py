"""Latest-turn display regressions using the real rules and a headless pygame stub.

Run: python "core algorithm/test_latest_move_highlight.py"
An optional source path checks another synchronized triangular_game.py copy.
"""

import importlib.util
from pathlib import Path
import sys
import types


class _Surface:
    def __init__(self, *args):
        pass

    def fill(self, *args):
        pass

    def blit(self, *args):
        pass

    def get_rect(self, **kwargs):
        return kwargs

    def get_width(self):
        return 100


class _Rect:
    def __init__(self, x, y, width, height):
        self.x, self.y, self.width, self.height = x, y, width, height
        self.center = (x + width // 2, y + height // 2)

    def collidepoint(self, *point):
        x, y = point[0] if len(point) == 1 else point
        return self.x <= x < self.x + self.width and self.y <= y < self.y + self.height


class _Font:
    def render(self, *args):
        return _Surface()


class _Draw:
    def __init__(self):
        self.circles = []

    def circle(self, screen, color, center, radius, width=0):
        self.circles.append((color, center, radius, width))

    def line(self, *args):
        pass

    def rect(self, *args, **kwargs):
        pass

    def polygon(self, *args):
        pass


DRAW = _Draw()
pygame = types.ModuleType("pygame")
pygame.init = lambda: None
pygame.SRCALPHA = 1
pygame.Surface = _Surface
pygame.Rect = _Rect
pygame.draw = DRAW
pygame.display = types.SimpleNamespace(
    set_mode=lambda *args: _Surface(), set_caption=lambda *args: None,
    flip=lambda: None,
)
pygame.font = types.SimpleNamespace(Font=lambda *args: _Font())
pygame.time = types.SimpleNamespace(Clock=lambda: None)
sys.modules["pygame"] = pygame

source = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).with_name("triangular_game.py")
spec = importlib.util.spec_from_file_location("latest_move_target", source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
Game, Player, State = module.TriangularGame, module.Player, module.PointState


def place(game, point):
    player = game.current_player
    game.handle_click(game._get_screen_pos(*point))
    assert game.last_moves[player] == point, (player, point, game.last_moves)


def marked_centers(game, full_draw=False):
    DRAW.circles.clear()
    if full_draw:
        game.draw()
    else:
        game._draw_latest_moves()
    return {center for color, center, radius, width in DRAW.circles if color == (255, 193, 7)}


game = Game()
assert game.last_moves == {Player.BLACK: None, Player.WHITE: None}
assert marked_centers(game, full_draw=True) == set(), "Starting nodes are not placed moves"

place(game, (2, 0))
place(game, (6, 0))
assert marked_centers(game, full_draw=True) == {
    game._get_screen_pos(2, 0), game._get_screen_pos(6, 0),
}, "Each side keeps its own latest node"

place(game, (0, 2))
assert marked_centers(game) == {
    game._get_screen_pos(0, 2), game._get_screen_pos(6, 0),
}, "A new move replaces only that side's marker"

before = dict(game.last_moves)
before_grid = dict(game.grid)
before_black_edges, before_white_edges = set(game.black_edges), set(game.white_edges)
game.handle_click(game._get_screen_pos(0, 0))
assert game.last_moves == before and game.grid == before_grid, "Rejected moves keep the markers"
assert game._is_legal_move((4, 0), Player.WHITE)
assert game.last_moves == before, "Legality probes do not become displayed moves"

# Reject a real otherwise-legal move because its resulting state is already known.
assert game._add_node((4, 0))
repeated_hash = game._compute_state_hash(Player.BLACK)
game.grid = dict(before_grid)
game.black_edges, game.white_edges = set(before_black_edges), set(before_white_edges)
game.history_hashes.add(repeated_hash)
game.handle_click(game._get_screen_pos(4, 0))
assert game.last_moves == before and game.grid == before_grid, "Superko rejection keeps the markers"

game.handle_skip()  # White passes while Black's latest node remains.
assert game.last_moves == {Player.BLACK: (0, 2), Player.WHITE: None}
assert marked_centers(game) == {game._get_screen_pos(0, 2)}
game.handle_skip()
assert game.game_over and marked_centers(game) == set(), "Consecutive passes clear both markers"

automatic = Game()
place(automatic, (2, 0))
place(automatic, (6, 0))
automatic._has_valid_moves = lambda player: player == Player.WHITE
automatic._check_and_auto_skip()
assert automatic.last_moves == {Player.BLACK: None, Player.WHITE: (6, 0)}
assert automatic.current_player == Player.WHITE, "Automatic passes clear the passing side"

removed = Game()
place(removed, (2, 0))
place(removed, (6, 0))
for replacement in (State.EMPTY, State.BLACK_LINE, State.WHITE_NODE):
    removed.grid[(2, 0)] = replacement
    assert marked_centers(removed) == {removed._get_screen_pos(6, 0)}, "Removed/replaced nodes are not marked"

state_hash = removed._compute_state_hash(removed.current_player)
removed.last_moves = {Player.BLACK: None, Player.WHITE: None}
assert removed._compute_state_hash(removed.current_player) == state_hash, "Display markers do not change rules hashes"
removed.__init__()
assert marked_centers(removed) == set(), "Starting a fresh game clears previous markers"

print(f"PASS latest move highlights: {source.resolve()}")
