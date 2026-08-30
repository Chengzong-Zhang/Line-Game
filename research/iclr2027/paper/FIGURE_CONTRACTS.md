# Paper figure contracts

## Rendering standard

- Canonical regeneration entry point: `paper/figures/build_figures.py`, run
  from the repository root. It reconstructs Figure 1 through the rules engine
  and asserts the frozen witness/aggregate shapes before writing any asset.
- Final paper assets are vector PDF; 320 dpi PNG copies are retained only for
  inspection and non-LaTeX previews.
- Figure text is locked to Times New Roman with STIX math so labels match the
  ICLR Times-family body typography. PDF/PS font type is 42 for embedded,
  searchable text.
- The palette uses one dark blue, one light blue, and one gold root plus neutral
  gray. Line style, markers, edge style, and panel position preserve distinctions
  without color.
- Axes report score rates as percentages. Denominators remain explicit in the
  chart note and LaTeX caption.

## Figure 1: shared board, different logical topology

- Question: can two legal histories yield the same implemented Grid view but
  different hidden logical edges?
- Takeaway: the verified side-five witness has identical occupancy, turn,
  pass count, and legal mask, while one white logical edge exists only in
  history A.
- Form: paired triangular-board diagrams reconstructed by the executable rules
  engine from `state_aliasing/pairs_v1.json`.
- Encoding: physical lattice in neutral gray; black logical edges are solid
  blue; white logical edges are dashed orange; node and line-point glyphs use
  both shape/size and color. A gray dotted segment in history B marks the
  location of the edge that exists only in history A; it is not a game edge.
- Limitation: the exhaustive side-five audit found no decision-relevant
  consequence; the figure illustrates latent topology aliasing only.

## Figure 2: five formal checkpoint probes

- Question: how does score against UCT-MCTS-16 vary across the five recorded
  checkpoints for each representation and evaluation size?
- Takeaway: trajectories are non-monotone and size dependent.
- Form: three small-multiple line charts, one per side length, with distinct
  markers and line styles as well as color.
- Source: `results/formal/d14_d16/aggregate_v1/arena_learning_curve.csv`.
- Denominator: 100 games at steps 40--160 and 1,000 games at step 200, pooled
  across five seed receipts.
- Limitation: five discrete probes are too sparse for a continuous learning
  claim; no AUC or fixed-strength sample-efficiency estimator was
  preregistered.

## Figure 3: final model-by-size-by-opponent score heatmap

- Question: what are the final score rates of each model against Random and
  UCT-MCTS-16 on the three jointly trained sizes?
- Takeaway: all Random cells exceed 0.5; against UCT-MCTS-16 seven cells are
  clear in the descriptive interval summary, one is borderline, and one is
  inconclusive.
- Form: paired 3x3 sequential heatmaps with exact score in every cell.
- Source: `results/formal/d14_d16/aggregate_v1/final_vs_search.csv`.
- Denominator: 1,000 games per cell; score is `(wins + 0.5 draws) / games`.
- Limitation: this is not raw win rate, a multiple-comparison test, or evidence
  about unseen sizes; uncertainty remains in Table 3 rather than being encoded
  by color.
