import { p, m, c, s, ch } from './GuideArticleFormat.js?v=20261029-unified-r1';

// Mathematical derivations and their scope are authored by the primary agent.
// Implementation reports must not turn a sufficient certificate into a full
// game solver, or a finite tactical test into a general strength theorem.
export const TOPOLOGY_MATH_CHAPTER = ch('topology',
  '第四章 拓扑棋盘：三角剖分与代数拓扑',
  'IV. Topology boards: triangulation and algebraic topology',
  p('先把“画在哪里”与“什么是同一个点”分开。展开图用于操作，三角面粘合后的商空间定义棋盘；落子、路径、计分、显示和 AI 分别使用这个对象的不同结构。本章依次给出直觉、例子、定义、命题及证明，说明哪些是数学定理、哪些是现有游戏约定、哪些只是策略启发。',
    'Separate where a point is drawn from which point it is. The atlas is an interface; a quotient of triangular faces defines the board. Moves, paths, scoring, display and AI use different structures on that object. Intuition, examples, definitions, propositions and proofs distinguish theorems, game conventions and strategic heuristics.'), [
  s('play', '4.1 从展开图进入一局', '4.1 Playing from an atlas', [
    p('在玩家、先手与边长之后选择棋盘形状；拓扑棋盘展开预设、随机与自定义入口。边长 5–15 同步缩放点阵。随机起点会给每个现存玩家重新分配一个点；添加随机起点只给所选方增加一个，手动点选仍可维护每方 1–6 个起点。同一规范点的多个副本不是多个棋位，落子、删除、高亮和计分都须同步。',
      'Choose the shape after players, first player and size. Topology reveals presets, random boards and the editor; size 5–15 scales the lattice. Random starts replace the layout with one per active player. Add random start appends one for the selected player; manual selection still supports 1–6 per player. Copies of one canonical point are one playable point and share occupation, deletion, highlighting and scoring.'),
    p('画边界可连续添加闭合轮廓，以奇偶填充表示内部与孔洞；粘边选两条边界单位边及各自方向。实线是真实边界，编号虚线与箭头是对应接缝。先粘边再加轮廓也要重新验证；只保留仍存在且合法的配对，不把内部格边擅自当成切口。完整 JSON 放在折叠工具中。双把手以正反两片展开，共同组成一个棋盘。',
      'Draw boundary adds closed contours with even-odd interior and holes. Gluing selects two boundary unit edges and their directions. Solid lines are real boundaries; numbered dashed arrows pair seams. Adding contours after gluing revalidates pairs and preserves only those still valid; an internal edge is not silently cut. Full JSON tools are collapsed. A double torus uses front and back charts of one board.'),
    p('原有不交叉、沿三角方向、三点限制、实际切断时的例外、禁区、断联与 Superko 都继续生效。极点可以有多个真实方向：线到极点停止，下一条线可从任一实际扇区出发，不自动拐弯。复盘与导入保存完整定义、路径、起点、行动方和历史，验证失败不能覆盖进行中的棋局。',
      'Noncrossing triangular-direction play, the three-point restriction and actual-cut exception, protection, disconnection and Superko still apply. A pole may have several actual sectors: an incoming line stops there and a new line may leave through any actual sector. Replay and import retain the complete definition, paths, roots, actor and history; failed validation cannot replace an active match.'),
  ]),
  s('complex', '4.2 三角面、胞腔与商空间', '4.2 Triangles, cells and quotient spaces', [
    p('直觉：先剪出有限张小三角纸片，再按带方向的边逐段贴合。以 X 表示不交并的三角面，K=X/∼ 表示按端点映射粘合后的空间。零维胞腔是规范顶点，二维胞腔是三角面；一维胞腔按边的粘合等价类记录，不能只按两个端点去重。两条端点相同但绕行不同的边，是不同的一维胞腔。只有邻接图会丢掉这些信息，也无法区分三角形边框和填满的三角形。',
      'Imagine gluing finitely many triangular sheets along directed edge segments. Let X be their disjoint union and K=X/~ the endpoint-matched quotient. Canonical vertices are 0-cells, triangles are 2-cells, and edge equivalence classes are 1-cells. Two distinct edges with the same endpoints remain different cells. Adjacency alone loses them and cannot distinguish a triangular frame from a filled triangle.'),
    m(String.raw`K=\left(\coprod_{f\in\mathcal F}\Delta_f^2\right)\!\big/\sim,\qquad V=|K^{(0)}|,\quad E=|\mathcal E|,\quad F=|\mathcal F|.`,
      'K = disjoint triangular faces / gluing; V = canonical vertices, E = edge classes, F = faces.'),
    p('这是有限三角面粘合的胞腔／Δ 型表示，不应无条件叫“严格单纯复形”。严格单纯复形要求一个单纯形由顶点集唯一确定，两个单纯形的交是公共面；多重边已违反前一条件。需要时可适当细分成满足这些条件的三角剖分。游戏目前只支持有限、分段线性的边附着，不支持任意维 CW 复形或任意连续附着映射。',
      'This is a finite triangular cell/Delta-type representation, not automatically a strict simplicial complex. In a simplicial complex a vertex set determines a simplex and intersections are common faces; parallel edges already violate the first condition. Suitable subdivision may give a strict triangulation. The game supports finite piecewise-linear edge attachments, not arbitrary-dimensional CW complexes or arbitrary continuous attaching maps.'),
    p('工程对应：BoardDefinition 保存面、边发生项与端点方向；BoardCompiler 产生规范点与 edgeClasses；BoardPaths 保存整条逻辑路径及经过的格点。同一对端点不再唯一指定路径。图册副本只服务显示和命中，不能变成额外棋子或额外得分。',
      'BoardDefinition stores faces, edge occurrences and endpoint directions; BoardCompiler produces canonical vertices and edgeClasses; BoardPaths retains complete logical routes. Endpoints no longer uniquely identify a route. Atlas copies serve rendering and hit testing, never extra pieces or points.'),
  ]),
  s('link', '4.3 什么情况下真的是曲面', '4.3 When the complex is a surface', [
    p('直觉：围着一个顶点画一个足够小的圈，观察它与相邻三角面相交的“顶点链环” link。内部点应看见一整圈，边界点应看见一条区间。命题 T1：在当前有限纯三角面粘合中，若边只邻接一或两个面，且每个顶点的 link 是一个圆或一条区间，则每点分别有圆盘或半圆盘邻域，K 是带边界的紧二维曲面。',
      'A small neighborhood around a vertex meets adjacent triangles in its link. An interior link should be one circle; a boundary link, one interval. Proposition T1: for this finite pure triangular gluing, if every edge has one or two incident faces and every vertex link is a circle or interval, each point has a disk or half-disk neighborhood, so K is a compact surface with boundary.'),
    p('证明：面内点显然有圆盘邻域；一／二面相邻边内点有半圆盘／圆盘邻域；顶点的星形邻域是其 link 的锥，圆的锥为圆盘，区间的锥为半圆盘。有限个闭面保证紧性。分叉或多个不连通 link 产生非流形顶点；它们可以属于自定义复形，但不得标为随机曲面。六价不是流形条件，球面极点虽非六价仍可有圆形 link。',
      'Proof: face interiors have disk neighborhoods; edge interiors have half-disks or disks according to incidence. A vertex star is the cone on its link, giving the required neighborhood. Finitely many closed faces give compactness. Branched or disconnected links produce nonmanifold points, allowed in a custom complex but not labeled a random surface. Valence six is not the manifold criterion: a sphere pole can have a circular link at another valence.'),
    p('把每个面任选方向，通过公共边传播相邻面方向；传播发生矛盾就是不可定向。真实边界由只邻接一个面的边组成，边界分量按带重数的边图数圈。连通紧曲面的分类给出：可定向时 χ=2−2g−b；不可定向时 χ=2−k−b。g 是把手数，k 是交叉帽数，b 是真实边界圈数。圆柱有 b=2、g=0，莫比乌斯带有 b=1、k=1；平面挖两个洞有 b=3、g=0，双把手闭曲面则是 b=0、g=2。',
      'Orient faces and propagate signs across common edges; a contradiction detects nonorientability. Real boundary edges have one incident face; boundary circles use incidence multiplicities. Surface classification gives chi=2−2g−b when orientable and chi=2−k−b otherwise. Here g counts handles, k crosscaps and b real boundary circles. A cylinder has b=2,g=0; a Möbius strip b=1,k=1; a plane region with two holes b=3,g=0; a closed double torus b=0,g=2.'),
  ]),
  s('curvature', '4.4 六邻接为什么不能覆盖所有曲面', '4.4 Why valence six is not universal', [
    p('命题 T2：在紧三角剖分曲面上，度数按边发生重数计，内部顶点集合为 V°，真实边界顶点集合为 V∂，则有下面的离散高斯—博内恒等式。闭曲面时第二项消失，所以处处六价强迫 χ=0；球面或亏格大于一的闭曲面必须出现非六价顶点。',
      'Proposition T2: for a compact triangulated surface, count degrees with edge multiplicity and separate interior from boundary vertices. The following discrete Gauss–Bonnet identity holds. On a closed surface the boundary term disappears; valence six everywhere forces chi=0, so spheres and closed surfaces of genus greater than one need exceptional vertices.'),
    m(String.raw`\sum_{v\in V^\circ}(6-\deg v)+\sum_{v\in V^\partial}(4-\deg v)=6\chi(K),\qquad\chi(K)=V-E+F.`,
      'Σ interior (6−degree) + Σ boundary (4−degree) = 6χ; χ=V−E+F.'),
    p('证明：令 E∂ 为边界边数，三角面边计数给出 3F=2E−E∂，握手恒等式给出 Σdeg=2E，边界是圈故 E∂=|V∂|。因此 6χ=6V−2E−2|V∂|，正是左侧。若把三角面看成等边三角形，则内部角亏为 (π/3)(6−deg)，边界转角为 (π/3)(4−deg)，总和为 2πχ。这是内在离散度量的曲率，不是屏幕上 3D 网格的视觉弯曲度。',
      'Proof: triangle incidences give 3F=2E−E_boundary, the handshake identity gives sum degree=2E, and boundary circles give E_boundary=V_boundary. Thus 6chi=6V−2E−2V_boundary, the stated sum. For equilateral faces, interior angle defect is (pi/3)(6−degree) and boundary turning is (pi/3)(4−degree), totaling 2pi chi. This is curvature of the intrinsic discrete metric, not visual bending in a 3D preview.'),
  ]),
  s('homology', '4.5 用链复形计算洞，而不是猜外观', '4.5 Computing holes with a chain complex', [
    p('直觉：若把一堆三角面涂黑，两两相邻的公共边会抵消，只留下外轮廓。为避免不可定向曲面上的正负号，工程先用二元域 F₂：出现偶数次为 0，奇数次为 1。C₀、C₁、C₂ 分别以规范顶点、边等价类、面为基；∂₁把边映到两端点，∂₂把面映到三条边。每个三角面的每个顶点恰出现两次，所以 ∂₁∂₂=0。',
      'Intuition: shade several triangles; shared sides cancel, leaving a boundary. The implementation uses F2 so even incidences cancel without orientation signs. C0, C1 and C2 have bases given by canonical vertices, edge classes and faces. d1 maps edges to endpoints, d2 faces to their three sides. Each triangle vertex appears twice, proving d1 d2=0.'),
    m(String.raw`C_2\xrightarrow{\partial_2}C_1\xrightarrow{\partial_1}C_0,\quad H_j=\ker\partial_j/\operatorname{im}\partial_{j+1}.\quad \beta_0=V-r_1,\ \beta_1=E-r_1-r_2,\ \beta_2=F-r_2.`,
      'C2 →d2 C1 →d1 C0; Hj=ker dj / im d(j+1). For rj=rank dj: β0=V−r1, β1=E−r1−r2, β2=F−r2.'),
    p('命题 T3：上式由线性代数的秩—零度定理直接成立；相减得 β₀−β₁+β₂=V−E+F。β₀数连通分量，β₁数独立的一维模二洞，β₂数无边界的二维模二周期。连通球面是 (1,0,1)，环面 (1,2,1)，双把手 (1,4,1)，圆盘 (1,0,0)，圆柱与莫比乌斯带都是 (1,1,0)。克莱因瓶与环面同为 (1,2,1)，因此 F₂ 同调不足以区分它们，必须另查可定向性；整数同调还会看到克莱因瓶的二阶扭结。',
      'Proposition T3 follows from rank–nullity; subtracting gives beta0−beta1+beta2=V−E+F. Beta0 counts components, beta1 independent mod-two one-dimensional holes, beta2 mod-two 2-cycles. The sphere gives (1,0,1), torus (1,2,1), double torus (1,4,1), disk (1,0,0), cylinder and Möbius strip both (1,1,0). Klein bottle and torus both give (1,2,1); F2 homology cannot distinguish them, whereas orientability does. Integer homology additionally detects the Klein bottle’s order-two torsion.'),
    p('工程实现 TopologyAlgebra 用位列与异或消元精确求秩，并逐面检查边界的边界为零。它也能计算相对链复形 C*(K,∂K)：把真实边界顶点与边的基向量商掉。这样一条连接两处真实边界的弧可能成为相对周期，却不是普通闭线。它是分析／校验工具，不能直接替换游戏的领土泛洪。',
      'TopologyAlgebra uses exact bit columns and XOR elimination, checking boundary squared face by face. It also computes relative chains C*(K,boundary K) by quotienting boundary vertices and edges. An arc ending on the real boundary can be a relative cycle without being an ordinary closed line. This is a diagnostic and validation tool, not a replacement for territory flood fill.'),
  ]),
  s('separation', '4.6 闭线、分离、可缩并不是一回事', '4.6 Closed, separating and contractible differ', [
    p('命题 T4：在连通闭曲面上，一条嵌入的单闭曲线 c 分离曲面，当且仅当 [c]=0∈H₁(K;F₂)。这里必须是单条嵌入圆，并且没有真实边界；不能套到自交线、多条线任意相加或一般非流形复形。工程 analyzeEdgeCycle 只有核实这些条件才返回 separating，否则给出 null，避免把未知当成否。',
      'Proposition T4: on a connected closed surface, one embedded circle c separates exactly when [c]=0 in H1(K;F2). It must be a single embedded circle with no real boundary on the ambient surface. This is not a blanket test for self-crossing chains, sums of circles or nonmanifold complexes. analyzeEdgeCycle returns separating only after checking the hypotheses, otherwise null.'),
    p('证明：若分离，取其中一侧全部三角面，其模二边界恰为 c。反过来，若 c=∂₂A，则不在 c 上的公共边两侧面的 A 系数相同，c 上的两侧系数不同。任意避开 c 的路径不能从系数 0 的区域跨到 1 的区域；局部圆盘与嵌入条件确保两侧均存在，故补空间不连通。这个证明也解释了为何模二系数能处理不可定向曲面。',
      'Proof: if c separates, the mod-two sum of faces on one side has boundary c. Conversely, when c=d2 A, adjacent face coefficients agree across every side outside c and differ across c. A path avoiding c cannot pass from coefficient 0 to 1. Disk neighborhoods and embeddedness ensure both sides exist, so the complement disconnects. Mod-two coefficients make this argument independent of orientability.'),
    p('环面的经线是闭线但不分离；双把手中间的腰圈分离且零同调，却不可缩成一点。后者两边各有一个带边界把手，都不是圆盘。因此“零同调”不能写成“没有绕行”或“可缩”。有真实边界时要另处理边界或相对同调；游戏直接用完整离散邻接与真实边界判断，不靠屏幕内外或一句闭线判据。',
      'A torus meridian is closed but nonseparating. The waist separating two handles is null-homologous and separating yet not contractible: neither side is a disk. Thus null-homology does not mean no winding or contractibility. Surfaces with boundary need boundary-aware or relative arguments. The game instead uses its full discrete adjacency and actual boundary, never screen-inside/outside alone.'),
  ]),
  s('territory', '4.7 离散领土、连续面积与围困', '4.7 Discrete territory, display area and confinement', [
    p('令 G 为规范格点邻接图，Wᵢ 为己方节点和线点，Oᵢ 为敌方占点，B 为真实边界点。令 Q 遍历 G−Wᵢ 的连通分量。当前正式规则如下；三角／六边棋盘是有外边界的特例。闭曲面 B=∅，仍须逐分量排除敌方。含敌人的封闭小块是围困目标，不是已获得的安全领土。',
      'Let G be canonical sample adjacency, Wi friendly node/line samples, Oi enemy samples, and B the real boundary samples. Iterate components Q of G−Wi. The official rule below includes triangular and hexagonal boards as bounded cases. On closed surfaces B is empty, but enemy components still must be excluded. An enclosed enemy pocket is a confinement target, not already owned safe territory.'),
    p('闭曲面没有真实边界：如果某个剩余连通分量不含敌方元素，它就按这条离散约定计分，即使屏幕上看不出被围住；若分量含敌方元素，整块不计分。这是游戏规则，不是由曲面的几何面积自动推导出的结论。',
      'A closed surface has no real boundary. Under this discrete convention, any remaining component without enemy elements scores even when it does not look enclosed on screen; a component containing an enemy is excluded in full. This is a game rule, not a consequence of geometric surface area.'),
    m(String.raw`R_i=W_i\cup\!\bigcup_{\substack{Q\in\pi_0(G-W_i)\\Q\cap B=\varnothing,\ Q\cap O_i=\varnothing}}Q,\qquad a_i=\sum_{v\in R_i}w_v.`,
      'Ri = Wi ∪ components Q of G−Wi with Q∩B=∅ and Q∩Oi=∅; ai=Σv∈Ri wv (unit weights by default).'),
    p('命题 T5：多源 BFS 与逐分量敌方检查恰好得到 Rᵢ，复杂度为 O(|V|+|E_G|)。证明由 BFS 的可达性不变量：入队点都有源路径，每个可达点沿最短源路径逐层入队。对每个剩余分量扫描敌方标记即可。这是图的零维连通性／H₀计算；未经额外细分与对应证明，它不等于连续曲面补空间 K−Wᵢ 的拓扑，也不等于二维面积。',
      'Proposition T5: multi-source BFS plus enemy checks produces exactly Ri in O(|V|+|E_G|). Every queued vertex has a source path and induction along shortest paths reaches every accessible vertex; inspecting remaining components completes the rule. This is graph connectivity/H0, not automatically the topology of the continuous complement K−Wi or its geometric area.'),
    p('显示可以保留凸包与收紧的势力范围，但最终必须与实际棋盘面片取交，扣掉孔洞，不能跨出真实边界；接缝处使用同一面的所属关系映射到 3D。线点计入离散分数不意味着要把单根线涂成一片领土。凸包显示、连续阴影面积与正式 aᵢ 分开，不能用 3D 像素数决定胜负。',
      'Display may retain hull and tightening influence, but intersects it with the actual board faces, excluding holes and real exterior. Seam and 3D mapping use the same face identity. Counting line samples does not require filling a ribbon along a lone line. Hull shading, geometric display area and official ai remain separate; rendered pixels never decide the winner.'),
  ]),
  s('straight', '4.8 拓扑不指定直线', '4.8 Topology does not specify straightness', [
    p('同一个环面可以带很多度量；仅知道它有一个把手，不知道什么叫直线。现规则额外选择等边三角网的六方向、接缝端点与面侧确定的方向变换、特殊顶点停止规则。跨缝保存的是局部方向变换和真实路径，不是把两个屏幕端点直接连线。莫比乌斯带的一次绕行会翻转局部标架，不能丢掉这个方向信息。',
      'A torus admits many metrics; knowing it has one handle does not define a straight line. The game additionally chooses six triangular directions, seam transport determined by endpoints and incident-face side, and stopping at special vertices. A crossing stores direction transport and the actual path, not a screen-space endpoint chord. One trip around a Möbius strip reverses a local frame, which must be retained.'),
    p('因此合法直线路径、给定同调类的最短路、全局测地线是三个问题。当前实现只承诺第一种离散延续，极点停止是明确玩法而不是微分几何定理。检查反向过缝变换互逆、同一物理路径去重、同端点不同绕行不合并，才能让切断、断联和复盘一致。',
      'A legal discrete straight route, a shortest route in a homology class and a global geodesic are different problems. Only the first continuation rule is implemented; stopping at a pole is a game convention. Inverse seam transport, physical-route deduplication and retaining distinct same-endpoint routes keep cuts, disconnection and replay consistent.'),
  ]),
  s('double', '4.9 双把手的确定构造与无自交 3D', '4.9 A constructive double torus and embedded 3D', [
    p('本项目构造：取连通平面三角区域 D，挖 h 个互不接触且不碰外边界的孔。复制正反两份，沿每条对应真实边界边粘合，称为 Double(D)。命题 T6：它是连通、闭合、可定向的亏格 h 曲面。证明：两片内部仍为圆盘邻域，边界的半圆盘成对粘成圆盘；把背面方向翻转后接缝方向一致。边界是 h+1 个圆，χ(∂D)=0，故 χ(Double(D))=2χ(D)−χ(∂D)=2−2h，由分类得亏格 h。',
      'Project construction: take a connected planar triangulated region D with h disjoint holes away from the outer boundary. Glue front and back copies along every corresponding boundary side: Double(D). Proposition T6: this is a connected closed orientable surface of genus h. Interior neighborhoods remain disks and paired half-disks become disks. Reversing the back orientation makes orientations consistent. The h+1 boundary circles have Euler characteristic zero, giving chi(Double(D))=2chi(D)−chi(boundary D)=2−2h and hence genus h.'),
    m(String.raw`\chi(D)=1-h,\qquad\chi(\operatorname{Double}(D))=2-2h,\qquad h=2\Longrightarrow(\chi,\beta_0,\beta_1,\beta_2)=(-2,1,4,1).`,
      'χ(D)=1−h; χ(Double(D))=2−2h. For h=2: χ=−2 and F2 Betti=(1,4,1).'),
    p('3D 不猜一个看起来像双甜甜圈的外壳。只为渲染对 D 做重心细分，给真实边界顶点高度 0，所有内部细分点严格正高度，片内线性插值得到 t:D→[0,∞)，其零集恰为 ∂D。正反片分别映到 (x,y,+t) 与 (x,y,−t)。同一片投影是恒等映射而无自交；两片只可能在 t=0 处相遇，恰是已粘边界。所得商空间到三维像的连续双射由紧性成为同胚，故这是真实嵌入。',
      'Do not guess a shell that merely looks like two doughnuts. Barycentrically subdivide D for rendering only. Give true boundary samples height zero and all interior subdivision samples positive height; linear interpolation produces t with zero set exactly boundary D. Map sheets to (x,y,+t) and (x,y,−t). Each sheet projects identically without crossings; the sheets meet only at t=0, exactly the glued boundary. The resulting continuous bijection from the compact quotient to its image is a homeomorphism, proving an embedding.'),
    p('关键反例：内部边可能两端恰在边界；只给原顶点高度会把整条内部边压成零，额外捏合。内部边中点和面中心必须有正高度。每个渲染小三角保留原 faceId 与重心坐标，细分不新增落点或分数。克莱因瓶则不能无自交嵌入三维欧氏空间，显示应标明浸入／展开图，不能冒称同样的无自交实体。',
      'Critical counterexample: an interior edge can have both endpoints on the boundary. Heights on original vertices alone would collapse that whole edge to zero and pinch the sheets. Interior edge midpoints and face centers must be positive. Render triangles retain their source faceId and barycentric coordinates; subdivision adds no game samples or score. A Klein bottle cannot embed without self-intersections in Euclidean 3-space, so its immersion/atlas must be labeled accordingly.'),
  ]),
  s('stable', '4.10 连接后不会掉落：一个严格充分条件', '4.10 A sufficient certificate of permanent connection', [
    p('直觉：节点不能被敌人直接覆盖，线的内部线点却可以被切。视觉相邻、连了两条长线、甚至图上有两个独立端点路径，都不保证安全；同一次攻击可能切中共享格点并触发大块断联。我们只认证一个有完整证明的稳固核心。固定棋盘、起点和规则；悔棋、导入、修改设置不属于这里的后续合法对局。',
      'Nodes cannot be overwritten directly, while interior line samples can be cut. Visual adjacency, two long links or two endpoint-graph paths need not be safe: one attack can cut shared samples and detach a large structure. We certify only a core with a proof. Fix the board, roots and rules; undo, import and reconfiguration are outside subsequent legal play in this statement.'),
    m(String.raw`P_0=\text{己方起点},\qquad P_{t+1}=P_t\cup\{b:\exists e=(a,b)\in\mathcal L_i,\ a\in P_t,\ b\text{ 为己方节点},\ \operatorname{int}(e)\subseteq P_t\},\quad P_*=\bigcup_tP_t.`,
      'P0=friendly roots. Add endpoint b of an actual logical path from a∈Pt when b is a friendly NODE and every interior sample is already in Pt. Iterate to P*.'),
    p('命题 T7：P* 中的节点在任意后续合法对局中不会因切断而脱落。证明用认证层数归纳。根不丢失。假设路径起点和全部内部点已永久存在，它们均是己方节点，不能被合法落子占据；新认证端点本身也是节点。于是该逻辑路径不能被切，端点通过永久起点连回根，断联清理不能移除它。己方加点、跳过和认输也不会覆盖这些节点。重复归纳即得结论。',
      'Proposition T7: nodes in P* cannot be detached by cuts in any subsequent legal continuation. Induct on certification layers. Roots persist. If a path source and every interior sample are permanent friendly nodes, no legal placement can occupy them; its target is also a node. The path cannot be cut and keeps the target connected through its certified source to a root, so disconnection cleanup cannot remove it. Friendly placements, passes and resignations do not overwrite them. Induction completes the proof.'),
    p('没有内部点的相邻真实逻辑边是最简单的认证边。但内部存在一个尚未认证的己方节点也不能草率通过：它可能因别处断联消失，随后留下可切线点。RootStability 以依赖队列求这个最小闭包；复杂度 O(逻辑路径总长度＋节点数)。这是充分条件，不是必要条件，未认证绝不等于可被吃掉。AI 可奖励稳固核心增长，再用真实反击搜索评估其余连接。',
      'An actual adjacent logical edge with no interior samples is the simplest certificate. Even a friendly interior node cannot be assumed permanent before certification: it could disappear after another cut, exposing a line point. RootStability computes the least closure with a dependency queue in O(total logical path length + nodes). This is sufficient, not necessary; uncertified does not mean capturable. AI rewards growth of this core and tests other links with actual counterplay.'),
  ]),
  s('strategy', '4.11 长线策略与预算内证据', '4.11 Long-term strategy under a finite budget', [
    p('认证稳定性是无限后续都成立的局部结构结论，整个着法的好坏仍需比较面积、吃子、围困和对手回应。围困特征必须来自 G−Wᵢ 的真实分量，不能来自屏幕凸包；闭曲面没有外部，一个包含所有敌人的大分量本身不构成围困证据。保守地要求真实分离并检查较小敌方分量及其行动空间，且含敌方区域仍不直接计分。',
      'The certificate is an unlimited-continuation structural statement; move quality still depends on area, captures, confinement and replies. Confinement must use actual components of G−Wi, not a screen hull. Without an outside on a closed surface, a single large enemy component is not evidence of confinement. Conservatively require actual separation and inspect smaller enemy components and their action space; enemy regions remain unscored.'),
    p('搜索使用完整状态和历史，按实际存活行动方轮换，包含 PASS。迭代加深只能称已完成的深度；多人深度 d 不能冒充 d 轮对手行动。统一约 3 秒截止时间，合法步生成、策略、战术复核共享预算；保留已完成比较，过期结果不执行。原模型权重和身份保留，战术修正单独记版本。有限候选、单次回应、选择性推演都应标明覆盖范围，不能宣称永久安全或最优。',
      'Search retains full state/history, follows the surviving actors and includes PASS. Report completed depth, not requested depth; d plies in multiplayer are not d opponent rounds. Move generation, policy and tactical checks share an approximately three-second deadline, preserving complete comparisons and rejecting stale results. Model weights and identity remain intact, with a separately versioned tactical layer. Shortlists, one-reply checks and selective rollouts must disclose their scope, not claim optimality or permanent safety.'),
    p('拓扑通用 AI 是按规则试下的有界搜索，不继承固定棋盘模型的棋力等级；各方节点辅助项也不自动使双人估值严格零和。当前拓扑人机保持练习属性，不能把没有相同地图、起点、规则与预算对局校准的数值写入既有 AI 榜。反例回归证明功能，完整配对对局才提供所测分布上的棋力证据，两者分开报告。',
      'Topology General AI is bounded rule-based search, not an inherited fixed-board strength tier; node tie-breakers do not automatically make two-player evaluation zero-sum. Topology remains practice unless strength is calibrated under the same map, starts, rules and budgets. Counterexample regressions verify behavior; complete paired matches supply evidence on the tested distribution. Report these separately.'),
  ]),
  s('sampling', '4.12 随机曲面的概率到底是什么意思', '4.12 What a random-surface probability means', [
    p('不存在本游戏自动获得的“所有可三角剖分曲面上的均匀分布”：曲面类型、网格数量和细分次数都没有有限统一样本空间。我们明确选择有限混合模型，再在所选类别内部随机生成网格与起点。默认拓扑类概率：圆盘 30%，双边界可定向曲面 25%，三边界平面曲面 10%，莫比乌斯带 8%，环面 12%，克莱因瓶 5%，球面 5%，双把手 5%。双边界类内部再按平面环形 60%／圆柱 40%选择展示，不把它们冒充两个不同拓扑类。',
      'There is no automatic uniform distribution on all triangulable surfaces: types, mesh sizes and subdivisions do not form a fixed finite sample space. Use an explicit finite mixture, then generate a mesh and starts within its category. Defaults: disk 30%, orientable two-boundary surface 25%, planar three-boundary surface 10%, Möbius strip 8%, torus 12%, Klein bottle 5%, sphere 5%, double torus 5%. Within the two-boundary class choose planar annulus 60% or cylinder 40%; these are displays of one topology type.'),
    m(String.raw`\Pr(C=c\mid N,m,\mathrm{supported})=\frac{p_c\,\mathbf1\{c\in A(N,m)\}}{\sum_{d\in A(N,m)}p_d}.`,
      'P(category c | size N, players m, supported) = pc · 1{c∈A(N,m)} / Σd∈A(N,m) pd.'),
    p('A(N,m) 是当前生成器在该尺寸和人数下已验证支持的类别，不是所有数学上可能的类别。有限开局搜索找不到布局，不等于不可实现。先确认支持集合并归一化，再抽类别，之后只在该类别内有界重试；失败要显式返回，不能偷偷换成圆盘。记录请求分布、有效分布、排除原因、生成器版本、种子与完整定义。只有完整定义与哈希可稳定重放；旧 v1–v3 的种子序列保持不变。',
      'A(N,m) is the set supported and validated by this generator at that size/player count, not every mathematically possible category. Failure of a finite layout search is not impossibility. Determine support and normalize first, then draw a category and retry only within it. Report failure rather than silently substituting a disk. Record requested/effective probabilities, exclusion reasons, generator version, seed and full definition. Replay uses the full definition/hash; old v1–v3 seed sequences remain unchanged.'),
  ]),
  s('sources', '4.13 来源、适用范围与复核', '4.13 Sources, scope and verification', [
    p('基础参考：[Hatcher，Algebraic Topology，第 2 章](https://pi.math.cornell.edu/~hatcher/AT/ATch2.pdf) 给出链、边界与同调；[Erickson，Surface Classification](https://jeffe.web.engr.illinois.edu/teaching/comptop/2017/notes/surface-classification.pdf) 介绍曲面分类与多边形粘合。[CGAL Polygon Mesh Processing](https://doc.cgal.org/5.6.3/Polygon_mesh_processing/index.html) 可作网格检查工程参考，本项目未因此声称已经依赖 CGAL。T6 的双层高度构造和 T7 的规则稳定性证书在本章给出本项目推导；不把它们冒充上述书中的原文。',
      'References: [Hatcher, Algebraic Topology, Chapter 2](https://pi.math.cornell.edu/~hatcher/AT/ATch2.pdf) develops chains, boundaries and homology; [Erickson, Surface Classification](https://jeffe.web.engr.illinois.edu/teaching/comptop/2017/notes/surface-classification.pdf) covers classification and polygon gluing. [CGAL Polygon Mesh Processing](https://doc.cgal.org/5.6.3/Polygon_mesh_processing/index.html) is an engineering reference, not a claimed dependency. T6’s height construction and T7’s rule-specific certificate are project derivations supplied here, not quotations from those sources.'),
    p('代码复核对应：verify-topology-algebra 检查链条件、普通／相对同调、平行边与非分离圈；verify-root-stability 检查认证依赖、多个根与真实引擎的合法回复。随机双把手另核实 χ=−2、F₂ Betti=(1,4,1)、真实边界为零、link 全为圆以及 3D 接缝吻合。数学证明、数值回归、浏览器可用性与棋力实验是四种不同证据，不互相替代。',
      'Verification: verify-topology-algebra checks chains, absolute/relative homology, parallel edges and nonseparating cycles; verify-root-stability checks dependencies, multiple roots and actual-engine replies. Random double tori additionally check chi=−2, F2 Betti=(1,4,1), no real boundary, circular links and 3D seam agreement. Proofs, numerical regressions, browser usability and strength experiments are different evidence tiers.'),
  ]),
]);

export const TOPOLOGY_CODE_CHAPTER = ch('topology',
  '第四章 拓扑棋盘的工程实现', 'IV. Topology implementation',
  p('本章对应数学版第四章。所有算法以规范点、边等价类、面发生关系和版本化完整状态为输入；图册与渲染细分只作为派生视图。代码示意明确标为伪代码，精确实现以列出的模块为准。',
    'This corresponds to mathematical chapter IV. Algorithms consume canonical points, edge classes, face incidences and complete versioned state. Atlas and render subdivision are derived views. Snippets below are pseudocode unless stated otherwise; named modules contain the implementation.'), [
  s('compile', '4.1 编译与同调诊断', '4.1 Compilation and homology diagnostics', [
    p('流水线：输入定义 → 校验三角面与有向配对 → union-find 合并规范点／边发生项 → 保留多重边的 edgeClasses → 计算顶点 link、方向传播、真实边界 → TopologyAlgebra 的 F₂ 链矩阵。不能从 sampleAdjacency 重建一维胞腔，因为它会合并平行边。诊断按不可变 compiledBoard 缓存，不进入每手正式计分。',
      'Pipeline: definition → triangle/directed-pair validation → union-find on vertices/edge occurrences → edgeClasses retaining multiplicity → vertex links, orientation and true boundary → F2 chains in TopologyAlgebra. sampleAdjacency cannot reconstruct 1-cells because it merges parallel edges. Diagnostics cache immutable compiled boards and do not enter per-move official scoring.'),
    c(`// Pseudocode; see TopologyAlgebra.js
for each edge class e: d1[e] = XOR(bits of canonical endpoints)
for each face f: d2[f] = XOR(bits of its edge occurrences' classes)
assert d1 * d2 == 0
r1, r2 = exact_GF2_column_rank(d1), exact_GF2_column_rank(d2)
betti = [V-r1, E-r1-r2, F-r2]
assert betti[0]-betti[1]+betti[2] == V-E+F
classify genus only if connected && all vertex links are circles/intervals`, 'text'),
    p('analyzeBoardAlgebra(board,{relativeBoundary}) 返回 field、cellCounts、boundaryRanks、betti、chainCondition、Euler 与曲面诊断。相对版本删除边界胞腔的基向量，不能只删显示轮廓。analyzeEdgeCycle 对输入边 ID 按奇偶消去，先验是否为周期，再判断是否属于 im∂₂；separating 仅在闭合连通曲面的单嵌入圈上解释。当前不计算整数 Smith 标准形，因此不输出扭结群。位消元是多项式诊断，不应把它描述成线性时间。',
      'analyzeBoardAlgebra(board,{relativeBoundary}) returns field, cellCounts, boundaryRanks, betti, chainCondition, Euler and surface diagnostics. Relative chains remove boundary-cell basis vectors, not display contours. analyzeEdgeCycle cancels repeated edge IDs modulo two, checks cyclehood, then image membership under d2; separating is interpreted only for one embedded circle on a connected closed surface. Integer Smith normal form and torsion groups are not implemented. Bit elimination is a polynomial diagnostic, not a linear-time claim.'),
  ]),
  s('stable', '4.2 稳固核心与战术层', '4.2 Certified roots and tactical evaluation', [
    p('RootStability.computeRootStability 只读现有节点与真实逻辑路径；普通棋盘适配显式端点边及内部格点，拓扑棋盘直接读 topologyPaths，不能只调用 getLinePoints(a,b) 猜多重绕行。使用依赖计数：每条有向认证规则依赖一个起点和所有内部节点，依赖全认证时把另一端入队。各点仅入队一次，各依赖仅释放一次。',
      'RootStability.computeRootStability reads nodes and actual logical paths. Ordinary boards adapt explicit edges and lattice interiors; topology reads topologyPaths directly instead of guessing a winding with getLinePoints(a,b). A directed certificate depends on a source and all interior nodes; once all are certified, enqueue the target. Each point enters once and each dependency is discharged once.'),
    c(`// Pseudocode; sufficient certificate, never a capture oracle
P = friendly roots; queue = roots
for (path a -> b):
  if every interior sample is a friendly NODE:
    register dependency {a} union interior(path) => b
while queue not empty:
  for rule waiting on queue.pop():
    if --rule.remaining == 0 and rule.target not in P:
      P.add(rule.target); queue.push(rule.target)
return {version:'root-stability-v1', kind:'sufficient-only', nodeKeys:[...P]}`, 'text'),
    p('策略接入与模型身份分离：稳固核心用于非终局特征，最终胜负仍用正式分数。围困来自真实邻接分量，不把其中的敌方计为领土。合法回复、Superko 与行动方均交给真实引擎；预算内只完成部分反击时，不发布“已证明安全”。约三秒统一截止要涵盖候选枚举、原策略和战术复核，Worker 超时及过期响应检查与之配套；生成 Worker bundle 后也须验证实际入口。',
      'Separate tactical integration from model identity: the core is a nonterminal feature, while outcomes use official scores. Confinement uses actual adjacency without scoring enclosed enemies. The real engine handles replies, Superko and actors; partial reply checks cannot certify safety. A shared approximately three-second deadline covers generation, base policy and tactical verification, coordinated with Worker timeouts and stale-response guards; generated Worker entry points also require verification.'),
  ]),
  s('random', '4.3 分类别随机与完整棋盘保存', '4.3 Category sampling and complete board persistence', [
    p('RandomBoard 的旧生成器 v1–v3 保留；v4 先求当前尺寸／人数已验证支持的类别，再按数学版概率条件化抽样，在固定类别中有界重试。输出保存 category、展示分支、requested/effective distribution、excludedCategories、版本、种子、完整 definition 与 hash。闭曲面起点按规范邻接距离选取，并用真实引擎逐席检查至少有合法开局，不能从不存在的真实边界采样。',
      'Keep RandomBoard v1–v3. V4 determines categories supported and validated for the size/player count, draws from the conditional distribution, and retries within that category. Persist category, display branch, requested/effective distribution, excludedCategories, version, seed, complete definition and hash. Closed-surface starts use canonical graph distance and actual-engine opening checks, never nonexistent true boundary samples.'),
    p('验收不是“编译成功”四个字：核对连通性、每个 link、边界圈、可定向性、Euler 与 Betti。N=5 的六人小图可能只支持部分构造，这必须如实记录为生成器支持范围。保存／房间／复盘冻结生成结果，其他客户端不能各自重抽。修改概率或生成序列要升生成器版本，不修改历史种子的含义。',
      'Acceptance checks connectivity, every link, boundary circles, orientability, Euler and Betti, not compilation alone. A size-five six-player layout may support only part of the construction family; record this generator limitation explicitly. Saves, rooms and replays freeze the result instead of redrawing independently. Changes to probabilities or sequences require a generator version change.'),
  ]),
  s('render', '4.4 同一规则网格的二维与三维', '4.4 One rule mesh in two and three dimensions', [
    p('正反展开片共享 canonical ID；渲染过滤、屏幕投影与 hit-test 使用相同的当前片选择，跨缝副本仍同步。3D 接口必须带原 faceId 与重心坐标，不能仅传一个平面坐标猜它来自哪片。双倍平面孔洞构造的每原三角分成六个渲染三角，内部边中点和面中心有正高度，边界高度零；背面高度取负。',
      'Front and back share canonical IDs; rendering, screen projection and hit testing use the same active chart selection. The 3D interface includes source faceId and barycentric coordinates, not just a planar coordinate. For doubled perforated domains, each source face becomes six render triangles with positive interior midpoint/centroid heights, zero boundary heights and negated heights on the back.'),
    p('面片颜色、线段与节点使用同一嵌入，粘边对应点必须三维重合。曲面遮挡用 WebGL 深度缓冲，不能靠平均深度排序冒充凹曲面的正确遮挡。渲染细分不写回规则样本，不改变合法行动或离散分数。上下文不可用时显示可理解的二维回退状态；不能显示一个假的立体成功状态。',
      'Face colors, segments and nodes share the embedding, with glued copies coincident in 3D. Use a WebGL depth buffer for concave-surface occlusion rather than mean-depth sorting. Render subdivision never changes legal samples, moves or scores. If the context is unavailable, expose a clear two-dimensional fallback instead of a false 3D success.'),
  ]),
  s('verification', '4.5 版本、回放与验证', '4.5 Versions, replay and validation', [
    p('源码与内容同源生成：GuideTopologyChapters → GuideMathChapters／GuideTechnicalChapters → GuideImplementation → 四篇双语 Markdown。旧 topologyGuide 入口转到 rules-math 的 rulesMath-topology 锚点，不维护两份正文。UI 的着法列表与分析默认收起，播放和拖动进度共用隔离恢复逻辑，清掉旧候选与异步请求。拓扑候选使用 canonical vertexId，全部展开副本同步高亮。',
      'One content source: GuideTopologyChapters → GuideMathChapters/GuideTechnicalChapters → GuideImplementation → four bilingual Markdown articles. Redirect topologyGuide to the rulesMath-topology anchor inside rules-math, avoiding duplicate bodies. Replay moves and analysis are collapsed; playback and seek share isolated restoration and clear old candidates/requests. Topology candidates use canonical vertexId and highlight all atlas copies.'),
    c(`node web/tools/sync-implementation-guides.mjs --check
node web/web前端/tests/verify-guide-content.mjs
node web/web前端/tests/verify-topology-algebra.mjs
node web/web前端/tests/verify-root-stability.mjs`, 'text'),
    p('其他验证覆盖随机生成的旧种子与 v4 可复现性、N=5/9/15 与 2–6 人、双孔面／边映射、完整棋局保存恢复、三秒预算及取消、真实浏览器的设置／复盘／旋转。Node 回归、浏览器截图、发布、远程排名与正式棋力评测分别报告；本次源码更新本身不表示已经跨端发布或训练新模型。',
      'Further checks cover old seeds and v4 reproducibility, sizes 5/9/15 with 2–6 players, double-hole face/edge mapping, full-match persistence, deadlines/cancellation and actual-browser settings/replay/rotation. Report Node regressions, browser evidence, release, remote ranking and formal strength separately; source updates alone imply neither cross-platform release nor new model training.'),
  ]),
]);
