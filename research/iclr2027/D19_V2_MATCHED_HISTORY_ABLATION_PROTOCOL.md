# D19-v2 同骨干逻辑边 × 紧凑历史 2×2 消融协议

冻结候选日期：2026-09-01

协议 ID：`d19_v2_matched_history_ablation_protocol_20260901_v1`

实验 ID：`d19_v2_logical_edges_x_compact_history_candidate_v1`

可执行合同：`scripts/d19_v2_matched_history_contract.py`

候选 manifest：`configs/d19_v2_matched_history_ablation_manifest.json`

当前状态：**仅协议与 CPU preflight；训练、评估、GPU 和正式结果均未授权、未执行。**

## 1. Append-only 边界

本协议是独立的 D19-v2 候选，不覆盖、不修订、也不重新解释冻结的
`D17_D19_PROTOCOL.md`、`configs/d17_d19_formal_manifest.json`、旧 D19 P1 gate、
任何 D17--D19 结果、receipt 或 paper gate。旧 D19 v1 仍因 P0 科学门失败而
关闭，旧 TopologyHistory、D14--D18 或 history-twin 结果不得冒充本实验结果。

本轮只允许：

- 解析并哈希绑定候选 manifest 与现有规则/张量源；
- 从完整的决策前规则快照构造紧凑历史通道；
- 在 CPU 上构造小张量、实例化四个同构网络并做无梯度 forward；
- 精确核对参数数、state-dict 形状、输入形状、特征门和已验证 witness 的边界。

本轮禁止 self-play、训练循环、反向传播、optimizer step、checkpoint、正式 arena、
联网、安装、GPU、AutoDL、上传、提交和论文正面结果。以后即使准备运行，也必须先有
独立 CPU/GPU 预算测量、精确成本与目标复核，并取得新的单次授权。

## 2. 唯一允许变化的两个轴

四臂固定为：

| arm | logical-edge feature | compact-history feature |
| --- | ---: | ---: |
| `edge0_history0` | 0 | 0 |
| `edge1_history0` | 1 | 0 |
| `edge0_history1` | 0 | 1 |
| `edge1_history1` | 1 | 1 |

四臂始终使用相同的 3-relation 张量形状：physical、own-logical、opponent-logical。
关闭 logical-edge feature 时，只把 own/opponent 两个关系通道置零；physical 通道、
节点特征、legal mask 和张量形状不变。不得改为 Grid-GNN、减少 relation projection、
删除模块或用不同宽度补参数。

四臂始终使用相同的 12 维节点输入：现有 11 维规则/几何特征加 1 维紧凑历史特征。
关闭 compact-history feature 时，只把最后一维置零；不得删除 input weight、改变
hidden width，或让 legal mask、规则模式随 arm 改变。

## 3. 紧凑历史的精确定义

紧凑历史是 `immediate_superko_membership_plane_v1`：对当前玩家和每个棋盘点
`a_i`，在完整的决策前 `GameSnapshot` 上计算

```text
h_i = 1  当且仅当 evaluate_move(a_i).would_violate_superko == true
h_i = 0  其他情况
```

PASS 的历史特征固定为 0，且不新增单独的可训练 PASS-history 参数。该摘要的模型
特征宽度恒为每节点 1 bit，与棋盘边长无关；混合尺寸批次仍按现有节点前缀 padding。

这是 action-aligned 编码里对“下一步结果 key 是否已在 Superko 集合中”的最小精确
摘要：每个点只保留一个必要且充分的布尔值。它并不重建完整历史顺序、历史集合或更远
未来。它只读取快照中的 board、logical edges、current player、history set、规则模式等
当前规则状态，并调用无副作用的当前落子判定；不读取之后的动作、奖励、终局、搜索树、
对手回应或训练标签。因此它是决策前规则特征，不是未来泄漏。

本定义只对“一步 Superko membership”充分；不同完整历史可以映射到同一个 bit plane，
所以不得称其为完整 Markov state、完整 TopologyHistory 或无碰撞历史编码。

## 4. 同骨干与精确参数门

唯一骨干为 64 hidden、3 message-passing layers 的三关系 GNN：

- input width：12；
- relation count：3；
- point-policy、PASS-policy、value head 与现有 Topology-GNN 同形；
- 每臂 trainable parameters：**63,235**。

四臂必须有完全相同的 module 名、state-dict key、tensor shape 和参数数。同一个 training
seed 下四臂必须从完全相同的初始化 bytes 开始；arm ID 不得参与初始化或随机子流派生。
任一实际参数数不是 63,235，或四臂之间差 1 个参数，都必须拒绝，不能使用相对容差、
近似 width matching、额外 dummy 参数或删减另一 head 补偿。

## 5. 共享训练合同（只预注册，未授权）

四臂逐字段共享：

- training seeds：`20260825..20260829`，所有 seed 均须保留；
- mixed train sizes：5、7、9；Superko `enforce`；最多 256 plies；
- 每 seed/arm 10 iterations × 10 self-play games = 100 games；
- 每 iteration 20 gradient steps，总计 200；batch 16；replay 10,000；
- PUCT-16，`c_puct=1.5`；self-play Dirichlet alpha 0.3、epsilon 0.25；
- temperature moves 20，temperature 从 1.0 切到 0.1；
- AdamW：lr 0.001、weight decay 0.0001、betas (0.9, 0.999)、epsilon 1e-8、
  amsgrad false；gradient clip 5.0。

随机性必须使用与 arm 无关的 counter-based 子流；相同 training seed、iteration、game、
search node、replay draw 和 update index 在四臂得到相同派生 seed。随机调用次数因策略分歧
而变化时，禁止依赖一个共享的顺序 PRNG 状态伪称 paired。

## 6. 共享评估合同（只预注册，未授权）

只评最终 200-step checkpoint；不得 fine-tune。每个 arm × training seed × eval size
(9/10/12) × opponent (Random/UCT-MCTS-16) 固定 200 局，即 100 个换色 pair。
神经侧 PUCT-16、temperature 0、无 root noise；UCT 对手 16 simulations、rollout depth
80、exploration sqrt(2)。四臂复用逐局相同的 opening、policy seed、对手 seed、颜色与
换色计划。截断、失败或缺失 seed 不得删除。

主统计单位是 5 个 training seed，不是 24,000 个 pooled games。预注册 factorial contrasts：

- logical-edge effect at history=0：`edge1_history0 - edge0_history0`；
- logical-edge effect at history=1：`edge1_history1 - edge0_history1`；
- history effect at edge=0：`edge0_history1 - edge0_history0`；
- history effect at edge=1：`edge1_history1 - edge1_history0`；
- interaction：`edge1_history1 - edge1_history0 - edge0_history1 + edge0_history0`。

每个 size/opponent 分层报告五 seed 配对均值与双侧 Student-t 95% 区间（df=4）；不得
把一局当成独立推断单位，不得从某个单元格推广到全尺寸、全预算或其他算法。

## 7. CPU preflight 的通过条件

`verify_d19_v2_matched_history_preflight.py` 必须在 CPU 上同时验证：

1. manifest schema、四臂 2×2 完整性、所有共享 reference 和执行禁令；
2. protocol、规则 core、原 Topology tensor code、witness candidate/receipt 与本轮脚本哈希；
3. 四臂参数数均严格为 63,235，state-dict key/shape 与相同 seed 初始化摘要完全一致；
4. 四臂 tensor/output shape 一致，physical relation、前 11 个节点特征和 legal mask 一致；
5. 关闭轴只产生相应全零 logical relation 或 history plane；
6. 混合小尺寸 batch 可做 finite CPU forward，非法 action probability support 仍被 mask；
7. 已验证 n=6 natural history twin 的 candidate `(2,3)` 在 reference history bit 为 1、
   twin 为 0，且 mask-free topology 相等但 legal mask 不等；
8. receipt 明确写出 0 training、0 optimizer step、0 self-play、0 evaluation game、0 GPU。

preflight PASS 只表示静态合同和 CPU tensor path 可运行，不是 smoke、pilot、正式训练或
正式结果，也不打开旧 D19 gate。

## 8. 科学主张边界

本协议与 preflight 支持的唯一表述是：

> 已准备一个参数精确相等、只通过清零特征实现的 logical-edge × immediate-Superko-
> membership 四臂候选，并在 CPU 小张量上验证其合同。

仍不支持：

- logical edges、compact history 或二者交互带来学习收益；
- TopologyHistory 优于 Grid/Topology；
- old D19、D17 或 D18 通过 gate；
- witness 构成 same implemented observation/mask pair；
- 相同 observation 和 legal mask 下最优动作、Q 值或不可避免 regret 不同；
- 模型输入已经完整 Markov，或紧凑历史 bit plane 无信息损失。

尤其是当前 natural history twin 的 legal mask 本身不同。所有四臂仍接收真实 legal mask，
所以该 witness 只能检查历史特征的规则含义，不能变成 reviewer 要求的 same-observation/
mask decision witness。核心 construct-validity blocker 保持 **OPEN**。

## 9. 当前复现命令

从 `research/iclr2027` 运行：

```powershell
$env:PYTHONPATH='.'
python -B scripts/verify_d19_v2_matched_history_preflight.py
python -B -m unittest tests.test_d19_v2_matched_history_preflight -v
```

两条命令都不得带训练、GPU 或正式输出参数。任何未来 runner、checkpoint/receipt schema、
预算测量与独立结果 verifier 必须作为新的 append-only 工作另行审阅。

