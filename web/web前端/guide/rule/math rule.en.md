# LIFELINE: Formal Model and Theory

Abstract. Under fixed territory-v3 rules, we formulate a history-complete finite game and derive state/horizon bounds, connectivity and flood correctness, tightening termination, minimax error bounds and conditional benefits of topology. The four chapters are Mathematics, Algorithms, AI and Topology.

Base derivations: 2026-10-25; topology chapter independently derived by the primary agent and source-checked on 2026-10-29. Claims state assumptions and proofs or proof sketches. Encoding upper bounds are not reachability lower bounds, and communication-path benefits are not strength experiments. See the companion Code report for implementation and source audits.

Reading path: chapter I defines notation and full state; II develops rule algorithms; III develops AI; IV gives triangulation, algebraic topology, a double-torus construction and permanent-connection certificates. In territory-v3 the score always counts owned points and separately adds enemy-free pockets cut off from the exterior. The official set supplies area and renderPoints. Display may use hull/tightened polygons intersected with actual board faces, without ribbons along lone lines or shading holes/exterior. Display never changes scores; old replays retain their recorded rule versions.

**Contents**

[I. Mathematics](#i-mathematics)

- [1.1 Lattice and graphs](#11-lattice-and-graphs)

- [1.2 State and legal actions](#12-state-and-legal-actions)

- [1.3 History and transitions](#13-history-and-transitions)

- [1.4 State and horizon bounds](#14-state-and-horizon-bounds)

- [1.5 Values and game structure](#15-values-and-game-structure)

- [1.6 Information requirements](#16-information-requirements)

[II. Algorithms](#ii-algorithms)

- [2.1 Connections and cuts](#21-connections-and-cuts)

- [2.2 Discrete territory](#22-discrete-territory)

- [2.3 Flood-fill properties](#23-flood-fill-properties)

- [2.4 Tightening guarantees](#24-tightening-guarantees)

- [2.5 Paths and complexity](#25-paths-and-complexity)

- [2.6 Symmetry and caching](#26-symmetry-and-caching)

[III. AI](#iii-ai)

- [3.1 Minimax recurrence](#31-minimax-recurrence)

- [3.2 Alpha–beta advantage](#32-alphabeta-advantage)

- [3.3 Evaluation error bounds](#33-evaluation-error-bounds)

- [3.4 Graph representation](#34-graph-representation)

- [3.5 Priors and PUCT](#35-priors-and-puct)

- [3.6 Learning objectives](#36-learning-objectives)

- [3.7 Multiplayer decisions](#37-multiplayer-decisions)

- [3.8 Guarantees and evidence](#38-guarantees-and-evidence)

[IV. Topology boards: triangulation and algebraic topology](#rulesMath-topology)

- [4.1 Playing from an atlas](#41-playing-from-an-atlas)

- [4.2 Triangles, cells and quotient spaces](#42-triangles-cells-and-quotient-spaces)

- [4.3 When the complex is a surface](#43-when-the-complex-is-a-surface)

- [4.4 Why valence six is not universal](#44-why-valence-six-is-not-universal)

- [4.5 Computing holes with a chain complex](#45-computing-holes-with-a-chain-complex)

- [4.6 Closed, separating and contractible differ](#46-closed-separating-and-contractible-differ)

- [4.7 Discrete territory, display area and confinement](#47-discrete-territory-display-area-and-confinement)

- [4.8 Topology does not specify straightness](#48-topology-does-not-specify-straightness)

- [4.9 A constructive double torus and embedded 3D](#49-a-constructive-double-torus-and-embedded-3d)

- [4.10 A sufficient certificate of permanent connection](#410-a-sufficient-certificate-of-permanent-connection)

- [4.11 Long-term strategy under a finite budget](#411-long-term-strategy-under-a-finite-budget)

- [4.12 What a random-surface probability means](#412-what-a-random-surface-probability-means)

- [4.13 Sources, scope and verification](#413-sources-scope-and-verification)

## I. Mathematics

Fix territory-v3, board shape, side length, player count and actual starts. A game excludes undo, restart, clock forfeits and repeatedly rejected inputs. The results concern completed rule transitions; a computation timeout is not a mathematical terminal state.

### 1.1 Lattice and graphs

Let N≥2 be side length, p the player count and M the number of lattice points. Use nonnegative coordinates for a triangle and centered axial coordinates with R=N−1 for a hexagon. The lattice graph G₀=(V,E₀) has at most six neighbors per vertex, so |E₀|≤3M. It is distinct from a player’s logical-link graph.

$$
\begin{aligned}V_\triangle&=\{(x,y)\in\mathbb Z_{\ge0}^2:x+y\le N-1\},\\M_\triangle&=\sum_{j=1}^{N}j=\frac{N(N+1)}2,\\V_{\mathrm{hex}}&=\{(q,r)\in\mathbb Z^2:\max(|q|,|r|,|q+r|)\le R\},\\M_{\mathrm{hex}}&=1+\sum_{k=1}^{R}6k=3N(N-1)+1.\end{aligned}
$$

Proof: triangular rows contain N,N−1,…,1 vertices. Hexagonal ring k contains 6k vertices around the center. N=15 gives 120 and 631. These count vertices, not triangular faces. The direction set is D={(1,0),(−1,0),(0,1),(0,−1),(1,−1),(−1,1)}; screen projection does not change adjacency.

### 1.2 State and legal actions

Let B:V→{∅,NODE₁,LINE₁,…,NODEₚ,LINEₚ}. Player i has node set Uᵢ, line-point set Lᵢ, explicit undirected links Eᵢ and actual start rᵢ. The complete rule state includes the actual actor i, consecutive passes c, resignations D, terminal flag g and Superko history H; configuration Ω is fixed. Counters, caches and revisions are implementation state, excluded from strategic counting unless an added rule depends on them.

$$
S=(\Omega,B,(E_j)_{j=1}^{p},i,c,D,g,H),\qquad A(S)=A_{\rm place}(S)\cup A_{\rm pass}(S)\cup A_{\rm resign}(S).
$$

Voluntary passing is allowed before termination. A placement must satisfy occupancy, start protection, the three-point limit, a clear friendly connection and no repeated trial key. Put dᵢ(v)=|N₀(v)∩Uᵢ|. Unless directly cutting an enemy LINE, require dᵢ(v)=0, or dᵢ(v)=1 with its sole friendly neighbor u satisfying dᵢ(u)=0 in the old occupancy. This forbids three-node chains or clusters, not only elementary triangles. A direct cut bypasses only this condition.

### 1.3 History and transitions

A placement first performs a trial update: node insertion, links, cuts, disconnected-component removal and reconnection, producing B′ and E′. Let j be the next non-resigned player. The source constructs κ using j before automatically skipping players without legal moves. Only afterwards does it extend history, reset c and normalize turns. This key is not the hash of the fully normalized rule state.

$$
\begin{aligned}\kappa&=\operatorname{JSON}(j,D,\operatorname{sort}(B'_{\ne\varnothing}),\operatorname{sort}(E'_1),\ldots,\operatorname{sort}(E'_p)),\\a\in A_{\rm place}(S)&\iff \operatorname{LocalLegal}(S,a)\ \land\ \kappa\notin H,\\H'&=H\cup\{\kappa\}.\end{aligned}
$$

Hash is a canonical serialized string; Set uses string identity rather than an explicitly truncated integer digest. With H retained, the transition and legality are functions of S. Occupancy B alone does not generally provide that guarantee. Pass and resignation use separate transitions; unchanged occupancy does not invalidate PASS.

### 1.4 State and horizon bounds

Proposition 1, a coarse encoding upper bound. With Ω fixed, let K count possible Superko keys. Each point has at most 2p+1 states. Relax each player’s link set to an arbitrary subset of all vertex pairs, allow p next actors and at most 2ᵖ resignation sets. Relaxing consistency constraints can only enlarge the count. This is an upper bound, not an estimate or lower bound on reachable positions.

$$
\begin{aligned}K&\le \overline K:=p\,2^p(2p+1)^M\,2^{p\binom M2},\\\log_2\overline K&=\log_2p+p+M\log_2(2p+1)+p\binom M2,\\|\mathcal S|&\le 2(p+1)\,\overline K\,2^{\overline K}.\end{aligned}
$$

For complete states multiply by at most 2ᴷ history subsets, p+1 pass counts and two terminal flags, then replace K by K̄. Proposition 2, finite termination: every accepted placement adds a new key, so L≤K−1; there are R≤p resignations. Between events resetting the pass count, at most p passes end the game. Thus T≤L+R+p(L+R+1)≤(p+1)(K̄+p), including automatic skips in this loose bound. Pieces need not increase monotonically; cuts may remove them.

$$
L\le K-1,\quad R\le p,\quad T\le (p+1)(\overline K+p),\qquad b\le M+2.
$$

The bound b≤M+2 models the current actor choosing a placement, PASS or their own resignation. The engine also accepts resignation events for other seats through resignPlayer(player). Counting all such external events as node commands gives the conservative bound b≤M+p+1. The turn-based game recurrences below use the former decision model.

This enormous bound establishes finiteness only. A naive search tree has at most Σ(t=0…T)bᵗ nodes. That is not a complexity lower bound and proves neither NP-hardness, PSPACE-hardness nor a first-player win. Finite positions, finite histories and feasible computation are different claims.

### 1.5 Values and game structure

Proposition 3: use terminal win/draw/loss utilities 1/0/−1 for two players with fixed starts. Backward induction on the finite perfect-information tree gives pure subgame-perfect strategies and a minimax value. Proof by tree height: leaves have fixed utility; finite MAX and MIN action sets attain their extrema. Existence does not require a powerful neural network.

For three or more players use u=(u₁,…,uₚ); each actor maximizes its own component. Finite perfect-information backward induction still yields a pure equilibrium, potentially nonunique. Other players are not a single MIN opponent. Even the constant-sum convention assigning 1/(number of tied winners) does not give the two-player minimax identity.

An extra node changes cuts, adjacency restrictions and history, so the harmless-extra-piece premise of a strategy-stealing proof is unavailable without proof. Voluntary passing also invalidates an argument based on compulsory placement. No first- or second-player forced win is established here.

### 1.6 Information requirements

Proposition 4, conditional state aliasing. Suppose two reachable states S₁,S₂ have identical observation φ, a trial key κ belongs to H₁ but not H₂, and all other checks pass. The action then has different legality by section 1.3. A deterministic function of φ alone cannot correctly decide both. Reachability of such a pair is an explicit premise; arbitrary invented histories are not a reachable witness.

$$
\phi(S_1)=\phi(S_2),\quad \kappa\in H_1\setminus H_2\ \Longrightarrow\ \mathbf1\{a\in A(S_1)\}\ne\mathbf1\{a\in A(S_2)\}.
$$

A supplied legal mask filters current actions but does not automatically recover all future history-dependent transitions. A sufficient abstraction must preserve rewards, action sets and successor observation distributions for every shared action between equally encoded states. Seven or eleven local channels do not prove that property; search retains the full engine state.

## II. Algorithms

Treat rule operations as discrete operators. Their correctness targets are the root component, coverage for a supplied wall, and a greedy fixed point over generated candidates. None is interchangeable with a globally optimal polygon.

### 2.1 Connections and cuts

Two coordinates are lattice-collinear when xᵤ=xᵥ, yᵤ=yᵥ or xᵤ+yᵤ=xᵥ+yᵥ. A direct connection also requires no enemy NODE/LINE in the interior. After connecting the new node, attacks and reconnections are processed. Cleanup uses the attacked player’s logical graph Gᵢ=(Uᵢ,Eᵢ), not adjacency among all occupied lattice points.

$$
R_i=\operatorname{Reach}_{(U_i,E_i)}(r_i),\qquad U_i^{\rm keep}=R_i,\qquad E_i^{\rm keep}=\{\{u,v\}\in E_i:u,v\in R_i\}.
$$

Proposition 5: BFS retains exactly the root component. Every enqueued vertex has a known path from the root; conversely, induction along any shortest root path shows every reachable vertex is eventually enqueued. Explicit-graph BFS costs O(|Uᵢ|+|Eᵢ|). Checking all lattice points on geometric links has additional cost, so this does not make the entire attack operation O(M).

### 2.2 Discrete territory

Let Fᵢ=Uᵢ∪Lᵢ be player i’s occupied node and line points, Eᵢ all enemy node and line points, G_V the lattice adjacency graph, and ∂V the board boundary. Delete Fᵢ and run multi-source BFS from the remaining boundary points. Each unvisited connected component Qₖ is a pocket enclosed by friendly points. Let Bᵢ be the union of components satisfying Qₖ∩Eᵢ=∅, and define the official territory set Rᵢ=Fᵢ∪Bᵢ. This needs no single closed polygon and naturally includes donut holes and multiple disjoint pockets.

$$
\begin{aligned}X(W)&=\operatorname{Reach}_{G_0[V\setminus W]}(\partial V\setminus W),\\C(W)&=V\setminus X(W),\\c(W)&=|C(W)|=|W|+|C(W)\setminus W|,\qquad 0\le c(W)\le M.\end{aligned}
$$

$$
B_i=\bigcup_{k:\,Q_k\cap E_i=\varnothing}Q_k,\qquad R_i=F_i\cup B_i,\qquad a_i=|R_i|=|F_i|+|B_i|,\qquad \operatorname{renderPoints}_i=\operatorname{ord}_V(R_i).
$$

The official score is aᵢ=|Rᵢ|. Each point counts once, so 0≤aᵢ≤M. renderPointsᵢ is merely the stable board-order enumeration of the same set Rᵢ, hence |renderPointsᵢ|=aᵢ; order supports deterministic serialization and caching without changing membership or score. An open chain or single line has Rᵢ=Fᵢ when it creates no pocket. Every safe pocket is added separately; an inner donut hole also counts when it contains no enemy point. A single polygon and displayArea are only geometric diagnostics/legacy compatibility, not Rᵢ or aᵢ. The old territory-v2 six-player scores (25,10,11,13,8,8) are historical and must not be treated as verified v3 values.

### 2.3 Flood-fill properties

Proposition 6: after deleting Fᵢ, the connected components among vertices unvisited by boundary multi-source BFS are exactly the bounded pockets. Testing each component against Eᵢ yields exactly Bᵢ. The same traversal can therefore construct Rᵢ, aᵢ and renderPointsᵢ together, making renderPoints sound and complete for the official score set. Display shading may separately use clipped geometry without filling ribbons along lines. The ordinary triangular lattice has degree≤6, giving O(M) time and O(M) auxiliary space; a general topology graph uses O(|V|+|E_G|). An interface that explicitly emits aᵢ coordinates also has an Ω(aᵢ) output-time and output-space lower bound. No simple polygon or single-pocket assumption is needed; a single line has no pocket but Fᵢ still scores without requiring an area ribbon in the display.

$$
|\operatorname{renderPoints}_i|=|R_i|=a_i,\qquad T_{\rm flood}=O(M),\qquad S_{\rm aux}=O(M),\qquad T_{\rm explicit\ output},S_{\rm explicit\ output}=\Omega(a_i).
$$

$$
W\subseteq W'\quad\Longrightarrow\quad X(W')\subseteq X(W)\quad\Longrightarrow\quad C(W)\subseteq C(W').
$$

Proposition 7, monotonicity: adding walls removes traversable vertices and sources, never creating exterior paths. An upper-envelope wall containing every candidate wall can therefore certify infeasibility: if even its coverage misses a required friendly node, every subwall misses it too. This does not certify cycles, enemy exclusion or that shorter perimeter always means smaller coverage.

### 2.4 Tightening guarantees

Let ℓ(ρ) count contour-walk steps and c(ρ) be that contour’s closed-coverage diagnostic. Compare J(ρ)=(ℓ(ρ),c(ρ)) lexicographically. Shortest paths between contour endpoints generate candidates; the best admissible strict improvement is accepted, or the algorithm stops. Proposition 8: with finite initial length ℓ₀, at most (ℓ₀+1)(M+1)−1 strict acceptances occur. Length never increases and both coordinates are bounded integers; strict descent cannot revisit a pair.

$$
J(\rho_{t+1})<_{\rm lex}J(\rho_t),\qquad T_{\rm accept}\le(\ell_0+1)(M+1)-1.
$$

Termination guarantees no strict improvement among the generated candidates. Global minimization over all feasible closed walks has a larger search space. A shorter perimeter takes priority even if coverage increases. There is no claim of a global optimum, monotone area decrease or approximation ratio. Canonical orientation selection is a separate operation in section 2.6.

### 2.5 Paths and complexity

BFS obtains shortest distances and a predecessor DAG from one source in O(M), but enumeration also depends on path count. In an unobstructed triangle, paths from (0,0) to (k,k), N≥2k+1, have k steps of each positive axis direction. There are (2k choose k) shortest paths, asymptotic to 4ᵏ/√(πk). Using BFS does not make the entire tightening algorithm linear.

$$
P_k=\binom{2k}{k}\sim\frac{4^k}{\sqrt{\pi k}},\qquad T_{\rm raw}=O\!\left(\sum_t\left[\ell_tM+(\ell_t^2+J_t)(M+\ell_t)\right]\right).
$$

This conservative structural bound includes enumeration: Jₜ counts visited path prefixes and candidates; ℓₜM allows one BFS per contour source, and remaining terms allow linear checks per endpoint pair and candidate. Basic index operations are unit-cost; string and sorting overhead is separate. Caches, equivalent-wall reuse, envelopes and perimeter bounds reduce repeated work or Jₜ without automatically removing worst-case combinatorial growth.

### 2.6 Symmetry and caching

If g bijectively preserves lattice adjacency and the outer boundary, it maps paths pointwise, yielding C(gW)=gC(W) and equal counts. Thus flood fill for a supplied wall is geometrically equivariant. A greedy program with fixed clockwise order and coordinate tie-breaking need not inherit that property automatically.

$$
C(gW)=gC(W),\qquad B_i(gS)=gB_i(S),\qquad a_i(gS)=|gF_i|+|gB_i(S)|=a_i(S).
$$

The source first uses territory-v2 seat transforms Tᵢ to select a diagnostic/compatibility polygon by closed coverage and canonical contour key. It then computes the official v3 Rᵢ, area and renderPoints independently from all friendly walls and safe pockets. Triangles use barycentric permutations and hexagons rotations/reflections. Symmetry conclusions require bijective correspondence between candidate sets; arbitrary custom starts need not retain full D₆ symmetry. Representation bias in polygon does not alter the same-source Rᵢ and aᵢ.

A sufficient cache condition is that its key preserve every input dependency of the cached function. Geometry-only coverage does not read history; legality and search do. Reusing a board/edges/actor key for the latter would omit H. A v3 runtime cache must also treat area and renderPoints as one indivisible result and deep-copy coordinates across engine/search snapshots or Worker boundaries; otherwise a correct score can still display a stale set. A versioned replay may omit the recomputable derived set, but loading must reconstruct it. Dependency separation avoids irrelevant invalidation without deleting rule-relevant information.

## III. AI

Separate solving power, evaluation error, representation advantages and finite-sample evidence. Every guarantee states its conditions; an algorithm name, parameter count or local search score is not proof of playing strength.

### 3.1 Minimax recurrence

Measure values from root player r’s perspective. Recursion uses actual actor i(S), because automatic skips can let the same player act twice. The theoretical full tree includes every legal action, including PASS, and uses true terminal utilities. Existing two-player code caps candidates at 20, omits voluntary PASS while placements exist and uses heuristic F even at terminal branches. It evaluates a particular truncated tree.

$$
V_d(S)=\begin{cases}u_r(S),&S\text{ terminal},\\f(S),&d=0,\\\max_{a\in A(S)}V_{d-1}(T(S,a)),&i(S)=r,\\\min_{a\in A(S)}V_{d-1}(T(S,a)),&i(S)\ne r.\end{cases}
$$

The implemented F=15Δnodes+8Δcoverage+20Δreach+12attackable line points+10root-connectivity quality. Reach expands from friendly occupied points and is not official territory. Depths 2,3,4 count action plies. F is a fast surrogate, with no established uniform error constant or equivalence to true outcome.

### 3.2 Alpha–beta advantage

Proposition 9: alpha–beta preserves the minimax root value on the same candidate tree and leaf values. Alpha bounds what MAX can already secure and beta what MIN can already enforce; beta≤alpha makes further descendants irrelevant to that ancestor’s choice. The argument uses bounds, not calibrated win probabilities. Identical chosen moves additionally require identical tie-breaking.

$$
N_{\rm worst}=b^d,\qquad N_{\rm ideal}=b^{\lceil d/2\rceil}+b^{\lfloor d/2\rfloor}-1=O(b^{d/2})\quad(d\text{ even}).
$$

The leaf formula assumes a uniform branching factor, fixed depth and ideal ordering. Worst ordering remains bᵈ. Pruning can inspect less of the same tree; candidate truncation changes the tree. The source also scores root candidates separately, so measured visits and wall time need not equal the ideal expression.

### 3.3 Evaluation error bounds

Proposition 10: on the same finite search tree, if every cutoff estimate f differs from the true continuation value f* by at most ε, the backed-up root error is at most ε. Max and min are 1-Lipschitz in the sup norm; induction proves the result without multiplying by depth. If every root Q estimate has that error, choosing its estimated maximum has true regret at most 2ε.

$$
\begin{aligned}|\max x-\max y|&\le\|x-y\|_\infty,\\Q^*(a^*)-Q^*(\hat a)&\le[Q^*(a^*)-\widehat Q(a^*)]+[\widehat Q(\hat a)-Q^*(\hat a)]\le2\varepsilon.\end{aligned}
$$

For retained root actions A′, define omission loss δ=maxₐ∈A Q*(a)−maxₐ∈A′ Q*(a). If retained continuation estimates still have error ε, regret is at most δ+2ε. When every level is truncated, internal omissions must be included in Q error. No validated ε or δ is available for the current heuristic, 16-simulation PUCT or 20-candidate cap; these are conditions for evaluating improvements, not certificates already earned.

### 3.4 Graph representation

Grid GNN uses lattice relations; Topology GNN adds friendly and enemy logical links. The source averages neighbors per relation, projects the mean, adds the self projection, then applies ReLU, residual addition and per-node layer normalization. Biases are omitted below and empty-neighborhood messages are zero.

$$
\begin{aligned}m_{v,r}^{(l)}&=\frac1{|N_r(v)|}\sum_{u\in N_r(v)}h_u^{(l)},\\h_v^{(l+1)}&=\operatorname{LN}\!\left(h_v^{(l)}+\operatorname{ReLU}\!\left(W_0h_v^{(l)}+\sum_rW_rm_{v,r}^{(l)}\right)\right).\end{aligned}
$$

Proposition 11, local propagation depth: an L-layer lattice message-passing node embedding, before pooling, depends only on its L-hop neighborhood, by induction. A logical edge between endpoints at grid distance D permits a one-hop message; grid-only propagation needs at least D layers for that node-level route. This is an available communication path, not guaranteed learned use. A globally pooled value head does not have the same node-locality restriction.

Simultaneously permuting node indices, features and relations preserves equivariance of shared linear layers and mean aggregation. Physical rotation changes absolute x,y features, however, so rotational invariance does not follow. Mean aggregation can alias different multisets; pooling opponents can lose individual identity. Eleven channels still do not recover full H.

### 3.5 Priors and PUCT

On legal actions A, stable softmax subtracts the largest logit, preserving probabilities while avoiding overflow from large positive exponents. PUCT allocates visits using prior P and empirical mean Q. In two-player search σ=+1 for the root actor and −1 for the opponent; backups retain root perspective instead of alternating signs by depth.

$$
P(a\mid S)=\frac{e^{z_a-z_{\max}}}{\sum_{b\in A(S)}e^{z_b-z_{\max}}},\qquad U(S,a)=\sigma Q(S,a)+cP(a\mid S)\frac{\sqrt{\max(1,N(S))}}{1+N(S,a)}.
$$

Neural values and random rollouts are budget-limited surrogates. Plain UCT uses c√(log N/n); PUCT incorporates P. The Mini Game uses 16 neural simulations with c=1.5 and exact territory at terminal leaves. Most visits is a decision rule, not proof of optimality or calibrated win probability. Asymptotic consistency needs assumptions and a theorem for the specific method; a UCT name does not confer it on finite-budget PUCT.

### 3.6 Learning objectives

With current-actor values, use σₜ=+1 if the same player acts next and −1 if the opponent does; fixed-root values need no change. Masked Double DQN selects with the online network and evaluates with the target network. The research dqn.py uses a fixed negative sign. Interpreting it as σₜ=−1 requires the training transition convention, not merely a Web model label or assumed cross-engine equivalence.

$$
a' =\arg\max_{a\in A(S')}Q_\theta(S',a),\qquad y=r+\gamma\sigma_t(1-d)Q_{\bar\theta}(S',a'),\qquad L_Q=\mathbb E[\operatorname{Huber}(Q_\theta(S,a)-y)].
$$

PPO clips policy ratios on a collected batch. This limits incentives in parts of its surrogate objective, without guaranteeing monotone improvement in true return after every update. Discrete SAC uses the smaller of two Q estimates and entropy regularization, updating Q and policy separately. Browser play only evaluates the exported forward network.

$$
\begin{aligned}L_{\rm PPO}&=\mathbb E[\min(\rho_tA_t,\operatorname{clip}(\rho_t,1-\epsilon,1+\epsilon)A_t)],\quad\rho_t=\frac{\pi_\theta(a_t\mid S_t)}{\pi_{\rm old}(a_t\mid S_t)},\\V_{\rm soft}(S)&=\sum_a\pi(a\mid S)[\min(Q_1,Q_2)(S,a)-\alpha\log\pi(a\mid S)],\\L_{\pi}^{\rm SAC}&=\mathbb E_S\sum_a\pi(a\mid S)[\alpha\log\pi(a\mid S)-\min(Q_1,Q_2)(S,a)].\end{aligned}
$$

Source boundary: train_imitation_adversarial.py currently shares one loop for gail and gan labels, mainly changing seed offset and metadata. The discriminator labels expert samples 1 and policy samples 0, while the generator minimizes −Σₐπ(a|s)log σ(−D(s,a)). With D fixed this favors smaller D, not a larger expert-label probability. Standard GAIL occupancy-matching results therefore cannot certify this script, and the labels do not establish two different theoretical algorithms. This report changes neither training nor weights.

### 3.7 Multiplayer decisions

A 16-feature policy ranks z(a)=wᵀf(S,a)/τ and produces softmax priors. V4 compares three root candidates under V1/V2 response models with 12 further plies; V5 checks at most two close candidates and five response plies when tactical triggers hold. Shortlists reduce computation while introducing omission error.

$$
\widehat V_i(S,a)=\frac1{J}\sum_{j=1}^{J}F_i(\operatorname{Rollout}(S,a;\pi_{-i}^{(j)})),\qquad V_i^{\rm robust}(S,a)=\min_{\pi_{-i}\in\Pi_{-i}}V_i(S,a;\pi_{-i}).
$$

A finite response-policy average differs from worst-case optimization over all opponents; the former is not automatically a lower bound on the latter. Paranoid search treats opponents as one MIN coalition and can be pessimistic; selfish rollouts can be exploited by unmodeled policies. Later Web hard mode falls back to complete phases; the ultimate candidate can also publish completed fair comparisons. That budget mechanism does not mean every root has finished.

### 3.8 Guarantees and evidence

Provable benefits are specific: O(M) flood coverage for a fixed wall; history-complete rule transitions; value-preserving alpha–beta with potential visit reduction; shorter node communication paths through topology; and dependency-correct reuse. Unproved items include global greedy optimality, uniform F error, finite-budget search optimality, model strength ranking and transfer across rules.

For J prespecified policies, each with n IID complete-game returns X∈[0,1], Hoeffding plus a union bound gives the expression below. Complete games, not moves within one trajectory, are the independent units. Paired differences in [−1,1] need the corresponding range length. Deterministic replay on fixed starts reports test-set performance without automatically satisfying IID assumptions.

$$
\Pr\!\left(\max_{1\le j\le J}|\widehat\mu_j-\mu_j|>\varepsilon\right)\le2J e^{-2n\varepsilon^2},\qquad n\ge\frac{\log(2J/\delta)}{2\varepsilon^2}.
$$

Reproduction records rules and source hashes, configuration, full actions or state and history, model/weight hashes, candidate/depth/time budgets and random seeds. These are inspectable derivations and source correspondences, not newly established formal experimental results. Entry points are GameEngine, AIEngine, ResearchAI, ModelFreeAI, ThreePlayerSearchAI, HexFastSearchAI and Multiplayer modules; the companion Code report gives pseudocode and training-source distinctions.

## IV. Topology boards: triangulation and algebraic topology

Separate where a point is drawn from which point it is. The atlas is an interface; a quotient of triangular faces defines the board. Moves, paths, scoring, display and AI use different structures on that object. Intuition, examples, definitions, propositions and proofs distinguish theorems, game conventions and strategic heuristics.

### 4.1 Playing from an atlas

Choose the shape after players, first player and size. Topology reveals presets, random boards and the editor; size 5–15 scales the lattice. Random starts replace the layout with one per active player. Add random start appends one for the selected player; manual selection still supports 1–6 per player. Copies of one canonical point are one playable point and share occupation, deletion, highlighting and scoring.

Draw boundary adds closed contours with even-odd interior and holes. Gluing selects two boundary unit edges and their directions. Solid lines are real boundaries; numbered dashed arrows pair seams. Adding contours after gluing revalidates pairs and preserves only those still valid; an internal edge is not silently cut. Full JSON tools are collapsed. A double torus uses front and back charts of one board.

Noncrossing triangular-direction play, the three-point restriction and actual-cut exception, protection, disconnection and Superko still apply. A pole may have several actual sectors: an incoming line stops there and a new line may leave through any actual sector. Replay and import retain the complete definition, paths, roots, actor and history; failed validation cannot replace an active match.

### 4.2 Triangles, cells and quotient spaces

Imagine gluing finitely many triangular sheets along directed edge segments. Let X be their disjoint union and K=X/~ the endpoint-matched quotient. Canonical vertices are 0-cells, triangles are 2-cells, and edge equivalence classes are 1-cells. Two distinct edges with the same endpoints remain different cells. Adjacency alone loses them and cannot distinguish a triangular frame from a filled triangle.

$$
K=\left(\coprod_{f\in\mathcal F}\Delta_f^2\right)\!\big/\sim,\qquad V=|K^{(0)}|,\quad E=|\mathcal E|,\quad F=|\mathcal F|.
$$

This is a finite triangular cell/Delta-type representation, not automatically a strict simplicial complex. In a simplicial complex a vertex set determines a simplex and intersections are common faces; parallel edges already violate the first condition. Suitable subdivision may give a strict triangulation. The game supports finite piecewise-linear edge attachments, not arbitrary-dimensional CW complexes or arbitrary continuous attaching maps.

BoardDefinition stores faces, edge occurrences and endpoint directions; BoardCompiler produces canonical vertices and edgeClasses; BoardPaths retains complete logical routes. Endpoints no longer uniquely identify a route. Atlas copies serve rendering and hit testing, never extra pieces or points.

### 4.3 When the complex is a surface

A small neighborhood around a vertex meets adjacent triangles in its link. An interior link should be one circle; a boundary link, one interval. Proposition T1: for this finite pure triangular gluing, if every edge has one or two incident faces and every vertex link is a circle or interval, each point has a disk or half-disk neighborhood, so K is a compact surface with boundary.

Proof: face interiors have disk neighborhoods; edge interiors have half-disks or disks according to incidence. A vertex star is the cone on its link, giving the required neighborhood. Finitely many closed faces give compactness. Branched or disconnected links produce nonmanifold points, allowed in a custom complex but not labeled a random surface. Valence six is not the manifold criterion: a sphere pole can have a circular link at another valence.

Orient faces and propagate signs across common edges; a contradiction detects nonorientability. Real boundary edges have one incident face; boundary circles use incidence multiplicities. Surface classification gives chi=2−2g−b when orientable and chi=2−k−b otherwise. Here g counts handles, k crosscaps and b real boundary circles. A cylinder has b=2,g=0; a Möbius strip b=1,k=1; a plane region with two holes b=3,g=0; a closed double torus b=0,g=2.

### 4.4 Why valence six is not universal

Proposition T2: for a compact triangulated surface, count degrees with edge multiplicity and separate interior from boundary vertices. The following discrete Gauss–Bonnet identity holds. On a closed surface the boundary term disappears; valence six everywhere forces chi=0, so spheres and closed surfaces of genus greater than one need exceptional vertices.

$$
\sum_{v\in V^\circ}(6-\deg v)+\sum_{v\in V^\partial}(4-\deg v)=6\chi(K),\qquad\chi(K)=V-E+F.
$$

Proof: triangle incidences give 3F=2E−E_boundary, the handshake identity gives sum degree=2E, and boundary circles give E_boundary=V_boundary. Thus 6chi=6V−2E−2V_boundary, the stated sum. For equilateral faces, interior angle defect is (pi/3)(6−degree) and boundary turning is (pi/3)(4−degree), totaling 2pi chi. This is curvature of the intrinsic discrete metric, not visual bending in a 3D preview.

### 4.5 Computing holes with a chain complex

Intuition: shade several triangles; shared sides cancel, leaving a boundary. The implementation uses F2 so even incidences cancel without orientation signs. C0, C1 and C2 have bases given by canonical vertices, edge classes and faces. d1 maps edges to endpoints, d2 faces to their three sides. Each triangle vertex appears twice, proving d1 d2=0.

$$
C_2\xrightarrow{\partial_2}C_1\xrightarrow{\partial_1}C_0,\quad H_j=\ker\partial_j/\operatorname{im}\partial_{j+1}.\quad \beta_0=V-r_1,\ \beta_1=E-r_1-r_2,\ \beta_2=F-r_2.
$$

Proposition T3 follows from rank–nullity; subtracting gives beta0−beta1+beta2=V−E+F. Beta0 counts components, beta1 independent mod-two one-dimensional holes, beta2 mod-two 2-cycles. The sphere gives (1,0,1), torus (1,2,1), double torus (1,4,1), disk (1,0,0), cylinder and Möbius strip both (1,1,0). Klein bottle and torus both give (1,2,1); F2 homology cannot distinguish them, whereas orientability does. Integer homology additionally detects the Klein bottle’s order-two torsion.

TopologyAlgebra uses exact bit columns and XOR elimination, checking boundary squared face by face. It also computes relative chains C*(K,boundary K) by quotienting boundary vertices and edges. An arc ending on the real boundary can be a relative cycle without being an ordinary closed line. This is a diagnostic and validation tool, not a replacement for territory flood fill.

### 4.6 Closed, separating and contractible differ

Proposition T4: on a connected closed surface, one embedded circle c separates exactly when [c]=0 in H1(K;F2). It must be a single embedded circle with no real boundary on the ambient surface. This is not a blanket test for self-crossing chains, sums of circles or nonmanifold complexes. analyzeEdgeCycle returns separating only after checking the hypotheses, otherwise null.

Proof: if c separates, the mod-two sum of faces on one side has boundary c. Conversely, when c=d2 A, adjacent face coefficients agree across every side outside c and differ across c. A path avoiding c cannot pass from coefficient 0 to 1. Disk neighborhoods and embeddedness ensure both sides exist, so the complement disconnects. Mod-two coefficients make this argument independent of orientability.

A torus meridian is closed but nonseparating. The waist separating two handles is null-homologous and separating yet not contractible: neither side is a disk. Thus null-homology does not mean no winding or contractibility. Surfaces with boundary need boundary-aware or relative arguments. The game instead uses its full discrete adjacency and actual boundary, never screen-inside/outside alone.

### 4.7 Discrete territory, display area and confinement

Let G be canonical sample adjacency, Wi friendly node/line samples, Oi enemy samples, and B the real boundary samples. Iterate components Q of G−Wi. The official rule below includes triangular and hexagonal boards as bounded cases. On closed surfaces B is empty, but enemy components still must be excluded. An enclosed enemy pocket is a confinement target, not already owned safe territory.

A closed surface has no real boundary. Under this discrete convention, any remaining component without enemy elements scores even when it does not look enclosed on screen; a component containing an enemy is excluded in full. This is a game rule, not a consequence of geometric surface area.

$$
R_i=W_i\cup\!\bigcup_{\substack{Q\in\pi_0(G-W_i)\\Q\cap B=\varnothing,\ Q\cap O_i=\varnothing}}Q,\qquad a_i=\sum_{v\in R_i}w_v.
$$

Proposition T5: multi-source BFS plus enemy checks produces exactly Ri in O(|V|+|E_G|). Every queued vertex has a source path and induction along shortest paths reaches every accessible vertex; inspecting remaining components completes the rule. This is graph connectivity/H0, not automatically the topology of the continuous complement K−Wi or its geometric area.

Display may retain hull and tightening influence, but intersects it with the actual board faces, excluding holes and real exterior. Seam and 3D mapping use the same face identity. Counting line samples does not require filling a ribbon along a lone line. Hull shading, geometric display area and official ai remain separate; rendered pixels never decide the winner.

### 4.8 Topology does not specify straightness

A torus admits many metrics; knowing it has one handle does not define a straight line. The game additionally chooses six triangular directions, seam transport determined by endpoints and incident-face side, and stopping at special vertices. A crossing stores direction transport and the actual path, not a screen-space endpoint chord. One trip around a Möbius strip reverses a local frame, which must be retained.

A legal discrete straight route, a shortest route in a homology class and a global geodesic are different problems. Only the first continuation rule is implemented; stopping at a pole is a game convention. Inverse seam transport, physical-route deduplication and retaining distinct same-endpoint routes keep cuts, disconnection and replay consistent.

### 4.9 A constructive double torus and embedded 3D

Project construction: take a connected planar triangulated region D with h disjoint holes away from the outer boundary. Glue front and back copies along every corresponding boundary side: Double(D). Proposition T6: this is a connected closed orientable surface of genus h. Interior neighborhoods remain disks and paired half-disks become disks. Reversing the back orientation makes orientations consistent. The h+1 boundary circles have Euler characteristic zero, giving chi(Double(D))=2chi(D)−chi(boundary D)=2−2h and hence genus h.

$$
\chi(D)=1-h,\qquad\chi(\operatorname{Double}(D))=2-2h,\qquad h=2\Longrightarrow(\chi,\beta_0,\beta_1,\beta_2)=(-2,1,4,1).
$$

Do not guess a shell that merely looks like two doughnuts. Barycentrically subdivide D for rendering only. Give true boundary samples height zero and all interior subdivision samples positive height; linear interpolation produces t with zero set exactly boundary D. Map sheets to (x,y,+t) and (x,y,−t). Each sheet projects identically without crossings; the sheets meet only at t=0, exactly the glued boundary. The resulting continuous bijection from the compact quotient to its image is a homeomorphism, proving an embedding.

Critical counterexample: an interior edge can have both endpoints on the boundary. Heights on original vertices alone would collapse that whole edge to zero and pinch the sheets. Interior edge midpoints and face centers must be positive. Render triangles retain their source faceId and barycentric coordinates; subdivision adds no game samples or score. A Klein bottle cannot embed without self-intersections in Euclidean 3-space, so its immersion/atlas must be labeled accordingly.

### 4.10 A sufficient certificate of permanent connection

Nodes cannot be overwritten directly, while interior line samples can be cut. Visual adjacency, two long links or two endpoint-graph paths need not be safe: one attack can cut shared samples and detach a large structure. We certify only a core with a proof. Fix the board, roots and rules; undo, import and reconfiguration are outside subsequent legal play in this statement.

$$
P_0=\text{己方起点},\qquad P_{t+1}=P_t\cup\{b:\exists e=(a,b)\in\mathcal L_i,\ a\in P_t,\ b\text{ 为己方节点},\ \operatorname{int}(e)\subseteq P_t\},\quad P_*=\bigcup_tP_t.
$$

Proposition T7: nodes in P* cannot be detached by cuts in any subsequent legal continuation. Induct on certification layers. Roots persist. If a path source and every interior sample are permanent friendly nodes, no legal placement can occupy them; its target is also a node. The path cannot be cut and keeps the target connected through its certified source to a root, so disconnection cleanup cannot remove it. Friendly placements, passes and resignations do not overwrite them. Induction completes the proof.

An actual adjacent logical edge with no interior samples is the simplest certificate. Even a friendly interior node cannot be assumed permanent before certification: it could disappear after another cut, exposing a line point. RootStability computes the least closure with a dependency queue in O(total logical path length + nodes). This is sufficient, not necessary; uncertified does not mean capturable. AI rewards growth of this core and tests other links with actual counterplay.

### 4.11 Long-term strategy under a finite budget

The certificate is an unlimited-continuation structural statement; move quality still depends on area, captures, confinement and replies. Confinement must use actual components of G−Wi, not a screen hull. Without an outside on a closed surface, a single large enemy component is not evidence of confinement. Conservatively require actual separation and inspect smaller enemy components and their action space; enemy regions remain unscored.

Search retains full state/history, follows the surviving actors and includes PASS. Report completed depth, not requested depth; d plies in multiplayer are not d opponent rounds. Move generation, policy and tactical checks share an approximately three-second deadline, preserving complete comparisons and rejecting stale results. Model weights and identity remain intact, with a separately versioned tactical layer. Shortlists, one-reply checks and selective rollouts must disclose their scope, not claim optimality or permanent safety.

Topology General AI is bounded rule-based search, not an inherited fixed-board strength tier; node tie-breakers do not automatically make two-player evaluation zero-sum. Topology remains practice unless strength is calibrated under the same map, starts, rules and budgets. Counterexample regressions verify behavior; complete paired matches supply evidence on the tested distribution. Report these separately.

### 4.12 What a random-surface probability means

There is no automatic uniform distribution on all triangulable surfaces: types, mesh sizes and subdivisions do not form a fixed finite sample space. Use an explicit finite mixture, then generate a mesh and starts within its category. Defaults: disk 30%, orientable two-boundary surface 25%, planar three-boundary surface 10%, Möbius strip 8%, torus 12%, Klein bottle 5%, sphere 5%, double torus 5%. Within the two-boundary class choose planar annulus 60% or cylinder 40%; these are displays of one topology type.

$$
\Pr(C=c\mid N,m,\mathrm{supported})=\frac{p_c\,\mathbf1\{c\in A(N,m)\}}{\sum_{d\in A(N,m)}p_d}.
$$

A(N,m) is the set supported and validated by this generator at that size/player count, not every mathematically possible category. Failure of a finite layout search is not impossibility. Determine support and normalize first, then draw a category and retry only within it. Report failure rather than silently substituting a disk. Record requested/effective probabilities, exclusion reasons, generator version, seed and full definition. Replay uses the full definition/hash; old v1–v3 seed sequences remain unchanged.

### 4.13 Sources, scope and verification

References: [Hatcher, Algebraic Topology, Chapter 2](https://pi.math.cornell.edu/~hatcher/AT/ATch2.pdf) develops chains, boundaries and homology; [Erickson, Surface Classification](https://jeffe.web.engr.illinois.edu/teaching/comptop/2017/notes/surface-classification.pdf) covers classification and polygon gluing. [CGAL Polygon Mesh Processing](https://doc.cgal.org/5.6.3/Polygon_mesh_processing/index.html) is an engineering reference, not a claimed dependency. T6’s height construction and T7’s rule-specific certificate are project derivations supplied here, not quotations from those sources.

Verification: verify-topology-algebra checks chains, absolute/relative homology, parallel edges and nonseparating cycles; verify-root-stability checks dependencies, multiple roots and actual-engine replies. Random double tori additionally check chi=−2, F2 Betti=(1,4,1), no real boundary, circular links and 3D seam agreement. Proofs, numerical regressions, browser usability and strength experiments are different evidence tiers.
