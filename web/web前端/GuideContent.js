const WHY_TALK_ZH = `# Talk：扩张、防守与破绽

最高指挥官，这个游戏真正抓人的地方，不是“谁占的点更多”，而是每一次扩张都会改变自己的脆弱面。三角棋盘像一条从狭窄前线展开到广阔纵深的战场：靠近大本营，补给短、结构稳；推进到中央，空间变大，防线也被拉长。

> 越想扩张，防线越长，越容易被切开；越想防守，空间越小，越容易被围死。

这是第一组矛盾。扩张带来领土，也带来更长的边界、更薄的连接、更显眼的桥。防守看似稳健，却会把自己压回基点附近，让对手取得外线、压缩你的回旋空间。苏德战场式的张力就在这里：广阔纵深不是免费的，狭窄防线也不是安全的终局。

> 越想快速扩张，就越必须暴露线；越想完全不露破绽，规则又不允许你凭空获得效率。

这是第二组矛盾。棋子之间的线不是装饰，而是补给线，也是对手可以切入的目标。你若追求速度，就会留下尚未闭合的长线、桥点和割点；你若追求完美闭合，又会因为三点限制、可见性规则和落子顺序而付出效率。规则逼迫玩家承认：不存在既高速扩张、又完全无破绽的形状。

## 直觉核心

* 扩张与溃败绑定。多一个节点可能扩大领土，也可能把整条战线变成可被切断的长桥。
* 防守与窒息绑定。退回基点附近可以降低暴露面，但会把战略纵深交给对手。
* 速度与完整性绑定。快速铺开必然留下线，慢速补形又会损失先机。
* 进攻的本质不是吃子，而是切断基点连通性。真正被消灭的不是一个点，而是一整段失去补给的结构。

所以，这个游戏不是单纯的占点竞赛。它要求玩家在效率、闭合、桥、割点、战线长度和后续空间之间寻找均衡。妙处不在规则复杂，而在规则把所有逃避都封死了：你必须扩张，也必须暴露；你必须防守，也必须留下空间。`;

const WHY_CODE_ZH = `# Code：物理与逻辑的优雅分离

工程实现的关键不是把棋盘画出来，而是承认棋盘有两层事实。

* 物理层是 \`grid\`：每个格点现在显示为空、节点或线点。
* 逻辑层是 \`adj_list / edges\`：哪些节点之间真的存在可见性边。

这两层必须分开。渲染只需要 \`grid\`；连通性判断必须查询逻辑边；攻击结算则先改变物理层，再清理和重建逻辑层。

\`\`\`python
# 物理层：负责渲染和占用状态
grid: dict[tuple[int, int], PointState]

# 逻辑层：负责图论连通性
black_edges: set[frozenset[tuple[int, int]]]
white_edges: set[frozenset[tuple[int, int]]]

def is_connected_to_initial(pos, player):
    adj_list = build_adj_list(edges[player])
    return bfs(adj_list, start=initial[player], target=pos)
\`\`\`

## 攻击结算

一次落在敌方线点上的行动不是简单“覆盖格子”。它会触发一个确定的图重写流程。

\`\`\`python
def handle_attack(pos, player):
    delete_enemy_line_cells_from(pos)
    alive = bfs_component_from_enemy_base(grid)
    remove_every_enemy_piece_not_in(alive)
    edges[enemy].clear()
    reconnect_player_nodes(player)
    reconnect_player_nodes(enemy)
\`\`\`

这里的美感在于职责清晰：\`grid\` 记录物理事实，\`edges\` 记录逻辑事实，BFS 只回答一个问题：某个部分是否仍然连回基点。

## 领土计算

领土不是靠浮点几何射线判断，而是靠离散泛洪。

\`\`\`python
def covered_points(polygon):
    wall = set(polygon)
    water = flood_fill_from_board_boundary(blocked=wall)
    return all_grid_points - water
\`\`\`

当前前端引擎还做了楔形泛洪优化：当一条候选捷径位于当前领土内部时，只对被替换的楔形区域做一次泛洪，再用整数公式更新候选面积。后端也保持同一逻辑，避免文档和生产规则分裂。`;

const WHY_THEORY_ZH = `# Theory：算力深渊与上帝的简洁逻辑

这个游戏的理论核心不是“状态数比谁大”，而是一个更干净的错位：

$$
V(n)=\frac{n(n+1)}{2}=\Theta(n^2)
$$

但潜在长程可见性边为

$$
E(n)=3\sum_{k=1}^{n}\binom{k}{2}
=\frac{n^3-n}{2}
=\Theta(n^3).
$$

棋盘是二次规模，战术关系是三次规模。复杂度不是堆出来的，而是从视线边自然长出来的。

## 状态空间

语义位置只统计真正不同的棋盘局面：

$$
S_{\mathrm{pos}}(n)\le 2\cdot 5^{V(n)}
=2^{\Theta(n^2)}.
$$

如果把显式边缓存也算进表示对象，则有

$$
S_{\mathrm{repr}}(n)
\le 2\cdot 5^{V(n)}3^{E(n)}
=2^{\Theta(n^3)}.
$$

这两个量不能混淆。前者是游戏局面，后者是实现表示。真正困难的地方不是吹大状态数，而是二次格点承载了三次长程边。

## Superko

Superko 不是让普通位置图自动无环。更准确地说，规则把状态提升为

$$
(s,H),
$$

其中 $H$ 是历史位置集合。合法转移满足

$$
(s,H)\to(s',H\cup\{s'\}),\qquad s'\notin H.
$$

秩函数

$$
\rho(s,H)=|H|
$$

在每一步严格增加，所以增广状态转移图是 DAG。

## AI 含义

CNN 擅长局部纹理，但这里的价值来自基点连通性、桥、割点和极大连通分量。两个局部图案相同的盘面，只要一方少一条备用路径，价值就可能完全相反。因此更自然的模型是 GNN：把格点、可见性边、基点、桥与割点作为图对象输入，让消息沿逻辑边传播。`;

const WHY_TALK_EN = `# Talk: Expansion, Defense, and Exposure

Commander, the central question is not who occupies more points. It is how each expansion changes the shape of your own vulnerability. The triangular board opens from a narrow home front into a wide field: near the base, supply is short and stable; toward the center, space grows, but the front stretches.

> The more you expand, the longer your line becomes, and the easier it is to cut. The more you defend, the less space you keep, and the easier it is to be boxed in.

That is the first contradiction. Expansion gives territory, but also creates longer borders, thinner connections, and visible bridges. Defense looks stable, but it pushes you back toward the base and hands the outside line to the opponent.

> The faster you expand, the more lines you expose. The more you try to hide every weakness, the more efficiency the rules force you to lose.

That is the second contradiction. Lines are not decoration. They are supply routes, and therefore attack targets. If you expand quickly, you leave unfinished long lines, bridges, and articulation points. If you insist on perfect closure, the triangle restriction, visibility rule, and move order make you pay in tempo.

## Intuition

* Expansion and collapse are linked. A new node can enlarge territory or turn the whole front into a cuttable bridge.
* Defense and suffocation are linked. Staying near the base reduces exposure but gives away strategic depth.
* Speed and completeness are linked. Fast growth exposes lines; slow repair loses initiative.
* Attacks do not merely capture pieces. They sever connectivity to the base.

The game is not a simple occupation race. It asks the player to balance efficiency, closure, bridges, articulation points, frontage, and future space.`;

const WHY_CODE_EN = `# Code: Separating Physics from Logic

The implementation works because it keeps two facts separate.

* The physical layer is \`grid\`: what each lattice point currently displays.
* The logical layer is \`adj_list / edges\`: which nodes are truly connected by visibility edges.

\`\`\`python
# Physical layer: rendering and occupancy
grid: dict[tuple[int, int], PointState]

# Logical layer: graph connectivity
black_edges: set[frozenset[tuple[int, int]]]
white_edges: set[frozenset[tuple[int, int]]]

def is_connected_to_initial(pos, player):
    adj_list = build_adj_list(edges[player])
    return bfs(adj_list, start=initial[player], target=pos)
\`\`\`

## Attack Resolution

\`\`\`python
def handle_attack(pos, player):
    delete_enemy_line_cells_from(pos)
    alive = bfs_component_from_enemy_base(grid)
    remove_every_enemy_piece_not_in(alive)
    edges[enemy].clear()
    reconnect_player_nodes(player)
    reconnect_player_nodes(enemy)
\`\`\`

The elegance is that \`grid\` records physical facts, \`edges\` records logical facts, and BFS answers one question: does this structure still connect to its base?

## Territory

\`\`\`python
def covered_points(polygon):
    wall = set(polygon)
    water = flood_fill_from_board_boundary(blocked=wall)
    return all_grid_points - water
\`\`\`

The engine also uses a wedge flood-fill optimization: when a shortcut lies inside the current territory, it flood-fills the replaced wedge once and updates candidate area with an integer formula.`;

const WHY_THEORY_EN = `# Theory: A Simple Law, a Deep Search Space

The point is not to inflate state counts. The clean fact is the mismatch:

$$
V(n)=\frac{n(n+1)}{2}=\Theta(n^2)
$$

but the potential long-range visibility edges satisfy

$$
E(n)=3\sum_{k=1}^{n}\binom{k}{2}
=\frac{n^3-n}{2}
=\Theta(n^3).
$$

The board is quadratic. The tactical relation graph is cubic.

## State Space

Semantic positions satisfy

$$
S_{\mathrm{pos}}(n)\le 2\cdot 5^{V(n)}
=2^{\Theta(n^2)}.
$$

Explicit representation space, if edge caches are counted, satisfies

$$
S_{\mathrm{repr}}(n)
\le 2\cdot 5^{V(n)}3^{E(n)}
=2^{\Theta(n^3)}.
$$

These are not the same object. One counts game positions; the other counts implementation encodings.

## Superko

Superko lifts the state to

$$
(s,H),
$$

where $H$ is the set of previous positions. Legal transitions satisfy

$$
(s,H)\to(s',H\cup\{s'\}),\qquad s'\notin H.
$$

The rank

$$
\rho(s,H)=|H|
$$

strictly increases, so the augmented transition graph is a DAG.

## AI Consequence

CNNs see local texture. This game is valued by base connectivity, bridges, articulation points, and maximal connected components. A GNN is the more natural architecture because messages can flow along the same visibility graph that defines the rules.`;

const GUIDE_MARKDOWN = Object.freeze({
  zh: Object.freeze({
    rulesEssential: `【胜利条件】
双方轮流在三角网格落子，最终由己方节点与连线完全闭合且内部无敌方元素的区域即为领土，领土所包含的网格点数多者获胜。
![可落子区域示意](./guide-images/可以走的区域png.png)

【核心机制】
相邻且无遮挡的己方节点会自动连线，盘面上所有的节点与连线必须与己方初始点保持物理连通。玩家可落子于敌方连线上将其切断，一旦连线断裂导致敌方部分节点或连线失去与初始点的连通路径，这些断联的元素将立即从棋盘上彻底清除。
![切断示意一](./guide-images/切断1.png)
![切断示意二](./guide-images/切断2.png)

【限制规则】
为保证博弈的平衡与推进，游戏设定了三项强制约束。首先是起步保护，靠近初始点的两个相邻位置绝对禁止敌方落子。
![起点限制示意](./guide-images/起点限制.png)

其次是阵型限制，禁止主动形成三个节点互相紧挨的最小三角形阵型，除非该次落子直接切断了敌方的连线。
![三点限制示意](./guide-images/三点限制.png)

最后是同形禁手，禁止任何会使全局节点与连线状态恢复至历史重复局面的落子，以防止双方陷入无限互相切断的死循环`,
    rulesWar: `最高指挥官，欢迎来到这片由点与线交织的三角阵地。

常言道，兵马未动，粮草先行。在这片残酷的战场上，如果你前方的部队失去了和总基地的联系，就会因为断水断粮而直接在棋盘上溃散消失。这是你在接下来的指挥中最需要牢记的铁律。

仔细观察你眼前的这片三角战场，它形似二战时期的苏德战场，从狭窄的波德平原一路向广阔的东欧平原延伸。这种特殊的地形里隐藏着这场战争最本质的战略张力：越靠近你的大本营，战线越窄，虽然极易防守，但你能掌控的领土也十分可怜；而越向战场中央挺进，天地越广阔，圈占的领土越大，但拉长的防线也会暴露出致命的破绽。你越想激进进攻，破绽就越多；越想保守防御，就越容易被对方死死围住。是稳扎稳打，还是狂飙突进，全在你的一念之间。

为了防止总司令部一开局就被敌方的闪电战彻底封锁，你的大本营周围驻扎着极其强大的禁卫军。敌方绝对无法在你大本营最靠近的区域落子，有了这层绝对的保护，你可以安心地从这里向外发兵。
![起点限制示意](./guide-images/起点限制.png)

随着战役打响，你需要和敌军轮流派出士兵，占据新的网格点。只要视线不被阻挡，你的新兵就会和原有的部队自动拉起一条相互呼应的补给线。
![可落子区域示意](./guide-images/可以走的区域png.png)

你的终极目标是尽可能扩大你的安全领土。在这片战场上，领土就是由你的士兵和补给线完完全全包围起来的区域。为了减轻前线的防御压力，我们聪明的参谋部会自动为你规划出最精简的防线。这条防线会尽可能缩短周长、减少多余的防守面积，但一定会把你所有的部队都安全地保护在内，并且保证圈进来的地盘里绝对没有任何敌军的影子。

在这场鏖战中，战备资源十分紧张。为了避免兵力浪费，你不能把三个士兵紧挨着挤在一个小三角里。
![三点限制示意](./guide-images/三点限制.png)

但是战场瞬息万变，如果你这一步是直接踩在敌军的补给线上，狠狠切断了他们的粮草，那就相当于抢夺了敌方的物资。这说明该地段战况极其激烈，此时你就可以打破常规，不受不能拥挤的限制，大举集结兵力发起猛攻。
![切断示意一](./guide-images/切断1.png)
![切断示意二](./guide-images/切断2.png)

当所有的硝烟散去，双方都无兵可派、无地可占时，谁圈出的领土面积更大，谁就是这场战争真正的赢家。去吧，指挥官，愿你的防线坚不可摧。`,
    rulesMath: `# 离散数学与强化学习视角：三角圈地博弈的形式化定义与理论分析

本文档旨在从离散数学中的图论、组合博弈论（CGT）以及强化学习的视角，对本博弈游戏进行严谨的数学定义、模型构建与复杂性评估。

## 一、组合博弈论属性、策梅洛定理与迫移局面

本游戏是一个**双人、有限步数、完备信息、确定性（无随机因素）的零和博弈**。

根据组合博弈论中的策梅洛定理（Zermelo's Theorem），满足上述条件的有限博弈必然存在纯策略的纳什均衡。这意味着在完美算力下，必定存在确定的最优策略。

然而，在经典的对称博弈中，增加己方棋子永远能带来严格的正向收益，理论上先手方可以通过随便落子并假装自己是后手，从而完成“策略窃取（Strategy Stealing）”，这在逻辑上排除了后手必胜的可能。但在本博弈模型中，这种经典证明被彻底摧毁。由于引入了动态拓扑解绑与防拥挤约束，额外增加一个节点极有可能成为敌方发起切割攻击的物理跳板，或者不慎堵死己方后续的布阵空间。这意味着在特定盘面下，落子不仅无法产生收益，反而会帮倒忙。由于玩家无法放弃行动回合，系统极易陷入被迫落子从而破坏自身完美防线的状态，即博弈论中经典的**迫移局面（Zugzwang）**。
![三点限制示意](./guide-images/三点限制.png)

迫移局面的客观存在，使得后手方具备了通过精准诱导实现反杀的理论可能。这不仅彻底瓦解了试图建立“先手无脑必不败”的粗暴证明，更赋予了游戏极深的反击战术维度，使得博弈树的分支因子和状态价值评估呈现出高度的非线性。寻找理论最优解因此成为一个计算复杂性极高的问题，非常适合作为深度强化学习的研究环境。

## 二、状态空间的图论建模（Graph Representation）

游戏的物理基底是一个有限的离散点集，由边长为 $N$ 的三角网格的所有坐标构成，记为全局顶点集 $V_{grid}$。在任意离散时间步 $t$，游戏的全局状态可被严谨地定义为一张带色彩属性的无向图 $S_t = \\langle G_t, C_t \\rangle$，其中：

* $G_t = (V_t, E_t)$，$V_t \\subseteq V_{grid}$ 为当前棋盘上存活的节点集合，$E_t$ 为节点间通过直线规则生成的边集合。
* $C_t: V_t \\cup E_t \\rightarrow \\{Black, White\\}$ 为特征函数，映射点与边的阵营归属。

【图论连通性公理】
图 $G_t$ 中存在两个特殊的固定基点 $v_{black}^* = (0,0)$ 与 $v_{white}^* = (N-1,0)$。对于任意时刻 $t$ 的任意同色子图 $G^{color}_t$，其包含的所有顶点和边，必须在图论意义上与对应的基点 $v_{color}^*$ 属于同一个连通分量。
![起点限制示意](./guide-images/起点限制.png)

## 三、动作空间与图结构的动态演化

玩家的动作空间定义为在集合 $V_{grid} \\setminus V_t$ 中选择一个合法空顶点。系统状态的转移函数表现为对无向图 $G_t$ 的离散算子操作，严格按以下顺序执行：
![可落子区域示意](./guide-images/可以走的区域png.png)

1. 落子后，沿六个离散网格方向进行射线扫描，若遇到同色节点且无异色元素遮挡，则生成新边。
2. 若动作坐标正好落在敌方某条边的离散路径上，则该边会被永久删除，这会导致敌方图结构直接分裂。
![切断示意一](./guide-images/切断1.png)
3. 应用广度优先搜索，在敌方子图中寻找包含其基点的极大连通分量。所有不属于该连通分量的顶点与边都会因违背连通性公理而被剔除。
![切断示意二](./guide-images/切断2.png)

## 四、强化学习建模：回合制马尔可夫决策过程

为使现代强化学习算法能够求解该博弈，需将其抽象为一个马尔可夫决策过程 $\\mathcal{M} = \\langle \\mathcal{S}, \\mathcal{A}, \\mathcal{P}, \\mathcal{R} \\rangle$。

* 状态张量编码：系统状态可以被编码为一个多通道的二维特征矩阵集合，分别表示黑方节点特征、白方节点特征以及全局邻接矩阵。
* Superko 与 DAG 转移约束：为防止由于割边算子引发的循环博弈，引入基于图结构哈希的历史状态集 $H$。状态转移必须满足 $Hash(S_{t+1}) \\notin H$，从而保证单个 Episode 必然在有限步内到达终局状态。
* 稀疏奖励函数：游戏过程中的即时奖励为 0，仅在终局时调用泛洪注水算法计算各方最终圈地的离散格点基数，并给出最终奖励。`,
    whyTalk: WHY_TALK_ZH,
    whyCode: WHY_CODE_ZH,
    whyTheory: WHY_THEORY_ZH,
    whyThis: WHY_TALK_ZH,
    thanks: `创始人：zcz
愿景启发：Harmony（第一个帮我做出初始程序的人；没有 Harmony，这个游戏的程序化进程可能会无限期搁置）, zem（第一个认为这个游戏高度程序化、可以编程实现的人）, jhd（和我上课下棋做早期测试；在和他下棋的过程中，我逐渐形成了规则意识）, dya, yhx, wy, zz, lzh
产品经理：Gemini(3.1Pro), zcz
算法工程师：zcz, Claude code(Opus4.6/Opus4.7/Sonnet4.6), hmy
前端开发工程师：Codex(GPT5.4/GPT5.5), Claude code(Sonnet4.6), zcz
后端开发工程师：Codex(GPT5.4), Claude code(Sonnet4.6), zcz
提示词工程师：zcz, Gemini(3.1Pro/3.1Thinking)
UI设计师：zcz, Codex(GPT5.4)
UE设计师：zcz, LeoYan, Codex(GPT5.4), Pigeon
运维工程师：Codex(GPT5.4), zcz, Claude code(Sonnet4.6)
测试工程师：zcz, LeoYan, Pigeon, Rainy
内测用户：Mandy, zfp, Orange, Puppy, yxy, hmy, RobinTian, zjy, wyc, fjh, lh, O, lhh, lhr, jhd`,
  }),
  en: Object.freeze({
    rulesEssential: `【Victory Condition】
Players take turns placing nodes on a triangular grid. Any region fully enclosed by your own nodes and links, with no enemy elements inside, counts as your territory. The side controlling more grid points inside its territories wins.
![Playable area example](./guide-images/可以走的区域png.png)

【Core Mechanic】
Adjacent friendly nodes connect automatically as long as nothing blocks the line of sight. Every node and every link on the board must remain physically connected to that side's starting node. You may place a node directly on an enemy link to cut it. If that cut causes part of the enemy structure to lose all connection back to its starting node, the disconnected nodes and links are removed from the board immediately.
![Cut example one](./guide-images/切断1.png)
![Cut example two](./guide-images/切断2.png)

【Restriction Rules】
To keep the game balanced and moving, three constraints always apply. First, there is opening protection: the two positions adjacent to a player's starting node are absolutely forbidden to the opponent.
![Starting-point restriction](./guide-images/起点限制.png)

Second, there is a formation restriction: you may not voluntarily create the smallest triangle made of three mutually adjacent nodes, unless that move directly cuts an enemy link.
![Three-point restriction](./guide-images/三点限制.png)

Third, there is a superko-style repetition ban: any move that recreates a previously seen global node-and-link state is illegal, preventing endless cut-and-recut loops.`,
    rulesWar: `Commander, welcome to this triangular theater woven from points and lines.

There is an old rule of war: supply must move before the army does. On this battlefield, if your forward troops lose contact with headquarters, they collapse from the board at once. That is the iron law you must remember above all else.

Look carefully at the shape of this battlefield. It resembles a front that opens from a narrow approach into a wide plain. That geometry creates the deepest tension in the game: the closer you stay to home base, the easier your line is to defend, but the less land you can truly control. The farther you push toward the center, the larger the territory you may claim, but the longer your line becomes, and the more weak points you expose. The more aggressively you expand, the more cracks you create. The more cautiously you turtle, the easier it is for your opponent to box you in. Whether you advance steadily or charge forward recklessly is always your call.

To prevent headquarters from being sealed off on turn one, a powerful guard protects the area nearest your base. The enemy simply cannot play there. That absolute shield gives you a safe zone from which to begin your outward march.
![Starting-point restriction](./guide-images/起点限制.png)

As the campaign unfolds, you and your opponent alternate sending units to occupy new grid points. Whenever sight lines remain open, a new unit automatically links up with the rest of its side's formation and extends the supply network.
![Playable area example](./guide-images/可以走的区域png.png)

Your ultimate objective is to expand secure territory. On this battlefield, territory means land completely surrounded by your troops and supply lines. To reduce the burden on your front, the staff automatically tightens your border into the leanest defensive outline it can find. That outline tries to shorten the perimeter and remove waste, while still protecting all of your forces and guaranteeing that no enemy presence remains inside the enclosed land.

Resources are tight in a drawn-out war. To avoid waste, you cannot crowd three soldiers into the smallest possible triangle.
![Three-point restriction](./guide-images/三点限制.png)

But the battlefield changes instantly. If your move lands directly on an enemy supply line and cuts it, that is treated as a decisive tactical strike. In such a fierce moment, normal crowding restrictions are waived and concentrated force becomes legal.
![Cut example one](./guide-images/切断1.png)
![Cut example two](./guide-images/切断2.png)

When the smoke clears and neither side has any move or expansion left, the side that enclosed more territory is the true winner. Go on, Commander. May your lines hold.`,
    rulesMath: `# A Formal View of the Triangular Territory Game from Discrete Math and Reinforcement Learning

This note describes the game through graph theory, combinatorial game theory (CGT), and reinforcement learning, with the goal of giving it a precise mathematical model and a clear complexity profile.

## I. Combinatorial Game Structure, Zermelo's Theorem, and Zugzwang

This game is a **two-player, finite, perfect-information, deterministic, zero-sum game**.

By Zermelo's Theorem, every finite game of this kind has an optimal pure-strategy equilibrium. In principle, perfect play must therefore exist.

In many classical symmetric games, adding one more friendly piece is never harmful. That supports the usual strategy-stealing argument: the first player can imagine being second and still not lose. Here that logic breaks down. Because the game includes dynamic topological disconnection and anti-crowding constraints, an extra node can become a physical stepping stone for an enemy cut or can block your own future shape. In some positions, playing more is not just unhelpful, it is actively harmful. Since players cannot pass forever, the game naturally creates **zugzwang** positions in which being forced to move damages an otherwise stable defense.
![Three-point restriction](./guide-images/三点限制.png)

The existence of zugzwang gives the second player real counterplay. It destroys any naive proof that the first player must always be safe, and it gives the game a strongly nonlinear tactical structure. That also makes the search for optimal play computationally expensive, which is exactly why the game is interesting as a reinforcement-learning environment.

## II. Graph Representation of the State Space

The physical substrate of the game is a finite set of lattice points: all coordinates of a triangular grid with side length $N$. Call that global vertex set $V_{grid}$. At any discrete time step $t$, the full game state can be written as a colored undirected graph $S_t = \\langle G_t, C_t \\rangle$, where:

* $G_t = (V_t, E_t)$, with $V_t \\subseteq V_{grid}$ the currently surviving nodes and $E_t$ the links generated by the line-connection rules.
* $C_t: V_t \\cup E_t \\rightarrow \\{Black, White\\}$, a feature function assigning each node and edge to a side.

【Connectivity Axiom】
The graph $G_t$ contains two distinguished anchor nodes, $v_{black}^* = (0,0)$ and $v_{white}^* = (N-1,0)$. For any time $t$ and any monochromatic subgraph $G^{color}_t$, every contained node and edge must belong to the same connected component as that side's anchor.
![Starting-point restriction](./guide-images/起点限制.png)

## III. Action Space and Dynamic Graph Evolution

The action space consists of choosing a legal empty vertex from $V_{grid} \\setminus V_t$. State transitions are discrete operators applied to the graph $G_t$, in the following order:
![Playable area example](./guide-images/可以走的区域png.png)

1. After a move is placed, cast rays along the six lattice directions. If a same-color node is found with no opposing element blocking the path, add a new edge.
2. If the chosen coordinate lies on the discrete path of an enemy edge, that edge is deleted permanently, which may split the enemy graph.
![Cut example one](./guide-images/切断1.png)
3. Run breadth-first search on the enemy subgraph to find the maximal connected component containing its anchor. Every node and edge outside that component is removed for violating the connectivity axiom.
![Cut example two](./guide-images/切断2.png)

## IV. Reinforcement-Learning Model: Turn-Based Markov Decision Process

To make the game solvable by modern RL methods, we model it as a Markov decision process $\\mathcal{M} = \\langle \\mathcal{S}, \\mathcal{A}, \\mathcal{P}, \\mathcal{R} \\rangle$.

* State tensor encoding: the board can be encoded as multi-channel two-dimensional features, including black-node features, white-node features, and a global adjacency structure.
* Superko and DAG transition constraint: to prevent cycles caused by repeated cutting, maintain a history set $H$ over graph hashes. Legal transitions must satisfy $Hash(S_{t+1}) \\notin H$, guaranteeing that each episode still reaches a terminal state in finitely many steps.
* Sparse reward function: the immediate reward during play is 0. Only at the end of the game do we evaluate enclosed territory with a flood-fill style area operator and assign the final reward.`,
    whyTalk: WHY_TALK_EN,
    whyCode: WHY_CODE_EN,
    whyTheory: WHY_THEORY_EN,
    whyThis: WHY_TALK_EN,
    thanks: `Founder: zcz
Vision Spark: Harmony (the first one who helped me build an initial program; without Harmony, the game's software path might have stalled indefinitely), zem (the first one who believed this game was structured enough to be programmed), jhd (an early playtest partner whose games with me helped shape my awareness of the rules), dya, yhx, wy, zz, lzh
Product Lead: Gemini(3.1Pro), zcz
Algorithm Engineers: zcz, Claude code(Opus4.6/Opus4.7/Sonnet4.6), hmy
Frontend Engineers: Codex(GPT5.4/GPT5.5), Claude code(Sonnet4.6), zcz
Backend Engineers: Codex(GPT5.4), Claude code(Sonnet4.6), zcz
Prompt Engineers: zcz, Gemini(3.1Pro/3.1Thinking)
UI Designers: zcz, Codex(GPT5.4)
UX Designers: zcz, LeoYan, Codex(GPT5.4), Pigeon
Operations Engineers: Codex(GPT5.4), zcz, Claude code(Sonnet4.6)
Test Engineers: zcz, LeoYan, Pigeon, Rainy
Beta Testers: Mandy, zfp, Orange, Puppy, yxy, hmy, RobinTian, zjy, wyc, fjh, lh, O, lhh, lhr, jhd`,
  }),
});

const GUIDE_IMAGE_BASE_PATH = "./guide/guide-images/";

const GUIDE_RULE_IMAGE_BLOCKS = Object.freeze({
  rulesEssential: Object.freeze([
    { type: "image", alt: "可落子区域示意", src: `${GUIDE_IMAGE_BASE_PATH}可以走的区域png.png` },
    { type: "image", alt: "切断示意一", src: `${GUIDE_IMAGE_BASE_PATH}切断1.png` },
    { type: "image", alt: "切断示意二", src: `${GUIDE_IMAGE_BASE_PATH}切断2.png` },
    { type: "image", alt: "起点限制示意", src: `${GUIDE_IMAGE_BASE_PATH}起点限制.png` },
    { type: "image", alt: "三点限制示意", src: `${GUIDE_IMAGE_BASE_PATH}三点限制.png` },
  ]),
  rulesWar: Object.freeze([
    { type: "image", alt: "起点限制示意", src: `${GUIDE_IMAGE_BASE_PATH}起点限制.png` },
    { type: "image", alt: "可落子区域示意", src: `${GUIDE_IMAGE_BASE_PATH}可以走的区域png.png` },
    { type: "image", alt: "三点限制示意", src: `${GUIDE_IMAGE_BASE_PATH}三点限制.png` },
    { type: "image", alt: "切断示意一", src: `${GUIDE_IMAGE_BASE_PATH}切断1.png` },
    { type: "image", alt: "切断示意二", src: `${GUIDE_IMAGE_BASE_PATH}切断2.png` },
  ]),
  rulesMath: Object.freeze([
    { type: "image", alt: "三点限制示意", src: `${GUIDE_IMAGE_BASE_PATH}三点限制.png` },
    { type: "image", alt: "起点限制示意", src: `${GUIDE_IMAGE_BASE_PATH}起点限制.png` },
    { type: "image", alt: "可落子区域示意", src: `${GUIDE_IMAGE_BASE_PATH}可以走的区域png.png` },
    { type: "image", alt: "切断示意一", src: `${GUIDE_IMAGE_BASE_PATH}切断1.png` },
    { type: "image", alt: "切断示意二", src: `${GUIDE_IMAGE_BASE_PATH}切断2.png` },
  ]),
});

function resolveGuideImageSrc(src) {
  const value = String(src ?? "").trim();

  if (!value || /^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(value)) {
    return value;
  }

  return value
    .replace(/^\.\.\/guide-images\//, GUIDE_IMAGE_BASE_PATH)
    .replace(/^(?:\.\/)?guide-images\//, GUIDE_IMAGE_BASE_PATH);
}

export function ensureGuideRuleImages(key, blocks = []) {
  const normalizedBlocks = Array.isArray(blocks) ? blocks : [];
  const hasImage = normalizedBlocks.some((block) => block?.type === "image" || block?.type === "image-row");
  const imageBlocks = GUIDE_RULE_IMAGE_BLOCKS[key] ?? [];

  if (hasImage || !imageBlocks.length) {
    return normalizedBlocks;
  }

  return [
    ...normalizedBlocks,
    ...imageBlocks.map((block) => ({ ...block })),
  ];
}

function tokenizeInline(text) {
  const source = String(text ?? "");
  const tokens = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\$[^$\n]+\$)/g;
  let lastIndex = 0;

  for (const match of source.matchAll(pattern)) {
    const matchText = match[0];
    const matchIndex = match.index ?? 0;

    if (matchIndex > lastIndex) {
      tokens.push({
        type: "text",
        text: source.slice(lastIndex, matchIndex),
      });
    }

    if (matchText.startsWith("**") && matchText.endsWith("**")) {
      tokens.push({
        type: "strong",
        text: matchText.slice(2, -2),
      });
    } else if (matchText.startsWith("$") && matchText.endsWith("$")) {
      tokens.push({
        type: "math",
        text: matchText.slice(1, -1).trim(),
      });
    } else if (matchText.startsWith("`") && matchText.endsWith("`")) {
      tokens.push({
        type: "code",
        text: matchText.slice(1, -1),
      });
    }

    lastIndex = matchIndex + matchText.length;
  }

  if (lastIndex < source.length) {
    tokens.push({
      type: "text",
      text: source.slice(lastIndex),
    });
  }

  const normalized = tokens.filter((token) => token.text);

  return normalized.length
    ? normalized
    : [{ type: "text", text: source.replace(/\s+/g, " ").trim() }];
}

function createTextBlock(type, text, extras = {}) {
  const plainText = String(text ?? "").replace(/\s+/g, " ").trim();
  return {
    type,
    text: plainText,
    tokens: tokenizeInline(plainText),
    ...extras,
  };
}

function splitMarkdownTableRow(line) {
  return String(line ?? "")
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isMarkdownTableSeparator(line) {
  return /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(String(line ?? "").trim());
}

export function getGuideMarkdown(key, language = "zh") {
  const normalizedLanguage = language === "en" ? "en" : "zh";
  return GUIDE_MARKDOWN[normalizedLanguage]?.[key] ?? GUIDE_MARKDOWN.zh[key] ?? "";
}

export function getGuideMarkdownAsset(key, language = "zh") {
  const normalizedLanguage = language === "en" ? "en" : "zh";
  const assets = {
    zh: {
      rulesEssential: "./guide/rule/essential%20rule.md",
      rulesWar: "./guide/rule/war%20rule.md",
      rulesMath: "./guide/rule/math%20rule.md",
      whyTalk: "./guide/interesting/why-talk.zh.md",
      whyCode: "./guide/interesting/why-code.zh.md",
      whyTheory: "./guide/interesting/why-theory.zh.md",
      thanks: "./guide/Thanks.md",
    },
    en: {
      whyTalk: "./guide/interesting/why-talk.en.md",
      whyCode: "./guide/interesting/why-code.en.md",
      whyTheory: "./guide/interesting/why-theory.en.md",
      thanks: "./guide/Thanks.en.md",
    },
  };
  return assets[normalizedLanguage]?.[key] ?? "";
}

export function parseGuideMarkdown(raw) {
  const normalized = String(raw ?? "").replace(/\r\n?/g, "\n").trim();
  if (!normalized) {
    return [];
  }

  const blocks = [];
  const lines = normalized.split("\n");
  let index = 0;

  const flushParagraph = (paragraphLines) => {
    if (!paragraphLines.length) {
      return;
    }
    blocks.push(createTextBlock("paragraph", paragraphLines.join(" ")));
    paragraphLines.length = 0;
  };

  const paragraphLines = [];

  while (index < lines.length) {
    const trimmed = lines[index].trim();
    if (!trimmed) {
      flushParagraph(paragraphLines);
      index += 1;
      continue;
    }
    if (trimmed.startsWith("```")) {
      flushParagraph(paragraphLines);
      const language = trimmed.slice(3).trim();
      const codeLines = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      blocks.push({
        type: "codeblock",
        language,
        code: codeLines.join("\n").replace(/\s+$/g, ""),
      });
      continue;
    }
    if (trimmed === "$$") {
      flushParagraph(paragraphLines);
      const mathLines = [];
      index += 1;
      while (index < lines.length && lines[index].trim() !== "$$") {
        mathLines.push(lines[index].trim());
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      blocks.push({
        type: "mathblock",
        text: mathLines.join("\n").trim(),
      });
      continue;
    }
    if (trimmed.startsWith(">")) {
      flushParagraph(paragraphLines);
      const quoteLines = [];
      while (index < lines.length && lines[index].trim().startsWith(">")) {
        quoteLines.push(lines[index].trim().replace(/^>\s?/, ""));
        index += 1;
      }
      blocks.push(createTextBlock("quote", quoteLines.join(" ")));
      continue;
    }
    if (trimmed.startsWith("# ")) {
      flushParagraph(paragraphLines);
      blocks.push(createTextBlock("heading1", trimmed.slice(2)));
      index += 1;
      continue;
    }
    if (trimmed.startsWith("## ")) {
      flushParagraph(paragraphLines);
      blocks.push(createTextBlock("heading2", trimmed.slice(3)));
      index += 1;
      continue;
    }
    if (trimmed.startsWith("### ")) {
      flushParagraph(paragraphLines);
      blocks.push(createTextBlock("heading3", trimmed.slice(4)));
      index += 1;
      continue;
    }
    if (trimmed.startsWith("* ") || trimmed.startsWith("- ")) {
      flushParagraph(paragraphLines);
      blocks.push(createTextBlock("bullet", trimmed.slice(2)));
      index += 1;
      continue;
    }
    if (trimmed.startsWith("|") && index + 1 < lines.length && isMarkdownTableSeparator(lines[index + 1])) {
      flushParagraph(paragraphLines);
      const headers = splitMarkdownTableRow(trimmed).map((cell) => ({
        text: cell,
        tokens: tokenizeInline(cell),
      }));
      index += 2;
      const rows = [];
      while (index < lines.length && lines[index].trim().startsWith("|")) {
        rows.push(splitMarkdownTableRow(lines[index]).map((cell) => ({
          text: cell,
          tokens: tokenizeInline(cell),
        })));
        index += 1;
      }
      blocks.push({
        type: "table",
        headers,
        rows,
      });
      continue;
    }
    if (/^-{3,}$/.test(trimmed)) {
      flushParagraph(paragraphLines);
      blocks.push({ type: "divider" });
      index += 1;
      continue;
    }
    if (/^\d+\.\s+/.test(trimmed)) {
      flushParagraph(paragraphLines);
      const [, order, content] = trimmed.match(/^(\d+)\.\s+(.+)$/) ?? [];
      blocks.push(createTextBlock("ordered", content ?? trimmed, {
        order: Number(order ?? 0),
      }));
      index += 1;
      continue;
    }
    if (/^!\[(.*)\]\((.+)\)$/.test(trimmed)) {
      flushParagraph(paragraphLines);
      const [, alt, src] = trimmed.match(/^!\[(.*)\]\((.+)\)$/) ?? [];
      blocks.push({
        type: "image",
        alt: String(alt ?? "").trim(),
        src: resolveGuideImageSrc(src),
      });
      index += 1;
      continue;
    }
    if (/^[^：:]{1,24}[：:]\s*.+$/.test(trimmed)) {
      flushParagraph(paragraphLines);
      const [, label, value] = trimmed.match(/^([^：:]{1,24})[：:]\s*(.+)$/) ?? [];
      blocks.push({
        type: "meta",
        label: String(label ?? "").replace(/\s+/g, " ").trim(),
        text: String(value ?? "").replace(/\s+/g, " ").trim(),
        tokens: tokenizeInline(value ?? ""),
      });
      index += 1;
      continue;
    }
    if (/^【.+】$/.test(trimmed)) {
      flushParagraph(paragraphLines);
      blocks.push(createTextBlock("callout", trimmed));
      index += 1;
      continue;
    }
    paragraphLines.push(trimmed);
    index += 1;
  }

  flushParagraph(paragraphLines);
  return blocks;
}
