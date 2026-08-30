# LIFELINE-RL ICLR 2027 blind-first 独立模拟审稿

## 哈希绑定与审稿协议

- 审稿对象：`research/iclr2027/paper/main.pdf`
- 完整 SHA-256：`3000054C0A1BDE8158AA0EBCF6E24AFB54DB15B2DB3AA3109B6D5E1FA6C9A981`
- 审稿日期：2026-08-30
- PDF 规格：11 页，US Letter，612 x 792 pt，未旋转
- 失效规则：`main.pdf` 任何一个字节发生变化，本报告即不再适用于新 PDF，必须重新审稿。

开始时已重新计算 SHA-256，结果与给定值完全一致。第一阶段只读取上述 PDF 及其 11 页渲染图，不读取既有 reviews、`PAPER_HANDOFF.md`、`CLAIM_EVIDENCE_LIMITATION.md`、论文源文件或实验说明。第一阶段的评分与问题清单封存后，第二阶段才读取指定 handoff/claim ledger，并对 D17-D19、AI-use、匿名 supplement 和少量实现歧义做只读交叉核查。既有 Round 1/Round 2 review 的结论没有被套用到本报告。

## 总体结论

**倾向：Weak Reject（约 4/10）；置信度：0.82。**

论文最有价值的部分是：把物理占位、玩家特定逻辑连通性和历史相关重复规则放入同一可重放环境；给出 side-5 的完整枚举负结果和 side-6 的 Superko 可绑定 witness；并且对失败门、重复轨迹、架构混淆和未完成实验保持了少见的克制。当前拒稿倾向主要不是因为明显伪造或把 partial result 冒充 formal result，而是因为：

1. 中央 Wilson “下界”来自已知非独立、且大量完全重复的确定性轨迹，不能作为有覆盖率含义的不确定性结论，却被放进摘要核心结果；
2. PDF 没有给出足够自洽的规则、枚举器和搜索基线定义，使一个 benchmark paper 的核心对象无法仅凭论文独立实现或审计；
3. Topology-GNN 与 Grid-GNN 同时改变关系结构和宽度，`TopologyHistory` 未进入正式比较，side-6 的正 witness 也不在训练尺寸中，因此现有实验不能识别“拓扑/历史输入导致收益”的因果作用；
4. 当前提交物仍缺强制 AI-use statement，且没有匿名、allowlist、身份扫描、哈希绑定的 supplement。当前哈希对应的 PDF 因此尚不可作为最终投稿件。

若只评价论文中最窄的 artifact/diagnostic contribution，存在接收理由；若按 ICLR 主会 benchmark/empirical paper 的完整性与证据强度评价，当前更接近弱拒。

## Blind 阶段的主要优点

- **问题设置有辨识度。** 论文清楚地区分 rendered occupancy、logical topology 和 repetition history；与一般固定格点占位基准相比，这个组合具有潜在研究价值。
- **负结果有边界。** side-5 只证明 latent topology aliasing，并明确没有发现 legal-action、next-observation、value、shared-action Q 或 optimal-action 差异；没有把它夸成 Grid 非 Markov。
- **Superko witness 表述克制。** side-6 只证明规则可以实际拒绝一个闭环动作，不声称找到了自然 paired-history legality alias，也不声称 Superko 可省略。
- **证据治理较好。** 论文区分 formal、pilot、bounded miss、failed gate 和 one-game/one-update smoke；使用 receipts、hash、replay verification 和 task-indexed records，且保留 inconclusive/borderline cell。
- **局限性写得诚实。** 明确承认单一手工游戏的外部效度、架构混淆、未匹配 compute、两条确定性轨迹、缺少 zero-shot/edge/history/cascade ablation，以及不能推出全局排名和 sample efficiency。
- **版式总体成熟。** 11 页均无裁切、重叠、黑块、乱码、字体替换或页眉页脚碰撞；Figure 1 和主表格尤其清晰。

## P0：投稿或核心结论阻塞项

### P0-1：mandatory AI-use statement 缺失

当前 PDF 和当前 `main.tex` 都没有 AI-use section。`AI_USE_DISCLOSURE_DRAFT.md` 明确只是待作者确认的事实核对表和措辞草案，不能替代论文中的 mandatory section，也不能替代 OpenReview submission-form disclosure。

关闭条件至少包括：所有作者确认实际工具、任务阶段、保留输出、未公开材料传输和人工核验；在论文中加入最终 statement；单独完成 live submission form；重建 PDF；对新哈希重新执行完整 gate。本次模拟审稿本身也属于应由作者确认的 AI-assisted simulated review 工作流；若其结论或文字进入论文/表单，应纳入最终披露。

**状态：OPEN，阻塞最终投稿。**

### P0-2：匿名 supplement 尚不存在

本轮没有找到 `supplement/RELEASE_CLAIM_DELTA.md`、匿名 supplement 目录或匿名压缩包。稿件已经把过宽的 release inventory 收窄到 compact aggregates、receipt ledger、hashes、protocols 和 verifier outputs，但“收窄声明”并不会自动生成、匿名化或验证 supplement。

这里不是声称 ICLR 对所有论文普遍强制提交 supplement；而是对本稿当前的 artifact/reproducibility 声明和项目 submission gate 而言，匿名 supplement 仍是 P0。它至少需要明确 allowlist、去身份/绝对路径/remote 扫描、独立 clean-copy 测试、完整哈希 manifest，并与论文 release wording 一致。

**状态：OPEN，阻塞当前项目定义的最终投稿 gate。**

### P0-3：摘要中的 Wilson “下界”没有可辩护的抽样解释

Table 3 把五个训练 seed 的 1,000 局 pooled records 放进 Wilson 95% interval，并把 draw 作为 0.5 success。论文同时承认每个 D16 200-game task 只有两条 color-conditioned deterministic trajectories，pooled games 不是独立试验。把区间称为 descriptive 是诚实的，但不能恢复其 frequentist coverage；摘要中的“seven of nine lower bounds above 0.5”仍会被自然理解为不确定性证据。

最低修复是从摘要和主结论中移除 interval/lower-bound 语言，只保留冻结 arena 的描述性点估计；更好的修复是以训练 seed、opening cluster、task 或 unique trajectory 为分析单位，报告五个 paired seed outcome，并在多样化开局/随机性下重新估计不确定性。

### P0-4：当前提交包不足以独立复现 benchmark 的核心对象

PDF 只用自然语言提到 protected regions、three-point restriction、extend/attack、edge cut/restoration、cascade deletion、automatic skip、canonical Superko key 和 discrete territory。它没有足够精确的 transition specification、伪代码、初始状态定义、完整 scoring rule，也没有给出 side-5 枚举/去重/backward induction 的可审计算法和 side-6 动作序列。对一个 benchmark contribution，这是核心可复现性缺口。

若匿名 supplement 提供经过扫描的可执行规则、测试、witness、verifier、冻结 config、完整哈希和一条端到端复现命令，此项可以部分关闭；在当前 PDF + 当前不存在的 supplement 状态下不能关闭。

## P1：重大科学与技术问题

### P1-1：没有隔离 topology/history 的作用

Grid-GNN 和 Topology-GNN 的 relation set 与 hidden width 同时变化（82 vs. 64）；CNN 又增加模型家族混淆。参数量接近不等于算子、FLOPs、memory、transition count 或 wall time 匹配。`TopologyHistory` 被声明但未进入正式 neural comparison；formal training sizes 是 5/7/9，而正面的 Superko witness 在 side 6。现有 direct play 只能描述这组模型在这组冻结任务中的 arena outcome，不能把差异归因于 logical edges 或 history。

需要同宽、同算子、同训练/搜索预算的 controlled ablation，例如 logical relations present/masked/shuffled/dummy，以及真正的 history feature ablation，并使用 paired seeds。

### P1-2：正式 baseline 太弱且定义不足

正式 neural evaluation 只有 Random 与 UCT-MCTS-16；Greedy/Minimax 五代理矩阵仍是 engineering smoke。固定 16 simulations 随 board size 增长很可能相对变弱，因此 score 随尺寸升高不能自动解释为模型更强。PDF 还没有完整说明 UCT exploration、leaf evaluator/rollout、tie breaking、transposition、evaluation temperature 和 automatic-skip handling。

side-5 已有 exact solution，却没有用于 optimal-opponent、policy/action agreement、value calibration 或 exploitability-like 检查，这是明显错失的强基线。

### P1-3：seed-level 和机制暴露证据不足

Table 4 的每个 aggregate 实质上只有五个 training seeds、十条 unique color-conditioned trajectories，而不是 1,000 个独立试验。正文所谓 size-representation “interaction”最多是描述性 crossover pattern。应公开逐 seed 的 paired score、unique trajectory count 和 opening/task 层面的变异。

同时，formal self-play/evaluation 没有报告 Superko trigger、cascade、logical-edge mutation 或 history-sensitive decision 的暴露率。side-5 的 topology alias 恰好是 decision-irrelevant；larger-board strict witness search 是 budgeted miss；240-game extension 观察不到 trigger/outcome effect。模型可能几乎不需要使用该 benchmark 的标志性机制。

### P1-4：Equation (3) 与冻结实现不一致

PDF 的式 (3) 只显示 `rho(W0 h + mean relation messages)`，随后文字说有 residual。当前实现实际为近似

`LayerNorm(h + ReLU(W0 h + sum_r W_r mean_r(h_j)))`。

式子遗漏 residual addition、LayerNorm、self-projection bias 和 empty-neighborhood convention。实现对零邻居用 degree clamp，零邻域贡献零消息，因此这不是冻结结果错误，也不需要重跑实验；但它是应在论文中修正的模型定义/复现错误。

### P1-5：枚举与验证主张在 PDF 内不可审计

Proposition 1/2 依赖计算 witness 和穷举证书，但没有给出完整枚举算法、state identity/canonical key、history 去重、PASS/automatic skip 处理、pair universe 或独立 backward-induction verifier 的定义。“independent all-PASS backward-induction audit”措辞尤其容易被误解。Figure 1 证明图示状态差异清楚，但不能替代 reachability/completeness certificate。

### P1-6：D14-D16 边界总体守住，但 claim ledger 仍有映射缺口

第二阶段核对结果如下：

| 证据边界 | PDF 状态 | 结论 |
| --- | --- | --- |
| C1 Python/Web parity | 明确限定为 recorded traces，不是 exhaustive cross-implementation proof | PASS |
| C2 side-5 latent topology | 明确报告 decision-relevant negative result，不称 Grid 非 Markov | PASS |
| C3 side-6 Superko witness | 只称 rule can bind，不称 paired-history alias | PASS |
| C4 D14-D16 bundle counts | 使用 15/315 tasks、1,500 games、3,000 updates、330 receipts、30,600 task-indexed records | PASS |
| C5-C6 Random/UCT-MCTS-16 | 限定 seen sizes、descriptive intervals；科学有效性仍受 P0-3 限制 | 边界 PASS，证据弱 |
| C7 direct play | 明确 two trajectories/task、无 global ranking | PASS |
| C8 checkpoints | 不声称 AUC、continuous convergence 或 sample efficiency | PASS |
| C9 parameter match | 明确 architecture/compute confound | PASS |
| C10 240-game Superko extension | 保留 failed 1% gates、0/10 上界和 smoke/bounded 限制 | PASS |

但是，Section 7.4 前半段的 2,000-pair-per-size fixed-policy pilot 没有像 240-game extension 一样在 authoritative ledger 中获得单独、明确的 claim-evidence-limitation 行。建议补足映射，或把 C10 明确扩展到该 pilot。另有两处范围措辞应限定成 “completed D14-D16 bundle”：Section 7.5 的 `formal_ready=true` 与 Appendix B 的 “No formal task failed or truncated”，避免被误读成覆盖未完成的 D17-D19。

### P1-7：复现和 compute 说明仍不完整

100 个 mixed-size self-play games 如何分配到 5/7/9、replay sampling/batch composition、checkpoint selection、evaluation noise/temperature、CNN kernel/normalization/padding map、graph pooling 等操作细节不足。论文声称 data/parameters near-matched，但 transitions、FLOPs、memory、wall time 和 evaluation compute 都未匹配；应避免 efficiency 或纯 representation 因果语言。

## P2：次要问题

- **Figure 2/3 小字。** Figure 2 的图例、坐标、灰色 N 说明以及 Figure 3 底部灰字约为 5.6-6.7 pt，屏幕放大可读，但打印或缩放后偏小、偏淡。
- **Page 11 留白。** Appendix B 只有一段正文，约四分之三页面为空，却继续显示空白行号 551-593。不是模板或页数违规，但可利用空间补规则伪代码、witness 或 artifact inventory。
- **256 plies 措辞。** Table 5 将其写在 “Terminal rule” 行中，但实现把它作为外部 self-play/arena cap；到 cap 而未 `game_over` 的局标记 truncated、无 winner、且不进入 replay。由于 formal tasks 报告零 truncation，Eq. (2) 不存在由此导致的 Markov-state 缺失；建议改为 “external cap: 256 plies; capped games are truncated and excluded”。
- **数值格式。** Table 3 使用三位小数，Figure 3 使用一位百分数，存在 `.851` 与 `85.0%` 之类的视觉差异，宜统一。
- **措辞。** “Within-size self-play” 与前文 mixed-size training 容易混淆；“Broader Impact”段实际只有 limitations；结论中的 “isolates” 比实验真正做到的 controlled isolation 略强。
- **metadata 指纹。** Author/Title/Subject/Keywords 均为空，未发现身份信息；但保留精确生成时间、`+08` 时区和 MiKTeX/pdfTeX producer。它不构成当前匿名泄露，追求最严格去指纹时可清理。

## D17-D19 独立交叉核查

当前可读 v5 状态为：10/85 tasks complete、640/8,320 replay-verified games、75 missing、`formal_ready=false`、`independent_verification_passed=false`、无完整 result ledger；这 10 个 task 全部属于 GEN-SIZE partial evidence。

| 实验 | 协议要求 | 当前 PDF | 判断 |
| --- | --- | --- | --- |
| D17 / GEN-SIZE n=10/12 | formal gate、seed-aware 结果、完整 verification 后才可报告 | 只说 n=10/12/zero-shot 留待未来；没有 score/interval/generalization claim | PASS：未引用 partial result |
| D18 / D16-v2 diversified openings | 45/45 tasks、cluster/seed-aware gate 后才可修复原 D16 重复问题 | 仍明确承认原 D16 两条轨迹和需要 diversified evaluation | PASS：未引用 partial result |
| D19 matched-architecture logical-edge ablation | 仅 smoke，且有条件门 | 没有 D19 或 matched-architecture result | PASS：未引用 partial result |

Section 7.4 的 fixed-policy pilot 与 240-game Superko extension 不是 D17-D19。`D17_D19_PROTOCOL.md` 明确说明该协议不完成 ABL-SUPERKO；240-game extension 由单独的 C10/Superko evidence 支持。故本 PDF **没有错误引用 D17-D19 的部分结果**。需要修复的是前述 ledger 映射和 D14-D16 范围措辞，而不是删除一条被误认成 D17-D19 的结果。

## PDF、匿名、引用和模板审计

| 检查项 | 结果 |
| --- | --- |
| 哈希 | 开始、交叉核查前均为完整 SHA-256 `3000054C0A1BDE8158AA0EBCF6E24AFB54DB15B2DB3AA3109B6D5E1FA6C9A981` |
| 页数/纸张 | 11 页 US Letter；正文和 reproducibility statement 在第 8 页结束，references 为第 8-10 页，appendix 在 references 后的第 10-11 页；可见主文未越过常规 9 页上限 |
| 模板 | 可见 official ICLR 2027 review header、匿名作者块、行号；本地 `.sty/.bst` 与 official archive 的 handoff hash 完全一致；无 `\iclrfinalcopy` |
| 字体 | 23 个字体对象全部 embedded/subset，并有 Unicode 映射；无 Type 3 或缺失字体迹象 |
| 匿名性 | 正文无姓名、单位、邮箱、致谢、作者仓库或本机路径；Author/Title metadata 为空；无身份性 XMP、附件、JavaScript 或表单 |
| 引用 | 30 个 unique cited keys 与 30 个 bibliography items 一一对应；missing=0，uncited=0；当前 log 无 undefined citation/reference、BibTeX warning 或 overfull box |
| 链接 | 75 个 `/Link`：64 个内部链接、11 个外部文献链接；内部目标全部存在，矩形均在页面内，无可见边框；外链为 DOI/arXiv/DBLP。这里只验证 PDF 结构和 URI，未重新联网验证 10 个 unique external URL 的实时 HTTP 可用性 |
| 图表 | 3 figures、5 tables 均在页面边界内，无裁切/重叠；Figure 2/3 小字见 P2 |

文献真实性方面，本轮 blind review 检查了正文语境、引用覆盖、bibliography 呈现和链接结构；第二阶段读取的 handoff 记录 30 条均已做 registry metadata audit。本轮没有重新联网逐条查询 Crossref/DataCite/DBLP，因此不把本报告表述为一次新的 30 条在线真实性复核。

## 11 页逐页检查记录

| 页 | 内容与检查结论 |
| --- | --- |
| 1 | 标题、Anonymous authors、abstract、contributions 和 Related Work 开头清晰；无身份泄露；摘要 Wilson lower-bound claim 构成 P0-3。 |
| 2 | Related Work 和 benchmark state 定义可读；公式无裁切；最近邻覆盖较广，但缺少更尖锐的 feature-by-feature 对比。 |
| 3 | Figure 1、legend、Table 1 清晰，线型不只依赖颜色；规则说明不足以独立实现。 |
| 4 | Definition 1/2、Proposition 1/2 与 evidence boundary 清楚；命题缺少可审计算法/证书细节；正式 baseline 说明过短。 |
| 5 | model equation 和 Table 2 版式清晰；Eq. (3) 与实现不完整一致；参数匹配不能消除架构/compute confound。 |
| 6 | Table 3 清晰；Figure 2 主体可读但轴/图例/N 说明偏小；pooled Wilson 与重复轨迹是核心统计问题。 |
| 7 | Figure 3 数值直接标注、Table 4 清楚；round robin 的有效 unique trajectory 很少；pilot/extension 限制写出，但 ledger mapping 不完整。 |
| 8 | limitations、conclusion、reproducibility statement 与 References 衔接正常；主要证据边界保留；“isolates”略强。 |
| 9 | References 连续可读，长 DOI/URL 换行正常，无裁切。 |
| 10 | References 结束后进入 Appendix A；Table 5 清晰；256 plies 的 “Terminal rule” 标签不准确。 |
| 11 | Appendix B 匿名、文字正常；大面积留白，空行号持续到 593；可用于补复现细节。 |

## 给作者的关键问题

1. 能否在匿名 supplement 中给出完整 executable transition specification、初始局面、protected regions、three-point restriction、attack/cascade/edge restoration、pass/skip、territory scoring 和 Superko canonical key？
2. side-5 的完整枚举、state identity、history 去重、PASS-aware backward induction 和 pair universe 分别是什么？能否给出 machine-checkable certificate 和一条复现命令？
3. 为什么不使用已有 exact side-5 solver 作为 optimal opponent，并检查 policy/value accuracy？
4. UCT-MCTS-16 的完整实现和强度校准是什么？固定 16 simulations 在 n=5/7/9 上的绝对强度如何变化？
5. 能否报告所有五个 paired seed 的结果，并以 seed/opening/task/unique trajectory 作为统计单位，而不是 pooled records？
6. 能否用同宽同算子的 GNN 做 logical-edge present/masked/shuffled ablation，并正式评价 `TopologyHistory`，尤其是在有正 Superko witness 的尺寸？
7. 100 个 mixed-size self-play games 如何分配？replay sampling、batch composition、evaluation temperature/noise 和 tie breaking 如何定义？
8. 哪些 code/config/witness/replay input/verifier/aggregate 将实际进入匿名 supplement？每个主表对应的完整 hash 和单命令是什么？
9. 2,000-pair fixed-policy pilot 的 authoritative claim-evidence-limitation 映射在哪里？

## 最终建议

保持当前谨慎措辞是必要的，但还不足以达到接收。最能改变评分的工作依次是：

1. 关闭 AI-use 与匿名 supplement 两个 P0，并在新 PDF/hash 上重新 gate；
2. 删除或重做摘要的 pooled Wilson lower-bound 主张，给出 seed/opening/trajectory-level 结果；
3. 在完全相同架构下隔离 logical topology/history 输入，并报告机制暴露率；
4. 用 exact side-5 solver 和多预算 search 校准 baseline；
5. 在论文或匿名 supplement 中补齐规则、枚举器、witness、verifier 和端到端复现合同。

**最终倾向：Weak Reject。置信度：0.82。**

**本报告只绑定 PDF SHA-256：`3000054C0A1BDE8158AA0EBCF6E24AFB54DB15B2DB3AA3109B6D5E1FA6C9A981`。**
