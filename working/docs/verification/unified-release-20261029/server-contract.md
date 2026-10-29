# LIFELINE 统一发布：服务端只读核查和发布契约

核查时间：2026-10-29（中国时间）；仅作源码、服务状态、发布收据和只读 HTTP 检查。没有部署、重启、访问房间记录、读取个人信息或数据库内容。文件哈希是本次时间点的观测，激活前必须重新核验。

## 线上基线

- Web 前端：`/home/ubuntu/line-game/web/web前端`；`/home/ubuntu/line-game/.deploy-artifacts/web-topology-multistart-20261029-r3.activation.json` 状态 `ATOMIC_SWITCH_OK`，commit `a1dc6d75aaa2a3afceedb60daf4aacdf70c5f8d4`，141 个覆盖文件，active tree `cff789b3050686a2b9f2198f150f1f81b2a58f5fcee3729b794e9024b8508925`。现场 GameEngine.js `e708ca8bc9d7cd2bac3b926819598cc38ab9b922acb97742fd8d25e346270c08`、TopologySetup.js `3890d8fb159fcd6ed4459c09477716a2c7c496ca2085bd671b0cb238f5b1ba54` 与 `working/tmp/topology-web-r3-full` 对应文件一致。这是两文件抽样和历史激活收据，不代表本次全量公开资源或交互已验收。
- `lifeline-game.service` active，`0.0.0.0:8000`，工作目录 `/home/ubuntu/line-game/web/web后端`；`server.py` SHA-256 `c61daabb4286857aa460f1b8b340badc7e68f4fed0bc63b20c3c554a38fa2207`、`board_validation.py` `ed13701636b6b2f923bc15477c96a2527dcffd602f16f3faa875416cbfd7483d`。公网 `/api/health` 返回 status ok。当前线上源树有生产变更，不以 Git HEAD 代表部署版本。
- `lifeline-wechat.service` active，`127.0.0.1:8006`，运行树 `/home/ubuntu/line-game/.deploy-artifacts/wechat-service-20261021/release`；`web/web后端/wechat_online.py` SHA-256 `2001d14accc6a0b40f4b36f686e75e48cbe3a5834f1087d290e3f18f9f1b8965`、`wechat/tools/wechat_service_asgi_draft.py` `20d6795c7faa5629a5377c06e46f3c119d9efdae81dd1096fbfe3ef9eb6149ea`，与 `local_artifacts/all-platform-sync-20261026` 这两文件逐字节一致。`/api/wechat/status` 内网和公网均返回 200，声明 territory-v2/v3、2–15 人、混合玩家、悔棋、计时、账户和 ladder-v3。10-27 收据 `/home/ubuntu/line-game/.deploy-artifacts/wechat-service-fix-20261027/activation.json` 为 `ACTIVATED`、schema 6、`databaseRestored:false`；这只是收据，未再次查询当前数据库。
- `lifeline-training-contributions.service` active，`127.0.0.1:8005`，工作目录 `/home/ubuntu/line-game/.deploy-artifacts/collector-v2-current-sync-20261023-r2/service/web/backend`；公网和内网 `/api/training/contributions/status` 返回 enabled，支持版本 1、2。`/api/training/status` 为 404，不能误当作实际健康端点。
- Nginx `/api/wechat/` 转 8006，`/api/training/` 转 8005，其余转 8000。以上健康和能力声明不证明真实对局或真机验收。

## 协议与必须解决的差异

1. 网页 8000 现有 `board-topology-v1` capability、完整 boardDefinition 规范化与顶点 `vertexId` 路由；拓扑房间代码将人数限制为 2–6。线上 `board_validation.py` 接收 JSON 安全的 generator 元数据，未发现显式版本白名单；这不证明所有 random-board-v4 定义、缝合边或新路径语义均能通过。round5 主树 `RandomBoard.js` 默认 `random-board-v4`，必须用真实 v4 fixture 检查线上基线与候选的规范化、哈希、起点、缝合和 canonical vertex 动作/恢复，不能仅凭字符串检索宣称兼容。
2. WeChat 8006 `room_settings` 的严格字段白名单不包含 `boardDefinition`；它会拒绝该字段；没有发现拓扑 capability / 顶点动作处理。因此拓扑共享房间不能宣称可用。是否当前微信客户端实际发起该功能，必须由客户端集成方核对；若允许进入服务端共享拓扑房间，须补齐完整规范化、能力协商、动作合法性、状态回放/重连、服务端 AI 及其限制，使用专门回归和跨端测试，不能仅放宽白名单。
3. 普通棋盘线上 8000 支持 triangle、diamond、hexagon、2–15 人和显式起点，且随机重开；但其 `random_initial_positions` 对所有非 hexagon 使用三角区域，diamond 随机起点仅覆盖半个菱形。8006 同名函数明确覆盖完整 diamond。需合并生产基线并用边界/重开/2–15 人回归验证。主树 `web/web后端/server.py` 目前普通局限制 2–6 且归一化时没有 diamond，直接覆盖生产会退化；主树和线上 server、validator 的哈希均不同。
4. 线上微信 `wechat_online.py` 与 all-platform-sync 对应文件相同，可作为合并起点，但需要比较完整 runtime inventory，而不是据两个文件断言整树一致。`web/web前端` 和服务端 bridge 的依赖、规则、棋盘表示、动作与服务器实际入口须同源核验。不要把实验模型自动准入。
5. Collector 是独立进程和独立候选目录，不能因网页资源切换而假设它继承了新引擎。新格式若需采集，单独验证 validator、协议和隐私授权；不要求采集新格式时维持既有服务及数据。

## 发布与恢复契约

- 先冻结集成候选和文件哈希；以线上运行源码为 legacy 合并基线，以当前 8006 全量清单为 WeChat 合并基线。做受影响规则、多人、随机、菱形、拓扑、WS/断线重连、AI bridge 与用户资料/排行榜兼容测试；用临时隔离数据库，禁止替换现有数据库。涉及跨端能力时检查客户端和服务端一起通过。
- 旧 `wechat/tools/activate_service_release.py` 固定旧 `wechat_online.py` 哈希 `90ea...`、旧引擎哈希及 schema 3，和当前 `2001...`、10-27 收据 schema 6 不符；其 rollback health 假设 territory-v2。**不能直接运行旧清单，不能删除校验凑通过。** 需要先独立适配成当前完整清单和精确 schema 6 / v3 基线，审查保留资产、unit、数据库身份、单写者、隔离 preflight、停止后快照、原子交换、日志及失败恢复，并运行故障恢复演练。旧脚本的 `preflight` 也会创建运行目录及候选，不是只读操作。
- 历史 `web/tools/deploy_multiplayer_release.py` 写死旧日期、PID、unit 状态和旧服务安装路径，不能直接对当前生产复用。必须针对当前基线建立受校验的后端发布/回滚事务；它的旧代码自动回滚逻辑不是当前可执行回滚命令。
- 前端可用 `web/tools/atomic_frontend_release.py` 的 `prepare` → `activate`，使用新 release ID、压缩包 SHA 和现场完整树 SHA；它基于原目录快照、拒绝哈希漂移、`renameat2(RENAME_EXCHANGE)` 切换并保留完整回滚。`prepare_frontend_release.py` 会修改源文件缓存版本，须在隔离冻结候选而非 dirty 主树执行；旧文件默认保留，须审查最终树而非只看 overlay。
- 顺序：准备并离线测试所有候选及回滚 → 重新核验线上快照和其他执行者状态 → 如必须变更服务，优先发布向后兼容服务并验健康与真实协议 → 原子激活前端并全量核对公网文件 → 上传/验证微信版本并单独报告开发版、体验版、真机及审核状态。跨客户端持续兼容旧客户端，避免在前端/微信版本切换空窗破坏旧会话。
- 前端发生问题且未有后续漂移时，回滚命令合同为：`sudo python3 /home/ubuntu/line-game/.deploy-artifacts/<NEW_RELEASE_ID>/atomic_frontend_release.py rollback --release-id <NEW_RELEASE_ID>`，仅当该脚本确已按候选部署至该路径；先核实实际脚本路径和 activation receipt。脚本检查当前 active 与 rollback 树哈希，再交换并写 rollback 收据；如拒绝则停止并调查，不强行交换。现行 r3 脚本路径 `/home/ubuntu/line-game/.deploy-artifacts/web-topology-multistart-20261029-r3/atomic_frontend_release.py` 和回滚树 `.deploy-artifacts/web-topology-multistart-20261029-r3.rollback-web前端`；使用其回滚会撤回当前线上前端，需由唯一发布执行者按具体事故决定。
- 微信旧激活事务具备失败时原运行树恢复和保留同一实时数据库、日志及快照机制；没有适合当前 schema 6 和当前完整基线的已验证独立手工回滚命令。恢复必须由重新验证的新事务执行，禁止把历史备份覆盖活数据库。中断或 SSH 异常先核查日志、激活收据、当前树哈希、unit 与健康，再决定恢复，不能盲目重复。
