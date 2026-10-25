# Code：LIFELINE 算法技术报告

摘要：本报告按数学、算法、AI 三大章组织。重点是数据结构、执行顺序、伪代码、源码摘录、复杂度与实现边界；让读者能从一条规则追踪到实际函数及返回值。

2026-10-25 源码核对版。编号伪代码是控制流说明，标明来源的摘录才是原始代码。终局奖励下的线性继续训练、历史神经模型与固定深度 Minimax 分别说明；训练、推理、限定准入和 Web/小程序发布由各自收据确认。

阅读路径：第一章建立符号和完整状态，第二章讨论规则算法，第三章讨论 AI。目录可直接定位各章与小节。territory-v3 始终计算己方占点，并逐个加入与外界隔绝且无敌方点的空腔；旧棋谱保留原规则版本。

**目录**

[第一章 数学](#第一章-数学)

- [1.1 状态的数据结构](#11-状态的数据结构)

- [1.2 分数与不变量](#12-分数与不变量)

- [1.3 快照与恢复成本](#13-快照与恢复成本)

[第二章 算法](#第二章-算法)

- [2.1 合法性试走](#21-合法性试走)

- [2.2 自动连线](#22-自动连线)

- [2.3 切断与根 BFS](#23-切断与根-bfs)

- [2.4 Superko 提交](#24-superko-提交)

- [2.5 轮廓与闭环判定](#25-轮廓与闭环判定)

- [2.6 领土收紧](#26-领土收紧)

- [2.7 洪水与计分](#27-洪水与计分)

- [2.8 规范方向与缓存](#28-规范方向与缓存)

- [2.9 跳过与终局](#29-跳过与终局)

- [2.10 源码与验证路径](#210-源码与验证路径)

[第三章 AI](#第三章-ai)

- [3.1 贪心与估值](#31-贪心与估值)

- [3.2 Minimax 控制流](#32-minimax-控制流)

- [3.3 普通 MCTS](#33-普通-mcts)

- [3.4 神经网络前向](#34-神经网络前向)

- [3.5 PUCT 选步](#35-puct-选步)

- [3.6 五类策略的推理](#36-五类策略的推理)

- [3.7 训练源码与损失](#37-训练源码与损失)

- [3.8 多人线性策略](#38-多人线性策略)

- [3.9 三人 V4](#39-三人-v4)

- [3.10 六边形 V5](#310-六边形-v5)

- [3.11 后续多人搜索](#311-后续多人搜索)

- [3.12 调度与可复现性](#312-调度与可复现性)

## 第一章 数学

这一章把数学对象映射为工程数据与不变量。后文伪代码用于讲清控制流，使用带行号的语言无关步骤；标为“源码摘录”的片段才是当前工作区的原文。完整证明见配套抽象废话版。

### 1.1 状态的数据结构

把屏幕上的棋盘拆成三层，会更容易理解后面的算法。第一层是固定的格点与六邻接关系；第二层 grid 记录每个位置为空、某方棋子节点或某方连线途经点；第三层 edges 为每一方单独保存真实存在的逻辑边。线经过某个位置，不表示那里放了一颗棋子；看起来挨在一起，也不自动等于逻辑上相连。

边长 N 指外边上的格点数。三角棋盘有 N(N+1)/2 个格点，六边形有 3N(N−1)+1 个格点；N=15 时分别为 120、631。整数坐标的六个方向是 (1,0)、(−1,0)、(0,1)、(0,−1)、(1,−1)、(−1,1)。绘制时再投影到屏幕，规则计算不依赖像素、缩放或手机分辨率。

完整状态还包括棋盘形状、规则版本、各方实际起点、当前行动方、连续跳过次数、认输集合、终局标记，以及全部 Superko 历史。领土缓存与局面修订号用于加速和异步显示；只保存一张棋盘图片，或者只保存 grid，都不足以恢复一局棋的全部规则。

```text
01 CONFIG = {rules, shape, size, players, starts}
02 grid: Map<pointKey, EMPTY | NODE(player) | LINE(player)>
03 edges[player]: Set<canonicalEndpointPair>
04 historyHashes: Set<serializedTrialKey>
05 turn = {currentPlayer, consecutiveSkips, resignedPlayers, gameOver}
06 display = {cachedTerritories, territoryRevision, positionRevision}
```

工程上必须区分三种身份：规则状态用于判断下一手，几何依赖用于领土缓存，修订号/请求号用于拒绝异步旧结果。相同 grid 不意味着相同 edges；相同 grid+edges 不意味着相同历史；同一规则局面也可能来自不同 UI 请求。

源码定位：web/web前端/GameEngine.js → constructor, _captureReplayState, _computeStateHash。

### 1.2 分数与不变量

接口约定：area 是正式计分，displayArea 是鞋带表达式对应的几何量，reach 是 AI 特征。它们即使都叫“面积”也不可互换。用类型或命名保持区分，终局读取规范领土，不能直接拿 evaluate 返回值判胜负。

$$
\operatorname{coverage}_i=|F_i|,\qquad \operatorname{area}_i=|F_i|+|B_i|,\qquad \operatorname{reach}_i=|\operatorname{Reach}_{G_0\setminus O_i}(F_i)|.
$$

应检查的不变量包括：节点不能被普通落子覆盖；存活节点沿显式边能回到实际起点；非法试走不提交历史；接受落子只增加新历史键；搜索恢复后规则状态不变；AI 返回值仍属于当前请求且执行时合法。断联、切线与终局都应通过 GameEngine，而不是让 UI 或网络模型各写一套近似规则。

源码定位：web/web前端/GameEngine.js → _getOpponentConnectedPieces, _evaluateMove, _computeTerritory。

### 1.3 快照与恢复成本

AIEngine 的 saveState 复制 grid、各方 edges、历史 Set 与轮转字段，并复制领土缓存；restoreState 重建棋盘/边/历史容器，但把 snapshot.cachedTerritories 直接赋回。随后要刷新精确领土的分支必须拥有自己的缓存对象，V4/V5 因而有额外隔离。只复制最外层对象会让分支互相污染。

源码摘录：这些字段正是同一盘面仍可能具有不同合法性的原因。

```javascript
    historyHashes: new Set(engine.historyHashes),
    consecutiveSkips: engine.consecutiveSkips,
    resignedPlayers: new Set(engine.resignedPlayers ?? []),
    currentPlayer: engine.currentPlayer,
    gameOver: engine.gameOver,
```

若 M 为格点数、e 为逻辑边数、h 为历史条目数，一份快照通常复制 O(M+e+h) 个容器条目；不可变历史字符串可以共享引用，其实际字节长度另计。深度 d 的递归同时保留多份快照时，不能把空间成本简写成 O(d)。函数返回时的正常恢复与异常路径 finally 的覆盖范围也要分别审计。

源码定位：web/web前端/AIEngine.js → saveState, restoreState, cloneCachedTerritories。

## 第二章 算法

按一次落子经过的路径拆解：合法性 → 自动连线 → 切断清理 → Superko 提交 → 轮转 → 计分。每节列输入、核心步骤、输出与源码入口；领土的外轮廓、收紧和洪水是三个不同阶段。

### 2.1 合法性试走

合法动作由真实引擎试走决定。检查包括有效坐标、可占用状态、敌方起点保护、三点限制、与己方建立连接，以及动作完成后是否触犯 Superko。空点与线点可以成为落子候选，已有 NODE 不能被覆盖。所有敌方实际起点的有效邻点都受保护，随机起点与自定义起点也按相同方法检查。

三点限制以当前 _checkThreePointLimitation 的实现为准：新点若已有至少两个相邻己方节点，拒绝；如果它只邻接一个己方节点，但该节点已经邻接另一己方节点，也拒绝。因此它限制的是形成三个相邻节点的链或团，直线或折线三连也可能触发，并不只是检查最小三角形。

直接落在敌方线点上的切线动作可豁免这项三点检查，但不能豁免起点保护、连接要求或 Superko。合法性不会读取着色用的领土缓存来猜测能否落子；实际节点、线点、连线阻挡和完整历史共同决定结果。

试走必须可撤回。_evaluateMove 临时修改棋盘与边集，计算结果状态，然后在 finally 中恢复。合法点提示可以检查很多候选，却不应改变正在进行的棋局。

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

枚举 M 个候选会执行许多试走，因此一次 getLegalMoves 的成本是 M 乘试走成本的量级，而非一次邻居扫描。固定坐标顺序、射线几何和可复用缓冲可以加速；不得缓存忽略历史的“永远合法点”。

源码定位：web/web前端/GameEngine.js → _evaluateMove, getLegalMoves, _checkThreePointLimitation, _isInProtectionZone。

### 2.2 自动连线

一次落子先检查新点能否沿网格直线连接到已有己方节点。两点必须位于同一条 x 恒定、y 恒定或 x+y 恒定的网格线上；扫描中间格点时，遇到任一敌方节点或敌方线点就被阻挡。若没有任何可连的己方节点，这次落子不成立。

连接成功后，端点记为 NODE，中间原本为空的点记为 LINE，并把两个端点组成的无向边加入 edges。端点顺序规范化，避免 A—B 与 B—A 重复入库。新点与已有节点的连接检查可以保留长边，因此规则并不是只把屏幕上相邻的一对棋子连起来。

随后 _connectAllCrawl 从己方每个节点沿六个方向爬行：遇敌方元素停止，遇第一个己方节点就补上缺少的边，再结束该方向扫描。直接切线可能清走遮挡物，所以攻击后还会检查其他各方，补上新解锁的连接。扫描读取当前占用；预缓存的只是固定射线路径。

领土着色轮廓与实际连线是两个对象。轮廓为了计分而经过某个空点，并不会把它变成 LINE，也不会凭空产生可攻击的逻辑边。

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

源码摘录：新点可直接记录长逻辑边；这与逐方向只找第一个节点的补线阶段相互补充。

```javascript
      // 记录显式边
      this._getEdges(this.currentPlayer).add(this._edgeKey(point, node));
```

设射线最大长度为 D、己方节点 k 个，直接连接检查和一次六向 crawl 的朴素扫描量为 O(kD)，另需计写入的线点和边。预计算射线减少重复几何计算，但敌方占用必须每次重新读取。

源码定位：web/web前端/GameEngine.js → _addNode, canConnectWithBlocking, getLinePoints, _connectAllCrawl。

### 2.3 切断与根 BFS

落在敌方 LINE 上是切线，而不是吃掉任意敌方棋子。攻击会破坏经过该位置的逻辑边；_cleanupBrokenEdges 逐条检查边上的格点，把已经不完整的边移除。双方的普通落子与 AI 模拟都走同一套状态转移。

接着以被攻击方的实际初始节点为根，在显式边集形成的节点图上做 BFS。能沿存活逻辑边走到的节点留下；存活边的中间线点也留下。失去所有回家路径的节点与线点被清除，再处理边集与可能恢复的原有连接。这里的 BFS 是“沿补给图找根连通分量”，不是“从棋盘边缘注水算领土”。

例如 A—B—C 是一条从起点 A 出发的唯一通路，切掉 A—B 会使 B、C 一侧失联；若 C 还有另一条绕回 A 的路径，则那一侧未必消失。视觉上碰到一条路过的线，也不能替代真实的端点—边路径。

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

必须先明确边是否存活，才能讨论沿边可达。源码为攻击维护被破坏连线与恢复检查；这里的伪代码只抽取根连通性主干，不把几何路径检查、边集维护和跨玩家补线省略为免费操作。

源码定位：web/web前端/GameEngine.js → _handleBlockingAttack, _cleanupBrokenEdges, _getOpponentConnectedPieces。

### 2.4 Superko 提交

这里的名称是“全局同形禁手”，不是“全局没有禁手”。它防止切断、重新连线之后反复回到已经记录过的同一全局局面，而不是只禁止紧接上一手的局部反吃。

当前 _computeStateHash 的状态键依次包含：下一行动方、认输玩家列表、按坐标排序的所有非空格点及其状态、按玩家组织并排序的显式边集。虽然函数名叫 Hash，这里实际上用稳定的 JSON 字符串作为 Set 的键，不是只保留一个短整数哈希。相同棋子分布但逻辑边不同，不算同一个键；下一行动方不同，也可能是不同的键。

开局键先进入 historyHashes。每次候选落子完成连接、切断和清理后，计算下一局面键；若历史里已有该键，则判 SUPERKO_VIOLATION 并撤回。真实合法落子才把新键加入历史。跳过按独立回合规则处理，不把“棋盘没有变化”直接当作非法重复；认输也有自己的轮转和结算逻辑。

例如两份存档的棋盘与当前玩家完全相同，但其中一份历史已包含“落在 P 后的结果”，另一份没有，P 就可能只在后一份合法。因此搜索快照、悔棋、复盘分支与恢复都必须保留各自那条路径的历史；网络特征或棋盘截图不能代替它。

精确时序补充：playMove 在 _addNode 成功后，用 _getNextPlayer(currentPlayer) 计算键；historyHashes.add 之后才 _switchPlayer 和 _checkAndAutoSkip。它不是把自动跳过后的 currentPlayer 原样序列化。

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

键生成包括排序/序列化成本；Set 查找通常按哈希表分析，但整体流程并不因此是 O(1)。源码缓存固定格点排序和单点序列化片段，仍然逐次读取占用与全部边，再对完整历史判重。

源码定位：web/web前端/GameEngine.js → _computeStateHash, _getStateHashOrder, playMove。

### 2.5 轮廓与闭环判定

显示轮廓先收集己方节点与线点，并把其他各方的节点和线点作为敌方元素。_getOuterContourFromPoints 按固定顺时针邻接顺序，用右手摸墙式遍历取得外轮廓。轮廓是一条格点闭合游走，可以沿枝条走出去再折返，因此同一个格点可能在游走序列中出现多次；这条轮廓不再定义正式计分。

闭合游走不一定围出真正的区域。A—B—C—B—A 只是来回走了一条线。_hasBoundaryCycle 用于轮廓候选与显示诊断，但正式计分不依赖它。territory-v3 将全部己方节点和线点作为墙，按边界洪水找出所有空腔；无闭环时仍计己方占点，多个空腔和甜甜圈内孔也会独立判断。

轮廓仍用于画面诊断，但正式分数不依赖它能否形成单一闭环。计分会把全部己方节点和线点当墙，从棋盘边界注水；所有不连通外界的空腔逐一计数，含敌方元素的空腔排除。开链、多个环和甜甜圈内孔都由同一连通分量判定处理。

```text
01 Walk the outer boundary using the fixed clockwise neighbor order
02 Convert consecutive walk vertices into distinct undirected unit edges
03 Reject an invalid point or a non-unit step
04 Let n = distinct vertices, e = distinct edges
05 Accept the cycle gate iff n >= 3 and e >= n
```

源码摘录及依据：一个有效闭合游走形成的去重边图连通；连通无向图有环当且仅当 e≥n。因此这里可用边点计数，而不能对任意不连通图不加条件照搬同一判据。游走沿枝条折返不额外增加去重边数。

```javascript
    return vertices.size >= 3 && edges.size >= vertices.size;
```

源码定位：web/web前端/GameEngine.js → _getOuterContourFromPoints, _hasBoundaryCycle。

### 2.6 领土收紧

_computeRawTerritory 对当前轮廓反复寻找捷径。选取轮廓上的两个位置作为端点，避开敌方格点，在棋盘六邻接图上做 BFS，取得最短距离及全部最短路的前驱关系，再枚举相关最短路径。将路径与旧轮廓的两侧分别拼接，产生可能保留的候选闭合游走。

候选必须保住全部己方节点、不能覆盖任何敌方节点或线点，并且满足有效闭环。比较采用字典序：先让轮廓步数更少；步数相同时，让覆盖格点数更少。每轮接受找到的最好候选，继续收紧，直到找不到改善。这里的周长按离散轮廓游走步数衡量；枝条的往返会体现在游走长度中。

覆盖格点由下一节的洪水法计算。为了避免重复工作，实现会复用同一源点的 BFS、相同边界的覆盖检查，并用周长下界和可覆盖性条件排除不可能改善的路径。它不会简单地只保留某个随意固定数量的最短路径来冒充精确检查。

这是一套确定性贪心收紧程序。它在自己的候选与接受规则下停止，不能据此宣称已经找到所有可能多边形中的全局最短周长或全局最小覆盖面积。收紧也可能使用原本为空的网格点，因此最终计分边界不必逐段等于原有的实体连线。

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

复杂度记账：给定墙的洪水是 O(M)，一次源点 BFS 是 O(M)，但一个前驱 DAG 可能代表组合数量的最短路。用 J 表示实际枚举的路径前缀/候选工作量，端点对数与 J 必须单独计入。当前 _rawTerritoryUncached 使用周长下界、路径包络、已验证墙集合和标量覆盖查询削减重复工作；_computeRawTerritory 再加依赖缓存。不能给整个算法承诺 O(M)。

源码定位：web/web前端/GameEngine.js → _computeRawTerritory, _rawTerritoryUncached, _bfsFromSource, _iterateTerritoryPaths, _iterateCoveredTerritoryPaths。

### 2.7 洪水与计分

_computeOwnedWallArea 把己方节点与线点标成墙，并调用 _getCoveredPoints 从棋盘边界注水。再对未被水访问的非墙点做分量 BFS；分量含敌方点时不计，否则计入。单线没有空腔但占点照常计分。

令 V 为全棋盘格点，F 为己方节点与线点，删除 F 后从棋盘边界洪水可达的点为 X；Qₖ 是 V\(F∪X) 的各连通分量，B 为不含敌方节点或线点的 Qₖ 之并。territory-v3 的 area=|F|+|B|。这一定义无需有效闭环，因此开链和单线照常计占点；多个空腔及甜甜圈内孔分别计入，敌方所在空腔整块排除。同一点只算一次。这里数格点，不数最小三角形。

旧 territory-v2 六人截图曾得到格点分数 25、10、11、13、8、8，以及几何诊断 6、2、2、4、2、2；这些不是新规则的复核分数。新规则中青方即使只有未闭合的三个己方格点，也应得 3。

引擎另用鞋带公式计算 displayArea，单位对应最小三角形面积。它是几何诊断；比分与终局比较读取 area。洪水法只是给定墙后区分内外，计分单位由被遍历的对象决定：在格点图上注水与在小三角面之间注水，并不是同一个计数问题。

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

实现将己方全部节点和线点作为墙，从棋盘边界注水，再逐个遍历未连到外界的空腔。含敌方节点或线点的整块空腔排除；其余空腔全部加入己方占点数。因而无需先找到有效闭环：开链、单线按占点计分，多个空腔与甜甜圈内孔分别统计。整数索引、预分配队列与访问标记只优化运行成本，不改变计分定义。鞋带式只用于 displayArea。

源码定位：web/web前端/GameEngine.js → _getCoveredPoints, _getValidatedTerritoryArea, computeTriangularPolygonArea。

### 2.8 规范方向与缓存

固定方向的轮廓遍历可能偏向某席位。territory-v3 沿用 v2 的规范朝向生成用于显示的闭环轮廓，并独立从全部己方点线计算正式空腔分数。三角棋盘使用重心坐标置换；六边形使用 D6 旋转与反射。规范候选轮廓的选择不决定正式 area。

精确领土需要轮廓、最短路径和洪水检查，通常比简单数棋子昂贵。实现使用整数格点下标、预计算邻接表、可复用 TypedArray 队列与 epoch 标记，减少字符串、集合与数组分配。它们改变计算成本，不改变 area 的单位。

显示层可以缓存领土或交给 Worker 计算，但结果必须带着正确的局面修订号回来。旧局面的结果不能覆盖新棋盘；终局判胜必须取得当前局面的精确得分。fastTerritoryBFS 等 AI 估计不能填进正式领土缓存。

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

几何缓存键包括形状/尺寸、规则和规范方向依赖、己方节点/线点、敌方障碍并集及显式初始轮廓的相关次序。搜索缓存还需完整历史和轮转信息。缓存返回可变多边形时需复制；对覆盖了核心方法的诊断/子类对象，源码保留未优化路径，避免把原生方法的剪枝证明误用于不同语义。

源码定位：web/web前端/GameEngine.js → _getCanonicalTerritoryTransforms, _computeCanonicalTerritoryCandidate, _computeTerritory, dependencyMemo。

### 2.9 跳过与终局

当前版本允许主动跳过。没有合法落点时，引擎还会自动跳过该玩家；轮转时排除已经认输的玩家。因此搜索树里“下一层轮到谁”必须读引擎状态，不能一律按照递归深度的奇偶来猜。

所有仍在场的玩家连续各跳过一次后，正常终局按各自精确 area 比较；最高分并列就是平局。中途有人成功落子，连续跳过计数重置。认输者退出轮转与胜者比较；若只剩一位未认输玩家，该玩家立即获胜。

对固定有限棋盘，记录历史的合法落子不能无限重复同一状态键；连续跳过又有结算规则。这个终止机制并不意味着 AI 已经求解游戏，也不能把旧文中“玩家无法跳过，因此必然被迫落子”的论证沿用到当前规则。

2026-10-25 的产品选步取消了“跳过立即独胜就直接返回 PASS”的捷径。共享检查保留原策略的落子；首选 PASS 时，在隔离完整状态中先查下述适用的不变量或终局分差证书；若无完整证书，再枚举实际对手的全部合法落子与 PASS，直到原行动方再次行动或原生终局，寻找保留己方节点、覆盖和起点连通的增长落点。若原 PASS 会独胜，替代落点还须在这个窗口内保持领先。

该检查默认最多 200 毫秒、10000 个节点，只在完整证书成立时替换 PASS；开局还允许节点增长且正式 area 不减的完整发展证书。预算不足或没有证书时保留真实策略 PASS，无合法落点按引擎规则跳过，策略完全无结果则报告可重试错误。一轮应对证书只证明所检查的一轮，也不是训练所需的深层 Minimax 标签。

V3 对不会立即结算的真实策略 PASS 优先检查起点保护区证明：落子后保留全部原节点和覆盖，所有己方节点沿完好的逻辑边连回起点，全部己方线点位于起点相邻保护区，且占据格点数严格超过落子前的正式 area。对手既不能占己方节点，也不能落在受保护线点，因此在自己下次实际行动、认输或原生终局前，任意对手行动序列都不能切断这些棋形。即使自己被自动跳过，也可用此证书继续安全扩张；它不证明未来分差、胜率或整体最优。隔离状态和规范 PASS 检查计入总预算；随后结构搜索最多检查 12 个靠近起点的落点，搜索窗口最多为 8 毫秒与总预算 5% 中较小者；没有证书时，完整应对检查继续使用实际剩余预算。会立即结算的 PASS 必须维持原有胜负与领先门槛，V4 的特殊解析证明见下；Minimax 搜索深度不变。

V4 另为会立即结算的真实 PASS 提供窄范围解析证书：仅用于原生 4–6 人六角局面，其他存活玩家均只有自己的出生节点、没有线。新根须保留原节点和覆盖，全部落子后覆盖均沿完好逻辑边连接出生点，并证明每个可攻击己方线点的敌方出生射线都被己方节点遮挡，因此这一轮不存在首次切断。还须保留一个出生点相邻的己方线点：其规范落子合法，而且逐条解析完整历史后从未出现该处己方节点；保护区和这个历史条件保证自己不会被自动跳过，故每名敌方在自己回归前至多行动一次。逐敌方分别枚举出生点到候选点的直线段，保留己方已证覆盖作障碍、忽略其他敌方障碍，以正式 native area 求各自面积上界；不把互不相容的线段并成棋形。己方占据下界须严格超过旧 area，并让分差下界在原 PASS 独胜时严格大于零、原 PASS 平局时不小于零。此证书是实际一轮的解析上界证明，不冒充逐回应穷举，也不承诺任意未来轮的胜差。最多尝试 12 个按预计覆盖增量排序的根，隔离、历史、几何和哈希检查均计入同一总预算；不成立则原检查只使用真实余量。

```text
01 PASS: increment consecutiveSkips
02 If skips >= remaining-player count: set gameOver
03 Otherwise advance to the next non-resigned player
04 While the current player has no legal placement: auto-skip
05 A successful placement or resignation resets the pass count
06 If only one player remains: that player wins
07 Otherwise at settlement: recompute exact area and compare survivors
```

性能优化可以延后非终局着色，但终局读取比分前必须完成精确更新。当前 Minimax 的真实终局分支与神经 PUCT 都按规范 area 判胜负；两者的非终局估值、访问次数或网络先验仍不能统一标成“胜率”。

源码定位：web/web前端/GameEngine.js → skipTurn, resignPlayer, _checkAndAutoSkip, getWinner。

### 2.10 源码与验证路径

引擎主路径在 web/web前端/GameEngine.js；搜索与快照在 AIEngine.js；跨 Worker 状态协议在 AIStateProtocol.js；棋谱恢复在 ReplayCodec.js 与 LocalGameSession.js。微信阅读/任务调度分别在 wechat/minigame/src/guide-content.js、help-ui.js 和 Worker 会话模块。后续多人开发路径见第三章，不把 Web 候选存在等同于手机已装入。

建议验证顺序：固定动作重放 → 比较 grid/edges/history/turn → 精确面积与胜者 → 原状态恢复 → Worker 迟到结果拒绝 → 实际界面目录/公式/代码阅读。普通文档修改只运行相关检查；冻结实验与已有发布收据不改写。本报告源码摘录通过与当前文件逐字匹配检查；缩进规范化不改变代码标记。

```text
node web/tools/sync-implementation-guides.mjs --check
node web/web前端/tests/verify-guide-content.mjs
node --test --test-timeout=180000 wechat/minigame/tests/guide-cabin.test.mjs
```

## 第三章 AI

先看候选如何生成，再看估值、搜索、神经前向与返回动作。下列预算和适配行为是源码事实；训练目标与推理入口分开描述，候选模型的标签不代表棋力排序。

### 3.1 贪心与估值

贪心 AI 先枚举真实合法落点，按“切敌方线、邻近己方线、其余落点”的顺序排序，最多保留 20 个候选。对每个候选试走一手，计算评价，再恢复状态，选择评价最高的点。它看的是一步之后的估计好坏，不保证正式领土增量最大。

当前 AIEngine 的评价为 F=15Δ节点+8Δ覆盖+20Δ可达+12可攻击线点+10起点连通质量。覆盖是节点数加线点数；双人时差值针对对手，多人通用贪心会把部分对手计数求和，而可达差选择节点最多的主要对手。可攻击线点必须经真实合法性检查，包括 Superko。连通质量逐个检查己方节点是否能沿逻辑边回到起点。

fastTerritoryBFS 从己方全部节点和线点向外扩张，敌方元素作为障碍，统计能到达的格点。这是一项活动空间特征，即使没有闭环也可能很大；它不等于“从棋盘边缘往内注水”得到的正式领土。AI 评价、显示色块和终局 area 因而必须分开解释。

```text
01 legal <- engine.getLegalMoves(actor)
02 ranked <- cuts first, own-line adjacency next, other placements last
03 candidates <- first 20 ranked placements
04 For each candidate: save -> play -> evaluate F -> restore
05 Sort by descending F; return top requested candidates
```

源码定位：web/web前端/AIEngine.js → evaluate, fastTerritoryBFS, orderMoves, GreedyAI.getTopMoves。

### 3.2 Minimax 控制流

Minimax 把“我选择最好的一步，对手选择对我最不利的一步”递归展开。以根玩家为评价视角：当前行动方是根玩家时取所有被搜索后继的最大值，轮到对手时取最小值。Web 与小程序的 Minimax 简单、中等、困难分别为深度 2、3、4，指行动层数而非每方轮数；它是固定深度搜索，没有多人困难路径的 650 毫秒总预算。比较速度应固定局面、尺寸和实际深度。

α 保存 MAX 已有的下界，β 保存 MIN 已有的上界；当 β≤α，继续展开这条分支已不可能改变祖先的选择，可以剪掉。α–β 在相同候选树和评价下保留 Minimax 的决策，但每层最多 20 个排序候选本身是另一种截断，会漏掉排序之外的合法招法。

每个分支先保存 grid、edges、historyHashes、行动方、认输、跳过、终局、修订号和领土缓存，再通过 GameEngine.playMove 或 skipTurn 推进，随后恢复。自动跳过可能让同一玩家连续获得行动，MAX/MIN 因而由 currentPlayer 决定。非终局深度耗尽使用 Minimax 的启发式估值；真实终局按正式 area 判胜、平、负，返回 +1000000、0、−1000000。有限候选与有限深度的非终局结果仍不是整局胜负证明。

当前双人 Minimax 把 PASS 与合法落点一起作为根层和递归层候选，并通过 GameEngine.skipTurn 推进；因此即使有合法落点也可主动跳过。PASS 是否入选仍取决于同一启发式和有限深度搜索，不等于已经求解终局。多人困难搜索另有完整下一位对手 MOVE+PASS 回复包与时间门，两套实现的证据范围需要分别说明。

为减少等待，推演不生成界面快照、不反复计算只用于显示的领土；只到启发式叶子时还可省去不影响 F 的下一玩家自动跳过扫描。非叶子仍保持真实轮转，避免提速改变树的含义。

```text
01 SEARCH(S,d,alpha,beta,root):
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
13   Return value
```

```javascript
    const maximizingPlayer = engine.currentPlayer === aiPlayer;
```

伪代码省略非法候选返回分支与缓存字段，不是新求解器。正常分支恢复与 finally 的实际覆盖范围应按源码阅读；不能仅凭伪代码推断任意中途异常都有完整事务回滚。全候选枚举成本仍会发生在取前 20 个之前，故“只搜 20 个”不等于“只试走 20 个”。

源码定位：web/web前端/AIEngine.js → MinimaxAI.minimax, MinimaxAI.getTopMoves, applyMinimaxAction。

### 3.3 普通 MCTS

仓库中的普通 MCTSAI 实现“选择—扩展—随机模拟—回传”：在树中用平均回报加探索项选择分支，展开尚未访问的动作，再随机推演到终局或深度上限，把结果累计到沿途节点。UCT 探索项与 sqrt(log(父访问数)/子访问数) 成正比，让冷门分支也有被尝试的机会。

该普通实现默认 64 次模拟、随机推演深度 40、探索系数 sqrt(2)，用带种子的伪随机数复现实验；未到终局的模拟以 tanh(F/100) 估值。它是代码里保留的算法实现，不代表当前小程序菜单另有一个独立“普通 MCTS”选项。

CNN、Grid GNN、Topology GNN 使用的则是 NeuralPUCTAI：网络给出动作先验和局面价值，PUCT 根据先验分配搜索次数。两者都有树搜索与回传，但 PUCT 不是把神经网络当随机落子的别名，也不能把 16 次神经模拟与 64 次随机模拟直接当作相同算力或棋力。

```text
01 Repeat simulation budget times:
02   restore root state
03   Select children by mean return + UCT exploration bonus
04   Expand one unvisited action
05   Roll out random actions until terminal or depth cap
06   Evaluate rollout return; add it to every visited tree node
07 Rank root actions using accumulated search statistics
```

当前普通实现的 rollout 最终使用 tanh(F/100)，并不因为撞到终局就自动改成精确 area 的 ±1。要区分这一实现与后文 NeuralPUCTAI 的终局价值规则。带种子随机数有助复现动作序列，但同一初态重复同一种子不产生新的独立统计样本。

源码定位：web/web前端/AIEngine.js → MCTSAI, rollout, evaluate。

### 3.4 神经网络前向

研究模型每个格点使用 11 个特征：空点、己方节点、己方线点、敌方节点、敌方线点、归一化 x、归一化 y、边界标记、己方起点、敌方起点、连续跳过计数。视角始终相对于当前行动方。真实引擎另外生成合法动作掩码；历史全集并没有塞进这 11 个通道。

CNN 将三角棋盘放进带无效区域的方形张量，经过输入投影和 3×3 卷积残差块，读取有效格点的隐藏表示。Grid GNN 在六邻接网格图上传消息，对邻居表示取均值并线性变换，再与自身投影、残差和归一化组合。

Topology GNN 使用三类关系：格点邻接、己方逻辑连接、敌方逻辑连接。它让长边关系直接参与消息传播，而不必全部依赖很多层局部卷积去间接传递。三种架构最后都有逐点策略头、全局池化后的 PASS 头与价值头；价值头用 tanh，策略 logits 经合法掩码和稳定 softmax 变成先验。

相同棋盘特征可以对应不同历史，因此“网络输入”不等于完整的马尔可夫规则状态。合法掩码与推演仍依赖带完整历史的引擎。S01–S03 是不同训练种子的模型，D14 是较早的模型版本；模型名称、种子编号和参数数量都不自动证明棋力高低，跨尺寸与规则兼容也要看对应验证范围。

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

源码摘录：关系聚合不是把边画出来给网络看，而是直接使用关系邻接表。下面是已有隐藏向量的均值累加。

```javascript
          const neighbors = relations[relation][node];
          if (neighbors.length) {
            for (const neighbor of neighbors) for (let channel = 0; channel < channels; channel += 1) aggregate[channel] += hidden[neighbor * channels + channel] / neighbors.length;
          }
```

若隐藏宽度为 c、关系边总数为 eᵣ、关系数为 R，每层均值聚合约 O(eᵣc)，逐点关系与自身线性投影约 O((R+1)Mc²)。CNN 每次 3×3 卷积约 O(9N²c²)，应另乘实际块内卷积次数。以上只计前向算术，真实合法掩码成本要单列。

源码定位：web/web前端/ResearchAI.js → encodeResearchPosition, researchRelations, forwardGnn, forwardCnn, applyHeads。

### 3.5 PUCT 选步

一次 PUCT 分析先展开根节点，得到每个合法动作的网络先验 P。选择子节点时计算 sign·Q+c·P·sqrt(max(1,N))/(1+n)：Q 是该子节点累计回报的平均值，N 是父访问次数，n 是子访问次数；sign 根据真实行动方把根玩家视角切换为对手视角。

每次模拟都从完整根快照恢复，再沿树执行真实落子或跳过。首次到达未展开的非终局节点时运行网络，把当前玩家价值换成根玩家视角，回传到整条路径。若到达真正终局，强制调用规则引擎的精确领土更新，以胜、平、负的 +1、0、−1 回传。

小程序当前的神经模型使用 16 次模拟、cPuct=1.5。搜索结束后主要按子节点访问次数选步，再以平均价值破同分。网络先验决定先查什么，访问数表示本次搜索把预算花在哪里；二者都不等同于经过统计校准的胜率。

模型动作契约决定正常有落点时是否提供 PASS；没有落点时也需要正确处理跳过。所有输出最终仍要属于当前局面并通过执行时的合法性检查。PUCT 预算有限，不能当作穷举求解器。

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

源码定位：web/web前端/ResearchAI.js → NeuralPUCTAI.expand, select, getTopMoves。

### 3.6 五类策略的推理

这五类模型在手机上共享一条轻量推理路径。三角棋盘最多 120 个格点，每点 7 个特征：空、己方节点、己方线、敌方节点、敌方线、x、y。小棋盘填充到 120 点，再加入棋盘尺寸和连续跳过计数，共 842 维。网络是 842→512→512→121，隐藏层使用 ReLU；121 个输出为预留的动作空间。

DQN 导出的动作头输出 Q 值；PPO、SAC、GAIL、GAN 导出策略 logits。当前推理器用真实引擎的合法点索引过滤，再做稳定 softmax 并排序，不在每次落子时执行反向传播。DQN 的 softmax(Q) 只是排序用的先验，不能解释为 Q 值天然就是概率。PPO、GAIL、GAN 资产还可带价值头，但这条直接选步路径没有用它做树搜索。

当前 ModelFreeAI 在同一合法 softmax 中保留落子与显式 PASS 槽，因此有合法落点时也可能首选主动 PASS。完整动作分布的 prior 和为 1，截取前几个候选后不保证仍为 1。产品 Worker 随后应用共享 PASS 检查；该运行时修正没有重训这些双人神经权重。

```text
01 Encode <=120 triangular points into 7 features each; pad missing points
02 Append size and pass count -> 842-dimensional vector
03 ReLU(W1*x+b1) -> ReLU(W2*h+b2) -> 121 action outputs
04 DQN reads Q-head weights; other families read policy-head weights
05 Softmax over legal indices including the PASS slot
06 Return explicit placement and PASS candidates; sort by prior
07 Product Worker applies the shared bounded PASS-discipline check
```

源码摘录：真实合法落子与 PASS 使用同一 softmax 分母，返回显式动作类型；完整分布归一化，截取 top-N 后无需重新归一化。共享检查不改写这些模型的神经权重。

```javascript
    return { priors: legal.map((index, order) => index < engine.validPositions.length
      ? { type: "move", point: [...engine.validPositions[index]], actionIndex: index, prior: exp[order] / total }
      : { type: "pass", point: null, actionIndex: engine.validPositions.length, prior: exp[order] / total }) };
```

源码定位：web/web前端/ModelFreeAI.js → encode, forwardBody, logits, evaluate, ModelFreeAI.getTopMoves。

### 3.7 训练源码与损失

本次继续训练的对象是四个既有线性 parent：easy、three-v4 的线性基准、three-v1、hex-v1。继承的 16 个系数先除以原 temperature，再增加一个从 0 开始的 PASS 系数；新策略温度为 1。CNN、GNN 以及 DQN/PPO/SAC/GAIL/GAN 的神经权重不属于这次重训，固定深度 Minimax 也不是训练得到的模型。

新协议仅在原生自然终局给予奖励 R=sign(己方面积−最大对手面积)+0.1×面积差/总点数+0.01×己方面积/总点数，折扣系数 gamma=1；所有非终局奖励为 0，没有中间面积增量或时长奖励。截断对局不产生终局回报或参数更新。梯度样本须有实际完成至少三层、覆盖两轮真实对手行动且全部合法根含 PASS 的精确 Minimax 分析；它只决定固定防守掩码与样本资格，不替代环境奖励。

候选继续使用原生规则与完整历史；只有完成分析且防守掩码保留至少两个动作的选定状态才参与策略梯度，因此不能声称覆盖全部状态或尺寸。新覆盖仅用于 territory-v3，旧 v1/v2 证据与存档不改写。easy、three-v1、hex 的新 PASS 系数参与排序；three-v4 与困难路径保留原搜索并使用新落子系数，不把线性 PASS 分数混同于搜索价值。实际训练、独立评估、限定准入与发布分别由对应收据确认。

研究训练入口与 Web 推理入口分开。以下是当前可阅读的训练源码，不单凭文件同名推断现行二进制权重由这份源码生成；资产来源仍需 manifest/训练收据。研究环境与 Web 的规则和自动跳过语义也须另行比对。

DQNTrainer.update：从 replay 抽批量，在线 Q 在合法掩码内取 argmax，目标网络读取该动作 Q；使用 smooth-L1、梯度裁剪 5。下列原文固定采用负续局值，对应对手视角假设；自动跳过后是否仍换人应由训练状态约定验证。

```python
            next_online = self._masked_argmax(self.online(next_states), next_masks)
            next_values = self.target(next_states).gather(1, next_online.unsqueeze(1)).squeeze(1)
            target = rewards - self.config.gamma * (1.0 - done) * next_values
```

PPOTrainer.run_episode：保存动作、旧 log-prob 和价值；逆序计算带负续值/负续优势的 GAE，标准化优势，再多轮优化 clipped ratio。value_loss 先含 0.5，随后总损失又乘 0.5，故其均方误差总系数为 0.25；熵系数为 0.01。不要把默认 PPO 公式中的系数直接写成这个实现。

```python
            value_loss = 0.5 * (values_now - returns).square().mean()
            entropy = dist.entropy().mean()
            loss = policy_loss + value_loss * 0.5 - entropy * 0.01
```

SACTrainer.update：双 Q 与双目标 Q，按合法离散动作精确求和计算 soft value；目标同样采用负续值。Q 用平方误差，策略最小化 Σπ(α logπ−min(Q₁,Q₂))；目标参数用 τ 做软更新。推理只需要策略头，因此不能从运行时缺少 Q 网络推断训练没有双 Q。

源码定位：research/iclr2027/lifeline_rl/model_free/sac.py → SACTrainer.update。

GAIL/GAN：train_imitation_adversarial.py 从 greedy expert 收集数据；两种标签调用同一循环，主要改变种子偏移与元数据。D 输入“状态+动作 one-hot”，专家标签=1、生成动作=0。为避免离散采样的不可导步骤，生成器枚举全部动作，以概率加权计算下列期望，而不是对抽样动作直接求导。

```python
            rewards = torch.sigmoid(-discriminator(repeated_states, action_grid)).reshape(batch_states.shape[0], ACTION_COUNT)
            g_loss = -(probs * torch.log(rewards.clamp_min(1e-6))).sum(dim=1).mean()
```

这里的负号很关键：固定 D 时，最小化 −log σ(−D) 偏向较小 D，而专家正标签训练偏向较大 D。因此当前循环不能直接享有标准 GAIL 的模仿保证；两个名称也不等于两种独立算法。脚本在固定专家状态批次上更新，并非完整在线占用分布匹配；训练采样未在该循环应用合法掩码，Web 推理另做真实合法过滤。这些历史神经训练循环仅作源码说明；本次线性继续训练不修改这些循环或神经权重。

### 3.8 多人线性策略

三人 V1、V2 与六边形 V1 首先对每个真实合法候选试走一手，比较动作前后的棋盘，再提取 16 维特征。特征是己方节点、覆盖、可达空间；这三项相对最强对手的领先量；清除的敌方节点与覆盖；自身节点与覆盖增量；切线标记；落在己方线上的标记；离起点距离；中心程度；己方前沿空点数；相对对手的前沿领先量。

数量按棋盘总点数归一化，距离与中心性使用相应棋盘几何。模型用 score=(w·features)/temperature 排序，再以 softmax 得到 prior。同分时用固定坐标顺序保证可复现。这里既有训练得到的权重，又有人工定义的特征；它不是 CNN，也不是把双人模型随便换个颜色就变成六人模型。

三人及更多人的对局不能直接套用“双人零和”的结论。多人特征把自己与最强对手比较，也统计所有对手损失；某次切断可能帮到第三方。因此选择不同的对手模型或后续推演方法，会改变推荐行动。小程序按人数、形状、边长筛选策略，V2 和六边形搜索 V5 保留实验标记。

```text
01 Save S and before-move metrics for all players
02 For each real legal placement a:
03   play a; measure nodes, coverage, reach, capture and frontier changes
04   normalize the 16-feature vector; score = dot(w,features)/temperature
05   restore S
06 Stable rank by score and coordinate; softmax -> prior
```

源码定位：web/web前端/ThreePlayerAI.js / HexPlayerAI.js → feature extraction, candidate scoring, getTopMoves。

### 3.9 三人 V4

three-player-search-v4-round12 在三角三人局中先用线性策略选出前三个根候选，再分别假设其他玩家遵循 V1 或 V2 策略。根玩家后续按自己的基准策略行动；每条分支在根动作之后继续最多 12 个行动层，或提前到达终局。候选不足三个就只检查实际数量，只有一个时直接返回。

每个叶子都计算精确离散领土。非终局强度为 area+0.3×coverage+0.05×reach，经温度为 0.12×棋盘点数的 softmax 得到相对偏好；终局则按最高领土给领先者分配 1/并列人数，其余为 0。另记录与最强对手的领土差。两种对手假设下的分数求平均，再按领土差、基准分和坐标破同分。

如果搜索首选比原基准首选的平均分提高不到 0.02，就保留原首选，避免微小波动改变决策。当前小程序 V4 入口支持边长 5、7、9；其他尺寸使用兼容列表中的策略。这里的平均是对所选两种对手策略的平均，不是对全部可能对手的保证，也不是一次完整的三人均衡求解。

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

源码定位：web/web前端/ThreePlayerSearchAI.js → positionUtilityV4, ThreePlayerSearchAI.getTopMoves。

### 3.10 六边形 V5

hex-player-search-v5 是可选实验搜索，面向六边形 4–6 人、边长 5 或 7。它先用 V1 权重排序，只在与首选分差不超过 0.4 的候选中保留至多两个。合法点不超过 6，或候选涉及吃子、切线、覆盖增长至少 3 点等战术条件时，才启动复核；安静局面或首选明显时沿用基础策略。

每个根候选试走后，让后续对手按 V1 依次应对，最多 5 个行动层；轮回根玩家、终局或同一对手再次出现时停止。行动顺序读取真实引擎，不能假定六个人始终都还有合法点或都没有认输。

非终局叶子用 0.7×reach+0.3×coverage 衡量强度；因为 reach 包含已占格点，它也等于 coverage+0.7×可达空点。再以 0.15×棋盘点数为温度做 softmax。这是快速偏好，不是正式领土或校准胜率。终局叶子才强制计算精确 area。

候选比较先区分已确认的模拟胜局、未终局分支、已确认的模拟败局，再比较各自值；普通改选还需要至少 0.03 的改善。这样不会把启发式 0.9 误当成比真实终局胜利更可靠。但“确认”只针对该条 V1 应对分支，不代表已经防住所有其他走法。

```text
01 Rank by V1; retain <=2 roots within base-score gap 0.4
02 If quiet and legal count >6: return base ranking
03 For each retained root: restore isolated state and play it
04 Simulate <=5 V1 replies, stopping at terminal or return/repeated actor
05 Terminal -> exact area; otherwise -> 0.7*reach+0.3*coverage
06 Compare terminal tiers, then values; ordinary switch needs >=0.03
07 Restore the source engine and its territory cache
```

源码定位：web/web前端/HexFastSearchAI.js → evaluateHexFastLeafV5, chooseHexFastSearchLeafV5, getTopMoves。

### 3.11 后续多人搜索

后续 Web 开发实现又加入简单、中等、困难和终极候选四类入口。简单使用训练过的 16 特征线性策略；中等复用三人 V4 或六边形 V1，并加速等价的候选与特征计算；原生形状的困难使用对手各自按自身策略行动的 rollout。这些新路径与小程序当前的 V1、V2、V4、V5 菜单要分开看，写进本文不代表已全部装入你手机里的版本。

这条后续 rollout 的叶子重新调用正式领土计算，结合覆盖、可达空间形成非终局偏好。对手按自己的策略选择动作，不假定所有人合谋压低根玩家的分数。非默认形状另有 MultiplayerMinimaxAI：使用保守的 paranoid 假设，把所有其他行动方视为 MIN，带 α–β、主动 PASS、迭代加深和完整阶段回退；其非终局评价是相对节点、覆盖与可达优势，终局使用精确领土。两种对手假设各有局限。

截至 2026-10-23 所查 Web 源码，困难的原生形状路径以 650 ms 为目标预算，按 12、24 层比较全部合法根落点及主动 PASS；只有阶段内所有根完成同一组应对/层数比较，才发布该完整阶段。超时退回上一完整阶段或基准策略；单次同步规则操作可能越过目标时限。

终极候选先用迁移 GNN 给合法落点先验，推理时间计入预算；后续检查 12、24、36 层，设置 publishCompletedComparisons=true。它可以在整轮尚未结束时，发布与固定阶段基准在相同深度/完整应对前缀上已经完成的改进；不能写成“每次都完成全根扫描”。不足预算时回退到 GNN 合法落点 argmax，仅无落点才 PASS，不用未经训练的 PASS/value 头作回退。

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

非默认形状的 MultiplayerMinimaxAI 使用 paranoid α–β、主动 PASS、迭代加深与完整迭代回退。多人 GNN 把敌方节点/线/起点与关系合并编码，并不显式表示各敌方身份。LocalAIModes.js 的 MULTIPLAYER_ULTIMATE_AVAILABLE 当前为 false，运行器为 application-candidate；文档纳入实现不等于推广或手机发布。

源码定位：web/web前端/MultiplayerRuntime.js / MultiplayerRollout.js / MultiplayerSearch.js / MultiplayerModel.js → loadMultiplayerRuntime, getTopMoves, canonical leaf evaluation, publication policy。

### 3.12 调度与可复现性

小程序把 AI、提示、领土与复盘任务放进同一个 Worker 调度队列。请求按优先级和请求编号串行处理，避免同时创建多个普通 Worker。返回值必须匹配请求编号和完整上下文；新局、悔棋、切换复盘或取消任务后，旧 Worker 的迟到结果会被丢弃。

当前调度器默认 15 秒超时。超时、Worker 异常或进程被系统结束时，解绑并终止该 Worker，向会话报告失败，保留可恢复棋局并允许重试。后台搜索不能堵住 Canvas 的触摸与绘制，也不能把失败偷偷改成另一个 AI 的成功。

Worker 内恢复局面时可缓存同一配置、同一动作前缀的引擎，只补放新增动作；任一前缀或配置不匹配就重新恢复。缓存必须保留完整历史，异步模型加载期间的引擎也不能被后来的请求修改。AI 选步、提示和复盘分析复用同一种算法；普通选步返回首选，分析可返回前三个候选及其评分含义。

执行前再次核对局面身份与行动方，并让真实引擎验证落点。Web 有独立 AI／提示／领土 Worker 的组织方式，小程序采用单队列适配；两端共享规则，不意味着线程数量和调度代码必须相同。

模型加载先检查清单中的 ID、规则、人数、棋盘范围、张量名称、维度、偏移和权重长度，再检查数值有限性与资产完整性。小程序分包提供双人二进制模型，小型多人 JSON 策略嵌入 Worker；它们都要绑定到明确的模型身份，不能因为文件名类似就混用权重。

普通对局只做推理，不在手机上训练网络。允许“帮 AI 学下棋”收集完整对局，也不意味着本局落子会立刻修改当前模型。离线训练、候选评估、实际选用和发布是不同步骤；研究训练环境、Web 和小程序也必须分别核对规则版本，不能只看名字都叫 LIFELINE。

存档与棋谱保存配置和动作；恢复时通过同一规则引擎重放，重建节点、边、历史和轮转。导入先在隔离局面中校验，成功后才替换正在看的棋局。悔棋、复盘试走和 AI 搜索同样需要完整恢复，不能只把棋子颜色画回去。

要复现一次 AI 决策，至少记录规则版本、棋盘配置、完整动作或规则状态与历史、行动方、模型 ID／资产哈希、搜索参数和随机种子（若使用随机算法）。截图可用于解释面积，却不足以复现所有合法性和选步；固定时间预算的搜索还可能随设备速度停在不同的完整阶段。

```text
01 Request <- {id, revision, rules, actor, config, full state/actions, model}
02 Queue in the single Mini Game Worker; reject cancelled/stale tasks
03 Restore engine (reuse only an identical config and action prefix)
04 Validate model identity, dimensions, lengths and asset integrity
05 Run the selected strategy; report candidates and metric meaning
06 Receiver checks request/context again and validates the chosen action
07 On timeout/error: preserve recoverable match and expose retry
```

把“模型名称、训练循环、导出文件、运行时策略、证据等级”分别记录，是排查结果差异的最短路径。完整状态与完整比较条件是算法合同；目录、分页、公式的显示则属于阅读合同。两篇文章可独立维护叙述，但关键公式、预算和源代码引用必须随版本重新核对。

源码定位：web/web前端/AIStateProtocol.js / ReplayCodec.js → state identity, full restoration and isolated replay validation。
