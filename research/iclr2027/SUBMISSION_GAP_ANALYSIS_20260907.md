# LIFELINE-RL 投稿缺口与执行路线

状态日期：2026-09-07（Asia/Shanghai）  
工作区：`codex/territory-v2-page-correctness`，当前存在用户已有未提交修改。  
本文件是追加式的决策记录，不改写冻结 protocol、旧 receipt、旧 gate 或当前 PDF 的绑定。

## 结论先行

当前项目还不具备投稿条件。最新 `submission_gate_postrun_v7_848C6035.md` 对当前
`main.pdf`（SHA-256：
`848C60359A0DCD829E33E8E0388F5FA0AA136A2E045215E0B8D63A8ABFFA99F6`）的结论是
`FAIL / Needs revision`，科学评价为 `Weak Reject, 4/10`。

最短可行路线不是继续重复旧 D17/D18，而是：

1. 先完成 D19-v2 的安全 CPU 预检、预算测量、runner/verifier 闭环，然后在允许的
   新运行边界下执行同骨干 2×2 消融；
2. 对“同 implemented observation 与 legal mask、但未来决策不同”的构造问题做一次
   有预算的决策相关性审计；找不到就把论文主张明确收窄为 simulator-state / legality
   engine 机制，而不是声称 Grid/Topology 学习必要性；
3. 只有在上述科学结果明确后，重写主论文的 framing、方法、结果和限制，并完成
   fresh reproduction、anonymous supplement、AI-use disclosure 及最终 hash-bound gate。

## 当前证据状态

| 方向 | 当前状态 | 可以写进论文的内容 | 不能写的内容 |
|---|---|---|---|
| PDF 技术质量 | PASS（11 页 US-Letter、字体/渲染检查通过） | 当前 PDF 的技术质量 | “已可投稿”；它仍是 dirty working-tree bytes |
| 环境与规则 | 已有 Python/Web trace parity 与 replayable snapshot | 测试过的规则/快照/回放合同 | exhaustive cross-engine proof |
| side-5 topology | exhaustive negative result | 有 Grid-equivalent 状态存在 latent logical-edge 差异，且 side-5 未发现决策后果 | Grid 非 Markov、topology 必然带来性能收益 |
| side-6 history twin | 独立 Python/Web replay PASS，但为 mask-free projection | 同 topology projection 下 Superko 合法性可不同 | same implemented observation/mask、不同 value/optimal action、学习收益 |
| D14–D16 | `formal_ready=true`，15 train / 315 eval / 1,500 self-play / 3,000 updates / 30,600 task-indexed records | 五 seed 的 bounded descriptive summaries | 全局 representation ranking、独立逐局推断、unseen-size/generalization、sample efficiency |
| D17/D18-v1 | 85/85 tasks、8,320/8,320 games、canonical integrity PASS；科学 gate FAIL_CLOSED | 执行完整但被 diversity gate 排除这一事实 | D17/D18 正面性能、D16-v2 inference、D19 result |
| D18-v3 | `frozen_zero_formal_games` | capacity planning only | 任意 formal result |
| D19-v2 | `preflight_only_not_authorized`；无训练/评估/GPU/正式 receipt | 候选合同、四臂设计和计划预算 | 任何 D19 数值、显著性或主张 |
| 投稿材料 | 当前 gate 为 NO；supplement/AI-use/fresh install/final archive/open form 均开放 | 只能写准备状态 | author approval、匿名归档完成、已上传/已投稿 |

## 投稿前必须完成的实验

### P0-S1：D19-v2 同骨干 factorial ablation

这是当前最直接、最值得投入的一项实验，因为它把 reviewer 的架构混杂问题变成
可检验的单一骨干对照。冻结候选文件为：

- protocol：`D19_V2_MATCHED_HISTORY_ABLATION_PROTOCOL.md`；
- manifest：`configs/d19_v2_matched_history_ablation_manifest.json`；
- 四臂：`edge0_history0`、`edge1_history0`、`edge0_history1`、`edge1_history1`；
- 固定输入宽度 12、三类关系、64 hidden、3 message-passing layers；每臂严格
  63,235 个参数、相同 state-dict 形状和同 seed 初始 bytes；
- planned totals：20 training tasks、2,000 self-play games、4,000 gradient steps、
  120 evaluation tasks、24,000 evaluation games；这些数字目前全部是计划，不是结果。

执行顺序必须保持：

1. CPU preflight：manifest/protocol/source/witness 哈希、四臂参数与 state-dict、
   feature-zeroing、legal-mask support、finite forward、0 training/0 game/0 GPU receipt；
2. 独立预算测量：CPU/GPU 时间、显存、磁盘、预计总耗时和停止条件；
3. 再执行正式合同，并由独立 verifier 从 receipt/aggregate 重新计算主表；
4. 以五个 training seeds 为主统计单位，按 eval size/opponent 分层报告配对
   factorial contrasts 和 df=4 的区间；不得把 pooled games 当独立样本。

若结果接近零或区间很宽，也应如实报告：这会把结论变成“在该预算和任务分布下
未观察到稳定输入效应”，而不是把 null 结果包装成 topology/history 无用。

### P0-S2：同 observation-and-mask 的决策相关性审计

side-6 witness 已经证明的是 mask-free Topology projection 下的合法性差异；因为
legal mask 本身随之改变，它没有回答 reviewer 的更强问题。需要一次限时、可复核的
搜索/验证工作：

- 同时固定 board、typed logical edges、player、skip/terminal 状态和 implemented
  legal mask；
- 让完整 history 仍不同；
- 找到共享合法动作后不同的可验证 transition、exact value、Q value 或 optimal action；
- 保存完整历史、projection/mask fingerprint、candidate action、独立 verifier 和
  search budget。

如果在预先声明的尺寸/预算内找不到，论文应主动删掉或降级以下 framing：
`non-Markov Grid`、`history is necessary for learning`、`TopologyHistory superiority`、
`same-observation aliasing`。保留“history-dependent legality is a simulator-state
mechanism”是科学上诚实且已经有证据的版本。

### P1-S3：多样性、强对手和外推

这组实验不能用更多重复的 deterministic trajectories 代替。D17/D18 的 22/45
diversity misses 已经说明旧方案不能作为修补。若时间/算力允许，应另行冻结一个
小而明确的扩展：

- 预注册 opening/trajectory diversity 与独立统计单位；
- 对 calibrated stronger opponent 做 search-budget sweep，或给出可解释的
  opponent-strength calibration；
- 将 unseen-size（至少一个未参与训练的 size）作为明确的 held-out evaluation，
  只在正式 receipt 通过后报告；
- 不把一次 hand-designed game 的结果外推到整个 board-game/representation 家族。

这组实验优先级低于 P0-S1；若 D19 或决策相关性审计不能支持中心论点，应该收窄论文，
而不是用旧 D17/D18 重跑来制造“更多证据”。

## 必须写或重写的论文材料

### 1. 主论文修订版

当前 `main.tex` 已经较谨慎地写入 side-5 negative result、side-6 mask-free witness
和 D14–D16 bounded evidence；后续需要按实验结果完成一次全局一致性修订：

- Introduction/abstract：把贡献中心放在 benchmark/environment、状态分解、负结果和
  可审计机制证据；D19 只有 receipt 通过后才能写入；
- State-aliasing：明示 mask-free projection 与 implemented mask-bearing observation
  的区别，不把 legal-set difference 当成 implemented alias；
- Experiments：加入 D19 四臂表、预注册 contrasts、seed-level uncertainty 和
  exact budget；没有结果就保留为 protocol/limitation，不放数字；
- Limitations：保留单一 hand-designed game、弱 search opponent、deterministic
  trajectory duplication、未验证外部有效性和 compute 未完全匹配；
- Conclusion：不写 global ranking、sample efficiency、unseen-size generalization
  或 learned benefit，除非有对应 gate-passing artifact。

每次改 `main.tex` 都会使当前 PDF hash、claim ledger、blind review 和 submission gate
失效，必须重新编译、渲染、抽取文本、做匿名性/引用/字体检查，并重新生成 hash-bound
review/gate。

### 2. Anonymous supplement v2

目前仅有 candidate-only profile/allowlist 和未完成的 author per-file review。仍需：

- 重新绑定当前论文与新增 D19/决策审计证据的 payload topology；
- 私下完成人员/身份覆盖与逐文件 author decision；
- 完成 identity scan、subject-bound archive、member manifest/hash；
- 在 clean copy 上 independent verify-extract；
- 明确 raw trajectories、checkpoints、私密路径和未授权文件不进入匿名包。

### 3. Reproduction、AI-use 与 live form

- fresh clean install：不能用 retained environment 的 contract-only PASS 代替；需要
  clean export/build、安装、scoped tests 和 hash-bound receipt；
- AI-use：根据作者真实工具、任务、输出和最终 wording 完成 disclosure；agent 不能
  猜测作者事实，也不能把草稿视为 author approval；
- final form：确认 exact PDF/supplement bytes、标题/作者/领域/冲突等元数据，完成
  live OpenReview form；当前未上传、未提交。

## 当前并行子任务

已启动三个真正隔离的子 agent，写入范围互不重叠：

1. `Gauss`（agent id `01a07aed-9c1d-7b90-a866-d13adf5d3bfa`）：独立审计当前 PDF、
   reviews 与 Agent ICLR handoff；
2. `Gibbs`（agent id `01a07aed-9e93-78d0-af8e-5042f9235406`）：只做 D19-v2 CPU
   preflight、静态完整性和本地预算/入口审计，不跑正式训练；
3. `Boole`（agent id `01a07aed-a0fa-7e21-99b6-7d68f5da703a`）：起草 bounded
   manuscript revision 段落和修改清单，不改 `main.tex`、不编译 PDF。

## 明确的停止条件

- D19 任一合同字段、参数数、初始权重、seed pairing、receipt 或 verifier 不一致：
  立即拒绝结果，不修后报成正式结果；
- 任何实验只有 smoke/pilot/capacity/preflight：只能写对应 evidence tier；
- 正式运行需要新 GPU/AutoDL/付费资源时：先停在预算和执行边界，不自动开启计费；
- 找不到 same-observation-and-mask witness：不继续无界搜索，改写 framing；
- 论文、supplement、AI-use 或作者身份仍未完成 author gate：不上传、不投稿。

## 预期投稿判据

只有同时满足以下条件，项目才从“needs revision”进入“可进行最终投稿检查”：

1. P0-S1 有完整正式 receipt、独立 aggregate/verifier 和不夸大的 interpretation；
2. P0-S2 已找到可复核 witness，或论文已明确收窄而不再依赖该 claim；
3. 论文所有数字与 hash-bound evidence 一致，fresh QA/review/gate 通过；
4. supplement v2、fresh reproduction、AI-use、identity review 和 final archive 全部
   关闭；
5. 作者在 live form 中确认 exact bytes 和 metadata。

在这些条件之前，当前合理状态是：科学上继续修订，投稿状态 `NO`。

## 2026-09-07 实际执行记录

- D19-v2 CPU preflight：**PASS**；命令 exit code `0`。
- 专用测试：`8/8 OK`，耗时约 `0.574 s`。
- 运行环境：`C:\Users\zcz\anaconda3\envs\rl310\python.exe`，PyTorch
  `2.7.1+cu118`，此次路径为 CPU。
- receipt：
  `results/validation/d19_v2_cpu_preflight_receipt_20260907.json`，SHA-256
  `C1CBC7B8E2D143D1744F5F3394543D960EAAEEF3BDCED0E0F57B7FDFF987ECE6`。
- receipt 中的 execution counts 全为 0：训练步、optimizer step、self-play、
  evaluation、checkpoint、formal result、GPU operation 和 network request 均为 0。
- 因而本次推进的真实产物是“合同预检 receipt + 投稿缺口分析 + 论文修订草稿”，
  不是 D19 正式实验结果；formal runner 仍为 `NOT_IMPLEMENTED`，而 verifier 只完成了
  合同加固和测试，未来正式 receipt 仍需另行审查。

## 2026-09-07 live continuation（追加）

- D19 verifier 已加固为 CPU-only `weights_only=True` checkpoint round-trip，独立
  核对 35 个 state-dict entries、固定 shape 和 63,235 参数；正常项目权限下
  verifier `10/10`、runner + matched-history preflight `13/13` 通过。它只关闭了
  verifier contract risk，不产生 D19 数值。
- n=6 same-observation-and-mask 搜索启动到 25,000-state 上限前，在 20,000 states
  checkpoint 安全中止；progress-only record 标为
  `INTERRUPTED_BEFORE_COMPLETION`，没有 final negative receipt，也没有关闭 S1。
- 本轮论文输出是 `paper/MANUSCRIPT_REVISION_DRAFT_LIVE_20260907.md`；它给出可
  直接移植的 evidence-bounded 段落，但未改 `main.tex`、未编译新 PDF，因此当前
  `848C6035...FFA99F6` 的旧 review/gate binding 不变。
