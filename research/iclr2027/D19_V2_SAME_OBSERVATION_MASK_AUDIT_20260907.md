# D19-v2 同 implemented observation-and-mask 决策 witness 审计

日期：2026-09-07

状态：**提前收尾；没有完成声明预算搜索，也没有产生正式 positive/negative 结果。**

## 实际完成内容

新增了两个只服务于本审计的脚本：

- `scripts/search_same_observation_mask_witness.py`：固定标准初始状态、`superko_mode=enforce`、FIFO breadth-first、PASS-first 后按点字典序；碰撞键固定包含实现的 topology observation（board、coordinates、physical edges、typed logical edges、current player、skip、legal-action mask）及显式 terminal flag。完整 action history 和 Superko history set 都必须不同；共享 legal actions 会逐一比较 successor observation/mask，并支持有节点上限的 exact minimax 检查。
- `scripts/verify_same_observation_mask_witness.py`：不导入搜索器，独立 replay 并核验 source hashes、严格 observation/mask 相等、共享合法动作、声明的 successor/decision difference，以及负结果不得升级为 nonexistence。

两者均已通过无写入的 Python compile check。

## 执行状态

已完成的仅是极小 smoke：

```text
search: n=5, max_states=10, max_depth=2, status=NOT_FOUND_WITHIN_DECLARED_BUDGET
verify: PASS, search_status=NOT_FOUND_WITHIN_DECLARED_BUDGET
```

smoke 产物：

- `results/validation/d19_v2_same_observation_mask_search_smoke_20260907.json`
- `results/validation/d19_v2_same_observation_mask_verification_smoke_20260907.json`

随后曾启动 side-5 的声明预算命令（30,000 states、depth 40、exact solver 30,000 nodes、最多 32 个 decision pairs），但按用户要求提前终止。终止前只看到一条 progress：`states_examined=5000`、`observation_collisions=4799`、`distinct_history_collisions=4799`；create-only 搜索产物不存在。因此这不是完成的 negative result，不能据此报告“未找到”。side-6 未启动。

## 证据与 claim 边界

本文件和 smoke 只证明新脚本的静态路径、预算边界及独立核验路径可运行；没有证明同 implemented observation-and-mask 的 transition、value 或 optimal-action witness 存在或不存在。

既有 side-5 完整精确负结果仍只支持其原有范围。既有 side-6 witness 仍是 mask-free topology 相等、legal mask 不等的 Superko legality witness；它没有被本审计升级为 stronger same-observation-and-mask decision witness，也不能支持 value、Q-value、optimal-action 或 regret 差异结论。

在完成声明预算搜索和可复核 receipt 之前，D19-v2 的 construct-validity blocker 应保持 **OPEN**；不得把本轮 smoke 或被中止的 5,000-state 中间进度写入论文正面结果、nonexistence 结论或训练收益 claim。

## 新增文件哈希

| 文件 | bytes | SHA-256 |
| --- | ---: | --- |
| `scripts/search_same_observation_mask_witness.py` | 22594 | `8D7075B2AA35CFD0488AAFC2481BE3705C71FE32F44EDC6AB7CDFBAED599EBBD` |
| `scripts/verify_same_observation_mask_witness.py` | 13022 | `1F73D3D92D4905038DB77FC5E13B7D311C1BE84F60C08E4E62A6908579FB524D` |
| `results/validation/d19_v2_same_observation_mask_search_smoke_20260907.json` | 3708 | `0AD2B8D68AFA0116554C9F4CB8C20EFF352E93B57E6FFEE952DBC03B03F200D8` |
| `results/validation/d19_v2_same_observation_mask_verification_smoke_20260907.json` | 1285 | `5F6B3152F64F78230616B3A62675A9E34B6B0FA49AD250564E388878D842B101` |

本审计记录为 append-only；未修改 `main.tex`、manifest/protocol、runner/verifier 或其他 agent 文件。

## 2026-09-07 执行更正（追加）

在上述记录之后，另行完成了一次较小但完整的 n=5 bounded run，未覆盖或替换
原有 smoke/中止记录：`max_states=5000`、`max_depth=10`、exact solver nodes
`0`、decision pairs `0`。命令正常到达 `STATE_BUDGET`，create-only 产物为
`results/validation/d19_v2_same_observation_mask_search_n5_5000s_d10_20260907.json`；
实际统计为 5,000 examined states、4,799 observation/history collisions、49,024
transition checks、113 terminal states，未找到 witness。对该完整 JSON 的独立 verifier
通过，产物状态为 `NOT_FOUND_WITHIN_DECLARED_BUDGET`。

这只是一个明确配置下的 bounded negative result，不是 side-5 穷尽、全尺寸非存在性
证明，也不关闭 construct-validity blocker；smoke 与此前被中止的 30,000-state 记录
仍按各自历史状态保留，均不得写成全局结论。

## 2026-09-07 n=6 continuation（追加）

随后启动了一个独立的 n=6、25,000-state、depth-20 搜索。它在达到
20,000 states 时记录了 21,188 个 observation collisions、21,188 个
distinct-history collisions，剩余 frontier 为 158,112；在这之前没有报告
same implemented observation-and-mask future-decision witness。由于 frontier
增长导致运行成本显著上升，进程在该 checkpoint 被安全中止，未生成脚本的最终
search JSON。因此本次 continuation 的状态是
`INTERRUPTED_BEFORE_COMPLETION`，不是 `NOT_FOUND_WITHIN_DECLARED_BUDGET`，也不
改变 S1 blocker。对应的 progress-only record 是
`results/validation/d19_v2_same_observation_mask_search_n6_20000_interrupted_20260907.json`。
