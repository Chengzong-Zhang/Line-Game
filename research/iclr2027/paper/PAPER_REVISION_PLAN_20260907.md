# LIFELINE-RL 论文修订计划（2026-09-07）

状态：独立审计与写作计划；只绑定当前可核验材料，不代表作者批准、正式实验完成或可投稿。

## 结论先行

当前科学状态仍为 `needs revision / NO`。冻结的 PDF-only reviewer 对
`paper/main.pdf`（11 页，SHA-256 `848C60359A0DCD829E33E8E0388F5FA0AA136A2E045215E0B8D63A8ABFFA99F6`）给出
`4/10 - Weak Reject`、confidence `4/5`。这个分数只能归属于该精确 PDF；不能把它当作未来修订稿的分数，也不能把本地 reviewer 或第三方 ICLR 数据当作官方评分预测。

评分最主要的驱动项是：

1. 中心构念效度仍未闭合：side-6 witness 只在 mask-free Topology projection 下相同，implemented legal mask 不同，因此不是 same-observation-and-mask witness。
2. 没有 feature-isolating、same-backbone 的逻辑边/历史因果消融；Grid-GNN 与 Topology-GNN 同时改变关系输入和 hidden width，CNN 还存在更大的架构差异。
3. D14--D16 的正面学习信号弱且重复轨迹严重：主要单位是五个 training seeds，不能把重复 deterministic games 当独立样本或据此给出全局 representation ranking。
4. 贡献外推不足：一个 hand-designed game、jointly trained sizes、弱且未校准的 search opponent，尚无 unseen-size、cross-game 或更强对手证据。

技术 PDF 可读性/字体/匿名性检查通过，不会自动消除以上科学问题。D17/D18 的完整性也不能转化为正面性能结果；D19 当前只有 preflight，绝不能写成结果。

## 证据账本与写作边界

| 主题 | 当前可写事实 | 不得写成 | 关闭条件 |
|---|---|---|---|
| 环境与规则 | 可回放环境、状态分解、测试过的 Python/Web parity | exhaustive cross-engine proof | 在最终论文中绑定准确 protocol、source hash、parity receipt，并保留“记录轨迹范围内”的限制 |
| side-5 topology | 完整 side-5 审计找到 latent logical-edge 差异，但未找到 legal-action、transition、value、Q 或 optimal-action 后果 | `Grid is non-Markov`、topology 必然带来性能收益 | 维持负结果；除非新正式证据直接支持更强措辞，否则删除/降级 |
| side-6 history | 自 standard start 可达的 paired histories 在 mask-free Topology projection 相同，Superko 使一个 shared placement 合法性不同；双引擎 replay PASS | implemented observation 相同、same mask、different value/optimal action、learning benefit | 机制段落必须明确 mask 不同；更强 claim 只有 same-observation-and-mask + future-decision witness 通过独立验证后才能恢复 |
| D14--D16 | 15 train tasks、315 eval tasks、1,500 self-play games、3,000 updates、30,600 task-indexed records；仅 descriptive、receipt-bound | global ranking、sample efficiency、unseen-size generalization、independent-game inference | 重新绑定最终 PDF 与现有 formal ledger/aggregate/seed-pair audit，并把五 seed 作为统计单位 |
| D17/D18 | 85/85 tasks、8,320/8,320 records 的 canonical accounting，以及 22/45 diversity failures；科学 gate 仍 failed/`formal_ready=false` | D17/D18 正面性能、D16-v2 inference、D19 result | 仅写 status/limitation；不得放入正面结果表 |
| D19-v2 | CPU contract preflight PASS；execution counts 全为 0，属于 planned protocol 的入口检查 | 任意 D19 数字、显著性、interaction 或 learned benefit | formal execution receipt、独立 aggregate/verifier、compute accounting 和不夸大的 interpretation 全部通过 |

依据：`SUBMISSION_GAP_ANALYSIS_20260907.md:24-36,40-81,173-185`；
`paper/CLAIM_EVIDENCE_LIMITATION_V6.md:59-72,81-115`；
`reviews/iclr2027_postrun_independent_review_v6_848C6035.md:26-54,64-102`。

## 可直接改写的章节（不依赖 D19）

这些段落可以先按 `MANUSCRIPT_REVISION_DRAFT_20260907.md` 改写，但改动后必须重新编译、逐页 QA、生成新的 PDF-bound review/gate；不得认为现有 hash 仍有效。

| 位置 | 直接写作动作 | 必须绑定的证据与限制 |
|---|---|---|
| Title / Abstract | 将贡献中心收窄为 replayable benchmark、state decomposition、side-5 negative result、mask-free history-legality mechanism 和 bounded accounting | 不出现 topology/history learned benefit、global ranking 或 generalization |
| Introduction | 明示 topology/history 是 simulator-state components 与 declared channels，不是已证明的 learning sources；将 contributions 写成可审计 artifact | `MANUSCRIPT_REVISION_DRAFT_20260907.md:41-70`；贡献的证据等级分开 |
| Related Work | 保留定位，但避免从本项目单一游戏推出领域级 novelty/优越性 | 外部 ICLR review model 规定 offline reviewer 不能在无浏览时声称 globally novel；见 `C:\coding\Agent\ICLR\reports\INDEPENDENT_REVIEWER_MODEL.md:71-79` |
| Benchmark / Observation Protocol | 直接补清 physical occupancy、typed logical edges、history、legal mask、terminal bookkeeping 的区别 | 特别标注 mask-free projection 与 implemented mask-bearing observation 的差异 |
| State-Aliasing Diagnostics | 用 side-5 exhaustive negative result + side-6 bounded witness 的双段结构；保留 bounded search ceiling，不写 shortest/exhaustive side-6 | `MANUSCRIPT_REVISION_DRAFT_20260907.md:72-93`；`CLAIM_EVIDENCE_LIMITATION_V6.md:27-43` |
| Benchmark Protocol / Compute | 把 parameter matching 改写成 reproducibility control，而非 compute equivalence；说明 FLOPs、memory、transition、wall-time 未匹配 | `MANUSCRIPT_REVISION_DRAFT_20260907.md:95-116` |
| Experiments / D14--D16 | 保留 seed-level descriptive tables，正文明确 repeated deterministic trajectories 不是独立 game observations | `CLAIM_EVIDENCE_LIMITATION_V6.md:66-71` |
| Limitations | 直接采用 bounded list：mask 差异、side-5 scope、重复轨迹、架构混杂、joint sizes、弱对手、单一游戏、无 formal D19 | `MANUSCRIPT_REVISION_DRAFT_20260907.md:128-160` |
| Conclusion | 将结论降到 benchmark/rule-accounting resource；明确 stronger construct-validity claim remains open | `MANUSCRIPT_REVISION_DRAFT_20260907.md:162-181` |

## 必须等待 D19 / 机制审计的段落

### D19-dependent：同骨干 2×2 消融

`MANUSCRIPT_REVISION_DRAFT_20260907.md:183-209` 的整段只能保留为 `FUTURE-ONLY` 模板。候选设计是四臂
`edge0_history0`、`edge1_history0`、`edge0_history1`、`edge1_history1`；四臂应共享 backbone、parameterization、initialization、optimizer、schedule 和 paired evaluation plan。当前预注册计划中的 task/game/update 数字也全部是 planned/future-only。

只有下列 receipt-level 条件全部满足，才可把模板改成过去时并填数：formal runner 完成；四臂参数/state-dict/seed pairing 一致；独立 verifier 从 receipt/aggregate 重算 contrasts；compute accounting 可核对；结果解释限定在 tested sizes、opponent、budget 和 metric。null 或宽区间必须写成 inconclusive under this protocol，不能写成 feature 无用。

### 机制审计-dependent：same observation-and-mask

当前 side-6 witness 的 legal masks 不同，因此只能支持“history-dependent legality 是 simulator-state/legality-engine mechanism”。必须等待一次有预算、可复核的搜索/验证：固定 board、typed edges、player、skip/terminal、implemented legal mask，同时保持完整 history 不同，并证明共享合法动作的 future transition、exact value/Q 或 optimal action 不同。

若找到 witness：将其作为构念效度的独立机制证据，仍不能自动推出 learning benefit。若在预声明尺寸/预算内找不到：删除或降级 `non-Markov Grid`、`history is necessary for learning`、`TopologyHistory superiority`、`same-observation aliasing`，保留 mask-free simulator-state 版本。

## 分开的投稿材料与非科学 gates

### Anonymous supplement

当前 v2 profile/allowlist 与 per-file review 都是 `candidate_only_not_approved` / `OPEN`。必须重新绑定最终论文、新机制证据（如有）和最终 subject commit；完成 private identity coverage、逐文件 author decision、identity scan、member manifest/hash、subject-bound archive，以及 clean copy 上 independent verify-extract。raw trajectories、checkpoints、私密路径和未授权文件不进入匿名包。

### Fresh install / reproduction

retained environment 的 contract-only PASS 不等于 fresh reproduction。必须完成 clean export/build、依赖 wheel/runtime 闭合、全新安装、scoped tests、最终 source/config hash-bound receipt；编译、BibTeX、运行和抽取均需记录。失败时不得用本地缓存或旧 receipt 宣称复现完成。

### AI-use disclosure

`AI_USE_DISCLOSURE_DRAFT.md` 只是待作者填事实的草稿。作者必须逐项确认工具/provider/model、实际任务和阶段、是否影响方法/实验/解释/文字、保留输出、人类复核者、是否传输 unpublished material、共同作者使用，以及最终责任表述；再把批准版本分别放入论文要求位置和 live form。不能从分支名、内部 AI-2/AI-3 标签或仓库沉默推断事实。

### Live form

当前 live OpenReview form 未核验、未上传、未提交。作者必须在行动时确认 exact PDF/supplement bytes、title/authors/area/COI 等字段和平台要求，并检查论文 AI-use statement 与表单一致。任何本地 draft、review report 或 gate 都不能代替 live form。

## 最短可行路线

1. 先完成 D19 formal runner/verifier 的静态审查、CPU preflight 和一次明确的预算/付费边界确认；不因既有批准自动开启新的 GPU/AutoDL 运行。
2. 若获准运行，执行 frozen same-backbone 2×2 D19；只接受独立 verifier 通过的结果，所有数字标为 planned/future-only 直到该时点。
3. 并行完成一次有界 same-observation-and-mask 机制审计；找到则谨慎补强机制，找不到则立即收窄 framing。
4. 按结果一次性修订 abstract/introduction/state-aliasing/experiments/limitations/conclusion，随后 rebuild、全文 PDF QA、匿名性检查、fresh blind review 和 submission gate。
5. 以最终 subject commit 重新生成 anonymous supplement v2，完成 fresh install/reproduction、AI-use author gate、identity/per-file review 和 final archive。
6. 最后由作者核对 exact bytes 与 live form；在所有 gate 关闭前保持 `submission_ready=NO`。

## 不能自动代作者完成的事项

作者必须亲自决定并确认：是否启动付费/外部计算、D19 结果解释、same-mask witness 是否足以支撑主张、每个 supplement 文件是否公开、身份覆盖、AI-use 事实与责任声明、共同作者批准、最终 PDF/supplement bytes、COI/作者/领域等 live form 字段，以及最终上传/投稿动作。审计 agent 可以生成检查、复算和草稿，但不能替作者作这些事实性或外部提交承诺。
