# 三人 AI v3：本地继续训练完成，未晋级

v3 从冻结 v2 开始进行真实终局奖励 PPO 训练，已完成 216 局、3,418 个学习者动作样本及 36 次更新，并完成 342 局开发集选模。开发集选中第一阶段权重，即第 12 次更新的模型。后续阶段完成但没有被选用。

所有训练/开发动作、随机采样、终局离散面积、PPO/Adam 更新及选模结果已由独立验证器重算通过。随后两套新 FINAL 各完成 126 局真实终局、零截断，全部策略动作和汇总也已独立重放通过。

| 新 FINAL 比较对象 | 平均共享胜利分数增量 | 95% cluster bootstrap 区间 | 单 AI 增量 | 双 AI 增量 |
|---|---:|---:|---:|---:|
| 生产 v1 | -1.23 个百分点 | [-6.17, +3.70] 个百分点 | -1.54 个百分点 | -0.93 个百分点 |
| 训练父模型 v2 | -6.94 个百分点 | [-11.11, -2.78] 个百分点 | -9.26 个百分点 | -4.63 个百分点 |

**结果：`TRAINING-VERIFIED-NOT-PROMOTED`。** v3 没有通过预定生产晋级门，当前默认保持 v1。已完成训练不等于棋力提升；v3 保留为本地候选与可复现证据，没有启用为默认、部署或同步小程序。两套对照使用不同新种子，不能把它们的增量差当作共同开局下的 v1–v2 直接比较。

模型：`web/web前端/assets/research-ai/three-player-policy-v3.json`

SHA256：`1335fdaaedc227a8176696b720b2e93827fef4baed79790630c59fbe5a3e08b9`

父 v2 SHA256：`00fc241c500dfd01ff85b5e2a4f1907cc5a9d8307d68bb78be64b0aad129f56e`

保留生产 v1 SHA256：`8cd1a2f36267f96b1e32b7749a9cdc785f489ea7ec12e31aee0beb0a72901794`

## 可复核证据

- [固定协议和控制入口](verification/three-player-ai-v3/PROTOCOL.md)
- [最终交付收据](verification/three-player-ai-v3/delivery-receipt.json)
- [训练独立重算报告](verification/three-player-ai-v3/training-independent-verification.json)
- [对 v1 汇总](verification/three-player-ai-v3/final-vs-v1-summary.json)及[重放报告](verification/three-player-ai-v3/final-vs-v1-verification.json)
- [对 v2 汇总](verification/three-player-ai-v3/final-vs-v2-summary.json)及[重放报告](verification/three-player-ai-v3/final-vs-v2-verification.json)
- [实际中断恢复测试](verification/three-player-ai-v3/recovery-verification.json)

训练和两套评估均由独立监督进程执行，全部在首次尝试完成、退出码 0，无异常重启。训练约 418 秒，两套 FINAL 各约 185 秒。上述时间包含实际持久化开销，不能用来外推更大棋盘的成本。

复核命令（仓库根目录执行）：

```powershell
node --unhandled-rejections=strict web/web前端/tests/verify-three-player-v3-training.mjs
node --unhandled-rejections=strict web/tools/verify-three-player-v3-output.mjs --output local_artifacts/three-player-ai-posttrain-v3-20261021/training-independent-verification-rerun.json
node --unhandled-rejections=strict web/tools/verify-three-player-arena.mjs --run-root local_artifacts/three-player-v3-final-vs-v1-20261021
node --unhandled-rejections=strict web/tools/verify-three-player-arena.mjs --run-root local_artifacts/three-player-v3-final-vs-v2-20261021
```

独立训练验证器采用新输出文件，防止覆盖原报告。冻结模型内的“独立评估待完成”是训练冻结时的状态，最终评估结论由旁置交付收据补充，未回写冻结模型。样本数继承字段只记录来源，不计作本轮新增样本。本轮棋力评估仅覆盖尺寸 5 / 7 / 9，生产系统中人类对手表现也未由这些固定模型对局证明。
