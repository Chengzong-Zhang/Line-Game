# D14--D16 三表示正式实验结果

日期：2026-08-28

状态：**正式任务、全量深验与聚合全部完成；`formal_ready=true`**

## 1. 结论先行

D9--D12 的 AlphaZero/PUCT、经验池、策略价值训练、严格 checkpoint/resume
和三种表示已经进入同一冻结流水线。D13 的首个正式门此前已通过：单个
Topology-GNN checkpoint 在 n=5 对 Random 的 200 局中取得 166 胜、26 和、
8 负，得分率 0.895，pooled Wilson 95% 区间为 [0.8448, 0.9303]，且 retained-
replay learning-health gate 同时通过。D13 的窄边界见
[`D11_D13_DELIVERY.md`](D11_D13_DELIVERY.md)。

D14--D16 本轮完成了 15 个训练任务和 315 个评估任务：

| 验收项 | 结果 |
| --- | ---: |
| training receipts | 15 / 15 |
| evaluation receipts | 315 / 315 |
| failed / missing receipts | 0 / 0 |
| self-play games / gradient steps | 1,500 / 3,000 |
| 唯一正式评估局数 | 30,600 |
| replay verified / truncated | 30,600 / 0 |
| 换色对 | 15,300 |
| deep-validated artifacts | 330 / 330 |
| result ledger | valid |
| aggregate status | complete |
| formal gate | `formal_ready=true` |

最终 checkpoint 的三个表示在 n=5/7/9 全部明显超过 Random。面对冻结的
UCT-MCTS-16，Grid-GNN 的 n=5 区间跨过 0.5，Padded-CNN 的 n=5 仅为边界性
优势，其余七个模型×尺寸格子的名义 pooled-game Wilson 下界均高于 0.5。

D16 不支持一个稳定的全局排名。Topology-GNN 在三个尺寸的直接配对中都高于
Grid-GNN；但 Padded-CNN 相对另外两种表示的方向会随尺寸反转。更重要的是，
D16 的确定性竞技场在每个 200 局 task 中只有两条唯一动作轨迹，因此 1,000 局
汇总的 Wilson 区间只是名义逐局描述，不能当作 1,000 个独立样本的不确定性。

## 2. 冻结身份与运行环境

| 项目 | 值 |
| --- | --- |
| experiment id | `d14_d16_three_representation_formal_v1` |
| evidence tier | `formal` |
| canonical manifest SHA-256 | `1bbf2c9a9ecc9174cd2d4b4299e22289dea58b7a53885e1be923374add2841cb` |
| trainer source SHA-256 | `21a46dbd787090fc18c24cb4e29ebe1dd743203d31abeda43b3ce421833b596c` |
| runner SHA-256 | `55c077c3fe08f7d3527be3950fb4e70b54a743130acaa911da8949f37ec59937` |
| protocol/aggregator SHA-256 | `1b4ca0a7f9115df4b4ecf95fa326425ce77caf6cf57e6a12c26625e279d2145d` |
| Python / PyTorch | 3.10.20 / 2.7.1+cu118 |
| CUDA runtime / cuDNN | 11.8 / 90100 |
| device | NVIDIA GeForce RTX 4060 Laptop GPU |
| determinism | deterministic algorithms; cuDNN deterministic; benchmark off |

330 条 receipt 只有一套 execution identity。独立复算确认 task id 与冻结 bundle
全集完全相等，没有 missing、extra 或 duplicate task。

## 3. 预算与参数公平性

每个表示使用五个相同 seed、mixed-size `[5,7,9]`、100 局 self-play、200 次
梯度更新、PUCT-16、相同 checkpoint steps `{40,80,120,160,200}`。每个参数组
都通过 1% 门：

| 表示 | 可训练参数 | step 200 平均环境步 | step 200 平均墙钟秒 |
| --- | ---: | ---: | ---: |
| Padded-CNN | 62,868 | 1,710.4 | 489.8 |
| Grid-GNN | 62,733 | 1,576.8 | 399.2 |
| Topology-GNN | 63,171 | 1,574.8 | 440.0 |

参数最小值为 62,733，最大值为 63,171，相对跨度为 0.698197%，低于 1%。
这证明参数、自博弈局数、梯度步、搜索模拟数和评估调度匹配；它不证明架构逐层
同构，也不表示 FLOPs、显存、环境步或墙钟完全相等。CNN 与 GNN 的比较仍同时
混合了表示与架构差异。

四张 CSV 可见局数相加为 39,600，是因为 step 200 对 UCT-16 的 9,000 局同时
服务 `arena_learning_curve.csv` 和 `final_vs_search.csv`。唯一 receipt 对应的
正式评估总数仍是 30,600，不能把双用途行重复计为独立对局。

## 4. D14：同尺寸五点学习曲线

下表每格为得分率和 pooled-game Wilson 95% 区间。steps 40/80/120/160 每格
100 局，step 200 每格 1,000 局，所以最后一点精度更高；原始 W/D/L 保存在
[`arena_learning_curve.csv`](results/formal/d14_d16/aggregate_v1/arena_learning_curve.csv)。

| 表示 | 尺寸 | step 40 | step 80 | step 120 | step 160 | step 200 | 40→200 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Grid-GNN | 5 | 49.00% [39.42, 58.65] | 57.50% [47.71, 66.73] | 49.00% [39.42, 58.65] | 66.00% [56.28, 74.54] | 52.25% [49.15, 55.33] | +3.25 pp |
| Grid-GNN | 7 | 70.50% [60.94, 78.55] | 61.50% [51.71, 70.44] | 70.50% [60.94, 78.55] | 65.50% [55.77, 74.09] | 64.55% [61.53, 67.45] | -5.95 pp |
| Grid-GNN | 9 | 83.50% [75.01, 89.51] | 83.50% [75.01, 89.51] | 83.00% [74.45, 89.11] | 85.50% [77.29, 91.09] | 84.80% [82.44, 86.89] | +1.30 pp |
| Padded-CNN | 5 | 40.00% [30.94, 49.80] | 54.00% [44.26, 63.44] | 56.00% [46.23, 65.33] | 56.00% [46.23, 65.33] | 53.15% [50.05, 56.22] | +13.15 pp |
| Padded-CNN | 7 | 57.50% [47.71, 66.73] | 62.00% [52.21, 70.90] | 65.50% [55.77, 74.09] | 71.00% [61.46, 78.99] | 71.05% [68.16, 73.78] | +13.55 pp |
| Padded-CNN | 9 | 77.00% [67.85, 84.16] | 89.00% [81.37, 93.75] | 80.50% [71.67, 87.08] | 85.50% [77.29, 91.09] | 91.35% [89.45, 92.94] | +14.35 pp |
| Topology-GNN | 5 | 51.00% [41.35, 60.58] | 60.50% [50.70, 69.52] | 60.00% [50.20, 69.06] | 62.00% [52.21, 70.90] | 64.25% [61.23, 67.16] | +13.25 pp |
| Topology-GNN | 7 | 63.50% [53.73, 72.27] | 67.50% [57.82, 75.88] | 73.00% [63.57, 80.73] | 65.00% [55.25, 73.64] | 71.50% [68.62, 74.21] | +8.00 pp |
| Topology-GNN | 9 | 89.00% [81.37, 93.75] | 88.00% [80.19, 93.00] | 91.50% [84.39, 95.54] | 89.50% [81.96, 94.11] | 87.55% [85.36, 89.45] | -1.45 pp |

Padded-CNN 的 40→200 点估计在三个尺寸都上升约 13--14 pp；Topology-GNN
在 n=5 总体上升；Grid-GNN 多处平台或波动。n=9 的三个模型很早就达到较高
得分。由于没有预注册 AUC、steps-to-fixed-strength 阈值或 seed-level paired
分析，不能把这些描述性曲线改写成“某表示显著更样本高效”或“更快收敛”。

训练 loss 是 mixed-size optimizer diagnostic，不是逐尺寸强度：

| 表示 | mean total loss：40 / 80 / 120 / 160 / 200 |
| --- | --- |
| Grid-GNN | 2.9147 / 2.9329 / 2.9569 / 2.8830 / 2.8041 |
| Padded-CNN | 3.0709 / 3.0480 / 3.0256 / 2.9925 / 2.9305 |
| Topology-GNN | 2.8880 / 2.9027 / 2.8292 / 2.8187 / 2.8185 |

三者从 step 40 到 step 200 的均值都下降，但 Grid-GNN 和 Topology-GNN 并非
单调；loss 不能单独证明策略增强、收敛或跨架构优劣。

## 5. D15：最终 checkpoint 对 Random 与 UCT-MCTS-16

每格 1,000 局、五个训练 seed。W/D/L 为模型的胜/和/负；得分率为
`(W + 0.5D) / N`。

| 表示 | 尺寸 | 对 Random：W/D/L；得分率 [CI] | 对 UCT-16：W/D/L；得分率 [CI] |
| --- | ---: | --- | --- |
| Grid-GNN | 5 | 760/181/59；85.05% [82.71, 87.13] | 484/77/439；52.25% [49.15, 55.33] |
| Grid-GNN | 7 | 842/99/59；89.15% [87.07, 90.93] | 625/41/334；64.55% [61.53, 67.45] |
| Grid-GNN | 9 | 926/50/24；95.10% [93.58, 96.27] | 831/34/135；84.80% [82.44, 86.89] |
| Padded-CNN | 5 | 810/126/64；87.30% [85.09, 89.22] | 487/89/424；53.15% [50.05, 56.22] |
| Padded-CNN | 7 | 907/63/30；93.85% [92.19, 95.18] | 695/31/274；71.05% [68.16, 73.78] |
| Padded-CNN | 9 | 967/22/11；97.80% [96.69, 98.54] | 907/13/80；91.35% [89.45, 92.94] |
| Topology-GNN | 5 | 781/163/56；86.25% [83.98, 88.25] | 602/81/317；64.25% [61.23, 67.16] |
| Topology-GNN | 7 | 847/125/28；90.95% [89.01, 92.57] | 691/48/261；71.50% [68.62, 74.21] |
| Topology-GNN | 9 | 913/71/16；94.85% [93.30, 96.06] | 848/55/97；87.55% [85.36, 89.45] |

三个表示在三个尺寸都明显超过 Random。对 UCT-16，Grid-GNN n=5 的区间跨
0.5，不能称为明确击败；Padded-CNN n=5 的下界仅 50.05%，应称为边界证据；
其余七格给出清楚的名义 pooled-game 优势。尺寸 5/7/9 都出现在 mixed-size
训练中，因此随尺寸变化的结果不是 unseen-size 泛化证据。

D15 只覆盖 Random 与 compute-matched UCT-MCTS-16，不能替代 Random、Greedy、
Minimax-2、Minimax-3、UCT 五类独立 `BASE-SEARCH` 矩阵，也不能外推到更大的
搜索预算或转换成未计算的 Elo。

## 6. D16：三表示逐尺寸配对

下表严格按 A 视角报告 W/L/D 和 A score；每行名义 1,000 局、五个训练 seed。

| 尺寸 | A vs B | A W/L/D | A score [名义 Wilson 95%] |
| ---: | --- | ---: | ---: |
| 5 | Grid-GNN vs Topology-GNN | 300/600/100 | 0.350 [0.321, 0.380] |
| 5 | Padded-CNN vs Grid-GNN | 400/400/200 | 0.500 [0.469, 0.531] |
| 5 | Padded-CNN vs Topology-GNN | 600/400/0 | 0.600 [0.569, 0.630] |
| 7 | Grid-GNN vs Topology-GNN | 200/800/0 | 0.200 [0.176, 0.226] |
| 7 | Padded-CNN vs Grid-GNN | 500/400/100 | 0.550 [0.519, 0.581] |
| 7 | Padded-CNN vs Topology-GNN | 300/700/0 | 0.300 [0.272, 0.329] |
| 9 | Grid-GNN vs Topology-GNN | 400/600/0 | 0.400 [0.370, 0.431] |
| 9 | Padded-CNN vs Grid-GNN | 300/700/0 | 0.300 [0.272, 0.329] |
| 9 | Padded-CNN vs Topology-GNN | 500/500/0 | 0.500 [0.469, 0.531] |

在本次固定 checkpoint 和五个配对训练 seed 下，Topology-GNN 对 Grid-GNN 的
名义得分分别为 0.65、0.80、0.60；但 Padded-CNN 相对 Topology-GNN 是 n=5
领先、n=7 落后、n=9 持平，相对 Grid-GNN 是 n=5 持平、n=7 领先、n=9 落后。
这说明 size×representation 交互明显，不支持一个跨尺寸全局排序。

### 6.1 确定性重复轨迹审计

独立扫描 45 个 round-robin `games.jsonl`、共 9,000 局：每个 200 局 task
恰好只有两条唯一动作序列，A 执黑和 B 执黑各一条；100 个换色 pair 完全重复
这两条轨迹。因此每个 1,000 局汇总行实际只有五个训练 seed 和十条唯一动作
轨迹。点估计仍是五个配对 seed 的等权均值，但 1,000 局 Wilson 区间不能解释
为 1,000 个独立样本的不确定性，也不是 seed-cluster 或层级置信区间。

若要支持更强的表示排名，需要建立新的 v2 协议，引入多样化开局或评估随机性，
以训练 seed 为主要统计单位，并预注册层级/cluster-aware 推断。不能覆盖或重跑
本次 v1 来掩盖这一限制。

## 7. 统计解释边界

- 所有 Wilson 区间使用 z=1.96、将和棋计为半个成功，并把五个 seed 的对局池化；
  它们是描述区间，不是跨 seed 显著性检验。
- 同一换色 pair、同一训练 seed 的对局相关；D16 还有完全重复轨迹问题。
- 72 个 arena aggregate rows 没有预注册多重比较校正，不能挑选少数格子宣布全局
  显著性。
- `formal_ready=true` 只表示任务、身份、预算、重放与工件完整，不自动表示某模型
  击败对手或某表示全局更优。
- 没有预注册的 AUC、fixed-strength threshold、Elo、Bradley--Terry 或跨尺寸
  scalar ranking。
- 本轮只覆盖 seen sizes 5/7/9；n=10/12、逻辑边消融、Superko/TopologyHistory、
  cascade 消融、candidate/champion、opponent pool 和完整五类搜索基线仍未完成。

## 8. 恢复事件与 lineage 限制

正式 runner 的两个 Codex unified exec 承载进程曾以 `exit_code=-1` 无 traceback
终止；每次恢复前都先深验已有 receipts。最终使用隐藏后台进程完成剩余 64 项，
本次 invocation 记录 251 项跳过、64 项完成、0 项失败。

中断任务最终以 `attempts=3` 和 `attempt_0003.json` 完成，但执行器只在产生最终
receipt 后写 attempt 文件，`state.json` 也只保留最近一次 interruption；因此
attempt 1/2 没有各自的 canonical attempt 文件。两次中断的 PID、时间、status
复核和这一限制保存在
[`runner_control_v1/RECOVERY_INCIDENT.md`](results/formal/d14_d16/runner_control_v1/RECOVERY_INCIDENT.md)，
不能声称 per-attempt canonical lineage 完整。

## 9. 工件与 SHA-256

| 工件 | SHA-256 |
| --- | --- |
| [`result_receipts.jsonl`](results/formal/d14_d16/run_v1/result_receipts.jsonl) | `ff3ef8bfd9b7a443bc42ba16ab9d4daa9f855a5d0432d58a62322686247b8114` |
| [`aggregate.json`](results/formal/d14_d16/aggregate_v1/aggregate.json) | `59c264fc65d7b11357b0d718d38371df1ba44be4b92e7ef41ff995bf088f501c` |
| [`training_curve.csv`](results/formal/d14_d16/aggregate_v1/training_curve.csv) | `af96f5a9cfb5fc1f343953d1ad2b1bbabff96f078f002e4ee2e57dc048b4fae0` |
| [`arena_learning_curve.csv`](results/formal/d14_d16/aggregate_v1/arena_learning_curve.csv) | `40f531f0f974f75cf8921499d209eb529bc2f99308390f8ce753f63047f5b616` |
| [`final_vs_search.csv`](results/formal/d14_d16/aggregate_v1/final_vs_search.csv) | `8fdcba541d8c62b9697be5bd17f512c76976e0acb4d1a6a3f8c785d3959b0fa8` |
| [`representation_round_robin.csv`](results/formal/d14_d16/aggregate_v1/representation_round_robin.csv) | `b06659670c5bd199fcbefaa808398859ff220a4ce60cae9ddd47d04fa4f25fff` |

独立验证逐项对账 aggregate JSON 与四张 CSV，复算全部 72 个评测汇总行：
`W+D+L=N`、score 和 Wilson 上下界的最大绝对误差都为 0。

## 10. 协议快照说明

[`D14_D16_EXPERIMENT_PROTOCOL.md`](D14_D16_EXPERIMENT_PROTOCOL.md) 保持
2026-08-26 冻结快照，不事后回写。其聚合示例中的 ledger 正确路径应为
`results/formal/d14_d16/run_v1/result_receipts.jsonl`；末尾“formal 尚未启动”是
当时的历史状态。当前结果与命令以本文件和冻结 result ledger 为准。
