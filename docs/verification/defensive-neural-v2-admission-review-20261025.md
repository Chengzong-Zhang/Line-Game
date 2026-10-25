# 神经候选训练语义与产品准入独立审查

本审查只读检查冻结训练实现与本次实际产物；新增的候选核验器不训练、不改运行时资产，也不改变既有 teacher 或监督机制。训练源提交为 `59b2934`。本说明不充当完整对战或产品准入收据。

## 本次准备和实际数据

源计划包含 112 场固定 seed 游戏的 356 个完整局面。独立核对 feasibility pilot 的 356 个逐单元收据、源状态哈希、完成集合、accepted 文件及 source 闭包通过；271 个接受、85 个因预算不足拒绝，pilot 输出始终不是正式训练标签。

初始 271 个接受局面中，有 99 个因精确终局 shortcut 没有实际到达请求 horizon，其中 66 个的所有分支在第三 ply 前结束。不能把这类 `completedDepth` 记账理解为实际执行了同样多步。随后新源计划额外要求 `maxReachedPly >= requiredDepth`，未改冻结 teacher、未改旧 pilot 收据。独立重读正式标签得到：

| 人数 | train | validation | 最小 completedDepth / maxReachedPly |
| --- | ---: | ---: | --- |
| 2 | 61 | 62 | 4 / 4 |
| 3 | 23 | 16 | 6 / 6 |
| 4 | 5 | 2 | 8 / 8 |
| 5 | 1 | 2 | 10 / 10 |
| 6 | 0 | 0 | 无标签 |

正式标签共 172 条。神经导出仅消费其中 123 个双人三角形样本（61 train、62 validation），完整 source-bound 重建和编码逐项核验通过。正式源 manifest SHA-256 为 `9bb52809324f3f962084a511fc292fd520adb7e5ca24dcba1bc00de3623b29d8`，神经导出 identity 为 `7471c9fae40d0b67c6b6aa8f315a33c08c8c68ec21e3fd5c0a0fd2500694bd79`。

样本来自边长 5、6、7、9 的 crowded/tactical 局面，源采样只保留至多四个合法落点的状态，再做完整全根搜索，包含 PASS。train/validation 按整场独立游戏划分，但相邻前缀仍相关；统计不应把每个位置视为独立对局。该分布不能证明开局、高分支局面、其他边长、六人或 7–15 人训练能力。五人只有一个训练位置，尤其不能据此宣称泛化改善。

## 实际发生的阶段排序失败

`neural-train-r1` 在零次参数更新时正确停止为 FATAL：尚在运行的线性流水线每段重新验证已完成数据，并原子重写字节相同的原始 manifest；Python 的 mtime/size 输入签名检测到改变。未发现权重或数据字节被改写，但继续训练所依赖的输入元数据不稳定。

处理方式是保留 r1、等主线性流水线 COMPLETE 后以稳定数据启动新 r2；不削弱输入 guard、不编辑冻结数据，不把 r1 当作完成或恢复训练结果。r2 的实际模型结果由独立新核验收据记录。

## 17 个模型究竟训练什么

当前三个现有 manifest 定义 12 个 CNN/GNN（3 legacy、9 transfer）及 5 个 MLP（DQN/PPO/SAC/GAIL/GAN）。初始化严格来自当前 F32 父资产，模型结构和导出顺序保持不变。新 Adam 和 RNG 从固定 seed 初始化；这是现有权重的监督 warm-start，不能称为继续原来的强化学习算法或原 RL 优化器状态。

每步目标为完整防守教师分布的交叉熵，加 `0.25 * KL(parent policy || candidate policy)`，学习率 `5e-5`、batch 16，每模型固定 100 次更新。17 个模型共享这组小样本监督目标；名称不同不自动证明新的难度梯度或棋力排序。现配置合计 1700 次优化更新、27200 次有放回样本抽取，并非 27200 个不同训练局面。

图网络 PASS 位于 mixed-size batch 的最后一列，MLP PASS 位于各样本实际 `nodeN`，不是固定 120。`pass_policy` 可更新。所有 value 参数保持原字节，但主干依然更新，因而 value 输出不固定。KL 只约束策略分布，既不约束 value 输出，也不保证历史棋力不退步。

这不是假设风险：对已有 tiny 两步 Grid-GNN 回归产物的独立核验发现，value 参数逐字节相同，单个 heldout 位置的 value 输出仍变化 `0.0058573559`。这个数字只属于 tiny fixture，不是 r2 的漂移结果。`NeuralPUCTAI.expand()` 直接把 value 用于搜索回传，故 12 个图网络的 value 漂移可能改变实际走法；五个 MLP 当前网页策略路径不消费存储的 value head。

另一个真实接入缺口是三个 legacy 图网络父 manifest 未声明 `action_contract.pass`。当前 `ResearchAI.evaluate()` 在仍有合法落点时会保留其历史 point-only 入口；继承该字段的新候选即使训练了 PASS，也不会自动在产品中开放主动 PASS。9 个 transfer 图网络和 5 个 MLP 具备现有 PASS 接口。该缺口阻塞“三个 legacy 候选已获得产品主动 PASS”这一说法，不阻塞离线隔离拟合。

## 独立核验和准入要求

新增只读核验器 `web/tools/verify-defensive-neural-candidates-v2.py` 接收完成的 run、严格数据和原配置。它检查原子提交 authority、identity/source/dataset/parent 闭包、全部候选和最终 `.pt` 哈希、F32 有限性和精确导出、冻结 value 参数，重新计算 heldout CE、教师最优动作一致率/概率质量、完整教师防守向量、PASS 使用和图网络 value 漂移。另列当前产品 legacy mask 下的差异；隐藏 PASS 使正质量目标不可表示时不会伪造有限 CE。

```text
<rl310-python> web/tools/verify-defensive-neural-candidates-v2.py --run-root <complete-run> --data-root <neural-export> --config web/tools/configs/defensive-neural-v2-20261025.json --output <new-report-outside-frozen-run>
```

该工具已在既有 tiny Grid-GNN/DQN 两步恢复产物上通过：真实 checkpoint/父资产闭包、合法且归一化策略、冻结 value 参数与输出漂移均得到核验。正式 run 完成后必须重新运行，tiny 结果不能代替正式结果。

产品准入还需要以下独立证据：

1. 在精确目标规则、形状和人数范围内验证候选 manifest、PASS 接口、实际浏览器/原生微信前向与 Python 的数值一致性，保留 Worker 取消、重开和完整历史恢复回归。
2. 使用不参与训练、pilot 选择或超参数选择的新整场种子测试；包括开局、高分支、连续被切、主动造根连通攻击链和决定胜负的 PASS。按整场种子报告不确定性，区分原生状态与外推尺寸。
3. 对照当前产品父模型，在相同规则、完整对局、颜色交换和相同搜索预算下，分别比较胜负、离散终局分数、连续损失、根连通攻击和延迟。有限 teacher agreement 不能替代完整对战。
4. 对 12 个图网络单列 value 漂移及与真实终局结果的校准。若价值预测恶化，需要新的隔离方案及复验；不能因 value 参数没变就宣称价值能力保持。
5. 只有上述结果支持后才单独决定各候选的接入、难度归属与发布；保留可回滚父资产，分别核实 Web、微信设备和渠道状态。当前候选一律 `strength_verified:false`、`runtime_admitted:false`。
