# D1--D8 统一交付与验收清单

日期：2026-08-25

范围：`research/iclr2027` 下的双人、无 UI、边长 5--15 参考环境

## 总结

| 阶段 | 状态 | 已交付结果 | 证据边界 |
| --- | --- | --- | --- |
| D1 论文合同 | 完成 | 标题、研究问题、四项贡献、实验矩阵、论文目录 | 学习与泛化结论仍是待检验假设 |
| D2--D3 训练环境 | 完成 | 规则核心、固定序列化、动作掩码、终局奖励、完整状态复制/恢复 | Gymnasium 形状兼容，但未依赖第三方 `Space` 类 |
| D4--D5 环境验证 | 完成（冻结双人范围） | 冻结 D1--D8 核心测试 62/62、65 条 Python/Web 轨迹、攻击/断联断言、速度报告 | 扩展树快照另为 81 通过+7 可选依赖跳过；Python/Web 仅是差分验证 |
| D6 状态混淆 | 严格配对正假设未证成；n=6 自然触发已找到 | 三对弱配对、n=5 完整负结果、n=6 自然见证、n=6/n=7 规范规则消融 | **没有**双自然历史严格别名；单策略内部门限通过不等于规则等价 |
| D7--D8 搜索与竞技场 | 完成（工程门） | Random、Greedy、Minimax-2/3、UCT-MCTS、统一工厂、换色竞技场、全配对矩阵 | 30 局是冒烟，不是论文强度排名 |

## D1：冻结论文合同

- `D1_research_contract.md`：标题、RQ1--RQ4、四项有边界的贡献、失败规则与 D6 证据修订。
- `experiment_matrix.csv`：环境、诊断、搜索、神经自博弈、泛化与消融的机器可读矩阵。
- `paper/main.tex`、`paper/references.bib`：可编译论文骨架；未完成实验仍保留显式 `TBD`。
- `D1_D3_audit.md`：D1--D3 的交付映射。

D6 修订没有偷偷改换研究目标，而是执行 D1 已冻结的 falsification rule：若完整搜索只发现行为冗余的边差异，就删除“Grid 非马尔可夫”的强主张。

## D2--D3：无 UI 训练环境

核心实现位于 `lifeline_rl/`：

- `core.py`：独立规则状态机、玩家逻辑边、攻击与级联删除、PASS、Superko、终局领土和零和奖励；
- `env.py`：固定动作编号、最终 PASS 动作、合法动作掩码、Gymnasium 形状的 `reset/step`；
- `encoding.py`：Grid、GridGraph、Topology、TopologyHistory 四种观测；
- `GameSnapshot`：完整复制/恢复，包括 Superko 历史；
- 默认 `superko_mode="enforce"` 保持 schema v1、严格反序列化、规范 JSON 和 SHA-256
  状态指纹；消融用 `observe` 模式采用 schema v2 并显式记录模式。

环境与序列化合同见 `ENVIRONMENT.md` 和 `D2_environment_status.md`。

## D4--D5：环境验证

完整报告为 `D4_D5_validation_report.md`。关键证据：

- 冻结 D1--D8 核心套件 62/62 通过；`2026-08-25 23:48:20 +08:00` 从
  `research/iclr2027` 执行 `python -B -m unittest discover -s . -t . -v` 的扩展树快照为
  88 项：81 通过、7 项因未安装可选 `torch` 而跳过，跳过不计失败；
- 5 条确定性规则轨迹加 60 条随机轨迹与 Web 引擎逐步一致；
- 攻击 `(2,2)` 精确删除三个断联点，并恢复唯一存活边；
- 攻击 `(1,1)` 只切断一条逻辑边，不误删端点；
- 合成历史测试覆盖拒绝与事务回滚分支；另有标准 n=6 初态自然可达的 Superko
  重放见证覆盖真实触发路径；
- n=5 完整原始图有 25,096 状态、67,505 转移，全部进入拓扑序，自然 Superko 为 0；
- 六种尺寸的三重复端到端吞吐中位数从 n=5 的 1,573.92 transitions/s 降至 n=15 的 19.26 transitions/s。

机器可读结果位于 `results/validation/`。n=5 Superko 结论是完整证明范围内的计算证书；它不适用于 n=6--15。

## D6：严格反例假设的真实结果

原交付要求是“两类严格反例”。真实搜索和完整求解不支持这个正结论，因此不能把字面要求打勾。

已交付：

- `D6_state_aliasing.md`：定义、四个命题、搜索预算、PASS 审计修正和论文可用措辞；
- `state_aliasing/pairs_v1.json`：两个弱拓扑对和一个弱历史对的完整动作历史、观测摘要、状态指纹和期望差异；
- `state_aliasing/search_report_v1.json`：精确与有界搜索统计；
- `state_aliasing/superko_n6_witness_v1.json`：标准 6×6 初态的自然 Superko 拒绝、
  六步闭环和严格声明边界；
- `results/validation/d6_random_n5_final.json`、`d6_random_n6_final.json`：最终 mask-aware、含 PASS 分类器的 n=5（10,000 局）与 n=6（5,000 局）固定预算输出；
- `scripts/run_superko_ablation.py` 和
  `results/validation/superko_ablation_n6_n7_canonical_pilot_20260825.json`：
  schema-v2 规范 keyed-priority 耦合的 `enforce`/`observe` 公共随机数配对消融，
  n=6/n=7 各 2,000 对局；
- `SUPERKO_ABLATION_PROTOCOL.md`、`SUPERKO_ABLATION_RESULTS.md`：内部固定门限、
  耦合审计修正、规范结果和论文声明边界；
- `scripts/search_state_aliasing.py`：随机碰撞、n=5 精确审计入口和配对续局搜索；
- `tests/test_d6_aliasing.py`：9 项数据集重放、搜索键语义与证书一致性测试；
- `tests/test_superko_ablation.py`：6 项自然见证、事务回滚、闭环、诊断和序列化测试；
- `d6_redteam_audit.md`、`scripts/d6_redteam_exact_audit.py` 和 `d6_redteam_exact_audit.json`：独立红队证书。

形式化结果：

1. 自然可达状态可以有完全相同的已实现 Grid 观测而逻辑边不同；这证明弱全状态混淆。
2. 自然可达状态可以有完全相同的 Topology 观测而 Superko 历史不同；这同样是弱混淆。
3. 在完整 n=5 图中，976 个 Grid 混淆组包含 1,088 对不同拓扑状态；合法动作、下一 Grid 观测、精确价值、共享动作 Q 值和最优动作集合的差异数全部为 0。
4. n=5 没有自然 Superko，故严格历史/Superko 反例也不存在。
5. 旧 n=6 的 5,000 局轨迹采样器不主动选择 PASS；它与 5,000 pair-state 共享续局
   搜索均未找到严格配对见证，后者前沿未清空，只能标记 `NOT_FOUND_WITHIN_BUDGET`。
6. 采用自愿 PASS 的定向搜索在第 489 局找到标准 n=6 初态自然见证：
   `B(0,1), W(4,0), B(2,0), W(1,4), B(2,3), W(2,2), B(3,1), W(1,4),`
   `B PASS, W(1,1)` 后，`B(2,3)` 因 `SUPERKO_VIOLATION` 被拒绝。关闭执行规则后，
   对应六步环可重复。
7. 上述见证只有一条自然历史加反事实消融，不是“两条自然历史到同一 Topology、历史不同、
   同一动作合法性不同”的严格配对别名。
8. 规范耦合消融在 n=6 为 0/2,000 触发、0 分歧、0 截断，B/W/D 为
   1,020/948/32，零触发 Wilson 95% 上界 0.1917%。n=7 为 2/2,000 触发
   （95% CI 0.0274%--0.3639%），`observe` 在 1 局选择 2 个重复动作，造成
   1/2,000 轨迹分歧；两模式 2,000/2,000 胜者一致，B/W/D 都为 1,043/934/23，
   且无截断。n=7 平均局长为 24.5780/24.5755，相对差 -0.01017%，paired-bootstrap
   95% CI 为 [-0.03076%, 0]；两尺寸非零黑方得分差均为 0/2,000，其 Wilson 上界
   0.1917%。内部固定门限在该 policy/尺寸/horizon 下通过。
9. 规范方法是在查看早期探索输出后修订并复用 seed，且只覆盖一个手工攻击+PASS 策略。
   因此它支持“采样策略下经验相近”的工程结论，不支持规则等价、删除 Superko、
   训练策略无影响或运行成本等价。

红队还发现旧精确求解漏掉 2,080 个从零次跳过开始却直接终局的 PASS 分支，影响 294 个状态价值和 1,272 个最优动作集合。修正后的独立求解仍得到严格反例 0；论文只能引用修正版。

## D7--D8：搜索基线与自动竞技场

实现：

- `lifeline_rl/agents/random_agent.py`：均匀随机合法动作，包含 PASS；
- `greedy.py`、`heuristic.py`：确定性一步启发式；
- `minimax.py`：深度 2/3、Alpha-Beta、每层 top-20 点动作并保留 PASS；
- `mcts.py`：对抗式 UCT-MCTS、完整状态恢复和随机 rollout；
- `factory.py`：五类稳定 CLI 名称；
- `arena.py`、`scripts/run_arena.py`：严格换色、独立策略种子、截断单列、JSONL/CSV/summary；
- `scripts/run_baseline_matrix.py`：五类 Agent 的 15 个无序含对角配对；
- `scripts/verify_arena_results.py`：独立重放与汇总校验。

工程矩阵位于
`results/smoke/baseline_matrix/20260825T123419.575786Z_all_baselines_n5_g2_seed20260825/`：15/15 配对、30/30 局完成、0 截断、30/30 可重放。MCTS 仅用 4 simulations / rollout depth 8，每格仅 2 局；任何胜率排序都不是论文结论。

## 一组可复制的验收命令

从仓库根目录运行：

```powershell
Push-Location .\research\iclr2027
python -B -m unittest discover -s . -t . -v
Pop-Location
```

```powershell
python -B .\research\iclr2027\scripts\check_reference_parity.py --random-games 60 --max-plies 120 --seed 20260825
```

```powershell
python -B .\research\iclr2027\scripts\validate_or_search_superko.py --mode exhaustive --grid-size 5
```

```powershell
python -B .\research\iclr2027\scripts\d6_redteam_exact_audit.py --output .\research\iclr2027\d6_redteam_exact_audit.json
```

```powershell
$env:PYTHONPATH="$PWD\research\iclr2027"; python -B -m unittest tests.test_d6_aliasing -v
```

```powershell
$matrix = '.\research\iclr2027\results\smoke\baseline_matrix\20260825T123419.575786Z_all_baselines_n5_g2_seed20260825'; Get-ChildItem -Directory $matrix | ForEach-Object { python -B .\research\iclr2027\scripts\verify_arena_results.py $_.FullName }
```

LaTeX 骨架从 `research/iclr2027/paper` 双遍运行：

```powershell
pdflatex -interaction=nonstopmode -halt-on-error main.tex
pdflatex -interaction=nonstopmode -halt-on-error main.tex
```

## 下一科学门，而非本轮欠交工程

- 在 n=6--15 找到双自然历史的可重放严格配对见证，或只在可承受尺寸上给出新的完整负证书；
- 用全新独立种子、多个随机/搜索策略及冻结学习策略复验 Superko `enforce`/`observe`
  配对消融；另做循环寻优正对照和见证前缀条件评估；
- 冻结正式 MCTS 预算并运行每个主配对至少 200 局；
- 实现共同 AlphaZero 风格训练管线与 GridGraph/Topology 参数匹配模型；
- 执行五种子训练、跨尺寸评估和预注册消融。

这些属于 D9 之后的训练与论文结果阶段。当前 D1--D8 的工程门已完成；唯一未实现的字面
正交付是 D6 的“两类严格配对反例”：n=5 完整证据明确否定它，n=6 虽已确认自然
Superko 可触发、n=7 规范 pilot 也采样到触发，但仍没有双自然历史配对见证，n=6
以上的严格配对负搜索也都不是不存在性证明。

## 2026-08-26 后续状态

D9--D10 的共同 AlphaZero 工程框架、GridGraph/Topology 参数匹配网络、PUCT、经验池、策略价值训练、完整 checkpoint 和严格恢复已实现并通过真实冒烟。证据与限制见 `D9_D10_alphazero_framework.md`。五种子正式训练、200 局竞技场、跨尺寸评估和论文结论仍未开始。
