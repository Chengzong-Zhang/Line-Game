# D9--D10 AlphaZero 训练框架交付

日期：2026-08-26

状态：**工程框架与断点恢复已验证；正式多种子训练、竞技场晋升和论文结果尚未开始**

> 2026-08-28 追记：本文件保留 2026-08-26 的 D9--D10 工程快照与当时状态，
> 不事后改写 smoke 证据。其后 D11--D13 已完成，D14--D16 的五种子正式训练、
> 评估与聚合也已完成；当前结果见 `D11_D13_DELIVERY.md` 和
> `D14_D16_RESULTS.md`。第 6 节“尚未完成”与末尾“下一工程门”应按历史快照
> 阅读；candidate/champion、opponent pool、多 actor、n=10/12 与消融仍未完成。

## 1. 交付边界

本阶段实现同一套可用于 `GridGraph` 与 `Topology` 的 AlphaZero 风格训练流水线：

```text
exact LifelineGame
  -> PUCT + policy/value evaluator
  -> complete self-play action log
  -> bounded replay buffer
  -> masked policy loss + terminal value loss
  -> atomic checkpoint + strict resume
```

这不是 AZ-GRID/AZ-TOPO 的论文级结果。当前真实运行仅为边长 5、4 次 PUCT
simulation、单局、单梯度步的工程冒烟；不能据此声称学习效果、表示优势或泛化能力。

## 2. 实现

### 2.1 PUCT

`lifeline_rl/alphazero/puct.py` 使用固定整数动作空间，点动作位于
`[0, n(n+1)/2)`，PASS 始终为最后一个动作。每个节点按实际行动玩家选择

```text
Q(s,a) + c_puct * P(s,a) * sqrt(N(s)) / (1 + N(s,a)).
```

先验先应用精确合法动作 mask，再归一化；合法质量为零时退回均匀合法先验。训练自博弈可启用只作用于合法根边（包含 PASS）的 Dirichlet 噪声，评估时可关闭。

价值备份保存 BLACK/WHITE 的绝对 payoff，而不是按树深机械翻号。原因是规则的自动跳过可能使一次 transition 后仍由同一玩家行动。每次 simulation 都从含逻辑边、PASS 计数和完整 Superko 历史的 `GameSnapshot` 恢复，不做不安全的 observation-only transposition 合并。

### 2.2 经验池与自博弈

`replay.py` 的每条 `Experience` 保存：

- 棋盘尺寸、表示模式、物理边和双方逻辑边；
- 实际 `current_player`、连续 PASS 数、合法动作 mask；
- 完整根访问计数、终局目标 `z`、完整状态 SHA-256；
- game/seed/ply/action/Superko 等 provenance。

经验池是固定容量 FIFO，整局完成后才一次性提交；截断局保留动作日志但不进入训练。`z` 由

```text
game.rewards()[Player(sample.current_player)]
```

回填，绝不按 ply 奇偶推导。经验池 checkpoint 保留 FIFO 顺序、`total_added` 和独立采样 RNG。

`self_play.py` 记录每个 ply 的 actor、整数动作、点坐标、温度、状态指纹、mask、root visits、root policy、root priors 和 simulation 数。训练器的 game/iteration JSONL 以稳定键去重；从上一个安全检查点确定性重放时不会重复写相同记录，内容不一致则立即失败。

### 2.3 参数匹配策略价值网络

`network.py` 使用纯 PyTorch 密集关系消息传递，不依赖 PyG。每个位置按当前玩家视角规范化为 11 维点特征。三个固定关系槽为：

1. 物理三角格邻接；
2. 当前玩家逻辑边；
3. 对手逻辑边。

`GridGraph` 将后两个关系槽置零，`Topology` 填入真实逻辑边；两者使用完全相同的层、参数和训练器，因此参数量严格相等。网络输出逐点 logits、独立 PASS logit 和 `tanh` 标量 value。混合尺寸 batch 显式 padding 点和动作，并把每个尺寸自己的 PASS 重定位到 batch 最后一列；padding/非法动作不参与 softmax 或 policy loss。

损失为

```text
L = cross_entropy(root_visit_policy, masked_policy_logits)
    + mse(terminal_outcome, value).
```

优化器为 AdamW，包含有限值检查和梯度范数裁剪；没有 shaped reward。

### 2.4 检查点与恢复

`checkpoint.py` 的 schema v1 保存：

- model、optimizer、可选 scheduler 和 scaler；
- 完整经验池；
- iteration/game/environment-step/gradient-step/examples-seen 等计数；
- trainer 局部 RNG、Python/NumPy/Torch CPU 及已初始化 CUDA RNG；
- canonical resume-critical config/hash、训练源码树 hash 和元数据。

检查点只在“完整对局之间、optimizer step 之后”的安全点生成。不保存半局或半次 PUCT。文件先在同目录临时写入并 `fsync`，再用 `os.replace` 原子替换；`latest.json` 保存文件名、字节数和 SHA-256。加载在修改模型前验证 manifest、摘要、schema、配置和源码；源码迁移只能显式使用 `--allow-source-mismatch`。

checkpoint 使用 `torch.load(..., weights_only=False)` 以恢复 Python/NumPy/RNG 与经验池状态，因此只应加载可信的本地产物。

另外修复了核心序列化遗漏：非默认 WHITE 开局现在使用游戏状态 schema v3 保存 `start_player`，同时保持默认 BLACK/enforce 的 schema-v1 指纹字节不变。

## 3. 文件

```text
lifeline_rl/alphazero/
  __init__.py
  config.py
  puct.py
  replay.py
  self_play.py
  network.py
  trainer.py
  checkpoint.py
scripts/
  train_alphazero.py
  verify_alphazero_run.py
configs/
  alphazero_d9_d10.json
  alphazero_d9_d10_smoke.json
  alphazero_d9_d10_topology_smoke.json
  seed_registry.json
tests/
  test_alphazero_puct.py
  test_alphazero_replay.py
  test_alphazero_self_play.py
  test_alphazero_network.py
  test_alphazero_checkpoint.py
  test_alphazero_trainer.py
```

PyTorch 位于 `pyproject.toml` 的 `train` optional extra。核心 `lifeline_rl`、PUCT、经验池和自博弈仍可在无第三方依赖环境导入和测试。

## 4. 可复制命令

以下命令均从仓库根目录运行。当前机器已验证的训练解释器为 `rl310`：

```powershell
$py = 'C:\Users\zcz\anaconda3\envs\rl310\python.exe'
```

只校验配置、网络参数量和源码 hash，不写产物：

```powershell
& $py -B .\research\iclr2027\scripts\train_alphazero.py --config .\research\iclr2027\configs\alphazero_d9_d10_smoke.json --smoke --dry-run --device cpu
```

从零冒烟：

```powershell
& $py -B .\research\iclr2027\scripts\train_alphazero.py --config .\research\iclr2027\configs\alphazero_d9_d10_smoke.json --smoke --output-dir .\research\iclr2027\results\smoke\alphazero\my_gridgraph_smoke --device cpu
```

从最新检查点继续一轮：

```powershell
& $py -B .\research\iclr2027\scripts\train_alphazero.py --config .\research\iclr2027\configs\alphazero_d9_d10_smoke.json --smoke --resume .\research\iclr2027\results\smoke\alphazero\my_gridgraph_smoke\checkpoints --additional-iterations 1 --device cpu
```

独立重放动作日志并核对经验池、计数和最新 checkpoint：

```powershell
& $py -B .\research\iclr2027\scripts\verify_alphazero_run.py .\research\iclr2027\results\smoke\alphazero\my_gridgraph_smoke --device cpu
```

完整 AlphaZero 测试：

```powershell
$env:PYTHONPATH="$PWD\research\iclr2027"; & $py -B -m unittest discover -s .\research\iclr2027\tests -t .\research\iclr2027 -p 'test_alphazero*.py' -v
```

## 5. 真实验证证据

### GridGraph 从零加严格恢复

产物：`results/smoke/alphazero/d9_d10_gridgraph_smoke_verified_seed20260825/`

| 指标 | 从零第 1 轮 | 恢复后第 2 轮累计 |
| --- | ---: | ---: |
| 完成/截断对局 | 1 / 0 | 2 / 0 |
| environment steps | 8 | 18 |
| replay size / total added | 8 / 8 | 18 / 18 |
| gradient steps | 1 | 2 |
| examples seen | 2 | 4 |
| total loss | 3.434574 | 3.025705 |

最终 `checkpoint_000002.pt`：

- 大小：98,961 bytes；
- checkpoint SHA-256：`e3dfd3f8f57557b9941e2338bb12fab74cd7e8713b36398ed63be12620587212`；
- resume-critical config hash：`8c707b91704aae8201b27cde3ae35bdd6c496254da9637a73190456f865d2994`；
- source hash：`90fffac7a50fdcf25b5d2fcd2bcb8e109d176fa261ef6766715f87e2b95124df`。

独立 verifier 重放 2/2 局、18/18 actions，并确认 checkpoint iteration 2、gradient steps 2、buffer 18/18。

### Topology 共同管线

产物：`results/smoke/alphazero/d9_d10_topology_smoke_verified_seed20260825/`

Topology 冒烟完成 1 局、8 steps、8 条经验和 1 次梯度更新；独立 verifier 通过。GridGraph 与 Topology 的 smoke 网络参数量均为 **2,131**，测试还直接断言两种表示只改变关系张量而不改变参数量。

### 测试

- 默认无 Torch 环境：102 tests 全部收集成功，94 pass、8 个 Torch-only 测试按预期 skip；
- `rl310` AlphaZero 专项：30/30 pass；
- `rl310` 全仓集成：102/102 pass；
- `test_next_update_is_identical_after_full_checkpoint_resume` 验证连续训练的下一次采样、loss、计数和逐参数张量，与保存后恢复的下一步完全相同（CPU）。

## 6. 尚未完成

- 未运行五种子正式 AZ-GRID/AZ-TOPO；`seed_registry.json` 仅冻结未来种子，不表示已运行；
- 未冻结论文级 PUCT/self-play/optimizer 预算；当前 `alphazero_d9_d10.json` 是工程起点；
- 未实现 candidate/champion 竞技场晋升和 opponent pool；
- 未实现多进程 actor、批量叶评估或树复用；
- 未运行 n=10/12 零样本评估、规则消融或 200 局换色竞技场；
- `TopologyHistory` 尚未接入神经网络，历史特征协议仍需单独冻结；
- 没有任何学习优势、样本效率或泛化结论可写入论文结果。

下一工程门是 D11：冻结 candidate/champion 竞技场晋升协议和正式预算，在正式训练前提交/冻结当前仍未被 Git 跟踪的 `research/` 源码。
