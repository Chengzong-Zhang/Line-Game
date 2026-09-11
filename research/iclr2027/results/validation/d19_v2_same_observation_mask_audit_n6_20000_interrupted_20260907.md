# D19-v2 same implemented observation-and-mask audit: n=6 interrupted progress

日期：2026-09-07（Asia/Shanghai）

状态：**INTERRUPTED_BEFORE_COMPLETION；不是 bounded negative result。**

## Scope

The existing deterministic breadth-first search was started with grid size 6,
an upper bound of 25,000 states, depth ceiling 20, no exact solver nodes, and
no decision-pair cap. It used the implemented topology observation, including
the legal-action mask, as the collision key; complete action histories and
Superko history sets were required to differ.

The process was safely stopped after the 20,000-state progress checkpoint when
the remaining frontier had grown substantially. The search script did not emit
its final JSON, so the partial counters below are recorded only to prevent the
run from being mistaken for a completed result.

## Observed progress

| counter | value |
|---|---:|
| states examined | 20,000 |
| observation collisions | 21,188 |
| distinct-history collisions | 21,188 |
| frontier remaining | 158,112 |
| requested state ceiling | 25,000 |
| GPU/network/training/evaluation | 0 / 0 / 0 / 0 |

No same implemented observation-and-mask future-decision witness was reported
before the stop. This is not a completed search result and does not support
`NOT_FOUND_WITHIN_DECLARED_BUDGET`, a nonexistence statement, prevalence, or
any learning/representation claim. The complete n=5, 5,000-state run remains
the only current bounded-negative artifact for this audit.

The machine-readable progress record is
`results/validation/d19_v2_same_observation_mask_search_n6_20000_interrupted_20260907.json`.

## Source and runtime binding

- search script: `8D7075B2AA35CFD0488AAFC2481BE3705C71FE32F44EDC6AB7CDFBAED599EBBD`
- engine core: `A3219C931608AB76F466CF5278E6297DDFDF128B19D721A16FAB895EB81E05E7`
- encoding: `B9A6A14CB627853936333968C8E931D7622B56AD6F0C48251B5E658D5494C33D`
- D19 manifest: `DD5718080492234FC33C8E67A2389D43C9F7B5368CAA76F9644503E6F8B5A18B`
- D19 protocol: `ACE2DA18E66E4DF5BC0E95EA61CB20A4990C2293AF032D7F2CCF52F403CFFF52`
- runtime: CPython 3.10.20, CPU-only Windows run

