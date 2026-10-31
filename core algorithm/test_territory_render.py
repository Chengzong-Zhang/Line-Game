"""Fixed territory-v3 scoring/rendering probes that do not require pygame.

Pass one or more triangular_game.py paths to check another synchronized copy.
With no arguments the sibling triangular_game.py is checked.
"""

from __future__ import annotations

import argparse
import importlib.util
import sys
import types
from collections import Counter
from pathlib import Path


class _FakeSurface:
    def __init__(self, size=None, flags=0):
        self.size = size
        self.flags = flags
        self.blits = []

    def blit(self, surface, position):
        self.blits.append((surface, position))


class _FakeLabel:
    def __init__(self, text):
        self.text = text

    def get_width(self):
        return len(self.text) * 8


class _FakeFont:
    def __init__(self):
        self.texts = []

    def render(self, text, antialias, color):
        self.texts.append(text)
        return _FakeLabel(text)


class _FakeDraw:
    def __init__(self):
        self.polygon_calls = []

    def polygon(self, surface, color, points, width=0):
        self.polygon_calls.append((surface, color, tuple(points), width))


FAKE_DRAW = _FakeDraw()
FAKE_PYGAME = types.ModuleType("pygame")
FAKE_PYGAME.SRCALPHA = 1
FAKE_PYGAME.Surface = _FakeSurface
FAKE_PYGAME.draw = FAKE_DRAW
sys.modules["pygame"] = FAKE_PYGAME


RING_A = {(2, 3), (2, 1), (1, 2), (3, 2), (1, 3), (3, 1)}
CENTER_A = (2, 2)
RING_B = {(5, 2), (5, 0), (4, 1), (6, 1), (4, 2), (6, 0)}
CENTER_B = (5, 1)
OPEN_CHAIN = {(1, 1), (2, 1), (3, 1)}


def _load_source(source: Path, index: int):
    module_name = f"territory_render_target_{index}"
    spec = importlib.util.spec_from_file_location(module_name, source)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load {source}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _new_game(module):
    game = module.TriangularGame.__new__(module.TriangularGame)
    game.GRID_SIZE = 9
    game.SCREEN_WIDTH = 800
    game.SCREEN_HEIGHT = 600
    game.grid_start_x = 100
    game.grid_start_y = 100
    game.cell_size = 50
    game.grid = {
        (x, y): module.PointState.EMPTY
        for y in range(game.GRID_SIZE)
        for x in range(game.GRID_SIZE - y)
    }
    game.black_edges = set()
    game.white_edges = set()
    game._hull_black = (None, 0.0)
    game._hull_white = (None, 0.0)
    game._territory_black = set()
    game._territory_white = set()
    game.screen = _FakeSurface((game.SCREEN_WIDTH, game.SCREEN_HEIGHT))
    game._font_sm = _FakeFont()
    return game


def _set_position(module, game, black_points, white_points=()):
    for point in game.grid:
        game.grid[point] = module.PointState.EMPTY
    for point in black_points:
        game.grid[point] = module.PointState.BLACK_LINE
    for point in white_points:
        game.grid[point] = module.PointState.WHITE_NODE


def _assert_position(module, black_points, white_points, expected_black):
    game = _new_game(module)
    _set_position(module, game, black_points, white_points)
    actual = game._compute_owned_wall_points(set(black_points), set(white_points))
    assert actual == expected_black, (actual, expected_black)
    assert game._compute_owned_wall_area(set(black_points), set(white_points)) == len(expected_black)
    game._update_hulls()
    assert game._territory_black == expected_black
    assert len(game._hull_black) == 2, "_compute_inner_hull return compatibility changed"
    assert game._hull_black[1] == len(expected_black)
    return game


def _assert_render_matches(game, expected_black, expected_white):
    FAKE_DRAW.polygon_calls.clear()
    game.screen.blits.clear()
    game._font_sm.texts.clear()
    game._draw_territory_hulls()

    fills_by_color = {
        color: Counter(
            points
            for _surface, call_color, points, width in FAKE_DRAW.polygon_calls
            if width == 0 and call_color == color
        )
        for color in ((30, 80, 255, 88), (255, 50, 50, 88))
    }
    assert fills_by_color[(30, 80, 255, 88)] == Counter(
        tuple(game._get_territory_tile(point)) for point in expected_black
    )
    assert fills_by_color[(255, 50, 50, 88)] == Counter(
        tuple(game._get_territory_tile(point)) for point in expected_white
    )
    assert game._font_sm.texts[0] == f"Blue territory: {len(expected_black)} pts"
    assert game._font_sm.texts[1] == f"Red territory:  {len(expected_white)} pts"
    assert len(game.screen.blits) == 3, "overlay and both score labels must be blitted"


def verify_source(source: Path, index: int):
    module = _load_source(source, index)

    donut = _assert_position(module, RING_A, set(), RING_A | {CENTER_A})
    assert donut._hull_black[1] == 7

    enemy_in_hole = _assert_position(module, RING_A, {CENTER_A}, RING_A)
    assert CENTER_A not in enemy_in_hole._territory_black

    two_pockets = RING_A | RING_B | {CENTER_A, CENTER_B}
    multi = _assert_position(module, RING_A | RING_B, set(), two_pockets)
    assert {CENTER_A, CENTER_B}.issubset(multi._territory_black)
    assert multi._hull_black[1] == 14

    chain = _assert_position(module, OPEN_CHAIN, set(), OPEN_CHAIN)
    assert chain._hull_black[1] == 3

    _assert_render_matches(donut, RING_A | {CENTER_A}, set())
    _assert_render_matches(enemy_in_hole, RING_A, {CENTER_A})
    _assert_render_matches(multi, two_pockets, set())
    _assert_render_matches(chain, OPEN_CHAIN, set())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("sources", nargs="*", type=Path)
    args = parser.parse_args()
    sources = args.sources or [Path(__file__).with_name("triangular_game.py")]
    for index, source in enumerate(sources):
        resolved = source.resolve()
        if not resolved.is_file():
            parser.error(f"source does not exist: {resolved}")
        verify_source(resolved, index)
        print(f"PASS territory render fixtures: {resolved}")


if __name__ == "__main__":
    main()
