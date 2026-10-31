# 全尺寸迁移模型的网页接入验收

日期：2026-10-12（Asia/Shanghai）。状态：**已实现并在本地验证；PILOT_ONLY / COMPATIBILITY_TRIAL；未部署**。

Padded-CNN、Grid-GNN、Topology-GNN 各 3 个 seed（2026092201/02/03）的 transfer_all stage3 已导出。新资产独立位于 `web/web前端/assets/research-ai/transfer-v1/`，总计 2,265,264 bytes。原 `assets/research-ai/manifest.json` 和三个旧 F32 未覆盖，原始及正式 checkpoint 未改动；冻结协议、runner、campaign 均未修改。没有 commit、push 或 deploy。

## 使用与选择

在本地网页的“棋盘舱”中选择双人局、AI 先手或后手，再选择三个网络家族之一；“PUCT 种子 / 旧模型”可明确选三个 seed，或回到 seed20260825 的 D14/D16 g200。家族与 seed 共同决定唯一模型 ID。初始默认 seed2026092201，依据是最小种子的稳定排列，不是棋力排名；seed 选择写入独立 localStorage 键，刷新后保留。

迁移模型只开放双人 territory-v2、边长 5–15；UI 和 manifest 都标明训练尺寸、seed、PUCT-16、c_puct=1.5、PILOT_ONLY 和 COMPATIBILITY_TRIAL。比较面板保留 9 个新模型、3 个旧模型以及既有其他算法。候选显示 PASS、prior、visits、root-player Q；这些统计不是胜率或棋力证明。模型加载失败会给出可见提示并回退 Minimax。

## 已通过的验证

| 层次 | 结果与范围 |
|---|---|
| 来源完整性 | 27 个阶段逐一核对；9 个 stage3 的真实 checkpoint SHA、latest schema/大小/配置/来源、冻结 plan 配置、父阶段来源链、回执和 trainer 计数一致。额外核验 stage1 原始 D14/D16 pinned checkpoint。 |
| F32 导出 | 9 个模型、270 个 tensor，little-endian F32、C-order；名称/顺序/shape/有限性逐项核对，逐 tensor 数值完全相同。每个 asset SHA-256 正确。 |
| Python/Web 数值 | 22 个非初态 × 9 个模型 = 198 比较，覆盖 5–15 和双方起始。11 维特征、row-major 点序、三类逻辑关系逐项一致；最大 logit 误差 9.5367431640625e-7，最大 value 误差 1.4414667030143713e-7，阈值 3e-5。 |
| 网页前向 | 9 模型 × 11 尺寸 × 2 起始，共 198 个非初态；有限输出、合法先验归一化，非法点被 mask，PASS index=n(n+1)/2。 |
| PUCT | 36 个边长 5/15 的实际模型试验；访问数预算、prior/Q/value 有界、合法动作、源状态和 territory cache 保持。额外测试当前玩家限制、双人/规则限制、显式 PASS、终局计分、Q 的玩家视角、异常恢复及强制 Superko history mask。 |
| Worker / 浏览器 | Node Worker handler 的 9 模型与错误分支通过；真实浏览器模块 Worker 对 9 新 + 3 旧模型全部通过，采用边长6、2 simulations、c_puct=1.5。实际页面 Topology seed03、边长5、PUCT-16 成功落子；seed 和局面刷新恢复，中英文控件已检查。 |
| 其他回归 | research-ai、comparison、AI control flow、hint worker、local session、replay codec、online recovery、territory-v2 均 exit 0。4 项损坏拒绝测试通过。 |

回执的完整配置 hash 包含 iterations 和 checkpoint_every；checkpoint 的 resume-critical 配置 hash 按现有 trainer 契约排除这两项。二者分别重算、与各自持有者严格核对，不能直接视为同一口径。未修改任何 hash 来绕过校验。

## 规则差分：有界检查，存在差异

同一动作前缀在 Python 与 Web territory-v2 重放：22 个前缀、317 个状态，覆盖 5–15、双方起始、12 步以内落子及显式连续 PASS。动作均未被拒绝；所查节点、逻辑边、合法点 mask、当前玩家、连续跳过、回合计数、终局与赢家一致。发现 **2 处终局离散领土面积差异**：

| 局面 | Python BLACK / WHITE | Web v2 BLACK / WHITE |
|---|---|---|
| 边长6，BLACK起始，第14步 | 7 / 6 | 7 / 0 |
| 边长10，WHITE起始，第14步 | 32 / 5 | 32 / 0 |

这批网络来自原研究规则；运行时全部合法性和终局价值以 Web GameEngine 为权威。两处例子的赢家相同，不能据此推出其他状态赢家相同。数值 parity 使用同一输入张量，独立于规则差分，不是 Python/Web 全规则等价证明。未针对全部 Superko 历史、所有切断/级联、完整对局或状态空间进行穷尽验证。原规则与 Web v2 的差异原样保留，不能混入尺寸泛化或正式 v2 棋力结论。

## 明确未完成的事项

- 独立棋力评估：**NOT_RUN**。未对全部尺寸、双方颜色、独立开局/对手进行统计评估。
- 正式研究证据：**NOT_FORMAL**，formal_ready=false；不是正式棋力模型、最佳模型或零样本外推结果。
- 生产部署：**NOT_DEPLOYED**。F32 保持本地并被 Git ignore；没有上传资产或切换线上服务。
- 移动端、完整浏览器对局和长期延迟/内存：**NOT_RUN**。当前浏览器验收属于有界工程试验。

## 精确命令与证据

[commands.json](../verification/web-size-transfer-v1-20261012/commands.json) 记录实际命令、退出码和结果；[verification.json](../verification/web-size-transfer-v1-20261012/verification.json) 记录 9 个 checkpoint/asset/config/source hash、源文件与冻结协议 hash、数值误差和差分。新 manifest 为 [transfer-v1/manifest.json](../../web/web%E5%89%8D%E7%AB%AF/assets/research-ai/transfer-v1/manifest.json)，创建收据为 [export-receipt.json](../../web/web%E5%89%8D%E7%AB%AF/assets/research-ai/transfer-v1/export-receipt.json)。

导出时创建收据记录的 exporter hash 保持不变；后续导出器增加 stage1 原始来源锚定和导入适配。最终验证收据同时记录创建版本与当前 verifier 版本的 hash。训练 source hash 始终为 117ebe2fc3d4654e545da94ca8ef8d481b8e4de7391226e4788cb1610915ec6c。

本次修正了两个现有测试适配遗漏：online recovery 的 render-only inspectionOverlay 排除，以及 territory-v2 的 data-URL Worker ModelFreeAI import 重写。没有降低规则状态断言。测试中发现的首次失败与修复记录保留在 commands.json。

常用复核（仓库根目录 PowerShell）：

```powershell
& 'C:\Users\zcz\anaconda3\envs\rl310\python.exe' research/iclr2027/scripts/export_web_size_transfer.py --verify-only
node --unhandled-rejections=strict web/web前端/tests/verify-research-ai.mjs
node --unhandled-rejections=strict web/web前端/tests/verify-research-worker.mjs
```

重新做数值/差分检查时，先用 verify_web_size_transfer.py --fixtures 指定一个**尚不存在**的本地 fixture 文件，再将该路径传给 verify-research-ai.mjs 的 --fixtures；--report 写有界工程报告。原始 fixture 留在 results/pilot。默认导出器拒绝已有输出目录；如需重新导出，应选新的输出目录，再人工审阅，不覆盖旧资产。

本地 UI 截图位于 `local_artifacts/web-transfer-v1-20261012/model-seed-selection-final.png`；真实 Worker 验收截图/文本为同目录的 browser-worker-smoke.png / .txt。截图与临时 single-stage 导出均保持本地。
