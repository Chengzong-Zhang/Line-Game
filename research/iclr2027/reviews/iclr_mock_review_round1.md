# LIFELINE-RL ICLR 模拟评审 Round 1

审计日期：2026-08-29  
角色：独立模拟评审与复现负责人（AI-3）  
结论：**Reject；必须先关闭 P0，再讨论科学性加分。**

## 1. 评审快照与独立性

本轮只评价 2026-08-29 11:40 捕获的候选稿，不用后续补丁追溯性地提高
Round 1 分数：

| 工件 | Round 1 SHA-256 | 观察 |
|---|---|---|
| `research/iclr2027/paper/main.pdf` | `BAD6AF30D084C1F0DEFCAD6DE08D277BF900DC614B01FE1BFAD5C6854C44F967` | 7 页；无 Related Work、正文引用或 References |
| `research/iclr2027/paper/main.tex` | `F3F584F4DD880EF3A069FBF3CDAA2AFF6AAFB2486B80620A790D8074BC86AB7A` | Round 1 源快照 |

评审不修改 `paper/**`、`configs/**`、`scripts/**`、`results/**` 或实验代码，
不调参、不补跑训练、不使用 AutoDL。实验数字从冻结 task bundle、receipt、逐局工件和
checkpoint 绑定独立核验；`formal_ready=true` 只按工件完整性解释。

评分采用 1--10：3 为 Reject，4 为 Weak Reject。三位 reviewer 的均值为
**3.33/10**，中位数为 **3/10**。

## 2. Reviewer A：创新性与相关工作（尖锐 benchmark reviewer）

### Summary

论文提出一个确定性自博弈游戏环境，将三角格、玩家特定逻辑连边、级联删除和 Superko
历史约束组合起来，并提供较强的状态快照、重放和审计工件。但在 Round 1，稿件甚至没有
Related Work 和 References；更本质地，当前证据更像一个做工扎实的单游戏环境与负结果
审计案例，尚未建立足够宽的 ICLR benchmark 新颖性。

### Strengths

- 区分了潜在拓扑差异与决策相关差异，side-5 完整枚举得到否定结果后没有强行改写成
  正面发现。
- 完整状态、动作 mask、序列化、逐局重放和 receipt 设计有实质复现价值。
- 当前结果边界原则上允许环境贡献独立于正面的模型排名。

### Weaknesses

1. Round 1 PDF 无 Related Work、正文引用和参考文献，无法判断贡献是否重复已有工作。
2. 未与最接近的 Ludii、Regular Boardgames、Polygames、Hex 尺寸迁移或棋类 GNN
   正面比较；只比较通用 RL/GNN 背景不足以建立 benchmark 新颖性。
3. 仓库根 `README.md:3-12` 明示这是单一自定义规则游戏；冻结研究合同
   `research/iclr2027/D1_research_contract.md:278-286` 也承认需要规则消融、跨尺寸
   泛化或合成任务来回答“只是另一款游戏”的质疑。
4. `research/iclr2027/experiment_matrix.csv:10-14` 中 n=10/12 零样本、逻辑边、
   History/Superko、cascade 和完整 compute match 仍是 `planned`/`gated`。
5. `research/iclr2027/lifeline_rl/alphazero/network.py:125-172,224-238` 显示
   Grid-GNN 只有一类 relation projection、宽度 82；Topology-GNN 有三类 relation
   projection、宽度 64。这不是“只增删逻辑边”的纯表示消融。

### Questions

1. 哪些 LIFELINE 机制或任务不能由 Ludii、Regular Boardgames、OpenSpiel 或
   Polygames 表达？
2. 相比 Hex、Havannah、Twixt、Go/Superko 等连接或历史敏感游戏，新增的究竟是
   规则、接口、验证方法，还是一套可迁移 benchmark？
3. 能否使用完全相同的三关系网络和宽度，只把 own/opponent logical adjacency 清零？
4. side-5 没有决策相关别名、自然 Superko 触发又极少时，什么证据表明 topology/history
   是主要学习难点？
5. n=10/12 和三类关键消融未完成时，为何应称完整 benchmark 而非 environment paper？

### Reproducibility concerns

- Round 1 缺少任何可核验引用；真实性检查无法开始。
- `research/iclr2027/D14_D16_RESULTS.md:161-185` 已说明 D16 重复轨迹和关键消融缺失；
  这些边界不能由 pooled-game 图表消除。
- 单一公开仓库还包含既有可玩游戏资产；论文必须说明 benchmark 新增部分和既有资产的
  时间线。

### Score and confidence

- **Score: 3/10 (Reject)**
- **Confidence: 4/5**

## 3. Reviewer B：实验与统计（方法学怀疑型 reviewer）

### Summary

实验工件链显著强于统计结论。冻结 manifest、330 份 receipt、30,600 条逐局记录、
checkpoint/config/source hash 和失败门具备良好审计基础；然而 D16 每个 200-game task
只有两条确定性轨迹，五个训练 seed 的不确定性远大于 pooled Wilson 所暗示的精度，且
Grid-GNN/Topology-GNN 混合了关系算子数与宽度。

### Strengths

- 330/330 task 有 receipt；没有 missing、extra、duplicate、failed 或 truncated task。
- 30,600 条评估记录可解析；checkpoint、resolved config 和源码身份有哈希绑定。
- 逐局重放能核对 actor、动作索引、winner 和 territory。
- 训练 seed、board-size schedule 和 game-seed schedule 在三表示间匹配。

### Weaknesses

1. **伪重复。** 45 个 D16 round-robin task 每个 200 局都只有 2 条完整动作轨迹和
   2 个按颜色区分的开局簇；100 个 pair seed 没有产生新轨迹。
2. **推断单位错误风险。** Pooled Wilson 只能描述 task-indexed records，不能代替
   training-seed 或 seed×opening-cluster 推断；五个训练 seed 的探索性 t 区间均很宽。
3. **架构混淆。** 参数量接近不等于表示因果隔离；Grid 与 Topology 的 relation
   projection 数和宽度不同。
4. **核心证据缺失。** n=10/12、逻辑边、TopologyHistory/Superko、cascade、完整
   BASE-SEARCH 和严格 compute match 尚未完成。
5. **“compute-matched”过强。** 只匹配 simulation count=16；UCT depth-80 rollout
   与神经 PUCT 推理的墙钟、FLOPs、内存和节点扩展没有匹配。
6. **“30,600 unique games”误导。** 唯一的是 task/game identity，不是动作轨迹或
   独立样本；应写 `30,600 task-indexed replay-verified game records`。
7. 两次 runner `exit_code=-1` 没有独立 canonical attempt 文件，不能声称完整
   per-attempt provenance。

### Questions

1. 为什么 Grid control 不保留与 Topology 完全相同的三关系算子和宽度？
2. 作者是否会发布逐训练 seed W/D/L，并预注册 seed/paired-opening 层级推断？
3. “compute matched”具体指 simulation 数、墙钟、FLOPs 还是扩展节点数？
4. n=10/12 与消融是本次投稿承诺，还是明确的未来工作？
5. 是否会把全文 `unique games` 改为准确的 `game records`？

### Reproducibility concerns

- `research/iclr2027/D14_D16_RESULTS.md:180-185` 正确写明
  `formal_ready=true` 只表示任务、身份、预算、重放和工件完整；论文不得把它解释成
  模型优越性。
- D16 的 Wilson 区间是描述性区间，不能用作 1,000 个独立游戏的置信推断。
- 缺失任务不得静默排除；任何新 aggregate 都必须与 330-task ledger 做集合相等检查。

### Score and confidence

- **Score: 4/10 (Weak Reject)**
- **Confidence: 5/5**

## 4. Reviewer C：复现与投稿（desk-reject 风险 reviewer）

### Summary

Round 1 不是可提交包。除缺失 Related Work/References 外，它使用 ICLR 2026 style
并手写 2027 页眉，缺少 ICLR 2027 强制 AI-use statement，也没有明确 allowlist 的
匿名 supplement。论文对 release 的描述与当前可发布 Git 快照不一致。

### Strengths

- 主 PDF 的作者栏为 Anonymous，PDF Author metadata 为空。
- Letter 页面和基本 ICLR 样式可渲染。
- 项目已有 manifest、receipt、aggregate 和 verifier，可形成良好匿名 supplement 的
  原料。

### Weaknesses

1. 官方 ICLR 2027 Author Guidelines 要求使用 2027 style；Round 1 使用
   `research/iclr2027/paper/iclr2026_conference.sty` 并手写 2027 页眉。
2. 官方 AI Policy 要求论文中有 mandatory AI-use section，同时在 submission form
   披露；Round 1 没有该 section。
3. 论文声称 release 含 checkpoints/逐局工件，但 `.gitignore:36-50` 排除了 checkpoint、
   task arena 和 `games.jsonl`；当前没有匿名 supplement manifest 或 zip。
4. 不能提交整仓作为 supplement：tracked 路径
   `submission/241098117-张城宗/**` 和 remote
   `github.com/Chengzong-Zhang/Line-Game.git` 明确泄露身份；tracked AutoDL policy 和
   validation JSON 还包含 `C:/Users/zcz`。
5. Python/PyTorch/CUDA 没有 lockfile/container；`pyproject.toml` 的宽依赖范围不足以
   恢复论文所报的 Python 3.10.20、PyTorch 2.7.1+cu118、CUDA 11.8 环境。

### Questions

1. 匿名 supplement 的精确 allowlist 是什么？是否在隔离目录中二次扫描姓名、用户名、
   绝对路径、remote URL 和 PDF metadata？
2. checkpoint 和 raw replay 是随 supplement、匿名对象存储还是录用后发布？
3. 官方 2027 style 与 AI-use section 何时替换/补齐？
4. 干净环境的唯一安装和完整复现命令是什么？

### Reproducibility concerns

- Round 1 PDF 没有引用，引用真实性和完整性失败。
- 没有锁定依赖或容器，clean-environment 复现尚未证明。
- 当时 LaTeX 交叉引用/红框与大面积空白尚未完成视觉 QA。
- 官方规则来源：
  - <https://iclr.cc/Conferences/2027/AuthorGuidelines>
  - <https://media.iclr.cc/Conferences/ICLR2027/iclr-2027-style-files.zip>
  - <https://iclr.cc/Conferences/2027/AIPolicyForAuthors>

### Score and confidence

- **Score: 3/10 (Reject)**
- **Confidence: 5/5**

## 5. 去重后的问题总表

### P0（4）

| ID | 阻塞项 | 具体证据 |
|---|---|---|
| R1-P0-01 | 无 Related Work、正文引用和 References | Round 1 PDF `BAD6...F967` 的 7 页文本抽取；后续补丁不得回写本轮 |
| R1-P0-02 | 投稿模板错误 | `paper/iclr2026_conference.sty`；Round 1 源使用 2026 style 并手写 2027 页眉；官方 2027 style zip 已发布 |
| R1-P0-03 | 缺 mandatory AI-use statement | Round 1 全文无该 section；ICLR 2027 AI Policy 明确要求正文和 submission form 披露 |
| R1-P0-04 | 没有一致、匿名、可提交的 supplement/release | `.gitignore:36-50` 排除承诺工件；tracked `submission/241098117-张城宗/**`、remote 和本机路径泄露身份 |

### P1（9）

| ID | 主要问题 | 具体证据 |
|---|---|---|
| R1-P1-01 | 缺最近邻 benchmark/general-game/棋类 GNN 比较 | Round 1 无 Related Work；Ludii、Regular Boardgames、Polygames、Hex transfer、棋类 GNN 未比较 |
| R1-P1-02 | 单游戏外部效度弱且关键主张证据未完成 | `D1_research_contract.md:278-286`；`experiment_matrix.csv:10-14` |
| R1-P1-03 | Grid/Topology 架构混淆 | `lifeline_rl/alphazero/network.py:125-172,224-238` |
| R1-P1-04 | D16 伪重复，pooled Wilson 不能代替 seed/cluster 推断 | 45 个 D16 task×200 局；每 task 2 条轨迹；`D14_D16_RESULTS.md:161-180` |
| R1-P1-05 | compute matching 只匹配部分预算 | `experiment_matrix.csv:14`；墙钟、FLOPs、内存和环境步未匹配 |
| R1-P1-06 | `30,600 unique games` 语义错误 | 30,600 是 task-indexed records；D16 的 9,000 条记录高度重复 |
| R1-P1-07 | 环境未锁定，clean install 未证明 | `research/iclr2027/pyproject.toml` 的宽版本约束；无 lockfile/container |
| R1-P1-08 | LaTeX/视觉构建尚未稳定 | Round 1 交叉引用/红框和第 7 页大面积空白；无稳定 clean-copy build receipt |
| R1-P1-09 | per-attempt lineage 不完整 | `results/formal/d14_d16/runner_control_v1/RECOVERY_INCIDENT.md:17-55` |

### P2（4）

| ID | 次要问题 | 具体证据 |
|---|---|---|
| R1-P2-01 | “Most board-game benchmarks ...” 过宽且无支持 | Round 1 Introduction 开头 |
| R1-P2-02 | Round 1 版式有大面积空白和不稳定链接框 | Round 1 PDF 第 7 页及全页视觉检查 |
| R1-P2-03 | README/环境/投稿文档与实际状态漂移 | 根 `README.md`、paper handoff 与 Round 1 PDF 状态不一致 |
| R1-P2-04 | 缺推荐的 Reproducibility Statement | Round 1 目录与正文均无独立 statement |

## 6. Round 1 决定

- **P0/P1/P2：4 / 9 / 4（去重后）。**
- 三 reviewer 分数：**3、4、3**；共识为 **Reject**。
- 不允许把 `formal_ready=true`、pooled Wilson 或 smoke 结果写成模型优越性。
- 关闭全部 P0 以前，不进入最终 submission packaging；科学 P1 即使全部诚实披露，仍会
  使当前工作处于 weak-reject 区间。
