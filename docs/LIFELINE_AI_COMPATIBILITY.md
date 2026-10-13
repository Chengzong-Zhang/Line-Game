# LIFELINE AI 兼容性与产品接入审计

审计日期：2026-09-21  
审计 checkout：`codex/territory-v2-page-correctness` ；本次不启动 CUDA/训练；网页侧新增的 MCTS 适配只使用当前规则引擎，不改研究协议。  
状态标签：

- **已核实**：本次在当前 checkout 中读取源码、配置、结果或运行了不产生仓库写入的 Web 回归。
- **历史记录**：来自已有历史 rollout/部署记录，不代表当前 checkout 或当前线上仍然存在。
- **待验证**：当前材料不足以确认，不能作为产品能力或科学结论。

## 1. 结论摘要

当前 Web 仓库的可运行 AI 包含 JavaScript `GreedyAI`、`MinimaxAI` 和新增的 `MCTSAI`：它们在 `AIWorker.js` 中运行规则贪心、alpha-beta 和固定预算 UCT 搜索；复盘展品使用贪心、UCT-MCTS-64、Minimax-2/3/4。提示 Worker 是产品并发/生命周期封装，不是另一种 AI。

当前 Web 规则真源是 `web/web前端/GameEngine.js`，默认产品控制器使用 `territory-v2`；支持 5--15 三角棋盘和 2/3 人，但当前产品 AI 入口只允许本地双人。`AIWorker.js` 本身未见独立的三人 fail-closed 校验，不能把 UI 禁用当作 Worker 级安全保证。研究包位于 `research/iclr2027/lifeline_rl`，不是用户所写的仓库根目录 `research/lifeline_rl`；它是 Python 双人环境，包含 Random、Greedy、Minimax-2/3、UCT-MCTS，以及 PyTorch Padded-CNN/Grid-GNN/Topology-GNN + PUCT。

当前 checkout 已从三份冻结 D14--D16 step-200 checkpoint 导出浏览器 F32 权重与 `assets/research-ai/manifest.json`：`ResearchAI.js` 在 Worker 内实现 Padded-CNN、Grid-GNN、Topology-GNN 前向和 PUCT。F32 权重由 `.gitignore` 排除，公开部署前仍须经显式 release/asset 发布并复核 manifest 哈希。

当前 checkout 也没有 GAN/GAIL/PPO/SAC/DQN 等可加载的训练实现与模型资产；研究文档中的 model-free RL 多数仍是计划或 stretch baseline，不能列成已接入网页对手。

已有历史记录称：2026-09-10 曾将 `topology_gnn_v3` 以独立浏览器 Worker 接入并原子切换到 `lifelinegame.cn`，范围限于本地双人 7/9 棋盘；训练规则是 territory-v1，Web 运行时由 territory-v2 负责规则，记录明确称其为“v2-compatible trial”，不是正式 V2 结果。当前公网线上版本、回滚目录和历史文件是否仍在服务，**本次未做线上复核，待验证**。

## 2. 能力矩阵

| AI / 位置 | 规则版本与可运行位置 | 输入状态 / 动作 | 预算 | 解释字段 | 当前接入结论 |
| --- | --- | --- | --- | --- | --- |
| Web Minimax（含 alpha-beta） | **已核实**：Web `GameEngine`；产品控制器默认 `territory-v2`；本地双人。三人 UI 禁用 AI。 | `serializeEngineState` 传 grid、三色 edges、Superko `historyHashes`、跳过/认输、当前玩家、终局、回合、`rulesVersion`、`positionRevision`。返回 `{point, score}`。 | 深度 2/3/4；每个节点按攻击线/邻接己方线/其余排序后最多搜索前 20 个点；`topN=5`。无固定毫秒 deadline。 | **已核实**：数值启发式分数；不返回特征分解、PV 或自然语言。 | **当前可运行**。但 20 点截断与研究侧 PASS 分支语义不同，不是完整动作空间的等价实现。 |
| Web UCT-MCTS-64（展品候选） | **已核实**：`MCTSAI` 与 `GameEngine` 同一规则状态；只在复盘比较 Worker 中运行，不替换默认自动对手。 | 当前完整 Web 状态；落子后由引擎处理自动 skip；不暴露研究侧 PASS 为候选。 | 64 simulations、rollout depth 40、固定 RNG seed、`c=sqrt(2)`。 | root visits、mean rollout value、simulation/rollout budget；rollout value 不是胜率。 | **当前可运行的浏览器搜索展品**；与 Python UCT-MCTS 的 PASS/规则版本/rollout 细节仍不是逐项等价实现。 |
| Web Hint Worker | **已核实**：仍使用 `AIWorker.js` + `MinimaxAI`，只在本地非 AI 回合运行。 | 同上；请求为当前玩家、深度 2、`topN=1`；仅渲染推荐点，不执行落子。 | 每局默认 3 次，可配置 1--10；一次性 Worker，状态变化时取消。无固定 deadline。 | Worker 消息带 `moves[].score`，UI 只显示高亮点；失败/无合法点不扣次数。 | **当前可运行**。必须保留请求 ID、引擎身份、position revision、规则版本、当前玩家五字段防陈旧结果。 |
| Research Random | **已核实**：`LifelineGame` 双人，Superko `enforce`/`observe`；无 Web `rulesVersion`。 | Python 规则对象；所有合法点加 PASS，统一随机。 | 每步 O(合法动作) 枚举；无搜索预算。 | 空诊断；arena 仍记录动作、耗时、终局、领土和 winner。 | **研究/CLI 可运行，不是浏览器能力**。 |
| Research Greedy | **已核实**：同一 Python 双人规则。 | 每个合法点和 PASS 的一层后继；启发式特征为 node、line、logical edge、frontier。 | 一步搜索；默认权重 `100/10/5/1`。 | `selected_score`、四项 feature、全部 root actions。 | **研究基线可运行**；可作为 CPU 降级逻辑，但需先解决规则序列化。 |
| Research Minimax-2 / Minimax-3 | **已核实**：Python 双人；没有三人版本。 | 完整 `GameSnapshot`（含逻辑边和历史）；点动作加 PASS。 | alpha-beta 深度 2/3；默认 `move_cap=20`，分支上限为 20 个点 + PASS。 | value、nodes、leaf evaluations、alpha-beta cutoffs、最大分支、root actions。 | **研究/CLI 可运行**；概念上最接近 Web，但 Web 当前没有显式 PASS 分支和同一诊断协议。 |
| Research UCT-MCTS | **已核实**：Python 双人，Uniform random rollout。 | 同一 Python 游戏状态；合法点加 PASS。 | 默认 64 simulations、rollout depth 80、exploration `sqrt(2)`；由 `factory.py` 可配置。 | simulations、selected visits/mean value、探索系数、rollout depth、root visits/mean values。 | **研究/CLI 可运行**；网页展品已有独立的 Web `MCTSAI`，但不宣称与 Python PASS/规则语义逐项等价。 |
| Research Padded-CNN / Grid-GNN | **已核实**：冻结 D14--D16 seed-20260825、gradient-200 checkpoint 已导出为 hash-bound 浏览器 F32。 | Web `GameEngine` 编码同一 11 维节点特征；Grid-GNN 只读取物理关系；PASS logit 不作为 Web 候选。 | PUCT-16、`c_puct=1.5`；双人 5--15 可推理，checkpoint 训练尺寸仍只为 5/7/9。 | model id、checkpoint/source/asset hash、prior、root visits、root mean value。 | **当前 Web Worker 可运行**；5/7/9 外是结构性尺寸外推试验，非已验证强度；`territory-v2` 仅是规则引擎兼容试验。 |
| Research Topology-GNN + PUCT | **已核实**：冻结 D14--D16 seed-20260825、gradient-200 checkpoint 已导出；输入物理、己方逻辑和对手逻辑关系。 | Web `GameEngine` 完整状态编码，逻辑边由当前执棋方归一化；PASS logit 不作为 Web 候选。 | PUCT-16、`c_puct=1.5`、63,171 参数；双人 5--15 可推理，checkpoint 训练尺寸仍只为 5/7/9。 | model id、checkpoint/source/asset hash、prior、root visits、root mean value。 | **当前 Web Worker 可运行**；5/7/9 外只可称外推试验，仍不能把 Web v2 trial 称作正式 v2 训练或强度结论。 |
| 历史线上 Topology-GNN + PUCT | **历史记录**：浏览器端以 Web `GameEngine`/territory-v2 为规则权威；训练为 territory-v1；仅本地双人 7/9。 | 历史 Worker/模型 manifest/F32 资产；具体桥接 schema 未保存在当前 checkout。 | 历史记录未在本报告重新启动或测量线上时延；模型为 `topology_gnn_v3`，选择依据是已完成权重的训练 loss 排序代理，不是全局/正式冠军证明。 | 历史记录有 manifest/F32 hash 和 PUCT/协议回归标记；当前仓库无法重放该线上文件树。 | **历史线上能力，不是当前仓库能力**；公网当前版本待验证。 |

## 3. 规则与状态兼容性

### 3.1 Web 规则真源（已核实）

- `GameEngine.js` 接受 `gridSize=5..15`、`playerCount=2/3`、`territory-v1`/`territory-v2`。
- `GameController` 的默认 `rulesVersion` 是 `territory-v2`；产品设置会把规则版本写进本地/房间设置。
- 落子使用真实 `playMove()`，包括保护区、三点限制、阻挡攻击、级联移除、显式逻辑边维护和 Superko；无合法落子时由引擎自动 skip，产品层另有 `skipTurn()`。
- AI 快照协议显式携带 `grid`、三方 edges、`historyHashes`、`consecutiveSkips`、`resignedPlayers`、`currentPlayer`、`gameOver`、`turnCount` 和 revision。Worker 回写前还校验规则版本与当前玩家。
- 当前搜索评估使用 `fastTerritoryBFS`，不是终局精确 territory-v2 面积；因此搜索分数不能当作产品最终计分。

### 3.2 research/lifeline_rl（已核实）

- `LifelineGame` 是纯 Python、双人、5--15 棋盘；没有 `territory-v1/v2` 字段，只有 `superko_mode=enforce/observe`。
- `LifelineEnv` 固定整数动作空间：三角棋盘点按 row-major 编号，最后一个动作是 PASS；观察默认 `topology_history`，包含 board、坐标、当前玩家、连续 skip、合法动作 mask、物理边、逻辑边和历史 digest。
- 终局可计算精确 territory；非终局研究启发式明确不使用 exact territory。研究 arena 记录 diagnostics、动作序列、decision time、最终领土和 winner。
- 研究合同明确“双人学习”和“Web deployment of trained policies”在原始范围外；这解释了研究代码虽可运行，却没有现成产品接入协议。

### 3.3 差异判定

| 差异 | 影响 |
| --- | --- |
| Web 有 territory-v1/v2，研究 core 无 rulesVersion | 同一个 checkpoint 不能仅凭 `superko=enforce` 证明与 Web v2 等价；必须绑定规则版本和 parity receipt。 |
| Web 支持三人且有认输集合，研究是双人且 GameSnapshot 无 resignedPlayers | 研究模型不能安全用于 Web 三人；三人应保持禁用或另建策略。 |
| Web 动作以 `[x,y]`/空结果表达，研究动作是整数点编号 + PASS | 需要固定坐标/索引映射、PASS、自动 skip 和 terminal 语义，不能直接传 JSON 字段。 |
| Web 运行时使用 Map/Set/字符串 edge key，网络模型使用 padded tensor/adjacency/mask | 需要确定性 encoder，并绑定 `gridSize`、节点 mask、关系顺序、legal mask 和 schema version。 |
| Web 当前 Minimax 有前 20 点截断；研究 Minimax 明确把 PASS 作为额外分支 | 两者的搜索预算和候选动作集合不同，不能把 Web Minimax 测试结果当作 research Minimax 或 PUCT 对照。 |
| 历史部署使用 v1 训练、v2 规则运行 | 属于兼容试验；在未有同一状态集的 v1/v2 parity 与模型回归前，不应升级为 v2 训练模型或正式强度结论。 |

## 4. 浏览器接入障碍与安全边界

1. **运行时**：当前 Topology-GNN 是 PyTorch 模型，研究代码的 neural agent 依赖 Python/PyTorch；浏览器不能直接加载 `.pt` 并执行该 Python adapter。需要经过 ONNX/WebGPU/TF.js 等可审计导出，或放到独立服务端推理 API。
2. **模型资产**：当前 checkout 没有历史 F32 权重、manifest、Topology Worker 或其 hash-bound 发布目录；模型文件还受 `.gitignore`/发布资产策略影响。缺少这些文件时只能降级，不能“凭类名”启用模型。
3. **状态编码**：必须把 Web 的完整 rule state 编码成研究模型的 11 维节点特征、三类关系邻接、合法动作 mask 和 PASS；关系顺序、节点 padding、坐标、颜色、当前玩家和 `gridSize` 都需 schema 化。
4. **规则版本**：模型训练/验证记录为 territory-v1，而产品默认 v2；没有规则版本绑定的 manifest、固定 parity fixtures、终局/历史 Superko 回放验证，不应上线自动落子。
5. **异步结果**：新模型也必须复用当前五字段 stale-result 检查、取消、Worker terminate、非法动作复验和超时；任何 schema/hash/model-load/推理错误都应 fail-closed。
6. **解释与观测**：产品当前只展示 Minimax 分数或 hint 点，没有解释面板。若接入神经模型，应至少展示 model id、checkpoint hash、simulations、selected prior/Q/visits、规则版本和 fallback reason，并避免把 prior/Q 说成可读因果解释。
7. **线上状态**：历史记录中的公网 hash、rollback 路径和 Uvicorn 进程是 2026-09-10 的时间点证据；本审计未访问公网或服务器，不能确认当前线上是否仍是该版本。

## 5. 降级方案

### v0.1（建议立即采用的产品边界）

- 默认只发布当前 Web Minimax：双人、本地、`territory-v2`，深度 2/3/4；三人明确显示“AI 不可用”。
- Hint 继续复用深度 2 的一次性 Worker；保留五字段 stale-result guard、合法动作二次检查和取消逻辑。
- 任何未来模型加载失败、hash 不匹配、规则版本不匹配、超时、非法动作或 Worker 崩溃，回退到 Minimax depth=2；若连 Minimax 不可用则只提示“暂无推荐”，不自动猜步。
- 产品只承诺“推荐落点/搜索分数”，不承诺胜率、全局最优、可解释因果或研究模型强度。

### v1.0（研究模型产品化的关闭条件）

- 发布一个版本化 adapter：`rulesVersion`、`stateSchemaVersion`、`modelKind`、`checkpointHash`、`sourceHash`、`gridSize`、`playerCount`、`superkoMode`、动作映射和预算全部写入 manifest。
- 先以 Web `GameEngine` 为唯一规则权威，完成 v1/v2 的固定状态集 parity：合法性、攻击/级联移除、逻辑边、Superko、PASS/auto-skip、终局和认输；每个模型只允许声明其实际覆盖范围。
- 选择浏览器推理或服务端推理之一并固定 SLA：浏览器侧用 Worker + 可验证导出；服务端侧使用版本化 API、超时、健康检查、模型 hash 和回滚。两者都不能把 Python core 直接当 Web 规则后端。
- 已完成代码级 2 人 5--15 合法性与 PUCT 边界回归；应继续单独收集 5/7/9 外的强度、时延和移动端证据。三人必须单独训练/验证，不得把双人 Topology-GNN 复用为三人 AI。
- 解释协议至少输出候选动作、prior/Q/visits、搜索预算、模型/规则版本、fallback reason；UI 文案须把“搜索统计”与“解释”分开。
- 生产切换沿用历史记录中已验证的原子目录交换、hash 校验、保留 rollback 和公网静态资源检查；当前 checkout 尚未恢复该资产链，故不能直接复刻历史部署。

## 6. 本次核验与证据索引

### 当前 checkout 已核实

- Web AI：[`web/web前端/AIEngine.js`](../web/web前端/AIEngine.js)、[`AIWorker.js`](../web/web前端/AIWorker.js)、[`AIStateProtocol.js`](../web/web前端/AIStateProtocol.js)、[`HintWorkerSession.js`](../web/web前端/HintWorkerSession.js)、[`GameEngine.js`](../web/web前端/GameEngine.js)、[`OnlineApp.js`](../web/web前端/OnlineApp.js)。
- 研究规则/基线：[`research/iclr2027/lifeline_rl/core.py`](../research/iclr2027/lifeline_rl/core.py)、[`env.py`](../research/iclr2027/lifeline_rl/env.py)、`agents/`、[`alphazero/network.py`](../research/iclr2027/lifeline_rl/alphazero/network.py)、[`neural_agent.py`](../research/iclr2027/lifeline_rl/alphazero/neural_agent.py)。
- 已有 D13 结果：[`research/iclr2027/results/formal/d13/topology_seed20260825_vs_random/summary.json`](../research/iclr2027/results/formal/d13/topology_seed20260825_vs_random/summary.json)、`gate.json`、`topology_seed20260825_learning_health.json`；记录 63,171 参数、训练尺寸 5/7/9、评估 PUCT-16、200 局/0.895 score rate（该结果是研究证据，不是 Web 线上证明）。
- 研究边界：[`research/iclr2027/D1_research_contract.md`](../research/iclr2027/D1_research_contract.md)、[`CLAIM_EVIDENCE_LIMITATION.md`](../research/iclr2027/CLAIM_EVIDENCE_LIMITATION.md)、[`D14_D16_RESULTS.md`](../research/iclr2027/D14_D16_RESULTS.md)。
- 本次只读 Web 回归均通过：`verify-ai-control-flow.mjs`、`verify-ai-search-15.mjs`、`verify-hint-worker.mjs`、`verify-territory-v2.mjs`，均 exit 0；未运行 Python/CUDA/训练。

### 历史记录（不等于当前能力）

- 2026-09-10 历史部署记录：曾选用 `topology_gnn_v3`，浏览器端新增 Topology 模型/PUCT Worker、manifest/F32 资产，限制本地双人 7/9，使用 Web territory-v2 规则权威；记录的 F32 SHA-256 为 `e29e50fb1240f917cfd3d169152d749b9464beebffaacd87567457a71efa28cc`，manifest SHA-256 为 `e62bf947c76da782189da1a5957478948207011e0b898f2ff17133eaecadbe9a`。
- 该历史记录还记载原子切换标记 `ATOMIC_SWITCH_OK`、公网 hash 检查和 rollback 目录；这些材料不在当前 checkout 文件树中，本次没有重新访问服务器。

### 待验证清单

- 当前 `lifelinegame.cn` 实际服务的 index/Worker/manifest/F32 hash、模型版本和是否仍保留 rollback。
- 历史浏览器 encoder 与当前 Web `GameEngine` 的完整源码/manifest 是否可恢复，以及它是否覆盖当前 territory-v2 版本。
- 浏览器或服务端推理的实际延迟、内存、移动端兼容、超时阈值和模型加载失败率。
- 任何 Topology-GNN 结果在 Web 规则 v2、真实产品设置和用户对局分布下的独立强度/安全验证。
