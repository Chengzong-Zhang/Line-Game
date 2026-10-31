# 三人 AI v1：轻量模仿训练与运行契约

本版本提供 `strategy: "three-player"`、`modelId: "three-player-policy-v1"`，
供 `territory-v2` 三人三角棋盘使用。任意一个或两个座位可以交给 AI；
座位编排、暂停、重开和异步响应校验由页面与现有 Worker 协议负责。

## 模型与训练

- 模型是 16 个相对局面特征的线性动作策略，导出为小型 JSON。
  特征包括己方节点/覆盖/可达空间、相对最强对手的优势、攻击造成的损失、
  新增己方结构、与出生点的距离和边界扩张。没有将两名对手合成一个棋子颜色。
- 第一阶段模仿现有双人 `MinimaxAI(depth=2)`。第二阶段在真实三人规则状态上
  模仿两层 MaxN 教师；每个行动方选择最大化自身收益的动作，不假定两名对手合作。
- 两阶段均使用 `GameEngine.js` 的 `territory-v2`、完整 Superko 历史和合法动作。
  教师评分是启发式收益，不能解释为真实领土面积、胜率或已证明最优动作。
- 固定 seed 为 `20261020`，训练尺寸为 5、7、9；生成 12 个双人、24 个三人轨迹单元，
  每个单元最多 18 步。未到终局的单元明确计入 `truncated_episodes`。
  训练集合与三人留出集合按完整轨迹单元划分，不把同局各步当独立对局结果。
- 第一阶段训练 100 轮、第二阶段 180 轮。收据记录真实样本数量、交叉熵、协议、
  模型 SHA-256 与四个源文件的字节 SHA-256。它是产品初始模型，
  不是正式强化学习结果，也没有宣称超过双人 AI 或其他基线。
- 运行尺寸为 5–15。10–15 未参加训练；这些尺寸的检查支持合法运行和状态保持，
  不支持棋力或泛化提升结论。

## 运行与失败行为

`ThreePlayerAI.getTopMoves(engine, currentPlayer, topN)` 只接收当前行动方，
返回 `point`、`score`、`prior`、`visits`。候选动作使用当前真实规则引擎的合法掩码；
`prior` 是本次合法候选间归一化的动作偏好，`score` 是线性策略 logit。
无合法动作返回空数组，由对局控制器执行规范跳过。

所有候选状态模拟均通过 `try/finally` 恢复棋盘、各色边、历史、当前玩家、
回合数、终局、认输、跳过和领土缓存。Worker 仍返回请求 ID、版本、行动方和
位置 revision，由页面复验是否属于当前对局。模型加载或验证失败返回错误，
保留对局；失败的加载缓存会清除，因此重新请求可以重试。

## 复现与恢复

在仓库根目录执行：

```powershell
node --unhandled-rejections=strict 'web/tools/train-three-player-ai.mjs' --run-root 'local_artifacts/three-player-ai-final-v1' --max-seconds 90
node --unhandled-rejections=strict 'web/web前端/tests/verify-three-player-ai.mjs'
node --unhandled-rejections=strict 'web/web前端/tests/verify-three-player-training-recovery.mjs'
```

这是有界 CPU 产品训练任务。默认最多 240 秒的数据生成预算，单次最多 600 秒；
时间到会在完整轨迹单元边界暂停。`--max-new-games N` 可进一步限定本次新增单元。
重复同一命令会读取校验后的检查点，跳过已完成单元并恢复已完成训练轮数。
源文件或协议变化必须选择新的 run-root，不能修改旧检查点绕过检查。

原始样本、每单元摘要、训练权重检查点和锁信息留在 `local_artifacts/`。
检查点先写临时文件再原子替换，并带完整性校验；崩溃遗留的临时写入会隔离保留。
仅绑定 `127.0.0.1` 的独占租约阻止同一 run-root 同时运行两个进程，
进程退出时操作系统自动释放租约；`run.lock` 只是信息收据。
恢复测试真实终止一个生成进程，再验证续跑与无中断执行结果完全相同。

这个短训练入口不提供长期无人值守作业的独立监督与自动重启。
若扩大为长训练，必须先满足仓库长任务要求，不能直接将时间上限加大。

## 交付文件与验证边界

- `web/web前端/ThreePlayerAI.js`：合法动作特征、模型校验与推理。
- `web/web前端/AIWorker.js`：三人策略入口与现有请求协议。
- `web/tools/train-three-player-ai.mjs`：有界训练、恢复与导出。
- `web/web前端/assets/research-ai/three-player-policy-v1.json`：训练后的文本模型。
- 同目录 `.training-receipt.json`：训练与来源收据。

专用 Node 检查覆盖各个座位、5/9/15 尺寸、一个/两个 AI 完整小盘对局、
Superko、异常回滚、Worker 回包和模型来源。真实页面交互、网络房间与发布状态
必须另行验证；这些检查不等于浏览器、手机实机或线上验收。
