import { IMPLEMENTATION_NOTES } from './GuideImplementationNotes.js?v=20261025-terminal-v4';
import { p, m, c, s, ch } from './GuideArticleFormat.js?v=20261025-terminal-v4';

function notes(id, omit = []) {
  const item = IMPLEMENTATION_NOTES.find(item => item.id === id);
  return item.paragraphs.zh.flatMap((zh, index) => omit.includes(index) ? [] : [p(zh, item.paragraphs.en[index])]);
}
const ref = (file, symbols) => p(`源码定位：${file} → ${symbols}。`, `Source: ${file} → ${symbols}.`);
const src = (file, symbol, code) => c(code, file.endsWith('.py') ? 'python' : 'javascript', { file, symbol });
const engine = 'web/web前端/GameEngine.js';
const ai = 'web/web前端/AIEngine.js';
const research = 'web/web前端/ResearchAI.js';

export const TECHNICAL_CHAPTERS = [
  ch('mathematics', '第一章 数学', 'I. Mathematics', p(
    '这一章把数学对象映射为工程数据与不变量。后文伪代码用于讲清控制流，使用带行号的语言无关步骤；标为“源码摘录”的片段才是当前工作区的原文。完整证明见配套抽象废话版。',
    'Map mathematical objects to engineering data and invariants. Numbered language-neutral pseudocode explains control flow; only blocks explicitly called source excerpts quote the current workspace. The companion mathematical article provides proofs.'), [
    s('state', '1.1 状态的数据结构', '1.1 State representation', [
      ...notes('state'),
      c(`01 CONFIG = {rules, shape, size, players, starts}
02 grid: Map<pointKey, EMPTY | NODE(player) | LINE(player)>
03 edges[player]: Set<canonicalEndpointPair>
04 historyHashes: Set<serializedTrialKey>
05 turn = {currentPlayer, consecutiveSkips, resignedPlayers, gameOver}
06 display = {cachedTerritories, territoryRevision, positionRevision}`),
      p('工程上必须区分三种身份：规则状态用于判断下一手，几何依赖用于领土缓存，修订号/请求号用于拒绝异步旧结果。相同 grid 不意味着相同 edges；相同 grid+edges 不意味着相同历史；同一规则局面也可能来自不同 UI 请求。',
        'Distinguish rule identity for the next move, geometric dependencies for territory caches, and revision/request identity for stale-result rejection. Equal grid does not imply equal edges; equal grid+edges does not imply equal history; the same rule position can also belong to different UI requests.'),
      ref(engine, 'constructor, _captureReplayState, _computeStateHash'),
    ]),
    s('contracts', '1.2 分数与不变量', '1.2 Scores and invariants', [
      p('接口约定：area 是正式计分，displayArea 是鞋带表达式对应的几何量，reach 是 AI 特征。它们即使都叫“面积”也不可互换。用类型或命名保持区分，终局读取规范领土，不能直接拿 evaluate 返回值判胜负。',
        'The score contract distinguishes official area, geometric shoelace displayArea and heuristic reach. Names such as area do not make them interchangeable. Preserve that distinction in types/names and use canonical territory for settlement, not evaluate’s heuristic result.'),
      m(String.raw`\operatorname{coverage}_i=|F_i|,\qquad \operatorname{area}_i=|F_i|+|B_i|,\qquad \operatorname{reach}_i=|\operatorname{Reach}_{G_0\setminus O_i}(F_i)|.`,
        'coverageᵢ=|Uᵢ|+|Lᵢ|\nareaᵢ=|Fᵢ|+Σ|Qₖ| for enemy-free non-exterior components Qₖ of G_V\\Fᵢ\nreachᵢ=|Reach(G₀ excluding enemies, Uᵢ∪Lᵢ)|'),
      p('应检查的不变量包括：节点不能被普通落子覆盖；存活节点沿显式边能回到实际起点；非法试走不提交历史；接受落子只增加新历史键；搜索恢复后规则状态不变；AI 返回值仍属于当前请求且执行时合法。断联、切线与终局都应通过 GameEngine，而不是让 UI 或网络模型各写一套近似规则。',
        'Check that placements do not overwrite nodes, surviving nodes have explicit-link routes to their actual starts, rejected trials do not commit history, accepted placements add new keys, search restores rule state, and AI outputs remain current and legal at execution. Cuts, connectivity and settlement belong to GameEngine rather than parallel approximate UI/model rules.'),
      ref(engine, '_getOpponentConnectedPieces, _evaluateMove, _computeTerritory'),
    ]),
    s('snapshots', '1.3 快照与恢复成本', '1.3 Snapshots and restoration', [
      p('AIEngine 的 saveState 复制 grid、各方 edges、历史 Set 与轮转字段，并复制领土缓存；restoreState 重建棋盘/边/历史容器，但把 snapshot.cachedTerritories 直接赋回。随后要刷新精确领土的分支必须拥有自己的缓存对象，V4/V5 因而有额外隔离。只复制最外层对象会让分支互相污染。',
        'AIEngine.saveState copies grid, per-player edges, history and turn fields, plus territory cache data. restoreState recreates grid/edge/history containers but assigns snapshot.cachedTerritories directly. A branch that refreshes exact territory therefore needs its own cache object; V4/V5 add isolation. Shallow outer-object copies can contaminate branches.'),
      p('源码摘录：这些字段正是同一盘面仍可能具有不同合法性的原因。', 'Source excerpt: these fields explain why visually identical positions can have different legality.'),
      src(ai, 'saveState', `    historyHashes: new Set(engine.historyHashes),
    consecutiveSkips: engine.consecutiveSkips,
    resignedPlayers: new Set(engine.resignedPlayers ?? []),
    currentPlayer: engine.currentPlayer,
    gameOver: engine.gameOver,`),
      p('若 M 为格点数、e 为逻辑边数、h 为历史条目数，一份快照通常复制 O(M+e+h) 个容器条目；不可变历史字符串可以共享引用，其实际字节长度另计。深度 d 的递归同时保留多份快照时，不能把空间成本简写成 O(d)。函数返回时的正常恢复与异常路径 finally 的覆盖范围也要分别审计。',
        'For M points, e links and h history entries, a snapshot copies O(M+e+h) container entries; immutable history strings can share references, with their byte lengths counted separately. A depth-d stack retaining snapshots is not merely O(d) space. Normal restoration and the actual extent of finally-based exception cleanup must be audited separately.'),
      ref(ai, 'saveState, restoreState, cloneCachedTerritories'),
    ]),
  ]),
  ch('algorithms', '第二章 算法', 'II. Algorithms', p(
    '按一次落子经过的路径拆解：合法性 → 自动连线 → 切断清理 → Superko 提交 → 轮转 → 计分。每节列输入、核心步骤、输出与源码入口；领土的外轮廓、收紧和洪水是三个不同阶段。',
    'Follow a placement through legality, connections, cut cleanup, Superko commit, turn normalization and scoring. Each section identifies inputs, steps, outputs and source entry points. Territory contour extraction, tightening and flood coverage are separate stages.'), [
    s('legality', '2.1 合法性试走', '2.1 Legal-move trials', [
      ...notes('legality'),
      c(`01 INPUT: full state S, candidate point v, actor i
02 Reject invalid v, existing NODE, or protected enemy-start neighbor
03 If v is not an enemy LINE: enforce the three-point condition
04 Temporarily apply node insertion, connections and attack cleanup
05 If no friendly connection exists: restore and reject
06 Compute trial key with next non-resigned actor
07 Reject if trial key is already in H
08 Restore all trial changes; return legal/illegal (do not commit)`),
      p('枚举 M 个候选会执行许多试走，因此一次 getLegalMoves 的成本是 M 乘试走成本的量级，而非一次邻居扫描。固定坐标顺序、射线几何和可复用缓冲可以加速；不得缓存忽略历史的“永远合法点”。',
        'Enumerating M candidates can invoke many trial transitions: getLegalMoves costs on the order of M trial costs rather than one neighbor scan. Fixed coordinate order, ray geometry and reusable buffers help; a history-free cache of permanently legal points is unsound.'),
      ref(engine, '_evaluateMove, getLegalMoves, _checkThreePointLimitation, _isInProtectionZone'),
    ]),
    s('connections', '2.2 自动连线', '2.2 Automatic connections', [
      ...notes('connections'),
      c(`01 For every old friendly NODE u:
02   If v,u are lattice-collinear AND the interior has no enemy:
03     mark v,u as NODE; mark eligible interior cells as LINE
04     add canonical undirected edge {v,u}
05 For each friendly NODE u and each of six directions:
06   walk the cached ray, reading current occupancy
07   stop at enemy occupancy
08   at first friendly NODE: add missing edge, then stop this ray
09 After a direct cut: also crawl each other player's surviving nodes`),
      p('源码摘录：新点可直接记录长逻辑边；这与逐方向只找第一个节点的补线阶段相互补充。',
        'Source excerpt: insertion records long logical edges, complementing the nearest-node-per-ray crawl.'),
      src(engine, '_addNode', `      // 记录显式边
      this._getEdges(this.currentPlayer).add(this._edgeKey(point, node));`),
      p('设射线最大长度为 D、己方节点 k 个，直接连接检查和一次六向 crawl 的朴素扫描量为 O(kD)，另需计写入的线点和边。预计算射线减少重复几何计算，但敌方占用必须每次重新读取。',
        'For maximum ray length D and k friendly nodes, direct checks and one six-ray crawl require O(kD) naive scanning, plus written line points and links. Precomputed rays remove repeated geometry work, but occupancy must be reread.'),
      ref(engine, '_addNode, canConnectWithBlocking, getLinePoints, _connectAllCrawl'),
    ]),
    s('cuts', '2.3 切断与根 BFS', '2.3 Cuts and root BFS', [
      ...notes('cuts'),
      c(`01 INPUT: attacked player's current grid and explicit edge set E
02 Remove broken edges whose geometric path no longer survives
03 Build endpoint adjacency from surviving E
04 Q <- [actual start]; reached <- {actual start}
05 WHILE Q is nonempty:
06   u <- pop Q; enqueue each unreached logical neighbor of u
07 END WHILE
08 Keep reached NODEs and interior LINEs belonging to surviving links
09 Clear disconnected elements; clean edges and restore eligible links`),
      p('必须先明确边是否存活，才能讨论沿边可达。源码为攻击维护被破坏连线与恢复检查；这里的伪代码只抽取根连通性主干，不把几何路径检查、边集维护和跨玩家补线省略为免费操作。',
        'Determine which links survive before asking about reachability. The attack source also tracks broken links and restoration. This pseudocode isolates root connectivity; geometric path checks, edge maintenance and other players’ reconnections are additional work.'),
      ref(engine, '_handleBlockingAttack, _cleanupBrokenEdges, _getOpponentConnectedPieces'),
    ]),
    s('superko', '2.4 Superko 提交', '2.4 Superko transactions', [
      ...notes('superko'),
      p('精确时序补充：playMove 在 _addNode 成功后，用 _getNextPlayer(currentPlayer) 计算键；historyHashes.add 之后才 _switchPlayer 和 _checkAndAutoSkip。它不是把自动跳过后的 currentPlayer 原样序列化。',
        'Exact timing: after _addNode succeeds, playMove builds the key using _getNextPlayer(currentPlayer). It adds history before _switchPlayer and _checkAndAutoSkip. It does not simply serialize the post-auto-skip actor.'),
      c(`01 savedGrid, savedEdges <- copy current containers
02 IF _addNode(v) fails: return INVALID_MOVE
03 key <- _computeStateHash(nextNonResignedActor)
04 IF historyHashes contains key:
05   restore savedGrid and savedEdges; return SUPERKO_VIOLATION
06 END IF
07 add key; increment turn/revision; reset consecutiveSkips
08 switch actor; normalize automatic skips; settle if required`),
      src(engine, 'playMove', `    this.historyHashes.add(stateHash);
    this.turnCount += 1;
    this.positionRevision += 1;
    this._territoryStateRevision += 1;
    this.consecutiveSkips = 0;
    this._switchPlayer();
    this._checkAndAutoSkip();`),
      p('键生成包括排序/序列化成本；Set 查找通常按哈希表分析，但整体流程并不因此是 O(1)。源码缓存固定格点排序和单点序列化片段，仍然逐次读取占用与全部边，再对完整历史判重。',
        'Key generation includes sorting/serialization cost. Hash-table-style Set lookup does not make the whole operation O(1). Fixed coordinate order and cell serialization fragments are cached, while current occupancy, all links and the full history check remain.'),
      ref(engine, '_computeStateHash, _getStateHashOrder, playMove'),
    ]),
    s('contour', '2.5 轮廓与闭环判定', '2.5 Contours and cycles', [
      ...notes('contour'),
      c(`01 Walk the outer boundary using the fixed clockwise neighbor order
02 Convert consecutive walk vertices into distinct undirected unit edges
03 Reject an invalid point or a non-unit step
04 Let n = distinct vertices, e = distinct edges
05 Accept the cycle gate iff n >= 3 and e >= n`),
      p('源码摘录及依据：一个有效闭合游走形成的去重边图连通；连通无向图有环当且仅当 e≥n。因此这里可用边点计数，而不能对任意不连通图不加条件照搬同一判据。游走沿枝条折返不额外增加去重边数。',
        'Source excerpt and justification: the deduplicated graph of a valid closed walk is connected. Such an undirected graph has a cycle iff e≥n. The criterion must not be applied without that premise to arbitrary disconnected graphs. Retracing a branch adds no distinct edge.'),
      src(engine, '_hasBoundaryCycle', '    return vertices.size >= 3 && edges.size >= vertices.size;'),
      ref(engine, '_getOuterContourFromPoints, _hasBoundaryCycle'),
    ]),
    s('tightening', '2.6 领土收紧', '2.6 Territory tightening', [
      ...notes('tightening'),
      c(`01 rho <- initial valid contour
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
13 Return closed rho, unique covered-point count and shoelace measure`),
      p('复杂度记账：给定墙的洪水是 O(M)，一次源点 BFS 是 O(M)，但一个前驱 DAG 可能代表组合数量的最短路。用 J 表示实际枚举的路径前缀/候选工作量，端点对数与 J 必须单独计入。当前 _rawTerritoryUncached 使用周长下界、路径包络、已验证墙集合和标量覆盖查询削减重复工作；_computeRawTerritory 再加依赖缓存。不能给整个算法承诺 O(M)。',
        'Cost accounting: supplied-wall flooding and one source BFS are each O(M), but a predecessor DAG may encode combinatorially many shortest paths. Count endpoint pairs and visited prefixes/candidates J separately. _rawTerritoryUncached uses perimeter bounds, path envelopes, validated-wall reuse and scalar coverage queries; _computeRawTerritory adds dependency caching. No O(M) bound is promised for the whole algorithm.'),
      ref(engine, '_computeRawTerritory, _rawTerritoryUncached, _bfsFromSource, _iterateTerritoryPaths, _iterateCoveredTerritoryPaths'),
    ]),
    s('flood', '2.7 洪水与计分', '2.7 Flood fill and scoring', [
      ...notes('flood'),
      c(`01 wall <- distinct valid friendly NODE and LINE points
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
13 Return area; no cycle or single-polygon requirement`),
      p('实现将己方全部节点和线点作为墙，从棋盘边界注水，再逐个遍历未连到外界的空腔。含敌方节点或线点的整块空腔排除；其余空腔全部加入己方占点数。因而无需先找到有效闭环：开链、单线按占点计分，多个空腔与甜甜圈内孔分别统计。整数索引、预分配队列与访问标记只优化运行成本，不改变计分定义。鞋带式只用于 displayArea。',
        'The implementation treats every friendly node and line point as a wall, floods from the board boundary, then visits each component disconnected from the exterior. An entire pocket containing an enemy node or line is excluded; all other pockets are added to the distinct owned-point count. No valid cycle is required: open chains and single lines score their owned points, while multiple pockets and donut holes are evaluated separately. Integer indices, reusable queues and visit marks change runtime cost, not the scoring rule. Shoelace displayArea remains diagnostic.'),
      ref(engine, '_getCoveredPoints, _getValidatedTerritoryArea, computeTriangularPolygonArea'),
    ]),
    s('symmetry', '2.8 规范方向与缓存', '2.8 Canonical views and caches', [
      ...notes('symmetry'),
      c(`01 transforms <- seat-specific canonical transforms
02 FOR g in transforms:
03   transform own NODEs/LINEs and all enemy occupancy
04   run raw tightening with a required real cycle
05   save display polygon and canonical polygon key; inverse-transform output
06 END FOR
07 Choose display contour by closed-contour coverage, then canonical polygon key
08 area <- CountOwnedWallArea(all friendly NODE/LINE points, all enemy NODE/LINE points)
09 Return display contour and official area; scoring is independent of contour`),
      p('几何缓存键包括形状/尺寸、规则和规范方向依赖、己方节点/线点、敌方障碍并集及显式初始轮廓的相关次序。搜索缓存还需完整历史和轮转信息。缓存返回可变多边形时需复制；对覆盖了核心方法的诊断/子类对象，源码保留未优化路径，避免把原生方法的剪枝证明误用于不同语义。',
        'Geometry keys include shape/size, rules/canonical-view dependencies, own nodes/lines, the enemy obstacle union and relevant ordering of an explicit initial walk. Search caches additionally need history and turns. Mutable polygon results are copied. Diagnostic/subclass overrides retain fallback paths so pruning arguments for native methods are not applied to different semantics.'),
      ref(engine, '_getCanonicalTerritoryTransforms, _computeCanonicalTerritoryCandidate, _computeTerritory, dependencyMemo'),
    ]),
    s('turns', '2.9 跳过与终局', '2.9 Passing and settlement', [
      ...notes('turns'),
      c(`01 PASS: increment consecutiveSkips
02 If skips >= remaining-player count: set gameOver
03 Otherwise advance to the next non-resigned player
04 While the current player has no legal placement: auto-skip
05 A successful placement or resignation resets the pass count
06 If only one player remains: that player wins
07 Otherwise at settlement: recompute exact area and compare survivors`),
      p('性能优化可以延后非终局着色，但终局读取比分前必须完成精确更新。当前 Minimax 的真实终局分支与神经 PUCT 都按规范 area 判胜负；两者的非终局估值、访问次数或网络先验仍不能统一标成“胜率”。',
        'Nonterminal shading may be deferred, but exact scores must be ready before settlement. Current Minimax true-terminal leaves and neural PUCT both use canonical area outcomes; their nonterminal values, visits and network priors are not a common win-probability measure.'),
      ref(engine, 'skipTurn, resignPlayer, _checkAndAutoSkip, getWinner'),
    ]),
    s('verification', '2.10 源码与验证路径', '2.10 Source and verification', [
      p('引擎主路径在 web/web前端/GameEngine.js；搜索与快照在 AIEngine.js；跨 Worker 状态协议在 AIStateProtocol.js；棋谱恢复在 ReplayCodec.js 与 LocalGameSession.js。微信阅读/任务调度分别在 wechat/minigame/src/guide-content.js、help-ui.js 和 Worker 会话模块。后续多人开发路径见第三章，不把 Web 候选存在等同于手机已装入。',
        'The engine lives in web/web前端/GameEngine.js; search/snapshots in AIEngine.js; Worker state in AIStateProtocol.js; replay restoration in ReplayCodec.js and LocalGameSession.js. Mini Game reader content/UI live in wechat/minigame/src/guide-content.js and help-ui.js. Later multiplayer development paths are covered in chapter III; source existence does not mean phone installation.'),
      p('建议验证顺序：固定动作重放 → 比较 grid/edges/history/turn → 精确面积与胜者 → 原状态恢复 → Worker 迟到结果拒绝 → 实际界面目录/公式/代码阅读。普通文档修改只运行相关检查；冻结实验与已有发布收据不改写。本报告源码摘录通过与当前文件逐字匹配检查；缩进规范化不改变代码标记。',
        'A useful verification order is fixed-action replay, grid/edges/history/turn comparison, exact score/winner, source-state restoration, stale Worker rejection and actual reading of contents/formulas/code. Documentation edits run scoped checks and preserve frozen experiments/releases. Source excerpts are checked against current files with whitespace normalization that leaves code tokens intact.'),
      c(`node web/tools/sync-implementation-guides.mjs --check
node web/web前端/tests/verify-guide-content.mjs
node --test --test-timeout=180000 wechat/minigame/tests/guide-cabin.test.mjs`, 'text'),
    ]),
  ]),
  ch('ai', '第三章 AI', 'III. AI', p(
    '先看候选如何生成，再看估值、搜索、神经前向与返回动作。下列预算和适配行为是源码事实；训练目标与推理入口分开描述，候选模型的标签不代表棋力排序。',
    'Follow candidate generation, evaluation, search, forward inference and returned actions. Budgets and adapters below describe source behavior. Training objectives are separate from inference, and candidate labels are not a strength ranking.'), [
    s('heuristic', '3.1 贪心与估值', '3.1 Greedy evaluation', [
      ...notes('heuristic'),
      c(`01 legal <- engine.getLegalMoves(actor)
02 ranked <- cuts first, own-line adjacency next, other placements last
03 candidates <- first 20 ranked placements
04 For each candidate: save -> play -> evaluate F -> restore
05 Sort by descending F; return top requested candidates`),
      ref(ai, 'evaluate, fastTerritoryBFS, orderMoves, GreedyAI.getTopMoves'),
    ]),
    s('minimax', '3.2 Minimax 控制流', '3.2 Minimax control flow', [
      ...notes('minimax'),
      c(`01 SEARCH(S,d,alpha,beta,root):
02   If gameOver: return exact area win/draw/loss utility
03   If d=0: return the nonterminal Minimax heuristic
04   Get legal placements; retain <=20 ordered placements and append PASS
05   maximizing <- (S.currentPlayer == root)
06   value <- -infinity if maximizing, otherwise +infinity
07   For each placement or PASS:
08     saved <- saveState; apply playMove or skipTurn
09     child <- SEARCH(successor,d-1,alpha,beta,root)
10     restoreState(saved)
11     Update value and alpha (MAX) or beta (MIN)
12     If beta <= alpha: break
13   Return value`),
      src(ai, 'MinimaxAI.minimax', `    const maximizingPlayer = engine.currentPlayer === aiPlayer;`),
      p('伪代码省略非法候选返回分支与缓存字段，不是新求解器。正常分支恢复与 finally 的实际覆盖范围应按源码阅读；不能仅凭伪代码推断任意中途异常都有完整事务回滚。全候选枚举成本仍会发生在取前 20 个之前，故“只搜 20 个”不等于“只试走 20 个”。',
        'This is explanatory pseudocode, omitting rejected-candidate branches and cache fields. Read the actual finally scope before assuming full transaction rollback under every exception. Full legal enumeration occurs before retaining 20 moves; searching 20 candidates does not mean only 20 legality trials.'),
      ref(ai, 'MinimaxAI.minimax, MinimaxAI.getTopMoves, applyMinimaxAction'),
    ]),
    s('mcts', '3.3 普通 MCTS', '3.3 Plain MCTS', [
      ...notes('mcts'),
      c(`01 Repeat simulation budget times:
02   restore root state
03   Select children by mean return + UCT exploration bonus
04   Expand one unvisited action
05   Roll out random actions until terminal or depth cap
06   Evaluate rollout return; add it to every visited tree node
07 Rank root actions using accumulated search statistics`),
      p('当前普通实现的 rollout 最终使用 tanh(F/100)，并不因为撞到终局就自动改成精确 area 的 ±1。要区分这一实现与后文 NeuralPUCTAI 的终局价值规则。带种子随机数有助复现动作序列，但同一初态重复同一种子不产生新的独立统计样本。',
        'The plain rollout implementation returns tanh(F/100), including when it reaches termination; that does not automatically become exact-area ±1. NeuralPUCTAI uses a different terminal rule below. A seeded generator helps reproduce decisions, while repeating the same start and seed is not a new independent statistical sample.'),
      ref(ai, 'MCTSAI, rollout, evaluate'),
    ]),
    s('networks', '3.4 神经网络前向', '3.4 Neural forward pass', [
      ...notes('networks'),
      c(`01 encodeResearchPosition -> point features, actual actor, legal indices
02 Input projection -> hidden vectors
03 CNN: residual 3x3 convolutions on a padded square
04 Grid GNN: mean messages over lattice neighbors
05 Topology GNN: also mean over own/opponent logical-link neighbors
06 Per-point head -> placement logits
07 Global pooled heads -> PASS logit and tanh value
08 Apply the real legal mask; stable softmax -> action priors`),
      p('源码摘录：关系聚合不是把边画出来给网络看，而是直接使用关系邻接表。下面是已有隐藏向量的均值累加。',
        'Source excerpt: link topology is provided as relation adjacency lists, not a drawing. This accumulates mean hidden vectors.'),
      src(research, 'forwardGnn', `          const neighbors = relations[relation][node];
          if (neighbors.length) {
            for (const neighbor of neighbors) for (let channel = 0; channel < channels; channel += 1) aggregate[channel] += hidden[neighbor * channels + channel] / neighbors.length;
          }`),
      p('若隐藏宽度为 c、关系边总数为 eᵣ、关系数为 R，每层均值聚合约 O(eᵣc)，逐点关系与自身线性投影约 O((R+1)Mc²)。CNN 每次 3×3 卷积约 O(9N²c²)，应另乘实际块内卷积次数。以上只计前向算术，真实合法掩码成本要单列。',
        'For hidden width c, relation-edge count eᵣ and R relations, aggregation costs about O(eᵣc) per layer; relation/self linear projections cost O((R+1)Mc²). A 3×3 CNN convolution costs O(9N²c²), multiplied by actual convolutions per block. These count forward arithmetic only; real legality-mask generation is additional.'),
      ref(research, 'encodeResearchPosition, researchRelations, forwardGnn, forwardCnn, applyHeads'),
    ]),
    s('puct', '3.5 PUCT 选步', '3.5 PUCT move selection', [
      ...notes('puct'),
      c(`01 Save full root state; expand root with network priors
02 For each simulation:
03   Restore root; path <- [root]
04   Select by sign*Q + c*P*sqrt(max(1,N))/(1+n)
05   Play the real action or PASS; append child to path
06   Expand a new nonterminal child and convert value to root perspective
07   If terminal: force exact territory and compute win/draw/loss
08   Add the root-perspective value to all nodes on path
09 Rank root children by visits, then mean value; restore source state`),
      src(research, 'NeuralPUCTAI.getTopMoves', `          GameEngine.prototype._updateTerritories.call(engine);
          const winner = engine.getWinner();
          value = winner === "DRAW" ? 0 : winner === aiPlayer ? 1 : -1;`),
      ref(research, 'NeuralPUCTAI.expand, select, getTopMoves'),
    ]),
    s('model-free', '3.6 五类策略的推理', '3.6 Five policy adapters', [
      ...notes('model-free', [2]),
      c(`01 Encode <=120 triangular points into 7 features each; pad missing points
02 Append size and pass count -> 842-dimensional vector
03 ReLU(W1*x+b1) -> ReLU(W2*h+b2) -> 121 action outputs
04 DQN reads Q-head weights; other families read policy-head weights
05 Softmax over legal indices including the PASS slot
06 Return explicit placement and PASS candidates; sort by prior
07 Product Worker applies the shared bounded PASS-discipline check`),
      p('源码摘录：真实合法落子与 PASS 使用同一 softmax 分母，返回显式动作类型；完整分布归一化，截取 top-N 后无需重新归一化。共享检查不改写这些模型的神经权重。',
        'Source excerpt: legal placements and PASS share one softmax denominator and retain explicit action types. The complete distribution is normalized; a top-N slice need not be renormalized. The shared check changes no neural weights.'),
      src('web/web前端/ModelFreeAI.js', 'ModelFreeModel.evaluate', `    return { priors: legal.map((index, order) => index < engine.validPositions.length
      ? { type: "move", point: [...engine.validPositions[index]], actionIndex: index, prior: exp[order] / total }
      : { type: "pass", point: null, actionIndex: engine.validPositions.length, prior: exp[order] / total }) };`),
      ref('web/web前端/ModelFreeAI.js', 'encode, forwardBody, logits, evaluate, ModelFreeAI.getTopMoves'),
    ]),
    s('training', '3.7 训练源码与损失', '3.7 Training source and losses', [
      ...notes('terminal-training'),
      p('研究训练入口与 Web 推理入口分开。以下是当前可阅读的训练源码，不单凭文件同名推断现行二进制权重由这份源码生成；资产来源仍需 manifest/训练收据。研究环境与 Web 的规则和自动跳过语义也须另行比对。',
        'Research training is separate from Web inference. These are current inspectable trainers; matching names alone do not prove that a deployed binary was generated by these exact sources. Asset lineage requires manifests/receipts, and rule/auto-skip parity between research and Web is a separate check.'),
      p('DQNTrainer.update：从 replay 抽批量，在线 Q 在合法掩码内取 argmax，目标网络读取该动作 Q；使用 smooth-L1、梯度裁剪 5。下列原文固定采用负续局值，对应对手视角假设；自动跳过后是否仍换人应由训练状态约定验证。',
        'DQNTrainer.update samples replay, takes a masked online-Q argmax and reads its target-network Q. It uses smooth-L1 and gradient clipping at 5. The quoted fixed negative continuation assumes opponent perspective, which must be checked against training turns after auto-skips.'),
      src('research/iclr2027/lifeline_rl/model_free/dqn.py', 'DQNTrainer.update', `            next_online = self._masked_argmax(self.online(next_states), next_masks)
            next_values = self.target(next_states).gather(1, next_online.unsqueeze(1)).squeeze(1)
            target = rewards - self.config.gamma * (1.0 - done) * next_values`),
      p('PPOTrainer.run_episode：保存动作、旧 log-prob 和价值；逆序计算带负续值/负续优势的 GAE，标准化优势，再多轮优化 clipped ratio。value_loss 先含 0.5，随后总损失又乘 0.5，故其均方误差总系数为 0.25；熵系数为 0.01。不要把默认 PPO 公式中的系数直接写成这个实现。',
        'PPOTrainer.run_episode stores actions, old log probabilities and values, computes reverse GAE with negative continuation values/advantages, normalizes advantages and optimizes clipped ratios. value_loss already contains 0.5 and is multiplied by another 0.5 in the total loss: its squared-error coefficient is 0.25. Entropy has coefficient 0.01; generic PPO defaults are not this source contract.'),
      src('research/iclr2027/lifeline_rl/model_free/ppo.py', 'PPOTrainer.run_episode', `            value_loss = 0.5 * (values_now - returns).square().mean()
            entropy = dist.entropy().mean()
            loss = policy_loss + value_loss * 0.5 - entropy * 0.01`),
      p('SACTrainer.update：双 Q 与双目标 Q，按合法离散动作精确求和计算 soft value；目标同样采用负续值。Q 用平方误差，策略最小化 Σπ(α logπ−min(Q₁,Q₂))；目标参数用 τ 做软更新。推理只需要策略头，因此不能从运行时缺少 Q 网络推断训练没有双 Q。',
        'SACTrainer.update maintains twin Q and target-Q networks, exactly sums over legal discrete actions for soft values, and also uses negative continuation. Q uses squared loss; the policy minimizes Σπ(α logπ−min(Q₁,Q₂)); targets use τ soft updates. Inference needs only the policy head, so absent runtime Q networks do not imply absent twin-Q training.'),
      ref('research/iclr2027/lifeline_rl/model_free/sac.py', 'SACTrainer.update'),
      p('GAIL/GAN：train_imitation_adversarial.py 从 greedy expert 收集数据；两种标签调用同一循环，主要改变种子偏移与元数据。D 输入“状态+动作 one-hot”，专家标签=1、生成动作=0。为避免离散采样的不可导步骤，生成器枚举全部动作，以概率加权计算下列期望，而不是对抽样动作直接求导。',
        'GAIL/GAN: train_imitation_adversarial.py collects greedy-expert data. Both labels use one loop, mainly changing seed offset and metadata. D consumes state plus action one-hot, with expert=1 and generated=0. The generator enumerates all actions and differentiates a probability-weighted expectation instead of differentiating through a sampled discrete action.'),
      src('research/iclr2027/scripts/train_imitation_adversarial.py', 'train', `            rewards = torch.sigmoid(-discriminator(repeated_states, action_grid)).reshape(batch_states.shape[0], ACTION_COUNT)
            g_loss = -(probs * torch.log(rewards.clamp_min(1e-6))).sum(dim=1).mean()`),
      p('这里的负号很关键：固定 D 时，最小化 −log σ(−D) 偏向较小 D，而专家正标签训练偏向较大 D。因此当前循环不能直接享有标准 GAIL 的模仿保证；两个名称也不等于两种独立算法。脚本在固定专家状态批次上更新，并非完整在线占用分布匹配；训练采样未在该循环应用合法掩码，Web 推理另做真实合法过滤。这些历史神经训练循环仅作源码说明；本次线性继续训练不修改这些循环或神经权重。',
        'The sign matters: holding D fixed, minimizing −log σ(−D) favors smaller D, whereas expert-positive classification favors larger D. This loop cannot directly inherit standard GAIL guarantees, and two names do not establish two independent algorithms. Updates use fixed expert-state batches, not full online occupancy matching; this loop does not mask sampled actions, while Web inference separately filters actual legality. These historical neural loops are documented only; the linear continuation changes neither those loops nor their neural weights.'),
    ]),
    s('multi-policy', '3.8 多人线性策略', '3.8 Multiplayer features', [
      ...notes('multi-policy'),
      c(`01 Save S and before-move metrics for all players
02 For each real legal placement a:
03   play a; measure nodes, coverage, reach, capture and frontier changes
04   normalize the 16-feature vector; score = dot(w,features)/temperature
05   restore S
06 Stable rank by score and coordinate; softmax -> prior`),
      ref('web/web前端/ThreePlayerAI.js / HexPlayerAI.js', 'feature extraction, candidate scoring, getTopMoves'),
    ]),
    s('three-search', '3.9 三人 V4', '3.9 Three-player V4', [
      ...notes('three-search'),
      c(`01 roots <- base policy's top 3 placements
02 For each root a and response policy in {V1,V2}:
03   restore full root state; play a
04   simulate at most 12 further plies using actual turn order
05   compute exact area and leaf preference / terminal winner share
06 Average the two response-policy scores
07 Rank by mean score, territory margin, base score and coordinate
08 If improvement over original first choice <0.02: retain that choice`),
      ref('web/web前端/ThreePlayerSearchAI.js', 'positionUtilityV4, ThreePlayerSearchAI.getTopMoves'),
    ]),
    s('hex-search', '3.10 六边形 V5', '3.10 Hexagonal V5', [
      ...notes('hex-search'),
      c(`01 Rank by V1; retain <=2 roots within base-score gap 0.4
02 If quiet and legal count >6: return base ranking
03 For each retained root: restore isolated state and play it
04 Simulate <=5 V1 replies, stopping at terminal or return/repeated actor
05 Terminal -> exact area; otherwise -> 0.7*reach+0.3*coverage
06 Compare terminal tiers, then values; ordinary switch needs >=0.03
07 Restore the source engine and its territory cache`),
      ref('web/web前端/HexFastSearchAI.js', 'evaluateHexFastLeafV5, chooseHexFastSearchLeafV5, getTopMoves'),
    ]),
    s('later', '3.11 后续多人搜索', '3.11 Later multiplayer search', [
      ...notes('new-multiplayer', [1, 3, 4]),
      p('截至 2026-10-23 所查 Web 源码，困难的原生形状路径以 650 ms 为目标预算，按 12、24 层比较全部合法根落点及主动 PASS；只有阶段内所有根完成同一组应对/层数比较，才发布该完整阶段。超时退回上一完整阶段或基准策略；单次同步规则操作可能越过目标时限。',
        'In Web source inspected on 2026-10-23, native-shape hard mode targets 650 ms and compares all legal roots plus PASS at 12/24-ply horizons. It publishes a phase only after all roots complete the same responses/horizon. Timeout retains the last complete phase or base fallback; a synchronous rule operation can overshoot the target.'),
      p('终极候选先用迁移 GNN 给合法落点先验，推理时间计入预算；后续检查 12、24、36 层，设置 publishCompletedComparisons=true。它可以在整轮尚未结束时，发布与固定阶段基准在相同深度/完整应对前缀上已经完成的改进；不能写成“每次都完成全根扫描”。不足预算时回退到 GNN 合法落点 argmax，仅无落点才 PASS，不用未经训练的 PASS/value 头作回退。',
        'The ultimate candidate obtains transferred-GNN priors and charges inference to the budget, then checks 12/24/36 plies with publishCompletedComparisons=true. Before a whole sweep completes it may publish an improvement whose comparison against the fixed phase anchor has completed at the same depth and full response prefix. It does not always finish every root. Fallback is legal-placement GNN argmax, or PASS only with no placement, avoiding untrained PASS/value heads.'),
      c(`01 Compute base / GNN fallback and remaining budget
02 For each configured horizon and response prefix:
03   Evaluate a common incumbent anchor
04   Evaluate competing roots under the same comparison conditions
05   Hard: publish only a complete root sweep
06   Ultimate candidate: may publish a completed improving comparison
07 On deadline: discard unfinished leaf/response work; keep valid incumbent
08 Report whether decision came from fallback, full phase or comparison`),
      p('非默认形状的 MultiplayerMinimaxAI 使用 paranoid α–β、主动 PASS、迭代加深与完整迭代回退。多人 GNN 把敌方节点/线/起点与关系合并编码，并不显式表示各敌方身份。LocalAIModes.js 的 MULTIPLAYER_ULTIMATE_AVAILABLE 当前为 false，运行器为 application-candidate；文档纳入实现不等于推广或手机发布。',
        'On non-default shapes, MultiplayerMinimaxAI uses paranoid alpha–beta, PASS, iterative deepening and complete-iteration fallback. Multiplayer GNN pools enemy nodes/lines/starts and relations without explicit individual-opponent identity. MULTIPLAYER_ULTIMATE_AVAILABLE in LocalAIModes.js remains false and the runtime is application-candidate. Documenting it does not establish promotion or phone release.'),
      ref('web/web前端/MultiplayerRuntime.js / MultiplayerRollout.js / MultiplayerSearch.js / MultiplayerModel.js', 'loadMultiplayerRuntime, getTopMoves, canonical leaf evaluation, publication policy'),
    ]),
    s('runtime', '3.12 调度与可复现性', '3.12 Runtime and reproduction', [
      ...notes('workers'), ...notes('integrity'),
      c(`01 Request <- {id, revision, rules, actor, config, full state/actions, model}
02 Queue in the single Mini Game Worker; reject cancelled/stale tasks
03 Restore engine (reuse only an identical config and action prefix)
04 Validate model identity, dimensions, lengths and asset integrity
05 Run the selected strategy; report candidates and metric meaning
06 Receiver checks request/context again and validates the chosen action
07 On timeout/error: preserve recoverable match and expose retry`),
      p('把“模型名称、训练循环、导出文件、运行时策略、证据等级”分别记录，是排查结果差异的最短路径。完整状态与完整比较条件是算法合同；目录、分页、公式的显示则属于阅读合同。两篇文章可独立维护叙述，但关键公式、预算和源代码引用必须随版本重新核对。',
        'Record model label, trainer, exported asset, runtime strategy and evidence tier separately to diagnose differences. Full state and comparable evaluations are algorithm contracts; contents, pagination and equation display are reader contracts. The two articles have independent exposition, while formulas, budgets and source references require version checks.'),
      ref('web/web前端/AIStateProtocol.js / ReplayCodec.js', 'state identity, full restoration and isolated replay validation'),
    ]),
  ]),
];
