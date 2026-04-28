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

The game runs on a triangular lattice. The player sees nodes, lines, and territory; the code handles discrete coordinates, state enums, explicit edge sets, BFS connectivity, flood-fill coverage, historical position hashes, and a turn state machine.

Core implementation goals:

- Use discrete coordinates instead of screen geometry.
- Use explicit edge sets instead of visual lines.
- Use graph connectivity to decide survival and removal.
- Use flood fill to calculate enclosed territory.
- Use historical hashes to prevent repeated global positions.
- Keep the front end and back end aligned on the same rule model.

## Two Layers

The implementation works because it keeps two facts separate.

* The physical layer is `grid`: what each lattice point currently displays.
* The logical layer is `adj_list / edges`: which nodes are truly connected by visibility edges.

```python
# Physical layer: rendering and occupancy
grid: dict[tuple[int, int], PointState]

# Logical layer: graph connectivity
black_edges: set[frozenset[tuple[int, int]]]
white_edges: set[frozenset[tuple[int, int]]]

def is_connected_to_initial(pos, player):
    adj_list = build_adj_list(edges[player])
    return bfs(adj_list, start=initial[player], target=pos)
```

Rendering only needs the physical layer. Connectivity must query the logical layer. Attack resolution first changes physical facts, then cleans and rebuilds logical facts.

## Attack Resolution

A move placed on an enemy line point is not a simple cell overwrite. It triggers a deterministic graph rewrite:

```python
def handle_attack(pos, player):
    delete_enemy_line_cells_from(pos)
    alive = bfs_component_from_enemy_base(grid)
    remove_every_enemy_piece_not_in(alive)
    edges[enemy].clear()
    reconnect_player_nodes(player)
    reconnect_player_nodes(enemy)
```

The elegance is that `grid` records physical facts, `edges` records logical facts, and BFS answers one question: does this structure still connect to its base?

## Territory Calculation

Territory is not computed by floating-point geometry. It is computed by discrete flood fill:

```python
def covered_points(polygon):
    wall = set(polygon)
    water = flood_fill_from_board_boundary(blocked=wall)
    return all_grid_points - water
```

The engine also uses a wedge flood-fill optimization. When a candidate shortcut lies inside the current territory, it flood-fills only the replaced wedge once and updates candidate area with an integer formula. The back end keeps the same logic so that documentation and production rules do not drift apart.

## Why This Structure Matters

The game looks visual, but the rules are graph rules. Lines are not decorative strokes; they are supply routes. Territory is not a visual polygon; it is the complement of flood-filled outside space. Capturing is not eating a single piece; it is deleting every enemy component that can no longer reach its base.

That is why the implementation should continue to treat geometry as a display of graph state, not as the source of truth.
