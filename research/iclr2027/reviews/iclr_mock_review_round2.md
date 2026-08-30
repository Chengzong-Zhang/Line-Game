# LIFELINE-RL ICLR 模拟评审 Round 2

审计日期：2026-08-29  
角色：独立模拟评审与复现负责人（AI-3）  
总体建议：**Weak Reject / Reject；科学边界显著改善，但投稿 gate 仍 FAIL。**

## 1. Round 2 冻结快照

| 工件 | SHA-256 |
|---|---|
| `research/iclr2027/paper/main.tex` | `E6FC776394EAD77749612E3FD74723A1931A2AAFC48587426731ACB01F2F391E` |
| `research/iclr2027/paper/main.pdf` | `00FAD4373A8F04CB76CDA638014CEEF2FEC6EDBB95C68D97F92C836AFF96793E` |
| `research/iclr2027/paper/references.bib` | `0F718B48C05DA702919446D8F01842D74818F7EF4FEC1A137A2D0FAFC75D5C97` |

本轮源文件与 Round 1 不同。当前 PDF 为 10 页 US Letter：主文在第 8 页上半部结束，
References 随即从第 8 页开始并延续到第 10 页，Appendix 在第 10 页参考文献之后开始。
所有 10 页均已渲染并逐页检查。

## 2. 分数变化

| Reviewer | Round 1 | Round 2 | 变化 | Confidence |
|---|---:|---:|---:|---:|
| A：创新性与相关工作 | 3/10 | 3/10 | 0 | 4/5 |
| B：实验与统计 | 4/10 | 4/10 | 0 | 5/5 |
| C：复现与投稿 | 3/10 | 4/10 | +1 | 5/5 |
| 均值 | 3.33 | 3.67 | +0.34 | -- |
| 中位数 | 3 | 4 | +1 | -- |

Related Work、30 条真实引用、三张图、完整限制段和匿名 PDF 使投稿质量改善；但 A/B
分数不提高，因为最近邻定位、单游戏外部效度、架构混淆、D16 推断单位以及消融缺口
没有被新实验关闭。

## 3. Reviewer A：创新性与相关工作

### Summary

Round 2 已加入 Related Work 和可核验参考文献，消除了 Round 1 最直接的学术完整性
失败。论文也诚实陈述 side-5 是决策相关否定结果、n=10/12 未测试、Topology-GNN
不能形成全局排名。然而相关工作仍停留在通用 AlphaZero、环境平台、基础 GNN、POMDP
和 Go 历史问题，没有与最接近的 general-board-game、尺寸迁移和棋类 GNN 系统比较。

### Strengths

- 当前 30 个正文 cite key 与 30 个 BibTeX key 一一对应，无 missing/uncited key。
- 14 条 Crossref、14 条 DataCite、2 条 DBLP 元数据均可解析，未发现虚构题名、作者、
  年份或 DOI。
- 论文明确把 side-5 的 1,088 个拓扑差异对写成决策相关否定结果，不再暗示 Grid
  必然 non-Markov。
- `main.tex:494-502` 明示 n=10/12、history、logical-edge、cascade 和 search-budget
  消融缺失，并披露架构/FLOPs/时间不匹配。

### Weaknesses

1. `main.tex:82-120` 未与 Ludii、Regular Boardgames、Polygames、Hex transfer、
   chess/board-game GNN 等最近邻工作正面比较。
2. benchmark 仍是单一手工游戏；`experiment_matrix.csv:10-14` 的外部效度证据没有
   进入当前论文结果。
3. side-5 的全部拓扑不同对都没有决策相关差异，side-6 只有一条规则可绑定 witness；
   尚未证明 topology/history 是稳定、普遍的学习难点。
4. Grid/Topology 的 relation operator 数和宽度不同，结果不能归因于“逻辑边本身”。

### Questions

1. LIFELINE 与 Ludii/Regular Boardgames/Polygames/Hex transfer 的机制和 task-suite
   差异是什么？
2. 贡献是新规则、新接口、新审计方法，还是可迁移 benchmark？请给逐项定位。
3. 为什么不使用同宽、同三关系算子的 masked-logical-edge control？
4. 如果 n=10/12 和关键消融留到未来工作，论文标题和 benchmark 主张是否应进一步收窄？

### Reproducibility concerns

- 引用真实性通过，但完整性仍有最近邻缺口。
- 多篇已有正式 venue 版本的工作仍只引 arXiv；属于出处选择问题，不是虚假引用。
- `paper/LITERATURE_METADATA_AUDIT.md` 前言只写 Crossref/DataCite，却实际使用 2 条
  DBLP 记录。

### Score and confidence

- **Score: 3/10 (Reject)**
- **Confidence: 4/5**

## 4. Reviewer B：实验与统计

### Summary

独立复算确认 D14--D16 数字链完整且算术正确，但科学推断仍然有限。30,600 条记录、
72 行 aggregate、75 个 checkpoint 及 630 局跨 task 分层重放均通过；D16 的 9,000
条记录却由每 task 两条确定性轨迹重复产生，不能支持 independent-game inference。

### Strengths

- 15 training + 315 evaluation = 330 task；330/330 receipt，0 missing、0 extra、
  0 duplicate、0 failed、0 truncated。
- 1,500 self-play games、3,000 updates、30,600 task-indexed evaluation records
  与原始调度一致。
- 945/945 arena 文件、45/45 training artifacts、75/75 checkpoint SHA-256 和
  canonical config/source binding 通过。
- 独立逐局复算的 72 个 aggregate 行与 canonical aggregate 的 W/D/L、score、
  Wilson 全部一致，最大绝对误差 0。
- 630/630 抽样局直接通过 `LifelineGame` 重放；没有调用 arena replay helper。
- 当前论文正确写明 pooled Wilson 只作描述，`formal_ready=true` 只表示工件完整性。

### Weaknesses

1. 45 个 D16 task、9,000 条记录，每 task 恰好 2 条完整轨迹；task+color 条件化共
   90 条，全局 size+color 条件化仅 89 条。
2. 五训练 seed 的探索性 t 区间明显宽于 pooled Wilson；直接表示比较没有预注册
   seed/cluster-level 主检验。
3. `network.py:125-172,224-238` 的 relation operator 数和宽度不同，参数接近不是
   logical-edge 因果消融。
4. 同 simulation count 不等于相同计算量；神经/UCT 的 timing、FLOPs、内存和环境步
   没有匹配。
5. 论文 `main.tex:373,564` 的 `30,600 unique ... games` 仍会把 record identity
   误解为轨迹唯一或统计独立，应改成
   `30,600 task-indexed replay-verified game records`。
6. D17--D19 的当前 v3 exact dry-run 已与最终 manifest/runner 精确绑定并通过
   195/195 checks，但 formal task 仍为 0；不得把 preflight、计划或 smoke 写成
   zero-shot 或架构消融结果。

### Questions

1. 是否会发布逐 training seed W/D/L，并用 seed 或 seed×opening-cluster 推断？
2. D16-v2 何时达到预注册的轨迹多样性门？
3. logical-edge effect 如何与 relation count/width 分离？
4. “compute matched”是否会改称准确的 “simulation-count matched”？
5. 论文是否会全局替换 `unique games` 的统计歧义？

### Reproducibility concerns

- D14--D16 最终 task 完整，但两次中断尝试没有独立 canonical attempt 文件。
- D17--D19 当前 `status=frozen_not_run`，`D17_D19_RESULTS.md` 不存在；当前有效 v3
  CPU exact dry-run 为 49.895 s：15 checkpoints、195/195 fixture forward/PUCT
  checks、96 openings、0 formal task。旧 13.10 s / 65-case dry-run 绑定旧 manifest，
  已失效。
- 任何后续 D17--D19 aggregate 必须由不读取 canonical aggregate 的 verifier 独立
  复算后才能进入论文。

### Score and confidence

- **Score: 4/10 (Weak Reject)**
- **Confidence: 5/5**

## 5. Reviewer C：复现与投稿

### Summary

Round 2 的 PDF 本体已匿名、页数合规、图表清晰、引用可构建；这是从 Round 1 的实质
进步。但官方 2027 template、mandatory AI-use section 和匿名且与 release 声明一致的
supplement 三个 P0 仍未关闭，因此不能提交或进入最后包装阶段。

### Strengths

- PDF Author metadata 为空，全文文本未检出姓名、本机路径、身份链接或个人域名。
- 10 页均无裁切、重叠、黑块、空白尾页或红色 link box；三张图可读。
- 主文在第 8 页上半部结束，低于 9 页上限；References 随后开始，Appendix 位于
  bibliography 之后；Letter，所有字体嵌入。
- 30 cite keys = 30 BibTeX keys；BibTeX warning 为 0。
- clean-copy 构建能成功生成 10 页 PDF；再增加一次 `pdflatex` 后无 undefined citation、
  reference 或 rerun warning。

### Weaknesses

1. `main.tex:3-7,30-31` 使用 ICLR 2026 style 并手写 2027 页眉；官方已经发布
   ICLR 2027 style zip。
2. 全文没有官方强制的 AI-use section；`PAPER_HANDOFF.md:119-123` 的内部说明不能
   代替论文正文和 submission form 披露。
3. 当前没有匿名 supplement manifest/zip。整仓包含 tracked
   `submission/241098117-张城宗/**`、身份 remote、`C:/Users/zcz` 路径；整仓提交会
   desk reject。
4. `main.tex:565-566` 声称 release 包含 checkpoints、aggregate CSV/JSONL 等，然而
   `.gitignore:36-50` 排除了 checkpoint、task arena 和 `games.jsonl`；release-like
   clean copy 中这些对象为 0。
5. `PAPER_HANDOFF.md:138-146` 给出的四步 canonical LaTeX 命令均 exit 0，但最后一次
   仍报 label rerun warning；需要额外一次 `pdflatex` 或改用 `latexmk`。
6. `pyproject.toml` 只约束 Python>=3.10、torch>=2.3，未锁论文实际环境。

### Questions

1. 官方 2027 style 和 AI-use section 何时进入候选稿？
2. 匿名 supplement 的 allowlist、哈希 manifest 和身份扫描命令是什么？
3. 缺失的 checkpoint/raw replay 是实际发布、匿名对象存储，还是应从论文 release
   声明删除？
4. 干净环境如何安装精确 Python/Torch/CUDA 组合？

### Reproducibility concerns

- 官方来源：
  - <https://iclr.cc/Conferences/2027/AuthorGuidelines>
  - <https://media.iclr.cc/Conferences/ICLR2027/iclr-2027-style-files.zip>
  - <https://iclr.cc/Conferences/2027/AIPolicyForAuthors>
- 官方规则要求 2027 style、主文不超过 9 页、bibliography 后放 appendix、正文强制
  AI-use statement；main text 或 supplement 泄露作者身份会 desk reject。
- clean-copy full unittest 结果见第 7 节；当前 suite 本身未通过。即使其余 177 个
  test method 均为 `ok`，也不能消除上述 desk-reject P0。

### Score and confidence

- **Score: 4/10 (Weak Reject)**
- **Confidence: 5/5**

## 6. 指定问题逐项结论

| 检查项 | Round 2 结论 |
|---|---|
| Related Work 和引用是否真实完整 | **真实性/键完整性 PASS；最近邻覆盖 NEEDS REVISION**。30/30 key 对齐，30 条元数据可核；Ludii/Regular Boardgames/Polygames/Hex transfer/棋类 GNN 缺口仍在 |
| Topology-GNN 与 Grid-GNN 是否架构混淆 | **是，P1**。relation count 与 width 同时变化 |
| D16 重复轨迹是否误当独立样本 | **统计解释已修复；计数措辞未完全修复**。正文明确不作 independent-game inference，但仍写 `unique games` |
| n=10/12 是否真的 zero-shot | **当前论文明确说没有；D17 正式结果也不存在** |
| logical edge/history/cascade 消融是否支持主张 | **不支持广泛机制主张**。固定策略 Superko pilot 与 smoke 不能替代完整正式消融 |
| `formal_ready=true` 是否写成模型优越性 | **否，PASS**。`main.tex:488` 明确仅表示 artifact completeness |
| PDF 是否泄露身份/绝对路径 | **PDF PASS** |
| supplement/repository 是否泄露身份/绝对路径 | **FAIL/P0** |

## 7. 测试、构建、引用与视觉检查

### 7.1 Full unittest

在已构造的 clean-copy 根目录中，核心 unittest invocation 如下；实际审计还将
`TEMP`/`TMP` 指向该副本内可写目录，并禁止写入字节码。下式不是 clean-copy 构造命令：

    & 'C:\Users\zcz\anaconda3\envs\rl310\python.exe' -B -m unittest discover -s .\research\iclr2027\tests -t .\research\iclr2027 -v

结果：**exit 1；Ran 177 tests in 23.373s**。177 个实际运行的 test method 全部
`ok`，skip=0、failure=0；另有 1 个 class-level `setUpClass` ERROR，使该类后续
7 个 tests 未运行。

失败不是模型逻辑断言，而是 clean-copy packaging 缺口：

- `tests/test_verify_superko_policy_matrix.py:10-23` 要读取
  `results/smoke/superko_policy_matrix/superko_policy_matrix_revised_runner_preflight.json`；
- 原工作树有该 fixture，clean copy 没有；
- `verify_superko_policy_matrix.py:195-197` 因 `FileNotFoundError` 抛
  `VerificationError: cannot read report`。

因此 full clean-copy suite 为 **FAIL**。该失败并入 P0-3 的匿名/可复现发布包缺口，
不另增 P0 数量。此前使用受限 Windows TEMP 的尝试因 `Access denied` 无效，未计入
代码结果。

### 7.2 LaTeX clean-copy build

- `pdflatex -> bibtex -> pdflatex -> pdflatex`：四步均 exit 0，输出 10 页 PDF，
  但末次仍提示 `Label(s) may have changed`。
- 再额外运行一次 `pdflatex`：exit 0；最终 log 无 undefined citation/reference/rerun；
  BibTeX `warning$ -- 0`。
- 因此“可构建”通过，`PAPER_HANDOFF.md` 所称 canonical 四命令不足，列 P1。

### 7.3 引用、PDF 和图表

- cite/BibTeX key：30/30；missing 0；uncited 0。
- PDF：10 页、US Letter、未加密、字体全部 embedded/subset。
- PDF metadata Author 为空；文本身份/绝对路径扫描 0 命中。
- 10/10 页视觉检查通过；三张正式图无裁切或重叠。

## 8. 去重后的 Round 2 问题总表

### P0（3）

| ID | 阻塞项 | 证据 |
|---|---|---|
| R2-P0-01 | 模板不合规 | `main.tex:3-7,30-31` 使用 2026 style + 手写 2027 页眉；官方 2027 zip 已发布 |
| R2-P0-02 | 缺 mandatory AI-use statement | 全文无 section；ICLR 2027 AI Policy 要求正文和 submission form 披露 |
| R2-P0-03 | 没有匿名且与 release 声明一致的 supplement | 无 allowlist manifest/zip；整仓明确泄露姓名/remote/本机路径；承诺的 checkpoint/raw replay 又未进入可发布快照 |

### P1（9）

| ID | 主要问题 | 证据 |
|---|---|---|
| R2-P1-01 | 最近邻与新颖性定位不完整 | `main.tex:82-120`；缺 Ludii、Regular Boardgames、Polygames、Hex transfer、棋类 GNN |
| R2-P1-02 | 单游戏外部效度及关键消融/零样本证据缺失 | `experiment_matrix.csv:10-14` |
| R2-P1-03 | Grid/Topology 架构混淆 | `network.py:125-172,224-238` |
| R2-P1-04 | D16 轨迹伪重复，seed/cluster 推断弱 | 45 task、9,000 records、每 task 2 trajectories |
| R2-P1-05 | `30,600 unique games` 统计语义不准确 | `main.tex:373,564`；应写 task-indexed game records |
| R2-P1-06 | compute match 不完整 | parameter/games/simulations 匹配；steps、wall-clock、FLOPs、memory 未匹配 |
| R2-P1-07 | 运行环境未锁定 | `pyproject.toml` 仅 Python>=3.10/torch>=2.3；无 lockfile/container |
| R2-P1-08 | canonical LaTeX 命令少一次稳定 pass | `PAPER_HANDOFF.md:138-146`；四步后仍有 rerun warning |
| R2-P1-09 | D17--D19 尚无冻结正式结果 | v3 dry-run 195/195 PASS 但 formal task=0；manifest `frozen_not_run`；`D17_D19_RESULTS.md` 缺失 |

### P2（5）

| ID | 次要问题 | 证据 |
|---|---|---|
| R2-P2-01 | 文献审计来源说明漏写 DBLP | `paper/LITERATURE_METADATA_AUDIT.md` 前言与两条 DBLP 记录不一致 |
| R2-P2-02 | 多条已有 venue 版本仍引 arXiv | `paper/references.bib` |
| R2-P2-03 | DOI/URL 换行与 Figure 1 caption 字距可改善 | Round 2 PDF 第 3、8--10 页视觉检查 |
| R2-P2-04 | README/handoff 仍保留模板状态漂移 | `paper/PAPER_HANDOFF.md:113-123` 及相关 README |
| R2-P2-05 | 两次中断缺 canonical per-attempt lineage | `runner_control_v1/RECOVERY_INCIDENT.md:17-55` |

## 9. Round 2 决定

- **P0/P1/P2：3 / 9 / 5（去重后）。**
- 三 reviewer 分数：**3、4、4**；均值 **3.67**，中位数 **4**。
- 数字链和 PDF 本体质量明显改善；科学结论仍只能是 seen-size、固定五 seed、固定
  协议下的描述性结果。
- 当前投稿 gate 为 **FAIL**。在 3 个 P0 全部关闭并重新运行匿名/模板/AI-policy gate
  之前，**不允许进入 D23--D24**。
