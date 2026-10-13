# LIFELINE Lab 公开互动展品清单

状态：只读研究整理稿。未启动实验，未修改游戏源码或冻结协议，未提交。结论只覆盖本次审阅的 `research/iclr2027` 证据快照。

## 证据范围与总原则

本清单依据：

- `research/iclr2027/README.md`（论文/研究目录说明与公开表述边界）；
- `research/iclr2027/D6_state_aliasing.md`、`state_aliasing/`、`d6_redteam_audit.md` 及 D6 红队验证脚本；
- `research/iclr2027/D14_D16_RESULTS.md`、`results/README.md`、D14--D16 环境验证脚本与 fresh-install contract 验证脚本；
- 结果文件中列出的哈希、账本、CSV、JSON receipt 和独立审计产物。

展品接入统一遵守 **LIFELINE Exhibit Evidence Rule v1**：

1. 只从固定版本的 JSON/CSV/receipt 重放或渲染，不在展品服务器上重新搜索、训练或改变规则。
2. 每个交互视图同时显示“观测相等/潜变量不同/决策是否不同/验证范围”四类标签，避免把机制诊断变成性能宣传。
3. 所有“未找到”必须保留搜索预算；只有完整边长 5 枚举可标记为该范围内的穷尽负结果。
4. `formal_ready=true` 只表示任务、身份、预算、重放和工件完整；不自动表示全局最优、因果效果、统计显著或外部复现完成。
5. 展品页面展示证据层级、数据版本、源文件 SHA-256 和验证脚本版本；不上传原始大体积轨迹、checkpoint 或本地执行树。

## 优先级总览

| 优先级 | 展品 | 适合原因 |
| --- | --- | --- |
| P0 | 同一棋盘，隐藏结构不同吗？ | 低成本确定性重放，直接展示表示可识别性与“没有决策差异”的边界。 |
| P0 | 为什么 6×6 的这一步被 Superko 拒绝？ | 因果链清楚，规则触发可逐步审计；不需要宣称严格状态别名。 |
| P0 | 一条正式结果如何被审计？ | 体现 LIFELINE Lab 的证据治理，适合作为所有性能展品的入口。 |
| P1 | 5×5 完整枚举：潜在别名真的影响决策吗？ | 将负结果、PASS 修正和独立求解器变成可检查的机制展品。 |
| P1 | 三种表示的学习曲线 | 有正式账本和多 seed 描述结果，但需显著标注统计边界。 |
| P1 | 表示之间有没有跨尺寸赢家？ | 交互式展示 size × representation 交互和重复轨迹限制。 |
| P2 | 固定对手矩阵：Random 与 UCT-MCTS-16 | 可作为性能背景页，不应作为主叙事或排行榜。 |

## 展品 1：同一棋盘，隐藏结构不同吗？

- **用户问题**：两个动作历史能否到达相同的当前 Grid 观测，却留下不同的逻辑边或 Superko 历史？这些差异是否已经改变下一步决策？
- **可视化形式**：左右双栏同步重放 `weak_grid_topology_n5_v1`、`weak_grid_topology_n6_v1` 和 `weak_history_alias_n5_v1`；逐步显示棋盘、合法动作掩码、逻辑边、历史键数量及哈希。共同动作时叠加后继观测，明确标出“潜变量不同、直接决策结果相同”。
- **依赖的验证文件**：`D6_state_aliasing.md`；`state_aliasing/pairs_v1.json`；`state_aliasing/search_report_v1.json`；`scripts/d6_redteam_exact_audit.py` 及其 `d6_redteam_exact_audit.json`；必要时使用 D6 中列出的 `tests.test_d6_aliasing` 重放检查。
- **可公开表述**：我们找到自然可达的弱配对：实现的完整 Grid 观测可以相同而逻辑边不同，完整 Topology 观测可以相同而历史集合不同。它们是“当前观测不能唯一恢复某些潜在结构”的诊断实例；在边长 5 的完整审计范围内，这些差异没有改变合法动作、一步观测、精确价值、共同动作 Q 值或最优动作。
- **禁止过度表述**：不得称“当前 Grid 非马尔可夫”“逻辑边是最优决策必需信息”“Superko 已产生自然可达决策别名”，也不得把 `NOT_FOUND_WITHIN_BUDGET` 写成不存在性证明。
- **接入规则版本**：`lifeline_rl 0.1.0`；`pairs_v1` schema 1、dataset 1.0.0；`search_report_v1` 的 `search_definition_version=2`、report 1.2.0；D6 证据快照（2026-08-25）。必须保留实现 Grid 含 `legal_action_mask` 的定义。
- **优先级**：P0。

## 展品 2：为什么 6×6 的这一步被 Superko 拒绝？

- **用户问题**：一条完全自然可达的对局中，系统如何识别并拒绝会回到既有规则位置的动作？如果关闭执行拒绝，轨迹会怎样？
- **可视化形式**：6×6 棋盘时间轴；逐步显示执棋方、棋盘、逻辑边、历史键和规则位置哈希。在候选动作 `[2,3]` 处并排显示 `enforce` 的事务性拒绝与 `observe` 的反事实继续，突出六步闭环及其最后一步。
- **依赖的验证文件**：`D6_state_aliasing.md`；`state_aliasing/superko_n6_witness_v1.json`；`state_aliasing/search_report_v1.json`；D6 所列的 `results/validation/superko_random_n6_seed20260826.json`。展品只重放冻结 witness，不调用搜索脚本生成新轨迹。
- **可公开表述**：从标准 6×6 初态出发，前 10 个动作合法，第 11 个候选动作因 `SUPERKO_VIOLATION` 被拒绝；该动作会闭合一条六步循环。它证明 Superko 在自然可达的 6×6 状态上确实能改变动作合法性，并提供关闭拒绝后的反事实对照。
- **禁止过度表述**：不得称这是严格的“双自然历史、同一无掩码 Topology、不同合法性”配对；不得称六步是全局最短；不得由这一见证推出 Grid/Topology 非马尔可夫、Superko 可以删除、规则等价或训练策略不受影响。
- **接入规则版本**：`natural_superko_n6_witness_v1` schema 1；规则实现 `lifeline_rl 0.1.0`；`superko_mode=enforce/observe` 只作为已定义的反事实显示；搜索报告仍标明 strict pair 未找到。
- **优先级**：P0。

## 展品 3：5×5 完整枚举——潜在别名真的影响决策吗？

- **用户问题**：即使有 1,088 对“同 Grid、不同逻辑边”的状态，是否存在合法动作、价值或最优策略差异？
- **可视化形式**：可筛选的完整图审计面板：25,096 个状态、67,505 条转移、976 个 Grid 混淆组、1,088 对不同拓扑状态；点击任一指标显示对应计数。单独展示全部严格差异指标为 0，并提供 PASS 分支审计说明。
- **依赖的验证文件**：`D6_state_aliasing.md`；`d6_redteam_audit.md`；`scripts/d6_redteam_exact_audit.py`；`d6_redteam_exact_audit.json`；`state_aliasing/search_report_v1.json`。证书必须来自修正后的独立求解器，不得用早期遗漏 PASS 的价值表替代。
- **可公开表述**：在当前双人规则、标准初态、边长 5 的完整原始图上，独立红队求解器显式处理每个非终局 PASS，并发现：合法动作不同、下一实现 Grid 观测不同、精确黑方价值不同、共同动作 Q 值不同、最优动作集合不同和不相交最优集合，均为 0。这是该范围内的完整负结果。
- **禁止过度表述**：不得外推到边长 6--15 或其他规则；不得称整个游戏家族不存在严格反例；不得把“当前 n=5 没有决策差异”改写成“逻辑边永远无用”。必须展示早期求解器漏掉 2,080 个终局 PASS、影响 294 个价值和 1,272 个最优动作集合的审计记录。
- **接入规则版本**：raw side-five graph；独立红队 audit schema 1；逆拓扑零和求解，PASS 全分支修正版；与 `search_report_v1` 的边长 5 complete 记录绑定。
- **优先级**：P1。

## 展品 4：三种表示的学习曲线

- **用户问题**：Padded-CNN、Grid-GNN、Topology-GNN 在固定训练预算下，学习曲线和尺寸变化是否呈现同一种形态？
- **可视化形式**：按表示和 `n=5/7/9` 切换的学习曲线；同时显示五个训练 seed、step 40/80/120/160/200 的 W/D/L 或得分率、区间类型和 mixed-size loss。默认视图不隐藏 seed 离散程度。
- **依赖的验证文件**：`D14_D16_RESULTS.md`；`results/README.md`；`results/formal/d14_d16/aggregate_v1/training_curve.csv`；`aggregate_v1/arena_learning_curve.csv`；`reviews/d14_d16_seed_pair_descriptive_audit.md`；`results/validation/d14_d16_independent_receipt_audit_20260831.json`；环境身份由 `scripts/verify_d14_d16_environment.py` 及其 v2 receipt 绑定。
- **可公开表述**：`d14_d16_three_representation_formal_v1` 完成 15/15 训练和 315/315 评估，三种表示在已见的 n=5/7/9 上均高于 Random；曲线可用于展示固定 checkpoint、五 seed 和尺寸条件下的描述性变化。loss 是 mixed-size optimizer diagnostic，不是单尺寸强度。
- **禁止过度表述**：不得说某表示显著更快收敛、更样本高效或具有跨尺寸泛化；不得用 pooled-game Wilson 区间替代 seed-level 推断；不得把 40→200 的变化当成预注册 AUC 或固定强度阈值结果。
- **接入规则版本**：experiment `d14_d16_three_representation_formal_v1`；evidence tier `formal`；五 seed、mixed-size `[5,7,9]`、checkpoint `{40,80,120,160,200}`；环境验证 schema 1。展品运行时禁止重新训练。
- **优先级**：P1。

## 展品 5：表示之间有没有跨尺寸赢家？

- **用户问题**：如果只看模型互打，是否存在一个在所有棋盘尺寸上都占优的表示？
- **可视化形式**：D16 三表示 round-robin 热力图，支持按 n=5/7/9、训练 seed 和 A 视角切换；每个格子同时显示 pooled W/L/D、seed-level 描述范围，并在旁边显示“每个 200 局 task 只有两条唯一颜色条件轨迹”的审计警告。
- **依赖的验证文件**：`D14_D16_RESULTS.md`；`results/README.md`；`results/formal/d14_d16/aggregate_v1/representation_round_robin.csv`；`reviews/d14_d16_seed_pair_descriptive_audit.md`；`results/validation/d14_d16_independent_receipt_audit_20260831.json`。
- **可公开表述**：在固定 checkpoint 和五个训练 seed 下，Topology-GNN 相对 Grid-GNN 的方向在三个尺寸都偏向 Topology-GNN；Padded-CNN 相对另外两种表示的方向随尺寸反转或持平。这支持“size × representation 交互值得研究”，不支持一个跨尺寸全局排名。
- **禁止过度表述**：不得称存在因果的表示优势、全局冠军、统计显著差异、Elo 或独立 1,000 局不确定性；D16 的 1,000 局汇总不能当作 1,000 个独立样本，不能外推到 n=10/12 或未见尺寸。
- **接入规则版本**：D16 `formal_v1`；45 个 round-robin task、五训练 seed、每 task 200 局；展品必须保留颜色交换和完整轨迹 hash 信息，并将 Wilson 区间标为 nominal/descriptive。
- **优先级**：P1。

## 展品 6：一条正式结果如何被审计？

- **用户问题**：研究者如何知道一个 headline result 没有缺 receipt、重复计数、截断或环境漂移？验证器到底证明了什么？
- **可视化形式**：从冻结 manifest 到训练 receipt、评估 receipt、replay、aggregate、独立审计和公开 CSV 的证据链；显示 15/15 training、315/315 evaluation、330/330 deep-validated artifacts、30,600/30,600 replay-verified、0 truncation，并提供哈希点选和失败关闭状态。
- **依赖的验证文件**：`D14_D16_RESULTS.md`；`results/README.md`；`results/validation/d14_d16_independent_receipt_audit_20260831.json`；`scripts/verify_d14_d16_environment.py`；`results/validation/d14_d16_environment_verification_20260831_v2.json`；`scripts/verify_d14_d16_fresh_install_profile.py` 及其 tracked profile。需要同时显示 `reviews/d14_d16_seed_pair_descriptive_audit.md` 的“descriptive only”边界。
- **可公开表述**：该证据包在冻结的 `d14_d16_three_representation_formal_v1` 身份下通过账本、聚合、回放和工件一致性检查；环境 verifier 绑定精确的软件版本与 portable metadata，fresh-install verifier 绑定的是一个未执行的、contract-only 的安装合同。两者共同提高可审计性，但各自不替代重新训练或原始硬件复现。
- **禁止过度表述**：不得说 fresh install 已成功执行、训练已在展品服务器重现、所有 checkpoint/raw trajectory 都被独立重新哈希、硬件差异已被消除或结果已获外部评审/接收。`formal_ready=true` 不是数学证明，也不是论文接收结论。
- **接入规则版本**：formal result `d14_d16_three_representation_formal_v1`；environment verification schema 1；fresh-install profile/receipt schema 1；profile status `contract_only_not_executed`；所有展示必须保留 verifier source hash、manifest hash 和 scope boundary。
- **优先级**：P0。

## 不建议当前接入的内容

- D6 的“严格拓扑反例”和“严格历史/Superko 配对反例”：当前证据明确为 0 或 `NOT_FOUND_WITHIN_BUDGET`，没有可诚实展示为已发现严格反例的素材。
- 把 Superko 单策略 n=6/n=7 pilot 做成“规则等价/可删除规则”的互动结论：D6 只支持固定策略、尺寸和 horizon 下的经验相近，且方法在探索输出后修订并复用了 seed。
- 把 D14--D16 做成实时训练或排行榜：这会绕过冻结身份、轨迹重复审计和统计边界。
- 将 `D17--D19` 或任何未达到 `formal_ready=true` 的扩展结果并入上述展品；当前论文 README 明确其状态不能作为正式性能结果。

## 最小公开入口

首批建议只上线三个 P0 展品：展品 1（弱配对）、展品 2（Superko 触发）和展品 6（证据链）。它们分别回答“观测遗漏了什么”“规则何时真正起作用”“如何审计结论”，且都能在不运行新实验、不修改游戏源码的条件下由冻结 JSON、receipt 和验证器重放。性能曲线与表示对战应作为第二阶段，并在页面首屏保留各自的描述性与非外推警告。
