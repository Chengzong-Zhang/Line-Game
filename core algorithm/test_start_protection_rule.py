"""Regression tests for the versioned two-player start protection rule.

Run: python "core algorithm/test_start_protection_rule.py"
"""

import importlib.util
from pathlib import Path
import sys
import types


class _Surface:
    pass


class _Rect:
    def __init__(self, *args):
        self.args = args


class _Font:
    pass


pygame = types.ModuleType("pygame")
pygame.init = lambda: None
pygame.display = types.SimpleNamespace(
    set_mode=lambda *args: _Surface(),
    set_caption=lambda *args: None,
)
pygame.font = types.SimpleNamespace(Font=lambda *args: _Font())
pygame.time = types.SimpleNamespace(Clock=lambda: None)
pygame.Rect = _Rect
sys.modules["pygame"] = pygame

source = Path(__file__).with_name("triangular_game.py")
spec = importlib.util.spec_from_file_location("start_protection_target", source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

Game = module.TriangularGame
Player = module.Player
SYMMETRIC = module.PROTECTION_RULE_SYMMETRIC
FIRST_UNPROTECTED = module.PROTECTION_RULE_DUEL_FIRST_UNPROTECTED


# New games remember both pieces of rule state. BLACK starts by default, so
# BLACK's root is open to WHITE while WHITE's root remains protected.
game = Game()
assert game.start_player == Player.BLACK
assert game.current_player == Player.BLACK
assert game.protection_rule == FIRST_UNPROTECTED
assert not game._is_in_protection_zone((1, 0), Player.WHITE)
assert game._is_legal_move((1, 0), Player.WHITE)
assert game._is_in_protection_zone((7, 0), Player.BLACK)
assert not game._is_legal_move((7, 0), Player.BLACK)


# Old saves and replays can request the historical symmetric rule explicitly.
legacy = Game(protection_rule=SYMMETRIC)
assert legacy._is_in_protection_zone((1, 0), Player.WHITE)
assert legacy._is_in_protection_zone((7, 0), Player.BLACK)
assert not legacy._is_legal_move((1, 0), Player.WHITE)
assert not legacy._is_legal_move((7, 0), Player.BLACK)


# The exemption follows the actual first player, rather than a hard-coded
# colour. When WHITE starts, WHITE's root is open and BLACK's root is guarded.
white_starts = Game(start_player=Player.WHITE)
assert white_starts.start_player == Player.WHITE
assert white_starts.current_player == Player.WHITE
assert not white_starts._is_in_protection_zone((7, 0), Player.BLACK)
assert white_starts._is_legal_move((7, 0), Player.BLACK)
assert white_starts._is_in_protection_zone((1, 0), Player.WHITE)
assert not white_starts._is_legal_move((1, 0), Player.WHITE)
assert white_starts._compute_state_hash(Player.WHITE) in white_starts.history_hashes
assert white_starts._compute_state_hash(Player.BLACK) not in white_starts.history_hashes


try:
    Game(start_player="BLACK")
except TypeError:
    pass
else:
    raise AssertionError("Non-Player start_player must be rejected")

try:
    Game(protection_rule="unknown-rule")
except ValueError:
    pass
else:
    raise AssertionError("Unknown protection_rule must be rejected")


print("PASS versioned two-player start protection")
