# 六角盘 AI v2 训练结果：训练完成，最终验收预算不足

**状态：LIMIT_BUDGET；候选不晋级，网页默认继续保留 hex-player-policy-v1。** 本次未修改运行时加载器，也未将此候选同步服务器。

新候选完成了 45 局真实终局训练和 36 次 PPO/Adam 更新；105 局开发对局选择第三阶段。训练与开发共 150 局全部自然终局，独立脚本完整重放 16258 个动作、15658 次策略决策，复算优化状态和模型输出，退出码 0。开发集共享胜场平均差为 +3 个百分点，仅用于选择候选，不作为最终提升结论。

| 阶段 | 完成情况 | 核验范围 |
| --- | --- | --- |
| 新训练 | 45/45 局，全部自然终局；只在 5 阶新增训练 | 完整策略/RNG/终局/优化器复算通过 |
| 开发选择 | 105/105 局，全部自然终局；选择阶段 3 | 选择结果与导出哈希通过 |
| 独立 FINAL | 77/90 局完成，77 局终局，0 局截断 | 原 1800 秒硬限停止 |
| FINAL 剩余 | 1 局在途，12 局尚未开始 | 在途 61 步已保存 |
| 9 阶兼容 | 15 个初始局面检查通过 | 仅合法动作/有限值/状态保持，不是完整对局或棋力证明 |

FINAL 的 5 阶完成 45/45 局，7 阶完成 32/45 局。整体硬限后，监督器状态为 BUDGET_EXHAUSTED，最后 worker 的原始 exit_code 为 null、signal 为 SIGKILL、cancelled 为 BUDGET_EXHAUSTED；监督器、host、worker 均已退出。没有重新授予预算。

在途对局为 `final-n7-p6-WHITE-s1-multi`，已保存 61 步。已完成的终局没有重新运行，检查点与完整历史均保留在本地。

停止后的小审计受独立监督，硬限 120 秒，退出码 0；核对了 21944 个动作的合法性、完整历史/Superko、随机前缀及新鲜终局离散面积。**FINAL 的策略评分没有重新计算：重算 0 次，未重算 21632 次。** 该状态为 PASS_LEGALITY_AREA_BOUNDARY_ONLY，不是完整 FINAL 策略核验通过。

因此不报告总体 FINAL delta 或 95% 置信区间（均为 null），不作棋力提升声明。候选 SHA256：`8cce4228dd835112e62db8fc397f86284380880fd21c62305f8f4aaa523bd910`。

可机器读取的精确数量、原始退出信息、完整核验命令与退出码见 [delivery-receipt.json](delivery-receipt.json)。冻结方案见 [PROTOCOL.md](PROTOCOL.md)，边界审计说明见 [BOUNDARY_AUDIT.md](BOUNDARY_AUDIT.md)，候选权重见 [hex-player-policy-v2.candidate.json](hex-player-policy-v2.candidate.json)。原始对局和检查点不进入普通 Git 历史。
