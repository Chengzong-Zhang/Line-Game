# Code：一盘棋如何变成可靠的程序

[查看 GitHub 源码](https://github.com/Chengzong-Zhang/Line-Game) · [项目 README](https://github.com/Chengzong-Zhang/Line-Game/blob/main/README.md)

LIFELINE 的实现围绕三件事展开：节点和连线怎样改变局面，AI 怎样在真实规则下搜索，以及异步计算怎样安全地回到正在进行的对局。

## 1. 同一棋盘，两层事实

物理层 `grid` 记录每个格点的占用状态，逻辑层 `edges` 记录节点间真正存在的连接。棋盘上连续的同色线点不能代替图中的连通关系。

- Canvas 读取物理状态，画出节点、连线与领土。
- 连通性判断沿逻辑边进行 BFS，检查结构能否回到自己的基点。
- 落在敌方线点上的攻击会切断连接，随后清除失去基点连接的结构。

这种分离使“看起来连着”和“规则上连着”都有明确的判定依据。规则真源是 [GameEngine.js](https://github.com/Chengzong-Zhang/Line-Game/blob/main/web/web%E5%89%8D%E7%AB%AF/GameEngine.js)。

## 2. 一次落子是一笔事务

落子需要同时改变节点、自动连线、被攻击的一方、回合与历史。中间任何一项校验失败，都不能留下半个新局面。

```text
检查坐标、占用、保护区与三点限制
→ 保存规则状态
→ 添加节点并生成合法连线
→ 结算切断攻击与失联清除
→ 检查 Superko
→ 提交行动与下一回合；失败则恢复原状态
```

Superko 不只看眼前棋盘。相同盘面搭配不同 `historyHashes`，可能拥有不同的合法动作集合，所以搜索、保存、Worker 快照和复盘都要保留历史。

## 3. 领土由离散规则决定

Web 页面和新房间使用 `territory-v2`。引擎从有效闭环和墙集合计算覆盖格点，处理候选边界、玩家基角规范化与离散泛洪；最终比分使用规则定义的 `area`。

渲染用的几何面积、AI 的快速领土估计与最终规则计分分别承担不同职责。页面不能用搜索估值替换结算比分。

裸引擎仍保留 `territory-v1` 兼容入口；Python/Pygame 是 legacy v1 lineage，研究环境依据自己的冻结协议运行。跨实现比较需要明确版本和相同输入。

## 4. AI 如何选落点

本地双人局可分别为蓝方、红方选择棋手。人类之外有 9 种 AI 策略：

| 策略 | 决策方式 |
| --- | --- |
| Minimax | 在规则生成的后继局面中进行 Alpha-Beta 搜索，并使用候选排序和启发式评估 |
| Padded-CNN + PUCT | 网格特征经卷积网络得到先验与价值，再进行 PUCT 搜索 |
| Grid-GNN + PUCT | 沿网格邻接传播信息，结合 PUCT 搜索 |
| Topology-GNN + PUCT | 同时利用网格邻接与双方实际连线，再进行 PUCT 搜索 |
| DQN / PPO / SAC / GAIL / GAN | 读取各自导出的模型，依据当前合法动作选择落点 |

Minimax 的三档难度对应深度 2、3、4。PUCT 结合网络先验、价值估计与访问次数，在既定预算内探索候选；这些数值不等于真实胜率。

浏览器直接读取 `.f32` 权重进行推理。迁移模型训练尺寸为 5–15，状态为 `PILOT_ONLY`；旧模型训练尺寸为 5/7/9，接入当前规则时标为兼容试用。种子用于区分训练副本，不是棋力排名。

代码入口是 [AIEngine.js](https://github.com/Chengzong-Zhang/Line-Game/blob/main/web/web%E5%89%8D%E7%AB%AF/AIEngine.js)、[ResearchAI.js](https://github.com/Chengzong-Zhang/Line-Game/blob/main/web/web%E5%89%8D%E7%AB%AF/ResearchAI.js)和 [ModelFreeAI.js](https://github.com/Chengzong-Zhang/Line-Game/blob/main/web/web%E5%89%8D%E7%AB%AF/ModelFreeAI.js)。

## 5. Worker 的结果必须属于当前对局

AI、提示和领土计算使用 Worker，避免长计算堵住页面。响应返回时，要核对请求 ID、引擎身份、局面版本、规则版本和行动方。

如果玩家已经重开、切换设置或完成新行动，旧结果就不能落子或覆盖当前显示。AI 真正执行行动前还会重新检查合法性。相关协议见 [AIStateProtocol.js](https://github.com/Chengzong-Zhang/Line-Game/blob/main/web/web%E5%89%8D%E7%AB%AF/AIStateProtocol.js)。

## 6. 棋谱可以复盘，也必须能验证

棋谱记录规则版本、初始配置、行动序列与终局摘要。导入时先在隔离引擎中按规则重放，检查行动方、事件效果、哈希与终局，再替换页面对局；损坏或未知版本不能破坏当前棋盘。

复盘时间轴、检查器和 AI 对比读取相应的历史局面，分析过程与正在玩的棋相互隔离。编码与校验入口是 [ReplayCodec.js](https://github.com/Chengzong-Zhang/Line-Game/blob/main/web/web%E5%89%8D%E7%AB%AF/ReplayCodec.js)。

## 7. 前端、服务器与训练各有入口

```text
web/web前端/  规则、Canvas、棋手选择、Worker、棋谱与教学
web/web后端/  账号、房间同步、匿名棋谱收件
web/tools/    棋谱校验与筛选、发布清单、原子上线与公网核验
research/     研究环境、训练源码、冻结协议、聚合结果与论文
core algorithm/  Python/Pygame 桌面示例
docs/         产品契约、平台计划、上线证据与历史资料
```

服务器负责账号和房间同步，完整棋盘规则在前端执行。匿名棋谱贡献由玩家自愿开启，收件与训练筛选走独立流程。

## 8. 测试让约定可检查

自动回归覆盖规则、完整状态、异步结果归属、独立棋手设置和棋谱重放；实际浏览器检查补足页面、Canvas 与 Worker 的真实行为。冻结研究证据与普通工程检查分别记录。

[文档导航](https://github.com/Chengzong-Zhang/Line-Game/blob/main/docs/README.md)提供各模块入口；[早期工程讲解](https://github.com/Chengzong-Zhang/Line-Game/blob/main/docs/archive/engineering/legacy-code.md)保留最初 Python/Pygame 实现的详细说明。
