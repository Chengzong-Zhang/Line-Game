# 防守模型继续训练与可靠流水线 v2

本任务沿用现有产品权重，使用 2026-10-25 防守 teacher 的新完整标签。冻结的 teacher、v1 数据编译器、旧训练数据及研究结果不修改。新权重保持隔离，训练完成、有限 teacher 对照、完整对战强度和产品准入分别报告。

## 数据、父模型与边界

`prepare-defensive-warmstart-v2.mjs` 从固定 seed 的原生合法游戏采样完整前缀，包括规则、逻辑边、行动方、起点和 Superko 历史。整场独立游戏决定 train/validation；优先近期连续受切和有反切机会的中后盘，再按晚盘排序。`maximum_legal_placements` 限制的是源局面选择，不截断 teacher 根动作。该选择有明确的迟盘和战术偏差，不代表全局面均匀分布。

可选 pilot 预筛对每个源局面调用未修改 teacher，分别持久记录 `COMPLETE_TEACHER_PROBE_NOT_DATA` 或 `REJECTED_INCOMPLETE_SEARCH`。每个 receipt 保留实际搜索完成深度、根动作、节点和超时情况；拒绝数不计训练样本。pilot 只用于成本校准，正式编译器仍通过 `defensive-training-data-v1.mjs` 重新产生正式标签。pilot 每段最多 60 秒，支持同参数续跑及 PAUSE/STOP。其完成单元收据不会重算。

正式标签必须完整达到 `max(3, 2 * surviving seats)` 层，包含所有合法根动作和 PASS，根价值精确；预算不足使正式流水线停止并保留拒绝收据。不会降深度、裁剪根候选或采用启发式 fallback 来凑标签。

四组 parent 为当前 `multiplayer-easy-v1`、`three-player-search-v4-round12` 的线性权重、`three-player-policy-v1` 和 `hex-player-policy-v1`。继承 16 维权重除以原温度后追加新 PASS 系数 0，初始落点 logit 逐项核验。PASS 概率与旧搜索行为不是继承的能力。新实验重置优化器，记录父文件路径、SHA-256、特征顺序、温度及原始权重；同实验 resume 则恢复已有更新，不能重新初始化。

三人 parent 仅消费三人子集，hex parent 仅消费 4–6 人子集，easy 消费 2–6 人子集。7–15 人当前搜索模式没有对应已有训练权重，本流水线不声称训练了这些人数的模型。神经模型使用单独的新桥接和训练任务；线性继续训练不代表神经模型已经训练。

## 准备和启动

仓库中的 `defensive-warmstart-v2.draft.json` 是待当前成本校准的模板，不是已授权运行规模。正式配置应保存为新文件，固定位置数、预算和更新数；源代码变化后使用新 run root。

```powershell
node web/tools/prepare-defensive-warmstart-v2.mjs --run-root C:/absolute/new-run --protocol C:/absolute/final-protocol.json --probe --probe-run-root C:/absolute/pilot-prefilter --probe-max-new-units 32 --probe-max-seconds 30 --probe-time-ms 1500 --probe-max-nodes 20000
```

返回 75 表示 pilot 尚未全部完成；使用相同参数继续，已完成的 pilot receipt 只验证哈希。完成后写出正式 `protocol.json`、`positions.json`、`frozen-sources.json`、采样收据和 `job.json`。也可加 `--input` 使用事先冻结的源局面数组。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File web/tools/launch-defensive-warmstart-v2.ps1 -JobPath C:/absolute/new-run/job.json -InstallLoginRecovery
```

启动器在隐藏进程中运行现有独立 supervisor，并可安装本用户 Startup 快捷方式。登录恢复只接续同一个已开始且仍在原绝对截止时间内的 PREPARED/RUNNING 任务；尊重 PAUSE/STOP，不移除锁、不扩大预算。快捷方式路径写在本地启动收据中，删除该快捷方式即可移除登录恢复入口。`-CheckOnly` 只报告路径，不启动或安装。

暂停和停止：在正式 run root 创建 `PAUSE` 或 `STOP` 文件。进度在 `progress.json`、`checkpoint.json` 和 `supervisor-state.json`；退出码、每次进程身份、重试和异常保留在 supervisor 收据中。手动确认恢复时才使用现有 supervisor 的 `--resume`，其重置预算语义需计入新授权；自动登录恢复从不传该参数。

## 持久单元和验证

正式流水线依次完成：每源局面一个 v1 标签单元、每 parent 每次参数更新一个单元、每 parent 每个 validation 局面一个有限 teacher 对照单元。不同阶段的子检查点独立原子保存，主检查点在意外中断后从已验证子计数接纳进度，不重复完成单元。源、输入、父资产、标签、checkpoint 或配置损坏时停止。已有 supervisor 提供互斥锁、worker-host、意外退出重试、无进展重试上限和原绝对墙钟预算；孤儿 worker 被回收后才允许替代进程。

恢复回归命令：

```powershell
node web/web前端/tests/verify-defensive-warmstart-pipeline-v2.mjs
node web/web前端/tests/verify-defensive-warmstart-v2.mjs
```

这些命令覆盖微型 fixture 的标签/参数中断、干净运行一致、完成幂等、重复 worker/supervisor、暂停/停止、完整性损坏、预算拒绝、真实 worker 与 supervisor 退出恢复，以及隐藏启动器和登录恢复决策。它们不证明新模型棋力提升。

独立 `verify-defensive-warmstart-v2.mjs` 的 report 只比较未用于训练的完整 teacher 标签，包括 CE、teacher 最优动作一致率、受切损失和根连通攻击指标，不运行完整对局。所有候选和报告继续标记 `strength_verified:false`、`runtime_admitted:false`。原始游戏、逐样本数据、checkpoint、日志和执行树留在本地；版本控制仅保留协议、源码、测试和紧凑结果。
