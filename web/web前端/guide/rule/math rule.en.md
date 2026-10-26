# LIFELINE: Formal Model and Theory

Abstract. Under fixed territory-v3 rules, we formulate a history-complete finite game and derive state/horizon bounds, connectivity and flood correctness, tightening termination, minimax error bounds and conditional benefits of topology. The three chapters are Mathematics, Algorithms and AI.

Derivations and source inspection: 2026-10-23. Claims state assumptions and proofs or proof sketches. Encoding upper bounds are not reachability lower bounds, and communication-path benefits are not strength experiments. See the companion Code report for implementation and source audits.

Reading path: chapter I defines notation and full state; II develops rule algorithms; III develops AI. In territory-v3 the score always counts owned points and separately adds enemy-free pockets cut off from the exterior; old replays retain their recorded rule versions.

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

## I. Mathematics

Fix territory-v3, board shape, side length, player count and actual starts. A game excludes undo, restart, clock forfeits and repeatedly rejected inputs. The results concern completed rule transitions; a computation timeout is not a mathematical terminal state.

### 1.1 Lattice and graphs

Let N≥2 be side length, p the player count and M the number of lattice points. Use nonnegative coordinates for a triangle and centered axial coordinates with R=N−1 for a hexagon. The lattice graph G₀=(V,E₀) has at most six neighbors per vertex, so |E₀|≤3M. It is distinct from a player’s logical-link graph.

$$
\begin{aligned}V_\triangle&=\{(x,y)\in\mathbb Z_{\ge0}^2:x+y\le N-1\},\\M_\triangle&=\sum_{j=1}^{N}j=\frac{N(N+1)}2,\\V_{\mathrm{hex}}&=\{(q,r)\in\mathbb Z^2:\max(|q|,|r|,|q+r|)\le R\},\\M_{\mathrm{hex}}&=1+\sum_{k=1}^{R}6k=3N(N-1)+1.\end{aligned}
$$

Proof: triangular rows contain N,N−1,…,1 vertices. Hexagonal ring k contains 6k vertices around the center. N=15 gives 120 and 631. These count vertices, not triangular faces. The direction set is D={(1,0),(−1,0),(0,1),(0,−1),(1,−1),(−1,1)}; screen projection does not change adjacency.

### 1.2 State and legal actions

Let B:V→{∅,NODE₁,LINE₁,…,NODEₚ,LINEₚ}. Player i has node set Uᵢ, line-point set Lᵢ, explicit undirected links Eᵢ and actual start rᵢ. The complete rule state includes the actual actor i, consecutive passes c, resignations D, terminal flag g and Superko history H; fixed configuration Ω includes the actual first player and protectionRule. A missing legacy field means symmetric-v1, while a new two-player triangular game uses duel-first-unprotected-v1. Counters, caches and revisions are implementation state, excluded from strategic counting unless an added rule depends on them.

$$
S=(\Omega,B,(E_j)_{j=1}^{p},i,c,D,g,H),\qquad A(S)=A_{\rm place}(S)\cup A_{\rm pass}(S)\cup A_{\rm resign}(S).
$$

Voluntary passing is allowed before termination. A placement must satisfy occupancy, start protection still active under the match protectionRule, the three-point limit, a clear friendly connection and no repeated trial key. duel-first-unprotected-v1 removes only the actual first player’s protected start in a two-player triangular game; the second player’s start stays protected, while other configurations and symmetric-v1 retain mutual protection. Put dᵢ(v)=|N₀(v)∩Uᵢ|. Unless directly cutting an enemy LINE, require dᵢ(v)=0, or dᵢ(v)=1 with its sole friendly neighbor u satisfying dᵢ(u)=0 in the old occupancy. This forbids three-node chains or clusters, not only elementary triangles. A direct cut bypasses only this condition.

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

Let Fᵢ=Uᵢ∪Lᵢ be player i’s occupied node and line points, G_V the lattice adjacency graph, and ∂V the board boundary. Delete Fᵢ and run multi-source BFS from the remaining boundary points. Each unvisited connected component Qₖ is a pocket enclosed by friendly points. Let Bᵢ be the union of such components containing no enemy node or line point. This needs no single closed polygon and naturally includes donut holes and multiple disjoint pockets.

$$
\begin{aligned}X(W)&=\operatorname{Reach}_{G_0[V\setminus W]}(\partial V\setminus W),\\C(W)&=V\setminus X(W),\\c(W)&=|C(W)|=|W|+|C(W)\setminus W|,\qquad 0\le c(W)\le M.\end{aligned}
$$

The official score is aᵢ=|Fᵢ|+|Bᵢ|, where Bᵢ contains only pockets disconnected from the board boundary and free of enemy elements. Each point counts once, so 0≤aᵢ≤M. An open chain or single line still scores |Fᵢ| when it creates no pocket. Every safe pocket is added separately; an inner donut hole also counts when it contains no enemy point. displayArea is only a geometric diagnostic, not aᵢ. The old territory-v2 six-player scores (25,10,11,13,8,8) are historical and must not be treated as verified v3 values.

### 2.3 Flood-fill properties

Proposition 6: after deleting Fᵢ, the connected components among vertices unvisited by boundary multi-source BFS are exactly the bounded pockets. Since degree≤6, finding pockets and excluding components with enemy elements takes O(M) time and O(M) auxiliary space. No simple polygon or single-pocket assumption is needed. A single line creates no pocket and still scores through |Fᵢ|.

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

The source first uses the territory-v2 seat transforms Tᵢ to select Wᵢ* by closed coverage and canonical contour key, then computes the v3 union score. Triangles use barycentric permutations and hexagons rotations/reflections. Symmetry conclusions require bijective correspondence between candidate sets; arbitrary custom starts need not retain full D₆ symmetry.

A sufficient cache condition is that its key preserve every input dependency of the cached function. Geometry-only coverage does not read history; legality and search do. Reusing a board/edges/actor key for the latter would omit H. Dependency separation avoids irrelevant invalidation without deleting rule-relevant information.

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
