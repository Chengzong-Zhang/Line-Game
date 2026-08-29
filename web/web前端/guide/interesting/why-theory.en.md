# LIFELINE Theory: Implementation Formalization, Combinatorial Game Theory, Complexity, and Reinforcement Learning

> Subject: the current Web versions of GameEngine.js and AIEngine.js.
> Rules snapshot: 2026-08-26.
> In the complexity sections, \(n\) denotes the generalized rule family obtained by removing the board-size cap in the code. The actual engine accepts only \(5\le n\le15\), and the current Web settings UI offers \(6\le n\le15\).

## Abstract

LIFELINE is a finite, deterministic, perfect-information sequential graph game, but the current implementation is not merely a game of “placing nodes on a triangular lattice.” A faithful state must simultaneously record the physical grid points, each side's explicit logical edges, the player to move, the set of resigned players, the consecutive-skip count, the terminal flag, and the Superko history. Explicit edges directly participate in the root-connectivity BFS after an attack, in edge restoration, and in Superko serialization; they are not a display cache uniquely reconstructible from the current nodes.

Let the number of players be \(m\in\{2,3\}\). A board of side length \(n\) has

\[
N(n)=\frac{n(n+1)}2=\Theta(n^2)
\]

physical grid points and

\[
Q(n)=3\sum_{\ell=1}^{n}\binom{\ell}{2}
=\frac{n^3-n}{2}
=\Theta(n^3)
\]

potential pairs of endpoints lying on a common lattice axis. In the current implementation, a safe upper bound on the number of Superko-serialized positions is

\[
P_m(n)
\le
m\,2^m(2m+1)^{N(n)}(m+1)^{Q(n)}
=2^{O(n^3)}.
\]

Consequently:

- \(2\cdot3^{N(n)}\) is not an equivalent-state upper bound for the current implementation;
- the number of successful placements is at most \(P_m(n)-1\);
- the complete game depth is at most \(m(P_m(n)+m-1)=2^{O(n^3)}\);
- the branching factor is at most \(N(n)+2=O(n^2)\);
- the naive game tree has size at most \(2^{2^{O(n^3)}}\).

Superko does not make every kind of action increase the history size: voluntary passes, automatic skips, and resignations do not write to the history. The complete augmented game is nevertheless a DAG. Let \(H\) be the history-key set, \(R\) the resignation set, and \(c\) the consecutive-skip count. Then

\[
\rho(q)=(m+1)^2|H|+(m+1)|R|+c
\]

strictly increases along every legal transition.

Complexity classes apply to a generalized decision problem, not to the phrase “this game.” What can currently be proved is that the explicit-position version of the generalized two-player forced-win problem belongs to EXPSPACE and also has a double-exponential time upper bound. No reduction establishes NP-hardness, PSPACE-hardness, EXPTIME-hardness, or EXPSPACE-hardness for the complete current rules. The three-point restriction does support a rigorously PSPACE-complete abstract Col variant, and the current engine contains a reachable two-ply witness combining score-lead alternation with same-color adjacency exclusion. Action isolation, long-range-edge isolation, and composable scoring remain unproved. A huge search space does not imply NP-hardness.

The precise result about strategy stealing is also subtler than the old claim. The three-point restriction makes the monotonicity premise “one extra friendly node can never hurt” false, so the classical extra-stone proof cannot be applied directly; voluntary Pass means that the rules still do not force a placement. Nevertheless, the current engine has a reachable state of maximum pressure \(Z=2\): Pass wins, while the only legal placement loses under optimal reply. This proves a strict Place-vs-Pass action-value reversal. Disabling Pass only at that given state makes it a zugzwang, but the reaching history itself uses voluntary Pass. Thus reachability of a zugzwang from the standard start in the no-Pass variant remains unproved, as does the claim that adding an extra friendly node lowers the Minimax value of an otherwise comparable state.

Superko can also produce a genuine **history divergence** distinct from extra-piece nonmonotonicity. This document gives two \(n=6\) histories reachable from the standard initial position: they arrive at exactly the same grid labels, explicit edges, player to move, skip count, and scoring-rules kernel, yet their different \(H\) sets make the same attacking placement legal in one game and illegal in the other solely because it hits an old key. A separate eight-step loop witness proves that the position projection with history removed really does contain a cycle, whose closing edge Superko deletes exactly. Exact Minimax further shows that the loop witness found so far only reduces White's winning first moves from three to two; both root values remain \(+1\). Thus what has been proved is that history-blind move-by-move copying is not universally legality-preserving and that Superko can force a winning strategy to detour. It has not been proved that Superko reverses the game value, nor that every history-aware strategy-stealing argument fails.

From a combinatorial-game perspective, the fundamental object on a fixed board is a finite partizan scoring-play short game on augmented states, not a nimber attached to the physical board. This document further defines the tempo gain of Place relative to Pass, the outcome span of a decision, the action-mask distance between histories sharing the same kernel, and a rigorously piecewise-linear “placement-tax spectrum.” These are computable temperature-like indicators, not an unproved Conway temperature. Under two-player win/loss utility, Resign is weakly dominated by the always-legal Pass and may be removed from optimal evaluation; the known maximum pass-pressure counterexample proves that Pass itself must not be removed.

From a reinforcement-learning perspective, the faithful environment is a deterministic Markov game whose internal state is the complete \(q=(\sigma,\mathbf E,\tau,R,c,H,z)\). The same-kernel/different-history counterexample proves rigorously that a feed-forward observation containing only the current grid and edges is not Markov: even the legal-action mask is not uniquely determined. This document consequently specifies action, Normalize, and reward contracts; history-aware state keys; backup rules that follow the actual controller; relational GNN and line-hypernode representations; potential-based reward shaping; the applicability boundaries of AlphaZero, PPO, and PSRO; and a falsifiable benchmark suite built from the existing reachable counterexamples. No formal reinforcement-learning run has yet been performed; these are research designs constrained by the implementation and the proved results.

The current territory algorithm is not fair under color-exchanging reflection either. A reachable ten-placement state ends in DRAW after two Passes, while its reflected, color-exchanged state ends in a BLACK win. The cause is dependence of greedy tightening on a closed contour's array start, orientation, and equal-objective enumeration order. This document gives three scoring definitions with provable equivariance: player-base canonical coordinates, bidirectional minimum, and orbit sum.

## 1. Status of Claims

This document strictly distinguishes four kinds of statements.

| Label | Meaning |
|---|---|
| Implementation fact | Directly checkable from the control flow of the current GameEngine.js or AIEngine.js |
| Theorem | A complete proof is provided here |
| Upper bound | Safe but potentially very loose; neither attainability nor asymptotic tightness is claimed |
| Open problem | Not currently proved and must not be presented as an established conclusion |

The three-state node model in the old document may be used for a separately defined idealized variant that uniquely reconstructs the complete visibility closure after every move, but it is not equivalent to the current Web game.

The implementation evidence index is below; line numbers refer to this rules snapshot:

| Topic | Code location |
|---|---|
| Players, grid-point states, bases, and initial state | GameEngine.js:1–158 |
| Common-axis relation, blocking, three-point restriction, and protected zones | GameEngine.js:347–450 |
| Explicit edges, root-connectivity BFS, attack, and restoration | GameEngine.js:453–695 |
| Outer contour, tightening, and flood-fill scoring | GameEngine.js:697–1109 |
| Superko serialization and player rotation | GameEngine.js:1112–1174 |
| Placement, automatic skipping, Pass, and Resign | GameEngine.js:1177–1466 |
| Heuristic search and evaluation function | AIEngine.js:13–286 |
| Worker search entry point and territory-cache disabling | AIWorker.js:4–47 |
| AI-state serialization and the local two-player-only activation condition | OnlineApp.js:50–65, 2507–2594 |
| Executable checks for the three reachable witnesses, full \(\Theta\)-state fields, the 19/11 basin split, and all three symmetrized scores | guide/interesting/verify-theory-counterexamples.mjs |
| Same-kernel/different-history Superko divergence, the eight-step cycle, and optional exact Minimax | guide/interesting/verify-superko-history-divergence.mjs |

## 2. Complete Formalization of the Current Rules

### 2.1 Board, adjacency, and players

The set of grid points is

\[
\mathcal V_n
=
\{(x,y)\in\mathbb Z_{\ge0}^2:x+y\le n-1\}.
\]

The six unit-neighbor directions are

\[
D=\{(1,0),(-1,0),(0,1),(0,-1),(1,-1),(-1,1)\}.
\]

Write \(u\sim v\) when \(v-u\in D\). Two distinct points lie on a common lattice axis if and only if

\[
x_u=x_v,\qquad
y_u=y_v,\qquad\text{or}\qquad
x_u+y_u=x_v+y_v.
\]

The fixed cyclic player orders are

\[
\mathcal C_2=(B,W),\qquad
\mathcal C_3=(B,W,P).
\]

The base points in two-player mode are

\[
r_B=(0,0),\qquad r_W=(n-1,0).
\]

The base points in three-player mode are

\[
r_B=(0,0),\qquad
r_W=(0,n-1),\qquad
r_P=(n-1,0).
\]

The starting player is configurable; the default is \(B\). Rotation skips players who have already resigned.

### 2.2 Physical layer and explicit-edge layer

Each player \(a\in\mathcal C_m\) has a node state \(a_N\) and a line-point state \(a_L\). The physical board labeling is

\[
\sigma:\mathcal V_n\to
\{\emptyset\}\cup\{a_N,a_L:a\in\mathcal C_m\}.
\]

Thus every point has \(2m+1\) possible physical states: five in two-player mode and seven in three-player mode.

Let

\[
\mathcal U_n
=
\{\{u,v\}:u,v\in\mathcal V_n,\ u\ne v,\ u,v\text{ lie on a common lattice axis}\}
\]

be the set of all potential logical edges. Each player also has an explicit edge set

\[
E_a\subseteq\mathcal U_n.
\]

In the current implementation, \(E_a\) is rule state rather than a disposable cache, for three reasons:

1. The BFS from a base point after an attack traverses only \(E_a\).
2. Attacks delete, clean up, and conditionally restore these edges.
3. Superko serialization includes every player's explicit-edge list.

Grid-point line states and edge sets do not determine one another uniquely in both directions. A newly placed node is initially connected to every unobstructed collinear friendly node; the crawl reconnection after an attack, however, adds only the first friendly node encountered on each ray, while edge restoration restores only edges that already existed before the attack. Consequently, the current program can assign different legal successors to identical grid labels paired with different explicit-edge sets. They must be treated as different positions.

### 2.3 Faithful rule state

After omitting display caches that can be recomputed, write the complete state as

\[
q=
(\sigma,\mathbf E,\tau,R,c,H,z),
\]

where:

- \(\mathbf E=(E_a)_{a\in\mathcal C_m}\);
- \(\tau\in\mathcal C_m\) is the player to move;
- \(R\subseteq\mathcal C_m\) is the set of resigned players;
- \(c\in\{0,\ldots,m\}\) is consecutiveSkips;
- \(H\) is the set of Superko-serialized positions recorded by the implementation;
- \(z\in\{0,1\}\) indicates whether the game is terminal.

turnCount does not affect legality, transitions, or the result. In states normally produced through the public rules interface,

\[
\text{turnCount}=(|H|-1)+|R|,
\]

because the initial history already contains one element, a successful placement increments both the history and the turn count, a resignation increments only the turn count, and a skip increments neither.

cachedTerritories, polygon, and displayArea can all be recomputed from the current physical board and therefore are not part of the minimal rule state. They may be added to an engineering state that reproduces every field of a UI snapshot, but doing so must not change the counting convention for mathematical game states.

### 2.4 Opponents, protected zones, and remnants of resigned players

The opponent set used by the code is

\[
\operatorname{Opp}(a)=\mathcal C_m\setminus\{a\},
\]

and does not exclude players who have resigned. A resignation therefore does not remove that player's nodes, line points, or edges. Those pieces continue to block connections, remain in other players' enemy sets, and continue to generate protected zones around their base point.

The no-entry protected zone for player \(a\) is

\[
Z_a
=
\bigcup_{b\in\operatorname{Opp}(a)}
\operatorname{Adj}(r_b).
\]

Every placement in \(Z_a\) is illegal, including an attacking placement.

### 2.5 Connection condition

Let \(L[u,v]\) be the discrete line segment, including its endpoints, between two grid points on a common lattice axis, and let \(L^\circ[u,v]\) be its interior points. For player \(a\), two friendly nodes \(u,v\) may be connected if and only if:

1. \(u,v\) lie on a common lattice axis;
2. no interior point is a node or line point of any opponent:

\[
\forall w\in L^\circ[u,v],\quad
\sigma(w)\notin
\{b_N,b_L:b\ne a\}.
\]

Friendly nodes and friendly line points do not block a connection. A newly placed node must connect to at least one existing friendly node, or the placement fails.

### 2.6 The actual three-point restriction

Let \(N_a\) be player \(a\)'s node set before the placement, let \(v\) be the candidate point, and define

\[
A_a(v)=N_a\cap\operatorname{Adj}(v).
\]

For a non-attacking placement, the three-point check passes if and only if

\[
|A_a(v)|=0,
\]

or

\[
A_a(v)=\{u\}
\quad\text{and}\quad
N_a\cap\operatorname{Adj}(u)=\emptyset.
\]

It therefore does more than forbid a minimal triangle. A candidate adjacent to two friendly nodes is illegal; even if it is adjacent to only one friendly node, it is illegal whenever that node is already unit-adjacent to another friendly node. This forbids three-node chains, V-shapes, and triangles.

Only an attacking placement that overwrites an opponent's line point is exempt from the three-point restriction. Promoting a friendly line point to a node must still pass the three-point check.

### 2.7 Three player actions

In a nonterminal decision state, the current player's action set is

\[
\mathcal A(q)
=
\{\operatorname{Place}(v):v\in\mathcal L(q)\}
\cup\{\operatorname{Pass},\operatorname{Resign}\}.
\]

Here \(\mathcal L(q)\) is the set of all legal placement points. Automatic skipping is a deterministic rules normalization, not a player-choice branch.

The low-level resignPlayer(player) interface permits any player who has not yet resigned to be specified. The formal game model restricts this to “the player to move may resign only themself,” matching the ordinary UI permission semantics. If the permissive low-level API is also treated as part of the rules, the later branching bound \(N+2\) need only be relaxed to \(N+m+1\).

## 3. Placement Transitions

### 3.1 Initial occupiability condition

The original state of a candidate point \(v\) must satisfy

\[
\sigma(v)\in
\{\emptyset\}\cup\{b_L:b\in\mathcal C_m\}.
\]

Thus the rules allow a player to:

- place on an empty point;
- overwrite an enemy line point and attack;
- promote a friendly line point to a friendly node.

No player's node can be overwritten directly.

Let the current player be \(a\). A Place\((v)\) action must additionally satisfy:

1. \(a\notin R\) and \(v\in\mathcal V_n\);
2. \(v\notin Z_a\);
3. if the original state of \(v\) is not an enemy line point, the three-point check passes;
4. after temporary placement, at least one connection to an existing friendly node can be made;
5. after the attack and reconnection are fully resolved, the new serialized position is not in \(H\).

### 3.2 New node and initial new edges

First execute

\[
\sigma(v)\leftarrow a_N.
\]

For every existing friendly node \(u\), if \(u,v\) satisfy the connection condition, set

\[
E_a\leftarrow E_a\cup\{\{u,v\}\}.
\]

Empty interior points of the segment are written as \(a_L\); existing friendly line points remain unchanged, and friendly nodes remain nodes. This stage connects every qualifying existing node, not merely the nearest node in each direction.

If no connection is established, \(v\) is restored to its original state and the placement is rejected.

### 3.3 Attack, edge severing, and root-connected deletion

If \(v\) was originally a line point of player \(b\ne a\), then \(b\)—not “all opponents”—is the owner being attacked.

First remove all explicit edges of \(b\) whose physical projection is no longer intact:

\[
E_b^{\mathrm{intact}}
=
\left\{
\{u,w\}\in E_b:
\forall x\in L[u,w],\
\sigma(x)\in\{b_N,b_L\}
\right\}.
\]

Because the attacked point is now \(a_N\), all edges of \(b\) passing through it are severed simultaneously.

In the logical graph

\[
G_b=(N_b,E_b^{\mathrm{intact}})
\]

perform BFS from the fixed base point \(r_b\). Let the set of reachable nodes be

\[
C_b=\operatorname{Reach}_{G_b}(r_b).
\]

The surviving set of physical pieces is

\[
S_b
=
C_b
\cup
\bigcup_{\substack{\{u,w\}\in E_b^{\mathrm{intact}}\\u,w\in C_b}}
L[u,w].
\]

All \(b_N\) and \(b_L\) not in \(S_b\) are cleared. Life and death here are determined by root reachability in the explicit node-to-node edge graph, not by physical six-neighbor connectivity.

The engine then:

1. saves every side's pre-attack edge set;
2. clears the attacked side's edge set and removes every edge whose physical projection has been broken;
3. restores only edges that existed before the attack, whose endpoints remain same-color nodes and whose present segment is unobstructed;
4. when restoring an edge, writes the corresponding line point only into empty interior points.

If this attack actually cleared any pieces, the code attempts to restore qualifying snapshot edges for all players. If no pieces were cleared, it explicitly restores snapshot edges only for the player who placed and the player who was attacked. Only afterward does it perform crawl reconnection for the player who placed.

Resolution therefore does not unconditionally rebuild the complete closure of all currently unobstructed node pairs.

### 3.4 Crawl reconnection

After attack processing, the engine performs six-direction crawl reconnection only for the player who just placed. For every friendly node and every ray:

1. stop immediately upon encountering an enemy node or line point;
2. upon encountering the first friendly node in that direction, add the edge if it is not already explicit and write friendly line points into empty points along the path;
3. then stop that ray.

This history-dependent process of “restore old edges plus first-node crawling” is precisely why explicit edges cannot be uniquely derived from nodes.

### 3.5 Implementation-defined Superko

The implementation uses deterministic JSON serialization strings, not short hashes that may collide. Define

\[
K(q)
=
\operatorname{Serialize}
\bigl(
\tau,\ R,\ \sigma|_{\sigma\ne\emptyset},\
(E_a)_{a\in\mathcal C_m}
\bigr).
\]

It includes:

- the next player to move;
- the resignation set in fixed player order;
- all nonempty physical grid points in sorted order;
- each player's sorted explicit-edge list.

It does not include the consecutive-skip count, terminal flag, turnCount, or territory caches.

The initial set is

\[
H_0=\{K(q_0)\}.
\]

After a candidate placement has been fully resolved, compute \(K'\) with \(\tau'\) set to the next player who has not resigned. If

\[
K'\in H,
\]

the board and all explicit edges are rolled back and the placement is illegal. Otherwise,

\[
H\leftarrow H\cup\{K'\}.
\]

The engine then increments turnCount by 1, resets the consecutive-skip count to 0, switches players, performs automatic-skip normalization, and updates territory.

This is an implementation-specific, situational-like Superko that includes the player to move, the resignation set, and explicit topology. It records only the initial position and serialized positions after successful placements; Pass and Resign do not write to \(H\).

## 4. Pass, Automatic Skipping, Resignation, and Termination

### 4.1 Voluntary Pass

In every nonterminal state, the current player may voluntarily Pass even when legal placements remain. Its effect is

\[
c\leftarrow c+1.
\]

If

\[
c\ge|\mathcal C_m\setminus R|,
\]

the game ends immediately. Otherwise, play rotates to the next player who has not resigned, followed by automatic-skip normalization.

A voluntary Pass changes neither the board, edges, history, nor turnCount.

### 4.2 Automatic skipping and normalization

If the current player has no placement that passes the complete Superko check, the engine automatically performs one skip:

\[
c\leftarrow c+1.
\]

The game ends if this reaches the number of remaining players; otherwise rotation continues and the check recurses. A resigned current player is merely bypassed by the rotation logic and does not create a choice branch.

This deterministic process can be written as a normalization operator

\[
\operatorname{Normalize}(q),
\]

which runs until either:

- it finds a non-resigned player to move who has at least one legal placement; or
- the state becomes terminal.

When the Web turn timer is enabled, a timeout causes the UI layer to invoke the same Pass process. A pure combinatorial-rules model does not record real time; a study of timed play must add the remaining clocks to the state.

### 4.3 Resign

When the current player resigns,

\[
R\leftarrow R\cup\{\tau\},
\qquad
c\leftarrow0.
\]

turnCount increases by 1, but \(H\) does not change. The resigned player's board elements, explicit edges, and protected zone all remain.

If at most one player remains, the game ends. Otherwise, play rotates to the next non-resigned player and is normalized.

### 4.4 Terminal conditions and winner

There are two sources of terminal states:

\[
c\ge|\mathcal C_m\setminus R|
\]

through consecutive voluntary or automatic skips, or

\[
|\mathcal C_m\setminus R|\le1
\]

through a resignation termination.

At a terminal state, discrete territory area is compared only among players who have not resigned. A unique maximizer wins; a tie for the maximum returns DRAW. If one player resigns in a two-player game, the sole survivor wins unconditionally, regardless of area. In a three-player game, play continues after the first resignation; after the second, the only remaining player wins immediately.

## 5. Algorithmic Semantics of Territory and Scoring

Territory is not simply geometric polygon area. It is a deterministic “physical contour—local greedy tightening—boundary flood fill” algorithm.

### 5.1 Outer contour

For player \(a\), take the physical friendly set

\[
F_a=\{v:\sigma(v)\in\{a_N,a_L\}\}.
\]

The explicit-edge set does not participate directly in contour tracing. Starting from the friendly point with minimum \(x\), breaking ties by minimum \(y\), the engine follows a fixed clockwise direction order and a right-hand wall-following rule on the six-neighbor graph of \(F_a\) for at most \(6|F_a|+10\) steps. Denote the resulting grid-point sequence by \(P_0\). If its length is less than 3, the territory is 0.

This sequence is a contour as defined by the implementation; without a proof, it should not be called a simple polygon in the general geometric sense.

### 5.2 Coverage operator

For any contour sequence \(P\), treat every grid point appearing in it as a wall:

\[
W(P)=\{v:v\text{ appears in }P\}.
\]

The boundary of the triangular board is

\[
\partial\mathcal V_n
=
\{(x,y):x=0\text{ or }y=0\text{ or }x+y=n-1\}.
\]

Flood from all boundary points not in the wall through the six-neighbor graph \(\mathcal V_n\setminus W(P)\). Define

\[
\operatorname{Cov}(P)
=
\mathcal V_n\setminus
\operatorname{Flood}_{\mathcal V_n\setminus W(P)}
\bigl(\partial\mathcal V_n\setminus W(P)\bigr).
\]

The discrete area is

\[
A(P)=|\operatorname{Cov}(P)|.
\]

Wall points themselves are not flooded and therefore also count toward area.

### 5.3 Greedy tightening

Starting from \(P_0\), the engine repeatedly enumerates pairs of contour vertices and constructs all shortest paths between them in the unit-grid graph while avoiding every enemy node and enemy line point. It considers only paths strictly shorter than the contour arc they would replace and constructs candidates on both sides.

Candidate selection strictly decreases the lexicographic objective

\[
\bigl(|P|,A(P)\bigr):
\]

perimeter first, and discrete covered area second among equal perimeters. A candidate with the same perimeter and area does not replace the incumbent; enumeration order determines which contour is retained when objective values are entirely identical.

Outward and wedge candidates check

\[
N_a\subseteq\operatorname{Cov}(P')
\]

and

\[
\operatorname{Cov}(P')
\cap
\{v:\sigma(v)\in\{b_N,b_L\},b\ne a\}
=\emptyset.
\]

The code's “inward scheme A,” however, uses an algebraic-area formula, explicitly checks only that friendly nodes remain covered, and relies on the implicit invariant that the current region contains no enemy elements rather than checking enemy points again. A faithful theory can therefore describe only the implemented algorithm; it cannot promote the final \(P^\star\) to a globally shortest feasible enclosure that has already been proved correct.

Because \((|P|,A(P))\) is an \(O(N)\times O(N)\) pair of nonnegative integers and strictly decreases, the tightening process must terminate. It terminates at a local greedy optimum within the enumerated neighborhood, with no guarantee of global optimality.

### 5.4 Winning area and displayed area

The final area used to decide the winner is

\[
\operatorname{area}_a=A(P^\star).
\]

A separate display quantity is

\[
\operatorname{displayArea}_a
=
\left|
\sum_i x_i y_{i+1}-x_{i+1}y_i
\right|.
\]

It is the absolute shoelace sum without division by 2. The UI may display it, but it is not used in the winner comparison.

## 6. Position in Combinatorial Game Theory

In combinatorial-game terminology, the current rules are best viewed as a **partizan scoring-play graph game**: legal actions depend on a player's color and base point, while termination is determined by scoring, skipping, and resignation. It is not an impartial normal-play game. Superko also makes it history-dependent; only on the augmented state is it a well-founded finite DAG.

### 6.1 Two-player version

The code returns a winner rather than a numerical utility. To obtain a two-player zero-sum model, define

\[
u_B(q_T)=
\begin{cases}
+1,&\operatorname{winner}=B,\\
0,&\operatorname{winner}=\mathrm{DRAW},\\
-1,&\operatorname{winner}=W,
\end{cases}
\qquad
u_W=-u_B.
\]

The complete utility cannot simply be defined as the area difference: after one player resigns, the sole survivor wins even if that player's area is smaller.

Under this utility, the two-player version is a finite, deterministic, perfect-information, zero-sum alternating-move extensive-form game. Section 8 proves that its augmented state graph is a DAG, so backward induction defines a unique game value:

\[
V(q)=
\begin{cases}
u_B(q),&q\text{ is terminal},\\
\max_{a\in\mathcal A(q)}V(T(q,a)),&\tau=B,\\
\min_{a\in\mathcal A(q)}V(T(q,a)),&\tau=W.
\end{cases}
\]

The recursion is well-defined on a finite DAG and guarantees pure optimal strategies for both players. This does not mean that computing those strategies is efficient.

### 6.2 Three-player version

The three-player version is a finite, deterministic, perfect-information multiplayer sequential game, but it is not naturally a two-player zero-sum game. The engine specifies only

\[
\operatorname{winner}\in\{B,W,P,\mathrm{DRAW}\},
\]

without defining coalitions, the value of second place, or numerical utilities for all three players. To complete the extensive-form model used in this document, one may adopt the following explicit analytical convention:

\[
u_a(q_T)=
\begin{cases}
+1,&\operatorname{winner}=a,\\
0,&\operatorname{winner}=\mathrm{DRAW},\\
-1,&\operatorname{winner}\in\mathcal C_3\setminus\{a\}.
\end{cases}
\]

This is a theoretical wrapper, not an engine field, and it is not the only reasonable preference specification. At a unique-winner terminal its three utilities sum to \(-1\), whereas at DRAW they sum to 0, so this particular wrapper is not constant-sum. Whether the game is constant-sum is not itself fixed by the engine, however. The ordinally equivalent convention

\[
\widetilde u_a=
\begin{cases}
2,&\operatorname{winner}=a,\\
0,&\operatorname{winner}=\mathrm{DRAW},\\
-1,&\operatorname{winner}\ne a
\end{cases}
\]

preserves the ranking win \(>\) draw \(>\) loss and satisfies \(\sum_a\widetilde u_a=0\). The two cardinal wrappers have different meanings for mixed strategies and risk. Equilibria may likewise change under coalition, ranking, or territory-difference preferences.

Once each player's complete preferences and a tie-breaking rule are specified, backward induction on the finite DAG still yields a pure subgame-perfect equilibrium, but the equilibrium is generally nonunique and cannot be represented by a single binary Minimax scalar. The invariant boundary, independent of the utility wrapper, is that there are three independent controllers. Any three-player complexity or learning study of “forced wins” must first state whether the other two players optimize separately or act as an adversarial coalition.

### 6.3 Why Sprague–Grundy theory does not apply directly

The current game is not a standard impartial normal-play combinatorial game:

- the sides have different bases and color-dependent legal-action sets;
- termination is scored by territory and resignation rather than “the player with no move loses”;
- draws, voluntary Pass, and Superko history exist;
- three-player mode lies outside the two-player Sprague–Grundy framework;
- long-range edges, root-connected deletion, and global flood fill prevent a natural decomposition into independent subgames.

One therefore cannot simply assign a nimber to each local region and XOR them. Bridges, articulation points, and small separators may still support dynamic programming with boundary-interface states or search pruning, but that is a conditional decomposition, not an ordinary disjunctive-sum decomposition.

### 6.4 The augmented state is a short game; the physical board has no independent game value

For fixed \(n,m\), the strict rank in Section 8 makes the complete augmented state graph a finite DAG. It is therefore a **short game form** in the sense that it has no infinite action chain, and backward induction can proceed from terminal states. The fundamental object must be

\[
q=(X,H)
=(\sigma,\mathbf E,\tau,R,c,z,H),
\]

not the physical rules kernel \(X\) with history removed. For the current controller \(p=\tau(q)\), define the valued option set

\[
\mathfrak O_p(q)
=
\left\{
\bigl(a,V_p(T(q,a))\bigr):a\in\mathcal A(q)
\right\}.
\]

The same-kernel/different-history witness in Section 7.10 has \(X_A=X_B\) but \(\mathcal A(q_A)\ne\mathcal A(q_B)\). Thus \(X\) has neither a unique option set nor a Conway form or Minimax value independent of history. Although the projection with \(H\) removed contains a directed cycle, treating it directly as an ordinary loopy game is also unfaithful: whether a particular return edge exists depends on the entire set of old keys. The correct procedure is to retain \(H\) and evaluate the augmented short game.

This also imposes a strict requirement on transposition tables. Merging nodes using only the grid, explicit edges, and player to move is incorrect. Even when the current legal-action masks happen to agree, different \(H\) sets may forbid different successors deeper in the search.

### 6.5 Pass is a tempo resource, not the zero game

A voluntary Pass changes \(c\), may immediately freeze the score, and may transfer control to the next player who still has a legal placement. It is therefore not an identity action that “leaves the position unchanged.”

Let the number of remaining players be \(r(q)=m-|R|\). Then, in a nonterminal state,

\[
b_{\mathrm{pass}}(q)=r(q)-c
\]

can be viewed as the remaining budget before the current consecutive-skip chain reaches termination. While the board and \(R\) remain fixed, every voluntary or automatic skip decreases this budget by at least 1, and reaching 0 ends the game; a successful Place resets \(c\) to zero and refills this global budget. For the current controller \(p\), define the strict tempo gain of each Place relative to Pass by

\[
U_p(q,a)
=
V_p(T(q,a))-V_p(T(q,\operatorname{Pass})),
\qquad a\in\mathcal A_{\mathrm{Place}}(q),
\]

and define the outcome span of the whole decision by

\[
D_p(q)
=
\max_{a\in\mathcal A(q)}V_p(T(q,a))
-
\min_{a\in\mathcal A(q)}V_p(T(q,a)).
\]

Under ternary win/draw/loss utility, \(D_p(q)\in\{0,1,2\}\). The reachable state from Section 7.5 satisfies simultaneously

\[
D_W(q)=2,
\qquad
\max_{a\in\mathcal A_{\mathrm{Place}}(q)}U_W(q,a)=-2,
\]

so every actual placement is worse than Pass by the maximum possible amount. These quantities rigorously measure move urgency and pass-pressure, but they must not be called Conway temperature. Classical temperature presupposes composable numerical subgames and a cooling operation, whereas the current rules do not decompose naturally and their utility is primarily the discrete win/draw/loss outcome. If a strictly equivariant score-difference utility is later adopted, scoring-play temperature may be studied. For now, \(U,D,Z\) are safest described as operational tempo indicators.

### 6.6 A distance for Superko graph-history interaction

Let \(\mathcal P(q)\) denote the legal Place set. For two augmented states with the same rules kernel \(X\), define the action-mask distance

\[
d_{\mathrm A}(q,q')
=
\frac{
|\mathcal P(q)\mathbin\triangle\mathcal P(q')|
}{
|\mathcal P(q)\mathbin\cup\mathcal P(q')|
},
\]

with distance 0 by convention when the union is empty. Also define the outcome distance

\[
d_{\mathrm V}(q,q')=|V_p(q)-V_p(q')|.
\]

The two real histories in Section 7.10 have \(|\mathcal P(q_A)|=4\), \(|\mathcal P(q_B)|=3\), and three actions in their intersection, so

\[
\boxed{d_{\mathrm A}(q_A,q_B)=\frac14}.
\]

This is a rigorous Graph History Interaction metric. The counterfactual \(q^-\) and real \(q^+\) associated with the eight-step cycle further show that deleting one old key removes a first move of value \(+1\), while two other \(+1\) first moves remain; hence \(d_{\mathrm V}=0\) for that pair. A change in game form, a change in the support of optimal strategies, and a change in the scalar root value are therefore three different phenomena. No pair of same-kernel histories both reachable from the standard initial position with \(d_{\mathrm V}>0\) has yet been found.

### 6.7 Conditional decomposition rather than an ordinary disjunctive sum

Suppose one tries to cut the board along a small separator \(S\). An interface sufficient for continued evaluation must record at least

\[
I_S(q)=
\bigl(
\sigma|_S,
\mathbf E_{\mathrm{cross}},
\Pi_{\mathrm{root}},
\tau,R,c,
H_{\mathrm{relevant}}
\bigr),
\]

where \(\mathbf E_{\mathrm{cross}}\) is the set of explicit edges crossing the separator, \(\Pi_{\mathrm{root}}\) records the connectivity partition among each player's boundary nodes and to that player's base, and \(H_{\mathrm{relevant}}\) must answer exactly whether every future candidate key has already occurred. Conditional dynamic programming over the two regions is possible only after proving all of the following:

1. no new cross-region collinear connection, attack, or crawl reconnection can occur;
2. deletion on one side cannot cascade through root connectivity into the other side;
3. terminal scoring composes once the interface is fixed;
4. the interface history answers every future Superko repetition query exactly.

The current rules commonly violate several of these conditions at once. In particular, the low degree of the physical triangular grid does not directly imply a low-treewidth algorithm: co-axial potential connections and explicit long edges create \(\Theta(n^3)\) nonlocal relations. Bridges, articulation points, and line-family hypergraphs may still support parameterized algorithms, but interface sufficiency must first be proved. This is an open FPT/dynamic-programming route, not an established decomposition theorem.

There is also a simple rigorous lower bound on this obstruction. Let the potential-visibility graph \(J_n\) connect two grid points whenever they lie on a common axis. Any boundary axis containing \(n\) grid points induces \(K_n\) in \(J_n\), and therefore

\[
\operatorname{tw}(J_n)\ge n-1.
\]

This proves only that a decomposition containing all potential long-range relations cannot have constant width. Whether the three-point restriction and reachability reduce the actual dynamic dependency graph to a smaller width remains open.

### 6.8 Theorem: Resign may be removed from two-player optimal evaluation, but Pass may not

Under the two-player win/draw/loss utility of Section 6.1, Resign gives the current player \(p\) value \(-1\) immediately in every nonterminal state. Pass is always legal, and its successor value must lie in \(\{-1,0,+1\}\). Hence

\[
V_p(T(q,\operatorname{Pass}))
\ge
-1
=
V_p(T(q,\operatorname{Resign})).
\]

Resign is therefore weakly dominated by Pass. Removing Resign from a two-player exact solver or an optimal reinforcement-learning action space does not change the Minimax value of any state. It should still remain available in the real UI, behavior cloning, and models of human data.

Pass cannot be removed in the same way: Section 7.5 gives a reachable state in which Pass is the unique winning action and the unique Place loses under optimal reply. In three-player play, resignation may also change the other two players' returns, coalitions, and equilibrium selection; without fully specified preferences, the two-player dominance result cannot be transferred unchanged.

### 6.9 A rigorously definable “placement-tax spectrum”

To obtain a temperature-like curve finer than the ternary \(U,D,Z\), define a derived rather than native move-tax model. Let \(w(a)\ge0\). Using Black's scalar utility, recursively define on the same augmented DAG

\[
F_\lambda(q)=
\begin{cases}
u_B(q),&q\text{ is terminal},\\[1mm]
\displaystyle\max_a\left(F_\lambda(T(q,a))-\lambda w(a)\right),&\tau=B,\\[2mm]
\displaystyle\min_a\left(F_\lambda(T(q,a))+\lambda w(a)\right),&\tau=W.
\end{cases}
\]

Induction on the finite DAG immediately shows that \(F_\lambda(q)\) is a finite piecewise-linear function. If the terminal values and \(w\) are integers, all breakpoints are rational. Taking

\[
w(\operatorname{Place})=1,
\qquad
w(\operatorname{Pass})=w(\operatorname{Resign})=0,
\]

allows one to study the threshold at which optimal play switches to Pass when each placement is taxed. It may be called a **placement-tax threshold** and can be computed on small exact subtrees. Until a cooling universe closed under disjunctive sum has been established, it must not be renamed a proved Conway temperature.

## 7. Strategy Stealing, Nonmonotonicity, and “Zugzwang”

### 7.1 What classical strategy stealing requires

Classical strategy-stealing arguments for games such as Hex usually rely on at least three conditions:

1. the rules and initial geometry are symmetric under exchanging the players;
2. there is no draw that the second player can exploit;
3. an extra friendly piece placed by the first player can never hurt, so that player may pretend it is absent while simulating the hypothesized second-player strategy.

The third condition is “extra-piece monotonicity.” Current LIFELINE does not satisfy it.

### 7.2 Theorem: an extra friendly node can reduce future legal placements

For any \(n\ge5\), consider Black's base point

\[
r_B=(0,0).
\]

The candidate point

\[
v=(1,0)
\]

is legal when only the base is present: it lies outside White's protected zone, is adjacent and collinear with \(r_B\), and passes the three-point check.

Now first add the black node

\[
x=(0,1).
\]

That placement is itself legal; \(W\) then Passes, returning the turn to \(B\). At this point, \(v\) is unit-adjacent to both \(r_B\) and \(x\), so

\[
|A_B(v)|=2,
\]

and the non-attacking placement at \(v\) is forbidden by the three-point restriction.

Thus adding a friendly node can strictly shrink the set of future legal placements. ∎

The current implementation also has a fully reachable counterexample in the opposite direction, showing that “adding friendly structure” can create new actions for the opponent. In a two-player game with \(n=5\), play the following sequence:

\[
B:(0,2),\qquad
W:(2,0),\qquad
B:(1,2).
\]

It is now \(W\)'s turn:

- if \(W\) Passes, an ordinary placement by \(B\) at \((2,1)\) would trigger the three-point restriction and is therefore illegal;
- if \(W\) places at \((2,2)\), the new white line passes through \((2,1)\);
- \(B\)'s subsequent placement at \((2,1)\) then becomes an attacking placement, receives the three-point exemption, and is therefore legal.

Thus new nodes and lines belonging to one side can enlarge the opponent's set of legal attacks. Both sequences above have been verified directly against the current GameEngine.js. Together they refute the action-monotonicity claim that “more friendly structure can only help and cannot create new actions for the opponent.”

### 7.3 What follows—and what does not

Together, the two counterexamples above prove that:

> The classical extra-stone strategy-stealing proof that depends on every additional friendly piece being harmless cannot be applied directly to the current rules.

It does not prove that:

- the second player has a winning strategy;
- the current game contains a classically zugzwang position that is actually reachable;
- every possible form of strategy stealing fails;
- an extra node necessarily lowers the Minimax value of the whole position.

Nonmonotonicity of the legal-action set negates one necessary premise of the old proof; it does not prove the opposite game-theoretic outcome.

### 7.4 Why “forced to place” is not a fact of the current rules

Pass is legal in every nonterminal state, even when the player has many legal placements. What happens automatically is only “skip when there is no legal placement,” never “be forced to choose a particular placement.”

More accurate research objects are therefore pass-pressure, placement-zugzwang in a no-Pass variant, and legality or value nonmonotonicity caused by extra structure. Fix the current player's three-valued Minimax utility \(V_a\in\{-1,0,1\}\). In a state with at least one legal placement, define

\[
Z_a(q)
=
V_a(T(q,\operatorname{Pass}))
-
\max_{v\in\mathcal L_a(q)}
V_a(T(q,\operatorname{Place}(v))).
\]

\(Z_a(q)>0\) says that Pass is strictly better than every placement, not that the rules force a placement. Pass increments the consecutive-skip counter and may terminate immediately, so it is not a cost-free null move.

### 7.5 Theorem: the current engine has maximum-strength strict pass-pressure

For \(n=5\), play from the standard initial state:

\[
\begin{aligned}
&B(1,0),\ W(2,0),\ B(1,2),\ W(2,1),\\
&B(0,2),\ W(1,1),\ B(0,4),\ W(1,3),\\
&B\operatorname{Pass}.
\end{aligned}
\]

The reachable state \(q\) has White to move, \(c=1\), areas \((7,8)\), and nine history keys. Exhausting all fifteen grid points shows that White's only legal placement is \((0,3)\). The complete critical branches are:

1. \(W\operatorname{Pass}\): \(c=2\), so the game ends immediately and White wins \(8:7\);
2. \(W\operatorname{Resign}\): Black wins;
3. \(W(0,3)\): the areas first become \((5,9)\). A Black Pass or Resign now lets White win. Black's only legal placement is \((2,2)\), and it is also Black's only winning action. After \(B(2,2)\), the areas are \((6,5)\), White has no legal placement and is automatically skipped, and Black Passes to win \(6:5\).

Therefore

\[
V_W(T(q,\operatorname{Pass}))=+1,
\qquad
\max_vV_W(T(q,\operatorname{Place}(v)))=-1,
\]

and

\[
\boxed{Z_W(q)=2},
\]

the maximum possible value under three-valued utility. White chooses Pass under the current rules, so this is not a legally forced placement. If voluntary Pass is removed only from the given decision state \(q\), White's unique placement loses under optimal response, making \(q\) a strict zugzwang as an abstract position. The displayed history reaching \(q\), however, itself uses Black's voluntary Pass, so this witness does not prove that a zugzwang is reachable from the standard start in the no-Pass variant. The unconditional result is a strict Place-vs-Pass action-value reversal and maximum pass-pressure in the current engine. It is not equivalent to proving that adding an extra friendly node lowers the value of an otherwise comparable state with the same controller and other conditions held fixed.

### 7.6 Reflection equivariance of the non-scoring rules kernel

Define

\[
\theta(x,y)=(n-1-x-y,y),
\]

and simultaneously exchange black and white nodes, line points, explicit edges, the player to move, resignation labels, and history keys; leave \(c\) and the terminal flag unchanged. Call the full map \(\Theta\).

After excluding the territory cache and final winner, the current rules kernel satisfies: if action \(a\) is legal at \(q\), then \(\Theta a\) is legal at \(\Theta q\), and

\[
\Theta T(q,a)=T(\Theta q,\Theta a).
\]

Indeed, \(\theta\) preserves unit adjacency, all three collinearity families, and discrete line segments. It exchanges the bases and protected zones and preserves the three-point restriction. Blocking, explicit-edge integrity, root-reachability BFS, deletion, old-edge restoration, and first-node ray reconnection depend only on these preserved relations. Transforming every key in \(H\) preserves Superko membership. Pass, Resign, and Normalize depend only on turn order, \(R\), \(c\), and existence of a legal placement, so they occur synchronously.

Territory computation is deliberately excluded: its fixed contour start, direction order, and enumeration order are not geometric invariants and do break terminal symmetry below.

### 7.7 Weak Pass strategy-stealing theorem

Consider the standard two-base initial state \(q_0\) with Black to move. Here \(T\) always includes the complete post-action Normalize process, and \(\Theta\) is an involution on the two-player rules kernel. Strategies may depend on the complete public history and may internally maintain a counterfactual history; the finite DAG in Section 8 guarantees termination under every strategy profile. Excluding a strict second-player win requires less than exact area equivariance. It suffices that:

1. the transition equivariance of Section 7.6 holds;
2. every relevant terminal state satisfies the one-sided implication
   \[
   u_W(t)=+1\Longrightarrow u_B(\Theta t)\ge0;
   \]
3. two Passes from the initial position produce a draw.

**Theorem.** Under these three assumptions, White has no strict winning strategy as the second player.

**Proof.** Suppose White has such a strategy \(\pi\). Black Passes first. White's Pass produces a draw and White's Resign loses, so \(\pi\) must reply with Place\(_W(v)\). Define the actual and counterfactual states

\[
q_A(v)=T\!\left(T(q_0,\operatorname{Pass}_B),\operatorname{Place}_W(v)\right),
\]

\[
q_C(v)=T\!\left(q_0,\operatorname{Place}_B(\theta v)\right).
\]

The first Place resets \(c\) to zero in both plays. Actual Black internally maintains the counterfactual history at \(q_C\). Whenever actual Black has a decision, it queries the action that \(\pi\) selects for White at the corresponding counterfactual state and plays its \(\Theta\)-image; every actual White action defines Black's action in the counterfactual play. Automatic skips are not strategy actions and occur synchronously under Normalize. Thus counterfactual White always follows \(\pi\), so every counterfactual terminal leaf is a White win. Assumption 2 makes actual Black at least nonlosing in every corresponding leaf, contradicting \(\pi\)'s ability to defeat every actual Black strategy. ∎

There is one Superko detail. Compare the history \(H_A\) after the actual sequence “Black Pass, \(W(v)\)” with the \(\Theta\)-image of the history \(H_C\) after the counterfactual sequence \(B(\theta v)\). Their symmetric difference is exactly the two bare initial keys:

\[
H_A\triangle\Theta H_C=\{h_B^0,h_W^0\}.
\]

Every successful Place computes its candidate key before Normalize, while the just-placed non-base friendly node is present. A node cannot be overwritten, and the current attack deletes only the opponent's structure. No later candidate key can therefore equal the bare two-base initial position. Replacing \(h_W^0\) by \(h_B^0\) yields a behaviorally equivalent state: all later Superko legality decisions agree, and terminal utility does not read \(H\). The counterfactual simulation is consequently exact.

### 7.8 Theorem: the current winner is not fully reflection-equivariant

The current engine has an \(n=7\) reachable counterexample with only ten placements and no intermediate Pass:

\[
\begin{aligned}
&B(1,0),\ W(5,1),\ B(4,0),\ W(2,1),\ B(0,5),\\
&W(2,3),\ B(1,2),\ W(1,4),\ B(0,3),\ W(0,4).
\end{aligned}
\]

The resulting areas are

\[
(A_B,A_W)=(10,10).
\]

Black and White then Pass, producing DRAW. Reflect and color-exchange the entire state, replay the corresponding mirrored sequence with White as starter, and the engine instead obtains

\[
(A_B,A_W)=(11,10).
\]

White and Black then Pass, producing a BLACK win. The mirrored physical state is also reachable from the default Black-start game by an initial Black Pass followed by that mirrored sequence, so this is not an artifact of manually assembling an illegal array.

A draw must remain a draw under any color-exchanging symmetry. The example therefore refutes both exact area equivariance and full win/loss/draw equivariance.

The cause is now localized to **representation dependence** in greedy tightening. The paired outer contours are the same closed contour up to cyclic shift and reversal, both initially at \((|P|,A)=(15,9)\). The implementation nevertheless treats a closed contour as an array with a start and orientation, enumerating by \(i,j\), BFS predecessor order, and path order; equal-objective candidates retain the first encountered polygon. Both sides first reach \((14,10)\) but enter different polygons: one stops, while the other continues to \((13,11)\). Across all fifteen cyclic starts and both orientations of this one contour, nineteen representations end at \((13,11)\) and eleven at \((14,10)\). Flood fill itself is reflection-equivariant; the failure is the combination of linear representation, first-encounter tie breaking, and distinct local basins.

This DRAW\(\to\)BLACK counterexample does not yet refute the weaker one-sided implication in Section 7.7. A targeted check of 37 legal replacements around the example plus 1000 deterministic random legal trajectories found no state in which White wins the original while Black still loses the mirror. That is test coverage, not a proof. Whether the first player is at least nonlosing from the standard initial state remains open.

### 7.9 Three scoring definitions with provable fairness

Let \(\operatorname{Raw}_c(q)\) be the current implementation's raw area for player \(c\).

**A. Player-base canonical coordinates.** Let \(T_B=\mathrm{id}\) and \(T_W=\Theta\), renaming the scored player to Black in \(T_cq\):

\[
A_c^{\mathrm{can}}(q)=\operatorname{Raw}_B(T_cq).
\]

Then immediately

\[
A_W^{\mathrm{can}}(q)=A_B^{\mathrm{can}}(\Theta q).
\]

Each player still requires one raw computation, the same total as today. Semantically, every player runs the same algorithm from their own base in the same standard orientation. The new counterexample becomes \((10,11)\) in the original and \((11,10)\) in the mirror, so the winner exchanges exactly.

**B. Bidirectional tightening.** Define

\[
\widehat A_c(q)
=
\min\{\operatorname{Raw}_c(q),\operatorname{Raw}_{\bar c}(\Theta q)\}.
\]

Swapping the two terms proves

\[
\widehat A_{\bar c}(\Theta q)=\widehat A_c(q).
\]

This never increases a raw score and best matches the intent of pulling the fence as tight as possible. It restores the new counterexample to \((10,10)\) on both sides. Without reuse, it computes both players on both \(q\) and \(\Theta q\), roughly doubling total cost.

**C. Orbit sum.** Alternatively,

\[
A_c^{\Sigma}(q)
=
\operatorname{Raw}_c(q)
+
\operatorname{Raw}_{\bar c}(\Theta q).
\]

This is also exactly equivariant; one compares integer sums without dividing by two. All three schemes retain the rule “a unique area maximizer wins and a tie is DRAW” and leave resignation terminals unchanged. Equivariance of the area vector therefore implies equivariance of the full terminal utility. Any of A, B, or C makes condition 2 of Section 7.7 automatic, so the second player cannot have a strict winning strategy from the standard two-player start.

One candidate for repairing the current raw algorithm internally is to canonicalize every closed contour in player-local coordinates to one key among all cyclic shifts and reversals. Enumerate all candidates, then globally minimize

\[
(\operatorname{perimeter},\operatorname{area},\operatorname{canonicalKey})
\]

and canonicalize again before the next round. The canonical key may break ties only among candidates with the same \((\operatorname{perimeter},\operatorname{area})\); the chosen candidate must still strictly improve on the current contour in the first two coordinates, so no equal-objective plateau transition is introduced. This removes the known first-encounter ambiguity. Elevating the entire raw algorithm to an equivariance theorem would still require proving, for every reachable friendly set, that `_getOuterContour` returns outer-face walks related only by cyclic shift or reversal under the group action and that the shortest-path candidate set is closed under that action. Until those facts are proved, A, B, and C are the formally guaranteed repairs; local canonicalization remains an engineering candidate.

For three players, player-frame normalization alone guarantees only the rotational subgroup \(C_3\). Full \(D_3\) symmetry requires \(D_3\) to act simultaneously on triangular-grid coordinates and on the base labels \(B,W,P\). For each player \(c\), choose \(T_c\) sending both \(c\)'s base and label to the standard label \(B\); an order-two labeled stabilizer \(\operatorname{Stab}(B)\) remains. Define

\[
A_c^{D_3}(q)
=
\min_{h\in\operatorname{Stab}(B)}
\operatorname{Raw}_B(hT_cq).
\]

Then, for every \(g\in D_3\),

\[
A_{gc}^{D_3}(gq)=A_c^{D_3}(q).
\]

Indeed, \(T_{gc}gT_c^{-1}\in\operatorname{Stab}(B)\), so multiplication by this stabilizer element merely permutes the two elements over which the minimum is taken; changing the section \(T_c\) has the same effect. This costs two raw computations per player, six in total, removes section dependence, and yields full \(D_3\) equivariance.

### 7.10 Superko strictly breaks history-blind copying, but has not yet reversed the value

Write the rules kernel without the history set as

\[
X=(\sigma,\mathbf E,\tau,R,c,z),
\]

and the complete state as \(q=(X,H)\). For a Place action \(a\) that has passed every non-Superko condition, let \(K(X,a)\) denote the candidate key after resolving the action. Let \(\widehat\Theta\) denote the action of the transformation from Section 7.6 on serialized keys.

Consider a pair of coupled states

\[
q_A=(X_A,H_A),\qquad q_B=(X_B,H_B),\qquad X_A=\Theta X_B,
\]

and a pair of reflected actions \(a_A=\Theta a_B\). Equivariance of the rules kernel gives

\[
K(X_A,a_A)=\widehat\Theta K(X_B,a_B).
\]

Define the history-difference set

\[
D=H_A\mathbin\triangle\widehat\Theta(H_B).
\]

Provided that non-Superko legality agrees on the two sides, the two actions differ in Superko legality if and only if

\[
K(X_A,a_A)\in D.
\]

This follows because the final Superko step asks only whether the candidate key belongs to the corresponding history set. In particular, if

\[
H_A=\widehat\Theta(H_B),
\]

then \(D=\varnothing\), and Superko cannot by itself break the reflected simulation. Conversely, synchronizing only the current board and explicit edges without maintaining a coupling of the histories provides no legality guarantee in principle.

The current engine contains a strict witness that does not rely on an artificially assembled history. Take \(n=6\) and, from the standard two-player initial position, execute respectively

\[
\begin{aligned}
\eta_A:\;&B(1,0),W(4,1),B(1,2),W(1,4),\\
&B(0,4),W(2,3),B(3,2);\\[2mm]
\eta_B:\;&B(1,0),W(4,1),B(0,4),W(1,1),B(3,1),\\
&W(1,4),B(1,2),W(1,3),B(3,2).
\end{aligned}
\]

Both histories are completely legal and reach the same rules kernel \(X\): the grid labels agree pointwise, both players' explicit edge sets agree, it is White's turn, \(R=\varnothing\), \(c=0\), \(z=0\), and both area vectors are \((11,0)\). Their history sizes, however, are

\[
|H_A|=8,\qquad |H_B|=10.
\]

At this point the same attack \(W(1,1)\) is

- legal in \((X,H_A)\);
- geometrically, three-point, connectivity, attack, and restoration legal in \((X,H_B)\), but it produces the key already recorded after move 4 of \(\eta_B\), so its only failure reason is `SUPERKO_VIOLATION`.

The complete legal Place sets on the two sides are

\[
\mathcal L(X,H_A)=\{(2,0),(3,0),(1,1),(2,1)\},
\]

\[
\mathcal L(X,H_B)=\{(2,0),(3,0),(2,1)\},
\]

so their difference is exactly \(\{(1,1)\}\).

It is therefore rigorously proved that **two states both reachable from the standard initial position and having exactly the same current rules kernel can have different legal-action sets solely because their histories differ.** Thus \(X\) is not a Markov state sufficient to determine legal actions. Without an additional history-safety proof, writing only \(\pi(X)\) cannot represent general complete strategies and cannot guarantee that a prescribed reply remains legal when copied to another state with the same kernel.

A second reachable witness measures the game-theoretic strength of this divergence exactly. Denote the 13-move state from Section 8.3 by

\[
q^+=(X_{13},H_{13}),
\]

and let

\[
q^-=(X_{13},H_{13}\setminus\{h_6\}),
\]

where \(h_6\) is the key written after move 6. Deleting only \(h_6\) restores \(W(0,3)\) from a Superko-forbidden move to a legal winning move. Unpruned exact Minimax using the real Place, Pass, automatic skipping, complete \(H\), and true terminal area gives:

| White root action | Value in \(q^-\) | Value in \(q^+\) |
|---|---:|---:|
| \(W(0,3)\) | \(+1\) | Superko-illegal |
| \(W(2,0)\) | \(+1\) | \(+1\) |
| \(W(2,1)\) | \(+1\) | \(+1\) |
| \(W(1,2)\) | \(-1\) | \(-1\) |
| Pass | \(-1\) | \(-1\) |

The root values on both sides are

\[
V_W(q^-)=V_W(q^+)=+1.
\]

The searches visit 83,957 and 50,028 recursive nodes respectively, with 55,865 and 34,039 transposition states. Resign immediately gives the acting player value \(-1\) while two players remain, so it can be omitted safely. Define the winning-action set by

\[
\mathcal W(q)=\{a:V_W(T(q,a))=+1\}.
\]

Then

\[
\mathcal W(q^-)=\{(0,3),(2,0),(2,1)\},
\qquad
\mathcal W(q^+)=\{(2,0),(2,1)\}.
\]

Superko therefore does delete one winning reply. Because Pass and \((1,2)\) both lose, White must switch to one of the two alternative Place actions to preserve a forced win. This may be called a **strategically forced detour**, but it is neither a rules-forced unique placement nor zugzwang: Pass remains syntactically legal, and two winning alternatives remain.

The strength of the conclusion must be divided into three levels:

1. **Legality divergence.** The same copied action is legal on only one side; the two real histories in this section prove this.
2. **Strategy divergence.** A specified winning strategy actually requires that action; the 13-move witness proves this for a strategy choosing \((0,3)\), and its winning-action set shrinks strictly.
3. **Value reversal.** \(V(X,H^-)\ne V(X,H^+)\), or the reflected strategy's unique value-preserving reply is forbidden with no alternative; this has not yet been found.

The counterexample does not refute the weak strategy-stealing theorem of Section 7.7 in which Black Passes first from the standard initial position. That special coupling differs in history by only two bare initial keys, and a later successful Place candidate can never equal the bare two-base position, so the difference set is never hit. The strongest correct statement at present is therefore:

> Superko strictly refutes the general principle that history-blind move-by-move copying is always legal and can force a winning strategy to detour; it does not automatically refute strategy stealing with a complete history coupling, and it has not yet produced a proved Minimax win/loss value reversal.

Executable verification is provided by [verify-superko-history-divergence.mjs](./verify-superko-history-divergence.mjs). Its default mode quickly checks the two real histories and the eight-step cycle; `--solve` runs the unpruned exact Minimax and prints both sets of action values and node counts shown above.

## 8. The Superko-Augmented Graph Is a DAG

### 8.1 Why the old proof using only \(|H|\) is wrong

A successful placement creates a new serialized position and inserts it into \(H\), so the subgraph containing only successful placements does indeed have \(|H|\) as a strict rank and is a DAG.

Voluntary Pass, automatic skipping, and Resign, however, do not increase \(H\). The proposition “every step of the complete game increases \(|H|\)” is therefore false.

### 8.2 Theorem: the complete augmented rules graph is a DAG

Take already-Normalized decision states and terminal states as graph vertices, and treat one player action together with its subsequent deterministic Normalize process as one rules transition. Define

\[
\rho(q)
=(m+1)^2|H|+(m+1)|R|+c.
\]

For a legal nonterminal state, \(0\le c\le m-1\).

**Successful placement.** Superko requires \(K'\notin H\), after which

\[
|H'|=|H|+1.
\]

Even if \(c\) resets from as high as \(m-1\) to 0,

\[
\Delta\rho
\ge
(m+1)^2-(m-1)>0.
\]

Any subsequent automatic skips only increase \(c\) further.

**Resignation.** \(H\) is unchanged, \(|R|\) increases by 1, and \(c\) resets. Therefore

\[
\Delta\rho
\ge
(m+1)-(m-1)=2>0.
\]

**Voluntary or automatic skip.** \(H,R\) remain unchanged while \(c\) increases by at least 1; the game enters a terminal state when it reaches the number of remaining players. Hence

\[
\Delta\rho>0.
\]

Every legal nonempty transition strictly increases the integer rank \(\rho\), so the complete augmented state-transition graph has no directed cycle. ∎

The correct conclusion is:

> The complete augmented game graph—including explicit edges, the player to move, the resignation set, consecutive skips, the terminal flag, and the history set—is a DAG.

It must not be restated as “the position graph with history removed is a DAG,” nor as “the Superko serialization key alone represents the complete state.” The serialized key omits \(c\) and \(z\); a second Pass can even terminate the game without changing that key.

### 8.3 Theorem: the position projection has a reachable eight-step cycle whose closing edge Superko deletes

Let the rules kernel \(X_t\) record the grid, explicit edges, player to move, resignation set, consecutive-skip count, and terminal flag after move \(t\), but omit \(H\). From the standard two-player initial position with \(n=6\), execute

\[
\begin{aligned}
&B(0,5),W(3,0),B(1,0),W(4,1),B(0,4),W(0,3),\\
&B(1,2),W(0,5),B(0,4),W(1,1),B(3,1),W(1,4),B(3,2).
\end{aligned}
\]

All 13 moves are legal. It is now White's turn, and the area vector is \((13,4)\). The attack \(W(0,3)\) passes every rule check except Superko. Its candidate key after tentative resolution is exactly the key \(h_6\) written after move 6, so the real engine returns `SUPERKO_VIOLATION`.

If \(h_6\) is removed solely for counterfactual analysis, the attack becomes immediately legal, and the resulting grid, explicit edges, player to move, \(R,c,z\), and serialized key all agree exactly with the rules kernel after move 6:

\[
X_{14}=X_6.
\]

Thus the rules-kernel projection that ignores history membership contains the real directed cycle

\[
X_6\to X_7\to\cdots\to X_{13}\to X_6,
\]

with eight edges. The current Superko rule deletes exactly its final closing edge. This witness establishes two points at once:

- the DAG property in Section 8.2 genuinely comes from augmented history, not from an inherent monotonicity of the physical board;
- an old noninitial key really can be hit by a future candidate action, so \(H\) is not a dormant field used only for theoretical upper bounds.

If the candidate attack were allowed, the area would change immediately from \((13,4)\) to \((0,8)\), and the score frozen by two Passes would change from a Black win to a White win. The complete Minimax analysis in Section 7.10 nevertheless proves that White retains two detouring winning moves, so this local score reversal is not a root-value reversal.

## 9. Upper Bounds on States, Depth, and Search Space

### 9.1 Physical points and potential edges

The number of grid points is

\[
N(n)
=
\sum_{\ell=1}^{n}\ell
=
\frac{n(n+1)}2.
\]

Each of the three axis families contains one line of every length \(1,\ldots,n\), so the number of potential co-axial endpoint pairs is

\[
Q(n)
=
3\sum_{\ell=1}^{n}\binom{\ell}{2}
=
3\binom{n+1}{3}
=
\frac{n^3-n}{2}.
\]

A pair of distinct grid points belongs to at most one of the three axis families, so there is no double counting.

### 9.2 Configuration and serialized-position bounds

Each grid point has \(2m+1\) states. For every potential endpoint pair, a legal explicit edge can be absent or belong to one of \(m\) players, for \(m+1\) possibilities. Therefore a safe upper bound on the physical and edge layers is

\[
C_m(n)
\le
(2m+1)^{N(n)}(m+1)^{Q(n)}.
\]

The Superko key also encodes the next player and the resignation set, so

\[
\boxed{
P_m(n)
\le
m\,2^m(2m+1)^{N(n)}(m+1)^{Q(n)}
}.
\]

This is only an upper bound. The vast majority of these combinations violate invariants concerning endpoint colors, physical edge projections, root connectivity, protected zones, the three-point restriction, or reachable histories.

If one counts the raw data structure as \(m\) independent Set objects, an even looser bound is

\[
P_m^{\mathrm{raw}}(n)
\le
m\,2^m(2m+1)^N2^{mQ}.
\]

For fixed \(m\), both conventions are \(2^{O(n^3)}\).

In particular,

\[
P_2(n)\le8\cdot5^N3^Q,
\qquad
P_3(n)\le24\cdot7^N4^Q.
\]

| \(n\) | \(N\) | \(Q\) | Two-player physical + edges \(C_2\) | Complete two-player key \(P_2\) | Complete three-player key \(P_3\) |
|---:|---:|---:|---:|---:|---:|
| 9 | 45 | 360 | \(1.649308\times10^{203}\) | \(1.319447\times10^{204}\) | \(1.416511\times10^{256}\) |
| 15 | 120 | 1680 | \(2.754917\times10^{885}\) | \(2.203933\times10^{886}\) | \(1.789623\times10^{1114}\) |

If only two-player keys with no resigned player are counted, the resignation-set factor may be removed:

\[
2\cdot5^{45}3^{360}
=3.298617\times10^{203},
\]

\[
2\cdot5^{120}3^{1680}
=5.509833\times10^{885}.
\]

The corresponding decimal values in the old document should be replaced by these two values as well.

### 9.3 Augmented history-state space

\(H\) is a subset of at most \(P_m\) keys. After additionally accounting for the current position, consecutive skips, and the terminal flag,

\[
\boxed{
|\Omega_{\mathrm{aug}}|
\le
2(m+1)P_m\,2^{P_m}
}
=
2^{2^{O(n^3)}}.
\]

This double exponential is an upper bound on the state space of the history automaton, not the length of one play.

### 9.4 Longest play

The initial history already contains one key. Every successful placement adds a previously unseen key, so the number \(L\) of successful placements satisfies

\[
L\le P_m-1.
\]

To avoid mixing this count with Section 8's convention that “one player action plus Normalize” is one graph edge, let \(D_m\) count primitive events here, including every automatic skip separately. The edge depth of the normalized decision graph can only be smaller. There are at most \(m-1\) resignations before termination. Let

\[
X=L+R_{\mathrm{act}}\le P_m+m-2
\]

be the number of actions that reset the consecutive-skip count. Before each nonterminal action segment there can be at most \(m-1\) Passes, and the final terminal segment has at most \(m\) Passes. Thus the total depth \(D_m\) satisfies

\[
D_m
\le
X+(m-1)X+m
=mX+m
\le
\boxed{m(P_m+m-1)}.
\]

Therefore

\[
D_m(n)\le2^{O(n^3)}.
\]

### 9.5 Branching factor and game tree

The current player may choose at most \(N\) placement points, plus Pass and Resign:

\[
\boxed{B_m(n)\le N(n)+2=O(n^2)}.
\]

Automatic skipping introduces no choice branch. A naive game tree without transposition merging satisfies

\[
|\mathcal T|
\le
\sum_{d=0}^{D_m}B_m^d
<
(N+2)^{D_m+1}
\le
2^{2^{O(n^3)}}.
\]

Substituting the complete-key bound gives the following extremely loose but explicit values:

| Board and number of players | Naive game-tree upper bound |
|---|---:|
| \(n=9,m=2\) | \(<10^{\,4.413\times10^{204}}\) |
| \(n=9,m=3\) | \(<10^{\,7.106\times10^{256}}\) |
| \(n=15,m=2\) | \(<10^{\,9.197\times10^{886}}\) |
| \(n=15,m=3\) | \(<10^{\,1.121\times10^{1115}}\) |

These figures result from substituting representation bounds into depth and branching bounds. They are not counts of reachable positions, average search workloads, or tight Shannon numbers.

### 9.6 Why the three-state compression does not apply

\[
2\cdot3^{N(n)}
\]

counts only empty, black-node, and white-node labels together with the player to move. It simultaneously assumes that:

- line points are uniquely determined by nodes;
- explicit edges are uniquely determined by nodes;
- resignations, consecutive skips, and history need not be represented;
- every move rebuilds all connections according to a unique closure rule.

The current implementation violates the first two assumptions, and the complete rules violate the latter two as well. The formula therefore belongs only to a separately defined idealized variant with a proved unique closure; it must not remain labeled as a “no-Superko equivalent compression” of the current game.

## 10. NP, NP-hardness, and Higher Complexity

### 10.1 Define the problem first

Complexity classes describe decision languages. The phrase “a legal input state” also conflates local consistency with actual reachability, so at least four problems should be separated:

1. \(\textsc{START-LIFELINE-WIN}\): the input contains only unary \(n\) and a constant number of start parameters, and play begins from the standard initial state;
2. \(\textsc{POSITION-LIFELINE-WIN}_{\mathrm{syn}}\): the input is
   \[
   (n,\sigma,\mathbf E,\tau,R,c,H)
   \]
   plus a designated player and is required only to satisfy local type and consistency constraints;
3. \(\textsc{POSITION-LIFELINE-WIN}_{\mathrm{reach}}\): the input is promised reachable from the standard start, with \(H\) exactly equal to the set generated by a legal history;
4. \(\textsc{HISTORY-LIFELINE-WIN}\): the input is an explicit legal action transcript, which the engine replays to construct the state and \(H\).

Each asks whether the designated player has a strategy that wins strictly against every opponent strategy. A three-player input must additionally specify utilities and a coalition model.

The START version has only a constant number of instances at each length and no natural position field in which to encode an arbitrary source instance. Gadget reductions should target a POSITION or HISTORY problem. A reduction that simply presets nodes, edges, or arbitrary history bans proves at most the syntactic-position version. A reachable-position result must exhibit and prove a polynomial-length legal construction history; if the target is the HISTORY version, that transcript must also be part of the output encoding.

The actual program caps \(n\) at 15 and therefore defines only a finite family. The asymptotic statements below remove this cap and use an explicit polynomially expanded encoding—for example, unary \(n\) with sparse edge lists, or a dense board and edge bit vector. They represent \(H\) explicitly or through an explicit transcript and do not cover a different succinct problem in which a circuit implicitly represents an enormous \(H\).

### 10.2 Currently provable membership upper bounds

Choose a canonical dense working representation without the history set. Its length is

\[
s=\Theta(Q(n))=\Theta(n^3).
\]

Hence

\[
P_m(n)\le2^{O(s)},
\qquad
D_m(n)\le2^{O(s)}.
\]

Let the full input length be \(L\). Every encoding above satisfies \(s=O(\operatorname{poly}(L))\); the stronger relation \(L\ge s\) holds only when the input explicitly fills all potential edge bits in a dense representation. Even if the input history is small, a future path may accumulate \(2^{O(s)}\) keys. A depth-first Minimax search can use one rollbackable global history set for the current branch, an exponentially deep action stack, and a polynomial-size working position, giving all explicit-input versions the safe bound

\[
\boxed{\textsc{LIFELINE-WIN}\in\mathrm{EXPSPACE}}.
\]

Fully expanding the tree, including per-transition computation, gives

\[
\boxed{\textsc{LIFELINE-WIN}\in 2\text{-}\mathrm{EXPTIME}}.
\]

The exponents here are polynomial in \(L\). EXPSPACE is the more informative space-membership statement. Neither is a completeness result, and neither silently solves validation of the reachability promise.

### 10.3 One-step and territory computation

Given an explicit \(H\), deciding the legality of a candidate placement does not require territory computation: connections, edge severing, BFS, reconnection, and Superko lookup can all be performed in time polynomial in the input representation.

The current territory implementation, however, materializes all shortest paths between a pair of vertices at once. The number of shortest paths in a six-neighbor graph can grow exponentially. Let \(N=N(n)\). A safe coarse bound is

\[
T_{\mathrm{territory}}(n)
\le
O(N^5 6^N)
=2^{O(n^2)}.
\]

The current implementation's peak memory usage can likewise be \(2^{O(n^2)}\). A streaming DFS enumeration could reduce this to polynomial working space without changing enumeration order or the greedy choice, although the time could remain exponential.

Territory does not affect placement legality, but it does affect cache updates in the public playMove operation and the terminal winner. Complexity arguments must distinguish the “rules-legality transition” from “updating the score cache with the current algorithm.”

### 10.4 What cannot currently be claimed

| Proposition | Current status |
|---|---|
| Candidate-placement legality | In P |
| Explicit-position/history two-player forced win | In EXPSPACE and in \(2\)-EXPTIME |
| Belongs to NP | Unproved, and not the natural default |
| NP-hard | Unproved |
| PSPACE-hard | Unproved |
| EXPTIME-hard / EXPSPACE-hard | Unproved |
| PSPACE-complete or other completeness result | Unproved |
| Abstract guarded-graph variant in Section 10.7 | PSPACE-complete, but not the current rules |

“A winning move can be verified” does not prove that forced win belongs to NP. A forced win must cover every opponent response; its certificate is generally a strategy tree, not one cooperative play trace, and the current depth itself can be exponential.

### 10.5 Pass-elimination lemma

Let \(q\) be a nonterminal two-player state with player \(a\) to move. Freeze the grid, explicit edges, history, and resignation set, and allow only Passes. If the resulting terminal position is a strict win for \(\bar a\), then:

> Pass cannot be the first action of a forced-win strategy for \(a\).

If \(a\)'s Pass itself reaches the consecutive-skip threshold, the same frozen scoring terminal is reached immediately. Otherwise it becomes \(\bar a\)'s turn: \(\bar a\) may voluntarily Pass if a placement exists, and the engine automatically skips \(\bar a\) if none exists. In every case the skip sequence finishes without changing the scored board, so \(\bar a\) wins. Resign loses immediately. ∎

A hardness reduction therefore need not remove Pass syntactically. It is enough to maintain the tempo invariant

\[
\operatorname{Winner}(\operatorname{Freeze}(q))
=
\text{the nonmoving player}.
\]

One natural target is for every simulated placement to give a strict lead to the player who just moved, leaving the next player temporarily behind.

### 10.6 A current-engine witness for two-ply tempo and Col conflict

This is not a complete reduction, but it proves that tempo scoring and the three-point restriction can coexist in a genuinely reachable current-engine state. For \(n=7\), play

\[
B(1,0),\quad W(2,4),\quad B(1,3),\quad W(4,0).
\]

It is Black's turn with areas \((5,8)\). Let

\[
u=(0,4),\qquad v=(1,4).
\]

Direct exhaustive checks give:

1. both \(u\) and \(v\) are legal for either color; if Black Passes, White can Pass and win \(8:5\);
2. after \(B(u)\), the areas are \((9,8)\); \(v\) is now unit-adjacent to both the new Black node \(u=(0,4)\) and the existing Black node \((1,3)\), so the three-point restriction makes \(v\) illegal for Black while it remains legal for White;
3. if White now Passes, Black can Pass and win \(9:8\);
4. after \(W(v)\), the areas are \((9,11)\), so the lead again belongs to the player who just moved.

This local state simultaneously implements same-color exclusion/opposite-color permission on adjacent candidates and two consecutive lead flips. Other legal actions remain elsewhere, and the structure has not been proved tileable, branchable, or indefinitely composable. It is a finite witness, not a hardness gadget.

### 10.7 A fully provable abstract PSPACE-complete core

Define a deliberately different variant, \(\textsc{GUARDED-GRAPH-LIFELINE-NORMAL}\). Its board is an input graph; only designated candidate vertices may be played; each candidate \(v\) is adjacent to two noninteracting private leaf guards \(g_{v,B},g_{v,W}\), preset as Black and White nodes; the current three-point restriction is retained, but long-range lines, attacks, and territory are removed; normal play declares the player with no legal move the loser.

Reduce from uncolored Col by identity on candidate vertices:

- initially, candidate \(v\) has exactly one isolated same-color guard for color \(c\), so it is legal and connected;
- if an adjacent source vertex \(u\) has already been occupied by \(c\), then \(v\) is adjacent to both \(g_{v,c}\) and \(u\), making it illegal for \(c\) under the three-point rule;
- an opponent-colored \(u\) adds no same-color neighbor and does not block \(c\) at \(v\);
- occupied candidates cannot be replayed.

The two game trees are isomorphic. Play lasts at most the number of candidates, placing the variant in PSPACE; Col's PSPACE-hardness makes it PSPACE-complete.

This proves that the combinatorial core of the three-point restriction can carry PSPACE-hardness, not that current LIFELINE does. The variant changes the board, move mask, connection rule, and terminal utility. Fenner et al. first proved PSPACE-hardness of Col on uncolored general graphs in 2015; Burke and Tennenhouse proved Col PSPACE-complete on triangular grid graphs in 2025.

### 10.8 Superko-inertness lemma and the minimal remaining gaps

Superko can be neutralized in a monotone construction. If every simulated move leaves a node on a previously empty private marker that can never later be deleted, physical positions after distinct simulated steps differ; their complete hashes differ as well. Provided the initial \(H\) contains none of these successors, Superko never fires on the simulated path.

Lifting triangular-grid Col to the complete current rules still requires six independent lemmas:

1. **Action isolation.** Every empty point, friendly line point, and enemy line point outside the logical candidates must be illegal or provably immediately losing.
2. **Long-range-edge isolation.** Private guards must not form cross-gadget collinear edges, occupy candidates, or create unintended attack ports.
3. **Reachable guards.** Guards and isolation structure must be constructible from the two real bases by a polynomial-length legal history and remain root-connected.
4. **Composable tempo.** The two-ply flip of Section 10.6 must extend through arbitrary branches and depths without cross-gadget changes from greedy territory tightening.
5. **Terminal correspondence.** A no-move loss in source Col must match the actual area winner after consecutive Passes; automatic skips must not reopen the simulation.
6. **History encoding.** For the reachable version, the reduction must construct and prove a real action sequence that generates exactly the \(H\) being used; the HISTORY version must additionally output that transcript explicitly.

Two private guards also consume two of a candidate's six neighboring slots, leaving only four direct ports. If the triangular-grid Col source uses degree-six vertices, a degree-reduction or port-copy gadget is additionally required.

If action isolation, reachable guards, permanent markers, arbitrarily composable tempo, terminal correspondence, and any necessary degree-reduction or port-copy structure can all be built in polynomial size, Triangular-Grid-Col immediately yields

\[
\textsc{POSITION-LIFELINE-WIN}_{\rm reach}
\text{ is PSPACE-hard},
\]

and hence NP-hard. Those lemmas are not yet proved. The strongest honest conclusion is: **there is a rigorous PSPACE-hard abstract core and a real local witness, but no hardness lower bound for the complete current rules.**

### 10.9 A strict comparison with known Go results

Go is one of the closest reference games, but “the complexity of Go” is not a single rule-independent result. At minimum, the following rules must be distinguished:

- **Japanese basic/simple ko:** only an immediate recapture that restores the preceding position is forbidden; longer cycles can still occur, and a triple-ko cycle may be declared no result.
- **Positional superko (PSK):** producing any board coloring that has appeared before is forbidden, regardless of the next player.
- **Situational superko (SSK):** a repetition occurs only when both the board coloring and the next player agree with an earlier situation.
- **Current LIFELINE:** a key contains the next player, the resignation set, five-state grid points, and each player's explicit edges. It is therefore situational-like but differs from Go SSK, and neither Pass nor Resign writes to \(H\).

Known results must be cited under their original problem and rules conventions:

| Object and rules convention | Known rigorous result | What it says about LIFELINE |
|---|---|---|
| Arbitrary given \(n\times n\) Go position | Lichtenstein–Sipser proved winner determination PSPACE-hard; their paper did not prove PSPACE-completeness [6] | Arbitrary-position gadgets are a viable research route, but the lower bound cannot be transferred |
| The Japanese-rules/basic-ko model used by Robson | The 1983 result is traditionally stated as EXPTIME-completeness of generalized forced win with an arbitrary preset position as input [9,11] | The proof depends on Go liberties, capture, ko banks, and cycling rules, and does not apply to LIFELINE Superko |
| Generalized Chinese/superko Go whose input position is only a stone configuration with no prior forbidden history | A 2015 survey records PSPACE-hardness and membership in EXPSPACE, with the tight classification open in that survey [11] | This is closest to the EXPSPACE membership proved here, but it is not the same input problem as an arbitrary explicit \(H\) |
| The Go ladder decision problem LADDERS | Deciding whether a given ladder works is PSPACE-complete [10] | A natural local mechanism can carry full complexity; the precise ko convention is the paper's, and its ladder gadgets cannot be reused here |
| Empty-board \(5\times5\) PSK Go with komi \(=24.5\) | A complete computer proof of a first-player full-board win was given in 2024 [13] | This solves one finite START instance; it is not a generalized hardness result |
| Static legal \(19\times19\) board colorings | Approximately \(2.081681994\times10^{170}\) [12] | This omits the player to move, Pass count, and \(H\), so it is not a complete rules-state count |

Robson's EXPTIME-completeness result cannot be cited after merely replacing “basic ko” by “superko”; the 2015 survey also notes that traditional Japanese rules do not give one completely uniform formal semantics for every cycling and terminal case. Robson's 1984 general exponential-space lifting theorem applies only to a class of known EXPTIME-complete games satisfying its construction premises [14]; without a reduction to a specific Go or LIFELINE ruleset, it does not imply EXPSPACE-hardness. This document has not confirmed a safely citable tight-classification result for PSK after the 2015 survey. It therefore reports the historical status from that survey and does not state “open” unconditionally as a theorem valid through every later year.

For Go of side length \(n\), let \(N_G=n^2\). The number of PSK board keys satisfies

\[
P_G^{\mathrm{PSK}}\le3^{N_G},
\]

whereas SSK satisfies

\[
P_G^{\mathrm{SSK}}\le2\cdot3^{N_G}.
\]

Under a two-player PSK ruleset in which Pass does not trigger repetition checking and two consecutive Passes end the game, let \(c_G\in\{0,1,2\}\) and take

\[
\rho_G=3|H_G|+c_G.
\]

A Place adds a new key and resets \(c_G\) to zero, while a nonterminal Pass increases \(c_G\). Hence Go's complete augmented graph is likewise a DAG. There are at most \(P_G-1\) successful placements, an explicit path history occupies \(2^{O(n^2)}\) space, and the naive tree gives safe EXPSPACE and double-exponential-time upper bounds. By contrast, the current-position projection under Japanese simple ko can contain long cycles, so this rank proof does not apply to it.

This is qualitatively the same structure as LIFELINE but at a different scale. Go keys are determined primarily by \(n^2\) intersections, whereas LIFELINE must additionally encode \(\Theta(n^3)\) potential long-range explicit edges. The respective safe key bounds are therefore

\[
2^{O(n^2)}
\quad\text{and}\quad
2^{O(n^3)}.
\]

This is only a comparison of representation upper bounds. It neither says that LIFELINE has been proved “harder” than Go nor supplies any hardness lower bound.

**Weak Pass stealing in zero-komi PSK Go.** For empty-board, zero-komi, area-scoring Tromp–Taylor PSK Go, the proof in Section 7.7 can be reused in a cleaner form. Suppose for contradiction that the second player, White, has a strict winning strategy. Black first Passes. If White also Passes, the result is a draw, so White must play \(W(v)\). The actual PSK history set is

\[
H_A=\{\varnothing,W(v)\}.
\]

Counterfactually, Black plays \(B(\theta v)\), the corresponding move under a color-exchanging board automorphism, directly from the empty board. Exchanging the colors and player to move then gives

\[
\widehat\Theta(H_C)=\{\varnothing,W(v)\}=H_A.
\]

Tromp–Taylor area score is the set-theoretic definition “friendly stones plus empty points connected only to that player.” It is strictly invariant under board automorphisms and color exchange, and two Passes on the empty board give a draw. White wins strictly in the counterfactual play by the assumed strategy, so the color-exchanged actual terminal must be a strict Black win. This constructs a Black strategy that defeats the alleged White strategy, contradicting its claim to beat every Black strategy. Finiteness and determinacy therefore imply that Black is at least nonlosing. Thus

\[
\boxed{\text{In empty-board zero-komi PSK Go, the second player has no strict winning strategy.}}
\]

This theorem does not require the premise that “an extra friendly stone can never hurt.” Conversely, it shows that **Superko and Pass do not automatically destroy strategy stealing; what matters is whether the two simulated histories are coupled exactly.**

SSK is closer to LIFELINE because its key also contains the player to move. The first-Pass coupling leaves the two bare empty-board situations as its history symmetric difference:

\[
D_0=\{(\varnothing,B),(\varnothing,W)\}.
\]

The suicide convention must now be separated explicitly.

**Pass-exempt SSK with suicide forbidden.** After every legal Place, the newly played stone remains on the board, so the candidate situation cannot be empty and can never hit \(D_0\). Under the same zero-komi, symmetric area-scoring, and two-Pass termination assumptions, the weak Pass-stealing proof therefore extends to this SSK variant as well. It is incorrect to say generically that “SSK breaks the proof.”

**Pass-exempt SSK with suicide allowed.** The history difference can genuinely change legality. On the minimal empty \(1\times1\) board, the initial history contains \((\varnothing,B)\). In the actual sequence Black first Passes; White then plays the only point and suicides, producing the empty board with Black to move, namely \((\varnothing,B)\), so SSK forbids it. Counterfactually, Black plays the only point directly and suicides, producing \((\varnothing,W)\), which has not appeared and is legal. The same color-exchanged reply is therefore legal on only one side and the reflected simulation diverges. This proves SSK legality divergence, not a value reversal. On a larger connected board, the same kind of empty-board key can be produced by expanding one connected friendly block until the whole board has one last liberty and filling that liberty to self-capture the entire block.

Go-search literature calls the phenomenon in which the current board is the same but different histories change legality or value Graph History Interaction (GHI) [13]. GHI, however, still supplies only the legality/strategy-divergence mechanism of Section 7.10. Unless a construction forbids the unique value-preserving reply or changes the Minimax value, it does not by itself prove that strategy stealing has failed.

Go ko threats provide the appropriate analogy as well. Simple ko forbids an immediate recapture, so a player can first create a distant threat that must be answered and then recapture. Although PSK and SSK inspect the entire history, the distant exchange changes the complete board key, so a local recapture may still be legal until the complete key truly repeats. LIFELINE's 13-move witness likewise has the form “direct restoration of the old kernel is forbidden, so the winning player must first play elsewhere.” Its three-point restriction, long-range edges, and root-connected deletion are not Go liberties, captures, or ko, however. It is only a history-detour analogy, not a Go gadget.

Finally, the set-theoretic Tromp–Taylor area score is inherently reflection-equivariant. A fixed komi awarded to White intentionally breaks color-exchange utility symmetry, while Japanese territory scoring must also account for prisoners, dead-stone agreement, and resumption conventions. LIFELINE's DRAW\(\to\)BLACK counterexample in Section 7.8 comes from representation order inside the same raw algorithm and is therefore a different kind of implementation-level nonequivariance. It cannot be excused by saying that “Go also has komi.”

## 11. The Current AI and a Reinforcement-Learning Perspective

### 11.1 Scope, search depth, and search width

Automatic AI is used only in local two-player games. UI difficulty levels correspond to depths

\[
\text{Easy}=2,\qquad
\text{Normal}=3,\qquad
\text{Hard}=4.
\]

Hints always use depth 2. At every search node, legal placements are first divided into three tiers:

1. attacks that overwrite an enemy line point;
2. candidates unit-adjacent to a friendly line point;
3. all other placements.

Within each tier, the original grid-point enumeration order is preserved, and only the first 20 moves of the merged list are retained. Normal AI returns the five highest-scoring moves, but the UI executes only the first. It is therefore a deterministic fixed-depth, fixed-width heuristic Alpha–Beta Minimax, not a complete game-tree solver.

### 11.2 Evaluation function

Fix AI player \(a\). Define the node difference

\[
\Delta_N
=
|N_a|-\sum_{b\ne a}|N_b|,
\]

and the physical-coverage difference

\[
\Delta_C
=
(|N_a|+|L_a|)
-
\sum_{b\ne a}(|N_b|+|L_b|).
\]

The AI also computes a fast BFS reachable-space measure \(\widehat T_a\): the search starts simultaneously from all friendly nodes and line points and treats only enemy nodes and line points as obstacles. This is not the official contour–tightening–flood-fill territory.

Let \(b^\star\) be the opponent with the most nodes and define

\[
\Delta_T=\widehat T_a-\widehat T_{b^\star}.
\]

Let \(Q_a\) be the number of enemy line points that can currently be attacked legally. Let \(K_a\) be the sum over friendly nodes of \(+1\) when the node is connected to its base in the explicit-edge graph and \(-1\) otherwise. The leaf heuristic is

\[
h_a
=
15\Delta_N
+8\Delta_C
+20\Delta_T
+12Q_a
+10K_a.
\]

The Worker disables official territory-cache updates, so search relies on this reachable-space proxy rather than on the final winning area.

### 11.3 Gaps relative to the complete rules

The current AI has the following theoretical limitations:

- its search action set contains only Place, omitting voluntary Pass while legal placements remain and omitting Resign;
- it manually simulates a skip only when legalMoves is empty, and that logic is not fully equivalent to the real Normalize process;
- state snapshots copy the board, explicit edges, history, skip count, and territory cache, but omit resignedPlayers;
- terminal leaves still return the heuristic rather than reading the true winner, so even a forced win visible within the finite horizon is not guaranteed to be selected;
- MAX and MIN alternate mechanically by recursive depth rather than using the actual currentPlayer after playMove; if an opponent is automatically skipped and the same player moves twice, control is modeled incorrectly;
- the 20-move truncation has no safety proof that it retains an optimal move;
- automatic AI is UI-restricted to two-player games, but hints in a three-player game may still call binary Minimax; this is neither Max-N nor strict Paranoid Search.

The correct description of the current AI is therefore “truncated heuristic search that uses the real engine to generate placement successors.” Protected zones, the actual three-point restriction, explicit-edge attacks, cascading deletions, and Superko all enter successor generation; but Pass, Resign, true terminal utility, control after automatic skipping, and three-player rationality are not searched faithfully.

### 11.4 Toward a more faithful solver

At minimum, an AI consistent with this formalization should:

1. add Place, Pass, and Resign to the action set;
2. process skipping through the public rules transition or a unified Normalize operation;
3. choose MAX or MIN from the actual currentPlayer;
4. use the true terminal utility \(+1,0,-1\);
5. include resignedPlayers in snapshots;
6. make width truncation configurable and retain a “complete mode”;
7. use Max-N, Paranoid, or equilibrium search under an explicitly specified utility in three-player games;
8. use bridges, articulation points, root edge-connectivity, and potentially deleted components of the explicit-edge graph as structural features.

### 11.5 A faithful reinforcement-learning environment is an augmented Markov game

Fix the rules configuration

\[
\kappa=(n,m,\text{bases},\text{turn order},\text{starting player}).
\]

The environment's internal state must be the complete \(q\) defined in this document. At every nonterminal decision state, the raw action space is

\[
\mathcal A_n
=
\{\operatorname{Place}(v):v\in\mathcal V_n\}
\cup
\{\operatorname{Pass},\operatorname{Resign}\}.
\]

An implementation may use \(N(n)+2\) indices for each \(n\), or fix 122 indices for the current maximum \(n=15\) and mask nonexistent points on smaller boards. The real engine must produce the legal-action mask entry by entry, accounting for out-of-board points, occupied nodes, protected zones, the three-point restriction, failure to connect, attack rules, Superko, resignation, and termination. The network must not be asked to infer legality.

One RL `step` should be defined as

\[
q'=T(q,a)=\operatorname{Normalize}(F(q,a)).
\]

Automatic skipping is deterministic Normalize behavior after an action. It is neither an action available to the agent nor an additional discounted step. A timeout Pass generated by the UI turn timer belongs to the UI or tournament-protocol layer; unless time controls are studied explicitly, it is not part of the core-rules MDP.

Following the standard finite-episode reinforcement-learning formulation [15], the most faithful two-player reward is zero at every intermediate state, with only the terminal return

\[
r_B=u_B(q_T),
\qquad
r_W=-r_B,
\qquad
\gamma=1.
\]

The complete augmented graph is a finite DAG, so the undiscounted return is well-defined. Choosing \(\gamma<1\) introduces an artificial preference for winning sooner and delaying defeat and no longer represents the current rules exactly. Section 6.8 shows that Resign may be removed from two-player optimal training; Pass must remain.

### 11.6 Theorem: an observation containing only the current board and edges is not Markov

Define the history-blind observation

\[
o_X(q)=(\sigma,\mathbf E,\tau,R,c,z),
\]

which retains every field of the current rules kernel while deleting \(H\). The two histories reachable from the standard initial position in Section 7.10 satisfy

\[
o_X(q_A)=o_X(q_B),
\]

but White's \(W(1,1)\) is legal only in \(q_A\). Consequently,

\[
M(q_A)\ne M(q_B).
\]

The process observed through \(o_X\) is therefore strictly not an MDP: even the available-action set is not determined by the observation. A feed-forward policy receiving only the current grid, explicit edges, and player to move faces state aliasing. Supplying the current legal mask prevents an illegal move on this step, but there is no reason to believe that the mask is sufficient to predict deeper future values.

There are three faithful approaches:

1. retain the exact \(H\) in every environment and search state;
2. give a recurrent network or Transformer the complete action and automatic-skip event sequence, because the deterministic engine can replay \(q_0,a_0,\ldots,a_{t-1}\) to reconstruct \(q_t\) exactly;
3. if only a finite window or compressed observation is supplied, define the task explicitly as a POMDP and accept that the policy is approximate.

Legality itself must not rely on a Bloom filter with possible false positives or on a collision-prone approximate hash: one false positive is equivalent to inventing a Superko prohibition. A neural network may encode history approximately for value estimation, but the final action mask must be adjudicated by an engine retaining the exact `historyHashes` set.

Exact search, replay storage, and deduplication should use at least

\[
K_{\mathrm{full}}(q)
=
\bigl(
\kappa,
K_{\mathrm{position}}(\tau),
\operatorname{sort}(H),
c,z
\bigr).
\]

The current `_computeStateHash` already includes the grid, every player's explicit edges, the next player, and \(R\), but it does not include the complete \(H\), \(c\), or \(z\). `turnCount` is irrelevant to the core rules, and the territory cache is recomputable from the rules state; neither should replace these fields.

### 11.7 Value backups must follow the actual controller rather than alternate signs mechanically

After a Place, Normalize may automatically skip an opponent with no legal placement and give the same player two consecutive decision turns. The common shortcut for strictly alternating games—negating the value whenever tree depth increases by one—is invalid here.

The safest two-player search always predicts \(v_B\) from Black's fixed perspective: maximize at nodes with \(\tau=B\), minimize at nodes with \(\tau=W\), and pass \(v_B(q')\) along an edge without negating it by depth. If a network outputs a scalar from the current controller's perspective, it should change perspective only when \(\tau(q')\ne\tau(q)\); it must not negate the value when automatic skipping leaves the same player in control. Three-player play should back up the vector

\[
\mathbf v(q)=(v_B(q),v_W(q),v_P(q)),
\]

with the actual controller at each node optimizing that controller's own component.

This is not merely an abstract risk. The current `AIEngine.js` alternates MAX and MIN mechanically by recursion depth and therefore searches under the wrong controller on automatic-skip branches. Every AlphaZero-style MCTS, PPO rollout, and offline-return generator must read control from the `currentPlayer` returned by the engine.

### 11.8 Neural representations suited to the current rules

Treating the triangular board only as an image discards its most important dynamic topology. A more faithful relational graph or hypergraph representation should include at least:

- a \((2m+1)\)-state one-hot vector, triangular coordinates, base marker, and protected-zone marker for every grid point;
- the fixed six-neighbor edges;
- each player's actual explicit long edges, annotated with owner, axis, and length;
- global features such as the current player, \(c\), \(R\), board size, and player count;
- a history encoding or the complete replayable action sequence.

To expose possible future co-axial connections, the network need not receive all \(Q(n)=\Theta(n^3)\) endpoint pairs explicitly. Introduce \(n\) line hypernodes for each of the three axis families and connect each grid point to the three line hypernodes containing it. The total number of incidences is only

\[
3N(n)=O(n^2),
\]

and two message-passing steps allow points on the same axis to exchange information. Actual explicit edges remain a separate dynamic relation type. This is a sparse learning representation, not a return to a three-state-node model of the rules state.

The historical JSON hashes themselves are semantically opaque strings and are poor direct neural inputs. More reasonable approximations encode the sequence or set of past position tensors, or reconstruct history through recurrent state. Whatever summary is used for value estimation, the environment must still retain the exact set for Superko adjudication.

Symmetry augmentation also requires care. The non-scoring transition kernel in Section 7.6 supports the color-exchanging reflection \(\Theta\), but the current winner has a `DRAW → BLACK` counterexample. Before scoring is repaired, \(\Theta\) may be used to test policy and transition consistency, but reflected terminals must not be labeled unconditionally with color-exchanged equal values. Doing so would inject contradictory targets into the value network.

### 11.9 Reward shaping and reward hacking

Sparse terminal rewards are most faithful but may be sample-inefficient. A dense reward that rigorously preserves optimal policies is potential-based shaping [18]. For each player \(p\), choose \(\Phi_p\) that is zero on every terminal state and define

\[
r'_p(q,a,q')
=
r_p(q,a,q')
+\Phi_p(q')-\Phi_p(q).
\]

The total return of a game differs from the original return only by the fixed constant \(-\Phi_p(q_0)\), so policy rankings from a fixed initial state are unchanged. Two-player zero-sum training should additionally impose \(\Phi_W=-\Phi_B\). Node count, the base-connected component, attack opportunities, and a symmetrized territory proxy may all enter \(\Phi\), but only through this difference form and with zero potential at terminal states.

The current AI's `fastTerritoryBFS`, node increments, and per-step raw-area increments do not automatically satisfy this condition. Rewarding them directly at each step can encourage reversible score farming, delayed termination, or sacrificing the true outcome for a proxy. In particular, the current greedy territory algorithm is not reflection-equivariant. If the objective is to defeat the current implementation faithfully, exploiting that bias is legitimate optimal behavior. If the objective is to study an ideal fair game, one should first select an equivariant scoring rule from Section 7.9 and then generate training labels. A strong agent exposing a scoring defect reveals an environment-specification problem, not an RL failure.

### 11.10 Algorithm selection

| Method | Applicability | Main current boundary |
|---|---|---|
| Exact backward induction, Alpha–Beta, proof-number search | Ground-truth oracle for small solvable suffixes | State and history explosion prevents coverage of large boards |
| AlphaZero-style PUCT + relational GNN [16] | Preferred main research path for the deterministic, perfect-information, two-player zero-sum version | Must include Pass, the complete action mask, real control, and a history-aware transposition key |
| Masked PPO [19] | Easy search-free baseline; can use recurrent policies | Nonstationary self-play, sparse terminal reward, and usually lower sample efficiency than planning methods |
| DQN / distributed Q-learning | Very small boards or restricted-action experiments | Large action set, masking, long horizons, nonstationary self-play, and history aliasing are all unfavorable |
| MuZero [17] | Can test whether a learned latent state compresses the complex transition | An exact simulator already exists; learning the model first usually adds error rather than solving the primary bottleneck |
| CFR-family methods | Small-board extensive-form strategy audits | The current game is sequential and perfect-information, so it lacks the imperfect-information structure that would make CFR the first choice |
| Max-N, vector MCTS, MAPPO, PSRO [20] | Three-player research after utilities are specified | They solve different equilibrium or coalition models and cannot be compared using one undifferentiated scalar win rate |

An AlphaZero-style method is not a theorem of convergence to optimal play here; it is simply the engineering starting point best matched to the exact simulator, legal mask, and graph structure. MuZero is better reserved as a later comparison for history compression than as the first environment.

### 11.11 Curriculum and falsifiable evaluation

A sensible dependency order is:

1. **Environment consistency.** Implement public `reset/clone/legalActionMask/step/fullStateKey` operations; snapshots must include `resignedPlayers`, and every transition must call the real `playMove/skipTurn/resignPlayer`.
2. **Small oracle data.** Begin with reachable \(n=5\) endgames and node-limited \(n=6\) subtrees. Label \(V\) and the complete set of optimal actions with full Minimax rather than imitating the current heuristic AI.
3. **Baselines.** Compare random play, the current depth-2/3/4 AI, Masked PPO, and an AlphaZero-style agent; report multiple random seeds and both colors.
4. **Curriculum.** Increase board size through \(n=5\to6\to7\), then test 9, 12, and 15. Gradually increase the frequency of attacks, long edges, and long-history states, while retaining an old-policy pool to reduce self-play forgetting.
5. **Three-player phase.** Train three-player agents only after fixing a utility vector, coalition assumptions, and equilibrium metrics.

The existing counterexamples directly form a unit benchmark that average win rate cannot hide:

| Benchmark | Required behavior |
|---|---|
| `HISTORY-MASK` | Produce different Place masks for the same-kernel/different-history states and identify the Superko divergence at \(W(1,1)\) |
| `CYCLE-CUT` | Reject \(W(0,3)\), which would close the eight-step cycle in the 13-move state |
| `PASS-PRESSURE` | Choose the uniquely winning Pass rather than the unique Place in the state from Section 7.5 |
| `CONTROL-SKIP` | Preserve the same controller after the opponent is automatically skipped; do not negate the backed-up value incorrectly |
| `SYMMETRY-DEFECT` | Under the current rules, reproduce DRAW in the original and BLACK in the reflection; after scoring is repaired, the discrepancy should vanish |
| `EXACT-ENDGAME` | Match both the root value and the complete optimal-action set on fully solved subtrees, rather than only one preferred move |

Final reports should include at least win/draw/loss rates with confidence intervals, paired color-swapped results, performance against the current AI and a historical policy pool, small-endgame exploitability or optimal-action recall, value calibration, Pass accuracy, probability mass assigned to illegal actions before masking, mean game length, and search nodes or time. Elo and self-play win rate measure relative strength only; they do not replace small-board optimality evidence.

Recommended ablations compare `X-only + mask`, recurrent encoding of the complete sequence, and explicit-history encoding; sparse terminal reward versus potential-based shaping; and image CNNs, ordinary GNNs, and line-hypernode relational GNNs. Each condition should use at least five training seeds with fixed training budgets, opponent-pool snapshots, and evaluation endgames.

### 11.12 Additional boundaries for three-player multiagent learning

A three-player agent must first select a cardinal utility convention from Section 6.2. A scalar value head with “maximize for the current player” cannot simultaneously express the interests of the other two players. More faithful choices are a vector critic, Max-N or vector MCTS selecting the actual controller's component, or PSRO constructing an empirical metagame over a policy population. Paranoid Search forcibly merges the other two players into one coalition; it solves a derived two-player zero-sum problem rather than the original game of three independent optimizers.

Independent PPO faces two simultaneously changing opponents and is prone to cycles and strategy forgetting. A centralized critic or historical policy pool can mitigate these problems but cannot substitute for a utility and equilibrium definition. Evaluation should report every seat, player permutations, robustness to temporary two-player coalitions, and regret or NashConv-type metrics in the empirical game rather than only aggregate win rate.

After the first player resigns, the remaining phase is not a clean new two-player game. The resigned player's nodes, lines, explicit edges, and protected zone remain on the board and continue to block play; only that player ceases to act and is removed from winner scoring. An environment snapshot that omits \(R\), as the current Worker does, merges these states incorrectly.

## 12. Remaining Research Boundaries

The most valuable next questions are not larger upper bounds, but tighter descriptions of reachable structure.

1. **Reachable explicit-edge count.** The current bound uses all \(Q(n)=\Theta(n^3)\) potential edges. It remains unknown whether the three-point restriction, blocking, and first-node crawling reduce the reachable edge sets to a smaller order.
2. **Hardness reduction.** Along the Triangular-Grid-Col route, close action isolation, long-range-edge isolation, reachable guards, arbitrarily composable scoring tempo, and terminal correspondence. Until then, the abstract PSPACE-complete core is not a lower bound for the current rules.
3. **Pressure classification.** A real reachable state with \(Z=2\) is now known. Classify the structures that create pressure, determine the minimum history length, and study systematic zugzwang constructions in the no-Pass variant.
4. **History-value reversal.** Two real histories now reach the same rules kernel while making \(W(1,1)\) legal on only one side, and an exact loop witness reduces the winning-action set from three moves to two. To upgrade “the copied reply fails” to “the strategy value fails,” one must still find \(V(X,H^-)\ne V(X,H^+)\), or prove that the forbidden action is the unique nonlosing or winning reply.
5. **Symmetry.** Exact area and full winner equivariance are both refuted by Section 7.8. Prove or refute the weaker implication “White win \(\Rightarrow\) Black at least nonlosing after reflection,” and choose and implement a strictly equivariant score.
6. **Territory correctness.** Prove the “current coverage contains no enemy element” invariant relied upon by inward scheme A, or add the check explicitly to the implementation.
7. **Tight complexity.** EXPSPACE is only a membership upper bound. A tight class requires a lower-bound reduction, perhaps first establishing PSPACE-hardness or EXPTIME-hardness for a restricted variant.
8. **Empirical search space.** Use reachable-state enumeration, transposition-table statistics, and real play records to measure average branching factor, attack rate, automatic-skip rate, and edge density. Worst-case upper bounds must not be presented as typical values.
9. **Conditional decomposition.** For a nontrivial reachable region, prove that action locality, the root-connectivity interface, score additivity, and a Superko-sufficient history signature remain closed under every successor. Until then, neither nimber XOR nor an ordinary disjunctive sum is justified.
10. **Tempo spectrum.** Compute \(U,D,Z\) and the placement-tax threshold on small fully solvable subtrees, studying how they vary with board size, history, and boundary interface without presenting the derived tax spectrum as standard Conway temperature.
11. **A sufficient statistic for history.** Determine whether an exact summary smaller than the complete \(H\) can make both current legality and future value Markov. The current action mask alone has no sufficiency proof.
12. **Reinforcement-learning oracle.** Establish a fixed set of reachable endgames, complete optimal-action sets, and exploitability evaluations before comparing history-blind, recurrent-history, and explicit-history networks. No formal training result currently exists.
13. **Three-player equilibrium.** Fix cardinal utilities, coalitions, and tie-breaking before comparing Max-N, vector MCTS, MAPPO, and PSRO. The different models must not be collapsed into one “AI win rate.”
14. **Divergent rule objectives.** State whether training aims to defeat the current implementation with its scoring nonequivariance or to study the repaired fair rules. The optimal strategies and symmetry-augmentation labels may differ.

## 13. Conclusion

Current LIFELINE can be completely described as a finite, history-dependent graph game with state

\[
q=(\sigma,\mathbf E,\tau,R,c,H,z).
\]

Once a winner utility is specified, the two-player version is a finite zero-sum extensive-form game; the three-player version is a multiplayer game and must not continue to be called two-player zero-sum. Explicit edges raise the faithful position upper bound from \(2^{O(n^2)}\) for a pure-grid model to \(2^{O(n^3)}\). Superko, resignations, and consecutive skips together provide a strict rank for the complete augmented graph, making it a DAG and permitting backward induction.

The explicit-position/history forced-win problem can currently be placed in EXPSPACE, with a naive double-exponential time upper bound. No hardness or completeness claim for the complete current rules is yet justified. What is now complete is a Pass-elimination lemma, a PSPACE-complete abstract Col core, and a current-engine two-ply tempo/same-color-exclusion witness; composability and action isolation remain missing.

On strategy stealing, the three-point rule rigorously refutes action monotonicity of an extra friendly piece. More strongly, the current engine has a reachable \(Z=2\) pass-pressure state: Pass wins while the only placement loses under optimal reply. This proves the maximum Place-vs-Pass action-value reversal, but it does not prove that an extra friendly node lowers the value of an otherwise comparable state; voluntary Pass also keeps “forced to place” false. The weak Pass theorem needs only a one-sided terminal implication. Full winner equivariance is refuted by the ten-placement DRAW\(\to\)BLACK example; the weaker implication and first-player nonloss from the standard start remain open.

The history results are stronger but have a precise boundary. Two histories reachable from the standard initial position arrive at the same rules kernel yet make the same attack Superko-forbidden on only one side; a separate reachable eight-step cycle is cut in the augmented graph by Superko. These witnesses strictly refute treating history-blind move-by-move copying as a universally legal principle. Exact Minimax limits their strength to “the winning-action set shrinks from three moves to two, forcing a detour,” rather than a root-value reversal. The standard first-Pass coupling differs only by bare initial keys that can never be hit, so these witnesses do not break it.

The comparison with Go reinforces the same boundary. Japanese simple ko, PSK, and SSK must be distinguished; in zero-komi Tromp–Taylor PSK Go, weak Pass stealing and first-player nonloss can even be proved rigorously. Go has rules-specific PSPACE-hard, EXPTIME-complete, and local PSPACE-complete results, but its preset positions, liberties, captures, ladders, and ko-bank gadgets cannot be transferred into a LIFELINE lower bound.

The new combinatorial-game perspective adds that the complete \(q\) is a short game amenable to backward induction, whereas the physical rules kernel \(X\) has neither an option set nor a value independent of history. Ordinary nimbers, disjunctive sums, and standard temperature all lack their required premises. What can be used rigorously are \(U,D,Z,d_{\mathrm A},d_{\mathrm V}\) and the derived placement-tax spectrum. Resign can be eliminated by weak dominance in two-player evaluation, whereas Pass both controls the terminal clock and can be the unique winning action.

The reinforcement-learning perspective interprets the same history divergence as strict state aliasing: a feed-forward `X-only` observation is not an MDP. A faithful agent must let the engine retain the exact \(H\), place automatic skipping inside Normalize, back up values according to the actual `currentPlayer`, and use terminal outcomes with \(\gamma=1\) as the baseline. A relational GNN or line-hypernode representation combined with AlphaZero-style search is the preferred engineering route for the two-player version, but it is not a convergence theorem; three-player play requires utility vectors and an explicit equilibrium concept. Formal training and experimental comparisons remain future work, and this document does not present design recommendations as achieved performance results.

The genuine theoretical difficulty is not merely a large number of states, but the simultaneous coupling of four structures: cubic-scale explicit long-range edges, root-connectivity cascade deletion, implementation-defined Superko history, and discrete greedy territory scoring. All subsequent proofs and AI systems must operate on this complete state.

## References

1. J. H. Conway, *On Numbers and Games*, 2nd ed., A K Peters, 2001.
2. E. R. Berlekamp, J. H. Conway, R. K. Guy, *Winning Ways for Your Mathematical Plays*, 2nd ed., A K Peters, 2001–2004.
3. D. Gale, “The Game of Hex and the Brouwer Fixed-Point Theorem,” *American Mathematical Monthly*, 86(10), 818–827, 1979. DOI: 10.2307/2320146.
4. A. K. Chandra, D. C. Kozen, L. J. Stockmeyer, “Alternation,” *Journal of the ACM*, 28(1), 114–133, 1981. DOI: 10.1145/322234.322243.
5. E. D. Demaine, R. A. Hearn, *Games, Puzzles, and Computation*, A K Peters, 2009.
6. D. Lichtenstein, M. Sipser, “GO is Polynomial-Space Hard,” *Journal of the ACM*, 27(2), 393–401, 1980. DOI: 10.1145/322186.322201. This paper is cited only as a methodological example showing that game hardness requires an explicit reduction; it is not a lower-bound proof for LIFELINE.
7. S. A. Fenner, D. Grier, J. Messner, L. Schaeffer, T. Thierauf, “Game Values and Computational Complexity: An Analysis via Black-White Combinatorial Games,” *ISAAC 2015*, LNCS 9472, 689–699, 2015.
8. K. Burke, C. Tennenhouse, “Col is PSPACE-complete on Triangular Grids,” arXiv:2501.06574v2, 2025.
9. J. M. Robson, “The Complexity of Go,” *IFIP Congress*, 413–417, 1983.
10. M. Crâşmaru, J. Tromp, “Ladders Are PSPACE-Complete,” *Computers and Games*, 241–249, 2001. DOI: 10.1007/3-540-45579-5_16.
11. A. Saffidine, O. Teytaud, S.-J. Yen, “Go Complexities,” *Advances in Computer Games*, 76–88, 2015. DOI: 10.1007/978-3-319-27992-3_8.
12. J. Tromp, “The Number of Legal Go Positions,” *Computers and Games*, 183–190, 2016. DOI: 10.1007/978-3-319-50935-8_17.
13. O. Randall, M. Müller, T.-H. Wei, R. Hayward, “Expected Work Search: Combining Win Rate and Proof Size Estimation,” arXiv:2405.05594, 2024.
14. J. M. Robson, “Combinatorial Games with Exponential Space Complete Decision Problems,” *MFCS 1984*, LNCS 176, 498–506, 1984. DOI: 10.1007/BFb0030333.
15. R. S. Sutton, A. G. Barto, *Reinforcement Learning: An Introduction*, 2nd ed., MIT Press, 2018.
16. D. Silver et al., “A General Reinforcement Learning Algorithm that Masters Chess, Shogi, and Go through Self-Play,” *Science*, 362(6419), 1140–1144, 2018. DOI: 10.1126/science.aar6404.
17. J. Schrittwieser et al., “Mastering Atari, Go, Chess and Shogi by Planning with a Learned Model,” *Nature*, 588, 604–609, 2020. DOI: 10.1038/s41586-020-03051-4.
18. A. Y. Ng, D. Harada, S. Russell, “Policy Invariance Under Reward Transformations: Theory and Application to Reward Shaping,” *ICML 1999*, 278–287, 1999.
19. J. Schulman et al., “Proximal Policy Optimization Algorithms,” arXiv:1707.06347, 2017.
20. M. Lanctot et al., “A Unified Game-Theoretic Approach to Multiagent Reinforcement Learning,” *NeurIPS 2017*, 4190–4203, 2017.
