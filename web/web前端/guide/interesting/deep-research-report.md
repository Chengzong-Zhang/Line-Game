# deep-research-report.md（旧稿已归档）

> 本文件是早期深度研究草稿，已停止维护，不应作为当前规则或复杂度结论的依据。

请改读：

- [当前中文理论架构](./why-theory.zh.md)
- [Current English theory framework](./why-theory.en.md)

旧稿中的下列结论已废弃：

1. **节点三态等价压缩**：当前实现把显式逻辑边纳入连通性、攻击恢复和 Superko 哈希；边集不是可从节点三态唯一恢复的缓存。
2. **“每一步都增加历史集合 H”**：只有成功落子向 H 写入新哈希；主动/自动跳过与认输不增加 H。DAG 证明必须使用包含 H、认输集合与连续跳过计数的增广状态。
3. **“已经证明迫移使策略窃取失效”**：当前已严格证明两条可达历史能到达同一规则核，却使同一应手只在一侧因 Superko 被禁；这否定历史盲复制，并给出“制胜动作集从 3 缩为 2”的精确绕行见证。但两侧 Minimax 根值仍同为 \(+1\)，主动 Pass 仍合法，正确携带 \(H\) 的弱首 Pass 窃取定理也未被击穿，所以旧强结论仍不成立。
4. **未完成归约的 hardness 声明**：尚无从 SAT、QBF、Generalized Geography 等标准问题出发的完整多项式归约，因此不得宣称 NP-hard、PSPACE-hard、EXPTIME-hard 或相应完备性。
5. **领土/胜负镜像对称**：当前贪心计分已有可达的 `DRAW → BLACK` 镜像反例；完整 winner 等变并不成立。严格反例、Pass-pressure 定理和 Col 下界路线见当前理论架构第 7、10 节。
6. **直接套用围棋复杂度**：围棋的 PSPACE-hard、EXPTIME-complete 与 LADDERS PSPACE-complete 结论分别依赖特定 ko 规则、任意预置局面、气、提子、征子或 ko-bank gadget；它们只能作为比较，不能推出当前 LIFELINE 的任何 hardness 下界。
7. **把当前盘面直接当作 AI/强化学习状态**：Superko 同核异史见证严格证明盘面、显式边、行动方和跳过数相同时，合法动作 mask 仍可因 \(H\) 不同而分叉。组合博弈的节拍/历史指标、精确 RL 状态、奖励塑形、图网络表示和三人多智能体边界现统一维护在当前理论架构第 6、11 节。
