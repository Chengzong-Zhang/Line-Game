const GUIDE_MARKDOWN = Object.freeze({
  rulesEssential: `【胜利条件】
双方轮流在三角网格落子，最终由己方节点与连线完全闭合且内部无敌方元素的区域即为领土，领土所包含的网格点数多者获胜。

【核心机制】
相邻且无遮挡的己方节点会自动连线，盘面上所有的节点与连线必须与己方初始点保持物理连通。玩家可落子于敌方连线上将其切断，一旦连线断裂导致敌方部分节点或连线失去与初始点的连通路径，这些断联的元素将立即从棋盘上彻底清除。

【限制规则】
为保证博弈的平衡与推进，游戏设定了三项强制约束。首先是起步保护，靠近初始点的两个相邻位置绝对禁止敌方落子。其次是阵型限制，禁止主动形成三个节点互相紧挨的最小三角形阵型，除非该次落子直接切断了敌方的连线。最后是同形禁手，禁止任何会使全局节点与连线状态恢复至历史重复局面的落子，以防止双方陷入无限互相切断的死循环`,
  rulesWar: `最高指挥官，欢迎来到这片由点与线交织的三角阵地。

常言道，兵马未动，粮草先行。在这片残酷的战场上，如果你前方的部队失去了和总基地的联系，就会因为断水断粮而直接在棋盘上溃散消失。这是你在接下来的指挥中最需要牢记的铁律。

仔细观察你眼前的这片三角战场，它形似二战时期的苏德战场，从狭窄的波德平原一路向广阔的东欧平原延伸。这种特殊的地形里隐藏着这场战争最本质的战略张力：越靠近你的大本营，战线越窄，虽然极易防守，但你能掌控的领土也十分可怜；而越向战场中央挺进，天地越广阔，圈占的领土越大，但拉长的防线也会暴露出致命的破绽。你越想激进进攻，破绽就越多；越想保守防御，就越容易被对方死死围住。是稳扎稳打，还是狂飙突进，全在你的一念之间。

为了防止总司令部一开局就被敌方的闪电战彻底封锁，你的大本营周围驻扎着极其强大的禁卫军。敌方绝对无法在你大本营最靠近的区域落子，有了这层绝对的保护，你可以安心地从这里向外发兵。

随着战役打响，你需要和敌军轮流派出士兵，占据新的网格点。只要视线不被阻挡，你的新兵就会和原有的部队自动拉起一条相互呼应的补给线。

你的终极目标是尽可能扩大你的安全领土。在这片战场上，领土就是由你的士兵和补给线完完全全包围起来的区域。为了减轻前线的防御压力，我们聪明的参谋部会自动为你规划出最精简的防线。这条防线会尽可能缩短周长、减少多余的防守面积，但一定会把你所有的部队都安全地保护在内，并且保证圈进来的地盘里绝对没有任何敌军的影子。

在这场鏖战中，战备资源十分紧张。为了避免兵力浪费，你不能把三个士兵紧挨着挤在一个小三角里。但是战场瞬息万变，如果你这一步是直接踩在敌军的补给线上，狠狠切断了他们的粮草，那就相当于抢夺了敌方的物资。这说明该地段战况极其激烈，此时你就可以打破常规，不受不能拥挤的限制，大举集结兵力发起猛攻。

当所有的硝烟散去，双方都无兵可派、无地可占时，谁圈出的领土面积更大，谁就是这场战争真正的赢家。去吧，指挥官，愿你的防线坚不可摧。`,
  rulesMath: `# 离散数学与强化学习视角：三角圈地博弈的形式化定义与理论分析

本文档旨在从离散数学中的图论、组合博弈论（CGT）以及强化学习的视角，对本博弈游戏进行严谨的数学定义、模型构建与复杂性评估。

## 一、组合博弈论属性、策梅洛定理与迫移局面

本游戏是一个**双人、有限步数、完备信息、确定性（无随机因素）的零和博弈**。

根据组合博弈论中的策梅洛定理（Zermelo's Theorem），满足上述条件的有限博弈必然存在纯策略的纳什均衡。这意味着在完美算力下，必定存在确定的最优策略。

然而，在经典的对称博弈中，增加己方棋子永远能带来严格的正向收益，理论上先手方可以通过随便落子并假装自己是后手，从而完成“策略窃取（Strategy Stealing）”，这在逻辑上排除了后手必胜的可能。但在本博弈模型中，这种经典证明被彻底摧毁。由于引入了动态拓扑解绑与防拥挤约束，额外增加一个节点极有可能成为敌方发起切割攻击的物理跳板，或者不慎堵死己方后续的布阵空间。这意味着在特定盘面下，落子不仅无法产生收益，反而会帮倒忙。由于玩家无法放弃行动回合，系统极易陷入被迫落子从而破坏自身完美防线的状态，即博弈论中经典的**迫移局面（Zugzwang）**。

迫移局面的客观存在，使得后手方具备了通过精准诱导实现反杀的理论可能。这不仅彻底瓦解了试图建立“先手无脑必不败”的粗暴证明，更赋予了游戏极深的反击战术维度，使得博弈树的分支因子和状态价值评估呈现出高度的非线性。寻找理论最优解因此成为一个计算复杂性极高的问题，非常适合作为深度强化学习的研究环境。

## 二、状态空间的图论建模（Graph Representation）

游戏的物理基底是一个有限的离散点集，由边长为 $N$ 的三角网格的所有坐标构成，记为全局顶点集 $V_{grid}$。在任意离散时间步 $t$，游戏的全局状态可被严谨地定义为一张带色彩属性的无向图 $S_t = \\langle G_t, C_t \\rangle$，其中：

* $G_t = (V_t, E_t)$，$V_t \\subseteq V_{grid}$ 为当前棋盘上存活的节点集合，$E_t$ 为节点间通过直线规则生成的边集合。
* $C_t: V_t \\cup E_t \\rightarrow \\{Black, White\\}$ 为特征函数，映射点与边的阵营归属。

【图论连通性公理】
图 $G_t$ 中存在两个特殊的固定基点 $v_{black}^* = (0,0)$ 与 $v_{white}^* = (N-1,0)$。对于任意时刻 $t$ 的任意同色子图 $G^{color}_t$，其包含的所有顶点和边，必须在图论意义上与对应的基点 $v_{color}^*$ 属于同一个连通分量。

## 三、动作空间与图结构的动态演化

玩家的动作空间定义为在集合 $V_{grid} \\setminus V_t$ 中选择一个合法空顶点。系统状态的转移函数表现为对无向图 $G_t$ 的离散算子操作，严格按以下顺序执行：

1. 落子后，沿六个离散网格方向进行射线扫描，若遇到同色节点且无异色元素遮挡，则生成新边。
2. 若动作坐标正好落在敌方某条边的离散路径上，则该边会被永久删除，这会导致敌方图结构直接分裂。
3. 应用广度优先搜索，在敌方子图中寻找包含其基点的极大连通分量。所有不属于该连通分量的顶点与边都会因违背连通性公理而被剔除。

## 四、强化学习建模：回合制马尔可夫决策过程

为使现代强化学习算法能够求解该博弈，需将其抽象为一个马尔可夫决策过程 $\\mathcal{M} = \\langle \\mathcal{S}, \\mathcal{A}, \\mathcal{P}, \\mathcal{R} \\rangle$。

* 状态张量编码：系统状态可以被编码为一个多通道的二维特征矩阵集合，分别表示黑方节点特征、白方节点特征以及全局邻接矩阵。
* Superko 与 DAG 转移约束：为防止由于割边算子引发的循环博弈，引入基于图结构哈希的历史状态集 $H$。状态转移必须满足 $Hash(S_{t+1}) \\notin H$，从而保证单个 Episode 必然在有限步内到达终局状态。
* 稀疏奖励函数：游戏过程中的即时奖励为 0，仅在终局时调用泛洪注水算法计算各方最终圈地的离散格点基数，并给出最终奖励。`,
  whyThis: `内在张力：你越想进攻，扩张面积越大，其实留下的破绽也越多。你越想保守，你控制的面积就越小，很容易被对方围住。这是一种内在的矛盾。

很像围棋，但比围棋好，因为考虑了线和面，而且有迫移局面，也就是多下一颗子未必好。

不像将棋、中国象棋、国际象棋那样，有不同棋子的限制，缺少一种公平性和同一性，规则繁复，不像上帝的游戏。`,
  thanks: `创始人：zcz
愿景启发:hmy, zem, jhd, dya, yhx, wy, zz, lzh
产品经理：zcz
算法工程师：zcz, Claude code(Opus4.6/Opus4.7/Sonnet4.6), hmy
前端开发工程师：Codex(GPT5.4/GPT5.5), Claude code(Sonnet4.6), zcz
后端开发工程师：Codex(GPT5.4), Claude code(Sonnet4.6), zcz
提示词工程师：zcz, Gemini(3.1Pro/3.1Thinking)
UI设计师：zcz, Codex(GPT5.4)
UE设计师：zcz, yzj, Codex(GPT5.4), wsx
运维工程师：Codex(GPT5.4), zcz, Claude code(Sonnet4.6)
测试工程师：zcz, yzj, wsx, yr
内测用户：zcz, zzm, zfp, yr, csy, cjx, yxy, wrz, hmy, tcj, zjy, wyc, fjh, lh, lhh, lhr`,
});

function normalizeInline(text) {
  return String(text ?? "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/`(.+?)`/g, "$1")
    .trim();
}

export function getGuideMarkdown(key) {
  return GUIDE_MARKDOWN[key] ?? "";
}

export function parseGuideMarkdown(raw) {
  const normalized = String(raw ?? "").replace(/\r\n?/g, "\n").trim();
  if (!normalized) {
    return [];
  }

  const blocks = [];
  const lines = normalized.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed.startsWith("# ")) {
      blocks.push({
        type: "heading1",
        text: normalizeInline(trimmed.slice(2)),
      });
      continue;
    }
    if (trimmed.startsWith("## ")) {
      blocks.push({
        type: "heading2",
        text: normalizeInline(trimmed.slice(3)),
      });
      continue;
    }
    if (trimmed.startsWith("* ")) {
      blocks.push({
        type: "bullet",
        text: normalizeInline(trimmed.slice(2)),
      });
      continue;
    }
    if (/^\d+\.\s+/.test(trimmed)) {
      const [, order, content] = trimmed.match(/^(\d+)\.\s+(.+)$/) ?? [];
      blocks.push({
        type: "ordered",
        order: Number(order ?? 0),
        text: normalizeInline(content ?? trimmed),
      });
      continue;
    }
    if (/^[^：:]{1,24}[：:]\s*.+$/.test(trimmed)) {
      const [, label, value] = trimmed.match(/^([^：:]{1,24})[：:]\s*(.+)$/) ?? [];
      blocks.push({
        type: "meta",
        label: normalizeInline(label ?? ""),
        text: normalizeInline(value ?? ""),
      });
      continue;
    }
    if (/^【.+】$/.test(trimmed)) {
      blocks.push({
        type: "callout",
        text: normalizeInline(trimmed),
      });
      continue;
    }
    blocks.push({
      type: "paragraph",
      text: normalizeInline(trimmed),
    });
  }

  return blocks;
}
