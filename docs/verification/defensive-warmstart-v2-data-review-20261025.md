# 防守继续训练 v2：源数据独立审查（2026-10-25）

本次只读核对冻结源码 `59b2934` 下已完成的 application-pilot-r1，不修改 teacher、v1 编译器、原 source plan、pilot 收据或运行协议。356 个真实合法前缀全部完成 pilot，完整搜索接受 271、预算拒绝 85。独立审查额外排除提前终局且实际未达到要求动作层数的源局面，得到 **172 个可供正式编译的源局面**；这些仍然不是正式训练标签。

## 实际搜索深度筛选

完整 Minimax 可以在原生终局提前精确解完，因而原 receipt 的 completedDepth 等于请求地平线时，maxReachedPly 仍可能只有 1 或 2。例 `p2-s5-triangle-train-g0-t6` 的 required/completed depth 为 4，实际 maxReachedPly 为 1，只有 2 个访问节点。它是有效的提前解完棋树，不能宣称实际搜索了四步。

本审查要求 pilot 已完整接受且 `maxReachedPly >= requiredDepth`。271 个完整搜索中，66 个实际最大深度不足 3，另 33 个达到 3 但短于人数要求；这 99 个留在原 pilot，从新源清单排除。未完整的 85 个也未进入新源清单。没有降低深度、通过认输减少存活人数或将超时动作当标签。

| 人数 | 要求及实际达到的最大层数 | train | validation |
| --- | --- | --- | --- |
| 2 | 4 | 61 | 62 |
| 3 | 6 | 23 | 16 |
| 4 | 8 | 5 | 2 |
| 5 | 10 | 1 | 2 |
| 6 | 12 | 0 | 0 |

筛选只证明至少一个分支实际到达要求的动作地平线；其他分支可以原生提前终局。现有 receipt 没有逐席实际行动次数和主变，因此不另外证明每个非终局分支都经历每个对手两次实际行动。规范自动跳过保留原行为。

## 划分与集中度

172 个源局面来自 68 个独立游戏 episode。核对 metadata.episodeId 的整场 split，无跨 split 的同 episode；完整 state 重复为 0。额外剥除 historyHashes、positionRevision 和 turnCount 后，跨 split 的同盘面、逻辑边和行动方状态重复也为 0。全部源局面非终局，没有认输玩家。

所有源局面只有 1–4 个合法落点，另加 PASS。含 PASS 的根动作数为 2/3/4/5 的源局面分别为 56/47/34/35。143 个近期有己方节点被切，58 个近期有至少两次破坏性回复，99 个存在合法反切。这些是源局面属性，不能等同于模型已经学会防守或持续进攻。

| 人数 | 形状 | 边长 | train | validation |
| --- | --- | --- | --- | --- |
| 2 | triangle | 5 | 14 | 12 |
| 2 | triangle | 6 | 15 | 19 |
| 2 | triangle | 7 | 16 | 22 |
| 2 | triangle | 9 | 16 | 9 |
| 3 | triangle | 5 | 3 | 2 |
| 3 | triangle | 6 | 8 | 4 |
| 3 | triangle | 7 | 8 | 5 |
| 3 | triangle | 9 | 4 | 5 |
| 4 | hexagon | 6 | 1 | 0 |
| 4 | triangle | 6 | 2 | 1 |
| 4 | triangle | 7 | 2 | 1 |
| 5 | hexagon | 5 | 0 | 2 |
| 5 | triangle | 6 | 1 | 0 |

三人包含 three-v1 当前非 5/7/9 的 6 边路由。4 人只有 7 个源局面，5 人只有 3 个；原生六边形仅有 4 人 6 边 train 1 个、5 人 5 边 validation 2 个。4–5 人其余源是三角形。6 人的接受树全部提前终局，或搜索未完成，实际达到 12 层的源局面为 0，**本批不能声称有 6 人训练覆盖**。

这是一批迟盘、低分支、偏近期受切的应用训练源，没有开局、大分支或均匀棋局覆盖。hex parent 可以做有限的权重继续训练，但 4–6 人原生六边形的全面棋力结论缺少数据。完整对局、配对强度、实际运行延迟和产品准入仍须单独验证。

## 新工件及完整性

新源清单：`local_artifacts/defensive-warmstart-v2/data-review-r1/reviewed-positions-r1.json`。同目录 `review-exclusion-receipt.json` 保存其 SHA-256、每个排除原因、实际深度、原 pilot 收据路径和哈希，以及每个保留源的搜索证据。两者只新增一次，不覆盖原冻结工件。

- 原 source SHA-256：`7033954f84b8396e14a0cf4fcd83a33a05ef7d0f3074744873b4e3ab79498cf0`。
- pilot identity：`13f534d30261267587e907cf7a27e9404a65159bc9b49345ffa55edcf3bbbf50`。
- 原 pilot completion receipt SHA-256：`dfa8c1da1b2bae71b3280b02b23ae9980aa07c216e26ea2e4190ab55604a1534`。

正式标签必须由原 v1 数据编译器对新清单重新产生。pilot 搜索不冒充正式训练数据。
