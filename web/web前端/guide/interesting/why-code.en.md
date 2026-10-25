# Code: LIFELINE Algorithm Report

Abstract. This report has three chapters: Mathematics, Algorithms and AI. It emphasizes data structures, execution order, pseudocode, source excerpts, complexity and implementation limits, connecting each rule to functions and outputs.

Source inspection: 2026-10-23. Numbered pseudocode explains control flow; attributed excerpts quote actual source. Training, exported inference and Web/Mini Game availability are distinguished. The companion mathematical edition supplies definitions and proofs.

Reading path: chapter I defines notation and full state; II develops rule algorithms; III develops AI. In territory-v3 the score always counts owned points and separately adds enemy-free pockets cut off from the exterior; old replays retain their recorded rule versions.

**Contents**

[I. Mathematics](#i-mathematics)

- [1.1 State representation](#11-state-representation)

- [1.2 Scores and invariants](#12-scores-and-invariants)

- [1.3 Snapshots and restoration](#13-snapshots-and-restoration)

[II. Algorithms](#ii-algorithms)

- [2.1 Legal-move trials](#21-legal-move-trials)

- [2.2 Automatic connections](#22-automatic-connections)

- [2.3 Cuts and root BFS](#23-cuts-and-root-bfs)

- [2.4 Superko transactions](#24-superko-transactions)

- [2.5 Contours and cycles](#25-contours-and-cycles)

- [2.6 Territory tightening](#26-territory-tightening)

- [2.7 Flood fill and scoring](#27-flood-fill-and-scoring)

- [2.8 Canonical views and caches](#28-canonical-views-and-caches)

- [2.9 Passing and settlement](#29-passing-and-settlement)

- [2.10 Source and verification](#210-source-and-verification)

[III. AI](#iii-ai)

- [3.1 Greedy evaluation](#31-greedy-evaluation)

- [3.2 Minimax control flow](#32-minimax-control-flow)

- [3.3 Plain MCTS](#33-plain-mcts)

- [3.4 Neural forward pass](#34-neural-forward-pass)

- [3.5 PUCT move selection](#35-puct-move-selection)

- [3.6 Five policy adapters](#36-five-policy-adapters)

- [3.7 Training source and losses](#37-training-source-and-losses)

- [3.8 Multiplayer features](#38-multiplayer-features)

- [3.9 Three-player V4](#39-three-player-v4)

- [3.10 Hexagonal V5](#310-hexagonal-v5)

- [3.11 Later multiplayer search](#311-later-multiplayer-search)

- [3.12 Runtime and reproduction](#312-runtime-and-reproduction)

## I. Mathematics

Map mathematical objects to engineering data and invariants. Numbered language-neutral pseudocode explains control flow; only blocks explicitly called source excerpts quote the current workspace. The companion mathematical article provides proofs.

### 1.1 State representation

Separate the board into three layers. Fixed lattice points and their six-neighbor adjacency form the geometry. The grid records empty points, player nodes and intermediate points occupied by links. Each player also owns an explicit edges set recording the logical links that actually exist. A point crossed by a line is not necessarily a placed node, and nearby graphics do not establish a logical connection.

Side length N counts points along an outer side. A triangle contains N(N+1)/2 points; a hexagon contains 3N(N−1)+1. At N=15 these counts are 120 and 631. The six integer directions are (1,0), (−1,0), (0,1), (0,−1), (1,−1) and (−1,1). Projection into screen pixels happens only when drawing, so zoom and device resolution do not change the rules.

The complete state also includes shape, rules version, actual starting points, the player to act, consecutive passes, resigned players, terminal status and the entire Superko history. Territory caches and revision numbers support efficient asynchronous display. Neither a screenshot nor the occupancy grid alone restores the full rule state.

```text
01 CONFIG = {rules, shape, size, players, starts}
02 grid: Map<pointKey, EMPTY | NODE(player) | LINE(player)>
03 edges[player]: Set<canonicalEndpointPair>
04 historyHashes: Set<serializedTrialKey>
05 turn = {currentPlayer, consecutiveSkips, resignedPlayers, gameOver}
06 display = {cachedTerritories, territoryRevision, positionRevision}
```

Distinguish rule identity for the next move, geometric dependencies for territory caches, and revision/request identity for stale-result rejection. Equal grid does not imply equal edges; equal grid+edges does not imply equal history; the same rule position can also belong to different UI requests.

Source: web/web前端/GameEngine.js → constructor, _captureReplayState, _computeStateHash.

### 1.2 Scores and invariants

The score contract distinguishes official area, geometric shoelace displayArea and heuristic reach. Names such as area do not make them interchangeable. Preserve that distinction in types/names and use canonical territory for settlement, not evaluate’s heuristic result.

$$
\operatorname{coverage}_i=|F_i|,\qquad \operatorname{area}_i=|F_i|+|B_i|,\qquad \operatorname{reach}_i=|\operatorname{Reach}_{G_0\setminus O_i}(F_i)|.
$$

Check that placements do not overwrite nodes, surviving nodes have explicit-link routes to their actual starts, rejected trials do not commit history, accepted placements add new keys, search restores rule state, and AI outputs remain current and legal at execution. Cuts, connectivity and settlement belong to GameEngine rather than parallel approximate UI/model rules.

Source: web/web前端/GameEngine.js → _getOpponentConnectedPieces, _evaluateMove, _computeTerritory.

### 1.3 Snapshots and restoration

AIEngine.saveState copies grid, per-player edges, history and turn fields, plus territory cache data. restoreState recreates grid/edge/history containers but assigns snapshot.cachedTerritories directly. A branch that refreshes exact territory therefore needs its own cache object; V4/V5 add isolation. Shallow outer-object copies can contaminate branches.

Source excerpt: these fields explain why visually identical positions can have different legality.

```javascript
    historyHashes: new Set(engine.historyHashes),
    consecutiveSkips: engine.consecutiveSkips,
    resignedPlayers: new Set(engine.resignedPlayers ?? []),
    currentPlayer: engine.currentPlayer,
    gameOver: engine.gameOver,
```

For M points, e links and h history entries, a snapshot copies O(M+e+h) container entries; immutable history strings can share references, with their byte lengths counted separately. A depth-d stack retaining snapshots is not merely O(d) space. Normal restoration and the actual extent of finally-based exception cleanup must be audited separately.

Source: web/web前端/AIEngine.js → saveState, restoreState, cloneCachedTerritories.

## II. Algorithms

Follow a placement through legality, connections, cut cleanup, Superko commit, turn normalization and scoring. Each section identifies inputs, steps, outputs and source entry points. Territory contour extraction, tightening and flood coverage are separate stages.

### 2.1 Legal-move trials

The real engine tests placements, checking coordinates, occupiable state, protected neighbors of enemy starts, the three-point limit, a friendly connection and Superko after the transition. Empty points and line points can be candidates; existing NODE points cannot be overwritten. Protection follows every actual enemy start, including random and custom starts.

The current _checkThreePointLimitation rejects a new point with at least two adjacent friendly nodes. It also rejects a point adjacent to one friendly node that already has another friendly node as a neighbor. Thus a chain or cluster of three adjacent nodes can trigger the limit, including straight or bent chains; the check is broader than a smallest-triangle-only test.

A direct placement on an enemy line point bypasses this three-point check only. Starting-zone protection, the connection requirement and Superko still apply. The legality path does not consult a colored territory cache as a click mask: actual nodes, line points, blockers and full history determine the result.

_evaluateMove performs a reversible trial, computes the resulting state identity and restores the board and edge sets in finally. Listing legal moves may inspect many candidates without changing the live game.

```text
01 INPUT: full state S, candidate point v, actor i
02 Reject invalid v, existing NODE, or protected enemy-start neighbor
03 If v is not an enemy LINE: enforce the three-point condition
04 Temporarily apply node insertion, connections and attack cleanup
05 If no friendly connection exists: restore and reject
06 Compute trial key with next non-resigned actor
07 Reject if trial key is already in H
08 Restore all trial changes; return legal/illegal (do not commit)
```

Enumerating M candidates can invoke many trial transitions: getLegalMoves costs on the order of M trial costs rather than one neighbor scan. Fixed coordinate order, ray geometry and reusable buffers help; a history-free cache of permanently legal points is unsound.

Source: web/web前端/GameEngine.js → _evaluateMove, getLegalMoves, _checkThreePointLimitation, _isInProtectionZone.

### 2.2 Automatic connections

A placement must connect to an existing friendly node along a lattice straight line: constant x, constant y or constant x+y. Every intermediate point is checked. Any opponent node or opponent line point blocks the connection. If no friendly node is reachable this way, the placement fails.

Successful connections keep endpoints as NODE, fill eligible empty intermediate points as LINE and add an undirected endpoint pair to edges. Endpoint order is canonicalized so A—B and B—A are not duplicated. The new-node checks can retain long links; connecting is not restricted to adjacent visible stones.

The _connectAllCrawl pass then walks six rays from each friendly node. An enemy element stops a ray; the first friendly node supplies a missing edge and ends that ray. A direct cut can remove blockers, so the attack path also rescans the other players for newly unlocked connections. Only ray geometry is cached; occupancy is read again each time.

A scoring contour is separate from a real link. If contour tightening crosses an empty point, that point does not become LINE and no attackable logical edge is invented.

```text
01 For every old friendly NODE u:
02   If v,u are lattice-collinear AND the interior has no enemy:
03     mark v,u as NODE; mark eligible interior cells as LINE
04     add canonical undirected edge {v,u}
05 For each friendly NODE u and each of six directions:
06   walk the cached ray, reading current occupancy
07   stop at enemy occupancy
08   at first friendly NODE: add missing edge, then stop this ray
09 After a direct cut: also crawl each other player's surviving nodes
```

Source excerpt: insertion records long logical edges, complementing the nearest-node-per-ray crawl.

```javascript
      // 记录显式边
      this._getEdges(this.currentPlayer).add(this._edgeKey(point, node));
```

For maximum ray length D and k friendly nodes, direct checks and one six-ray crawl require O(kD) naive scanning, plus written line points and links. Precomputed rays remove repeated geometry work, but occupancy must be reread.

Source: web/web前端/GameEngine.js → _addNode, canConnectWithBlocking, getLinePoints, _connectAllCrawl.

### 2.3 Cuts and root BFS

Placing on an opponent LINE cuts a link; it does not capture an arbitrary opponent node. The attack breaks logical edges passing through that position. _cleanupBrokenEdges checks the lattice points of each edge and removes edges that are no longer intact. Human play and AI simulations use the same state transition.

A BFS starts at the attacked side’s actual initial node and follows the explicit node-to-node edge graph. Reachable nodes survive, together with the intermediate points of surviving links. Nodes and line points with no remaining route home are removed, followed by edge cleanup and restoration checks. This BFS finds a rooted supply component; it is different from flooding the board exterior to score territory.

Suppose A—B—C is the only route from starting node A. Cutting A—B disconnects the B,C side. If C has another route back to A, that side may survive. Merely touching a line that passes nearby does not replace an actual endpoint-and-edge route.

```text
01 INPUT: attacked player's current grid and explicit edge set E
02 Remove broken edges whose geometric path no longer survives
03 Build endpoint adjacency from surviving E
04 Q <- [actual start]; reached <- {actual start}
05 WHILE Q is nonempty:
06   u <- pop Q; enqueue each unreached logical neighbor of u
07 END WHILE
08 Keep reached NODEs and interior LINEs belonging to surviving links
09 Clear disconnected elements; clean edges and restore eligible links
```

Determine which links survive before asking about reachability. The attack source also tracks broken links and restoration. This pseudocode isolates root connectivity; geometric path checks, edge maintenance and other players’ reconnections are additional work.

Source: web/web前端/GameEngine.js → _handleBlockingAttack, _cleanupBrokenEdges, _getOpponentConnectedPieces.

### 2.4 Superko transactions

The rule is global repetition prohibition, or Superko. It prevents returning to a previously recorded global position after cuts and reconnections, rather than merely forbidding an immediate local recapture. It does not mean that the game has no forbidden moves.

The current _computeStateHash key contains the next player, resigned-player list, all nonempty grid entries sorted by coordinate and every player’s sorted explicit edge set. Despite the name Hash, the implementation uses a stable JSON string as the Set key rather than a short integer digest. Equal occupancy with different logical edges gives a different key; a different next player can also distinguish keys.

The initial key enters historyHashes. After a trial placement completes connections, cuts and cleanup, its resulting key is checked against that history. A match returns SUPERKO_VIOLATION and the trial is rolled back. Accepted placements add their keys. Passing follows separate turn rules: an unchanged board alone does not make a pass illegal. Resignation also has its own rotation and settlement behavior.

Two saves can show the same board and player to act, yet only one history contains the result of placing at P. That placement may be legal only in the other save. Search snapshots, undo, replay branches and recovery must retain their own path histories; network features or screenshots cannot replace them.

Exact timing: after _addNode succeeds, playMove builds the key using _getNextPlayer(currentPlayer). It adds history before _switchPlayer and _checkAndAutoSkip. It does not simply serialize the post-auto-skip actor.

```text
01 savedGrid, savedEdges <- copy current containers
02 IF _addNode(v) fails: return INVALID_MOVE
03 key <- _computeStateHash(nextNonResignedActor)
04 IF historyHashes contains key:
05   restore savedGrid and savedEdges; return SUPERKO_VIOLATION
06 END IF
07 add key; increment turn/revision; reset consecutiveSkips
08 switch actor; normalize automatic skips; settle if required
```

```javascript
    this.historyHashes.add(stateHash);
    this.turnCount += 1;
    this.positionRevision += 1;
    this._territoryStateRevision += 1;
    this.consecutiveSkips = 0;
    this._switchPlayer();
    this._checkAndAutoSkip();
```

Key generation includes sorting/serialization cost. Hash-table-style Set lookup does not make the whole operation O(1). Fixed coordinate order and cell serialization fragments are cached, while current occupancy, all links and the full history check remain.

Source: web/web前端/GameEngine.js → _computeStateHash, _getStateHashOrder, playMove.

### 2.5 Contours and cycles

The display contour collects friendly nodes and line points and treats every other side’s nodes and line points as enemy elements. _getOuterContourFromPoints uses a fixed clockwise neighbor order for a right-hand wall-following traversal. The result is a closed lattice walk that can travel out along a branch and return, so vertices may occur repeatedly in its sequence; this contour no longer defines the official score.

A closed walk need not enclose a region: A—B—C—B—A merely retraces a line. _hasBoundaryCycle is used for contour candidates and display diagnostics, but official scoring does not depend on it. territory-v3 treats all friendly node and line points as walls and uses boundary flood fill to find every pocket; owned points still score without a cycle, and multiple pockets or donut holes are checked independently.

This contour is constructed from physical occupied lattice points and is used for display and diagnostics. It serves a different purpose from following edges to establish supply connectivity after a cut. Tightening keeps all friendly nodes in the display contour, but the official score is computed independently from the owned-wall pockets.

```text
01 Walk the outer boundary using the fixed clockwise neighbor order
02 Convert consecutive walk vertices into distinct undirected unit edges
03 Reject an invalid point or a non-unit step
04 Let n = distinct vertices, e = distinct edges
05 Accept the cycle gate iff n >= 3 and e >= n
```

Source excerpt and justification: the deduplicated graph of a valid closed walk is connected. Such an undirected graph has a cycle iff e≥n. The criterion must not be applied without that premise to arbitrary disconnected graphs. Retracing a branch adds no distinct edge.

```javascript
    return vertices.size >= 3 && edges.size >= vertices.size;
```

Source: web/web前端/GameEngine.js → _getOuterContourFromPoints, _hasBoundaryCycle.

### 2.6 Territory tightening

_computeRawTerritory repeatedly searches for shortcuts. It chooses two positions on the contour, runs BFS on the six-neighbor board graph while excluding enemy points, and records shortest distances together with the predecessor relationships for shortest paths. Relevant shortest paths are joined to either side of the old contour to form candidate closed walks.

A candidate must cover every friendly node, exclude every enemy node and line point, and retain a valid cycle. The comparison is lexicographic: fewer contour steps first, fewer covered lattice points second. The best improving candidate found in a round becomes the next contour, until no improvement remains. Perimeter here counts discrete contour-walk steps, including travel out and back along branches.

Flood fill computes coverage. The implementation reuses BFS results from the same source and repeated wall-coverage checks. Perimeter bounds and coverage feasibility reject paths that cannot improve the result. It does not claim exact checking by arbitrarily retaining only a fixed number of shortest paths.

This is deterministic greedy tightening, not a proof of globally minimum perimeter or coverage over all possible polygons. Shortcuts may use empty lattice points, so the final scoring boundary need not consist solely of the original physical links.

```text
01 rho <- initial valid contour
02 REPEAT:
03   best <- rho; compute current coverage
04   FOR endpoint pairs (u,v) on rho:
05     BFS avoiding enemies -> shortest-distance predecessor DAG
06     Enumerate relevant shortest paths; join each to either old side
07     Reject non-cycle, missing-friendly or enemy-covering candidates
08     If (length, coverageCount) is lexicographically better: keep it
09   END FOR
10   IF best equals rho: STOP
11   rho <- best
12 END REPEAT
13 Return closed rho, unique covered-point count and shoelace measure
```

Cost accounting: supplied-wall flooding and one source BFS are each O(M), but a predecessor DAG may encode combinatorially many shortest paths. Count endpoint pairs and visited prefixes/candidates J separately. _rawTerritoryUncached uses perimeter bounds, path envelopes, validated-wall reuse and scalar coverage queries; _computeRawTerritory adds dependency caching. No O(M) bound is promised for the whole algorithm.

Source: web/web前端/GameEngine.js → _computeRawTerritory, _rawTerritoryUncached, _bfsFromSource, _iterateTerritoryPaths, _iterateCoveredTerritoryPaths.

### 2.7 Flood fill and scoring

_computeOwnedWallArea marks all friendly node and line points as walls, then calls _getCoveredPoints to flood from the board boundary. It finds connected components among unvisited non-wall points; a component containing an enemy is excluded, while each other component is counted. An open line creates no pocket but its owned points still score.

Let V be all board points and F the owned node and line points. After deleting F, flood from the board boundary to obtain exterior-reachable points X. Let Qₖ be the connected components of V\(F∪X), and B the union of components containing no enemy node or line. In territory-v3, area=|F|+|B|. No valid cycle is required: open chains and single lines still score their owned points; multiple pockets and donut holes count separately, while a pocket containing an enemy is excluded in full. Every point counts once. The unit is lattice points, not triangular faces.

The old territory-v2 six-player screenshot gave lattice scores 25, 10, 11, 13, 8 and 8; these are historical, not verified v3 scores. Under v3, Cyan’s three owned points score 3 even when their chain is open.

The engine also computes displayArea with the shoelace formula, measured in smallest-triangle units. It is a geometric diagnostic; the scoreboard and settlement use area. Flood fill distinguishes inside from outside for a supplied wall. Flooding a graph of lattice points and flooding adjacency between triangular faces are different counting problems.

```text
01 wall <- distinct valid friendly NODE and LINE points
02 outside <- empty; Q <- empty
03 For every board boundary point b not in wall: mark/enqueue b
04 WHILE Q is nonempty:
05   u <- pop Q
06   For each lattice neighbor v not in wall and not yet outside:
07     mark outside[v]; enqueue v
08 END WHILE
09 enclosed <- all board points minus outside minus wall
10 area <- number of distinct wall points
11 For each connected component q of enclosed points:
12   If q contains no enemy NODE or LINE: area <- area + |q|
13 Return area; no cycle or single-polygon requirement
```

The implementation treats every friendly node and line point as a wall, floods from the board boundary, then visits each component disconnected from the exterior. An entire pocket containing an enemy node or line is excluded; all other pockets are added to the distinct owned-point count. No valid cycle is required: open chains and single lines score their owned points, while multiple pockets and donut holes are evaluated separately. Integer indices, reusable queues and visit marks change runtime cost, not the scoring rule. Shoelace displayArea remains diagnostic.

Source: web/web前端/GameEngine.js → _getCoveredPoints, _getValidatedTerritoryArea, computeTriangularPolygonArea.

### 2.8 Canonical views and caches

A fixed absolute contour traversal can favor a seat. territory-v3 keeps v2’s canonical transforms to generate a closed contour for display, while official pocket scoring is computed independently from all friendly points and lines. Triangles use barycentric permutations and hexagons D6 transforms. Canonical contour selection does not determine official area.

Exact territory needs contour processing, shortest paths and flood checks. Integer point indices, precomputed adjacency, reusable TypedArray queues and epoch marks reduce allocation and repeated work. They change computational cost, not the unit of area.

The UI can cache territory or compute it in a Worker, but a returned result must belong to the correct position revision. An old result cannot repaint a newer position, and terminal settlement requires current exact scores. AI estimates such as fastTerritoryBFS must not populate the official score cache.

```text
01 transforms <- seat-specific canonical transforms
02 FOR g in transforms:
03   transform own NODEs/LINEs and all enemy occupancy
04   run raw tightening with a required real cycle
05   save display polygon and canonical polygon key; inverse-transform output
06 END FOR
07 Choose display contour by closed-contour coverage, then canonical polygon key
08 area <- CountOwnedWallArea(all friendly NODE/LINE points, all enemy NODE/LINE points)
09 Return display contour and official area; scoring is independent of contour
```

Geometry keys include shape/size, rules/canonical-view dependencies, own nodes/lines, the enemy obstacle union and relevant ordering of an explicit initial walk. Search caches additionally need history and turns. Mutable polygon results are copied. Diagnostic/subclass overrides retain fallback paths so pruning arguments for native methods are not applied to different semantics.

Source: web/web前端/GameEngine.js → _getCanonicalTerritoryTransforms, _computeCanonicalTerritoryCandidate, _computeTerritory, dependencyMemo.

### 2.9 Passing and settlement

Voluntary passing is allowed. The engine also automatically skips a player with no legal placements and excludes resigned players from rotation. Consequently, a search must read the engine’s actual next player rather than infer the turn from recursion-depth parity.

Normal settlement occurs after all remaining players pass consecutively once each. Their exact area scores are compared; equal highest scores draw. An accepted placement resets the consecutive-pass count. Resigned players leave both the turn order and the winner comparison; a sole remaining player wins immediately.

On a fixed finite board, accepted placements cannot repeat recorded state keys indefinitely, while consecutive passes have an ending rule. This termination mechanism does not mean an AI has solved the game. Arguments based on an inability to pass do not describe the current rules.

```text
01 PASS: increment consecutiveSkips
02 If skips >= remaining-player count: set gameOver
03 Otherwise advance to the next non-resigned player
04 While the current player has no legal placement: auto-skip
05 A successful placement or resignation resets the pass count
06 If only one player remains: that player wins
07 Otherwise at settlement: recompute exact area and compare survivors
```

Nonterminal shading may be deferred, but exact scores must be ready before settlement reads them. Neural PUCT explicitly refreshes canonical territory at terminal simulations; old Minimax’s F leaf does not have the same exact-outcome semantics. Their outputs should not share an unqualified win-probability label.

Source: web/web前端/GameEngine.js → skipTurn, resignPlayer, _checkAndAutoSkip, getWinner.

### 2.10 Source and verification

The engine lives in web/web前端/GameEngine.js; search/snapshots in AIEngine.js; Worker state in AIStateProtocol.js; replay restoration in ReplayCodec.js and LocalGameSession.js. Mini Game reader content/UI live in wechat/minigame/src/guide-content.js and help-ui.js. Later multiplayer development paths are covered in chapter III; source existence does not mean phone installation.

A useful verification order is fixed-action replay, grid/edges/history/turn comparison, exact score/winner, source-state restoration, stale Worker rejection and actual reading of contents/formulas/code. Documentation edits run scoped checks and preserve frozen experiments/releases. Source excerpts are checked against current files with whitespace normalization that leaves code tokens intact.

```text
node web/tools/sync-implementation-guides.mjs --check
node web/web前端/tests/verify-guide-content.mjs
node --test --test-timeout=180000 wechat/minigame/tests/guide-cabin.test.mjs
```

## III. AI

Follow candidate generation, evaluation, search, forward inference and returned actions. Budgets and adapters below describe source behavior. Training objectives are separate from inference, and candidate labels are not a strength ranking.

### 3.1 Greedy evaluation

Greedy AI enumerates genuinely legal placements, prioritizes cuts on enemy links, then placements adjacent to friendly line points, then other placements, and retains at most 20 candidates. Each candidate is played once, evaluated and rolled back. The largest estimate wins; this need not maximize exact territory gain.

AIEngine uses F=15Δnodes+8Δcoverage+20Δreach+12attackable line points+10root-connectivity quality. Coverage counts nodes plus line points. In two-player play the differences compare the opponent; generic multiplayer greedy sums some opponent counts but selects the opponent with most nodes for its reach comparison. Attack opportunities are checked by actual legality, including Superko. Connectivity quality checks each friendly node’s route to its start through logical edges.

fastTerritoryBFS grows outward from all friendly nodes and line points while enemy elements block expansion. It estimates accessible space, which can be large without a closed region. It is not the official exterior flood fill. Search evaluation, shaded geometry and terminal area therefore have different meanings.

```text
01 legal <- engine.getLegalMoves(actor)
02 ranked <- cuts first, own-line adjacency next, other placements last
03 candidates <- first 20 ranked placements
04 For each candidate: save -> play -> evaluate F -> restore
05 Sort by descending F; return top requested candidates
```

Source: web/web前端/AIEngine.js → evaluate, fastTerritoryBFS, orderMoves, GreedyAI.getTopMoves.

### 3.2 Minimax control flow

Minimax recursively models choosing the best move while an opponent chooses the worst reply for the root player. Leaves return F(s). Nodes where the root player acts take a maximum; opponent nodes take a minimum. Depths 2, 3 and 4 count action layers, not that many complete rounds for each side.

Alpha stores a lower bound already available to MAX; beta stores an upper bound for MIN. When beta is no greater than alpha, the branch cannot improve the ancestor’s decision and can be cut. Alpha–beta preserves Minimax on the same candidate tree and evaluation. The separate 20-candidate cap truncates that tree and can omit legal moves.

Each branch saves the grid, edges, history, turn, resignations, passes, terminal state, revisions and territory cache, advances through GameEngine.playMove and restores the saved state. Automatic passes can return control to the same player, so currentPlayer determines MAX versus MIN. The existing two-player implementation evaluates both depth-limited and terminal leaves with heuristic F; its returned score is not an exact proof of victory.

The current two-player Minimax includes PASS alongside legal placements at both root and recursive nodes, and advances it through GameEngine.skipTurn. It can therefore pass while placements remain. Selection still depends on the same heuristic and bounded-depth search; it is not an exact solution of the ending. Multiplayer Hard instead evaluates complete MOVE-plus-PASS reply packets from the actual next opponent under its own time gate, so the evidence scopes remain separate.

Search suppresses UI snapshots and display-only territory refreshes. At heuristic leaves it can also omit a next-player auto-skip scan that does not affect F. Non-leaf transitions keep actual turn normalization so the optimization preserves the searched tree’s meaning.

```text
01 SEARCH(S,d,alpha,beta,root):
02   If d=0 OR gameOver: return F(S,root)
03   Get real legal placements; handle no-placement pass
04   Retain ordered candidates (at most 20)
05   maximizing <- (S.currentPlayer == root)
06   value <- -infinity if maximizing, otherwise +infinity
07   For each candidate:
08     saved <- saveState; apply the actual move
09     child <- SEARCH(successor,d-1,alpha,beta,root)
10     restoreState(saved)
11     Update value and alpha (MAX) or beta (MIN)
12     If beta <= alpha: break
13   Return value
```

```javascript
    const maximizingPlayer = engine.currentPlayer === aiPlayer;
```

This is explanatory pseudocode, omitting rejected-candidate branches and cache fields. Read the actual finally scope before assuming full transaction rollback under every exception. Full legal enumeration occurs before retaining 20 moves; searching 20 candidates does not mean only 20 legality trials.

Source: web/web前端/AIEngine.js → MinimaxAI.minimax, MinimaxAI.getTopMoves, applyMoveForAI.

### 3.3 Plain MCTS

The repository’s plain MCTSAI implements selection, expansion, random rollout and backpropagation. A mean return plus an exploration bonus selects a branch; an unvisited action is expanded; random play continues until termination or a depth limit; returns update the visited path. Its UCT bonus is proportional to sqrt(log(parent visits)/child visits).

Defaults are 64 simulations, rollout depth 40 and exploration coefficient sqrt(2), with a seeded pseudo-random generator. A nonterminal cutoff uses tanh(F/100). This is an implementation retained in the codebase, not evidence of a separate plain-MCTS option in the current Mini Game menu.

CNN, Grid GNN and Topology GNN instead use NeuralPUCTAI. A network provides action priors and position values, and PUCT allocates visits using those priors. Both methods search and backpropagate, but 16 neural simulations and 64 random simulations are not equivalent measures of compute or strength.

```text
01 Repeat simulation budget times:
02   restore root state
03   Select children by mean return + UCT exploration bonus
04   Expand one unvisited action
05   Roll out random actions until terminal or depth cap
06   Evaluate rollout return; add it to every visited tree node
07 Rank root actions using accumulated search statistics
```

The plain rollout implementation returns tanh(F/100), including when it reaches termination; that does not automatically become exact-area ±1. NeuralPUCTAI uses a different terminal rule below. A seeded generator helps reproduce decisions, while repeating the same start and seed is not a new independent statistical sample.

Source: web/web前端/AIEngine.js → MCTSAI, rollout, evaluate.

### 3.4 Neural forward pass

Research models use 11 features per lattice point: empty, own node, own line, enemy node, enemy line, normalized x and y, boundary flag, own start, enemy start and consecutive-pass count. Features are relative to the player to act. The real engine supplies a separate legal-action mask; these 11 channels do not contain the full history set.

CNN places the triangle into a padded square tensor, applies an input projection and residual 3×3 convolution blocks, then reads valid point embeddings. Grid GNN passes messages on six-neighbor lattice adjacency, combining mean neighbor projections with self projections, residual connections and normalization.

Topology GNN uses three relations: lattice adjacency, friendly logical links and enemy logical links. Long-link relations participate directly in message passing. All three architectures produce point-policy logits, a pooled PASS logit and a pooled tanh value. Legal masking and a stable softmax turn the action logits into priors.

Identical board features can accompany different histories, so the network observation is not the complete Markov rule state. Masks and transitions still rely on an engine retaining history. S01–S03 identify training seeds; D14 identifies an earlier model lineage. Names, seed numbers and parameter counts do not establish playing strength or validated transfer to every size and ruleset.

```text
01 encodeResearchPosition -> point features, actual actor, legal indices
02 Input projection -> hidden vectors
03 CNN: residual 3x3 convolutions on a padded square
04 Grid GNN: mean messages over lattice neighbors
05 Topology GNN: also mean over own/opponent logical-link neighbors
06 Per-point head -> placement logits
07 Global pooled heads -> PASS logit and tanh value
08 Apply the real legal mask; stable softmax -> action priors
```

Source excerpt: link topology is provided as relation adjacency lists, not a drawing. This accumulates mean hidden vectors.

```javascript
          const neighbors = relations[relation][node];
          if (neighbors.length) {
            for (const neighbor of neighbors) for (let channel = 0; channel < channels; channel += 1) aggregate[channel] += hidden[neighbor * channels + channel] / neighbors.length;
          }
```

For hidden width c, relation-edge count eᵣ and R relations, aggregation costs about O(eᵣc) per layer; relation/self linear projections cost O((R+1)Mc²). A 3×3 CNN convolution costs O(9N²c²), multiplied by actual convolutions per block. These count forward arithmetic only; real legality-mask generation is additional.

Source: web/web前端/ResearchAI.js → encodeResearchPosition, researchRelations, forwardGnn, forwardCnn, applyHeads.

### 3.5 PUCT move selection

PUCT expands the root to obtain network prior P for each legal action. Child selection uses sign·Q+c·P·sqrt(max(1,N))/(1+n), where Q is mean accumulated return, N is parent visits and n is child visits. The actual player to act determines the sign for the root-player perspective.

Each simulation restores the full root snapshot and follows real placements or passes. Reaching a new nonterminal node triggers a network evaluation whose value is converted to the root perspective and backed up along the path. A true terminal node forces exact rule-engine territory scoring and backs up +1, 0 or −1 for win, draw or loss.

The Mini Game currently uses 16 simulations and cPuct=1.5 for these neural models. Final ranking prioritizes visits, then mean value. Priors guide where to look; visits record where this search spent its budget. Neither quantity is a calibrated probability of winning.

The model action contract controls voluntary PASS availability when placements exist, and no-placement positions still need pass handling. Results must belong to the current position and pass legality checks when executed. A limited PUCT budget is not exhaustive game solving.

```text
01 Save full root state; expand root with network priors
02 For each simulation:
03   Restore root; path <- [root]
04   Select by sign*Q + c*P*sqrt(max(1,N))/(1+n)
05   Play the real action or PASS; append child to path
06   Expand a new nonterminal child and convert value to root perspective
07   If terminal: force exact territory and compute win/draw/loss
08   Add the root-perspective value to all nodes on path
09 Rank root children by visits, then mean value; restore source state
```

```javascript
          GameEngine.prototype._updateTerritories.call(engine);
          const winner = engine.getWinner();
          value = winner === "DRAW" ? 0 : winner === aiPlayer ? 1 : -1;
```

Source: web/web前端/ResearchAI.js → NeuralPUCTAI.expand, select, getTopMoves.

### 3.6 Five policy adapters

These five models share a lightweight on-device inference path. Up to 120 triangular-board points receive seven features each: empty, own node, own line, enemy node, enemy line, x and y. Smaller boards are padded to 120 points; board size and consecutive passes bring the vector to 842 dimensions. The network is 842→512→512→121 with ReLU hidden layers and a reserved action space.

DQN exports Q values; PPO, SAC, GAIL and GAN export policy logits. The runtime obtains legal point indices from the real engine, applies stable softmax and ranks them. It performs no gradient update during a move. Softmax of DQN Q values is a ranking prior, not evidence that Q values are probabilities. PPO, GAIL and GAN assets can include a value head, but this direct-policy path does not use it for tree search.

One runtime detail matters: the softmax denominator includes the position’s PASS slot, but ModelFreeAI returns only placement candidates. With available placements it therefore does not voluntarily pass because PASS has the highest probability, and the returned placement priors may sum to less than one. The outer controller handles no-placement passing. This describes the actual adapter rather than attributing every theoretical capability of an algorithm family to the menu option.

```text
01 Encode <=120 triangular points into 7 features each; pad missing points
02 Append size and pass count -> 842-dimensional vector
03 ReLU(W1*x+b1) -> ReLU(W2*h+b2) -> 121 action outputs
04 DQN reads Q-head weights; other families read policy-head weights
05 Softmax over legal indices including the PASS slot
06 Filter returned candidates to placements; sort by prior
07 If there is no placement, outer control handles passing
```

Source excerpt: filtering occurs after normalization, so returned placement priors need not sum to one. This is adapter behavior, not a failure of softmax.

```javascript
    return { priors: legal.map((index, order) => index < engine.validPositions.length
      ? { type: "move", point: [...engine.validPositions[index]], actionIndex: index, prior: exp[order] / total }
      : { type: "pass", point: null, actionIndex: engine.validPositions.length, prior: exp[order] / total }) };
```

Source: web/web前端/ModelFreeAI.js → encode, forwardBody, logits, evaluate, ModelFreeAI.getTopMoves.

### 3.7 Training source and losses

Research training is separate from Web inference. These are current inspectable trainers; matching names alone do not prove that a deployed binary was generated by these exact sources. Asset lineage requires manifests/receipts, and rule/auto-skip parity between research and Web is a separate check.

DQNTrainer.update samples replay, takes a masked online-Q argmax and reads its target-network Q. It uses smooth-L1 and gradient clipping at 5. The quoted fixed negative continuation assumes opponent perspective, which must be checked against training turns after auto-skips.

```python
            next_online = self._masked_argmax(self.online(next_states), next_masks)
            next_values = self.target(next_states).gather(1, next_online.unsqueeze(1)).squeeze(1)
            target = rewards - self.config.gamma * (1.0 - done) * next_values
```

PPOTrainer.run_episode stores actions, old log probabilities and values, computes reverse GAE with negative continuation values/advantages, normalizes advantages and optimizes clipped ratios. value_loss already contains 0.5 and is multiplied by another 0.5 in the total loss: its squared-error coefficient is 0.25. Entropy has coefficient 0.01; generic PPO defaults are not this source contract.

```python
            value_loss = 0.5 * (values_now - returns).square().mean()
            entropy = dist.entropy().mean()
            loss = policy_loss + value_loss * 0.5 - entropy * 0.01
```

SACTrainer.update maintains twin Q and target-Q networks, exactly sums over legal discrete actions for soft values, and also uses negative continuation. Q uses squared loss; the policy minimizes Σπ(α logπ−min(Q₁,Q₂)); targets use τ soft updates. Inference needs only the policy head, so absent runtime Q networks do not imply absent twin-Q training.

Source: research/iclr2027/lifeline_rl/model_free/sac.py → SACTrainer.update.

GAIL/GAN: train_imitation_adversarial.py collects greedy-expert data. Both labels use one loop, mainly changing seed offset and metadata. D consumes state plus action one-hot, with expert=1 and generated=0. The generator enumerates all actions and differentiates a probability-weighted expectation instead of differentiating through a sampled discrete action.

```python
            rewards = torch.sigmoid(-discriminator(repeated_states, action_grid)).reshape(batch_states.shape[0], ACTION_COUNT)
            g_loss = -(probs * torch.log(rewards.clamp_min(1e-6))).sum(dim=1).mean()
```

The sign matters: holding D fixed, minimizing −log σ(−D) favors smaller D, whereas expert-positive classification favors larger D. This loop cannot directly inherit standard GAIL guarantees, and two names do not establish two independent algorithms. Updates use fixed expert-state batches, not full online occupancy matching; this loop does not mask sampled actions, while Web inference separately filters actual legality. This report changes no training, weights or model selection.

### 3.8 Multiplayer features

Three-player V1/V2 and hexagonal V1 trial each genuinely legal placement and compute 16 features from before-and-after positions: own nodes, coverage and reach; leads over the strongest opponent for those three metrics; captured enemy nodes and coverage; own node and coverage gains; attack flag; own-line placement flag; distance from home; centrality; own empty frontier; and frontier lead over opponents.

Counts are normalized by board size, while distance and centrality use the appropriate geometry. The policy ranks score=(w·features)/temperature, then softmax produces priors. Coordinate order resolves ties reproducibly. This combines trained weights with hand-designed features; it is not a CNN or merely a recolored two-player network.

Games with three or more players do not inherit two-player zero-sum conclusions. Features compare the player with the strongest opponent and aggregate opponents’ losses; a cut can benefit a third party. Different response policies and continuation models can therefore produce different recommendations. Mini Game compatibility filters use player count, shape and size; V2 and hex search V5 retain experimental labels.

```text
01 Save S and before-move metrics for all players
02 For each real legal placement a:
03   play a; measure nodes, coverage, reach, capture and frontier changes
04   normalize the 16-feature vector; score = dot(w,features)/temperature
05   restore S
06 Stable rank by score and coordinate; softmax -> prior
```

Source: web/web前端/ThreePlayerAI.js / HexPlayerAI.js → feature extraction, candidate scoring, getTopMoves.

### 3.9 Three-player V4

three-player-search-v4-round12 shortlists the top three linear-policy root moves on a three-player triangle. It evaluates each under V1 and V2 opponent-response policies. The root player continues with its base policy, and each branch runs for up to 12 further action plies after the root move or stops at termination. Fewer candidates mean fewer trials; a single candidate returns directly.

Every leaf computes exact discrete territory. Nonterminal strength is area+0.3×coverage+0.05×reach, converted to relative preferences with softmax temperature 0.12 times the board-point count. Terminal leaders receive 1 divided by the number of tied leaders; others receive zero. Territory margin over the strongest opponent is also recorded. Results are averaged over the two response models, with margin, base score and coordinates breaking ties.

If the best search result improves on the original base choice by less than 0.02, the base choice remains first. The Mini Game V4 entry supports sizes 5, 7 and 9; other sizes use compatible listed policies. Averaging two response models is not a guarantee against all opponents or a solved three-player equilibrium.

```text
01 roots <- base policy's top 3 placements
02 For each root a and response policy in {V1,V2}:
03   restore full root state; play a
04   simulate at most 12 further plies using actual turn order
05   compute exact area and leaf preference / terminal winner share
06 Average the two response-policy scores
07 Rank by mean score, territory margin, base score and coordinate
08 If improvement over original first choice <0.02: retain that choice
```

Source: web/web前端/ThreePlayerSearchAI.js → positionUtilityV4, ThreePlayerSearchAI.getTopMoves.

### 3.10 Hexagonal V5

hex-player-search-v5 is an optional experimental search for 4–6-player hexagons of size 5 or 7. V1 weights rank candidates; at most two remain within 0.4 of the best base score. Search is triggered by at most six legal moves or tactical features such as captures, cuts or coverage gain of at least three points. Quiet positions and clear base choices retain the base policy.

After each candidate root move, opponents respond with V1 for at most five action plies. The rollout stops at termination, return to the root player or a repeated opponent turn. The actual engine determines rotation, including unavailable moves and resignations.

Nonterminal strength is 0.7×reach+0.3×coverage. Since reach includes occupied points, this equals coverage+0.7×reachable empty points. Softmax temperature is 0.15 times the board-point count. This is a fast preference, not official territory or calibrated win probability. Only terminal leaves force exact area scoring.

Comparison first distinguishes simulated confirmed wins, unfinished branches and simulated confirmed losses, then compares values within those categories. Ordinary nonterminal changes require an improvement of at least 0.03. A heuristic 0.9 therefore cannot displace a terminal win merely through numerical scale. Confirmation is conditional on the V1 responses simulated, not every possible opponent reply.

```text
01 Rank by V1; retain <=2 roots within base-score gap 0.4
02 If quiet and legal count >6: return base ranking
03 For each retained root: restore isolated state and play it
04 Simulate <=5 V1 replies, stopping at terminal or return/repeated actor
05 Terminal -> exact area; otherwise -> 0.7*reach+0.3*coverage
06 Compare terminal tiers, then values; ordinary switch needs >=0.03
07 Restore the source engine and its territory cache
```

Source: web/web前端/HexFastSearchAI.js → evaluateHexFastLeafV5, chooseHexFastSearchLeafV5, getTopMoves.

### 3.11 Later multiplayer search

Later Web development adds easy, medium, hard and ultimate-candidate paths. Easy uses a trained 16-feature linear policy. Medium reuses three-player V4 or hexagonal V1 with equivalent candidate/feature acceleration. Hard on native shapes uses selfish-policy rollouts. These paths are distinct from the Mini Game’s current V1, V2, V4 and V5 choices; inclusion in this article does not install them on a phone.

These later rollouts recompute canonical territory at leaves and combine it with coverage and reach for nonterminal preferences. Opponents follow their own policy rather than jointly minimizing the root player. Non-default shapes also have MultiplayerMinimaxAI, which uses the conservative paranoid assumption: all other players are MIN. It includes alpha–beta, voluntary PASS, iterative deepening and complete-iteration fallback. Nonterminal evaluation uses relative nodes, coverage and reach; terminal scoring uses exact territory. Neither opponent model is universally correct.

In Web source inspected on 2026-10-23, native-shape hard mode targets 650 ms and compares all legal roots plus PASS at 12/24-ply horizons. It publishes a phase only after all roots complete the same responses/horizon. Timeout retains the last complete phase or base fallback; a synchronous rule operation can overshoot the target.

The ultimate candidate obtains transferred-GNN priors and charges inference to the budget, then checks 12/24/36 plies with publishCompletedComparisons=true. Before a whole sweep completes it may publish an improvement whose comparison against the fixed phase anchor has completed at the same depth and full response prefix. It does not always finish every root. Fallback is legal-placement GNN argmax, or PASS only with no placement, avoiding untrained PASS/value heads.

```text
01 Compute base / GNN fallback and remaining budget
02 For each configured horizon and response prefix:
03   Evaluate a common incumbent anchor
04   Evaluate competing roots under the same comparison conditions
05   Hard: publish only a complete root sweep
06   Ultimate candidate: may publish a completed improving comparison
07 On deadline: discard unfinished leaf/response work; keep valid incumbent
08 Report whether decision came from fallback, full phase or comparison
```

On non-default shapes, MultiplayerMinimaxAI uses paranoid alpha–beta, PASS, iterative deepening and complete-iteration fallback. Multiplayer GNN pools enemy nodes/lines/starts and relations without explicit individual-opponent identity. MULTIPLAYER_ULTIMATE_AVAILABLE in LocalAIModes.js remains false and the runtime is application-candidate. Documenting it does not establish promotion or phone release.

Source: web/web前端/MultiplayerRuntime.js / MultiplayerRollout.js / MultiplayerSearch.js / MultiplayerModel.js → loadMultiplayerRuntime, getTopMoves, canonical leaf evaluation, publication policy.

### 3.12 Runtime and reproduction

The Mini Game serializes AI, hint, territory and replay work through one Worker queue, ordered by priority and request ID. Responses must match both ID and the full request context. Restarting, undoing, changing replay position or cancelling work invalidates late results from the old Worker.

The scheduler defaults to a 15-second timeout. Timeouts, Worker errors and process-killed notifications detach and terminate that Worker and report failure to the session, which preserves recoverable game state and supports retry. Computation must not block Canvas interaction or silently substitute another AI after failure.

The Worker can reuse a restored engine only when configuration and the entire existing action prefix match, replaying just the added suffix. Otherwise it restores from scratch. History remains intact, and a later request cannot mutate an engine leased to asynchronous model loading. AI play, hints and replay analysis share the strategy implementation; analysis can return the top three candidates and a metric label.

Before execution, the session checks position identity and player again, and the real engine validates the move. Web can organize separate AI, hint and territory Workers while the Mini Game uses one queue. Sharing rules does not require identical thread organization.

Loading checks model ID, rules, player count, board compatibility, tensor names, dimensions, offsets, byte length, finite values and asset integrity. Binary two-player models arrive in Mini Game subpackages; small multiplayer JSON policies are embedded in the Worker. Each is bound to a specific identity rather than accepted through a similar filename.

Ordinary games run inference, not on-phone training. Opting into complete-game contributions does not immediately update the model making the current move. Offline training, candidate evaluation, selection and release are separate steps. Research environments, Web and Mini Game also need explicit rules-version alignment.

Saves and replay documents retain configuration and actions. The same rule engine replays them to reconstruct nodes, edges, history and turns. Imports validate in isolation before replacing the active view. Undo, replay branches and AI search need full restoration, not just repainting node colors.

Reproducing a decision requires rules version, board configuration, complete actions or full state and history, player, model ID and asset hash, search parameters and any random seed. A screenshot can explain area but cannot reproduce all legality or decisions. Time-budgeted searches can also finish different complete phases on devices of different speed.

```text
01 Request <- {id, revision, rules, actor, config, full state/actions, model}
02 Queue in the single Mini Game Worker; reject cancelled/stale tasks
03 Restore engine (reuse only an identical config and action prefix)
04 Validate model identity, dimensions, lengths and asset integrity
05 Run the selected strategy; report candidates and metric meaning
06 Receiver checks request/context again and validates the chosen action
07 On timeout/error: preserve recoverable match and expose retry
```

Record model label, trainer, exported asset, runtime strategy and evidence tier separately to diagnose differences. Full state and comparable evaluations are algorithm contracts; contents, pagination and equation display are reader contracts. The two articles have independent exposition, while formulas, budgets and source references require version checks.

Source: web/web前端/AIStateProtocol.js / ReplayCodec.js → state identity, full restoration and isolated replay validation.
