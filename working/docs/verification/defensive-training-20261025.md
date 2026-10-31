# 后续训练：完整防守 Minimax 标签

日期：2026-10-25。实现和有界恢复检查完成；没有启动生产重训，没有替换网页或微信中的既有模型权重，没有新增棋力或晋升结论。

## 旧数据实际来自哪里

“以前所有数据都只看一步”不准确，但部分旧标签确实很浅。

| 当前源码/所读现场源码 | 旧教师实际机制 |
| --- | --- |
| `web/tools/train-hex-player-ai.mjs` | 双人迁移教师明确为 Minimax depth=1；六边形教师为自身单步效用加下一席贪心回复，只保留前四个候选。 |
| `web/tools/train-three-player-ai.mjs` | 双人 Minimax depth=2；三人 MaxN depth=2，回复层最多八个启发式候选。 |
| `web/tools/neural-posttraining-data*.mjs` | 配置强制 depth=2；原 Minimax 根/回复启发式列表最多二十个候选。 |
| `web/tools/neural-terminal-rollout-data-r3.mjs` | 有完整终局 rollout，但不是完整多步 Minimax 标签。 |
| 主工作树 `docs/verification/multiplayer-20261022/training-improvement-diagnosis.md` | 多人早期教师 depth=2，非终局为 `15 nodes + 8 coverage + 20 reach`；共享可达空域不是真正离散计分，旧诊断已记录教师对战门失败。 |
| 主工作树 `web/tools/multiplayer-fixed-teacher-v3.mjs` | 请求 `min(playerCount+1, 6)`，受节点预算限制，且没有强制 `completedDepth >=3`；请求深度不能冒充实际完成深度。 |

因此不能把全部旧模型都简单归为“只进攻”，也不能仅调大请求深度就宣称问题已解决。既有模型、冻结配置和已完成结果保留原来源和能力边界。新增门禁只约束今后的训练。

## 新路径

- `web/web前端/DefensiveTrainingTeacher.js`：离线完整合法动作 Minimax，包含主动 PASS。每个根动作独立精确窗口，alpha-beta 不把上界当作训练价值。
- 强制实际完成深度至少三层；为看到每个对手第二次实际行动，默认至少 `max(3, 2 × 存活人数)`，双人四层、三人六层。按引擎实际行动方和自动跳过推进，保留完整历史、逻辑边及规则版本。三层不是三轮，也不足以覆盖双人对手的第二次行动。
- 词典序目标依次为真实终局结果、保留己方原节点、避免重复遭到破坏、保留原覆盖、出生点连通、持续且仍根连通的切断链、敌方持续损失、节点和覆盖。局部空间估计不能抵消多丢己方节点。连接必须沿真实未断裂逻辑边回到起点，不能用视觉上靠近或填色代替。
- 多人采用明确的 paranoid 对手模型，所有非己方实际行动都最小化己方价值。它是一种保守模型，不能称为现实对手的真实策略或全局最优。
- 预算耗尽返回 `NO_LABEL_INCOMPLETE_SEARCH`，`label:null`。完整根排序、实际完成深度、PASS、候选无截断和防守契约在数据生成及训练消费两端再次检查。不会把一步回退、部分排序或超时当作三步标签。
- 原一步/两步及 rollout-only 的产品训练入口在开始前明确拒绝新训练；旧源代码计算函数和冻结文件保留供只读核查。新路径不修改研究目录中的冻结正式实验。

新数据入口 `web/tools/defensive-training-data-v1.mjs` 接收冻结 JSON 数组：每条为 `{id, split, state}`，`state` 来自 `serializeEngineState(engine)`，包含规则、完整历史和逻辑边。`split` 为 `train` 或 `validation`；同一完整局面不能跨集合重复。它输出完整动作价值和目标，以及当前十六维候选特征加显式 PASS 特征。每个样本独立原子保存并按哈希索引；崩溃后可接纳已经完成但未入索引的样本，不重复计算它。

```powershell
node web/tools/defensive-training-data-v1.mjs --input C:/absolute/frozen-positions.json --run-root local_artifacts/defensive-training-v1/data --max-new-units 1
node web/tools/train-defensive-policy-v1.mjs --data-root local_artifacts/defensive-training-v1/data --run-root local_artifacts/defensive-training-v1/model --max-new-units 1
```

两条命令均为有界单元，退出码 `75` 表示暂停或让出后可使用相同参数恢复，`78` 表示配置/完整性/预算拒绝；数据预算不足时保留失败收据且不产标签。修改源、输入或配置必须另建 run root，不能伪装成同实验恢复。新训练器只接受新完整标签数据集，保存每次确定性全批量更新。输出是隔离的十七维线性候选，标记 `strength_verified:false`、`runtime_admitted:false`，不自动装入产品。

复杂大盘和多人完整两轮搜索可能很昂贵，默认预算不足会拒绝标签。没有启动长训练。长任务仍须先通过恢复演练、冻结预算并复用 `supervise-three-player-job.mjs` 独立监督；使用运行目录 `PAUSE`/`STOP` 控制文件，监督者负责退出码、重试边界及防重复，不能直接把此有界命令当作无人值守长任务发布。

## 验证范围

命令：`node web/web前端/tests/verify-defensive-training-v1.mjs`，退出码 0。

- v2/v3 真实合法前缀 `[[2,0],[3,1],[0,1],[0,4]]`：完整四层、四个根动作含 PASS、106 节点；选择主动铺垫 `[2,1]`。每个根动作价值与禁用剪枝的完整搜索一致。
- 拒绝一层、两层、三层不足两轮的请求以及被篡改的完成深度/候选截断/非精确收据；预算不足无标签；调用者完整状态不变。
- 防守优先及重复破坏优先的价值测试；删除实际逻辑边后攻击节点失去“从起点连续”信用。
- 样本写入后中断可按哈希接纳；三次极小测试更新中断/恢复与干净运行权重一致；完成后不重跑；暂停、重复锁及损坏拒绝通过；旧数据和旧入口拒绝通过。

这些是工程与固定战术回归。它们不证明全部十五人局面可在预算内造出完整标签、不证明棋力提升，也不替代训练后相同预算对战、模型晋升或真机验收。
