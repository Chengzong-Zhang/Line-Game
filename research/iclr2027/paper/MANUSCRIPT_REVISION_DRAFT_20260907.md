# LIFELINE-RL bounded manuscript revision draft

状态日期：2026-09-07  
用途：当前 `main.tex` 的可移植修订草稿；不代表已经编译、审稿、绑定或投稿。  
规则：D19 相关段落全部是 `FUTURE-ONLY`，在正式 receipt 和独立 verifier 通过前不得填入数字。

## Recommended title

```latex
\title{LIFELINE-RL: A Replayable Benchmark for Logical Connectivity
and History-Dependent Legality in Self-Play}
```

## Abstract replacement

```latex
\begin{abstract}
We introduce \lifeline{}, a deterministic self-play benchmark that separates
physical occupancy, player-specific logical connectivity, cascading removal,
and repetition history. Complete side-five enumeration finds reachable
differences in latent logical edges but no decision-relevant difference in
legal actions, next Grid observations, exact values, shared-action $Q$ values,
or optimal actions. A standard-start side-six paired-history witness reaches
the same mask-free Topology projection while Superko changes the legality of
one shared placement. Because the implemented legal-action masks differ,
this witness is not a same-implemented-observation-and-mask pair and does not
establish representation insufficiency.

We additionally report a frozen D14--D16 comparison of a padded CNN,
physical-edge Grid-GNN, and typed-edge Topology-GNN on jointly trained sizes.
The resulting seed-level summaries are descriptive and receipt-bound.
Duplicated deterministic trajectories, architecture confounding, and the
absence of a feature-isolating same-backbone ablation preclude claims of a
learned feature benefit, global representation ranking, relative
sample-efficiency improvement, or unseen-size generalization. We therefore
present \lifeline{} as a replayable benchmark and rule/state-audit resource,
with the remaining construct-validity question stated explicitly.
\end{abstract}
```

## Introduction scope paragraph

```latex
\paragraph{Scope of the current manuscript.}
We use topology and history to denote simulator-state components and declared
observation channels, not established sources of learning improvement. The
current evidence supports a benchmark construction claim, a side-five
negative result, a side-six history-dependent legality witness under a
mask-free projection, and descriptive accounting of the frozen D14--D16
protocol. It does not establish that logical edges or compact history improve
learning, that any model family is globally superior, or that the benchmark
generalizes to unseen sizes.
```

```latex
Our contributions, each tied to an auditable artifact and an explicit
boundary, are:
\begin{enumerate}
  \item a tested variable-size environment with exact snapshots, legal masks,
  replayable trajectories, and cross-engine parity traces;
  \item exhaustive side-five diagnostics and a replay-verified side-six
  paired-history witness that distinguish latent topology aliasing from
  history-dependent legality under a deliberately weaker mask-free projection;
  and
  \item a receipt-bound D14--D16 descriptive evaluation containing 15 training
  tasks, 315 evaluation tasks, 1,500 self-play games, 3,000 updates, and
  30,600 task-indexed replay-verified game records, without a causal
  representation claim.
\end{enumerate}
```

## State-aliasing replacement paragraph

```latex
\paragraph{Evidence and boundary.}
The complete side-five state graph contains 25,096 states and 67,505
transitions. Across all 1,088 topology-distinct Grid-equivalent pairs, the
exhaustive audit finds no difference in legal actions, next Grid observations,
exact values, shared-action values, or optimal-action sets. This is a
side-five negative result only; it is not a nonexistence result for larger
boards and does not imply that Grid is non-Markov or strategically
insufficient across the benchmark family.

At side six, two legal histories from the standard start reach identical
board values, typed logical-edge sets, player to act, consecutive-pass count,
and terminal status under the mask-free Topology projection. A shared
placement is legal after one history and rejected after the other exactly by
Superko. The legal-action masks nevertheless differ. Thus the witness
establishes history-dependent legality for the mask-free projection, but not
equal implemented Grid or Topology observations, a same-observation-and-mask
future-decision consequence, different exact values or optimal actions, or a
learning benefit.
```

## Protocol and results interpretation

```latex
\subsection{Compute matching and statistics}

The learned model families share the training seed schedule, self-play
procedure, search budget, optimizer, checkpoints, evaluation schedule, and
approximately matched parameter counts. These controls make the comparison
more reproducible, but they do not make the architectures, relation sets,
FLOPs, memory use, transition counts, wall time, or evaluation compute
equivalent. In particular, the Grid-GNN and Topology-GNN comparison changes
both relation inputs and hidden width, while the CNN introduces a broader
architectural difference.

The primary descriptive unit is the training seed. Each final seed-level
matchup contains 100 same-seed color-swapped pairs, and the reported medians
and ranges summarize the five seed-level scores. Repeated deterministic
trajectories are not independent game-level observations. Accordingly, these
summaries characterize behavior under the frozen protocol; they do not
identify a causal feature effect, provide a global model ordering, or support
independent-game or multiple-comparison inference.
```

```latex
\subsection{Feature-isolating ablation status}

At the current evidence cutoff, no formal D19 training or evaluation result
is included. Consequently, the present manuscript makes no claim about the
isolated effect of logical-edge or compact-history inputs. The D19-v2
candidate is a pre-registered same-backbone $2\times2$ design, not an
executed experiment.
```

## Limitations replacement

```latex
\begin{itemize}
  \item The side-six paired-history witness is equal only under a mask-free
  Topology projection. Its legal masks differ, so it is not a
  same-implemented-observation-and-mask decision witness and does not
  establish a learned representation benefit.
  \item The exhaustive negative result is restricted to the standard
  side-five state graph. It does not establish that larger boards lack
  decision-relevant history or topology effects.
  \item The D14--D16 results are descriptive summaries of a frozen protocol.
  The seed-level unit is primary, while repeated deterministic trajectories
  limit the effective evaluation support and preclude independent-game
  inference.
  \item Grid-GNN and Topology-GNN differ in relation inputs and hidden width,
  and the CNN differs more broadly. Parameter-count matching does not remove
  architectural, FLOP, memory, transition, or wall-time confounds.
  \item The learned comparison covers jointly trained sizes only. Unseen-size
  generalization, cross-game transfer, stronger opponent calibration, and
  search-budget matching remain untested.
  \item The history intervention is policy- and sample-dependent. Its bounded
  or null observations do not show that Superko is unnecessary or that
  history features are irrelevant.
  \item No formal D19 same-backbone factorial result is included at the
  current evidence cutoff. A future feature ablation would test a model-input
  intervention, but would not by itself establish the stronger
  same-observation-and-mask construct.
  \item \lifeline{} is one hand-designed game. The current evidence therefore
  supports a benchmark and rule-accounting resource, not a general claim
  about representation choice across games or learning systems.
\end{itemize}
```

## Conclusion replacement

```latex
\lifeline{} provides a replayable environment in which physical occupancy,
logical connectivity, cascading removal, and repetition history are separated
and auditable. Complete side-five enumeration gives a decision-relevant
negative result. A dual-engine side-six paired-history witness shows that
identical mask-free topology can nevertheless have different Superko
legality, while the differing legal mask prevents this pair from establishing
an alias under the implemented observation.

The D14--D16 model results are retained as descriptive, receipt-bound
observations on jointly trained sizes. They do not establish a learned
benefit from logical edges or compact history, a global representation
ranking, relative sample-efficiency improvement, or unseen-size
generalization. The remaining scientific steps are a prospectively
diversified evaluation and a formally verified same-backbone factorial
ablation; until those results pass their respective gates, the stronger
construct-validity claim remains open.
```

## FUTURE-ONLY D19 insert

```latex
% FUTURE-ONLY: insert only after the formal D19 execution gate,
% independent result verification, and compute-accounting checks pass.
\subsection{Feature-isolating ablation}

We evaluated a $2\times2$ factorial design that toggles logical-edge inputs
and compact-history inputs independently. All four arms use the same
backbone, parameterization, initialization protocol, optimizer, training
schedule, and paired evaluation plan; only the two pre-registered input axes
are varied.

We report the pre-specified paired seed-level contrasts for the logical-edge
effect, compact-history effect, and their interaction, stratified by the
tested evaluation condition. The corresponding estimates and uncertainty
summaries are taken directly from the verified D19 aggregate.

The result supports only a protocol-bounded statement about the effect of the
toggled input on the measured metric under the tested sizes, opponent,
training budget, and evaluation contract. A contrast in one condition does
not establish universal representation superiority, TopologyHistory
necessity, unseen-size generalization, or a same-observation-and-mask
future-decision consequence. If the pre-specified contrasts are inconclusive,
we report them as inconclusive under this protocol rather than as evidence of
no effect.
```

## 必须执行的文字审核

- 全文搜索并逐项处理 `non-Markov`、`necessary`、`superior`、`ranking`、
  `sample efficiency`、`zero-shot`、`unseen-size`、`generalization`、
  `same observation`、`same mask`；每项必须有对应的正式 evidence，否则删去或
  改成未验证假设。
- 所有 D17/D18/D19 数字都必须从当前 hash-bound receipt 重新生成；preflight、capacity
  planning、smoke、pilot 不能出现在正面结果表中。
- 任何正文修改后重新编译 PDF、渲染全部页面、检查文本/字体/匿名性/链接/引用，并
  新建与 PDF SHA-256 绑定的 QA、blind review 和 submission gate。
- 继续单独完成 AI-use author facts、anonymous supplement v2、clean-install receipt、
  per-file author review、subject-bound archive 和 live form；本草稿不构成这些 gate
  的批准。

