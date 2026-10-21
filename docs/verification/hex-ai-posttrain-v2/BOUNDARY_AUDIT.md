# 整体预算耗尽时的边界核验

此补充不修改冻结的训练、开发或 FINAL 协议，也不增加原 FINAL 的 1,800 秒预算，不调整样本、候选或晋级阈值。

如果 FINAL 在完整完成前因整体预算停止，仅使用 `web/tools/verify-hex-posttraining-boundary.mjs` 做一个独立、只读、受监督的小审计。该审计 job 硬限 120 秒，worker 每次约 30 秒让出；它不会继续评估未完成的对局。

审计校验源代码/配置/模型身份、完成前缀及在途记录、完整动作历史的合法性和 Superko、固定随机前缀、以及已终局对局的新鲜离散 `area`。已提交对局不重新生成，未提交临时写入不作为结果。存在已写入但尚未进入索引的完成收据时单独列出。

该小审计**不重新计算 AI 策略评分或核对每步是否为模型最高分动作**。报告明确给出 `policyDecisionsRecomputed: 0` 与 `policyDecisionsNotRecomputed`，状态为 `PASS_LEGALITY_AREA_BOUNDARY_ONLY`。这个状态只表示所列边界检查通过，不是完整 FINAL、完整策略核验或棋力提升通过。

只要完整 FINAL 条件或所需独立核验未完成，`promote` 为 false，整体提升 `meanDelta` 和置信区间 `bootstrap95` 均为 null，网页继续使用 v1。训练阶段已经通过的 150 局完整策略重放、PPO/Adam 复算与模型身份核验，作为独立证据保留。

隔离 fixture 验证见 `BOUNDARY_AUDIT_RECOVERY.json`。另一个 `verify-hex-posttraining-partial.mjs` 能重算已完成前缀的全部策略评分，但在本轮整体 FINAL 预算耗尽后不会启动这个较长的核验；本轮只允许上述 120 秒边界审计。
