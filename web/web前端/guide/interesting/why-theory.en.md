# Theory: Structure, History, and Search

This overview separates board structure, complete rule state, and AI search. Ordinary boards support 2–15 players and topology boards support 2–6; the active match still determines the rule version, starting roots, and board definition.

## 1. Where long-range connections come from

An ordinary triangular board of side length $n$ has

$$
V(n)=\frac{n(n+1)}{2}
$$

lattice points. Across the three grid axes, the number of all collinear endpoint pairs is

$$
Q(n)=3\sum_{k=1}^{n}\binom{k}{2}=\frac{n^3-n}{2}.
$$

For $n=15$, these counts are 120 points and 1680 potential pairs. This counts candidate relations. Blocking, crossings, roots, and occupancy constrain the actual logical edges. It proves neither a reachable-position count nor a game-tree size or complexity classification, and does not rank the difficulty of different games.

## 2. Why occupancy alone is insufficient

Complete state also records actual logical edges, the actor, rule version, turn order, starting/permanent roots, resignations, consecutive PASS actions, termination, and Superko history. Topology games additionally need the canonical board definition, seams, and definition hash. Identical occupancy can admit different actions when edges or history differ. Restoration, undo, and search must retain that information.

For a fixed finite board, encoding each point, candidate edge, and finite control field gives an upper bound on representation count. Arbitrary encodings need not be reachable, and representation count does not count complete history-bearing states. An upper bound is not a tight growth rate or evidence of playing strength.

## 3. Superko and PASS

Let $H$ be the registered set of rule-position hashes. Accepted placements must pass the active version's Superko check; registering a new position extends $H$. PASS does not add to $H$ as a placement does, and resignation needs separate treatment. It is therefore incorrect to claim that every action strictly increases $|H|$.

A termination argument must also account for rotation, surviving players, consecutive PASS actions, and resignations: a full consecutive round of PASS among the surviving players ends in scoring, and one surviving player ends the game. Repetition restrictions and these termination rules work together; monotonic history alone does not prove that every state transition forms a DAG.

## 4. Scoring, topology, and AI

Ordinary v3 scores discrete grid points: owned node/line points plus safe pockets that touch no real boundary and contain no enemy element. Display outlines do not decide the winner. Closed surfaces have no real outside boundary. Read chapter four of the mathematical article and chapter four of the Code article for topology scoring, seam paths, and multiple-root connectivity.

AI uses search, heuristics, or admitted models under finite budgets. Bridges, articulation points, and root connectivity are useful structural information. Graph models may be a research direction, but this does not prove model superiority, optimal play, or calibrated win probabilities. Candidate training and product admission remain separate.

The long formalization dated 2026-08-26 is preserved as a historical rule snapshot of the then-current two/three-player implementation. It does not cover later topology, multiple roots, or expanded player counts; see guide/interesting/why-theory.20260826.en.md. Use the mathematical and implementation articles for current rule definitions.
