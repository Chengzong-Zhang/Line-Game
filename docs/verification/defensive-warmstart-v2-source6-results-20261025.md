# 六人专项继续训练：完成与独立核对

独立监督的 `application-source6-r1` 已完成 **210/210 单元**：6 个正式防守标签、两个原产品线性 parent 各 100 次参数更新，以及两个候选各 2 个 heldout 局面对照。27 个 worker 分段全部正常退出，没有异常恢复或无进展重试。未修改冻结 teacher、旧数据和原产品权重。

正式数据使用 6 个非终局、无认输的完整历史状态，来自 5 个独立 episode：4 个 triangle/7 train、2 个 hexagon/5 validation。6/6 标签的 requested、required、completed 和实际 maxReachedPly 都为 12，全部根动作精确且包括 PASS。最慢标签耗时 3531 毫秒；没有降深度或将超时动作当标签。

87 个 fresh 补充源完成 pilot 后有 26 个完整树、61 个预算拒绝；完整树中仅 5 个实际到达 12 层，其余 21 个提前终局而排除。5 个 fresh 源含 train 4、validation 1，另加入一个独立保存的原 validation 重试源，组成上述 6 个正式源。没有运行后续 20 秒重试。联合主批 172 源核对得到 178 个互异完整状态，无 ID 重复、整场 episode 跨 split 或剥除 history/revision/turn 后的同盘面跨 split。

| 原 parent | 参数更新 | train CE：原值 → 继续训练后 | 2 个 heldout CE：原值 → 继续训练后 |
| --- | --- | --- | --- |
| multiplayer-easy-v1 | 100 | 2.129894 → 1.624445 | 0.463247 → 0.351245 |
| hex-player-policy-v1 | 100 | 1.934157 → 1.463759 | 0.818536 → 0.546225 |

两份候选均从各自原产品 16 维权重除以原温度开始，并追加新 PASS 系数 0，未继承主批 172 源候选。完成后各有 16 个系数变化，PASS 系数分别为 0.735325 和 0.716356。独立核对了原 parent 及 candidate 哈希、检查点和完成收据，重新计算 dot-product、softmax、CE 及 teacher 一致率，与保存的聚合结果相差不超过 1e-12。

两个 parent 和各自候选在这两个 validation 局面均为 2/2 teacher 最优动作一致；本次 CE 改善只表示概率分配更贴合这两个有限 teacher 标签，不能称实际动作或棋力已经提高。train 为三角形、validation 为六边形，样本少且配置不同，没有匹配的原生六边形训练/验证强度结论。

完整数值、来源哈希、检查项及候选身份在同目录 `defensive-warmstart-v2-source6-results-20261025.json`。本独立复核没有重跑 teacher 搜索或完整对局。12 层为实际达到的最大动作层数，允许其他分支原生提前终局和规范自动跳过；没有逐对手两次实际行动的额外轨迹证明。

候选、heldout 报告继续标记 `strength_verified:false`、`runtime_admitted:false`。未自动安装到产品、上传或公开发布。该批是独立的六人专项变体，与主批继续训练候选分别保存。
