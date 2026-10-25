"""Exercise actual legacy Python scoring methods without starting Pygame."""
import ast
from collections import deque
import hashlib
import json
from pathlib import Path
from typing import List, Tuple

root = Path(__file__).resolve().parents[3]
source = root / 'core algorithm/triangular_game.py'
raw = source.read_bytes()
parsed = ast.parse(raw, filename=str(source))
game = next(node for node in parsed.body if isinstance(node, ast.ClassDef) and node.name == 'TriangularGame')
names = {'_get_covered_points', '_compute_owned_wall_area', '_get_adjacent_positions', '_has_boundary_cycle'}
methods = [node for node in game.body if isinstance(node, ast.FunctionDef) and node.name in names]
assert {node.name for node in methods} == names
probe = ast.Module(body=[ast.ClassDef(name='ScoreProbe', bases=[], keywords=[], body=methods, decorator_list=[])], type_ignores=[])
namespace = {'deque': deque, 'List': List, 'Tuple': Tuple}
exec(compile(ast.fix_missing_locations(probe), str(source), 'exec'), namespace)
instance = namespace['ScoreProbe']()
instance.GRID_SIZE = 9
instance.grid = {(x, y): None for y in range(9) for x in range(9-y)}
ring = {(4, 3), (2, 3), (3, 4), (3, 2), (4, 2), (2, 4)}
cases = [
    ('initial-owned-point', {(0, 0)}, set(), 1),
    ('open-line', {(0, 0), (1, 0), (2, 0)}, set(), 3),
    ('safe-pocket', ring, set(), 7),
    ('occupied-pocket', ring, {(3, 3)}, 6),
]
for name, friendly, enemy, expected in cases:
    assert instance._compute_owned_wall_area(friendly, enemy) == expected, name
assert instance._has_boundary_cycle([(0, 0), (1, 0), (2, 0), (1, 0), (0, 0)]) is False
print(json.dumps({'status': 'PASS_ACTUAL_PYTHON_FORMAL_SCORE_METHODS', 'checks': 5,
    'sourceSha256': hashlib.sha256(raw).hexdigest(), 'scores': {name: expected for name, _, _, expected in cases},
    'scope': 'AST-extracted actual methods only; legacy game movement and Pygame rendering are not verified'}))
