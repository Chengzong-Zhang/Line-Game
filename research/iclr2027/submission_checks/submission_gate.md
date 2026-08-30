# LIFELINE-RL Submission Gate

审计日期：2026-08-29  
评审角色：独立模拟评审与复现负责人（AI-3）  
冻结候选 PDF SHA-256：
`00FAD4373A8F04CB76CDA638014CEEF2FEC6EDBB95C68D97F92C836AFF96793E`

## Gate 决定

**FAIL**

**不允许进入 D23--D24。** 当前 PDF 本体已经达到可读、匿名、页数合规和数字可追踪的
候选稿水平，但仍有 3 个 desk-reject/不可提交 P0：2027 模板、强制 AI-use statement、
匿名且与 release 声明一致的 supplement。完整测试结果不会覆盖这些 P0。

去重后的当前问题数：**P0 = 3，P1 = 9，P2 = 5**。

## 1. P0 阻塞项

### P0-1：未使用官方 ICLR 2027 模板

- `research/iclr2027/paper/main.tex:3-7` 明示使用官方 ICLR 2026 style；
  `main.tex:30-31` 又手写 2027 页眉。
- 官方 Author Guidelines 要求 ICLR 2027 submission 使用 2027 style：
  <https://iclr.cc/Conferences/2027/AuthorGuidelines>。
- 官方 zip 已发布：
  <https://media.iclr.cc/Conferences/ICLR2027/iclr-2027-style-files.zip>。
- 必须由 AI-1 在官方模板下重新构建、重新检查页数和全页视觉；AI-3 不直接修改
  `paper/main.tex`。

### P0-2：缺 mandatory AI-use statement

- 当前 `main.tex` 全文没有 AI-use section。
- `paper/PAPER_HANDOFF.md:119-123` 的内部说明不能代替论文正文和 submission form。
- 官方政策明确要求正文 mandatory section，且该 section 不计页数；submission form
  也需披露：<https://iclr.cc/Conferences/2027/AIPolicyForAuthors>。
- 必须由人类作者确认事实范围和措辞；不得由评审人替作者隐藏、弱化或虚构披露。

### P0-3：没有匿名且与 release 声明一致的 supplement

- 当前没有独立的匿名 allowlist manifest/zip。
- 不能提交整仓：tracked 路径 `submission/241098117-张城宗/**` 和 remote
  `github.com/Chengzong-Zhang/Line-Game.git` 明确泄露身份；tracked AutoDL policy
  和 validation JSON 还包含 `C:/Users/zcz`。
- `main.tex:565-566` 声称 release 包含 checkpoints、aggregate CSV/JSONL 等，但
  `.gitignore:36-50` 排除了 checkpoint、task arena 和 `games.jsonl`；release-like
  clean copy 中 checkpoint、raw games JSONL、D14 task directories 均为 0。
- 修复必须二选一或组合：组装明确 allowlist 的匿名、哈希绑定 supplement/匿名对象
  存储；或把论文 release 声明收窄到实际提交工件。之后必须重新扫描姓名、学号、用户名、
  绝对路径、remote URL、PDF metadata 和压缩包内文件名。

## 2. 所有数字的一致性状态

### 2.1 D14--D16 正式结果

| 数字/检查 | 论文或正式口径 | 独立结果 | 状态 |
|---|---:|---:|---|
| training tasks | 15 | 15 | PASS |
| evaluation tasks | 315 | 315 | PASS |
| receipts / task directories | 330 / 330 | 330 / 330 | PASS |
| missing / extra / duplicate tasks | 0 / 0 / 0 | 0 / 0 / 0 | PASS |
| failed / truncated | 0 / 0 | 0 / 0 | PASS |
| self-play games | 1,500 | 1,500 | PASS |
| gradient updates | 3,000 | 3,000 | PASS |
| evaluation records | 30,600 | 30,600 | PASS（记录数） |
| independent aggregate rows | 72 | W/D/L/score/Wilson mismatch 0 | PASS |
| checkpoint SHA/config/source binding | 75 | 75/75 | PASS |
| stratified direct replay | -- | 630/630 | PASS |

可重复证据为 `research/iclr2027/reviews/independent_receipt_audit.py`
（SHA-256
`6A7EE4D84CA037E18F71C4D1E1103C7994A95946DC33B80772FAEBD0BA257D89`）。
其 `--compare-canonical` 模式本轮 exit 0、`ok=true`：先从原始 task/receipt/game
重建，再比较 72/72 canonical rows；W/D/L、score、Wilson mismatch 和最大绝对误差
均为 0。

30,600 的数值正确，但 `main.tex:373,564` 的 **unique games** 语义不正确。D16 的
9,000 records 来自 45 个 task，每 task 恰好 2 条动作轨迹；task+color 条件化共
90 条，全局 size+color 条件化仅 89 条。因此该措辞为 P1，建议固定为：

> 30,600 task-indexed replay-verified game records

### 2.2 论文表格和模型比较

- Table 3 的 18 个 model×size×opponent score 与独立逐局 W/D/L 复算一致。
- Table 4 的 9 个 representation round-robin score 与独立复算一致。
- 三张图可从冻结 aggregate 重建；clean-copy 重建图片与候选图片字节哈希一致。
- D16 重复轨迹已在正文披露，正文没有把 pooled Wilson 继续解释成 independent-game
  inference；该边界 PASS。
- `main.tex:488` 正确写明 `formal_ready=true` 只表示 artifact completeness，
  不表示模型优越性；该边界 PASS。
- `main.tex:494-495` 正确写明 n=10/12 不是已完成 zero-shot，history/logical-edge/
  cascade/search-budget ablations 仍缺；该边界 PASS。
- Grid-GNN 与 Topology-GNN 的 relation operator 数和 width 同时变化；表中点估计
  可以报告，但不能归因于 logical edges 的纯因果作用。

### 2.3 环境、状态别名和 Superko 数字

- side-5 的 state/transition/alias counts 与冻结 state-aliasing 工件和 claim ledger
  对齐；本 gate 未重新执行完整状态图枚举，故状态为 **artifact-consistent，非独立重算**。
- side-6 Superko witness 与冻结 replay artifact 对齐；论文正确限定为一个规则可绑定
  witness，不是自然 paired-history alias。
- 固定策略 Superko pilot 和 240-game five-seed extension 与现有验证摘要对齐；论文
  明示 practical-similarity gates 失败、neural row 是 smoke。它们不能替代完整
  history/cascade/edge ablation。

### 2.4 D17--D19

- 当前 `research/iclr2027/configs/d17_d19_formal_manifest.json` 状态在本 gate 观察期
  内仍为 `frozen_not_run`。
- 旧 13.10 s / 65-case exact dry-run 绑定旧 manifest `8092...`，已经失效。
- 当前有效 v3 dry-run 位于
  `results/formal/d17_d19/run_20260829_p0_v3/preflight/dry_run.json`：PASS，
  195/195 fixture forward/PUCT checks（GEN-SIZE 60、D16-v2 135），15/15
  checkpoints、96 openings、49.895 s、0 formal task。它绑定当前 canonical manifest
  `9d0d69...`、runner `b8083a...` 和 materialized manifest `e61313...`。
- 当前 bundle 仍为 `materialized_not_run`：85 planned tasks、8,320 planned games；
  正式进度为 0/85 tasks、0/8,320 games。
- `research/iclr2027/D17_D19_RESULTS.md` 当前不存在；正式任务、正式 receipt、独立
  aggregate 均不可用。
- AutoDL staging 为 `prepared_not_run`，`paid_action_performed=false`；AI-3 未调用
  AutoDL。
- 因此 n=10/12 zero-shot、D16-v2 多样化评估和 D19 架构匹配逻辑边 smoke **不得
  进入当前论文结论**。

## 3. 测试与构建

### 3.1 Clean-copy full unittest

在已构造的 clean-copy 根目录中，核心 unittest invocation 如下；实际审计还将
`TEMP`/`TMP` 指向该副本内可写目录，并禁止写入字节码。下式不是 clean-copy 构造命令：

    & 'C:\Users\zcz\anaconda3\envs\rl310\python.exe' -B -m unittest discover -s .\research\iclr2027\tests -t .\research\iclr2027 -v

结果：**exit 1；Ran 177 tests in 23.373s**。

- 177 个实际运行的 test method 全部 `ok`；skip=0、failure=0。
- 另有 1 个 class-level `setUpClass` ERROR，使该类后续 7 个 tests 未运行。
- 精确根因：`tests/test_verify_superko_policy_matrix.py:10-23` 要读取
  `results/smoke/superko_policy_matrix/superko_policy_matrix_revised_runner_preflight.json`；
  原工作树存在，clean copy 缺失；`verify_superko_policy_matrix.py:195-197` 将
  `FileNotFoundError` 包装为 `VerificationError: cannot read report`。
- 这不是模型逻辑断言失败，而是匿名/发布副本漏打包测试 fixture；因此 full
  clean-copy suite **FAIL**，并入 P0-3，不另增 P0 数量。
- 先前使用受限 Windows TEMP 的尝试因 TemporaryDirectory `Access denied` 无效，
  已记录但不计作代码测试结果。

当前 full suite 本身未通过。即使其余 177 个 test method 均为 `ok`，本 gate 也不把
smoke 当正式结果，更不把单元测试通过解释成论文主张成立。

### 3.2 LaTeX build

clean-copy 使用 TeX Live 2024 执行：

1. `pdflatex -interaction=nonstopmode -halt-on-error main.tex`
2. `bibtex main`
3. `pdflatex -interaction=nonstopmode -halt-on-error main.tex`
4. `pdflatex -interaction=nonstopmode -halt-on-error main.tex`

四步均 exit 0 并生成 10 页 PDF，但第 4 步仍有：

> LaTeX Warning: Label(s) may have changed. Rerun to get cross-references right.

再额外运行一次 `pdflatex` 后 exit 0，最终 log 无 undefined citation/reference/rerun，
BibTeX warning 为 0。因此：

- 构建能力：**PASS**；
- `paper/PAPER_HANDOFF.md:138-146` 标成 canonical 的四命令：**CONDITIONAL/P1**；
- 修复建议：使用 `latexmk`，或明确记录额外稳定 pass。

## 4. 投稿检查矩阵

| 检查域 | 状态 | 证据与边界 |
|---|---|---|
| 数字一致性 | CONDITIONAL PASS | D14--D16 算术和哈希 PASS；`unique games` 语义 P1；D17--D19 无结果 |
| 引用键完整性 | PASS | 30 cite keys = 30 BibTeX keys；missing 0，uncited 0 |
| 引用真实性 | PASS | Crossref 14、DataCite 14、DBLP 2；未发现虚构条目 |
| Related Work 完整性 | NEEDS REVISION/P1 | 缺 Ludii、Regular Boardgames、Polygames、Hex transfer、棋类 GNN 最近邻比较 |
| 图表 | PASS | 三图可重建；10 页视觉无裁切/重叠/黑块 |
| PDF 匿名 | PASS | Author metadata 为空；PDF 文本未检出身份/本机路径 |
| Supplement 匿名 | FAIL/P0-3 | 无匿名 allowlist 包；整仓明确泄露姓名、remote 和本机路径 |
| 模板 | FAIL/P0-1 | ICLR 2026 style + 手写 2027 页眉 |
| 页数 | PASS | 主文在第 8 页上半部结束，低于 9 页上限；总 PDF 10 页 |
| References/Appendix 顺序 | PASS | References 在第 8 页开始，Appendix 在第 10 页 bibliography 后开始 |
| PDF 字体/页面 | PASS | US Letter；全部字体 embedded/subset；10/10 页视觉检查 |
| 构建命令 | CONDITIONAL/P1 | 实际需比 handoff 多一次 pdflatex，或改用 latexmk |
| Full clean-copy tests | FAIL/P0-3 | 177 methods ok，但漏 fixture 导致 1 setUpClass ERROR、7 tests 未运行、exit 1 |
| 复现工件/发布包 | FAIL/P0-3 | release 声明与实际匿名可发布包不一致 |
| 环境锁定 | NEEDS REVISION/P1 | 依赖未锁定，无 lockfile/container |
| AI 政策 | FAIL/P0-2 | 缺 mandatory paper section 和 submission-form 决策 |
| AutoDL | NOT USED | AI-3 未运行、触碰或释放任何实例；未产生费用 |

## 5. P1/P2 科学与工程问题

P1 共 9 项：最近邻定位、单游戏外部效度与缺失消融/零样本、Grid/Topology 架构混淆、
D16 伪重复/seed-level 推断、`unique games` 措辞、实际 compute 未匹配、依赖未锁定、
canonical LaTeX 命令不足、D17--D19 尚无正式结果。

P2 共 5 项：文献审计漏写 DBLP、已有 venue 版本仍引 arXiv、少量 DOI/figure caption
排版、README/handoff 状态漂移、两次中断缺 canonical per-attempt lineage。

详细逐项证据见：

- `research/iclr2027/reviews/iclr_mock_review_round2.md`
- `research/iclr2027/reviews/experiment_audit_round1.md`

## 6. 关闭 Gate 的最低条件

AI-1/作者侧：

1. 使用官方 ICLR 2027 style 重建，不手写年份页眉；重新做页数和 10 页全页视觉检查。
2. 添加真实、合规的 mandatory AI-use statement，并完成 submission-form 披露决策。
3. 组装匿名 allowlist supplement，或收窄 release 声明；重新做身份、绝对路径、remote、
   metadata 和 archive filename 扫描。
4. 把 `unique games` 改为 `task-indexed replay-verified game records`。
5. 补最近邻 related-work 比较；保留架构混淆、重复轨迹和未完成消融限制。
6. 修正 canonical build 命令并锁定可复现环境。

AI-2 侧：

1. 不补跑 D14--D16 训练，不改既有正式工件。
2. 当前 v3 preflight 已绑定一致哈希并通过；若 manifest、runner 或 experiments 再有
   任何修改，必须重新生成 dry-run，旧 dry-run 不可复用。
3. 正式结果需 85/85 task、0 failed/missing/truncated、完整 receipt、重放、轨迹多样性门
   和独立 aggregate 一致；否则 `formal_ready=false`。
4. D19 smoke 只能标 smoke，不得替代架构匹配正式消融。

AI-3 复审：

1. 在新 PDF 和匿名 supplement 的新哈希上重跑本文件全部 gate。
2. 三个 P0 全部 PASS 前，不给 CONDITIONAL PASS/PASS，不允许进入 D23--D24。

## 7. 最终结论

当前状态：**FAIL**。  
进入 D23--D24：**NO**。  
可保留的论文结论：seen sizes 5/7/9、固定五 training seeds、固定 D14--D16 协议下的
描述性 W/D/L/score，以及环境/重放工件完整性。  
不可形成的结论：全局模型排名、logical-edge 因果优势、n=10/12 zero-shot、完整
history/cascade/edge ablation、pooled-game 独立样本显著性或实际 compute-matched 优势。
