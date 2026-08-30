# LIFELINE-RL 独立实验审计（Round 1）

- 审计角色：独立实验与统计审稿人
- 审计日期：2026-08-29（Asia/Shanghai）
- 工作目录：C:\coding\py\line game
- 审计对象：D14--D16 冻结协议、正式 manifest、task bundle、原始 task/receipt/game/checkpoint 证据
- 总体判断：**原始数字与正式证据链内部一致；核心表示比较仍需要修订统计解释与主张边界**
- 问题计数（仅本文件的 D14--D16 实验子审计，不是 submission-wide 总数）：
  **P0 = 0，P1 = 5，P2 = 2**

本审计未参与论文主张设计，未修改训练参数、实验代码、配置、结果或
paper/main.tex；未补跑训练，也未使用 AutoDL。完整性通过不等于科学主张通过。
本文件含本机绝对路径，仅供内部审计，不得原样放入匿名 supplement。

## 1. 独立性、证据顺序与审计边界

### 1.1 审计顺序

为了避免被 AI-2 的聚合结论锚定，本轮按以下顺序执行：

1. 先读取冻结 manifest、task bundle、result ledger、每个 task 的 receipt、
   receipt 绑定的原始 CSV/JSONL、训练日志和 checkpoint；
2. 从原始逐局记录独立复算任务集合、W/D/L、score、seed/board-size
   调度、失败/截断/缺失、轨迹簇和哈希；
3. 冻结上述复算表和 mismatch 计数；
4. 仅在第 3 步后打开 aggregate_v1 和 D14_D16_RESULTS.md，进行事后逐项比对。

因此，下文“独立复算”不以 aggregate_v1 或 D14_D16_RESULTS.md 为输入。
聚合文件只用于回答“AI-2 聚合与独立复算是否一致”。

### 1.2 原始证据

主要证据如下：

- research/iclr2027/configs/d14_d16_formal_manifest.json
- research/iclr2027/results/formal/d14_d16/task_bundle_v1/training_tasks.jsonl
- research/iclr2027/results/formal/d14_d16/task_bundle_v1/evaluation_tasks.jsonl
- research/iclr2027/results/formal/d14_d16/run_v1/result_receipts.jsonl
- research/iclr2027/results/formal/d14_d16/run_v1/tasks/**/receipt.json
- research/iclr2027/results/formal/d14_d16/run_v1/tasks/**/arena/games.csv
- research/iclr2027/results/formal/d14_d16/run_v1/tasks/**/arena/games.jsonl
- research/iclr2027/results/formal/d14_d16/run_v1/tasks/**/training_run/**
- research/iclr2027/results/formal/d14_d16/runner_control_v1/RECOVERY_INCIDENT.md

事后比对对象：

- research/iclr2027/results/formal/d14_d16/aggregate_v1/aggregate.json
- research/iclr2027/results/formal/d14_d16/aggregate_v1/*.csv
- research/iclr2027/D14_D16_RESULTS.md

### 1.3 审计粒度

本轮区分四种不同粒度，不能互相替代：

1. task：训练或评估调度单元；
2. task-indexed game record：(task_id, game_index) 唯一的逐局记录；
3. action trajectory：完整动作序列；D16 中大量 game record 共用同一轨迹；
4. training seed：五个训练随机种子，是当前最接近可用于跨训练运行推断的单位。

## 2. 完整性与证据链复核

### 2.1 任务、收据和逐局记录

| 检查项 | 独立结果 | 状态 |
|---|---:|---|
| 训练任务 | 15 | 一致 |
| 评估任务 | 315 | 一致 |
| 总任务 / task 目录 / receipt | 330 / 330 / 330 | 一致 |
| 缺失 / 额外 / 重复 task_id | 0 / 0 / 0 | 通过 |
| complete / failed | 330 / 0 | 通过 |
| 训练 self-play games | 1,500 | 一致 |
| 梯度更新 | 3,000 | 一致 |
| 评估逐局记录 | 30,600 | 一致 |
| 截断评估局 | 0 | 通过 |

30,600 条评估记录可从调度直接分解为：

- learning curve：180 tasks × 20 games = 3,600；
- final vs search：90 tasks × 200 games = 18,000；
- representation round robin：45 tasks × 200 games = 9,000。

这里的 30,600 是 task-indexed records 数，不是 30,600 条不同动作轨迹。

### 2.2 哈希、配置与 checkpoint 绑定

| 检查项 | 通过数 | 失败数 |
|---|---:|---:|
| arena summary / games JSONL / games CSV | 945 / 945 | 0 |
| resolved config / metrics / self-play log | 45 / 45 | 0 |
| checkpoint 文件 SHA-256 | 75 / 75 | 0 |
| checkpoint canonical config/source binding | 75 / 75 | 0 |
| receipt execution identity | 330 个 receipt 共 1 个 identity | 0 |

当前文件与 receipt 记录相符的关键身份如下：

| 身份 | SHA-256 |
|---|---|
| manifest canonical JSON | 1bbf2c9a9ecc9174cd2d4b4299e22289dea58b7a53885e1be923374add2841cb |
| trainer source identity | 21a46dbd787090fc18c24cb4e29ebe1dd743203d31abeda43b3ce421833b596c |
| formal runner | 55c077c3fe08f7d3527be3950fb4e70b54a743130acaa911da8949f37ec59937 |
| protocol / aggregator | 1b4ca0a7f9115df4b4ecf95fa326425ce77caf6cf57e6a12c26625e279d2145d |
| result ledger 文件 | ff3ef8bfd9b7a443bc42ba16ab9d4daa9f855a5d0432d58a62322686247b8114 |
| aggregate.json 文件（仅事后比对） | 59c264fc65d7b11357b0d718d38371df1ba44be4b92e7ef41ff995bf088f501c |

注意：1bbf... 是 canonical JSON digest，不应与 manifest 原始字节哈希混称。

### 2.3 独立动作重放

独立重放没有调用 arena replay helper 或 D14--D16 aggregator/verifier，而是直接
构造 LifelineGame 并逐动作检查：

- 每个评估 task 抽取 game_index 0 和 1；
- 共 315 × 2 = 630 局；
- 五个 training seed 各覆盖 126 局；
- 630 / 630 通过；
- 检查了 ply 连续性、actor、action-to-point 映射、合法执行、终局/截断、
  winner 和 territory。

这是一项覆盖所有评估 task 的分层抽样重放，不应误写成独立重放了全部
30,600 局。全部 30,600 局的 receipt-bound 文件哈希、行数、W/D/L 和截断数
均已检查；runner receipt 另记录 replay_verified_games = games_completed。

## 3. 调度与训练预算公平性

### 3.1 五种子 board-size 调度

三个表示在每个 seed 使用完全相同的 self-play board-size 序列。按 seed
汇总如下；每行数值对 Padded-CNN、Grid-GNN、Topology-GNN 三者相同。

| seed | n=5 | n=7 | n=9 | 每表示合计 |
|---:|---:|---:|---:|---:|
| 20260825 | 31 | 36 | 33 | 100 |
| 20260826 | 42 | 31 | 27 | 100 |
| 20260827 | 34 | 32 | 34 | 100 |
| 20260828 | 43 | 32 | 25 | 100 |
| 20260829 | 28 | 36 | 36 | 100 |
| 每表示合计 | 178 | 167 | 155 | 500 |

种子和 board-size schedule 对齐通过；每表示共 500 局、三表示共 1,500 局。

### 3.2 参数、环境步与 wall-clock

| 表示 | 参数量 | mean environment steps | mean wall-clock seconds |
|---|---:|---:|---:|
| Padded-CNN | 62,868 | 1,710.4 | 489.8 |
| Grid-GNN | 62,733 | 1,576.8 | 399.2 |
| Topology-GNN | 63,171 | 1,574.8 | 440.0 |

参数量 spread 为 0.6982%，预算中的 self-play games、梯度步、PUCT simulations、
checkpoint 和评估局数匹配。但 environment steps 与 wall-clock 仅报告、未匹配；
manifest 的 matching.wall_clock_seconds 也明确为 reported_not_matched
（d14_d16_formal_manifest.json:130--148）。

## 4. 从逐局记录独立复算的 W/D/L 与 score

score 定义为 (W + 0.5D) / (W + D + L)。下列数值先从 receipt 绑定的原始
games.csv 复算，再与聚合表比对。

### 4.1 Final checkpoint vs Random / UCT-MCTS-16

| 表示 | n | 对手 | W/D/L | score |
|---|---:|---|---:|---:|
| Grid-GNN | 5 | Random | 760/181/59 | 0.8505 |
| Grid-GNN | 5 | UCT-16 | 484/77/439 | 0.5225 |
| Grid-GNN | 7 | Random | 842/99/59 | 0.8915 |
| Grid-GNN | 7 | UCT-16 | 625/41/334 | 0.6455 |
| Grid-GNN | 9 | Random | 926/50/24 | 0.9510 |
| Grid-GNN | 9 | UCT-16 | 831/34/135 | 0.8480 |
| Padded-CNN | 5 | Random | 810/126/64 | 0.8730 |
| Padded-CNN | 5 | UCT-16 | 487/89/424 | 0.5315 |
| Padded-CNN | 7 | Random | 907/63/30 | 0.9385 |
| Padded-CNN | 7 | UCT-16 | 695/31/274 | 0.7105 |
| Padded-CNN | 9 | Random | 967/22/11 | 0.9780 |
| Padded-CNN | 9 | UCT-16 | 907/13/80 | 0.9135 |
| Topology-GNN | 5 | Random | 781/163/56 | 0.8625 |
| Topology-GNN | 5 | UCT-16 | 602/81/317 | 0.6425 |
| Topology-GNN | 7 | Random | 847/125/28 | 0.9095 |
| Topology-GNN | 7 | UCT-16 | 691/48/261 | 0.7150 |
| Topology-GNN | 9 | Random | 913/71/16 | 0.9485 |
| Topology-GNN | 9 | UCT-16 | 848/55/97 | 0.8755 |

### 4.2 D16 representation round robin

为方便解释，下表固定左侧为列出的 A 模型；这会把 aggregate CSV 中
Grid-GNN vs Topology-GNN 的方向翻转为 Topology-GNN vs Grid-GNN。

| n | A vs B | A W/D/L | A score |
|---:|---|---:|---:|
| 5 | Topology-GNN vs Grid-GNN | 600/100/300 | 0.650 |
| 7 | Topology-GNN vs Grid-GNN | 800/0/200 | 0.800 |
| 9 | Topology-GNN vs Grid-GNN | 600/0/400 | 0.600 |
| 5 | Padded-CNN vs Grid-GNN | 400/200/400 | 0.500 |
| 7 | Padded-CNN vs Grid-GNN | 500/100/400 | 0.550 |
| 9 | Padded-CNN vs Grid-GNN | 300/0/700 | 0.300 |
| 5 | Padded-CNN vs Topology-GNN | 600/0/400 | 0.600 |
| 7 | Padded-CNN vs Topology-GNN | 300/0/700 | 0.300 |
| 9 | Padded-CNN vs Topology-GNN | 500/0/500 | 0.500 |

### 4.3 与 AI-2 聚合的事后比较

原始复算冻结后，逐项比较 aggregate_v1 的 72 行：

- W/D/L mismatch：0；
- score mismatch：0；
- Wilson lower/upper mismatch：0；
- score/Wilson 最大绝对误差：0。

结论：AI-2 的聚合算术与本轮独立复算一致。后续 P1 问题针对统计单位、
比较设计和主张，不是否定这些 W/D/L 点估计。

## 5. Seed-level 敏感性与轨迹簇

### 5.1 探索性 seed-level 区间

当前协议没有预注册 seed-level interval。本轮仅作敏感性分析，使用五个训练
seed 的 score：

mean ± t(0.975, 4) × s / sqrt(5)，t(0.975, 4) = 2.776445，
并将端点裁剪到 [0,1]。

这不是新正式检验，不能事后替换成论文主检验。

#### Topology-GNN vs Grid-GNN

| n | 五 seed score（20260825--20260829） | mean | 探索性 t 区间 |
|---:|---|---:|---:|
| 5 | [1.00, 0.50, 0.50, 0.50, 0.75] | 0.650 | [0.372, 0.928] |
| 7 | [0.50, 0.50, 1.00, 1.00, 1.00] | 0.800 | [0.460, 1.000] |
| 9 | [0.50, 0.50, 0.50, 0.50, 1.00] | 0.600 | [0.322, 0.878] |

三个区间都包含 0.5。与 pooled-game Wilson 的窄区间相比，这直接显示把
1,000 行当独立 Bernoulli 单位会严重低估跨训练 seed 的不确定性。

#### Final checkpoint vs UCT-16

| 表示 | n | 五 seed score | 探索性 t 区间 |
|---|---:|---|---:|
| Grid-GNN | 5 | [.4775,.2925,.6800,.7775,.3850] | [.271,.774] |
| Grid-GNN | 7 | [.6550,.5300,.7275,.7300,.5850] | [.536,.755] |
| Grid-GNN | 9 | [.8775,.7000,.9350,.8625,.8650] | [.739,.957] |
| Padded-CNN | 5 | [.5550,.6025,.5050,.3450,.6500] | [.386,.677] |
| Padded-CNN | 7 | [.6700,.7725,.7000,.6250,.7850] | [.626,.795] |
| Padded-CNN | 9 | [.8750,.9350,.9425,.8950,.9200] | [.879,.949] |
| Topology-GNN | 5 | [.7825,.3425,.6775,.7800,.6300] | [.419,.866] |
| Topology-GNN | 7 | [.7625,.6525,.6950,.7500,.7150] | [.660,.770] |
| Topology-GNN | 9 | [.9000,.8350,.8600,.9150,.8675] | [.836,.915] |

对 Random 的九个模型×尺寸格子，探索性 seed-level t 区间下界均高于 0.5；
最低下界为 0.771。因这是事后敏感性分析，论文仍应明确其探索性。

### 5.2 Opening / trajectory cluster

“opening cluster”在本轮只是审计指纹：

(black_slot, first four action indices)

所有比赛都从同一个标准初始状态开始，因此它不是随机 opening 多样性。

| task 类型 | 每 task 完整轨迹数 min/median/max | prefix-4 cluster min/median/max |
|---|---:|---:|
| learning curve | 15 / 20 / 20 | 12 / 19 / 20 |
| final vs search | 102 / 169.5 / 199 | 51 / 117.5 / 170 |
| D16 round robin | 2 / 2 / 2 | 2 / 2 / 2 |

D16 的精确计数：

- 45 tasks、9,000 task-indexed rows；
- 每 task 恰好 2 条动作轨迹；
- task-conditioned、color-conditioned 轨迹合计 90 条；
- 全局按 board size + color assignment 条件化后只有 89 条不同动作轨迹。

因此，D16 的 200 局/task 是同一换色 pair 的确定性重复，不是 200 个独立
游戏样本；五 seed 汇总的 1,000 行也不是 1,000 个独立样本。

## 6. 优先级问题

### P0

本轮未发现 P0：没有缺失正式任务、失败/截断、W/D/L 算术错误、artifact
hash mismatch 或 checkpoint/source binding 失败。

这不解除下列 P1；P1 足以阻止把当前 D16 结果表述为稳健的模型优越性证据。

### P1-1：D16 存在严重伪重复，pooled-game 区间不是独立样本区间

证据：

- D14_D16_EXPERIMENT_PROTOCOL.md:37--41 规定每 task 200 局、100 个换色 pair；
- 原始 D16 games.jsonl 显示每 task 只有 2 条完整动作轨迹；
- D14_D16_RESULTS.md:164--166 也承认 100 个 pair 完全重复确定性轨迹；
- 本审计复算：45 tasks、9,000 rows、每 task 2 条轨迹、全局仅 89 条
  size/color-conditioned 轨迹。

影响：W/D/L 点估计忠实反映该固定调度，但 pooled Wilson 不能表示训练随机性、
opening 随机性或 1,000 个独立对局的不确定性。任何“显著优于”“稳定优越”
或以窄 Wilson 区间支持模型排名的表述均不成立。

给 AI-2 的精确处理要求：

1. 不重训、不补跑本轮缺失训练；
2. 保留原始点估计，但把 pooled Wilson 明确标为 descriptive only；
3. 正式推断以 training seed 或预先定义的 trajectory/opening cluster 为单位；
4. 若未来需要 game-level 推断，先冻结带真实随机 opening/评估随机性的 v2
   协议，再运行；不得事后把现有重复行重新命名为独立样本。

### P1-2：seed-level 不确定性远宽于 pooled Wilson

证据：

- D14_D16_RESULTS.md:175 说明 Wilson 将五 seed 对局池化；
- Topology-GNN vs Grid-GNN 的 seed-level t 区间分别为
  [.372,.928]、[.460,1]、[.322,.878]，全部包含 0.5；
- UCT-16 的 n=5 比较中，Grid、Padded、Topology 的探索性区间也都包含 0.5。

影响：当前五 seed 结果可以报告效应方向和异质性，但不能用 pooled Wilson
把 seed 间变异压缩成 game-level 精度。尤其不能把 D16 的 0.65/0.80/0.60
转化为稳定、跨 seed 的“Topology 优于 Grid”统计结论。

给 AI-2 的处理要求：提交 seed-level score 表；将 seed 视为推断单位；若只保留
五 seed，明确 small-n 和 interval 的探索性，不接受 pooled-game Wilson 替代。

### P1-3：Grid-GNN 与 Topology-GNN 比较混入架构变化

证据：

- d14_d16_formal_manifest.json:20--37：Grid-GNN 宽度 82、Topology-GNN
  宽度 64；二者只匹配总参数量；
- lifeline_rl/alphazero/network.py:125--172：每个 relation 有独立 projection；
- lifeline_rl/alphazero/network.py:224--231：Grid-GNN 只选择 relation 0；
- Topology-GNN 使用 physical、own、opponent 三类 relation。

因此两者同时改变了：

- 输入关系数量（1 vs 3）；
- relation projection 数量；
- hidden width（82 vs 64）；
- 每层消息混合方式。

影响：D16 是“两个参数量近似模型的系统级比较”，不是纯 logical-edge
处理效应。它不能单独证明提升来自逻辑边，而非 relation-specific capacity、
宽度或优化差异。

给 AI-2 的精确复现实验设计要求：使用同一三 relation 架构、相同 hidden width
和训练协议，仅 mask own/opponent logical relation；至少包含 remove-own、
remove-opponent、remove-both。该实验须作为新的冻结 ablation，不能回写或
解释为 D14--D16 已完成的内容。

### P1-4：关键零样本、消融与完整 baseline 证据在本轮 evidence package 中缺失

证据：

- task bundle 的 315 个 evaluation tasks 仅含 eval_size 5/7/9，各 105 个；
  eval_size 10/12 为 0；
- experiment_matrix.csv:10 的 GEN-SIZE（n=10/12）状态为 planned；
- experiment_matrix.csv:11 的 ABL-EDGE 状态为 planned；
- experiment_matrix.csv:12 的 ABL-SUPERKO/TopologyHistory 仍 gated；
- experiment_matrix.csv:13 的 ABL-CASCADE 状态为 planned；
- experiment_matrix.csv:7 的完整五类 BASE-SEARCH 正式 200-game runs 仍 pending；
- experiment_matrix.csv:14 也明确 n10/12 pending。

影响：D14--D16 只覆盖 seen sizes 5/7/9，不能称为 n=10/12 zero-shot
generalization；也不能用它支撑 logical edge、history、cascade 的机制性主张，
或完整搜索基线/Elo 主张。

给 AI-2 的处理要求：不得擅自补跑；先提交单独、冻结、可审计的新协议。任何
后续 D17--D19 evidence package 必须独立通过任务完整性、轨迹多样性和
seed-level 审计后，才能关闭本项。

### P1-5：“compute-matched UCT”只匹配 simulation count，不匹配实际计算

证据：

- manifest:53 和 :121--126 都使用 16 simulations；
- manifest:148 明确 wall-clock reported_not_matched；
- final-vs-UCT 的 45 个 task 中，神经 agent mean decision seconds /
  UCT mean decision seconds 的范围为 0.119--5.724：
  - 最低：eval.final_vs_search.n9.grid_gnn.seed20260827.gs200.vs.uct_mcts_16，
    0.1973 / 1.6573 = 0.119；
  - 最高：eval.final_vs_search.n7.topology_gnn.seed20260825.gs200.vs.uct_mcts_16，
    3.2560 / 0.5689 = 5.724。

影响：相同 simulations 不是相同 wall-clock、节点扩展、FLOPs 或硬件成本。
“compute-matched”会使读者误以为完成了实际计算预算控制。

给 AI-2 的处理要求：当前结果改称 simulation-count-matched UCT-16，并同时
报告 timing 分布；若要声称 compute matched，必须预先选择并冻结实际计算
匹配指标，不能事后挑选。

### P2-1：“30,600 unique games”混淆记录唯一性与轨迹唯一性

证据：

- D14_D16_RESULTS.md:24 使用“唯一正式评估局数 30,600”；
- 同文件 :78 又说明不能把双用途行重复计为独立对局；
- 原始主键 (task_id, game_index) 的确有 30,600 个，但 D16 的 9,000 行仅有
  89 条全局 size/color-conditioned 动作轨迹。

影响：数字总数没有算错，但“unique”会被自然理解为轨迹唯一或独立样本。

建议固定写法：

“30,600 task-indexed replay-verified game records”

在科学审计中列为 P2 文字/粒度问题；若投稿 PDF 仍用 unique games 支撑样本量
或置信区间，则升级为投稿 P1。

### P2-2：中断尝试的 canonical per-attempt lineage 不完整

证据：

- runner_control_v1/RECOVERY_INCIDENT.md:17--33 记录 attempt 1/2 在写出 arena
  或 receipt 前中断；
- 同文件 :48--54 说明中断 evaluation 在最终 receipt 前没有
  attempt_XXXX.json，state.json 只保留最近一次中断信息；
- 最终 task attempts=3 且正式 receipt 完成，早期精确时间由外部 incident
  record 保存，而非 canonical task attempt 文件。

影响：最终结果完整性未受损，但每次中断的规范化 provenance 不能完全从
canonical run_v1 task 状态重建。

给 AI-2 的处理要求：保留 RECOVERY_INCIDENT.md，并在复现说明中将其标为外部
operations record；未来 runner 在尝试开始和中断时即原子写入 append-only
attempt record。不得把没有 receipt 的中断尝试写成完成任务。

## 7. 特别检查结论

| 特别检查项 | 结论 |
|---|---|
| Topology-GNN 是否与 Grid-GNN 架构混淆 | **是，P1**；参数量匹配不足以隔离 logical-edge 效应 |
| D16 重复轨迹是否是独立样本 | **否，P1**；每 task 仅 2 条轨迹 |
| n=10/12 是否真正 zero-shot | **否，P1**；本轮 task 数为 0 |
| logical edge / history / cascade 消融是否完成 | **否，P1**；planned 或 gated |
| formal_ready=true 是否等于模型优越 | **否**；它只证明完整性 |
| 缺失/失败任务是否静默排除 | **未发现**；0 missing、0 failed、0 truncated |
| smoke 是否混入正式证据 | **未发现**；本轮只审计 formal evidence tier |
| 聚合 W/D/L/score 是否正确 | **是**；72 行 mismatch = 0 |

D14_D16_RESULTS.md:180--185 已正确写明 formal_ready 不代表模型优越，
并列出 n=10/12 和消融未完成。这一边界必须原样保留到论文和投稿版本。

## 8. 给 AI-2 的只读复现命令

以下命令均在 Windows PowerShell、仓库根目录 C:\coding\py\line game 运行。
它们不训练模型。

### 8.1 Manifest 校验

    & 'C:\Users\zcz\anaconda3\envs\rl310\python.exe' -B .\research\iclr2027\scripts\d14_d16_experiments.py validate --manifest .\research\iclr2027\configs\d14_d16_formal_manifest.json

### 8.2 参数量审计

    & 'C:\Users\zcz\anaconda3\envs\rl310\python.exe' -B .\research\iclr2027\scripts\d14_d16_experiments.py audit-parameters --manifest .\research\iclr2027\configs\d14_d16_formal_manifest.json --counts .\research\iclr2027\configs\d14_d16_parameter_counts.json

### 8.3 全量只读 status / deep validation

    & 'C:\Users\zcz\anaconda3\envs\rl310\python.exe' -B .\research\iclr2027\scripts\run_d14_d16_task_bundle.py status --manifest .\research\iclr2027\configs\d14_d16_formal_manifest.json --bundle-dir .\research\iclr2027\results\formal\d14_d16\task_bundle_v1 --run-root .\research\iclr2027\results\formal\d14_d16\run_v1

### 8.4 D16 轨迹唯一性复算

    $bundle = '.\research\iclr2027\results\formal\d14_d16\task_bundle_v1\evaluation_tasks.jsonl'
    $ledger = '.\research\iclr2027\results\formal\d14_d16\run_v1\result_receipts.jsonl'
    $taskById = @{}
    foreach ($line in (Get-Content -LiteralPath $bundle)) {
      $task = $line | ConvertFrom-Json
      $taskById[[string]$task.task_id] = $task
    }
    $global = [System.Collections.Generic.HashSet[string]]::new()
    $profiles = @()
    $rowCount = 0
    foreach ($line in (Get-Content -LiteralPath $ledger)) {
      $receipt = $line | ConvertFrom-Json
      if (-not $taskById.ContainsKey([string]$receipt.task_id)) { continue }
      $task = $taskById[[string]$receipt.task_id]
      if ($task.evaluation_kind -ne 'representation_round_robin') { continue }
      $withinTask = [System.Collections.Generic.HashSet[string]]::new()
      foreach ($gameLine in (Get-Content -LiteralPath $receipt.arena_games_path)) {
        $game = $gameLine | ConvertFrom-Json
        $color = "$($game.black_slot)-$($game.white_slot)"
        $actions = [string]::Join(',', @(
          $game.actions | ForEach-Object { [string]$_.action }
        ))
        $key = "$color|$actions"
        [void]$withinTask.Add($key)
        [void]$global.Add("$($game.grid_size)|$key")
        $rowCount++
      }
      $profiles += [pscustomobject]@{
        task_id = $task.task_id
        trajectories = $withinTask.Count
      }
    }
    [pscustomobject]@{
      tasks = $profiles.Count
      rows = $rowCount
      per_task_min = ($profiles.trajectories | Measure-Object -Minimum).Minimum
      per_task_max = ($profiles.trajectories | Measure-Object -Maximum).Maximum
      task_conditioned_trajectories = ($profiles.trajectories | Measure-Object -Sum).Sum
      global_size_color_trajectories = $global.Count
    } | Format-List

预期输出：

    tasks                          : 45
    rows                           : 9000
    per_task_min                   : 2
    per_task_max                   : 2
    task_conditioned_trajectories  : 90
    global_size_color_trajectories : 89

### 8.5 独立收据审计与 72 行事后比较

可重复审计脚本：
`research/iclr2027/reviews/independent_receipt_audit.py`，SHA-256
`6A7EE4D84CA037E18F71C4D1E1103C7994A95946DC33B80772FAEBD0BA257D89`。

默认模式不读取 aggregate 或结果结论；`--compare-canonical` 仍先完成相同的独立
重建和 630 局重放，之后才打开 canonical aggregate 比较 72 行：

    & 'C:\Users\zcz\anaconda3\envs\rl310\python.exe' -B .\research\iclr2027\reviews\independent_receipt_audit.py --compare-canonical

本轮实跑 exit 0、`ok=true`：315 个 evaluation task、630/630 直接重放；五个
training seed 各 126 局；独立/canonical/compared rows 均为 72；missing/extra key、
W/D/L、score、Wilson mismatch 均为 0；最大绝对误差为 0。脚本按 task 的
`purposes` 将 final UCT 行复用为 200-step learning-curve 点，避免漏掉 canonical
curve 中的 9 行。

## 9. D17--D19 Day-2 增量只读状态

快照时间：2026-08-29 14:19:34（Asia/Shanghai）。本节只审计 AI-2 的协议、
manifest、物化任务、readiness 和 dry-run；未运行正式任务，也没有读取不存在的
聚合结论。

### 9.1 当前冻结身份与预检

- manifest 仍为 `status=frozen_not_run`；文件 SHA-256 为
  `2349C2B47AC06CD0632F6B06AEA8950A21846F9FFA88320DE4BCC7A49639FFB9`，
  canonical JSON SHA-256 为
  `9d0d69a0d41a18837188e78f42a0c14a704c8df265a8a1a2fd251a13f6b36580`；
- 当前 runner SHA-256 为
  `B8083A9B1028DBF77F8EE0840CE6C92BB81F59E9835E17B08915DDA69465403C`，
  experiments materializer SHA-256 为
  `FA9F8DB2A657CEEB62D1F69E672E323B4177E2A0B361BDD5363A17794FACCE92`；
- v3 readiness 为 PASS（1.625 s、3/3 model forward、0 formal task），且记录的
  manifest、runner、experiments、protocol 哈希与当前文件一致；
- v3 bundle 为 `materialized_not_run`：85 tasks / 8,320 planned games，其中
  GEN-SIZE 40 / 2,560，D16-v2 45 / 5,760；
- 当前有效 exact dry-run：
  `results/formal/d17_d19/run_20260829_p0_v3/preflight/dry_run.json`，文件
  SHA-256
  `99330DBB5AACC4166789CC8F9F21C7870CF71A3ADBF59DD4915195B267F89870`；
  status PASS，15/15 checkpoints、65 checkpoint×size cells、195/195 fixture
  forward/PUCT checks（GEN-SIZE 60，D16-v2 135）、96/96 explicit legal
  nonterminal openings，耗时 49.895 s，`formal_tasks_executed=0`。

旧全局 dry-run 只绑定旧 manifest `8092...` 且只有 65 cases；它已失效，不计入当前
gate。v3 dry-run 同时绑定当前 canonical manifest `9d0d...`、runner `b808...` 和
materialized manifest `e613...`，因此当前 preflight 本身有效。

### 9.2 正式证据状态

- 正式进度：0/85 tasks、0/8,320 games；
- D17--D19 receipt、result ledger、canonical/independent aggregate 均不存在；
- `research/iclr2027/D17_D19_RESULTS.md` 不存在；
- AutoDL 仅为 `prepared_not_run`，`formal_tasks_executed=0`，
  `paid_action_performed=false`；AI-3 未调用 AutoDL。

因此尚无 W/D/L、score、seed/opening-cluster 正式统计可复算；这不是静默排除缺失
任务，而是正式运行尚未开始。当前 preflight 不能支持 n=10/12 zero-shot、D16-v2
多样性或 D19 架构匹配逻辑边结论，也不改变本文件 D14--D16 的 P0/P1/P2 计数。

## 10. 审计结论

### 独立复算是否一致

**一致。** 任务集合、W/D/L、score、Wilson 算术、失败/截断、checkpoint、
配置与源码身份均未发现 mismatch。630 局跨全部评估 task 的独立直接重放通过。

### 科学解释是否可直接通过

**不能。** 当前 evidence package 足以支持：

- 冻结调度已完整执行；
- 三个具体系统在 seen sizes 5/7/9、固定五 seed 和固定评估协议下的描述性
  W/D/L/score；
- 结果的文件、checkpoint、配置和执行身份可追踪。

当前 evidence package 不足以支持：

- D16 pooled-game 独立样本推断；
- 稳健的跨 seed Topology-GNN 优越性；
- logical edge 的纯因果归因；
- n=10/12 zero-shot generalization；
- history、cascade 或完整 edge ablation；
- 实际计算预算匹配的 UCT 公平比较。

Round 1 实验审计结论为：**数字链 PASS，主张与统计解释 NEEDS REVISION**。
在不关闭五个 P1 前，不应把 D14--D16 作为“Topology-GNN 已被统计证明优越”
或“已证明零样本/机制性贡献”的依据。
