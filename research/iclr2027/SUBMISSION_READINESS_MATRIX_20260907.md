# LIFELINE-RL 投稿就绪矩阵（2026-09-07）

状态：`NO — needs revision`。本矩阵是独立审计计划，不是作者批准、官方 ICLR 评分、上传回执或投稿授权。

## 评分边界

当前 reviewer 对精确 `main.pdf`（SHA-256 `848C60359A0DCD829E33E8E0388F5FA0AA136A2E045215E0B8D63A8ABFFA99F6`）冻结为 `4/10 - Weak Reject`、confidence `4/5`。其 score-driving blockers 为：

- same-observation-and-mask 的构念效度问题未闭合；
- 缺少 same-backbone、feature-isolating causal ablation；
- 重复 deterministic trajectories、弱对手和有限 seed summaries 使实证支撑不足；
- 单一 hand-designed game、jointly trained sizes、无 unseen-size/cross-game/强对手证据。

技术 PDF QA PASS 只说明该组 bytes 的页面、字体、链接、匿名元数据等检查结果，不改变 scientific readiness。`C:\coding\Agent\ICLR\reports\INDEPENDENT_REVIEWER_MODEL.md` 描述的是 uncalibrated、nonofficial、prompt-only review workflow，且明确禁止 acceptance prediction；它只能提供结构化诊断，不能替代官方 OpenReview 结果。

## 科学 readiness

| ID | Gate / blocker | 当前状态 | 证据 | 关闭条件 | 责任 |
|---|---|---|---|---|---|
| S1 | 构念效度：same observation + same mask + future decision | **OPEN / score-driving** | `paper/CLAIM_EVIDENCE_LIMITATION_V6.md:118-124`；`reviews/iclr2027_postrun_independent_review_v6_848C6035.md:26-40` | 有界搜索找到并由独立 verifier 复核；或论文删除/降级所有依赖该 claim 的 framing | 作者决定解释；审计可复核 |
| S2 | D19 same-backbone 2×2 ablation | **PLANNED / FUTURE-ONLY** | `SUBMISSION_GAP_ANALYSIS_20260907.md:40-63`；`paper/MANUSCRIPT_REVISION_DRAFT_20260907.md:183-209` | formal receipt + independent aggregate/verifier + parameter/seed pairing + compute accounting；无结果前正文不填数字 | 运行需作者/预算 gate；审计验证 |
| S3 | D14--D16 causal/statistical interpretation | **BOUNDED PASS** | `paper/CLAIM_EVIDENCE_LIMITATION_V6.md:66-71` | 最终正文只写 five-seed descriptive summaries；明确重复轨迹非独立样本、无 global ranking/sample efficiency | 写作后由作者确认 |
| S4 | D17/D18 scientific gate | **FAIL-CLOSED** | `paper/CLAIM_EVIDENCE_LIMITATION_V6.md:81-97`；`SUBMISSION_GAP_ANALYSIS_20260907.md:32-35` | 不需要“修饰数字”关闭；只能以 status/limitation 报告，或由新的正式设计独立通过科学 gate | 审计保持 fail-closed |
| S5 | 对手、有效支持与外推 | **OPEN / score-driving** | `reviews/iclr2027_postrun_independent_review_v6_848C6035.md:30-40` | 至少完成预注册 diversity/effective support、opponent calibration/search sweep、held-out size（若仍保留相应 claim）；否则收窄 contribution | 作者选择是否投入 |
| S6 | 论文文字一致性 | **OPEN** | `paper/MANUSCRIPT_REVISION_DRAFT_20260907.md:211-223` | 全文清理 `non-Markov/necessary/superior/ranking/sample efficiency/zero-shot/generalization/same observation/same mask`；每项均有对应 formal evidence | 作者最终批准 |

## 论文与 artifact gates

| ID | Gate | 当前状态 | 关闭条件 |
|---|---|---|---|
| A1 | Final paper bytes | **OPEN** | 依据最终 source/config/evidence 重编译；新 PDF hash、文本、字体、页数、引用、链接、匿名性和逐页渲染 QA 全部通过 |
| A2 | Fresh blind review / submission gate | **OPEN** | 对 exact final PDF 重新生成 hash-bound blind review 与 gate；旧 `4/10` 不自动迁移，新分数需以新 artifact 为准 |
| A3 | D19 numeric hygiene | **OPEN** | D19 数字只有在 formal execution + independent verification 后才可入正文；在此之前所有 D19 数字一律 `planned/future-only` |
| A4 | Claim-evidence ledger | **OPEN** | 每个保留 claim 指向最终 evidence/hash/limitation；任何 PDF/evidence/ledger 变化都触发 fresh binding |

## Anonymous supplement / reproduction gates

| ID | Gate | 当前状态 | 证据 | 关闭条件 |
|---|---|---|---|---|
| R1 | Anonymous supplement v2 topology | **OPEN / candidate-only** | `SUPPLEMENT_AUTHOR_PER_FILE_REVIEW_V2.md:1-17,23-46` | final subject commit 后重建 profile/allowlist，覆盖新论文和新证据；不能沿用旧 120-payload/124-member candidate |
| R2 | Per-file author review and identity | **OPEN** | `SUPPLEMENT_AUTHOR_PER_FILE_REVIEW_V2.md:71-91` | 作者私下完成 identity list、逐文件 include/exclude/transform 决策、identity scan 与 coverage receipt；不把私密身份输入写入公开矩阵 |
| R3 | Final archive / verify-extract | **OPEN** | `SUBMISSION_GAP_ANALYSIS_20260907.md:121-129` | subject-bound archive、manifest/hash、clean-copy independent verify-extract PASS；raw trajectories/checkpoints/private paths excluded |
| R4 | Fresh install | **OPEN** | `SUBMISSION_GAP_ANALYSIS_20260907.md:131-134`；`paper/CLAIM_EVIDENCE_LIMITATION_V6.md:137-143` | clean export/build、fresh install、scoped tests、TeX+BibTeX runtime closure 和 hash-bound reproduction receipt；retained env PASS 不够 |

## AI-use / live form gates

| ID | Gate | 当前状态 | 关闭条件 | 不能由审计推断的事实 |
|---|---|---|---|---|
| G1 | Paper AI-use statement | **OPEN / P0, non-score-driving** | 作者完成真实 inventory，批准 wording；写入论文后 rebuild 并重新做 A1/A2 | exact tools/models、任务影响、human verification、unpublished-material transmission、co-author use |
| G2 | Submission-form AI disclosure | **OPEN / separate P0** | 作者在 live form 按实际字段填写，并与 G1 一致 | live field names、required markers、平台选项和最终答案 |
| G3 | Live OpenReview form | **OPEN / unverified** | 作者检查 exact PDF/supplement bytes、title/authors/area/COI/其他必填项并亲自完成提交前确认 | 不能用本地 draft、旧 gate、模拟 review 或仓库元数据代替 live form |
| G4 | External upload/submission | **NOT AUTHORIZED** | 明确的 action-time confirmation，目标、文件、bytes、平台和作者批准均核对后才可行动 | 审计 agent 不代上传、不代提交 |

`AI_USE_DISCLOSURE_DRAFT.md` 明确要求作者逐项确认 AI 使用、输出、人类复核和 unpublished material；不要把它当成已完成披露。`paper/CLAIM_EVIDENCE_LIMITATION_V6.md:141-152` 也将 AI-use、identity coverage、archive 和 live form 保持为 OPEN。

## 最短可行路线与最终判定

最短路线是：

1. 先完成 D19 runner/verifier 的静态与预算 gate；若需要付费 GPU，等待新的精确一次性授权。
2. 执行并独立验证 D19 2×2；任何结果在验证前都保持 `planned/future-only`。
3. 有界完成 same-observation-and-mask 机制审计；成功则谨慎补强，失败则收窄 framing。
4. 据结果修订论文，生成新 PDF，完成 A1/A2/A4。
5. 重建并由作者审核匿名 supplement，完成 R1--R4。
6. 完成 G1--G4 的作者 gate，最后才可把 readiness 改为可进行最终投稿检查。

当前不能自动关闭的最小集合是 `S1/S2/S5/S6/A1/A2/A4/R1/R2/R3/R4/G1/G2/G3/G4`。因此最终状态仍为 `submission_ready=NO`，而不是“只差上传”。

## 2026-09-07 live update（追加）

- D19 verifier contract hardening passed under normal project permissions: `10/10`
  verifier tests and `13/13` runner + matched-history preflight tests. The verifier now
  loads future checkpoints on CPU with `weights_only=True` and checks the exact 35-entry,
  63,235-parameter state-dict contract. This is an artifact-integrity improvement only;
  S2 remains `PLANNED / FUTURE-ONLY`.
- A new n=6 same-observation-and-mask search was safely stopped at the 20,000-state
  checkpoint before its requested 25,000-state budget. It is recorded as
  `INTERRUPTED_BEFORE_COMPLETION`, not as `NOT_FOUND_WITHIN_DECLARED_BUDGET`; S1 remains
  open and no new paper claim is admitted.
- A separate live reviewer audit records the current ICLR reviewer model boundary and
  the frozen `4/10 Weak Reject` / `FAIL` decision without treating it as an official ICLR
  prediction: `reviews/ICLR_REVIEWER_LIVE_AUDIT_20260907.md`.
