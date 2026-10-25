# 完整防守标签的 17 神经模型 warm-start 桥

本增量只增加离线桥、训练器和有界回归。没有重启退休的一步/两步教师，没有改旧训练协议、旧核心、冻结数据或运行时模型资产。训练输出始终为独立候选，`strength_verified:false`、`runtime_admitted:false`。

`web/tools/export-defensive-neural-v2.mjs` 调用 `loadDefensiveDataset`，再用完整棋盘、真实逻辑边、行动方、规则和 Superko 历史进行 source-bound 校验。只选择双人三角形、边长 5–15 的局面；其他人数留给对应模型路径。每条记录保存源状态和完整教师标签、搜索收据与哈希，并按当前 `encodeResearchPosition`、`researchRelations`、`modelFreeState` 导出。生成和消费两端都拒绝浅层、不完整、超时、截断或非精确根分值标签，要求实际完成至少三层和当前双人两轮的四层门槛。

完整合法分布包含主动 PASS。图网络将 PASS 放在混合大小 batch 的最终列，MLP 与当前浏览器保持一致，将每个样本的 PASS 放在该样本 `nodeN`，其余 121 维输出严格遮罩；不能把 PASS 固定为 120。`defensive_neural_core_v2.py` 复用 `neural_posttraining_core.py` 的现有 12 个 CNN/GNN 和 5 个 MLP 网络、张量清单及 F32 导出，初始化后要求与所选父资产逐字节一致。图网络的 `pass_policy` 开放训练，value 参数保持冻结；共享主干变化仍可能改变 value 输出。

新训练器 `train-defensive-neural-v2.py` 是单独 Python 进程，保留 Adam、完整模型、Python/Torch/CUDA RNG 和每步检查点，校验配置、源文件、完整数据与父资产身份。CUDA RNG 恢复显式转换回 CPU ByteTensor。每次检查点只有在 `checkpoint.json` 原子提交后才算完成一个 update；未被引用的完整 `.pt` 保留为未提交证据，不按时间戳或最大编号自动采信。恢复只重算未提交单元，已提交单元和已完成模型不重跑。保留两个已提交状态；损坏、身份漂移和重复 worker 拒绝继续。

```text
node web/tools/export-defensive-neural-v2.mjs --data-root <complete-defensive-labels> --output <isolated-neural-export> --max-new-units 1
node web/tools/export-defensive-neural-v2.mjs --data-root <complete-defensive-labels> --output <isolated-neural-export> --verify
<rl310-python> web/tools/train-defensive-neural-v2.py --data-root <isolated-neural-export> --run-root <isolated-training-run> --config <frozen-config.json> --max-new-units 1 --max-seconds 60
```

训练配置 schema 为 `lifeline-defensive-neural-config-v2`，字段沿用明确的 `model_ids`、`updates_per_model`、`batch_size`、`seed`、`threads`、`device`、`learning_rate`、`parent_kl`、`gradient_clip`。`--max-units` 是 `--max-new-units` 的别名。退出码 75 为 PAUSE/STOP/预算让出，78 为配置/证据/重复锁拒绝，0 为隔离候选拟合完成，79 仅用于故障回归。运行目录 `PAUSE`/`STOP` 是显式控制入口；长任务仍须由独立 supervisor 启动并完成恢复演练。

回归入口：`node web/web前端/tests/verify-defensive-neural-v2.mjs`。它真实生成三个有界 source-bound 防守标签，检查导出未索引样本接纳、重哈希浅层标签仍拒绝、导出篡改拒绝；Python 检查全部 17 父资产的精确初始化、PASS 参数可更新、value 参数冻结、混合大小 PASS 遮罩，再以 Grid-GNN 和 DQN 各两次更新比较故障恢复与干净运行的资产哈希，覆盖暂停、重复锁、损坏、配置漂移及无效优化配置拒绝。另可用 `web/tools/tests/verify_defensive_neural_v2.py --data-root <test-export> --recovery-device cuda` 在本机 RTX 4060 上重复同一恢复检查。

这些是工程与 tiny 两步训练回归，不能当作生产训练、棋力提升、三角形之外的能力或模型准入证明。
