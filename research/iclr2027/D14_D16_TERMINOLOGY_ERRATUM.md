# D14--D16 术语勘误

日期：2026-08-31

状态：**append-only clarification；不修改冻结协议、receipt、聚合数值或正式结论**

## 1. 适用范围

本文件勘误 `D14_D16_RESULTS.md`、冻结 manifest/协议和历史 claim ledger 中两类
容易被误读的术语。原始正式证据保持逐字节不变；当前论文、匿名 supplement、
后续 handoff 和 review 应引用本文件及
`paper/CLAIM_EVIDENCE_LIMITATION_V3.md` 中的收窄表述。

## 2. `30,600 unique games` 的收窄

正式 ledger 含 30,600 条以 `(task_id, game_index)` 标识、receipt-bound、
replay-verified 的评估记录。这里的“唯一”只表示任务索引记录不重复，**不表示**
30,600 条不同动作轨迹，也不表示 30,600 个统计独立样本。

D16 的每个 200-game task 只有两条 color-conditioned deterministic action
trajectories。因此当前权威短语是：

> 30,600 task-indexed replay-verified game records

四张聚合 CSV 按行相加为 39,600，是因为 step-200 对 UCT-MCTS-16 的 9,000 条
记录同时出现在 `arena_learning_curve.csv` 和 `final_vs_search.csv` 两个视图中；
它们不能重复计为新的正式对局。

## 3. `compute-matched UCT-MCTS-16` 的收窄

训练/评估 PUCT 与冻结 UCT-MCTS-16 都使用名义 16 次 simulations，但这只支持
`simulation-count-matched`。它不表示 FLOPs、wall time、rollout transitions、
expanded nodes、memory 或硬件成本匹配。

UCT-MCTS-16 的冻结配置是：16 simulations、exploration constant
`sqrt(2)`、uniform-random rollout、rollout depth 80。当前论文必须保留完整配置和
上述 compute 限制。

## 4. 不变的正式边界

- D14--D16 的 15/15 training、315/315 evaluation、330/330 receipts、
  1,500 self-play games、3,000 gradient updates 和 30,600 task-indexed records
  不变。
- `formal_ready=true` 只表示 D14--D16 artifact completeness，不表示模型优越性。
- pooled Wilson intervals 仍是描述性汇总，不获得 independent-game coverage。
- 本勘误不接纳 D17、D18、D19 或任何未通过 gate 的结果。

## 5. 验证入口

从仓库根目录运行：

```powershell
python -B .\research\iclr2027\reviews\independent_receipt_audit.py --compare-canonical
```

验证必须继续要求 receipt/task 完整、哈希一致、重放通过和聚合逐行一致；本勘误
不能替代 verifier 输出。
