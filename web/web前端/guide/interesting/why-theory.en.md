# Theory.md

## Abstract

This document formalizes the triangular territory game as a finite, deterministic, two-player zero-sum graph game. Its theoretical value is not merely that the board can be enlarged, nor that state counts can be inflated. The interesting point is that a compact rule set creates three hard structures at once: long-range visibility edges, deletion by base connectivity, and historical path constraints introduced by Superko. Position evaluation is therefore not determined by local point count, but by bridges, articulation points, maximal connected components, and zugzwang-like positions.

The most important scale result is this. A triangular lattice of side length $n$ has only

$$
V(n)=\frac{n(n+1)}{2}=\Theta(n^2)
$$

physical lattice points, but the collinear visibility rule allows

$$
E(n)=\frac{n^3-n}{2}=\Theta(n^3)
$$

potential long-range logical edges. The count is

$$
E(n)=3\sum_{k=1}^{n}\binom{k}{2}
=3\binom{n+1}{3}
=\frac{n^3-n}{2}
=\Theta(n^3).
$$

This is the main source of complexity: the position lives on a quadratic number of points, while tactical relations happen over a cubic-scale visibility edge set. A single move may cut a bridge and then delete a maximal connected component that no longer reaches its base. A player may also be forced to play a move that creates the next vulnerable line. This zugzwang structure means that "one more friendly move" is not automatically useful, and it breaks the naive intuition behind strategy stealing.

## State Space and Representation Space

The document deliberately separates semantic state space from representation space.

Semantic state space counts genuinely different game positions:

$$
S_{\mathrm{pos}}(n)\le 2\cdot 5^{V(n)}
=2^{\Theta(n^2)}.
$$

Representation space may also count explicit cached edges, line points, or historical summaries:

$$
S_{\mathrm{repr}}(n)
\le 2\cdot 5^{V(n)}3^{E(n)}
=2^{\Theta(n^3)}.
$$

These are not the same object. The latter can be much larger than the former, but it should not be used to claim that the game's intrinsic position count already exceeds some classical game.

## Superko

Superko should be understood as an augmented state

$$
(s,H),
$$

where $s$ is the current position and $H$ is the set of historical positions. Legal transitions satisfy

$$
(s,H)\to(s',H\cup\{s'\}),\qquad s'\notin H.
$$

The rank function

$$
\rho(s,H)=|H|
$$

strictly increases at every step. Therefore the DAG structure exists in the augmented transition graph, not in the naive position graph.

## Search Meaning

Two different metrics should not be conflated:

| Metric | Meaning |
|---|---|
| State space | The number of possible positions. |
| Game-tree complexity | The number of possible play paths. |
| Representation space | The number of possible implementation encodings, including caches. |

The game's distinctive complexity comes from using a quadratic geometric substrate to generate cubic-scale long-range logical relations, then turning those relations into search depth through bridges, articulation points, base connectivity, and repetition history.

## AI Consequence

CNNs are good at local texture. This game is valued by base connectivity, bridges, articulation points, and maximal connected components. A GNN is the more natural architecture because messages can flow along the same visibility graph that defines the rules.
