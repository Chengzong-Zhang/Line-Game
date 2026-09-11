# LIFELINE-RL：live manuscript revision draft（2026-09-07）

状态：仅为可移植的英文论文修订材料；未修改 `paper/main.tex`，未编译 PDF，未改变任何既有 receipt、ledger、review 或 gate。

当前 source language 是英文，因此下列可移植段落均用英文；中文内容是编辑说明、证据绑定和写入条件。

## 0. 使用边界与当前 evidence cutoff

本草稿以当前 `research/iclr2027/paper/main.tex`、以下最新审计文件和 v6 claim ledger 为准：

- 投稿缺口：`research/iclr2027/SUBMISSION_GAP_ANALYSIS_20260907.md`；
- 投稿 readiness：`research/iclr2027/SUBMISSION_READINESS_MATRIX_20260907.md`；
- blind-first review：`research/iclr2027/reviews/iclr2027_postrun_independent_review_v6_848C6035.md`；
- submission gate：`research/iclr2027/submission_checks/submission_gate_postrun_v7_848C6035.md`；
- claim ledger：`research/iclr2027/paper/CLAIM_EVIDENCE_LIMITATION_V6.md`。

当前 gate 仍为 `FAIL / Needs revision`，submission readiness 为 `NO`。当前 PDF 的 review/gate binding 只属于既有 PDF bytes；本文件不是新的 PDF、review、gate 或 submission approval。

下文的标签含义：

- `SAFE NOW`：可以在保持当前 evidence binding 的情况下移植；
- `HOLD / FUTURE-ONLY`：当前不能写成结果，只能作为占位或 protocol 描述；
- `AUTHOR CONFIRMATION`：不能由仓库或 agent 推断，必须由作者确认；
- `REBUILD REQUIRED`：写入 `main.tex` 后会使当前 PDF hash、review、gate 和相关 ledger binding 失效，必须重新生成对应证据。

本草稿不引入任何尚未运行实验的结果数字。D19 的 arm、seed、game、step、effect、interval、compute 和 significance 字段均留给未来 verified receipt；D19 的计划数量不复制到正文结果段。

## 1. 建议的总 framing

### 1.1 Abstract replacement — `SAFE NOW`

目标位置：`main.tex:32-50`。

```latex
\begin{abstract}
We introduce \lifeline{}, a deterministic self-play benchmark that separates
physical occupancy, player-specific logical connectivity, cascading removal,
and repetition history. Complete side-five enumeration finds reachable
differences in latent logical edges but no decision-relevant difference in
legal actions, next observations, exact values, shared-action $Q$ values, or
optimal actions within the audited side-five state graph. A standard-start
side-six paired-history witness reaches the same board, typed logical edges,
turn, skip, and terminal components under a deliberately mask-free Topology
projection, while Superko changes the legality of one shared placement.
Because the implemented legal-action masks differ, this witness is not a
same-implemented-observation-and-mask pair and does not establish a future
value, $Q$-value, optimal-action, or learning consequence.

We also report the frozen D14--D16 comparison of a padded CNN, a physical-edge
Grid-GNN, and a typed-edge Topology-GNN on jointly trained sizes. These results
are receipt-bound, seed-level descriptive summaries. Deterministic trajectory
duplication, architecture confounding, the absence of a feature-isolating
same-backbone ablation, and the lack of held-out-size and stronger-opponent
evidence preclude claims of a learned feature benefit, a global representation
ranking, relative sample-efficiency improvement, or unseen-size
generalization. We therefore present \lifeline{} as a replayable benchmark and
rule/state-audit resource, with the stronger construct-validity question left
explicitly open.
\end{abstract}
```

证据路径：`paper/CLAIM_EVIDENCE_LIMITATION_V6.md:61-72,118-124`；
`research/iclr2027/reviews/iclr2027_postrun_independent_review_v6_848C6035.md:26-40`；
`research/iclr2027/paper/main.tex:232-302,422-516`。

写入条件：当前 side-five negative result、side-six mask-free witness 和 D14--D16 descriptive boundary 仍由 ledger v6 绑定；不得把 side-six pair 改写为 equal implemented observation/mask，也不得把 D19 或新的 diversity/held-out-size 结果预填入本段。

### 1.2 Introduction contribution paragraph — `SAFE NOW`

目标位置：替换 `main.tex:62-83` 的 contribution framing，保留现有环境定义和引用。

```latex
Our contributions are deliberately scoped to the evidence that can be
replayed and audited:
\begin{enumerate}
  \item a tested variable-size environment with exact snapshots, legal-action
  masks, and replayable trajectories, supported by recorded Python/Web parity
  traces rather than an exhaustive cross-implementation proof;
  \item exhaustive side-five diagnostics and a dual-engine side-six
  paired-history witness that separate latent topology differences from
  history-dependent legality under a named mask-free projection; and
  \item a frozen D14--D16 evaluation whose seed-level summaries are descriptive
  and receipt-bound, not a causal comparison of representation features.
\end{enumerate}

The benchmark construction does not require a positive model result. In
particular, we do not claim that logical edges or compact history improve
learning, that any representation is globally superior, that the implemented
Grid observation is non-Markov, or that the results generalize to unseen board
sizes without a corresponding gate-passing experiment.
```

证据路径：ledger `C1-C10`（`paper/CLAIM_EVIDENCE_LIMITATION_V6.md:61-72`）；
缺口边界 `research/iclr2027/SUBMISSION_GAP_ANALYSIS_20260907.md:24-36,99-119`。

写入条件：可以现在移植；若保留任何 stronger representation claim，则必须先有对应 formal artifact、独立 verifier 和新的 hash-bound review/gate。

## 2. Mask-free history witness 与 implemented observation/mask

### 2.1 Observation definition replacement — `SAFE NOW`

目标位置：`main.tex:200-203` 以及 `main.tex:235-248`。建议把“legal-set difference alone”写得更明确，把 mask 作为 implemented interface 的组成部分。

```latex
All declared observation protocols expose the player to act, the consecutive-
pass count, and the legal-action mask in addition to their named structural
features. The mask is therefore part of the implemented observation interface,
not auxiliary metadata. A difference in legal sets is an observable difference
under every implemented protocol and cannot by itself witness an alias of the
implemented Grid or Topology observation.

For diagnostics, we separately define two weaker maps. The occupancy
projection omits the legal-action mask and logical-edge channels. The
mask-free Topology projection retains the board, typed logical edges, player to
act, consecutive-pass count, and terminal flag, but omits both repetition
history and the legal-action mask. Equality under either weaker map must not be
reported as equality of an implemented mask-bearing observation.
```

证据路径：`main.tex:180-203,235-248`；ledger `C3`，即
`paper/CLAIM_EVIDENCE_LIMITATION_V6.md:27-43,61-65`；
`research/iclr2027/submission_checks/submission_gate_postrun_v7_848C6035.md` 的
`Same implemented observation and mask` 行。

写入条件：当前实现继续把 legal mask 暴露给四个 observation protocols；如果实现接口改变，必须重新定义并重新验证 `o_impl` 与 `\phi_free`。

### 2.2 Side-six witness paragraph — `SAFE NOW`

目标位置：替换 `main.tex:284-302` 中关于 side-six pair 的解释；命题标题可以保留，但正文必须采用以下边界。

```latex
For the side-six witness, two legal histories from the standard start agree on
the board values, both typed logical-edge sets, the player to act,
consecutive-pass count, and terminal status under the mask-free Topology
projection. A shared placement is legal after one history and is rejected
after the other by the Superko rule. The legal-action masks nevertheless
differ. Thus the witness establishes history-dependent legality under the
deliberately weakened mask-free projection, but it is not a pair of equal
implemented Grid or Topology observations. It does not establish a
same-observation-and-mask future-decision consequence, different exact values,
different optimal actions, a learning benefit, or TopologyHistory necessity or
superiority.
```

证据路径：
`research/iclr2027/paper/CLAIM_EVIDENCE_LIMITATION_V6.md:27-43,61-65,118-124`；
`research/iclr2027/results/validation/targeted_history_twin_n6_stage5_verification_v1.json`；
`research/iclr2027/results/validation/history_superko_n6_strict_pair_verification_v1.json`；
`research/iclr2027/reviews/iclr2027_postrun_independent_review_v6_848C6035.md:28-40`。

写入条件：只能使用已持久化 candidate 与现有 Python/Web replay verification 的窄结论。若 candidate、source hash 或 verifier receipt 改变，必须重新绑定；不能把 cross-engine replay corroboration 写成独立 discovery 或 exhaustive side-six search。

### 2.3 Explicit non-claim guard — `SAFE NOW`

建议在 state-aliasing 小节末尾加入以下短段，防止后续把“合法 mask 不同”误读成 implemented alias：

```latex
The distinction above is substantive for interpretation. A mask-free collision
can reveal that the full simulator history affects legality, but it does not
show that the policy receives the same implemented input. We therefore reserve
the terms ``implemented observation equivalence'' and ``same-mask decision
witness'' for pairs that agree on the actual exposed legal mask as well as all
other implemented observation fields.
```

证据路径：ledger prohibited forms `paper/CLAIM_EVIDENCE_LIMITATION_V6.md:99-114`；
readiness `research/iclr2027/SUBMISSION_READINESS_MATRIX_20260907.md:18-25`。

写入条件：无条件适用于当前 evidence cutoff。当前不得写入 `non-Markov Grid`、`history is necessary for learning`、`same-observation aliasing`、`optimal-action difference` 或 `TopologyHistory superiority`。

### 2.4 Search-scope sentence — `SAFE NOW`

```latex
The witness-search ceilings and examined frontier are properties of the stated
bounded search only. They do not establish prevalence, shortestness, exhaustive
coverage at side six, or nonexistence of a same-implemented-observation-and-
mask future-decision witness.
```

证据路径：ledger `paper/CLAIM_EVIDENCE_LIMITATION_V6.md:37-43`；
`research/iclr2027/D19_V2_SAME_OBSERVATION_MASK_AUDIT_20260907.md:32-38,51-63`。

写入条件：当前只可把 bounded search 当作 scope-limited evidence；不得把 smoke、被中止的搜索或 bounded miss 升级成 nonexistence proof。

## 3. D19-v2：planned / future-only 状态

### 3.1 Current-status paragraph — `SAFE NOW`

目标位置：可作为当前 `Ablations` 小节中 D19 的替代说明；不要把它放进正面结果表。

```latex
At the current evidence cutoff, D19-v2 is a preflight-only candidate rather
than an executed experiment. Its same-backbone factorial contract and tensor
path have been checked on CPU, but no formal training, self-play evaluation,
checkpoint result, or learning-effect estimate is included in this manuscript.
Accordingly, the paper makes no claim about the isolated effect of logical-edge
inputs or compact-history inputs.
```

证据路径：`research/iclr2027/D19_V2_MATCHED_HISTORY_ABLATION_PROTOCOL.md:13-31,139-147`；
`research/iclr2027/configs/d19_v2_matched_history_ablation_manifest.json` 的
`status` 与 `execution_boundary`；
`research/iclr2027/results/validation/d19_v2_cpu_preflight_receipt_20260907.json` 的
`evidence_tier`、`execution_counts` 和 `claim_boundary`；
readiness `S2/A3`：`research/iclr2027/SUBMISSION_READINESS_MATRIX_20260907.md:20-23,29-34`。

写入条件：只要 manifest 仍是 `preflight_only_not_authorized` 且 preflight receipt 没有 formal execution 字段，就只能写本段；不得写任何 D19 结果数字、显著性、优势或 null-effect 结论。

### 3.2 Planned feature definition — `SAFE NOW, protocol only`

如果需要在方法中解释未来 D19 的 compact-history channel，可使用以下版本；它描述 protocol，不描述 efficacy：

```latex
The planned compact-history input is an action-aligned one-step Superko-
membership feature computed from the complete pre-action simulator snapshot.
For each point action it records whether evaluating that action would violate
Superko; it does not encode the complete history losslessly, does not replace
the legal-action mask, and does not constitute a full Markov-state encoding.
This feature definition is a protocol choice, not evidence that compact history
improves learning.
```

证据路径：`research/iclr2027/D19_V2_MATCHED_HISTORY_ABLATION_PROTOCOL.md:53-73`；
manifest `compact_history_feature`。

写入条件：只有在论文明确把该段标为 planned protocol 且实际运行仍使用同一 feature contract 时才能保留；不得把该 bit plane 称作完整 `TopologyHistory` 或无碰撞历史编码。

### 3.3 Future result template — `HOLD / FUTURE-ONLY`

以下段落只能在 formal D19 execution、独立 aggregate/verifier 和 compute-accounting gate 全部通过后填入；方括号内容必须由 verified aggregate 产生，不能凭计划或 preflight 填写。

```latex
% HOLD: FUTURE-ONLY. Insert only after formal execution and independent
% verification have passed. Do not fill brackets from the manifest or preflight.
\subsection{Feature-isolating ablation}

We evaluated the pre-registered same-backbone factorial design that toggles
logical-edge inputs and compact-history inputs independently. All arms shared
the backbone, parameterization, initialization protocol, optimizer, training
schedule, seed pairing, search procedure, and evaluation contract; only the
two input axes were varied.

We report the verified seed-level contrasts for the logical-edge effect, the
compact-history effect, and their interaction, stratified by the registered
evaluation conditions. The estimates, uncertainty summaries, task counts, and
compute accounting below are copied only from the independently verified D19
aggregate: [INSERT VERIFIED VALUES AND UNITS].

The interpretation is restricted to the tested sizes, opponents, training
budget, and evaluation contract. A contrast in one condition does not establish
universal representation superiority, TopologyHistory necessity, unseen-size
generalization, or a same-implemented-observation-and-mask future-decision
consequence. If a pre-specified contrast is inconclusive, we report it as
inconclusive under this protocol rather than as evidence of no effect.
```

证据路径：protocol `D19_V2_MATCHED_HISTORY_ABLATION_PROTOCOL.md:75-123`；
gap `research/iclr2027/SUBMISSION_GAP_ANALYSIS_20260907.md:40-63`；
readiness `S2/A3`；runner/verifier contracts
`research/iclr2027/scripts/d19_v2_formal_runner.py` 和
`research/iclr2027/scripts/verify_d19_v2_evidence.py`。

写入条件：formal receipt 存在；独立 verifier 从 receipt/aggregate 重算主表；参数数、state-dict shape、paired seeds、缺失/截断任务和 compute accounting 全部通过；新的 evidence hash 已绑定到新 source 和新 gate。否则保留 3.1，不插入 3.3。

## 4. D14--D16：deterministic trajectory 的统计边界

### 4.1 Compute matching and statistics replacement — `SAFE NOW`

目标位置：替换 `main.tex:333-345` 的统计解释。

```latex
The frozen D14--D16 comparison is summarized at the training-seed level.
Matching the training schedule, search procedure, optimizer, checkpoints,
evaluation schedule, and approximate parameter count improves auditability, but
it does not remove architectural, relation-set, FLOP, memory, transition, wall-
time, or evaluation-compute confounds.

The nominal game-record count is not the independent statistical sample size.
Each final seed-level direct-play task is generated from only two deterministic
color-conditioned trajectories that are repeated across records. We therefore
report medians and min--max ranges across seed-level scores as descriptive
summaries. These summaries are not confidence intervals or hypothesis tests and
do not support independent-game inference, multiple-comparison inference, a
global representation ordering, or a causal feature claim.
```

证据路径：ledger `C5-C9`：`paper/CLAIM_EVIDENCE_LIMITATION_V6.md:66-71`；
`main.tex:333-345,487-516`；
`research/iclr2027/reviews/iclr2027_postrun_independent_review_v6_848C6035.md:28-32,42-54`。

写入条件：当前 D14--D16 formal bundle 及 seed/pair descriptive audit 仍保持 `PASS_DESCRIPTIVE_ONLY_NO_INFERENCE`；若未来采用 diversified evaluation，必须另行绑定其独立单位、opening support 和 uncertainty protocol，不能回溯改变 D14--D16 的统计含义。

### 4.2 Direct-play result paragraph — `SAFE NOW`

```latex
Direct play is heterogeneous across model pairs and board sizes. The reported
seed summaries should be read as behavior under the frozen deterministic
protocol, not as evidence of a universal ranking. Repeating the same
color-conditioned trajectories increases the number of recorded outcomes but
does not create new independent openings or independent games. We consequently
retain the seed-level medians, ranges, and trajectory hashes for reconciliation,
while withholding claims of superiority, robustness, or representation
causality.
```

证据路径：`main.tex:487-516`；ledger `C7`；review
`research/iclr2027/reviews/iclr2027_postrun_independent_review_v6_848C6035.md:28-40`。

写入条件：可以现在移植；不得用 pooled game count 替代 seed-level unit，也不得用 range 或 pooled score 改称 confidence interval。

### 4.3 Checkpoint/sample-efficiency guard — `SAFE NOW`

```latex
The checkpoint probes are retained for schedule and reconciliation purposes.
Because the protocol did not pre-register an area-under-curve or fixed-strength
learning estimator, the probes do not establish relative sample efficiency,
continuous convergence, or uncertainty over learning curves.
```

证据路径：ledger `C8`：`paper/CLAIM_EVIDENCE_LIMITATION_V6.md:69-70`；
`main.tex:458-471`。

写入条件：当前可直接使用；只有未来预注册并独立验证了对应 estimator 后，才能增加 sample-efficiency 结论。

## 5. D17/D18：fail-closed，而不是正面结果

### 5.1 Results/status paragraph — `SAFE NOW`

目标位置：可替换当前 `main.tex:568-570` 对 later extension 的一句话，或作为附录的 status paragraph。

```latex
The preregistered D17/D18-v1 extension completed its replay and canonical-
integrity contract, but its frozen scientific gate remained \texttt{FAIL\_CLOSED}
because the required trajectory-diversity criterion was not satisfied. We
therefore report this extension only as a fail-closed execution and artifact-
governance outcome. It is excluded from performance claims, zero-shot or
unseen-size claims, D16-v2 inference, D19 claims, and representation
superiority claims.

D18-v3 remains a planning/capacity state with no admitted formal result, and
D19-v2 remains a preflight-only candidate. Preparation bundles, smoke tests,
capacity measurements, recovery records, and candidate files are not formal
performance evidence.
```

证据路径：ledger `paper/CLAIM_EVIDENCE_LIMITATION_V6.md:81-97`；
gap `research/iclr2027/SUBMISSION_GAP_ANALYSIS_20260907.md:32-35,83-97`；
gate `research/iclr2027/submission_checks/submission_gate_postrun_v7_848C6035.md` 的
`D17/D18-v1 scientific gate`、`D18-v3` 和 `D19` 行。

写入条件：只要当前 canonical evidence 仍显示 scientific gate `FAIL_CLOSED` / `formal_ready=false`，只能写 status/limitation；不能挑出其中的执行量或完整性量来暗示 scientific readiness。

### 5.2 Prohibited upgrade — `SAFE NOW`

不要把以下任一短语放入正文、表格、图注或 supplement 的 claim summary，除非有新的、独立验证且 hash-bound 的 formal evidence：

```text
D17/D18 demonstrated zero-shot generalization.
D18 proved the diversified evaluation was scientifically positive.
D19 confirmed a logical-edge or compact-history benefit.
The complete run was formal-ready because all tasks and game records exist.
```

证据路径：ledger prohibited forms `paper/CLAIM_EVIDENCE_LIMITATION_V6.md:99-114`；
readiness `S4/A3`。

写入条件：当前全部禁止；这不是措辞偏好，而是 gate 的 evidence-tier 限制。

## 6. Limitations replacement — `SAFE NOW`

目标位置：替换 `main.tex:550-576` 的 `Limitations and Broader Impact` 项目列表。以下版本只写当前已知限制，不填 D19 或其他未来实验数字。

```latex
\begin{itemize}
  \item The side-six paired-history witness is equal only under a deliberately
  mask-free Topology projection. Its implemented legal masks differ, so it is
  not a same-implemented-observation-and-mask decision witness and does not
  establish different exact values, optimal actions, or a learned benefit.
  \item The exhaustive negative result is restricted to the audited standard
  side-five state graph. It does not establish nonexistence of decision-
  relevant topology or history effects on larger boards.
  \item The D14--D16 results are descriptive summaries of a frozen protocol.
  The training seed is the primary unit, while repeated deterministic
  color-conditioned trajectories limit effective evaluation support and rule
  out independent-game inference.
  \item Grid-GNN and Topology-GNN differ in relation inputs and hidden width,
  and the CNN differs more broadly. Parameter-count matching does not remove
  architectural, FLOP, memory, transition, wall-time, or evaluation-compute
  confounds.
  \item The learned comparison covers jointly trained sizes only. Unseen-size
  generalization, cross-game transfer, a calibrated stronger-opponent sweep,
  and a feature-isolating same-backbone result remain untested.
  \item The bounded Superko intervention is policy- and sample-dependent. Its
  null or similarity observations do not show that Superko is unnecessary or
  that history features are irrelevant.
  \item No formal D19 same-backbone factorial result is included at the current
  evidence cutoff. A future input ablation would test a model-input
  intervention, but would not by itself establish the stronger
  same-implemented-observation-and-mask construct.
  \item \lifeline{} is one hand-designed game. The current evidence therefore
  supports a replayable benchmark and rule-accounting resource, not a general
  claim about representation choice across games or learning systems.
\end{itemize}
```

证据路径：ledger `C2-C10` 和 `118-124`；
`research/iclr2027/reviews/iclr2027_postrun_independent_review_v6_848C6035.md:26-40`；
readiness `S1-S5`：`research/iclr2027/SUBMISSION_READINESS_MATRIX_20260907.md:18-25`。

写入条件：可以现在移植。若未来某个 gate 通过，只能删除相应已关闭的 limitation，并把新的 claim 绑定到新 artifact；不能因为 D19 通过就删除 observation/mask construct boundary 或 deterministic-trajectory limitation。

## 7. Conclusion replacement — `SAFE NOW`

目标位置：替换 `main.tex:578-599` 的 conclusion 与 reproducibility lead-in（AI-use section 另见第 8 节）。

```latex
\lifeline{} provides a replayable environment in which physical occupancy,
logical connectivity, cascading removal, and repetition history are separated
and auditable. Complete side-five enumeration gives a decision-relevant
negative result within its audited state graph. A dual-engine side-six
paired-history witness shows that identical mask-free topology can nevertheless
have different Superko legality, while the differing legal mask prevents that
pair from establishing an alias under the implemented observation.

The D14--D16 model results are retained as descriptive, receipt-bound
observations on jointly trained sizes. They do not establish a learned benefit
from logical edges or compact history, a global representation ranking, relative
sample-efficiency improvement, or unseen-size generalization. The stronger
same-implemented-observation-and-mask future-decision question and the
feature-isolating same-backbone ablation remain open at this evidence cutoff.
```

证据路径：ledger `paper/CLAIM_EVIDENCE_LIMITATION_V6.md:59-72,118-129`；
gate `research/iclr2027/submission_checks/submission_gate_postrun_v7_848C6035.md` 的
`Decision` 表；
`research/iclr2027/reviews/iclr2027_postrun_independent_review_v6_848C6035.md:50-54`。

写入条件：当前可移植；结尾不得写“ready to submit”，不得把最新 review 分数或 gate 结论迁移成新 PDF 的结论。任何改过正文的版本都要重新生成 PDF-bound review/gate。

## 8. AI-use statement 占位 — `AUTHOR CONFIRMATION / HOLD`

当前 `main.tex` 尚无作者确认后的 mandatory AI-use section。下面只是占位 skeleton，不是事实陈述，不应在 unresolved brackets 存在时插入论文或 OpenReview form。

目标位置：按 ICLR template 使用 `\subsection*{AI use statement}`，并按作者确认后的事实改写。

```latex
\subsection*{AI use statement}

Generative AI tools [AUTHOR-CONFIRMED PRODUCTS, PROVIDERS, AND MODEL
VERSIONS, OR ``UNKNOWN'' WHERE APPROPRIATE] were used for [AUTHOR-CONFIRMED
REQUIRED-DISCLOSURE TASKS] and [AUTHOR-CONFIRMED RECOMMENDED-DISCLOSURE
TASKS]. For the remaining required tasks, [AUTHOR-APPROVED USED / NOT USED /
NOT APPLICABLE ACCOUNT]. Retained AI-assisted outputs were [AUTHOR-CONFIRMED
CODE, ANALYSIS, FIGURES, TEXT, OR OTHER OUTPUTS] and were checked by the
authors using [AUTHOR-CONFIRMED HUMAN VERIFICATION]. The authors take
responsibility for the final text, claims, code, figures, references, and other
submission artifacts.
```

证据路径：`research/iclr2027/paper/AI_USE_DISCLOSURE_DRAFT.md:51-101,103-139,177-233`；
`research/iclr2027/paper/AI_USE_AUTHOR_DECISION_PACKET.md:17-51`；
readiness `G1-G4`：`research/iclr2027/SUBMISSION_READINESS_MATRIX_20260907.md:45-54`。

写入条件：作者逐项确认 tools/models、paper-relevant tasks、method implementation、claim/method/result interpretation、human verification、unpublished-material transmission、co-author use 以及最终 responsibility wording；paper section 与 live form 必须分别完成且一致。不能从 branch、process label 或当前 agent session 猜测 model/version、贡献比例或未公开材料传输情况。确认并写入后标记 `REBUILD REQUIRED`，再做新的 PDF QA/review/gate。

## 9. Reproducibility statement 与 supplement

### 9.1 Paper-safe reproducibility paragraph — `SAFE NOW`

目标位置：替换 `main.tex:593-599` 的当前 reproducibility statement；避免声称一个尚未 author-approved 的 supplement 已经 release-complete。

```latex
\subsection*{Reproducibility statement}

The manuscript specifies the rule contract, observation and legal-mask
interfaces, frozen training protocol, model inputs, evaluation unit, and the
scope of every reported result. Each retained claim is routed to a named
protocol or configuration, a compact aggregate or validation artifact, and an
independent verifier where one exists. Recorded Python/Web parity is evidence
for the checked traces and replay contracts; it is not an exhaustive
cross-implementation proof.

We distinguish formal results from bounded diagnostics, smoke/preflight checks,
planning evidence, and fail-closed executions. Raw per-game trajectories,
checkpoints, local task directories, private identity inputs, and transient
build outputs are not silently treated as public submission artifacts.
```

证据路径：ledger `C1-C10` 和 `154-162`；`main.tex:216-230,593-599,643-663`；
readiness `R1-R4`：`research/iclr2027/SUBMISSION_READINESS_MATRIX_20260907.md:36-43`。

写入条件：可以现在移植，但只应声称“manuscript specifies / evidence map routes”；不能写 `clean-install reproduced`、`claim-complete supplement released` 或 `final archive verified`，直到对应 receipt 存在。

### 9.2 Anonymous supplement release block — `HOLD / FUTURE-ONLY`

这是给 supplement README 或 artifact appendix 的可移植段落，不是当前 release 状态的事实陈述：

```text
The anonymous artifact package is generated from a subject-bound production
candidate whose source, protocol, evidence, and control files are recorded in
one manifest. It contains only the public-safe reference implementation,
frozen protocols, compact claim-supporting aggregates, validation receipts, and
independent verification materials required to reproduce the admitted claims.
Raw trajectories, checkpoints, private identity inputs, local absolute paths,
and unapproved or unrelated files are excluded. A clean-copy verify-extract
receipt binds the final archive to the same candidate tree.
```

证据路径：`research/iclr2027/SUPPLEMENT_AUTHOR_PER_FILE_REVIEW_V2.md:3-17,23-47,71-91,234-283`；
gap `research/iclr2027/SUBMISSION_GAP_ANALYSIS_20260907.md:121-129`；
readiness `R1-R4`。

写入条件：只有在 final subject commit/tree 已绑定、V2 profile/allowlist 已针对最终论文和证据重建、作者完成私下 identity/per-file review、privacy scan 通过、archive manifest/hash 生成、clean-copy independent verify-extract 通过后，才能把 `is generated` 改为现在时并宣称 package availability。当前 V2 仍是 `candidate_only_not_approved`；不能把 candidate profile/allowlist 当作 release receipt。

### 9.3 Fresh-install wording guard — `SAFE NOW`

```text
Reproducibility from a retained environment is not claimed as fresh-install
reproduction. A clean-install claim will be made only after a clean export/build,
fresh dependency installation, scoped rule-and-experiment checks, complete
TeX/BibTeX runtime closure, and a hash-bound reproduction receipt have all
passed on the final subject.
```

证据路径：gap `research/iclr2027/SUBMISSION_GAP_ANALYSIS_20260907.md:131-138`；
ledger `paper/CLAIM_EVIDENCE_LIMITATION_V6.md:137-152`；readiness `R4`。

写入条件：当前只可作为 limitation 或 release policy；在 fresh receipt 之前不得写成已经完成的 reproduction result。

## 10. Claim-routing checklist before transplant

| 目标文字 | 当前 authoritative evidence | 当前可写状态 | 写入前的必要条件 |
|---|---|---|---|
| Environment is replayable; checked Python/Web traces agree | `paper/CLAIM_EVIDENCE_LIMITATION_V6.md:61-64` | `SAFE NOW`, bounded to recorded traces | 不升级为 exhaustive cross-engine proof |
| Side-five latent topology difference with audited negative consequence | ledger `C2`, `:64` | `SAFE NOW`, side-five scope only | 不写 larger-board nonexistence、non-Markov 或 strategic insufficiency |
| Side-six history-dependent legality | ledger `C3`, `:65`; targeted and strict-pair verification JSON | `SAFE NOW`, mask-free projection only | 明确 legal masks differ；不写 same implemented observation/mask |
| D14--D16 seed summaries | ledger `C4-C9`, `:66-71`; seed/pair audit | `SAFE NOW`, descriptive only | seed is primary unit；deterministic repeats are not independent games |
| D17/D18 status | ledger `:81-97`; latest gate | `SAFE NOW`, fail-closed status only | 不从 execution/integrity completeness 推导 scientific readiness |
| D19 logical-edge/history effect | D19 protocol, manifest, CPU preflight | `HOLD / FUTURE-ONLY` | formal execution + independent verifier + compute accounting + new binding |
| AI-use wording | `AI_USE_DISCLOSURE_DRAFT.md`; author packet | `AUTHOR CONFIRMATION` | 作者确认事实、paper section、live form 和全体责任语言 |
| Anonymous supplement availability | `SUPPLEMENT_AUTHOR_PER_FILE_REVIEW_V2.md` | `HOLD`, candidate-only | subject-bound production candidate、author review、privacy/archive/verify-extract receipts |
| Fresh-install reproduction | readiness `R4`; ledger `:137-143` | `HOLD` | clean-install and hash-bound reproduction receipt |

## 11. Mechanical transfer map

1. `main.tex:32-50`：用第 1.1 节 abstract；不填未来实验结果。
2. `main.tex:62-83`：用第 1.2 节贡献边界。
3. `main.tex:200-203,235-302`：用第 2 节，固定 mask-free 与 implemented mask-bearing 的术语边界。
4. `main.tex:333-345,487-516`：用第 4 节，保留 D14--D16 的 descriptive 统计单位。
5. `main.tex:518-535`：保留已有 bounded Superko pilot/extension 的真实 tier；另加第 3.1 节 D19 status，不加入 D19 数字。
6. `main.tex:550-576`：用第 6 节 limitations。
7. `main.tex:578-599`：用第 7 节 conclusion 和第 9.1 节 reproducibility；AI-use 必须另按第 8 节作者确认。
8. 任何 `HOLD / FUTURE-ONLY` 段落在对应 gate 前不得进入正面结果表、摘要结果句或结论结果句。

## 12. Final no-overclaim gate for this draft

- 不把 mask-free history witness 写成 same implemented observation/mask witness。
- 不把 bounded search miss 写成不存在性证明。
- 不把 D19 protocol/preflight 写成 formal experiment、结果或 null effect。
- 不把 D14--D16 pooled records 写成 independent-game samples、confidence intervals、hypothesis tests 或 global ranking。
- 不把 D17/D18 execution/integrity completeness 写成 scientific pass。
- 不把 candidate-only supplement、contract-only reproduction 或未确认 AI-use wording 写成已完成发布/合规。
- 只要以后改动 `main.tex`，就把当前 PDF-bound ledger/review/gate 视为需要重新绑定的历史快照。
