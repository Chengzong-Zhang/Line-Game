# 六人防守标签：补充源与有界成本检查

未修改已运行的 172 源流水线、冻结 teacher 或 v1 工具。新增配置 `web/tools/configs/defensive-warmstart-v2-source6-supplement-20261025.json` 仅描述补充源和成本计划，没有启动长任务或训练。

新独立 seed 的 36 场原生合法游戏产生 87 个候选前缀，人数始终为 6，形状为原生六边形及三角形，边长 5/6/7；当前仅 1–2 个合法落点，teacher 仍枚举完整根动作和 PASS。源计划保存于 `local_artifacts/defensive-warmstart-v2/source6-supplement-r1/positions-unique-r1.json`，为每个新源和 episode 加 `source6-r1-` 前缀以避免与原源 ID 冲突。原采样器输出完整保留。`frozen-source-plan-receipt.json` 绑定配置、原文件与新源文件哈希。

只运行两次有界成本检查：第一批 6 个局面耗时 23.55 秒，第二批单个局面耗时 0.28 秒；每次 teacher 最多 5 秒、100000 节点，没有降低 12 层要求。

| 检查结果 | 数量 |
| --- | --- |
| 完整精确搜索且实际最大到达 12 层 | 1 |
| 完整搜索但原生提前终局、实际只到 1 层 | 2 |
| 5 秒预算内未完成，不产标签 | 4 |

找到的完整 12 层源为原 pilot validation 局面 `r1-retry-p6-s5-hexagon-validation-g0-t78`：六人、原生六边形、5 边、无认输，751 节点、2 个完整根动作含 PASS，实际最大层数 12，耗时 3308 毫秒。它是原未完成源在更高预算下的新 pilot，原收据不覆盖。这个 validation 源保存在 `source6-cost-r1/actual-full-horizon-positions.json`；只支持可行性，仍不是正式标签。

目前实际完整 12 层的 **train 源仍为 0、validation 为 1**，尚不能建立六人训练/验证集合。root 可对冻结的 87 个新源启动独立、有预算上限的监督预筛，并继续排除实际层数不足的提前终局树。本次没有启动该长预筛、改变 split、运行六人训练或宣称六人棋力提升。

逐局面收据在 `source6-cost-r1/pilot/receipts/` 和 `source6-cost-r2-one-train/receipts/`；第一批汇总为 `source6-cost-r1/bounded-cost-summary.json`。新源、原始轨迹和执行树留在本地，版本控制仅保存本说明及紧凑配置。
