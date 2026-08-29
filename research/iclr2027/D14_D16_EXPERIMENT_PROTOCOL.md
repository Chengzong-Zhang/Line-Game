# D14--D16 三表示公平实验协议

冻结日期：2026-08-26

机器清单：`configs/d14_d16_formal_manifest.json`

校验/生成/聚合器：`scripts/d14_d16_experiments.py`

## 1. 当前证据边界

本文件和 manifest 是预注册协议与运行基础设施，不是实验结果。创建任务、通过单元测试或生成空任务目录，都不能表述为 D14--D16 正式实验已完成。只有完整 result ledger 通过 `aggregate`，且输出中的 `formal_ready` 为 `true`，才可把聚合表用于正式结论。

`smoke`、`pilot`、`formal` 是互斥证据层。聚合器遇到层级混合、manifest hash 不同、缺失任务或重复任务会直接失败；它不会跳过失败种子来生成更好看的均值。

## 2. 冻结矩阵

三种表示按以下固定顺序比较：

1. `padded_cnn`：普通 Grid 表示的填充 CNN；
2. `grid_gnn`：只使用固定三角网格物理边；
3. `topology_gnn`：物理边加己方、敌方逻辑边关系。

`padded_cnn` 复用统一的 `grid_graph` 编码入口以获得同一 legal mask 和 padding 元数据，但网络不读取关系边；因此它仍是普通 Grid/CNN 表示，不会暗中获得 Grid-GNN 或 Topology-GNN 的消息传递信息。

每个训练任务按冻结调度混合采样尺寸 5、7、9，之后分别在 5、7、9 上做同尺寸评估。每个表示使用相同五个种子 `20260825` 至 `20260829`，因此共有 `3 representations x 5 seeds = 15` 个训练任务；不能拆成 45 个独立单尺寸训练后再混为同一个主比较。

每个训练任务使用相同预算：

- PUCT 每步 16 次模拟；
- 每个种子/模型共 100 局 mixed-size 完整自博弈；
- 200 次梯度更新；
- replay capacity 10,000，batch size 16；
- 固定 10 iterations，每 iteration 10 局自博弈和 20 次梯度更新，每 2 iterations 保存 checkpoint；
- 最多 256 plies，Superko 强制执行；
- 只使用终局胜/和/负目标，无 shaped reward。

固定梯度步 checkpoint 为 40、80、120、160、200。前四个 checkpoint 分尺寸对 `uct_mcts_16` 做 20 局学习曲线 probe；最终 checkpoint 对 Random 和 compute-matched UCT-MCTS-16 各做 200 局，并进行三表示两两 200 局对局。最终 UCT-MCTS 任务同时承担学习曲线的最后一个点，避免重复运行。

调度乘积由 manifest 校验器强制检查：`10 x 10 = 100` 局、`10 x 20 = 200` 梯度步，且每 2 iterations 正好映射到 40 步 checkpoint。batch size 16 也满足最坏的全 PASS 下首 iteration 至少产生 `10 x 2 = 20` 条经验，因此不会静默跳过第一批 20 次计划更新。

学习曲线 probe 是辅助测量，每个 task 20 局，由 10 个相同随机种子的换色对构成。最终搜索对手和表示两两比较是主证据，每个 task 恰好 200 局，由 100 个换色对构成。每个 task 的全部对局都必须完成并通过动作重放，截断局数必须为零。

Random、Greedy、Minimax-2、Minimax-3、UCT-MCTS 五类非学习基线仍由冻结的 `BASE-SEARCH` 矩阵覆盖。神经主实验只选择 Random 与相同 16 次模拟预算的 UCT-MCTS-16，避免把深度 Minimax 的成本乘到所有神经 checkpoint；这两个神经对手的 200 局结果不能替代独立五类搜索基线矩阵。

任务总数：

- 训练：15；
- 非最终学习曲线评估：180；
- 最终对搜索基线评估：90；
- 三表示两两比较：45；
- 合计：330 个任务，其中 315 个 arena matchup，共 30,600 局评估对局（3,600 局辅助 probe 加 27,000 局 200-game 主证据）。

这个规模是正式矩阵，不应与 GPU smoke 同时启动。当前单卡机器按单训练作业串行运行；先完成参数审计和 pilot 吞吐测量，再估算实际墙钟时间。

## 3. D14、D15、D16 对应产物

| 里程碑 | 冻结任务 | 聚合产物 |
| --- | --- | --- |
| D14 同尺寸学习效率 | 一个 mixed-size 训练轨迹的五个固定 checkpoint，分别在 5/7/9 对 `uct_mcts_16`；五种子完整保留 | `training_curve.csv`、`arena_learning_curve.csv` |
| D15 对搜索基线胜率 | 最终 checkpoint 对 Random 和 compute-matched UCT-MCTS-16；另引用五类 `BASE-SEARCH` 矩阵 | `final_vs_search.csv` |
| D16 三表示公平比较 | 同尺寸、同种子、同 checkpoint 的三表示两两换色对局；参数数目审计 | `representation_round_robin.csv`、`aggregate.json.parameter_audit` |

每个聚合胜率都同时保留 W/D/L、有效局数、种子 receipt 数和 Wilson 95% 区间。任何声明失败的训练或评估任务都保留在 `failed_runs`，并令 `formal_ready=false`。

## 4. 运行前校验和任务生成

在仓库根目录 `C:\coding\py\line game` 执行：

```powershell
& 'C:\Users\zcz\anaconda3\envs\rl310\python.exe' -B .\research\iclr2027\scripts\d14_d16_experiments.py validate --manifest .\research\iclr2027\configs\d14_d16_formal_manifest.json
```

预期只读校验结果必须显示 `training_tasks: 15`、`evaluation_tasks: 315`。

生成不可覆盖的正式任务 bundle：

```powershell
& 'C:\Users\zcz\anaconda3\envs\rl310\python.exe' -B .\research\iclr2027\scripts\d14_d16_experiments.py generate --manifest .\research\iclr2027\configs\d14_d16_formal_manifest.json --output-dir .\research\iclr2027\results\formal\d14_d16\task_bundle_v1
```

该命令写出 `manifest_snapshot.json`、`training_tasks.jsonl`、`evaluation_tasks.jsonl` 和 `bundle_summary.json`。目标目录非空时命令拒绝运行，防止覆盖已有任务或结果。

## 5. 参数量预检

正式训练开始前，对三个 size-agnostic 模型分别运行 model dry-run，并把 trainable parameter count 写成三项 JSON。冻结实测值如下：

| 表示 | 宽度 | trainable parameters | 相对 63,171 |
| --- | ---: | ---: | ---: |
| `padded_cnn` | 33 | 62,868 | -0.48% |
| `grid_gnn` | 82 | 62,733 | -0.69% |
| `topology_gnn` | 64 | 63,171 | reference |

```json
{
  "counts": [
    {
      "representation": "padded_cnn",
      "parameter_count": 62868
    }
  ]
}
```

上例只展示单项结构，不能通过正式审计；正式文件必须含三个表示的三项且不得重复。实测值必须与 manifest 的冻结值逐项相等。运行：

```powershell
& 'C:\Users\zcz\anaconda3\envs\rl310\python.exe' -B .\research\iclr2027\scripts\d14_d16_experiments.py audit-parameters --manifest .\research\iclr2027\configs\d14_d16_formal_manifest.json --counts .\research\iclr2027\configs\d14_d16_parameter_counts.json
```

三模型最大参数量与最小参数量的相对差 `max/min - 1` 为约 0.70%，不得超过 1%。参数数目与冻结 dry-run 不同或相对差超限都会直接失败，不能用训练时长或搜索次数补偿。

## 6. Result ledger 合同

runner 每完成一个任务，就向独立 JSONL ledger 写一个 schema v1 receipt。所有 receipt 都必须包含：

- `schema_name: "lifeline-d14-d16-result"`；
- `schema_version: 1`；
- task 中原样复制的 `experiment_id`、`manifest_sha256`、`evidence_tier`、`task_id`；
- `status: "complete"`，或 `status: "failed"` 加非空 `failure_reason`。

完整训练 receipt 还必须包含 task 的 `representation`、`board_sizes=[5,7,9]`、`seed`、完整 `training_budget`、`parameter_count`、实际 PUCT 模拟数/自博弈局数/梯度步数、全部固定 checkpoint，以及每个 checkpoint 的 curve snapshot。snapshot 至少包含：

- `gradient_steps`；
- `self_play_games`；
- `environment_steps`；
- 有限的 `loss`、`policy_loss`、`value_loss`、`wall_clock_seconds`；正式调度不得用 null 掩盖被跳过的更新。

每个 receipt 还冻结同一份 execution identity：训练器源码 hash、runner/protocol SHA-256、PyTorch/CUDA/cuDNN 版本、设备与 CUBLAS workspace 配置。正式聚合时，这组 identity 不仅必须在全部 330 个 receipt 中完全一致，还必须与当前冻结源码和当前 PyTorch 版本一致；因此旧源码生成的孤立 receipt 不能混入新 ledger。

完整 arena receipt 还必须包含：

- task 对应的尺寸、种子和 checkpoint 梯度步；
- learning-curve task 为 `games_requested=games_completed=20`，最终 task 为 200，且 `truncated_games=0`；
- A 执黑/执白局数各占一半；
- `color_pairs_verified` 等于局数一半，且 `color_balance="paired_swap_same_seed"`；
- `replay_verified_games` 等于全部请求局数；
- task 对应的 `max_plies`、`superko_mode`；
- `a_wins`、`a_losses`、`draws`，三者之和为 200。
- `summary.json`、`games.jsonl`、`games.csv` 三份工件的路径和 SHA-256；CSV 每一行必须与可重放 JSONL 的关键字段一致。

失败 receipt 仍必须保留 task 身份。训练失败 receipt 还需记录可由 model dry-run 得到的 `parameter_count`，使公平性审计不因失败种子消失。

## 7. 聚合

只有收集完全部 330 个 task receipt 后才运行：

```powershell
& 'C:\Users\zcz\anaconda3\envs\rl310\python.exe' -B .\research\iclr2027\scripts\d14_d16_experiments.py aggregate --manifest .\research\iclr2027\configs\d14_d16_formal_manifest.json --results .\research\iclr2027\results\formal\d14_d16\result_receipts.jsonl --output-dir .\research\iclr2027\results\formal\d14_d16\aggregate_v1
```

聚合器会拒绝：

- 任意缺失或重复 task/seed receipt；
- `smoke`、`pilot`、`formal` 混合；
- receipt 绑定的 manifest hash 不一致；
- PUCT、自博弈、梯度步、评估局数或规则预算不一致；
- 参数量与冻结值不同或相对差超过 1%；
- arena 少于 task 规定的 20/200 局、存在截断、不是逐对同种子换色，或没有逐局重放证据；
- W/D/L 与完成局数不一致。

聚合输出目录同样不可覆盖。若所有 receipt 都存在，但其中显式记录失败任务，聚合会保留失败信息并输出 `formal_ready=false`，不会偷偷删除该种子。

## 8. 回归测试

```powershell
& 'C:\Users\zcz\anaconda3\envs\rl310\python.exe' -B -m unittest research.iclr2027.tests.test_d14_d16_experiment_protocol -v
& 'C:\Users\zcz\anaconda3\envs\rl310\python.exe' -B -m unittest research.iclr2027.tests.test_d14_d16_executor -v
```

两项 D14--D16 专项共 21 个测试，覆盖正式任务数、不可覆盖生成、重复种子、冻结参数值与 1% 参数差、完整五种子聚合、缺失/重复 receipt、证据层混合、非换色结果、未全部重放、预算不匹配、失败种子保留，以及伪造 Agent、错误 checkpoint step、checkpoint/self-play/CSV 篡改、source drift、orphan checkpoint 收养、旧 ledger 失效、training-only 重启仍深验已有 evaluation 等反例。仓库完整回归为 178 项通过。

## 9. 可断点执行器

`scripts/run_d14_d16_task_bundle.py` 消费已生成且不可修改的 task bundle。它再次把 `manifest_snapshot.json`、两份 task JSONL 与确定性展开逐字节语义比较；任务丢失、重排或被改写都会在运行前失败。

每个任务有独立目录和以下状态：

- 原子 `state.json`；
- 当前原子 `receipt.json`；
- 不覆盖的 `attempts/attempt_NNNN.json`；
- 训练任务的 `resolved_config.json`、metrics/self-play JSONL 和每个固定梯度步的独立 checkpoint manifest；
- 评估任务的 `summary.json`、`games.jsonl`、`games.csv` 及其 SHA-256 绑定。

训练每个 iteration 后检查实际游戏数、截断数和梯度更新数；任何一次更新因 replay warmup 被跳过都会立即失败，不能等最终聚合才发现预算变少。每 2 iterations 在单独目录保存 checkpoint，因而 40、80、120、160、200 步都可独立加载。重启只从最近一个完整 checkpoint 恢复；checkpoint 的模型、优化器、buffer、计数器和 RNG 由 D9--D10 loader 实际恢复校验，outer counters 还必须与 trainer state、replay total 和 metrics 完全一致。若进程在 checkpoint 已原子落盘、`latest.json` 尚未落盘的间隙中断，执行器会从 payload 重建 manifest 后再做同样的严格验证；state 尚未登记的合法 snapshot 会自动收养。

完整训练 receipt 不能只靠自报计数通过：执行器逐局重放确定性的 mixed-size self-play 调度，核对每一步 PUCT visits/policy/prior、终局 fingerprint 和 reward；逐 iteration 核对 metrics/counters/replay size，并把 curve snapshot 的 loss、environment steps 和 wall clock 精确绑定到对应 metrics 与 checkpoint。

评估在写 complete receipt 前逐局重放，并验证：

- summary 的 task id、manifest hash、tier、checkpoint、尺寸、规则、seed、agent spec 与当前任务完全相同；
- 每局 `game_index`/`pair_index` 连续，尺寸和 Superko 正确；
- 每对 seed 等于 `base_seed + pair_index`，A/B 策略 seed 在换色后保持一致；
- agent 名称与黑白 slot 相符；
- 每一步 diagnostics 与真实 Agent 类、learned checkpoint SHA、表示、PUCT 或搜索预算相符；
- 零截断，W/D/L 与 summary 一致。

已完成 receipt 只有在底层 checkpoint、metrics、self-play、summary、JSONL、CSV 全部重新深验后才会跳过；即使本次只选择 `--task-kind training`，已有 evaluation 也必须通过深验。任何 ledger 重建前都先按“training 建 checkpoint index，再 evaluation”顺序深验所有现存 receipt。失败会写显式 receipt 并默认不重跑；检查原因后必须增加 `--retry-failed` 才会留下新 attempt 并重试。修改训练源码后，已有 checkpoint 的严格 source hash 会阻止继续 formal run，因此正式启动前必须先冻结源码。

### 9.1 已验证 executor smoke

smoke manifest 是 `configs/d14_d16_executor_smoke_manifest.json`，只用于工程证据：三个模型各训练 1 局/1 梯度步，arena task 各 2 局。严格 identity 与深验证加入前的 `executor_smoke_v1` 已明确标记 superseded。

当前有效工程证据位于 `results/smoke/d14_d16/executor_smoke_v2`。已在 `rl310` + CPU 上真实完成三个 training-only task 和第一个 `padded_cnn vs Random` 两局换色评估；4 个 receipt 经 checkpoint/model/optimizer/replay、self-play、metrics、逐步 Agent diagnostics、JSONL/CSV 和 source identity 深验证，失败数为 0。随后再次运行 training-only，实测 `attempted_this_invocation=0`、`skipped_complete=3`，且已有 evaluation 同时通过深验证。`status` 报告 `artifacts_deep_validated=4`。其余 5 个 smoke evaluation 故意未运行，整个目录仍为 `smoke`，不能用于 D13--D16 论文结论。

复现只读 dry-run：

```powershell
& 'C:\Users\zcz\anaconda3\envs\rl310\python.exe' -B .\research\iclr2027\scripts\run_d14_d16_task_bundle.py dry-run --manifest .\research\iclr2027\configs\d14_d16_executor_smoke_manifest.json --bundle-dir .\research\iclr2027\results\smoke\d14_d16\executor_smoke_v2\task_bundle
```

查看当前 smoke 状态：

```powershell
& 'C:\Users\zcz\anaconda3\envs\rl310\python.exe' -B .\research\iclr2027\scripts\run_d14_d16_task_bundle.py status --manifest .\research\iclr2027\configs\d14_d16_executor_smoke_manifest.json --bundle-dir .\research\iclr2027\results\smoke\d14_d16\executor_smoke_v2\task_bundle --run-root .\research\iclr2027\results\smoke\d14_d16\executor_smoke_v2\run
```

### 9.2 正式执行（源码冻结后）

先生成 formal bundle 并运行 read-only dry-run。正式运行额外需要显式 `--confirm-formal`，避免误把协议验证命令变成长训练：

```powershell
& 'C:\Users\zcz\anaconda3\envs\rl310\python.exe' -B .\research\iclr2027\scripts\run_d14_d16_task_bundle.py run --manifest .\research\iclr2027\configs\d14_d16_formal_manifest.json --bundle-dir .\research\iclr2027\results\formal\d14_d16\task_bundle_v1 --run-root .\research\iclr2027\results\formal\d14_d16\run_v1 --device cuda --task-kind training --confirm-formal
```

15 个训练 receipt 全部完成并复核后，才运行 315 个评估 task：

```powershell
& 'C:\Users\zcz\anaconda3\envs\rl310\python.exe' -B .\research\iclr2027\scripts\run_d14_d16_task_bundle.py run --manifest .\research\iclr2027\configs\d14_d16_formal_manifest.json --bundle-dir .\research\iclr2027\results\formal\d14_d16\task_bundle_v1 --run-root .\research\iclr2027\results\formal\d14_d16\run_v1 --device cuda --task-kind evaluation --confirm-formal
```

只有 330 个 receipt 齐全时执行器才写 `result_receipts.jsonl`；之后再使用第 7 节的 `aggregate` 命令。当前没有启动任何 formal 训练或 30,600 局评估。
