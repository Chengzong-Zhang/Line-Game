// Shared prose for the Web articles and the native Mini Game reader.
// Update the exported Markdown with tools/sync-implementation-guides.mjs.
const chapter = (id, zh, en, chinese, english) => ({ id, title: { zh, en }, paragraphs: { zh: chinese, en: english } });

export const IMPLEMENTATION_NOTES = [
  chapter('state', '棋盘与完整状态', 'Board and complete state', [
    '把屏幕上的棋盘拆成三层，会更容易理解后面的算法。第一层是固定的格点与六邻接关系；第二层 grid 记录每个位置为空、某方棋子节点或某方连线途经点；第三层 edges 为每一方单独保存真实存在的逻辑边。线经过某个位置，不表示那里放了一颗棋子；看起来挨在一起，也不自动等于逻辑上相连。',
    '边长 N 指外边上的格点数。三角棋盘有 N(N+1)/2 个格点，六边形有 3N(N−1)+1 个格点；N=15 时分别为 120、631。整数坐标的六个方向是 (1,0)、(−1,0)、(0,1)、(0,−1)、(1,−1)、(−1,1)。绘制时再投影到屏幕，规则计算不依赖像素、缩放或手机分辨率。',
    '完整状态还包括棋盘形状、规则版本、各方实际起点、当前行动方、连续跳过次数、认输集合、终局标记，以及全部 Superko 历史。领土缓存与局面修订号用于加速和异步显示；只保存一张棋盘图片，或者只保存 grid，都不足以恢复一局棋的全部规则。',
  ], [
    'Separate the board into three layers. Fixed lattice points and their six-neighbor adjacency form the geometry. The grid records empty points, player nodes and intermediate points occupied by links. Each player also owns an explicit edges set recording the logical links that actually exist. A point crossed by a line is not necessarily a placed node, and nearby graphics do not establish a logical connection.',
    'Side length N counts points along an outer side. A triangle contains N(N+1)/2 points; a hexagon contains 3N(N−1)+1. At N=15 these counts are 120 and 631. The six integer directions are (1,0), (−1,0), (0,1), (0,−1), (1,−1) and (−1,1). Projection into screen pixels happens only when drawing, so zoom and device resolution do not change the rules.',
    'The complete state also includes shape, rules version, actual starting points, the player to act, consecutive passes, resigned players, terminal status and the entire Superko history. Territory caches and revision numbers support efficient asynchronous display. Neither a screenshot nor the occupancy grid alone restores the full rule state.',
  ]),
  chapter('connections', '自动连线如何发生', 'Automatic connections', [
    '一次落子先检查新点能否沿网格直线连接到已有己方节点。两点必须位于同一条 x 恒定、y 恒定或 x+y 恒定的网格线上；扫描中间格点时，遇到任一敌方节点或敌方线点就被阻挡。若没有任何可连的己方节点，这次落子不成立。',
    '连接成功后，端点记为 NODE，中间原本为空的点记为 LINE，并把两个端点组成的无向边加入 edges。端点顺序规范化，避免 A—B 与 B—A 重复入库。新点与已有节点的连接检查可以保留长边，因此规则并不是只把屏幕上相邻的一对棋子连起来。',
    '随后 _connectAllCrawl 从己方每个节点沿六个方向爬行：遇敌方元素停止，遇第一个己方节点就补上缺少的边，再结束该方向扫描。直接切线可能清走遮挡物，所以攻击后还会检查其他各方，补上新解锁的连接。扫描读取当前占用；预缓存的只是固定射线路径。',
    '领土着色轮廓与实际连线是两个对象。轮廓为了计分而经过某个空点，并不会把它变成 LINE，也不会凭空产生可攻击的逻辑边。',
  ], [
    'A placement must connect to an existing friendly node along a lattice straight line: constant x, constant y or constant x+y. Every intermediate point is checked. Any opponent node or opponent line point blocks the connection. If no friendly node is reachable this way, the placement fails.',
    'Successful connections keep endpoints as NODE, fill eligible empty intermediate points as LINE and add an undirected endpoint pair to edges. Endpoint order is canonicalized so A—B and B—A are not duplicated. The new-node checks can retain long links; connecting is not restricted to adjacent visible stones.',
    'The _connectAllCrawl pass then walks six rays from each friendly node. An enemy element stops a ray; the first friendly node supplies a missing edge and ends that ray. A direct cut can remove blockers, so the attack path also rescans the other players for newly unlocked connections. Only ray geometry is cached; occupancy is read again each time.',
    'A scoring contour is separate from a real link. If contour tightening crosses an empty point, that point does not become LINE and no attackable logical edge is invented.',
  ]),
  chapter('cuts', '切断与起点连通性', 'Cuts and root connectivity', [
    '落在敌方 LINE 上是切线，而不是吃掉任意敌方棋子。攻击会破坏经过该位置的逻辑边；_cleanupBrokenEdges 逐条检查边上的格点，把已经不完整的边移除。双方的普通落子与 AI 模拟都走同一套状态转移。',
    '接着以被攻击方的实际初始节点为根，在显式边集形成的节点图上做 BFS。能沿存活逻辑边走到的节点留下；存活边的中间线点也留下。失去所有回家路径的节点与线点被清除，再处理边集与可能恢复的原有连接。这里的 BFS 是“沿补给图找根连通分量”，不是“从棋盘边缘注水算领土”。',
    '例如 A—B—C 是一条从起点 A 出发的唯一通路，切掉 A—B 会使 B、C 一侧失联；若 C 还有另一条绕回 A 的路径，则那一侧未必消失。视觉上碰到一条路过的线，也不能替代真实的端点—边路径。',
  ], [
    'Placing on an opponent LINE cuts a link; it does not capture an arbitrary opponent node. The attack breaks logical edges passing through that position. _cleanupBrokenEdges checks the lattice points of each edge and removes edges that are no longer intact. Human play and AI simulations use the same state transition.',
    'A BFS starts at the attacked side’s actual initial node and follows the explicit node-to-node edge graph. Reachable nodes survive, together with the intermediate points of surviving links. Nodes and line points with no remaining route home are removed, followed by edge cleanup and restoration checks. This BFS finds a rooted supply component; it is different from flooding the board exterior to score territory.',
    'Suppose A—B—C is the only route from starting node A. Cutting A—B disconnects the B,C side. If C has another route back to A, that side may survive. Merely touching a line that passes nearby does not replace an actual endpoint-and-edge route.',
  ]),
  chapter('legality', '合法性与三点限制', 'Legality and the three-point limit', [
    '合法动作由真实引擎试走决定。检查包括有效坐标、可占用状态、敌方起点保护、三点限制、与己方建立连接，以及动作完成后是否触犯 Superko。空点与线点可以成为落子候选，已有 NODE 不能被覆盖。所有敌方实际起点的有效邻点都受保护，随机起点与自定义起点也按相同方法检查。',
    '三点限制以当前 _checkThreePointLimitation 的实现为准：新点若已有至少两个相邻己方节点，拒绝；如果它只邻接一个己方节点，但该节点已经邻接另一己方节点，也拒绝。因此它限制的是形成三个相邻节点的链或团，直线或折线三连也可能触发，并不只是检查最小三角形。',
    '直接落在敌方线点上的切线动作可豁免这项三点检查，但不能豁免起点保护、连接要求或 Superko。合法性不会读取着色用的领土缓存来猜测能否落子；实际节点、线点、连线阻挡和完整历史共同决定结果。',
    '试走必须可撤回。_evaluateMove 临时修改棋盘与边集，计算结果状态，然后在 finally 中恢复。合法点提示可以检查很多候选，却不应改变正在进行的棋局。',
  ], [
    'The real engine tests placements, checking coordinates, occupiable state, protected neighbors of enemy starts, the three-point limit, a friendly connection and Superko after the transition. Empty points and line points can be candidates; existing NODE points cannot be overwritten. Protection follows every actual enemy start, including random and custom starts.',
    'The current _checkThreePointLimitation rejects a new point with at least two adjacent friendly nodes. It also rejects a point adjacent to one friendly node that already has another friendly node as a neighbor. Thus a chain or cluster of three adjacent nodes can trigger the limit, including straight or bent chains; the check is broader than a smallest-triangle-only test.',
    'A direct placement on an enemy line point bypasses this three-point check only. Starting-zone protection, the connection requirement and Superko still apply. The legality path does not consult a colored territory cache as a click mask: actual nodes, line points, blockers and full history determine the result.',
    '_evaluateMove performs a reversible trial, computes the resulting state identity and restores the board and edge sets in finally. Listing legal moves may inspect many candidates without changing the live game.',
  ]),
  chapter('superko', '全局同形禁手 Superko', 'Global repetition: Superko', [
    '这里的名称是“全局同形禁手”，不是“全局没有禁手”。它防止切断、重新连线之后反复回到已经记录过的同一全局局面，而不是只禁止紧接上一手的局部反吃。',
    '当前 _computeStateHash 的状态键依次包含：下一行动方、认输玩家列表、按坐标排序的所有非空格点及其状态、按玩家组织并排序的显式边集。虽然函数名叫 Hash，这里实际上用稳定的 JSON 字符串作为 Set 的键，不是只保留一个短整数哈希。相同棋子分布但逻辑边不同，不算同一个键；下一行动方不同，也可能是不同的键。',
    '开局键先进入 historyHashes。每次候选落子完成连接、切断和清理后，计算下一局面键；若历史里已有该键，则判 SUPERKO_VIOLATION 并撤回。真实合法落子才把新键加入历史。跳过按独立回合规则处理，不把“棋盘没有变化”直接当作非法重复；认输也有自己的轮转和结算逻辑。',
    '例如两份存档的棋盘与当前玩家完全相同，但其中一份历史已包含“落在 P 后的结果”，另一份没有，P 就可能只在后一份合法。因此搜索快照、悔棋、复盘分支与恢复都必须保留各自那条路径的历史；网络特征或棋盘截图不能代替它。',
  ], [
    'The rule is global repetition prohibition, or Superko. It prevents returning to a previously recorded global position after cuts and reconnections, rather than merely forbidding an immediate local recapture. It does not mean that the game has no forbidden moves.',
    'The current _computeStateHash key contains the next player, resigned-player list, all nonempty grid entries sorted by coordinate and every player’s sorted explicit edge set. Despite the name Hash, the implementation uses a stable JSON string as the Set key rather than a short integer digest. Equal occupancy with different logical edges gives a different key; a different next player can also distinguish keys.',
    'The initial key enters historyHashes. After a trial placement completes connections, cuts and cleanup, its resulting key is checked against that history. A match returns SUPERKO_VIOLATION and the trial is rolled back. Accepted placements add their keys. Passing follows separate turn rules: an unchanged board alone does not make a pass illegal. Resignation also has its own rotation and settlement behavior.',
    'Two saves can show the same board and player to act, yet only one history contains the result of placing at P. That placement may be legal only in the other save. Search snapshots, undo, replay branches and recovery must retain their own path histories; network features or screenshots cannot replace them.',
  ]),
  chapter('contour', '领土一：外轮廓与闭环', 'Territory: contour and cycle', [
    '显示轮廓先收集己方节点与线点，并把其他各方的节点和线点作为敌方元素。_getOuterContourFromPoints 按固定顺时针邻接顺序，用右手摸墙式遍历取得外轮廓。轮廓是一条格点闭合游走，可以沿枝条走出去再折返，因此同一个格点可能在游走序列中出现多次；这条轮廓不再定义正式计分。',
    '闭合游走不一定围出真正的区域。A—B—C—B—A 只是来回走了一条线。_hasBoundaryCycle 用于轮廓候选与显示诊断，但正式计分不依赖它。territory-v3 将全部己方节点和线点作为墙，按边界洪水找出所有空腔；无闭环时仍计己方占点，多个空腔和甜甜圈内孔也会独立判断。',
    '轮廓仍用于画面诊断，但正式分数不依赖它能否形成单一闭环。计分会把全部己方节点和线点当墙，从棋盘边界注水；所有不连通外界的空腔逐一计数，含敌方元素的空腔排除。开链、多个环和甜甜圈内孔都由同一连通分量判定处理。',
  ], [
    'The display contour collects friendly nodes and line points and treats every other side’s nodes and line points as enemy elements. _getOuterContourFromPoints uses a fixed clockwise neighbor order for a right-hand wall-following traversal. The result is a closed lattice walk that can travel out along a branch and return, so vertices may occur repeatedly in its sequence; this contour no longer defines the official score.',
    'A closed walk need not enclose a region: A—B—C—B—A merely retraces a line. _hasBoundaryCycle is used for contour candidates and display diagnostics, but official scoring does not depend on it. territory-v3 treats all friendly node and line points as walls and uses boundary flood fill to find every pocket; owned points still score without a cycle, and multiple pockets or donut holes are checked independently.',
    'This contour is constructed from physical occupied lattice points and is used for display and diagnostics. It serves a different purpose from following edges to establish supply connectivity after a cut. Tightening keeps all friendly nodes in the display contour, but the official score is computed independently from the owned-wall pockets.',
  ]),
  chapter('tightening', '领土二：贪心收紧', 'Territory: greedy tightening', [
    '_computeRawTerritory 对当前轮廓反复寻找捷径。选取轮廓上的两个位置作为端点，避开敌方格点，在棋盘六邻接图上做 BFS，取得最短距离及全部最短路的前驱关系，再枚举相关最短路径。将路径与旧轮廓的两侧分别拼接，产生可能保留的候选闭合游走。',
    '候选必须保住全部己方节点、不能覆盖任何敌方节点或线点，并且满足有效闭环。比较采用字典序：先让轮廓步数更少；步数相同时，让覆盖格点数更少。每轮接受找到的最好候选，继续收紧，直到找不到改善。这里的周长按离散轮廓游走步数衡量；枝条的往返会体现在游走长度中。',
    '覆盖格点由下一节的洪水法计算。为了避免重复工作，实现会复用同一源点的 BFS、相同边界的覆盖检查，并用周长下界和可覆盖性条件排除不可能改善的路径。它不会简单地只保留某个随意固定数量的最短路径来冒充精确检查。',
    '这是一套确定性贪心收紧程序。它在自己的候选与接受规则下停止，不能据此宣称已经找到所有可能多边形中的全局最短周长或全局最小覆盖面积。收紧也可能使用原本为空的网格点，因此最终计分边界不必逐段等于原有的实体连线。',
  ], [
    '_computeRawTerritory repeatedly searches for shortcuts. It chooses two positions on the contour, runs BFS on the six-neighbor board graph while excluding enemy points, and records shortest distances together with the predecessor relationships for shortest paths. Relevant shortest paths are joined to either side of the old contour to form candidate closed walks.',
    'A candidate must cover every friendly node, exclude every enemy node and line point, and retain a valid cycle. The comparison is lexicographic: fewer contour steps first, fewer covered lattice points second. The best improving candidate found in a round becomes the next contour, until no improvement remains. Perimeter here counts discrete contour-walk steps, including travel out and back along branches.',
    'Flood fill computes coverage. The implementation reuses BFS results from the same source and repeated wall-coverage checks. Perimeter bounds and coverage feasibility reject paths that cannot improve the result. It does not claim exact checking by arbitrarily retaining only a fixed number of shortest paths.',
    'This is deterministic greedy tightening, not a proof of globally minimum perimeter or coverage over all possible polygons. Shortcuts may use empty lattice points, so the final scoring boundary need not consist solely of the original physical links.',
  ]),
  chapter('flood', '领土三：洪水与分数', 'Territory: flood fill and score', [
    '_computeOwnedWallArea 把己方节点与线点标成墙，并调用 _getCoveredPoints 从棋盘边界注水。再对未被水访问的非墙点做分量 BFS；分量含敌方点时不计，否则计入。单线没有空腔但占点照常计分。',
    '令 V 为全棋盘格点，F 为己方节点与线点，删除 F 后从棋盘边界洪水可达的点为 X；Qₖ 是 V\\(F∪X) 的各连通分量，B 为不含敌方节点或线点的 Qₖ 之并。territory-v3 的 area=|F|+|B|。这一定义无需有效闭环，因此开链和单线照常计占点；多个空腔及甜甜圈内孔分别计入，敌方所在空腔整块排除。同一点只算一次。这里数格点，不数最小三角形。',
    '旧 territory-v2 六人截图曾得到格点分数 25、10、11、13、8、8，以及几何诊断 6、2、2、4、2、2；这些不是新规则的复核分数。新规则中青方即使只有未闭合的三个己方格点，也应得 3。',
    '引擎另用鞋带公式计算 displayArea，单位对应最小三角形面积。它是几何诊断；比分与终局比较读取 area。洪水法只是给定墙后区分内外，计分单位由被遍历的对象决定：在格点图上注水与在小三角面之间注水，并不是同一个计数问题。',
  ], [
    '_computeOwnedWallArea marks all friendly node and line points as walls, then calls _getCoveredPoints to flood from the board boundary. It finds connected components among unvisited non-wall points; a component containing an enemy is excluded, while each other component is counted. An open line creates no pocket but its owned points still score.',
    'Let V be all board points and F the owned node and line points. After deleting F, flood from the board boundary to obtain exterior-reachable points X. Let Qₖ be the connected components of V\\(F∪X), and B the union of components containing no enemy node or line. In territory-v3, area=|F|+|B|. No valid cycle is required: open chains and single lines still score their owned points; multiple pockets and donut holes count separately, while a pocket containing an enemy is excluded in full. Every point counts once. The unit is lattice points, not triangular faces.',
    'The old territory-v2 six-player screenshot gave lattice scores 25, 10, 11, 13, 8 and 8; these are historical, not verified v3 scores. Under v3, Cyan’s three owned points score 3 even when their chain is open.',
    'The engine also computes displayArea with the shoelace formula, measured in smallest-triangle units. It is a geometric diagnostic; the scoreboard and settlement use area. Flood fill distinguishes inside from outside for a supplied wall. Flooding a graph of lattice points and flooding adjacency between triangular faces are different counting problems.',
  ]),
  chapter('symmetry', '方向公平与领土缓存', 'Orientation and score caches', [
    '固定方向的轮廓遍历可能偏向某席位。territory-v3 沿用 v2 的规范朝向生成用于显示的闭环轮廓，并独立从全部己方点线计算正式空腔分数。三角棋盘使用重心坐标置换；六边形使用 D6 旋转与反射。规范候选轮廓的选择不决定正式 area。',
    '精确领土需要轮廓、最短路径和洪水检查，通常比简单数棋子昂贵。实现使用整数格点下标、预计算邻接表、可复用 TypedArray 队列与 epoch 标记，减少字符串、集合与数组分配。它们改变计算成本，不改变 area 的单位。',
    '显示层可以缓存领土或交给 Worker 计算，但结果必须带着正确的局面修订号回来。旧局面的结果不能覆盖新棋盘；终局判胜必须取得当前局面的精确得分。fastTerritoryBFS 等 AI 估计不能填进正式领土缓存。',
  ], [
    'A fixed absolute contour traversal can favor a seat. territory-v3 keeps v2’s canonical transforms to generate a closed contour for display, while official pocket scoring is computed independently from all friendly points and lines. Triangles use barycentric permutations and hexagons D6 transforms. Canonical contour selection does not determine official area.',
    'Exact territory needs contour processing, shortest paths and flood checks. Integer point indices, precomputed adjacency, reusable TypedArray queues and epoch marks reduce allocation and repeated work. They change computational cost, not the unit of area.',
    'The UI can cache territory or compute it in a Worker, but a returned result must belong to the correct position revision. An old result cannot repaint a newer position, and terminal settlement requires current exact scores. AI estimates such as fastTerritoryBFS must not populate the official score cache.',
  ]),
  chapter('turns', '跳过、认输与终局', 'Passes, resignation and endings', [
    '当前版本允许主动跳过。没有合法落点时，引擎还会自动跳过该玩家；轮转时排除已经认输的玩家。因此搜索树里“下一层轮到谁”必须读引擎状态，不能一律按照递归深度的奇偶来猜。',
    '所有仍在场的玩家连续各跳过一次后，正常终局按各自精确 area 比较；最高分并列就是平局。中途有人成功落子，连续跳过计数重置。认输者退出轮转与胜者比较；若只剩一位未认输玩家，该玩家立即获胜。',
    '对固定有限棋盘，记录历史的合法落子不能无限重复同一状态键；连续跳过又有结算规则。这个终止机制并不意味着 AI 已经求解游戏，也不能把旧文中“玩家无法跳过，因此必然被迫落子”的论证沿用到当前规则。',
    '2026-10-25 的产品选步取消了“跳过立即独胜就直接返回 PASS”的捷径。共享检查保留原策略的落子；首选 PASS 时，在隔离完整状态中先查下述起点保护区不变量，否则枚举实际对手的全部合法落子与 PASS，直到原行动方再次行动或原生终局，寻找保留己方节点、覆盖和起点连通的增长落点。若原 PASS 会独胜，替代落点还须在这个窗口内保持领先。',
    '该检查默认最多 200 毫秒、10000 个节点，只在完整证书成立时替换 PASS；开局还允许节点增长且正式 area 不减的完整发展证书。预算不足或没有证书时保留真实策略 PASS，无合法落点按引擎规则跳过，策略完全无结果则报告可重试错误。一轮应对证书只证明所检查的一轮，也不是训练所需的深层 Minimax 标签。',
    'V3 对不会立即结算的真实策略 PASS 优先检查起点保护区证明：落子后保留全部原节点和覆盖，所有己方节点沿完好的逻辑边连回起点，全部己方线点位于起点相邻保护区，且占据格点数严格超过落子前的正式 area。对手既不能占己方节点，也不能落在受保护线点，因此在自己下次实际行动、认输或原生终局前，任意对手行动序列都不能切断这些棋形。即使自己被自动跳过，也可用此证书继续安全扩张；它不证明未来分差、胜率或整体最优。隔离状态和规范 PASS 检查计入总预算；随后结构搜索最多检查 12 个靠近起点的落点，搜索窗口最多为 8 毫秒与总预算 5% 中较小者；没有证书时，完整应对检查继续使用实际剩余预算。会立即结算的 PASS 保留原有领先检查，Minimax 搜索深度不变。',
  ], [
    'Voluntary passing is allowed. The engine also automatically skips a player with no legal placements and excludes resigned players from rotation. Consequently, a search must read the engine’s actual next player rather than infer the turn from recursion-depth parity.',
    'Normal settlement occurs after all remaining players pass consecutively once each. Their exact area scores are compared; equal highest scores draw. An accepted placement resets the consecutive-pass count. Resigned players leave both the turn order and the winner comparison; a sole remaining player wins immediately.',
    'On a fixed finite board, accepted placements cannot repeat recorded state keys indefinitely, while consecutive passes have an ending rule. This termination mechanism does not mean an AI has solved the game. Arguments based on an inability to pass do not describe the current rules.',
    'The 2026-10-25 product path removes the shortcut that immediately returned PASS whenever it ended in a unique win. Shared checks preserve real policy placements. When PASS ranks first, an isolated complete state first checks the birth-root invariant below; otherwise it enumerates every legal placement and PASS by actual opponents until the original actor returns or native termination occurs, seeking profitable growth retaining own nodes, coverage and logical connection to the start. A replacement for a uniquely winning PASS must retain the lead throughout that window.',
    'The default check has a 200 ms/10000-node budget and replaces PASS only with a complete certificate; opening development may instead add nodes while exact area does not decrease. Incomplete or absent evidence preserves a real policy PASS. No-placement passing follows the engine, while missing policy output reports a retryable error. A full-round certificate certifies that examined round only and is not a deep Minimax training label.',
    'For a real policy PASS that would not immediately end the game, V3 first checks a birth-root protection invariant: every old node and coverage point survives the placement, every friendly node connects to the birth root through intact logical edges, every friendly LINE cell is adjacent to the birth root, and occupied coverage strictly exceeds the previous native area. Opponents cannot occupy friendly nodes or protected line cells, so any opponent-only action sequence preserves these pieces until the actor next acts, resigns or the game naturally ends. This also permits certified growth when the actor is automatically skipped. It proves no future score margin, win rate or overall optimality. Isolation and the canonical PASS preflight count toward the total budget. Structural root search then tries at most 12 roots near the birth node within the smaller of 8 ms and 5% of the total budget; without a certificate, full-round checks receive the actual remaining budget. Immediately ending PASS retains the original lead check, and Minimax search depth is unchanged.',
  ]),
  chapter('heuristic', '贪心与快速估值', 'Greedy play and evaluation', [
    '贪心 AI 先枚举真实合法落点，按“切敌方线、邻近己方线、其余落点”的顺序排序，最多保留 20 个候选。对每个候选试走一手，计算评价，再恢复状态，选择评价最高的点。它看的是一步之后的估计好坏，不保证正式领土增量最大。',
    '当前 AIEngine 的评价为 F=15Δ节点+8Δ覆盖+20Δ可达+12可攻击线点+10起点连通质量。覆盖是节点数加线点数；双人时差值针对对手，多人通用贪心会把部分对手计数求和，而可达差选择节点最多的主要对手。可攻击线点必须经真实合法性检查，包括 Superko。连通质量逐个检查己方节点是否能沿逻辑边回到起点。',
    'fastTerritoryBFS 从己方全部节点和线点向外扩张，敌方元素作为障碍，统计能到达的格点。这是一项活动空间特征，即使没有闭环也可能很大；它不等于“从棋盘边缘往内注水”得到的正式领土。AI 评价、显示色块和终局 area 因而必须分开解释。',
  ], [
    'Greedy AI enumerates genuinely legal placements, prioritizes cuts on enemy links, then placements adjacent to friendly line points, then other placements, and retains at most 20 candidates. Each candidate is played once, evaluated and rolled back. The largest estimate wins; this need not maximize exact territory gain.',
    'AIEngine uses F=15Δnodes+8Δcoverage+20Δreach+12attackable line points+10root-connectivity quality. Coverage counts nodes plus line points. In two-player play the differences compare the opponent; generic multiplayer greedy sums some opponent counts but selects the opponent with most nodes for its reach comparison. Attack opportunities are checked by actual legality, including Superko. Connectivity quality checks each friendly node’s route to its start through logical edges.',
    'fastTerritoryBFS grows outward from all friendly nodes and line points while enemy elements block expansion. It estimates accessible space, which can be large without a closed region. It is not the official exterior flood fill. Search evaluation, shaded geometry and terminal area therefore have different meanings.',
  ]),
  chapter('minimax', 'Minimax 与 α–β 剪枝', 'Minimax and alpha–beta', [
    'Minimax 把“我选择最好的一步，对手选择对我最不利的一步”递归展开。以根玩家为评价视角：当前行动方是根玩家时取所有被搜索后继的最大值，轮到对手时取最小值。Web 与小程序的 Minimax 简单、中等、困难分别为深度 2、3、4，指行动层数而非每方轮数；它是固定深度搜索，没有多人困难路径的 650 毫秒总预算。比较速度应固定局面、尺寸和实际深度。',
    'α 保存 MAX 已有的下界，β 保存 MIN 已有的上界；当 β≤α，继续展开这条分支已不可能改变祖先的选择，可以剪掉。α–β 在相同候选树和评价下保留 Minimax 的决策，但每层最多 20 个排序候选本身是另一种截断，会漏掉排序之外的合法招法。',
    '每个分支先保存 grid、edges、historyHashes、行动方、认输、跳过、终局、修订号和领土缓存，再通过 GameEngine.playMove 或 skipTurn 推进，随后恢复。自动跳过可能让同一玩家连续获得行动，MAX/MIN 因而由 currentPlayer 决定。非终局深度耗尽使用 Minimax 的启发式估值；真实终局按正式 area 判胜、平、负，返回 +1000000、0、−1000000。有限候选与有限深度的非终局结果仍不是整局胜负证明。',
    '当前双人 Minimax 把 PASS 与合法落点一起作为根层和递归层候选，并通过 GameEngine.skipTurn 推进；因此即使有合法落点也可主动跳过。PASS 是否入选仍取决于同一启发式和有限深度搜索，不等于已经求解终局。多人困难搜索另有完整下一位对手 MOVE+PASS 回复包与时间门，两套实现的证据范围需要分别说明。',
    '为减少等待，推演不生成界面快照、不反复计算只用于显示的领土；只到启发式叶子时还可省去不影响 F 的下一玩家自动跳过扫描。非叶子仍保持真实轮转，避免提速改变树的含义。',
  ], [
    'Minimax recursively models the best move against the worst reply for the root player. Root-player nodes take a maximum and opponent nodes a minimum. Web and Mini Game Minimax Easy/Medium/Hard use depths 2/3/4, counting action layers rather than complete seat rounds. This fixed-depth search has no 650 ms total budget from Multiplayer Hard; compare speed at the same position, size and actual depth.',
    'Alpha stores a lower bound already available to MAX; beta stores an upper bound for MIN. When beta is no greater than alpha, the branch cannot improve the ancestor’s decision and can be cut. Alpha–beta preserves Minimax on the same candidate tree and evaluation. The separate 20-candidate cap truncates that tree and can omit legal moves.',
    'Each branch saves grid, edges, history, turn, resignations, passes, terminal state, revisions and territory cache, advances through GameEngine.playMove or skipTurn and restores the state. Automatic passes can return control to the same player, so currentPlayer determines MAX versus MIN. Nonterminal depth-limited leaves use the Minimax heuristic. True terminal leaves use official area and return +1000000/0/−1000000 for win/draw/loss. Bounded nonterminal search still does not prove the outcome of the whole game.',
    'The current two-player Minimax includes PASS alongside legal placements at both root and recursive nodes, and advances it through GameEngine.skipTurn. It can therefore pass while placements remain. Selection still depends on the same heuristic and bounded-depth search; it is not an exact solution of the ending. Multiplayer Hard instead evaluates complete MOVE-plus-PASS reply packets from the actual next opponent under its own time gate, so the evidence scopes remain separate.',
    'Search suppresses UI snapshots and display-only territory refreshes. At heuristic leaves it can also omit a next-player auto-skip scan that does not affect F. Non-leaf transitions keep actual turn normalization so the optimization preserves the searched tree’s meaning.',
  ]),
  chapter('mcts', 'MCTS 与神经搜索的区别', 'MCTS versus neural search', [
    '仓库中的普通 MCTSAI 实现“选择—扩展—随机模拟—回传”：在树中用平均回报加探索项选择分支，展开尚未访问的动作，再随机推演到终局或深度上限，把结果累计到沿途节点。UCT 探索项与 sqrt(log(父访问数)/子访问数) 成正比，让冷门分支也有被尝试的机会。',
    '该普通实现默认 64 次模拟、随机推演深度 40、探索系数 sqrt(2)，用带种子的伪随机数复现实验；未到终局的模拟以 tanh(F/100) 估值。它是代码里保留的算法实现，不代表当前小程序菜单另有一个独立“普通 MCTS”选项。',
    'CNN、Grid GNN、Topology GNN 使用的则是 NeuralPUCTAI：网络给出动作先验和局面价值，PUCT 根据先验分配搜索次数。两者都有树搜索与回传，但 PUCT 不是把神经网络当随机落子的别名，也不能把 16 次神经模拟与 64 次随机模拟直接当作相同算力或棋力。',
  ], [
    'The repository’s plain MCTSAI implements selection, expansion, random rollout and backpropagation. A mean return plus an exploration bonus selects a branch; an unvisited action is expanded; random play continues until termination or a depth limit; returns update the visited path. Its UCT bonus is proportional to sqrt(log(parent visits)/child visits).',
    'Defaults are 64 simulations, rollout depth 40 and exploration coefficient sqrt(2), with a seeded pseudo-random generator. A nonterminal cutoff uses tanh(F/100). This is an implementation retained in the codebase, not evidence of a separate plain-MCTS option in the current Mini Game menu.',
    'CNN, Grid GNN and Topology GNN instead use NeuralPUCTAI. A network provides action priors and position values, and PUCT allocates visits using those priors. Both methods search and backpropagate, but 16 neural simulations and 64 random simulations are not equivalent measures of compute or strength.',
  ]),
  chapter('networks', 'CNN、Grid GNN、Topology GNN', 'CNN and the two GNNs', [
    '研究模型每个格点使用 11 个特征：空点、己方节点、己方线点、敌方节点、敌方线点、归一化 x、归一化 y、边界标记、己方起点、敌方起点、连续跳过计数。视角始终相对于当前行动方。真实引擎另外生成合法动作掩码；历史全集并没有塞进这 11 个通道。',
    'CNN 将三角棋盘放进带无效区域的方形张量，经过输入投影和 3×3 卷积残差块，读取有效格点的隐藏表示。Grid GNN 在六邻接网格图上传消息，对邻居表示取均值并线性变换，再与自身投影、残差和归一化组合。',
    'Topology GNN 使用三类关系：格点邻接、己方逻辑连接、敌方逻辑连接。它让长边关系直接参与消息传播，而不必全部依赖很多层局部卷积去间接传递。三种架构最后都有逐点策略头、全局池化后的 PASS 头与价值头；价值头用 tanh，策略 logits 经合法掩码和稳定 softmax 变成先验。',
    '相同棋盘特征可以对应不同历史，因此“网络输入”不等于完整的马尔可夫规则状态。合法掩码与推演仍依赖带完整历史的引擎。S01–S03 是不同训练种子的模型，D14 是较早的模型版本；模型名称、种子编号和参数数量都不自动证明棋力高低，跨尺寸与规则兼容也要看对应验证范围。',
  ], [
    'Research models use 11 features per lattice point: empty, own node, own line, enemy node, enemy line, normalized x and y, boundary flag, own start, enemy start and consecutive-pass count. Features are relative to the player to act. The real engine supplies a separate legal-action mask; these 11 channels do not contain the full history set.',
    'CNN places the triangle into a padded square tensor, applies an input projection and residual 3×3 convolution blocks, then reads valid point embeddings. Grid GNN passes messages on six-neighbor lattice adjacency, combining mean neighbor projections with self projections, residual connections and normalization.',
    'Topology GNN uses three relations: lattice adjacency, friendly logical links and enemy logical links. Long-link relations participate directly in message passing. All three architectures produce point-policy logits, a pooled PASS logit and a pooled tanh value. Legal masking and a stable softmax turn the action logits into priors.',
    'Identical board features can accompany different histories, so the network observation is not the complete Markov rule state. Masks and transitions still rely on an engine retaining history. S01–S03 identify training seeds; D14 identifies an earlier model lineage. Names, seed numbers and parameter counts do not establish playing strength or validated transfer to every size and ruleset.',
  ]),
  chapter('puct', 'PUCT 如何选下一手', 'How PUCT chooses a move', [
    '一次 PUCT 分析先展开根节点，得到每个合法动作的网络先验 P。选择子节点时计算 sign·Q+c·P·sqrt(max(1,N))/(1+n)：Q 是该子节点累计回报的平均值，N 是父访问次数，n 是子访问次数；sign 根据真实行动方把根玩家视角切换为对手视角。',
    '每次模拟都从完整根快照恢复，再沿树执行真实落子或跳过。首次到达未展开的非终局节点时运行网络，把当前玩家价值换成根玩家视角，回传到整条路径。若到达真正终局，强制调用规则引擎的精确领土更新，以胜、平、负的 +1、0、−1 回传。',
    '小程序当前的神经模型使用 16 次模拟、cPuct=1.5。搜索结束后主要按子节点访问次数选步，再以平均价值破同分。网络先验决定先查什么，访问数表示本次搜索把预算花在哪里；二者都不等同于经过统计校准的胜率。',
    '模型动作契约决定正常有落点时是否提供 PASS；没有落点时也需要正确处理跳过。所有输出最终仍要属于当前局面并通过执行时的合法性检查。PUCT 预算有限，不能当作穷举求解器。',
  ], [
    'PUCT expands the root to obtain network prior P for each legal action. Child selection uses sign·Q+c·P·sqrt(max(1,N))/(1+n), where Q is mean accumulated return, N is parent visits and n is child visits. The actual player to act determines the sign for the root-player perspective.',
    'Each simulation restores the full root snapshot and follows real placements or passes. Reaching a new nonterminal node triggers a network evaluation whose value is converted to the root perspective and backed up along the path. A true terminal node forces exact rule-engine territory scoring and backs up +1, 0 or −1 for win, draw or loss.',
    'The Mini Game currently uses 16 simulations and cPuct=1.5 for these neural models. Final ranking prioritizes visits, then mean value. Priors guide where to look; visits record where this search spent its budget. Neither quantity is a calibrated probability of winning.',
    'The model action contract controls voluntary PASS availability when placements exist, and no-placement positions still need pass handling. Results must belong to the current position and pass legality checks when executed. A limited PUCT budget is not exhaustive game solving.',
  ]),
  chapter('model-free', 'DQN、PPO、SAC、GAIL、GAN', 'Five learned policy families', [
    '这五类模型在手机上共享一条轻量推理路径。三角棋盘最多 120 个格点，每点 7 个特征：空、己方节点、己方线、敌方节点、敌方线、x、y。小棋盘填充到 120 点，再加入棋盘尺寸和连续跳过计数，共 842 维。网络是 842→512→512→121，隐藏层使用 ReLU；121 个输出为预留的动作空间。',
    'DQN 导出的动作头输出 Q 值；PPO、SAC、GAIL、GAN 导出策略 logits。当前推理器用真实引擎的合法点索引过滤，再做稳定 softmax 并排序，不在每次落子时执行反向传播。DQN 的 softmax(Q) 只是排序用的先验，不能解释为 Q 值天然就是概率。PPO、GAIL、GAN 资产还可带价值头，但这条直接选步路径没有用它做树搜索。',
    '训练思想上，DQN 用贝尔曼自举目标拟合动作价值；PPO 用优势与裁剪后的新旧策略比值限制更新；离散 SAC 用价值学习配合熵正则鼓励探索；GAIL 用专家与学习者状态动作的判别信号训练策略；这里的条件 GAN 模型学习从局面生成专家式动作分布。后两类当前资产的专家标注是 greedy-expert，不能写成来自人类大师。训练配置与检查点来源应查各自清单，不能由算法名推断训练效果。',
    '当前 ModelFreeAI 在同一合法 softmax 中保留落子与显式 PASS 槽，因此有合法落点时也可能首选主动 PASS。完整动作分布的 prior 和为 1，截取前几个候选后不保证仍为 1。产品 Worker 随后应用共享 PASS 检查；该运行时修正没有重训这些双人神经权重。',
  ], [
    'These five models share a lightweight on-device inference path. Up to 120 triangular-board points receive seven features each: empty, own node, own line, enemy node, enemy line, x and y. Smaller boards are padded to 120 points; board size and consecutive passes bring the vector to 842 dimensions. The network is 842→512→512→121 with ReLU hidden layers and a reserved action space.',
    'DQN exports Q values; PPO, SAC, GAIL and GAN export policy logits. The runtime obtains legal point indices from the real engine, applies stable softmax and ranks them. It performs no gradient update during a move. Softmax of DQN Q values is a ranking prior, not evidence that Q values are probabilities. PPO, GAIL and GAN assets can include a value head, but this direct-policy path does not use it for tree search.',
    'Their training ideas differ: DQN fits bootstrapped Bellman targets; PPO uses advantages and clipped policy ratios; discrete SAC combines value learning with entropy regularization; GAIL trains a policy from an expert-versus-learner state-action discriminator; the conditional GAN learns expert-like action distributions conditioned on a position. The current GAIL and GAN asset labels identify a greedy expert, not human masters. Actual training configurations and checkpoint lineage belong to their manifests, and names alone establish no strength claim.',
    'Current ModelFreeAI retains placements and an explicit PASS slot in the same legal softmax, so PASS can rank first while placements exist. Priors sum to one over the complete action distribution, but need not after a top-candidate slice. The product Worker then applies the shared PASS check. This runtime change does not retrain those two-player neural weights.',
  ]),
  chapter('terminal-training', '终局奖励下的继续训练', 'Continuation with terminal-only rewards', [
    '本次继续训练的对象是四个既有线性 parent：easy、three-v4 的线性基准、three-v1、hex-v1。继承的 16 个系数先除以原 temperature，再增加一个从 0 开始的 PASS 系数；新策略温度为 1。CNN、GNN 以及 DQN/PPO/SAC/GAIL/GAN 的神经权重不属于这次重训，固定深度 Minimax 也不是训练得到的模型。',
    '新协议仅在原生自然终局给予奖励 R=sign(己方面积−最大对手面积)+0.1×面积差/总点数+0.01×己方面积/总点数，折扣系数 gamma=1；所有非终局奖励为 0，没有中间面积增量或时长奖励。截断对局不产生终局回报或参数更新。梯度样本须有实际完成至少三层、覆盖两轮真实对手行动且全部合法根含 PASS 的精确 Minimax 分析；它只决定固定防守掩码与样本资格，不替代环境奖励。',
    '候选继续使用原生规则与完整历史；只有完成分析且防守掩码保留至少两个动作的选定状态才参与策略梯度，因此不能声称覆盖全部状态或尺寸。新覆盖仅用于 territory-v3，旧 v1/v2 证据与存档不改写。easy、three-v1、hex 的新 PASS 系数参与排序；three-v4 与困难路径保留原搜索并使用新落子系数，不把线性 PASS 分数混同于搜索价值。实际训练、独立评估、限定准入与发布分别由对应收据确认。',
  ], [
    'This continuation targets four existing linear parents: easy, the linear base of three-v4, three-v1 and hex-v1. The inherited 16 coefficients are divided by the original temperature, then a PASS coefficient starts at zero; the candidate uses temperature one. CNN/GNN and DQN/PPO/SAC/GAIL/GAN neural weights are not retrained here. Fixed-depth Minimax is a search algorithm rather than a fitted model.',
    'The protocol gives reward only at a natural native terminal: R=sign(own area−maximum opponent area)+0.1×margin/point count+0.01×own area/point count, with gamma=1. Every nonterminal reward is zero, with no intermediate area-gain or duration reward. Truncated games produce no terminal return or parameter update. Gradient samples require actually completed exact Minimax of at least three plies, two actual opponent rounds and all legal roots including PASS. That analysis controls a fixed defensive mask and eligibility, not the environment reward.',
    'Candidates retain native rules and full history. Only selected states with completed analysis and at least two defensively allowed actions contribute policy gradients; this does not establish uniform state or size coverage. New overlays apply only to territory-v3 and preserve historical v1/v2 evidence and saved games. Easy/three-v1/hex use the learned PASS coefficient in ranking. Three-v4 and Hard retain their original search with trained placement coefficients, without comparing linear PASS logits to search values. Training, independent evaluation, scoped admission and release each require their own receipts.',
  ]),
  chapter('multi-policy', '多人策略的 16 个特征', 'Multiplayer policy features', [
    '三人 V1、V2 与六边形 V1 首先对每个真实合法候选试走一手，比较动作前后的棋盘，再提取 16 维特征。特征是己方节点、覆盖、可达空间；这三项相对最强对手的领先量；清除的敌方节点与覆盖；自身节点与覆盖增量；切线标记；落在己方线上的标记；离起点距离；中心程度；己方前沿空点数；相对对手的前沿领先量。',
    '数量按棋盘总点数归一化，距离与中心性使用相应棋盘几何。模型用 score=(w·features)/temperature 排序，再以 softmax 得到 prior。同分时用固定坐标顺序保证可复现。这里既有训练得到的权重，又有人工定义的特征；它不是 CNN，也不是把双人模型随便换个颜色就变成六人模型。',
    '三人及更多人的对局不能直接套用“双人零和”的结论。多人特征把自己与最强对手比较，也统计所有对手损失；某次切断可能帮到第三方。因此选择不同的对手模型或后续推演方法，会改变推荐行动。小程序按人数、形状、边长筛选策略，V2 和六边形搜索 V5 保留实验标记。',
  ], [
    'Three-player V1/V2 and hexagonal V1 trial each genuinely legal placement and compute 16 features from before-and-after positions: own nodes, coverage and reach; leads over the strongest opponent for those three metrics; captured enemy nodes and coverage; own node and coverage gains; attack flag; own-line placement flag; distance from home; centrality; own empty frontier; and frontier lead over opponents.',
    'Counts are normalized by board size, while distance and centrality use the appropriate geometry. The policy ranks score=(w·features)/temperature, then softmax produces priors. Coordinate order resolves ties reproducibly. This combines trained weights with hand-designed features; it is not a CNN or merely a recolored two-player network.',
    'Games with three or more players do not inherit two-player zero-sum conclusions. Features compare the player with the strongest opponent and aggregate opponents’ losses; a cut can benefit a third party. Different response policies and continuation models can therefore produce different recommendations. Mini Game compatibility filters use player count, shape and size; V2 and hex search V5 retain experimental labels.',
  ]),
  chapter('three-search', '三人 V4：候选与推演', 'Three-player V4 rollouts', [
    'three-player-search-v4-round12 在三角三人局中先用线性策略选出前三个根候选，再分别假设其他玩家遵循 V1 或 V2 策略。根玩家后续按自己的基准策略行动；每条分支在根动作之后继续最多 12 个行动层，或提前到达终局。候选不足三个就只检查实际数量，只有一个时直接返回。',
    '每个叶子都计算精确离散领土。非终局强度为 area+0.3×coverage+0.05×reach，经温度为 0.12×棋盘点数的 softmax 得到相对偏好；终局则按最高领土给领先者分配 1/并列人数，其余为 0。另记录与最强对手的领土差。两种对手假设下的分数求平均，再按领土差、基准分和坐标破同分。',
    '如果搜索首选比原基准首选的平均分提高不到 0.02，就保留原首选，避免微小波动改变决策。当前小程序 V4 入口支持边长 5、7、9；其他尺寸使用兼容列表中的策略。这里的平均是对所选两种对手策略的平均，不是对全部可能对手的保证，也不是一次完整的三人均衡求解。',
  ], [
    'three-player-search-v4-round12 shortlists the top three linear-policy root moves on a three-player triangle. It evaluates each under V1 and V2 opponent-response policies. The root player continues with its base policy, and each branch runs for up to 12 further action plies after the root move or stops at termination. Fewer candidates mean fewer trials; a single candidate returns directly.',
    'Every leaf computes exact discrete territory. Nonterminal strength is area+0.3×coverage+0.05×reach, converted to relative preferences with softmax temperature 0.12 times the board-point count. Terminal leaders receive 1 divided by the number of tied leaders; others receive zero. Territory margin over the strongest opponent is also recorded. Results are averaged over the two response models, with margin, base score and coordinates breaking ties.',
    'If the best search result improves on the original base choice by less than 0.02, the base choice remains first. The Mini Game V4 entry supports sizes 5, 7 and 9; other sizes use compatible listed policies. Averaging two response models is not a guarantee against all opponents or a solved three-player equilibrium.',
  ]),
  chapter('hex-search', '六边形 V5：战术复核', 'Hexagonal V5 tactical checks', [
    'hex-player-search-v5 是可选实验搜索，面向六边形 4–6 人、边长 5 或 7。它先用 V1 权重排序，只在与首选分差不超过 0.4 的候选中保留至多两个。合法点不超过 6，或候选涉及吃子、切线、覆盖增长至少 3 点等战术条件时，才启动复核；安静局面或首选明显时沿用基础策略。',
    '每个根候选试走后，让后续对手按 V1 依次应对，最多 5 个行动层；轮回根玩家、终局或同一对手再次出现时停止。行动顺序读取真实引擎，不能假定六个人始终都还有合法点或都没有认输。',
    '非终局叶子用 0.7×reach+0.3×coverage 衡量强度；因为 reach 包含已占格点，它也等于 coverage+0.7×可达空点。再以 0.15×棋盘点数为温度做 softmax。这是快速偏好，不是正式领土或校准胜率。终局叶子才强制计算精确 area。',
    '候选比较先区分已确认的模拟胜局、未终局分支、已确认的模拟败局，再比较各自值；普通改选还需要至少 0.03 的改善。这样不会把启发式 0.9 误当成比真实终局胜利更可靠。但“确认”只针对该条 V1 应对分支，不代表已经防住所有其他走法。',
  ], [
    'hex-player-search-v5 is an optional experimental search for 4–6-player hexagons of size 5 or 7. V1 weights rank candidates; at most two remain within 0.4 of the best base score. Search is triggered by at most six legal moves or tactical features such as captures, cuts or coverage gain of at least three points. Quiet positions and clear base choices retain the base policy.',
    'After each candidate root move, opponents respond with V1 for at most five action plies. The rollout stops at termination, return to the root player or a repeated opponent turn. The actual engine determines rotation, including unavailable moves and resignations.',
    'Nonterminal strength is 0.7×reach+0.3×coverage. Since reach includes occupied points, this equals coverage+0.7×reachable empty points. Softmax temperature is 0.15 times the board-point count. This is a fast preference, not official territory or calibrated win probability. Only terminal leaves force exact area scoring.',
    'Comparison first distinguishes simulated confirmed wins, unfinished branches and simulated confirmed losses, then compares values within those categories. Ordinary nonterminal changes require an improvement of at least 0.03. A heuristic 0.9 therefore cannot displace a terminal win merely through numerical scale. Confirmation is conditional on the V1 responses simulated, not every possible opponent reply.',
  ]),
  chapter('new-multiplayer', '后续多人 AI 与搜索', 'Later multiplayer AI paths', [
    '后续 Web 开发实现又加入简单、中等、困难和终极候选四类入口。简单使用训练过的 16 特征线性策略；中等复用三人 V4 或六边形 V1，并加速等价的候选与特征计算；原生形状的困难使用对手各自按自身策略行动的 rollout。这些新路径与小程序当前的 V1、V2、V4、V5 菜单要分开看，写进本文不代表已全部装入你手机里的版本。',
    '困难 rollout 使用约 650 毫秒的搜索预算，按 12、24 层逐阶段推进；枚举根合法点并包含主动 PASS。每个阶段必须在同一对手策略与同一深度下完成全部根候选的比较，才发布新的选择。预算用尽时丢弃未完成阶段，保留最近完整阶段或原策略结果；一次同步规则操作也可能使实际耗时超过预算目标。',
    '这条后续 rollout 的叶子重新调用正式领土计算，结合覆盖、可达空间形成非终局偏好。对手按自己的策略选择动作，不假定所有人合谋压低根玩家的分数。非默认形状另有 MultiplayerMinimaxAI：使用保守的 paranoid 假设，把所有其他行动方视为 MIN，带 α–β、主动 PASS、迭代加深和完整阶段回退；其非终局评价是相对节点、覆盖与可达优势，终局使用精确领土。两种对手假设各有局限。',
    '终极候选先用迁移的 GNN 产生根动作先验，再引导 12、24、36 层的 rollout；推理耗时计入同一预算。多人编码把所有对手节点、线点和起点汇总到相对特征，Topology GNN 的敌方关系也合并各对手边集；这能看见所有敌方结构，却不会显式区分每个对手的联盟身份。',
    '截至本文核对的 2026-10-22 源码，终极候选的 Web 可用开关仍为关闭，运行器标记为 application-candidate。已存在网络代码、训练权重或本地校验，不等于候选已获准上线、已移植到小程序或已证明比其他 AI 更强。后续新增策略应继续记录模型身份、真实动作范围、预算、叶子评价与适用局面。',
  ], [
    'Later Web development adds easy, medium, hard and ultimate-candidate paths. Easy uses a trained 16-feature linear policy. Medium reuses three-player V4 or hexagonal V1 with equivalent candidate/feature acceleration. Hard on native shapes uses selfish-policy rollouts. These paths are distinct from the Mini Game’s current V1, V2, V4 and V5 choices; inclusion in this article does not install them on a phone.',
    'Hard rollout targets about 650 ms and progressively evaluates 12- and 24-ply horizons, including all legal root placements and voluntary PASS. A decision is published only after every root candidate completes the same response-policy and horizon comparison. Timeout discards the incomplete phase and retains the latest complete phase or base-policy fallback. A synchronous rule operation can still overshoot the target duration.',
    'These later rollouts recompute canonical territory at leaves and combine it with coverage and reach for nonterminal preferences. Opponents follow their own policy rather than jointly minimizing the root player. Non-default shapes also have MultiplayerMinimaxAI, which uses the conservative paranoid assumption: all other players are MIN. It includes alpha–beta, voluntary PASS, iterative deepening and complete-iteration fallback. Nonterminal evaluation uses relative nodes, coverage and reach; terminal scoring uses exact territory. Neither opponent model is universally correct.',
    'The ultimate candidate obtains root priors from a transferred GNN, then guides 12-, 24- and 36-ply rollouts within the remaining time budget. Multiplayer features pool all enemy nodes, lines and starts; Topology GNN unions opponent edge relations. This includes every opponent structure but does not explicitly distinguish individual opponents’ alliance identities.',
    'In the source inspected on 2026-10-22, the Web availability switch for the ultimate candidate remains off and the runtime identifies it as application-candidate. Existing code, weights or local checks do not establish release, Mini Game integration or superior strength. Future policies should retain explicit model identity, action support, budgets, leaf evaluation and compatibility records.',
  ]),
  chapter('workers', 'AI、提示与复盘的调度', 'AI, hints and replay workers', [
    '小程序把 AI、提示、领土与复盘任务放进同一个 Worker 调度队列。请求按优先级和请求编号串行处理，避免同时创建多个普通 Worker。返回值必须匹配请求编号和完整上下文；新局、悔棋、切换复盘或取消任务后，旧 Worker 的迟到结果会被丢弃。',
    '当前调度器默认 15 秒超时。超时、Worker 异常或进程被系统结束时，解绑并终止该 Worker，向会话报告失败，保留可恢复棋局并允许重试。后台搜索不能堵住 Canvas 的触摸与绘制，也不能把失败偷偷改成另一个 AI 的成功。',
    'Worker 内恢复局面时可缓存同一配置、同一动作前缀的引擎，只补放新增动作；任一前缀或配置不匹配就重新恢复。缓存必须保留完整历史，异步模型加载期间的引擎也不能被后来的请求修改。AI 选步、提示和复盘分析复用同一种算法；普通选步返回首选，分析可返回前三个候选及其评分含义。',
    '执行前再次核对局面身份与行动方，并让真实引擎验证落点。Web 有独立 AI／提示／领土 Worker 的组织方式，小程序采用单队列适配；两端共享规则，不意味着线程数量和调度代码必须相同。',
  ], [
    'The Mini Game serializes AI, hint, territory and replay work through one Worker queue, ordered by priority and request ID. Responses must match both ID and the full request context. Restarting, undoing, changing replay position or cancelling work invalidates late results from the old Worker.',
    'The scheduler defaults to a 15-second timeout. Timeouts, Worker errors and process-killed notifications detach and terminate that Worker and report failure to the session, which preserves recoverable game state and supports retry. Computation must not block Canvas interaction or silently substitute another AI after failure.',
    'The Worker can reuse a restored engine only when configuration and the entire existing action prefix match, replaying just the added suffix. Otherwise it restores from scratch. History remains intact, and a later request cannot mutate an engine leased to asynchronous model loading. AI play, hints and replay analysis share the strategy implementation; analysis can return the top three candidates and a metric label.',
    'Before execution, the session checks position identity and player again, and the real engine validates the move. Web can organize separate AI, hint and territory Workers while the Mini Game uses one queue. Sharing rules does not require identical thread organization.',
  ]),
  chapter('integrity', '模型、存档与复现', 'Models, saves and reproducibility', [
    '模型加载先检查清单中的 ID、规则、人数、棋盘范围、张量名称、维度、偏移和权重长度，再检查数值有限性与资产完整性。小程序分包提供双人二进制模型，小型多人 JSON 策略嵌入 Worker；它们都要绑定到明确的模型身份，不能因为文件名类似就混用权重。',
    '普通对局只做推理，不在手机上训练网络。允许“帮 AI 学下棋”收集完整对局，也不意味着本局落子会立刻修改当前模型。离线训练、候选评估、实际选用和发布是不同步骤；研究训练环境、Web 和小程序也必须分别核对规则版本，不能只看名字都叫 LIFELINE。',
    '存档与棋谱保存配置和动作；恢复时通过同一规则引擎重放，重建节点、边、历史和轮转。导入先在隔离局面中校验，成功后才替换正在看的棋局。悔棋、复盘试走和 AI 搜索同样需要完整恢复，不能只把棋子颜色画回去。',
    '要复现一次 AI 决策，至少记录规则版本、棋盘配置、完整动作或规则状态与历史、行动方、模型 ID／资产哈希、搜索参数和随机种子（若使用随机算法）。截图可用于解释面积，却不足以复现所有合法性和选步；固定时间预算的搜索还可能随设备速度停在不同的完整阶段。',
  ], [
    'Loading checks model ID, rules, player count, board compatibility, tensor names, dimensions, offsets, byte length, finite values and asset integrity. Binary two-player models arrive in Mini Game subpackages; small multiplayer JSON policies are embedded in the Worker. Each is bound to a specific identity rather than accepted through a similar filename.',
    'Ordinary games run inference, not on-phone training. Opting into complete-game contributions does not immediately update the model making the current move. Offline training, candidate evaluation, selection and release are separate steps. Research environments, Web and Mini Game also need explicit rules-version alignment.',
    'Saves and replay documents retain configuration and actions. The same rule engine replays them to reconstruct nodes, edges, history and turns. Imports validate in isolation before replacing the active view. Undo, replay branches and AI search need full restoration, not just repainting node colors.',
    'Reproducing a decision requires rules version, board configuration, complete actions or full state and history, player, model ID and asset hash, search parameters and any random seed. A screenshot can explain area but cannot reproduce all legality or decisions. Time-budgeted searches can also finish different complete phases on devices of different speed.',
  ]),
  chapter('theory', '数学边界与代码入口', 'Theory and source navigation', [
    '把完整规则状态与历史一起纳入状态后，固定对手策略可得到单方决策过程；多个玩家同时学习或策略改变时，更自然的对象是轮流行动的随机博弈。固定权重、规则与无随机推理时转移确定；随机起点和随机模拟必须另列随机来源。',
    '有限完全信息双人零和博弈可以讨论逆向归纳与极小极大值，但这不提供高效求解算法，也不证明先手必胜。多人不是自动零和。表示状态的位数上界、实际可达状态数、合法历史数、博弈树大小与计算复杂度定理是不同对象；本文的实现细节不能替代这些定理的证明。',
    '源码阅读顺序建议为：GameEngine 的 _addNode、_connectAllCrawl、_getOpponentConnectedPieces、_computeStateHash，再读 _computeRawTerritory 和 _getCoveredPoints；随后读 AIEngine 的 evaluate 与 MinimaxAI、ResearchAI 的编码和 NeuralPUCTAI、ModelFreeAI 的直接推理，以及 ThreePlayerSearchAI、HexFastSearchAI 和后续 Multiplayer 模块。',
    '这些模块的共同妙处，是让“规则允许什么”“如何估计一步的好坏”“最终按什么判胜负”和“怎样让手机及时显示结果”各自有明确职责，再通过完整状态和真实引擎连接起来。优化其中一层时，才有办法检查它是否改变了另一层的含义。',
  ], [
    'With complete rule state and history, a fixed opponent policy yields a single-agent decision process. When multiple players learn or change strategy, a turn-based stochastic-game formulation is more appropriate. Fixed weights and deterministic inference give deterministic transitions; randomized starts and simulations are separate randomness sources.',
    'Finite perfect-information two-player zero-sum games admit backward-induction and minimax analysis, but that supplies neither an efficient solver nor proof of a first-player win. Multiplayer is not automatically zero-sum. Representation-size bounds, reachable states, legal histories, game-tree size and formal complexity results are different objects; implementation details do not prove those theorems.',
    'A useful reading order is GameEngine’s _addNode, _connectAllCrawl, _getOpponentConnectedPieces and _computeStateHash, then _computeRawTerritory and _getCoveredPoints. Continue with AIEngine’s evaluate and MinimaxAI, ResearchAI’s encoding and NeuralPUCTAI, ModelFreeAI’s direct inference, and ThreePlayerSearchAI, HexFastSearchAI and the later Multiplayer modules.',
    'The architectural benefit is a clear separation of allowed actions, move-quality estimates, official settlement and responsive display, connected by complete state and the real engine. That separation makes it possible to ask whether an optimization in one layer changes the meaning of another.',
  ]),
];
