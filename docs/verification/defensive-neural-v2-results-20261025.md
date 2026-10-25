# 17 神经模型独立核验结果（2026-10-25）

`neural-train-r2` 完成并通过独立产物核验：**17 个现有父模型各 100 次更新，共 1700 次耐久更新；17 份候选权重均已改变**。严格复核配置、训练源、完整数据、17 个父 F32、候选 F32、最终模型/Adam/RNG checkpoint 和 manifest 哈希闭包通过；导出有限、动作合法且概率归一化。所有候选继续保持 `strength_verified:false`、`runtime_admitted:false`。

仅使用 123 个双人三角形 territory-v3 局面：61 train、62 validation，边长 5/6/7/9，最多四个合法落点加 PASS。每条标签完整搜索和实际到达深度均至少四层。位置来自固定 seed 游戏的 crowded/tactical 前缀；同一游戏的多个位置相关。这些结果不覆盖其他人数、开局/高分支局面或其他边长。

## Heldout 完整教师对照

17 个模型的完整动作 CE 均下降；教师最优动作一致率 14 个上升、2 个持平、1 个下降。这里比较的是**原始策略 argmax 与完整防守教师根价值**，不是实际 PUCT 或完整对局。表中 CE 对父模型和候选均使用完整 PASS 动作空间，不能直接当作旧 legacy 网页入口的行为比较。

| 父模型 | CE 父 → 候选 | 教师最优动作一致率 | 最大 value 输出变化 | 当前 PASS 接口 |
| --- | ---: | ---: | ---: | --- |
| `padded-cnn-d14-s20260825-g200` | 1.0630 → 0.9805 | 75.81% → 75.81% | 0.211874 | 缺主动PASS契约 |
| `grid-gnn-d14-s20260825-g200` | 1.0692 → 0.9345 | 66.13% → 77.42% | 0.227774 | 缺主动PASS契约 |
| `topology-gnn-d14-s20260825-g200` | 1.0177 → 0.9359 | 67.74% → 72.58% | 0.144293 | 缺主动PASS契约 |
| `padded-cnn-transfer-v1-seed2026092201` | 1.2679 → 1.0206 | 69.35% → 72.58% | 0.803920 | 已有契约 |
| `padded-cnn-transfer-v1-seed2026092202` | 1.2380 → 1.0294 | 67.74% → 70.97% | 0.605254 | 已有契约 |
| `padded-cnn-transfer-v1-seed2026092203` | 1.1647 → 1.0165 | 72.58% → 74.19% | 0.549104 | 已有契约 |
| `grid-gnn-transfer-v1-seed2026092201` | 1.2431 → 1.0473 | 70.97% → 74.19% | 0.259779 | 已有契约 |
| `grid-gnn-transfer-v1-seed2026092202` | 1.2914 → 1.0506 | 64.52% → 72.58% | 0.166312 | 已有契约 |
| `grid-gnn-transfer-v1-seed2026092203` | 1.2211 → 1.0068 | 64.52% → 72.58% | 0.169638 | 已有契约 |
| `topology-gnn-transfer-v1-seed2026092201` | 1.1086 → 1.0168 | 72.58% → 72.58% | 0.368266 | 已有契约 |
| `topology-gnn-transfer-v1-seed2026092202` | 1.1672 → 1.0146 | 70.97% → 72.58% | 0.214895 | 已有契约 |
| `topology-gnn-transfer-v1-seed2026092203` | 1.1781 → 1.0360 | 70.97% → 69.35% | 0.371094 | 已有契约 |
| `dqn-all-sizes-e2000` | 1.0676 → 0.9972 | 70.97% → 77.42% | — | 已有契约 |
| `ppo-all-sizes-e2000` | 4.5845 → 2.9219 | 69.35% → 72.58% | — | 已有契约 |
| `sac-all-sizes-e2000` | 1.3107 → 1.1382 | 64.52% → 69.35% | — | 已有契约 |
| `gail-all-sizes` | 1.5980 → 1.1114 | 50.00% → 75.81% | — | 已有契约 |
| `gan-all-sizes` | 1.6109 → 1.1975 | 37.10% → 75.81% | — | 已有契约 |

有限教师向量中的平均己方节点损失：8 个模型改善、8 个持平、1 个恶化；重复破坏指标：6 个改善、9 个持平、2 个恶化。CE 下降不能等同于所有防守指标改善，更不能据此宣称棋力提高。

## 产品接入仍未通过

12 个图网络的 value 参数逐字节保持父值，但 value 输出均已改变。最大绝对变化为 **0.803920**（`padded-cnn-transfer-v1-seed2026092201`，62 个验证位置的平均绝对变化 0.337111）。共享主干更新会改变 value；当前 PUCT 使用该值，且本次没有真实终局校准证据。

三个 legacy 图网络候选继承的 manifest 未声明主动 PASS；现行网页在存在合法落点时会隐藏它。每个 legacy 候选的 62 个验证位置中，有 **13 个位置含正质量 PASS 目标**，按现行接口该完整目标无法表示；核验报告保留 `CE:null`，没有用一个虚假的有限数值掩盖缺口。其余 9 个 transfer 图网络与 5 个 MLP 已有相应动作接口。

本次没有运行这 17 个神经候选的完整对局 arena，也未进行浏览器/微信数值一致性、真机或产品准入验收。它们保持隔离，现有运行时模型未替换。下一步应分别验证 legacy PASS 接口、value 校准和实际 PUCT 表现，并用未参与训练/pilot 的新整场种子做同预算对战。

## 运行与证据

此前 `neural-train-r1` 因线性流水线原子重写字节相同的源 manifest，在 **0 次更新**时被输入签名 guard 正确拒绝。r1 保留，待线性流水线 COMPLETE 后使用稳定数据新建 r2；未放宽检查，也未重新训练已完成模型。

独立命令：

```text
C:/Users/zcz/anaconda3/envs/rl310/python.exe web/tools/verify-defensive-neural-candidates-v2.py --run-root local_artifacts/defensive-warmstart-v2/neural-train-r2 --data-root local_artifacts/defensive-warmstart-v2/neural-export-r1 --config web/tools/configs/defensive-neural-v2-20261025.json --output local_artifacts/defensive-warmstart-v2/neural-independent-review-r1/report.json
```

退出码 0。完整逐模型核验在本地 `local_artifacts/defensive-warmstart-v2/neural-independent-review-r1/report.json`；原始训练/候选证据保留在同一工作根下的 `neural-train-r2`。相邻 `defensive-neural-v2-results-20261025.json` 是可纳入版本控制的紧凑收据，包含全部来源、父/候选哈希和逐模型指标。
