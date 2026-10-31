# 七条既有候选的全新确认结果

状态：`COMPLETE_VERIFIED_NOT_PROMOTED`。420/420 自然终局，无截断；全部 10,030 动作历史与终局面积核验通过，840 个首/中神经策略决定复算通过。固定七项家族中没有模型达到预先指定的全部晋级条件。

| 父模型路线 | 胜/平/负 | 均分 | 5/7/9 各尺寸均分 |
|---|---:|---:|---|
| CNN transfer seed 2026092203 | 32/4/24 | 56.67% | 40% / 70% / 60% |
| Grid-GNN seed 2026092201 | 26/6/28 | 48.33% | 57.5% / 37.5% / 50% |
| Grid-GNN seed 2026092202 | 34/1/25 | 57.50% | 57.5% / 55% / 60% |
| Grid-GNN seed 2026092203 | 26/3/31 | 45.83% | 55% / 40% / 42.5% |
| DQN | 27/1/32 | 45.83% | 50% / 37.5% / 50% |
| SAC | 25/0/35 | 41.67% | 35% / 60% / 30% |
| GAIL | 28/2/30 | 48.33% | 25% / 57.5% / 62.5% |

CNN 的五路表现低于预定 45% 下限；Grid-GNN seed 2026092202 通过均分与各尺寸下限，但非零配对开局只有 9 正 / 5 负（另外 16 簇打平），不足以通过固定七项 Holm 检验。全部调整后 p 值为 1。不能把“未确认提升”表述为每个候选都已证明变弱。

符号检验的联合零假设按预先固定的尺寸与先行方层解释：各层独立非零簇符号的正概率不超过 1/2；不是平均得分检验。共享开局中的两次换色属于同一簇。原 12 局探索结果没有与这 60 局合并。

## 评估器实现错误的版本化更正

原冻结统计器 `assess-neural-confirmation.mjs`（SHA-256 `72c0e61249e80788dbe216ff299ad5dda48a279291d1f76ef2d173e4ef8621a0`）在合法回放中报 `Unexpected voluntary PASS`。它额外要求只要还有合法落点就不能跳过，但冻结 Research 模型的 `action_contract.pass` 明确为 `always legal in nonterminal Web state; maps to skipTurn`，网页 PUCT 本来就可以选择 PASS。

原源文件保持不动。新增 `assess-neural-confirmation-v2.mjs` 只移除这个不属于协议和游戏规则的强制落点断言，保留 `skipTurn().success`、全部来源/历史/面积核验和原数值晋级门。模型、对局、种子、阈值、检验家族均未改动。v2 数学及完整性测试通过；另对真实 420 局中的 **591 次有合法落点时的主动 PASS** 全部复算冻结 PUCT 策略，动作契约、实际策略和规则合法性均通过。更正后仍为零晋级，不把校验程序错误当作改变门槛的理由。

源与收据：`neural-confirmation-delivery.json`、`neural-confirmation-assessment-v2.json`、`neural-confirmation-assessment-v2-tests.json`、`neural-voluntary-pass-regression.json`。上游原 arena summary 的 `promotionPass:false` 保持原样，独立统计结论另存。

## 后续动作

本次只确认既有后训练权重，没有新增训练更新。当前网页默认保留。依据本轮诊断，在新协议下固定 CNN seed 2026092203 与 Grid-GNN seed 2026092202 两条路线，改用终局 rollout 教师与策略头保守微调；新训练、开发、FINAL 全部分开，见 `NEURAL_HEADONLY_R3_PROTOCOL.md`。不能把本轮 420 局重新用于新候选的未见最终评估。
