# D17--D19 零样本尺寸泛化与多样化评估协议

冻结日期：2026-08-29

协议 ID：`d17_d19_protocol_frozen_20260829_v1`

可执行 manifest：`configs/d17_d19_formal_manifest.json`

显式开局 manifest：`configs/d17_d19_openings_manifest.json`

## 1. 证据边界与实验 ID

本协议只新增结果，不训练、复制或重跑 D14--D16 的正式任务，不修改既有模型权重、游戏规则、旧协议、旧收据或 `paper/**`。

三个新实验 ID 固定为：

| 优先级 | 实验 | experiment_id | 证据层 |
| --- | --- | --- | --- |
| P0 / D17 | GEN-SIZE | `d17_gen_size_zero_shot_formal_v1` | `formal` |
| P0 / D18 | D16-v2 | `d18_d16_v2_diverse_openings_formal_v1` | `formal` |
| P1 / D19 | 架构匹配逻辑边消融 | `d19_logic_edge_archmatched_smoke_v1` | `smoke` |

总 bundle ID 为 `d17_d19_lifeline_extension_20260829_v1`。D18 的展示名称只能写作 **D16-v2**；不得覆盖、改名或回写原 D16。

所有新输出必须位于 `results/formal/d17_d19/<new_run_id>/`。runner 必须拒绝非空目标目录。dry-run、smoke 与 formal 目录和 ledger 必须分离。

## 2. 冻结输入与 checkpoint

D14--D16 的五个训练 seed 固定为 `20260825..20260829`。可执行 manifest 逐个绑定 15 个最终 `gradient_steps=200` checkpoint：

- `padded_cnn` 5 个；
- `grid_gnn` 5 个；
- `topology_gnn` 5 个。

每项均包含 checkpoint 路径和 SHA-256、resolved config 路径和文件 SHA-256、checkpoint 内部 config/source hash、原 D14 training task receipt 路径和 receipt SHA-256。运行前必须重新计算并逐项相等。

GEN-SIZE 只允许使用其中 5 个 Grid-GNN 与 5 个 Topology-GNN，共 10 个最终 checkpoint。D16-v2 使用三个表示的全部 15 个最终 checkpoint，并只比较相同训练 seed 的模型。禁止微调、权重转换、checkpoint 合并和遗漏失败 seed。

## 3. 正式运行前的精确 dry-run

任何 formal game 之前必须完成一个独立 `dry_run` 证据目录。精确矩阵为：

先生成不可覆盖的显式 task bundle：

```powershell
& 'C:\Users\zcz\anaconda3\envs\rl310\python.exe' -B .\research\iclr2027\scripts\d17_d19_runner.py prepare-bundle --manifest .\research\iclr2027\configs\d17_d19_formal_manifest.json --bundle-dir .\research\iclr2027\results\formal\d17_d19\run_20260829_p0_v1\task_bundle
```

然后分别运行 CPU readiness 与精确 dry-run；二者只能写入本次 run 的 preflight 子目录：

```powershell
& 'C:\Users\zcz\anaconda3\envs\rl310\python.exe' -B .\research\iclr2027\scripts\d17_d19_runner.py readiness --manifest .\research\iclr2027\configs\d17_d19_formal_manifest.json --output .\research\iclr2027\results\formal\d17_d19\run_20260829_p0_v1\preflight\readiness.json
& 'C:\Users\zcz\anaconda3\envs\rl310\python.exe' -B .\research\iclr2027\scripts\d17_d19_runner.py dry-run --manifest .\research\iclr2027\configs\d17_d19_formal_manifest.json --output .\research\iclr2027\results\formal\d17_d19\run_20260829_p0_v1\preflight\dry_run.json
```

| 检查 | 单元数 | 每单元 fixture | forward / PUCT 检查 |
| --- | ---: | ---: | ---: |
| GEN-SIZE：10 checkpoint x n=10/12 | 20 | 3 | 60 |
| D16-v2：15 checkpoint x n=5/7/9 | 45 | 3 个固定 opening cluster（0、15、31） | 135 |
| 合计 | 65 | -- | 195 |

每个 fixture 必须同时验证：

1. checkpoint、config、source 与旧 receipt 哈希；
2. 完整状态解析、序列化、恢复与 state fingerprint 不变；
3. 尺寸编码和张量、节点、物理边、逻辑边形状；
4. 动作数严格等于 `n(n+1)/2+1`；
5. legal mask 与环境逐点合法动作完全一致；
6. PASS 位于 `n(n+1)/2`，在非终局状态合法；
7. 非法动作概率为零，合法 prior 与 value 有限；
8. Grid-GNN 只读取物理边，Topology-GNN 读取完整逻辑关系；
9. 一次无 root noise、temperature 0 的 PUCT-16 选择合法且可重放。

任意 checkpoint/尺寸/fixture 失败即停止；只修本地代码，不得进入正式运行或租用新实例。dry-run 结果不得进入 formal aggregate。

## 4. D17 GEN-SIZE 冻结矩阵

训练尺寸仍为 5/7/9，测试尺寸固定为 10/12，不允许任何形式的微调。

正式 cell：

`2 representations x 5 training seeds x 2 eval sizes x 2 opponents = 40 tasks`

对手固定为：

- Random；
- 冻结 `UCT-MCTS-16`：16 simulations、rollout depth 80、exploration `sqrt(2)`。

神经模型固定使用 PUCT-16、`c_puct=1.5`、temperature 0、无 root noise。每个 task 从空棋盘开始，`start_player=BLACK`，Superko enforce，最多 256 plies。

每个 task 使用 16 个显式 policy-seed block；每个 block 交叉两次 A/B 策略 seed 分配，每次分配成对换色。seed 随 agent 身份移动，不随棋色移动。因此：

- 每 task 32 个换色 pair、64 局；
- 40 tasks、2,560 局；
- 所有 checkpoint、尺寸和对手复用完全相同的 policy-seed plan。

task manifest 必须显式写出 32 项 `pair_plan`，包括 policy seed、两次颜色分配、game ID 与空开局 hash；不能仅留下派生公式。

### 4.1 GEN-SIZE 多样性门

动作轨迹 key 为“尺寸 + opening prefix + continuation action-index sequence”，忽略 black/white slot 标签。每个 64 局 task 至少需要：

- 48 条唯一轨迹；
- 唯一比例至少 0.75；
- 64/64 可重放；
- 0 截断。

未达到即该 task 失败，并令 GEN-SIZE `formal_ready=false`。

### 4.2 GEN-SIZE 统计

逐局 score 定义为 win=1、draw=0.5、loss=0。先对一个换色 pair 取均值，再对同一训练 seed 的 32 个 pair 取均值。

主统计单位是训练 seed，共 5 个。主区间为五个 seed 均值的双侧 95% Student-t 区间（df=4，截断到 [0,1]）。同时报告固定 20,000 次的 two-way crossed bootstrap：独立重采样 training-seed ID 与共享 policy-pair ID，再取交叉 cell；bootstrap seed 为 `202608299901`。

逐局 pooled Wilson 区间只能作为描述性附录，不能作为零样本泛化的主推断。

## 5. D18 D16-v2 显式开局

`configs/d17_d19_openings_manifest.json` 冻结了 96 个实际开局，而不是仅冻结生成算法：

- n=5/7/9 各 32 个 cluster；
- 每个尺寸的 target prefix length 为 2/4/6/8 plies，各 8 个；
- 每项包含 `cluster_id`、`opening_id`、base/effective opening seed、显式 action-index prefix 与坐标、prefix SHA-256、终态 fingerprint、PASS index、当前玩家、turn count 和合法性检查；
- 96 个 prefix hash 与 96 个 state hash 均唯一；
- 所有 prefix 只含合法 point action，不含 PASS、自动跳过或终局；
- Superko mode 固定为 `enforce`，start player 固定为 BLACK。

`opening_prefix_hash` 是无空格 canonical JSON action-index list 的 UTF-8 SHA-256；`opening_state_hash` 是 `LifelineGame.canonical_state_json()` 的 UTF-8 SHA-256。formal runner 必须按显式 prefix 重放，不能重新抽样或替换“不好看”的开局。

开局 manifest 的路径和整文件 SHA-256 被主 manifest 绑定。所有模型、训练 seed 与换色任务复用同一尺寸的 32 个开局。

## 6. D16-v2 冻结矩阵

模型 pair 固定为：

1. Padded-CNN vs Grid-GNN；
2. Padded-CNN vs Topology-GNN；
3. Grid-GNN vs Topology-GNN。

正式 cell：

`3 model pairs x 5 matched training seeds x 3 eval sizes = 45 tasks`

每个 opening cluster 有两种交叉的 A/B policy-seed assignment，每种 assignment 成对换色，共 4 局。因此：

- 每 task 32 clusters x 4 = 128 局；
- 每 task 64 个换色 pair；
- 45 tasks、5,760 局；
- PUCT、规则和 256-ply 上限与原 D16 保持一致。

主 manifest 对 96 个 opening 逐个列出两种显式 policy-seed assignment。task manifest 必须把一个 task 的 64 个 pair 全部写入 `pair_plan`；逐局记录必须引用 opening/policy assignment/pair/game ID。

### 6.1 D16-v2 多样性门

每个 128 局 task 必须同时达到：

- 至少 64 条唯一完整轨迹；
- 去掉 opening prefix、忽略 black/white slot 后，至少 32 条唯一 continuation；
- 至少 24/32 opening cluster 各自出现不少于 2 条不同 continuation；
- 128/128 可重放；
- 0 截断。

换色标签本身不能机械增加唯一数。另行报告带 slot 的审计 key，但不得用它通过主多样性门。

### 6.2 D16-v2 统计

一个基础统计 cell 是 `training seed x opening cluster`：保留该 cell 内两种 policy assignment 和两次换色共 4 局，先形成 cluster mean。

主 95% 区间为 20,000 次 two-way crossed-cluster percentile bootstrap：独立重采样 5 个 training-seed ID 与 32 个共享 opening-cluster ID，再取交叉 cell 并保留 cell 内全部 4 局；bootstrap seed 为 `202608299902`。

同时报告五个 training-seed mean 的 Student-t 95% 区间（df=4）。所有 model difference 必须在相同 seed、opening、policy seed 与换色计划上配对。不得把 5,760 局视为独立样本。

## 7. Task、逐局记录与 receipt 合同

正式 task manifest 必须正好 85 行 task-level 记录，并为每行保存显式 `pair_plan`。每个 task 至少包含：

- `task_id`、`experiment_id`、`experiment_arm`、`inference_group_id`；
- training seed、checkpoint ID/path/SHA、config/source/旧 receipt SHA；
- eval size、对手或 model pair；
- opening cluster/ID/actions/prefix hash/state hash；
- policy seed assignment、A/B seed、color swap 与 pair/game ID；
- games、max plies、Superko、manifest/source/runner/protocol hash。

每局记录必须包含完整开局与 continuation action indices、黑白 agent 绑定、策略 seed、W/D/L、终态 fingerprint、截断状态和 replay verification。summary、games JSONL、CSV、receipt 与 task manifest 必须互相绑定 SHA-256。

runner 每完成一个 task 原子写 receipt 和不可覆盖 attempt。恢复只能跳过已通过深验证的 complete receipt；失败 receipt 默认保留，只有显式 retry 才新增 attempt。重复 task、缺失 pair、额外 game、旧 experiment ID 或 hash drift 都是硬失败。

## 8. P0 正式门

P0 的冻结总量为：

| 实验 | tasks | games |
| --- | ---: | ---: |
| GEN-SIZE | 40 | 2,560 |
| D16-v2 | 45 | 5,760 |
| P0 合计 | 85 | 8,320 |

`formal_ready=true` 必须同时满足：

1. 85/85 complete receipts，0 failed，0 missing；
2. 8,320/8,320 完成，0 截断，全部可重放；
3. checkpoint、D14 receipt、source、config、protocol、runner 与 task manifest 哈希绑定；
4. 所有换色 pair、显式 opening 和 policy seed 完整；
5. 两项实验各自的唯一轨迹门全部通过；
6. canonical aggregate 不删除失败 seed；
7. 独立 verifier 不读取 canonical aggregate 或结果结论，独立重放并复算 task 完整性、W/D/L、区间和哈希；
8. 独立输出与 canonical aggregate 精确一致（浮点仅允许协议实现声明的机器精度容差）。

任一门失败都必须输出 `formal_ready=false`，保留失败原因，并禁止正面论文结论。

## 9. P1 D19 条件门

P1 默认禁用。只有两个 P0 aggregate 均 `formal_ready=true`、独立验证通过、85/85 task 无缺失/失败/截断、多样性门通过，且剩余墙钟预算至少为实测 P1 预计时间的两倍时，才可写 gate receipt 并启用。

smoke 内含两个严格匹配的训练 arm：

- `topology_full_smoke`；
- `topology_no_logical_edges_smoke`：保持 relation tensor 形状，仅把己方/敌方逻辑关系通道置零。

两者均为 Topology-GNN 64 hidden、3 message-passing layers、63,171 trainable parameters；参数数必须完全相等。只使用 seed 20260825，mixed n=5/7/9，每 arm 20 self-play games、40 gradient steps、PUCT-16。最终在 n=5/7/9 各进行 8 个换色 pair 的 head-to-head，共 48 局。计划 2 个训练 task + 3 个评估 task。

该结果只能称为工程 smoke，不得写成正式 ABL-EDGE 结论。三天内不得引入 PPO、A2C、DQN 或 TRPO；model-free RL 保持 stretch，不能延迟 P0。

## 10. AutoDL 合同

只有本地计算量过大时才可准备 AutoDL job。先完成本地修复和 195 项精确 dry-run。

Job TOML 必须同时含：

- task-shaped CPU `readiness_command`：读取真实冻结 checkpoint 与一个显式 opening，覆盖 manifest 解析、形状、模型构建和真实 forward；
- 15--30 秒 `gpu_smoke_command`：在 disposable model clone 上连续执行真实 CUDA forward/backward/optimizer，校准 batch、AMP 与数据供给，把 throughput profile 写入 `AUTODL_WORK_DIR`；
- `min_gpu_utilization_percent = 50`。

优先复用兼容实例；不得触碰 Tencent `ar-tc-*` 或无关实例，不得释放实例。大型中间文件只写 `AUTODL_WORK_DIR`；`AUTODL_EXPORT_DIR` 只含摘要、receipt、CSV、JSON、日志摘要和 SHA-256。

每个正式 Job 只执行一次 `autodl-direct run JOB`，不得并行手动轮询。readiness 失败只修本地；GPU smoke 失败先修当前实例依赖/配置。租用新实例、产生费用或改变卡型前必须暂停并取得用户明确确认。

## 11. 三天冻结节奏与交接

第 1 天只允许完成协议、manifest、runner、测试、readiness 与精确 dry-run。第 2 天执行 P0、按 receipt 恢复中断并收集轻量结果。第 3 天上午由独立 verifier 重放与聚合；下午只有在 formal gate 明确后才能冻结 `D17_D19_RESULTS.md` 并交给 AI-1 与 AI-3。

交接至少包括：

- 主 manifest、显式 opening manifest 与 task manifest；
- canonical 与 independent aggregate；
- result receipts、task completeness、replay 与 unique-trajectory 报告；
- checkpoint/source/config/protocol/runner/artifact SHA-256；
- readiness 时间、AutoDL 复用/新建状态、卡型、GPU smoke 利用率；
- 完成/失败/缺失 task 数和支持/不支持的论文主张。

## 12. 允许与禁止的论文主张

只有 GEN-SIZE 通过 seed-aware formal gate，才能在 n=10/12 的固定 Random/UCT-MCTS-16、固定预算与这 10 个 checkpoint 范围内陈述“零微调尺寸迁移”的实证结果；不能外推到其他尺寸、对手、搜索预算或训练算法。

只有 D16-v2 通过 cluster/seed-aware formal gate，才能用它修复原 D16 的确定性轨迹重复问题并陈述三表示在冻结多样化开局分布上的配对差异；不能把它改写为原 D16 的 200 个独立样本，也不能推出全局模型排名。

本协议不完成 ABL-SUPERKO、ABL-CASCADE、完整 ABL-EDGE 或 model-free RL。P1 smoke 即使通过，也只支持“架构匹配消融管线可运行”的工程性表述。
