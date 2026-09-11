# ICLR reviewer live audit for LIFELINE-RL

日期：2026-09-07（Asia/Shanghai）  
审计对象：当前工作树 `research/iclr2027/paper/main.pdf` 及其绑定的审稿、证据和投稿 gate。

## 1. Reviewer 能做什么

当前使用的 reviewer 依据是 `C:\coding\Agent\ICLR\reports\INDEPENDENT_REVIEWER_MODEL.md`、
`TASK_CONTRACT.md` 和 `STAGE1_HANDOFF.md`。该 reviewer 是离线、prompt-only、未校准的
三视角 manuscript diagnostic workflow；它要求匿名初稿、页码/原文引用和独立 response
receipt，但明确禁止 acceptance prediction，并不输出官方 ICLR 概率或官方评分。

因此这里的分数是内部修订信号，不是官方评审结果；OpenReview 官方数据采集在该 agent
项目中仍被 HTTP 403 阻断，PeerRead 结果也不能替代官方 ICLR calibration。

## 2. 当前 PDF 结论

本次 live 审计重新核对的 PDF SHA-256 是
`848C60359A0DCD829E33E8E0388F5FA0AA136A2E045215E0B8D63A8ABFFA99F6`，449,839 bytes，
11 页 US Letter。对应的 blind-first reviewer（2026-09-01，在读取仓库证据前冻结）给出：

- 科学 soundness：2/4；novelty：2/4；empirical evidence：2/4；presentation：3/4；
  reproducibility：3/4；
- 综合：**4/10，Weak Reject，confidence 4/5**；
- v7 submission gate：**FAIL / Needs revision；submission readiness = NO**。

PDF 页面、字体、匿名 metadata 和渲染 QA 是 PASS，但只对上述精确 bytes 有效；它们不
等于科学充分性、clean install、匿名 supplement、作者确认或投稿完成。

## 3. Score-driving scientific blockers

| blocker | 现有证据 | 关闭条件 |
|---|---|---|
| same implemented observation + same legal mask 下的 future decision | side-6 只有 mask-free Topology 相等、legal mask 不同；n=5/5,000 的完整 bounded search 未找到；n=6 continuation 在 20,000/25,000 states 前中止 | 找到并由独立 verifier 复核 transition/value/Q/optimal-action consequence，或删掉依赖该构念的 framing |
| logical-edge × compact-history 的因果效应 | D19-v2 只有 CPU contract preflight；四臂 63,235 参数、同 seed 初始化和 tensor path 通过；无训练、无评估、无 checkpoint 结果 | formal receipt、独立 aggregate/verifier、paired seed contrasts、compute accounting 全通过 |
| 实证支撑的有效样本与对手强度 | D14--D16 为五 seed 描述性汇总；每个 direct-play task 只有两条 deterministic color-conditioned trajectories；UCT-MCTS-16 未做强度校准 sweep | 预注册多样 opening/trajectory、明确 seed/cluster 统计单位、强对手或 search-budget sweep |
| 外推 | 仅 jointly trained size 5/7/9；无可信 unseen-size/cross-game 结果 | 新的 held-out size/cross-game formal artifact；否则删除 generalization framing |

## 4. 当前已被证据支持的结论

- 环境有 exact snapshots、legal masks 和可回放轨迹；Python/Web parity 只覆盖已检查
  的 traces，不是 exhaustive cross-engine proof。
- side-5 完整枚举发现 latent logical-edge 差异，但在审计图内未发现 legal action、
  transition、exact value、shared-action Q 或 optimal-action 差异。
- side-6 的自然 paired-history witness 只支持：相同 mask-free Topology projection
  下，Superko 可使一个 shared placement 的合法性不同；因为 legal masks 不同，它
  不是 implemented observation/mask alias，也不支持学习收益或 TopologyHistory 优越性。
- D14--D16 的 15 training + 315 evaluation tasks、1,500 self-play games、3,000 updates、
  30,600 task-indexed replay-verified records 可作为 frozen five-seed descriptive evidence；
  不能作为 independent-game inference、global ranking、sample-efficiency 或 unseen-size
  generalization。
- D17/D18-v1 的 85/85 tasks 与 8,320/8,320 records 完成 canonical integrity，但 22/45
  D18 tasks 未通过 diversity criterion，科学 gate 仍 `FAIL_CLOSED`。

## 5. 论文与投稿剩余工作

### 必须写/重写

1. abstract/introduction：把中心贡献收窄为 replayable benchmark、state decomposition、
   side-5 negative result、mask-free history-legality mechanism 和 bounded accounting。
2. state-aliasing：明确 mask-free projection 与 implemented mask-bearing observation 的
   差别；不再使用 `non-Markov Grid`、`history is necessary for learning` 等未被证据支持
   的简写。
3. experiments/limitations/conclusion：把 D14--D16 明确写成 seed-level descriptive，
   把 D17/D18 写成 fail-closed artifact-governance outcome，把 D19 写成 preflight-only，
   不填任何未来数字。
4. AI use statement：按 ICLR 要求补入正文和 submission form，但必须先由作者确认工具、
   模型、任务、人工复核和 unpublished-material 传输事实；当前不能从 agent 标签或分支
   名推断。
5. supplement/reproduction：重建 subject-bound anonymous v2、逐文件 author decision、
   identity scan、clean-copy verify-extract 和 fresh-install receipt。

可直接移植的英文段落已经写入
`paper/MANUSCRIPT_REVISION_DRAFT_LIVE_20260907.md`；该稿没有改 `main.tex`，也没有把
未运行结果写进正文。任何移植都会触发新的 PDF hash、QA、review 和 gate。

### 实验优先级

1. **P0：D19-v2 formal same-backbone 2×2**，前提是先完成独立预算测量和新的执行边界；
   当前 runner 的 formal executor 仍 `NOT_IMPLEMENTED`，不能把 preflight 当结果。
2. **P0：same-observation/mask bounded audit**，n=5 完整 miss 只关闭了一个有限预算，
   n=6 continuation 是 interrupted progress；不要无界继续。若没有 witness，采用收窄
   framing。
3. **P1：diverse evaluation + stronger opponent + held-out size**，只有在仍要声称学习/外推
   时才值得投入；重复旧 D17/D18 deterministic trajectories 没有信息增益。

## 6. Final status

当前最诚实的状态是：**科学上可继续修订，技术 PDF 可读，但距离 ICLR 投稿仍是
`NO — needs revision`。** 本审计未上传、未投稿、未调用官方 OpenReview、未启动 GPU/AutoDL、
未执行 D19 formal training。

