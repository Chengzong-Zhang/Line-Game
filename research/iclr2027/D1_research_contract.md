# D1 research contract: LIFELINE-RL

Date frozen: 2026-08-25

Target: ICLR 2027 main conference

Paper type: benchmark and empirical study with a topology-aware reference model

## 1. Working title

**LIFELINE-RL: A Benchmark for Topology-Aware and History-Dependent Self-Play**

Alternative title if the representation result becomes the dominant
contribution:

**Topology Matters: Structured State Representations for Dynamic-Connectivity
Self-Play**

The final title is selected on D20 from the evidence. The first title is the
default; the second must not be used unless the topology-aware model has a
clear, compute-matched advantage.

## 2. One-sentence thesis

LIFELINE-RL is a reproducible self-play benchmark in which physical board
occupancy, player-specific logical connectivity, cascading component removal,
and history-dependent repetition constraints expose state-representation and
size-generalization challenges that are not captured by occupancy-only board
observations.

## 3. Primary research question

**RQ1.** When a board game has player-specific dynamic connectivity and
history-dependent legal actions, which state representations are sufficient
for sample-efficient self-play and generalization to unseen board sizes?

Secondary questions:

- **RQ2.** Does explicitly providing the logical edge graph improve policy and
  value learning over representations that expose only point occupancy and
  physical lattice adjacency?
- **RQ3.** Do topology-aware, size-agnostic graph models generalize better from
  small training boards to larger test boards?
- **RQ4.** How much difficulty is introduced separately by cascading removal,
  Superko, and exact terminal territory scoring?

## 4. Frozen contribution contract

The submission will claim at most the following four contributions.

1. **Environment.** A tested, deterministic, headless LIFELINE-RL environment
   with legal-action masks, state cloning, replay, variable board sizes, and a
   documented Gymnasium/PettingZoo-compatible interface.
2. **State analysis and diagnostics.** A formal decomposition of the full game
   state into physical occupancy, logical connectivity, turn variables, and
   repetition history, plus paired-state diagnostics that test whether reduced
   observations alias decision-relevant states.
3. **Benchmark.** A compute-matched comparison of search and neural self-play
   baselines, including within-size learning, cross-size generalization, rule
   ablations, statistical uncertainty, and runtime cost.
4. **Reference model.** A relation-aware graph policy/value network that uses
   physical lattice edges and player-specific logical edges. It is a reference
   method, not a claimed breakthrough, unless the experiments justify a
   stronger statement.

The paper will not claim that a new game alone is a learning-algorithm
contribution. It will not claim non-Markovianity, improved sample efficiency, or
improved size generalization until the corresponding tests pass.

## 5. Full-state and observation contract

For a two-player game, the full simulator state is modeled as

```text
x_t = (B_t, E_t^black, E_t^white, H_t, p_t, c_t, z_t)
```

where:

- `B_t` is point occupancy: empty, node, or line for each player;
- `E_t^player` is that player's explicit logical edge set;
- `H_t` is the set of previously visited state hashes used by Superko;
- `p_t` is the player to act;
- `c_t` is the consecutive-skip count;
- `z_t` contains terminal state. Product-level resignation is deliberately
  excluded from the frozen training environment.

The benchmark will compare the following observation protocols:

- **Grid:** occupancy, coordinates, player to act, consecutive-PASS count, and
  legal-action mask;
- **GridGraph:** Grid plus the fixed six-neighbor triangular lattice;
- **Topology:** GridGraph plus black and white logical-edge relations;
- **TopologyHistory:** Topology plus a pre-registered compact history feature,
  such as the last `k` states or a repetition-risk feature. This is an ablation,
  not a mandatory main model.

The simulator always retains the exact full state. Observation variants change
only what the learning system receives.

## 6. D1 evidence audit

### Verified from the current engine

- The Web rule engine stores physical occupancy and player-specific logical
  edge sets separately.
- Connectivity and cascading removal use the explicit edge graph.
- Superko legality checks use a set of hashes of previously visited states.
- Legal moves can be enumerated and simulated without hidden randomness.
- Board sizes 5 through 15 and two- or three-player games are supported by the
  Web engine. The sprint uses two players only.

### Verified reachable weak-aliasing witness

A deterministic replay search on a two-player board of side length 5 found two
legal histories that terminate at the same physical grid and the same player
to act (`WHITE`) but different white logical-edge sets.

History A:

```text
(0,3), (0,4), (0,1), (1,3), (2,1), (2,0),
(2,2), (3,1), (0,4), (1,1), (0,2), (1,3)
```

History B:

```text
(0,1), (3,1), (0,4), (1,1), (2,2),
(2,0), (0,3), (1,3), (1,2), (0,2)
```

The white edge `(1,3)--(4,0)` exists after History A and is absent after
History B; the physical point states and player to act are identical. Replaying
the common legal action `(0,4)` preserves distinct full successor edge states.

This witness establishes **reachable full-state aliasing under an
occupancy-only observation**. It does not establish that the omitted edge
changes reward, the visible next board, the legal-action set, or the optimal
policy. The fixture is now covered by a permanent regression test, but no
decision-relevance witness was found. Such a witness remains mandatory before
the paper can claim that occupancy-only observations are non-Markov or
strategically insufficient.

### Current evidence boundary

- Complete side-five analysis found no reachable Grid-equivalent pair with
  different legal actions, visible next boards, exact values, Q values, or
  optimal moves; bounded side-six search also found no strict witness.
- Complete side-five analysis found no natural Superko rejection, and bounded
  side-six search found no same-topology history pair for which a specific
  action is legal in only one state.
- Any learning, sample-efficiency, or cross-size advantage of the proposed
  topology representation.

The weak fixtures and their regression tests are complete. The remaining
positive findings are later scientific gates, not assumed facts.

## 7. Falsifiable hypotheses and failure rules

### H1: decision-relevant state aliasing

There exist reachable full states with identical implemented Grid observations
but a different shared-action transition, return, value target, or incompatible
optimal-action requirement. A legal-action difference belongs only to the
separately named mask-free occupancy projection because Grid exposes the mask.

- **Support:** produce reproducible paired states and a witness action or
  policy; add them as deterministic tests.
- **Falsification rule:** if exhaustive small-board search and targeted random
  search find only redundant edge differences, remove the non-Markov claim and
  present topology as an architectural inductive bias only.

### H2: topology improves learning

Under matched parameter, self-play, search, and environment-step budgets, the
Topology model improves policy/value prediction, learning speed, or arena win
rate over GridGraph.

- **Support:** the pre-registered primary metric improves with uncertainty that
  excludes zero across the main seeds.
- **Falsification rule:** report no advantage and do not select favorable seeds
  or unequal search budgets.

### H3: topology improves size generalization

A size-agnostic Topology model trained on side lengths 5, 7, and 9 loses less
performance than Grid/Graph baselines when evaluated without fine-tuning on
side lengths 10 and 12.

- **Support:** a smaller cross-size Elo or win-rate drop in color-balanced arena
  evaluation.
- **Falsification rule:** if all models fail, the benchmark finding may remain,
  but the paper cannot claim successful generalization.

### H4: rule mechanisms create separable difficulty

Cascading removal and Superko cause measurable, distinct changes in search
cost, policy learning, or generalization.

- **Support:** pre-registered rule ablations with identical training budgets.
- **Falsification rule:** describe the ablations as negative results rather
  than inventing post-hoc explanations.

## 8. Frozen task scope

### Mandatory

- Two-player games only;
- side lengths 5, 7, and 9 for training;
- side lengths 10 and 12 for zero-shot evaluation;
- side length 15 as a stretch evaluation only;
- terminal win/loss/draw reward without hand-shaped intermediate rewards;
- exact rules for real transitions and terminal scoring;
- deterministic seeds, complete action logs, and replayable matches.

### Explicitly out of scope for this submission

- three-player learning and coalition analysis;
- human-subject experiments;
- Web deployment of trained policies;
- UI redesign or new gameplay rules;
- language-model agents;
- large hyperparameter sweeps without a fixed primary comparison;
- claims that performance on LIFELINE alone establishes universal superiority.

## 9. Mandatory baselines

Search and non-learning:

- Random legal policy;
- one-step greedy policy with a documented score;
- existing Minimax at depths 2 and 3, explicitly noting its top-20 move cap;
- UCT-MCTS under fixed simulation budgets.

Neural self-play:

- AlphaZero-style self-play with a parameter-matched Grid or GridGraph model;
- the same training system with the Topology model;
- TopologyHistory as an ablation if it is stable by D14.

Maskable PPO is a stretch baseline. It must not delay the common self-play and
arena infrastructure.

## 10. Evaluation protocol

Primary metrics:

- color-balanced win/draw/loss rate and Elo;
- environment steps and self-play games to a fixed arena strength;
- zero-shot performance drop from seen to unseen board sizes;
- policy accuracy and value error on paired-state diagnostics;
- wall-clock time, simulations per second, and peak compute use.

Minimum statistical protocol:

- five seeds for the central GridGraph-vs-Topology comparison when feasible;
- at least three seeds for expensive auxiliary ablations;
- at least 200 color-balanced evaluation games per main matchup;
- confidence intervals reported for every primary comparison;
- all seeds included, including failed or unstable runs;
- matched model size, MCTS simulations, training games, and evaluation budget.

The machine-readable minimum matrix is in `experiment_matrix.csv`.

## 11. Paper claim-to-evidence map

| Claim | Required evidence | Gate |
| --- | --- | --- |
| Environment is correct | rule tests, replay tests, Web/reference parity | D5 |
| Environment is usable | throughput and determinism benchmark | D5 |
| Grid observations alias full states | reachable paired-state witnesses | weak form verified; strict n=5 form falsified at D6; n=6+ open |
| Benchmark is non-trivial | search and self-play baseline matrix | D13 |
| Topology helps learning | matched-budget multi-seed comparison | D18 |
| Topology helps size generalization | unseen-size arena evaluation | D18 |
| Results are reproducible | configs, seeds, logs, checkpoints, anonymous code | D23 |

## 12. Reviewer-risk register

| Likely objection | Required response |
| --- | --- |
| This is merely another board game | isolate dynamic-connectivity and history diagnostics; show controlled rule ablations |
| Logical edges are reconstructible from the grid | provide reachable counterexamples and test decision relevance; weaken the claim if relevance fails |
| The proposed model just has more parameters | match parameter count and training/search budgets |
| AlphaZero is an expected baseline | use one shared AlphaZero-style pipeline for GridGraph and Topology |
| Results are specific to one hand-designed game | provide cross-size and rule-variant generalization; add a synthetic dynamic-connectivity task only if core results are complete |
| Baselines are weak or unfair | include UCT-MCTS, disclose Minimax truncation, publish configs and compute |
| Environment implementation is unreliable | differential replay tests, deterministic fixtures, and a versioned rules specification |

## 13. D1 exit checklist

- [x] Working title selected.
- [x] Primary and secondary research questions frozen.
- [x] Four contribution claims bounded.
- [x] Full-state and observation variants specified.
- [x] Falsifiable hypotheses and failure rules written.
- [x] Mandatory baselines and evaluation metrics frozen.
- [x] Minimum experiment matrix created.
- [x] Weak reachable topology-aliasing witness recorded.
- [x] Non-goals explicitly listed.
- [x] LaTeX paper outline created.

## 14. Immediate D2 actions

1. Convert both aliasing histories into a deterministic regression test.
2. Build a search that targets decision-relevant edge and Superko witnesses and
   emits replayable JSON fixtures.
3. Freeze the headless environment state schema and canonical action indexing.
4. Measure transition throughput with exact terminal scoring disabled between
   terminal states, without changing move legality.
5. Create the experiment manifest and seed registry before launching training.

## 15. D6 evidence amendment: hypothesis outcome, not a scope change

Recorded on 2026-08-25 after complete side-five enumeration.

The implemented reduced observation is now named explicitly:

```text
phi_grid(x) = (board, fixed coordinates, player, consecutive skips,
               legal-action mask)
```

The narrower occupancy projection `psi_occ = (board, player, consecutive
skips, terminal flag)` is used only when a diagnostic deliberately excludes the
mask. A legal-action difference is evidence against `psi_occ`, but it is not an
alias under `phi_grid`, because the implemented mask exposes that difference.

The D6 evidence falsifies the positive form of H1 on side length five. Complete
enumeration produced 25,096 reachable raw states, 67,505 transitions, 976 Grid
alias groups, and 1,088 same-Grid/different-topology pairs. Across all such
pairs, the exact audit found zero differences in legal actions, next implemented
Grid observations, terminal values, shared-action Q values, or optimal-action
sets. The same graph is a DAG and contains no naturally triggerable Superko
rejection. Therefore neither requested strict counterexample class exists at
side length five under the frozen two-player rules.

This is not a nonexistence claim for sizes 6--15. Larger-board searches remain
bounded experiments and must report `NOT_FOUND_WITHIN_BUDGET` unless a replayed
witness is found. Until then the paper may claim reachable weak full-state
aliasing and an exhaustive small-board negative result; it may not claim that
Grid observations are non-Markov or that topology/history is
information-theoretically necessary. The topology representation remains an
inductive-bias hypothesis to be tested by later learning experiments.

The exact certificate is the corrected all-PASS solver in
`scripts/d6_redteam_exact_audit.py`. An earlier solver omitted 2,080 terminal
PASS branches reachable from zero prior skips; that omission changed 294 state
values and 1,272 optimal-action sets, so its value table is superseded even
though its zero-strict-pair count happened to agree.
