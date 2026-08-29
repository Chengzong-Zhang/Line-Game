# D6：状态混淆证据、Superko 见证与负结果

日期：2026-08-25

规则范围：当前 `lifeline_rl` 双人规则、标准初始状态、边长 5--15

## 结论先行

D6 没有发现原计划要求的两类**严格配对**反例，因此不能把“两类严格反例”标记为完成。
不过，后续定向搜索已经找到边长 6 从标准初态自然可达的 Superko 拒绝；这推翻的是
“较大棋盘没有自然 Superko”的猜测，不会自动补成缺失的双历史配对别名。当前可复现证据是：

1. 两个自然可达的弱拓扑混淆对：完整 `grid` 编码相同，逻辑边不同；
2. 一个自然可达的弱历史混淆对：完整 `topology` 编码相同，Superko 历史不同；
3. 边长 5 的完整负结果：严格拓扑反例和严格 Superko 历史反例均不存在；
4. 边长 6 的自然 Superko 见证：第 11 个动作候选因重复第 5 步后的规则位置而被拒绝；
5. 边长 6 的严格配对别名仍只有有界负搜索：在已执行预算内没有找到双自然历史见证，
   但这不是不存在性证明。

机器可读配对数据集位于
`state_aliasing/pairs_v1.json`，搜索统计位于
`state_aliasing/search_report_v1.json`，自然 Superko 见证位于
`state_aliasing/superko_n6_witness_v1.json`。独立红队证书位于
`d6_redteam_exact_audit.json`；规则消融的规范耦合工程验证位于
`results/validation/superko_ablation_n6_n7_canonical_pilot_20260825.json`，
完整方案与结果解释见 `SUPERKO_ABLATION_PROTOCOL.md` 和
`SUPERKO_ABLATION_RESULTS.md`。

## 形式化定义

令完整规则状态为

\[
x=(B,E^{\mathrm B},E^{\mathrm W},H,p,k,z),
\]

其中 (B) 是五值物理棋盘，(E^{\mathrm B},E^{\mathrm W}) 是双方有类型的
逻辑边，(H) 是 Superko 状态键集合，(p) 是当前玩家，(k) 是连续跳过
次数，(z) 是终局标记。`turn_count` 不影响规则和观测，因此不进入等价关系。

实现中的三个观测映射为：

- \(\phi_{\text{grid}}\)：棋盘、归一化坐标、当前玩家、连续跳过次数和
  `legal_action_mask`；全零掩码同时暴露终局；
- \(\phi_{\text{topo}}\)：\(\phi_{\text{grid}}\) 加物理邻接和双方逻辑边；
- \(\phi_{\text{full}}\)：\(\phi_{\text{topo}}\) 加稳定的历史摘要集合。

这里必须强调：实现的 `grid` 和 `topology` 都包含合法动作掩码。因此“合法动作不同”
不可能同时满足实现观测完全相等。若论文要把合法性差异本身作为状态混淆证据，必须另行
定义不含掩码的 \(\phi^-_{\text{grid}}\) 或 \(\phi^-_{\text{topo}}\)，不能与当前编码
混用。

### 严格拓扑反例

一对自然可达状态 (x,x') 必须满足

\[
\phi_{\text{grid}}(x)=\phi_{\text{grid}}(x'),\qquad
(E^{\mathrm B},E^{\mathrm W})\ne(E'^{\mathrm B},E'^{\mathrm W}),
\]

并至少满足以下一项：某共同动作的奖励、终止或下一
\(\phi_{\text{grid}}\) 不同；在固定的精确零和求解定义下，共同动作的 (Q) 值、
状态价值或最优动作要求不同。仅“最优动作集合不相等”不一定迫使共享观测策略失败，
因为两个集合可能仍有交集；更强的策略不充分证据应要求最优集合不相交，或计算共享动作的
最小不可避免遗憾。

### 严格历史／Superko 反例

按原研究问题使用不含掩码的当前拓扑状态等价：棋盘、双方逻辑边、当前玩家、跳过和终局
完全相同，但历史集合不同，并存在具体动作 (a)，使一侧成功而另一侧恰因
`SUPERKO_VIOLATION` 被拒绝。若使用实现的 `topology` 编码，则该合法性差异已经由掩码
暴露，不能再称为实现观测别名。

## 命题与证据

### 命题 1：弱拓扑混淆自然可达

存在从标准初态出发的动作历史，使实现的完整 `grid` 观测相同而逻辑边不同。
数据集给出两个确定性见证：

| 配对 ID | 边长 | 历史长度 A/B | 差异 | 严格性 |
| --- | ---: | ---: | --- | --- |
| `weak_grid_topology_n5_v1` | 5 | 12 / 10 | A 独有白边 `(4,0)--(1,3)` | 弱 |
| `weak_grid_topology_n6_v1` | 6 | 8 / 8 | A 独有黑边 `(0,0)--(0,3)` | 弱 |

两对状态的 `grid` JSON SHA-256 在各自配对内部完全相同，`topology` SHA-256 不同；
完整动作历史、棋盘、状态指纹、历史键数量和逻辑边差异都已写入数据集并由测试重放。

边长 5 见证唯一共同落子 `(0,4)` 后，两侧仍有相同的 `grid` 后继、相同终局胜负和
奖励，只保留逻辑边差异。因此它证明“逻辑边不能由当前 Grid 唯一识别”，但不证明
“逻辑边对决策必要”。

### 命题 2：弱历史混淆自然可达

`weak_history_alias_n5_v1` 的两条长度 4 历史到达相同的完整 `topology` 观测，
但历史集合不同。两侧各有 5 个历史键，完整状态指纹和 `topology_history` 摘要不同。
当前三个合法落子及 PASS 的直接 `topology` 后继均相同，逐点检查也都没有
`SUPERKO_VIOLATION`。因此这同样是弱反例，不是历史决策必要性的证据。

### 命题 3：边长 5 不存在两类严格反例

`validate_or_search_superko.py` 枚举了从标准边长 5 初态可达的完整、去历史原始图：

- 25,096 个唯一状态；
- 67,505 条转移；
- 14,855 个不同落子历史键；
- 25,096 个节点全部进入拓扑序，故原始图是 DAG；
- 最长原始路径为 40。

在 DAG 上向前传播所有可能出现在到达路径中的单个历史键，没有任何落子边重复已传播键。
所以边长 5 的任何自然轨迹都不会触发 Superko，严格历史／Superko 反例不可能存在。

独立红队求解器从每个非终局状态显式执行 PASS，再做逆拓扑零和动态规划。它比较了
976 个 Grid 混淆组中的 1,088 对“同 Grid、不同逻辑边”状态，结果如下：

| 严格差异指标 | 状态对数量 |
| --- | ---: |
| 合法动作集不同 | 0 |
| 下一实现 Grid 观测不同 | 0 |
| 精确黑方价值不同 | 0 |
| 共同动作 Q 值不同 | 0 |
| 最优动作集合不同 | 0 |
| 最优动作集合不相交 | 0 |

这是边长 5、当前规则实现和标准初态范围内的完整负结果，不应外推到边长 6--15。

### PASS 审计修正

早期精确求解器只在 `consecutive_skips == 1` 时补入终局 PASS，漏掉了 2,080 个
`consecutive_skips == 0`、PASS 后因对手自动无棋可走而直接终局的分支。该遗漏影响
294 个状态价值和 1,272 个最优动作集合。独立红队求解器修正了所有 PASS 分支；修正后
严格反例数量仍为 0。论文只能引用修正后的红队证书，不能引用旧价值表作为精确证据。

### 命题 4：边长 6 的自然轨迹可以触发 Superko

从标准 6×6 初态出发，下面的带执棋方动作序列完全合法，直到最后一个候选动作：

```text
B(0,1), W(4,0), B(2,0), W(1,4), B(2,3),
W(2,2), B(3,1), W(1,4), B PASS, W(1,1),
B(2,3) -> SUPERKO_VIOLATION
```

第 5 步后的规则位置键 SHA-256 为
`c1362c7a100c1c512e2345740f4d9cbd1c34c12b7ab708d65dac681365c14608`。
从该位置开始的六步闭环
`W(2,2) -> B(3,1) -> W(1,4) -> B PASS -> W(1,1) -> B(2,3)`
在 `superko_mode="observe"` 下会精确回到同一棋盘、双方逻辑边、当前玩家、PASS
计数和终局状态，并可继续重复；在默认 `enforce` 模式下，最后一步被事务性拒绝。
“六步”只描述这个见证的闭环长度，不是全局最短性证明。

这个见证证明 Superko 在自然可达的 6×6 状态上确实会约束动作，也给出了删除相应历史键
或关闭执行规则后合法性改变的反事实证据。它仍**不是**严格历史配对别名：当前尚未找到
两条自然合法历史到达相同的无掩码 Topology、拥有不同历史集合，并使同一动作只在一侧
触发 Superko。因此不能据此宣称已实现的 Grid/Topology 观测非马尔可夫。

## 较大棋盘的有界搜索

| 搜索 | 预算 | 可达状态/成对状态 | 结果 |
| --- | --- | ---: | --- |
| 5×5 攻击偏置随机 | 10,000 局，seed `20260826` | 112,847 | 最终 mask-aware、含 PASS 分类器未找到两类严格见证；自然 Superko 0 |
| 6×6 旧攻击偏置随机 | 5,000 局，seed `20260826` | 88,379 | 未找到两类严格见证；该轨迹采样器不主动选择 PASS，因此该次“自然 Superko 0”不能再作为不存在证据 |
| 6×6 PASS 感知定向随机 | 上限 5,000 局，seed `20260826` | 第 489 局找到；累计 8,757 plies | 找到上述标准初态自然 Superko 拒绝 |
| 6×6 弱对共享续局 BFS | 上限 5,000 对状态、深度 20 | 5,000 对、12,656 动作 | 深度达到 7；未找到分叉；前沿仍有 6,295 |

共享续局搜索明确是 `NOT_FOUND_WITHIN_BUDGET`。它有未清空前沿，不能写成穷尽结论。
前两次旧随机搜索使用同一版状态标签与直接分类器；Grid 碰撞键包含合法动作掩码，并在
每个直接配对上同时检查所有合法落子与 PASS。但是，旧轨迹采样器本身不主动选择自愿
PASS；新见证恰好依赖一次 PASS，所以旧 n=6 运行的零触发只描述其固定预算和采样分布。
旧搜索完整输出分别保存在
`results/validation/d6_random_n5_final.json`（SHA-256
`A03F3243AAEA3DAE5B87C25285814B46A0AE7D85857E28E761CADE57AAA2B56A`）和
`results/validation/d6_random_n6_final.json`（SHA-256
`AC5C6F46AD3F33AA2BDB8DFF9C67FD9E9AFCF86F038BACF911D97E8EA425E788`）。
两次运行统一使用 `max_plies=100`、`seed=20260826`、`attack_weight=12`；它们仍是有界搜索，
而 n=5 的不存在性结论来自覆盖全部动作与 PASS 的完整枚举。

自然 n=6 搜索原始产物为
`results/validation/superko_random_n6_seed20260826.json`（SHA-256
`EFB6BF27D35E8894D9F8C749C8C86765CBCF957060B55AA8456C006051A84CA0`），冻结重放见证为
`state_aliasing/superko_n6_witness_v1.json`。Python 与独立 Web 规则实现均匹配该自然前缀
和最终拒绝。

## Superko 规则消融：规范耦合工程验证

环境提供两种显式模式：默认 `enforce` 拒绝重复位置；`observe` 允许该动作、继续维护历史，
并通过 `would_violate_superko` 标记本应触发的动作。规范 schema-v2 runner 对每个具体落点
使用共享、与候选集合大小无关的 SHA-256 keyed priority；加入一个较低优先级候选不会改变
已选共享动作。这修正了早期探索性 rank coupling 的动作集合重映射问题。

固定攻击偏置+自愿 PASS 策略在 n=6、n=7 各运行 2,000 对完整对局，公共随机数、
`max_plies=120`、seed `20260826`，结果如下：

| 指标 | n=6 | n=7 |
| --- | ---: | ---: |
| Superko 触发对局 | 0 / 2,000 | 2 / 2,000 |
| 触发率 Wilson 95% CI | 0%--0.1917% | 0.0274%--0.3639% |
| `observe` 实际选择重复动作 | 0 局 / 0 动作 | 1 局 / 2 动作 |
| 轨迹分歧 | 0 / 2,000 | 1 / 2,000（0.05%） |
| 胜者一致 | 2,000 / 2,000 | 2,000 / 2,000 |
| 两模式 B/W/D | 1,020 / 948 / 32 | 1,043 / 934 / 23 |
| 两模式截断 | 0 | 0 |
| 平均 plies：`enforce` / `observe` | 17.3725 / 17.3725 | 24.5780 / 24.5755 |
| 相对平均局长差 | 0 | -0.01017% |
| 相对局长 paired-bootstrap 95% CI | [0, 0] | [-0.03076%, 0] |
| 非零黑方得分差对局 | 0 / 2,000 | 0 / 2,000 |

内部固定门限在这个 policy/尺寸/horizon 上全部通过：黑方得分差在 +/-5 个百分点内，
相对局长差在 +/-5% 内，截断率差在 +/-1 个百分点内，且 `observe` 截断率 Wilson 上界
0.1917% 小于 1%。两种尺寸的非零黑方得分差均为 0/2,000，其 Wilson 95% 上界同为
0.1917%；零事件 bootstrap 的 `[0,0]` 不能解释为总体效应精确为零。

因此可用表述是：在这一固定攻击+PASS 策略、n=6/n=7 和 120-ply horizon 下，两种模式
的经验胜负与局长**实际相近**，且 Superko 触发很少；不能写成规则等价、可以删除
Superko、训练策略不受影响或真正关闭历史后的运行成本相同。方法在查看早期探索输出后
修订，规范重跑复用了 seed，且只有一个手工策略，所以它是内部工程验证，不是外部预注册
或多种子确认性实验。

规范产物采用 schema v2，SHA-256 为
`4F31ECB8F53ADD3151CE0B879CB3C9AD296F21C5D4B6B9553A9E6DD21221EE09`；runner SHA-256 为
`38FD1D436F7AB9C416BD540C09969BC99646BC16A051D292D855E02916AC162F`。早期 100 局 smoke
和 rank-coupled 2,000 局产物只保留为探索证据，不提供主路径分歧结论。

## 可复现命令

从仓库根目录运行：

```powershell
python .\research\iclr2027\scripts\validate_or_search_superko.py --mode exhaustive --grid-size 5
```

```powershell
python .\research\iclr2027\scripts\d6_redteam_exact_audit.py --output .\research\iclr2027\d6_redteam_exact_audit.json
```

```powershell
python .\research\iclr2027\scripts\search_state_aliasing.py --mode paired --pair-id weak_grid_topology_n6_v1 --max-pair-states 5000 --max-depth 20 --summary-only
```

```powershell
$env:PYTHONPATH="$PWD\research\iclr2027"
python -B -m unittest tests.test_d6_aliasing -v
```

```powershell
$env:PYTHONPATH="$PWD\research\iclr2027"
python -B -m unittest tests.test_superko_ablation -v
```

复现规范耦合消融：

```powershell
python -B .\research\iclr2027\scripts\run_superko_ablation.py --sizes 6 7 --episodes 2000 --max-plies 120 --seed 20260826 --pass-probability 0.12 --attack-bias 0.95 --progress --summary-only --output .\research\iclr2027\results\validation\superko_ablation_n6_n7_canonical_pilot_20260825.json
```

较长随机预算：

```powershell
python .\research\iclr2027\scripts\search_state_aliasing.py --mode random --grid-size 5 --episodes 10000 --max-plies 100 --seed 20260826 --attack-weight 12 --keep-searching --summary-only
```

```powershell
python .\research\iclr2027\scripts\search_state_aliasing.py --mode random --grid-size 6 --episodes 5000 --max-plies 100 --seed 20260826 --attack-weight 12 --keep-searching --summary-only
```

随机和成对搜索在未找到严格见证时返回非零状态码，用 JSON 的
`NOT_FOUND_WITHIN_BUDGET` 区分正常负搜索结果与脚本错误；`exact-n5` 完成完整枚举且未找到
见证时返回 0。

## 论文可用与不可用表述

当前可用：

> 我们构造了自然可达的配对状态，证明当前 Grid 不能唯一识别潜在逻辑拓扑，当前
> Topology 也不能唯一识别历史。完整 5×5 枚举进一步显示，这些潜在差异在小棋盘上
> 不改变合法性、一步观测转移、精确价值、Q 值或最优动作，并且自然 Superko 不会触发。
> 与此不同，我们给出一条标准初态可达的 6×6 轨迹，其中 Superko 拒绝一个会闭合六步
> 循环的动作；这证明规则可触发，但不构成双自然历史的严格配对别名。

当前不可用：

- “当前 Grid 编码是非马尔可夫的”；
- “逻辑边是最优决策的信息论必要输入”；
- “Superko 历史产生自然可达的决策别名”；
- “边长 6--15 不存在严格配对反例”；
- “有无 Superko 在策略结果或计算成本上等价”；
- 用有限随机搜索的未找到结果冒充不存在性证明。

因此 D6 当前最合适的论文定位是“表示可识别性诊断 + 小棋盘精确负结果 + 中棋盘自然
规则触发见证 + 尺度增长假设”，而不是已经证成的状态非马尔可夫性或规则等价结论。
