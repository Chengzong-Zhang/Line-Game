import { implementationMarkdown } from "./GuideImplementation.js?v=20261029-unified-r1";
import { guideHeadingId, isGuideAnchorId } from "./GuideArticleFormat.js?v=20261029-unified-r1";

const WHY_TALK_ZH = `# Talk：扩张、防守与破绽

最高指挥官，如果要一句话说明这个游戏为什么值得玩：它有围棋的圈地灵魂，却不只在点与气上较量，而是把点、线、面同时推上战场；它也不像国际象棋、中国象棋、将棋那样依靠不同棋子的能力差异制造复杂度，更不像跳棋主要沿固定吃子路径推进。这里每个节点本质相同，公平而简洁，但一条线的连接或切断会改变整片面的生死。真正抓人的地方，不是“谁占的点更多”，而是每一次扩张都会改变自己的脆弱面。三角棋盘像一条从狭窄前线展开到广阔纵深的战场：靠近大本营，补给短、结构稳；推进到中央，空间变大，防线也被拉长。

> 越想扩张，防线越长，越容易被切开；越想防守，空间越小，越容易被围死。

这是第一组矛盾。扩张带来领土，也带来更长的边界、更薄的连接、更显眼的桥。防守看似稳健，却会把自己压回基点附近，让对手取得外线、压缩你的回旋空间。苏德战场式的张力就在这里：广阔纵深不是免费的，狭窄防线也不是安全的终局。

> 越想快速扩张，就越必须暴露线；越想完全不露破绽，规则又不允许你凭空获得效率。

这是第二组矛盾。棋子之间的线不是装饰，而是补给线，也是对手可以切入的目标。你若追求速度，就会留下尚未闭合的长线、桥点和割点；你若追求完美闭合，又会因为三点限制、可见性规则和落子顺序而付出效率。规则逼迫玩家承认：不存在既高速扩张、又完全无破绽的形状。更妙的是，它会自然制造迫移局面：多下一颗子未必好，因为新节点既可能扩大领土，也可能变成对手下一次切断的跳板。

## 直觉核心

![三人制衡示意](./guide-images/三人制衡.jpg)

三个人的时候更为巧妙，涉及到合纵连横；有时候就会出现图片中这样，谁先走这步棋，谁就会成全另一方的局面。

* 扩张与溃败绑定。多一个节点可能扩大领土，也可能把整条战线变成可被切断的长桥。
* 防守与窒息绑定。退回基点附近可以降低暴露面，但会把战略纵深交给对手。
* 速度与完整性绑定。快速铺开必然留下线，慢速补形又会损失先机。
* 同一性与公平性绑定。每个节点能力相同，复杂性来自结构，而不是来自棋子特权。
* 进攻的本质不是吃子，而是切断基点连通性。真正被消灭的不是一个点，而是一整段失去补给的结构。

所以，这个游戏不是单纯的占点竞赛。它要求玩家在效率、闭合、桥、割点、战线长度和后续空间之间寻找均衡。妙处不在规则复杂，而在规则把所有逃避都封死了：你必须扩张，也必须暴露；你必须防守，也必须留下空间。`;

const WHY_CODE_ZH = implementationMarkdown("whyCode", "zh");

const WHY_THEORY_ZH = `# Theory：算力深渊与上帝的简洁逻辑

这个游戏相对国际象棋、围棋、跳棋等经典棋类的优越性，不是简单宣称“局面数最大”，而是用很少的几何格点制造出更高密度的长程结构。作为参照，跳棋常见状态空间约 $5\times 10^{20}$、博弈树约 $10^{31}$；国际象棋状态空间常估为 $10^{43}$ 到 $10^{50}$、博弈树约 $10^{120}$；19 路围棋合法局面数为 $2.08\times 10^{170}$、博弈树常估约 $10^{360}$。本游戏在边长 $n=15$ 时只有 $V=120$ 个物理格点，却已有 $E=1680$ 条潜在长程可见性边，显式表示上界约为 $6.49\times 10^{885}$。

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

棋盘是二次规模，战术关系是三次规模。复杂度不是靠巨大棋盘堆出来的，而是从视线边自然长出来的：二次规模棋盘生成三次规模战术关系，再由切断、连通性删除和 Superko 把这些关系转化为搜索深度。

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

Commander, if this game has to be explained in one sentence, it is this: it has the territorial soul of Go, but it does not fight only through points and liberties; it pushes points, lines, and surfaces onto the same battlefield. It also does not create depth like chess, xiangqi, or shogi, where different pieces carry different powers, and it is not like checkers, where play mostly advances through fixed capture paths. Here every node is the same kind of thing: fair, simple, and unified. Yet one connected or severed line can change the life of an entire surface. The central question is not who occupies more points. It is how each expansion changes the shape of your own vulnerability. The triangular board opens from a narrow home front into a wide field: near the base, supply is short and stable; toward the center, space grows, but the front stretches.

> The more you expand, the longer your line becomes, and the easier it is to cut. The more you defend, the less space you keep, and the easier it is to be boxed in.

That is the first contradiction. Expansion gives territory, but also creates longer borders, thinner connections, and visible bridges. Defense looks stable, but it pushes you back toward the base and hands the outside line to the opponent.

> The faster you expand, the more lines you expose. The more you try to hide every weakness, the more efficiency the rules force you to lose.

That is the second contradiction. Lines are not decoration. They are supply routes, and therefore attack targets. If you expand quickly, you leave unfinished long lines, bridges, and articulation points. If you insist on perfect closure, the triangle restriction, visibility rule, and move order make you pay in tempo. The rules force the player to accept that no shape can be both maximally fast and completely unexposed. Even better, the game naturally creates zugzwang: one more friendly node is not automatically good, because it may enlarge your territory or become the opponent's next cutting platform.

## Intuition

![Three-player balance of power](./guide-images/三人制衡.jpg)

With three players, the game becomes even subtler: alliances and counter-alliances come into play, and sometimes a position like the one shown here emerges, where whoever makes this move first ends up enabling another side.

* Expansion and collapse are linked. A new node can enlarge territory or turn the whole front into a cuttable bridge.
* Defense and suffocation are linked. Staying near the base reduces exposure but gives away strategic depth.
* Speed and completeness are linked. Fast growth exposes lines; slow repair loses initiative.
* Unity and fairness are linked. Every node has the same power, so complexity comes from structure, not piece privilege.
* Attacks do not merely capture pieces. They sever connectivity to the base.

The game is not a simple occupation race. It asks the player to balance efficiency, closure, bridges, articulation points, frontage, and future space.`;

const WHY_CODE_EN = implementationMarkdown("whyCode", "en");

// Legacy key remains an alias; the only topology article lives in rulesMath.

const WHY_THEORY_EN = `# Theory: A Simple Law, a Deep Search Space

The advantage over classical games such as chess, Go, and checkers is not the crude claim that the intrinsic position count is always larger. The advantage is structural density: a small geometric board produces a much richer long-range relation graph. For reference, checkers is commonly placed around $5\times 10^{20}$ states and roughly $10^{31}$ game-tree complexity; chess is often estimated around $10^{43}$ to $10^{50}$ states and $10^{120}$ game-tree complexity; 19x19 Go has $2.08\times 10^{170}$ legal positions and is often estimated near $10^{360}$ game-tree complexity. At side length $n=15$, this game has only $V=120$ physical lattice points, but already has $E=1680$ potential long-range visibility edges, giving an explicit representation upper bound of about $6.49\times 10^{885}$.

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

The board is quadratic. The tactical relation graph is cubic. In short, the game does not buy complexity by making the board enormous; it turns a quadratic board into cubic tactical relations, then turns those relations into search depth through cuts, connectivity deletion, and Superko.

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
玩家轮流在三角网格落子。己方节点和连线经过的格点直接计入领土；由己方点线隔开、不接触真实边界且不含敌方元素的每个空腔也计入，包括甜甜圈形状的内孔；含敌方元素的空腔不计。无需形成单一闭环；开链和单线仍按己方点数计分。同一格点只算一次。显示轮廓（displayArea）仅用于展示，不决定正式分数；最终格点数多者获胜。
![可落子区域示意](./guide-images/可以走的区域png.png)

【核心机制】
沿三角网格直线可见、且符合阻挡与禁交叉规则的己方节点会自动连线，不要求两点相邻。盘面结构必须沿实际存在的逻辑边连回己方任一起点。玩家可合法落子于敌方连线上将其切断；失去所有起点连通路径的敌方节点与线立即清除。粘合边两侧显示的是同一棋位，直线跨缝后按接缝方向继续。
![切断示意一](./guide-images/切断1.png)
![切断示意二](./guide-images/切断2.png)

【限制规则】
首先是起步保护：受保护起点的距离 1 实际邻点禁止敌方落子。新局中，双人普通三角棋盘的先手没有禁区；其他情况保留保护。旧棋谱按保存的规则版本解释。
![起点限制示意](./guide-images/起点限制.png)

其次是三点限制：禁止主动形成三个己方节点构成的相邻链或簇，不仅限于小三角形；只有本次落子实际切断敌方连线时才豁免。
![三点限制示意](./guide-images/三点限制.png)

最后是同形禁手，禁止任何会使全局节点与连线状态恢复至历史重复局面的落子，以防止双方陷入无限互相切断的死循环`,
    rulesWar: `最高指挥官，欢迎来到这片由点与线交织的三角阵地。

常言道，兵马未动，粮草先行。在这片残酷的战场上，如果你前方的部队失去了和总基地的联系，就会因为断水断粮而直接在棋盘上溃散消失。这是你在接下来的指挥中最需要牢记的铁律。

仔细观察你眼前的这片三角战场，它形似二战时期的苏德战场，从狭窄的波德平原一路向广阔的东欧平原延伸。这种特殊的地形里隐藏着这场战争最本质的战略张力：越靠近你的大本营，战线越窄，虽然极易防守，但你能掌控的领土也十分可怜；而越向战场中央挺进，天地越广阔，圈占的领土越大，但拉长的防线也会暴露出致命的破绽。你越想激进进攻，破绽就越多；越想保守防御，就越容易被对方死死围住。是稳扎稳打，还是狂飙突进，全在你的一念之间。

起点的禁区像大本营的卫队：敌方不能落在受保护起点距离 1 的实际邻点。双人普通三角棋盘的新局中，先手没有这层禁区，其他情况保留；旧战报仍按原规则重放。
![起点限制示意](./guide-images/起点限制.png)

随着战役打响，各方轮流占据网格点。新兵只能沿三角网格直线建立合法、无遮挡且不交叉的补给线，前线必须沿实际补给线连回己方任一大本营。
![可落子区域示意](./guide-images/可以走的区域png.png)

你的终极目标是尽可能扩大安全领土。士兵所在格点和补给线经过的格点始终计分，不要求闭合。己方点线隔开且不接触真实边界的安全空腔也计分；多个空腔和甜甜圈内孔分别计算，含敌军的空腔不计。同一格点只算一次。填色保留凸包与收紧轮廓，再裁剪到实际棋盘范围，排除外部与孔洞；单根补给线不铺领土色。显示轮廓（displayArea）仅用于展示，不决定正式分数。

在这场鏖战中，你不能主动把三个己方士兵排成紧挨着的链或簇；这项限制不只针对小三角形。
![三点限制示意](./guide-images/三点限制.png)

但是战场瞬息万变，如果你这一步是直接踩在敌军的补给线上，狠狠切断了他们的粮草，那就相当于抢夺了敌方的物资。这说明该地段战况极其激烈，此时你就可以打破常规，不受不能拥挤的限制，大举集结兵力发起猛攻。
![切断示意一](./guide-images/切断1.png)
![切断示意二](./guide-images/切断2.png)

当仍在场的玩家连续各跳过一回合时，按正式领土格点结算；若只剩一方仍在场，则该方获胜。去吧，指挥官，愿你的防线坚不可摧。`,
    rulesMath: implementationMarkdown("rulesMath", "zh"),
    topologyGuide: implementationMarkdown("rulesMath", "zh"),
    whyTalk: WHY_TALK_ZH,
    whyCode: WHY_CODE_ZH,
    whyTheory: WHY_THEORY_ZH,
    whyThis: WHY_TALK_ZH,
    thanks: `创始人：zcz
愿景启发：Harmony（第一个帮我做出初始程序的人；没有 Harmony，这个游戏的程序化进程可能会无限期搁置）, zem（第一个认为这个游戏高度程序化、可以编程实现的人）, jhd（和我上课下棋做早期测试，帮我完善了三点限制）, dya（他先手一步封喉，促使我提出了起点处禁区的概念）, yhx（下午大课间经常和我下棋，帮我完善了领土不能穿越的规则）, wy（早期测试）, zz（早期测试）, lzh（早期测试）
产品经理：Gemini(3.1Pro), zcz
算法工程师：zcz, Claude code(Opus4.6/Opus4.7/Sonnet4.6), hmy, LeoYan
理论分析：zcz， GPT5.5(deep reasearch), Gemini(3.1Pro)
前端开发工程师：Codex(GPT5.4/GPT5.5), Claude code(Sonnet4.6), zcz
后端开发工程师：Codex(GPT5.4), Claude code(Sonnet4.6), zcz
提示词工程师：zcz, Gemini(3.1Pro/3.1Thinking)
UI设计师：zcz, Codex(GPT5.4)
UE设计师：zcz, LeoYan, Codex(GPT5.4), Pigeon
运维工程师：Codex(GPT5.4), zcz, Claude code(Sonnet4.6)
测试工程师：zcz, LeoYan, Pigeon, Rainy
内测用户：Mandy, zfp, smy, zzd, slz, zxy, Orange, Puppy, yxy, hmy, RobinTian, zjy, wyc, fjh, lh, O, lhh, lhr, jhd`,
  }),
  en: Object.freeze({
    rulesEssential: `【Victory Condition】
Players take turns placing nodes on a triangular grid. Your nodes and link points always count. Every enemy-free pocket separated by friendly points and not touching a true boundary also counts, including the inner hole of a donut-shaped structure; pockets containing an enemy are excluded. No single closed loop is required; an open chain or single line still scores its owned points. Each point counts once. The displayed outline (displayArea) is for presentation and does not determine the official score. The higher total wins.
![Playable area example](./guide-images/可以走的区域png.png)

【Core Mechanic】
Friendly nodes connect along legal straight triangular-grid paths subject to blocking and crossing rules; endpoints need not be adjacent. Structures must connect through actual logical links to at least one friendly root. A legal move on an enemy link cuts it; enemy nodes and links that lose every route to their roots are removed. Copies on glued boundaries represent the same position, and a path continues across a seam using its direction transform.
![Cut example one](./guide-images/切断1.png)
![Cut example two](./guide-images/切断2.png)

【Restriction Rules】
First, opening protection forbids enemy moves on the actual distance-one neighbors of a protected root. In new two-player games on the ordinary triangular board, the first player has no protected zone; other configurations retain protection. Old replays keep their saved rule version.
![Starting-point restriction](./guide-images/起点限制.png)

Second, you may not voluntarily create an adjacent chain or cluster of three friendly nodes; the restriction is not limited to small triangles. It is waived only when this move actually cuts an enemy link.
![Three-point restriction](./guide-images/三点限制.png)

Third, there is a superko-style repetition ban: any move that recreates a previously seen global node-and-link state is illegal, preventing endless cut-and-recut loops.`,
    rulesWar: `Commander, welcome to this triangular theater woven from points and lines.

There is an old rule of war: supply must move before the army does. On this battlefield, if your forward troops lose contact with headquarters, they collapse from the board at once. That is the iron law you must remember above all else.

Look carefully at the shape of this battlefield. It resembles a front that opens from a narrow approach into a wide plain. That geometry creates the deepest tension in the game: the closer you stay to home base, the easier your line is to defend, but the less land you can truly control. The farther you push toward the center, the larger the territory you may claim, but the longer your line becomes, and the more weak points you expose. The more aggressively you expand, the more cracks you create. The more cautiously you turtle, the easier it is for your opponent to box you in. Whether you advance steadily or charge forward recklessly is always your call.

The protected zone is your headquarters' guard: enemies cannot occupy the actual distance-one neighbors of a protected root. The first player has no such zone in a new two-player game on the ordinary triangular board; other configurations retain it. Old battle records keep their saved rules.
![Starting-point restriction](./guide-images/起点限制.png)

As the campaign unfolds, players take turns occupying grid points. Supply lines follow legal straight triangular-grid paths, subject to blocking and crossing rules. Every front must connect through actual supply lines to at least one friendly headquarters.
![Playable area example](./guide-images/可以走的区域png.png)

Your ultimate objective is to expand secure territory. Your troops and supply lines always count their grid points. Enemy-free pockets separated by friendly structures and not touching a true boundary also count; multiple pockets and donut holes are evaluated separately, while a pocket containing an enemy is excluded. No loop is required to score owned points. Each point counts once. Shading keeps the hull and tightened outlines, then clips them to the board, excluding its exterior and removed holes; a single supply line receives no territory fill. The displayed outline (displayArea) is for presentation and does not determine the official score.

You cannot voluntarily crowd three friendly soldiers into an adjacent chain or cluster; this restriction is not limited to small triangles.
![Three-point restriction](./guide-images/三点限制.png)

But the battlefield changes instantly. If your move lands directly on an enemy supply line and cuts it, that is treated as a decisive tactical strike. In such a fierce moment, normal crowding restrictions are waived and concentrated force becomes legal.
![Cut example one](./guide-images/切断1.png)
![Cut example two](./guide-images/切断2.png)

When all surviving players pass consecutively, the game is settled by official territory points. If only one player remains, that player wins. Go on, Commander. May your lines hold.`,
    rulesMath: implementationMarkdown("rulesMath", "en"),
    topologyGuide: implementationMarkdown("rulesMath", "en"),
    whyTalk: WHY_TALK_EN,
    whyCode: WHY_CODE_EN,
    whyTheory: WHY_THEORY_EN,
    whyThis: WHY_TALK_EN,
    thanks: `Founder: zcz
Vision Spark: Harmony (the first person who helped build an initial program; without Harmony, the game's software path might have stalled indefinitely), zem (the first person who believed the game was highly programmable and could be implemented), jhd (an early class-time playtest partner who helped refine the three-point restriction), dya (whose first-move throat-cut prompted the starting-zone restriction), yhx (a frequent afternoon-break playtest partner who helped refine the rule that territory cannot be crossed), wy (early testing), zz (early testing), lzh (early testing)
Product Lead: Gemini(3.1Pro), zcz
Algorithm Engineers: zcz, Claude code(Opus4.6/Opus4.7/Sonnet4.6), hmy, LeoYan
Theoretical Analysis: zcz, GPT5.5(deep reasearch), Gemini(3.1Pro)
Frontend Engineers: Codex(GPT5.4/GPT5.5), Claude code(Sonnet4.6), zcz
Backend Engineers: Codex(GPT5.4), Claude code(Sonnet4.6), zcz
Prompt Engineers: zcz, Gemini(3.1Pro/3.1Thinking)
UI Designers: zcz, Codex(GPT5.4)
UX Designers: zcz, LeoYan, Codex(GPT5.4), Pigeon
Operations Engineers: Codex(GPT5.4), zcz, Claude code(Sonnet4.6)
Test Engineers: zcz, LeoYan, Pigeon, Rainy
Beta Testers: Mandy, zfp, smy, zzd, slz, zxy, Orange, Puppy, yxy, hmy, RobinTian, zjy, wyc, fjh, lh, O, lhh, lhr, jhd`,
  }),
});

const GUIDE_IMAGE_BASE_PATH = "./guide/guide-images/";

const GUIDE_RULE_IMAGE_BLOCKS = Object.freeze({
  zh: Object.freeze({
    rulesEssential: Object.freeze([
      { type: "image", id: "playable", alt: "可落子区域示意", src: `${GUIDE_IMAGE_BASE_PATH}可以走的区域png.png` },
      { type: "image", id: "cut1", alt: "切断示意一", src: `${GUIDE_IMAGE_BASE_PATH}切断1.png` },
      { type: "image", id: "cut2", alt: "切断示意二", src: `${GUIDE_IMAGE_BASE_PATH}切断2.png` },
      { type: "image", id: "start", alt: "起点限制示意", src: `${GUIDE_IMAGE_BASE_PATH}起点限制.png` },
      { type: "image", id: "triangle", alt: "三点限制示意", src: `${GUIDE_IMAGE_BASE_PATH}三点限制.png` },
    ]),
    rulesWar: Object.freeze([
      { type: "image", id: "start", alt: "起点限制示意", src: `${GUIDE_IMAGE_BASE_PATH}起点限制.png` },
      { type: "image", id: "playable", alt: "可落子区域示意", src: `${GUIDE_IMAGE_BASE_PATH}可以走的区域png.png` },
      { type: "image", id: "triangle", alt: "三点限制示意", src: `${GUIDE_IMAGE_BASE_PATH}三点限制.png` },
      { type: "image", id: "cut1", alt: "切断示意一", src: `${GUIDE_IMAGE_BASE_PATH}切断1.png` },
      { type: "image", id: "cut2", alt: "切断示意二", src: `${GUIDE_IMAGE_BASE_PATH}切断2.png` },
    ]),
    rulesMath: Object.freeze([
      { type: "image", id: "triangle", alt: "三点限制示意", src: `${GUIDE_IMAGE_BASE_PATH}三点限制.png` },
      { type: "image", id: "start", alt: "起点限制示意", src: `${GUIDE_IMAGE_BASE_PATH}起点限制.png` },
      { type: "image", id: "playable", alt: "可落子区域示意", src: `${GUIDE_IMAGE_BASE_PATH}可以走的区域png.png` },
      { type: "image", id: "cut1", alt: "切断示意一", src: `${GUIDE_IMAGE_BASE_PATH}切断1.png` },
      { type: "image", id: "cut2", alt: "切断示意二", src: `${GUIDE_IMAGE_BASE_PATH}切断2.png` },
    ]),
  }),
  en: Object.freeze({
    rulesEssential: Object.freeze([
      { type: "image", id: "playable", alt: "Playable area example", src: `${GUIDE_IMAGE_BASE_PATH}可以走的区域png.png` },
      { type: "image", id: "cut1", alt: "Cut example one", src: `${GUIDE_IMAGE_BASE_PATH}切断1.png` },
      { type: "image", id: "cut2", alt: "Cut example two", src: `${GUIDE_IMAGE_BASE_PATH}切断2.png` },
      { type: "image", id: "start", alt: "Starting-point restriction", src: `${GUIDE_IMAGE_BASE_PATH}起点限制.png` },
      { type: "image", id: "triangle", alt: "Three-point restriction", src: `${GUIDE_IMAGE_BASE_PATH}三点限制.png` },
    ]),
    rulesWar: Object.freeze([
      { type: "image", id: "start", alt: "Starting-point restriction", src: `${GUIDE_IMAGE_BASE_PATH}起点限制.png` },
      { type: "image", id: "playable", alt: "Playable area example", src: `${GUIDE_IMAGE_BASE_PATH}可以走的区域png.png` },
      { type: "image", id: "triangle", alt: "Three-point restriction", src: `${GUIDE_IMAGE_BASE_PATH}三点限制.png` },
      { type: "image", id: "cut1", alt: "Cut example one", src: `${GUIDE_IMAGE_BASE_PATH}切断1.png` },
      { type: "image", id: "cut2", alt: "Cut example two", src: `${GUIDE_IMAGE_BASE_PATH}切断2.png` },
    ]),
    rulesMath: Object.freeze([
      { type: "image", id: "triangle", alt: "Three-point restriction", src: `${GUIDE_IMAGE_BASE_PATH}三点限制.png` },
      { type: "image", id: "start", alt: "Starting-point restriction", src: `${GUIDE_IMAGE_BASE_PATH}起点限制.png` },
      { type: "image", id: "playable", alt: "Playable area example", src: `${GUIDE_IMAGE_BASE_PATH}可以走的区域png.png` },
      { type: "image", id: "cut1", alt: "Cut example one", src: `${GUIDE_IMAGE_BASE_PATH}切断1.png` },
      { type: "image", id: "cut2", alt: "Cut example two", src: `${GUIDE_IMAGE_BASE_PATH}切断2.png` },
    ]),
  }),
});

const GUIDE_RULE_IMAGE_ANCHORS = Object.freeze({
  rulesEssential: Object.freeze({
    playable: /胜利条件|territory|objective|playable|落子|occupies/i,
    cut1: /核心机制|切断|cut|connect|link/i,
    cut2: /核心机制|切断|cut|connect|link/i,
    start: /限制规则|起步保护|opening protection|starting/i,
    triangle: /限制规则|三项强制|triangle|formation/i,
  }),
  rulesWar: Object.freeze({
    start: /大本营周围|safe zone|nearest your base|headquarters/i,
    playable: /轮流派出|occupy new grid|alternate sending|links up/i,
    triangle: /三个士兵|smallest possible triangle|crowd three/i,
    cut1: /切断|tactical strike|cuts it|supply line/i,
    cut2: /切断|tactical strike|cuts it|supply line/i,
  }),
  rulesMath: Object.freeze({
    triangle: /迫移|zugzwang|strategy stealing|三点|triangle/i,
    start: /图论连通性|不变基点|连通性公理|Connectivity Axiom|anchor|基点/i,
    playable: /动作空间|Action Space|legal empty vertex|落子/i,
    cut1: /割边|Edge Deletion|split|切断/i,
    cut2: /BFS|极大连通分量|maximal connected component|removed/i,
  }),
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

export function ensureGuideRuleImages(key, blocks = [], language = "zh") {
  const normalizedLanguage = language === "en" ? "en" : "zh";
  const normalizedBlocks = (Array.isArray(blocks) ? blocks : []).map((block) => {
    if (block?.type === "image") {
      return { ...block, src: resolveGuideImageSrc(block.src) };
    }
    if (block?.type === "image-row") {
      return {
        ...block,
        images: (block.images ?? []).map((image) => ({ ...image, src: resolveGuideImageSrc(image.src) })),
      };
    }
    return block;
  });
  const imageBlocks = GUIDE_RULE_IMAGE_BLOCKS[normalizedLanguage]?.[key] ?? GUIDE_RULE_IMAGE_BLOCKS.zh[key] ?? [];

  if (!imageBlocks.length) {
    return normalizedBlocks;
  }

  const imageIds = new Set();
  const rememberImage = (image) => {
    const src = decodeURIComponent(resolveGuideImageSrc(image?.src ?? ""));
    if (src.includes("可以走的区域png.png")) imageIds.add("playable");
    if (src.includes("切断1.png")) imageIds.add("cut1");
    if (src.includes("切断2.png")) imageIds.add("cut2");
    if (src.includes("起点限制.png")) imageIds.add("start");
    if (src.includes("三点限制.png")) imageIds.add("triangle");
  };

  normalizedBlocks.forEach((block) => {
    if (block?.type === "image") {
      rememberImage(block);
    } else if (block?.type === "image-row") {
      (block.images ?? []).forEach(rememberImage);
    }
  });

  const missingImages = imageBlocks
    .filter((block) => !imageIds.has(block.id))
    .map((block) => ({ ...block }));

  if (!missingImages.length) {
    return normalizedBlocks;
  }

  const pending = new Map(missingImages.map((block) => [block.id, block]));
  // The paper has an explicit contents list: keyword matching would place
  // diagrams inside that list. Bind these illustrations to body sections.
  if (key === "rulesMath" && normalizedBlocks.some(block => block.type === "heading3" && /^1\.2\s/.test(block.text))) {
    const sectionImages = { "1.2": ["triangle", "start", "playable"], "2.1": ["cut1", "cut2"] };
    const result = [];
    let section = null;
    const appendSectionImages = () => {
      for (const id of sectionImages[section] ?? []) {
        if (pending.has(id)) result.push(pending.get(id));
        pending.delete(id);
      }
    };
    for (const block of normalizedBlocks) {
      if (/^heading[123]$/.test(block.type)) {
        appendSectionImages();
        section = block.type === "heading3" ? block.text.match(/^(\d+\.\d+)\s/)?.[1] : null;
      }
      result.push(block);
    }
    appendSectionImages();
    return [...result, ...pending.values()];
  }
  const anchors = GUIDE_RULE_IMAGE_ANCHORS[key] ?? {};
  const result = [];

  normalizedBlocks.forEach((block) => {
    result.push(block);
    const text = `${block?.text ?? ""} ${block?.label ?? ""}`.trim();
    for (const [id, image] of pending) {
      if (anchors[id]?.test(text)) {
        result.push(image);
        pending.delete(id);
      }
    }
  });

  return [
    ...result,
    ...pending.values(),
  ];
}

function tokenizeInline(text) {
  const source = String(text ?? "");
  const tokens = [];
  const pattern = /(\[[^\]\n]+\]\([^\)\n]*\)|\*\*[^*]+\*\*|`[^`]+`|\$[^$\n]+\$)/g;
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

    if (matchText.startsWith("[")) {
      const [, label, href] = matchText.match(/^\[([^\]]+)\]\(([^)]*)\)$/) ?? [];
      let safeHref = null;
      if (/^https?:\/\//i.test(href ?? "") && !/[\x00-\x20<>"'\\]/.test(href)) {
        try {
          const url = new URL(href);
          if (["http:", "https:"].includes(url.protocol)) safeHref = url.href;
        } catch (_) { /* Invalid URLs remain plain text. */ }
      }
      tokens.push(typeof href === "string" && href.startsWith("#") && isGuideAnchorId(href.slice(1))
        ? { type: "anchor", text: label, href }
        : safeHref
        ? { type: "link", text: label, href: safeHref }
        : { type: "text", text: matchText });
    } else if (matchText.startsWith("**") && matchText.endsWith("**")) {
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
      rulesMath: "./guide/rule/math%20rule.en.md",
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
      blocks.push(createTextBlock("heading1", trimmed.slice(2), { id: guideHeadingId(trimmed.slice(2)) }));
      index += 1;
      continue;
    }
    if (trimmed.startsWith("## ")) {
      flushParagraph(paragraphLines);
      blocks.push(createTextBlock("heading2", trimmed.slice(3), { id: guideHeadingId(trimmed.slice(3)) }));
      index += 1;
      continue;
    }
    if (trimmed.startsWith("### ")) {
      flushParagraph(paragraphLines);
      blocks.push(createTextBlock("heading3", trimmed.slice(4), { id: guideHeadingId(trimmed.slice(4)) }));
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
    if (/^[^：:\[`$]{1,24}[：:]\s*.+$/.test(trimmed)) {
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
