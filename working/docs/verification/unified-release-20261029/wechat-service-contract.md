# 微信服务整合与验证记录（中间态）

范围：主机当前运行的 schema 6 服务基线 + 当前隔离工作树候选。此记录不是线上部署、微信上传或真机验收收据。所有测试使用本地合成账号和临时 SQLite，不读取生产房间或个人数据。候选仍由不同子任务整合，以下哈希只代表写入时快照，最终构建须重算并重验。

## 协议

- 微信服务 surface 房为 `surface-v1`、`custom`、`board-topology-v1`、`board-hash-v1`；服务规范化完整棋盘并核对无前缀 boardHash，status 声明此能力。2–6 真人，禁用服务 AI；客户端 create/join 需声明 topologyCapabilities，动作使用 canonical `vertexId`。服务以认证席位注入 player、从 replay 重新构造 Worker 上下文并检查状态、序号与幂等。
- 旧经典房不强制 rootProtocolVersion；新 root-v2 房创建/加入和经典房切换 root-v2 前，所有真人须声明版本 2。已在旧房中的成员可幂等 join 登记能力。新 roots 仍严格两人、territory-v3；root_add / root_relocate 与 move 可在双方同意后撤回，PASS 和认输不作为目标。随机多根开始使用客户端预览并由服务验证保存；随机重开由服务使用系统安全随机源和共享根生成器重抽并保存，自定义及默认不重抽。
- 老线上行为中止恶意 hash、序号/行动方冲突、重复动作和重连重放。服务保留历史棋盘、账号资料、双榜以及现有数据库；未知协议不能静默降级。

## 本地证据

- `python -m pytest web/tests/test_wechat_online.py web/tests/test_training_contributions.py web/tests/test_training_contributions_v2.py web/tests/test_training_contributions_v3.py -q`：41 passed，临时数据和真实 Node；实际时间先于本文件生成，最终冻结版本仍须复跑受影响项。
- `python -m pytest web/tests/test_wechat_topology_contract.py -q`：包含真实 Node 和替身 verifier 的拓扑/多根建房、加入、恢复、3 人、协商、动作、幂等和悔棋；另有 Node random-board-v4 生成 + Python boardHash + Mini 服务初始化的单 fixture。成功不代表每个 v4 随机类别都通过。
- `python -m pytest web/tests/test_wechat_schema6_release_activation.py -q`：18 passed，涵盖健康合同、故障注入、旧代码恢复和手动回滚清单门禁的本地模型；不是 Linux/systemd 故障演练。
- `python web/tests/wechat_unified_release_probe.py --service-root .`：临时数据库与真实 Node 10 项合成检查，含旧房/双榜、菱形、拓扑落子去重、多根落子/PASS/增根持久化。
- `python -m pytest web/tests/test_topology_settings.py web/tests/test_topology_server_integration.py web/tests/test_topology_websocket_protocol.py -q`：21 passed；`test_diamond_room_settings.py test_fifteen_player_rooms.py test_online_start_undo.py test_start_protection_settings.py test_multi_start_online.py`：23 passed。
- Web 使用真实本地 FastAPI 响应与其客户端 replay/hash 的联合 fixture 已由 Web 协作方验证；不是微信真机或公网联机测试。

## 事务安全范围

`wechat/tools/prepare_schema6_service_bundle.py` 从当前线上完整 baseline inventory 和经审查 site 固定全部候选哈希，并携带 candidate、rollback probes 和 SQLite rehearsal；输出应为新建隔离目录。`wechat/tools/activate_service_schema6_release.py` 的 `preflight`、`activate` 和 `rollback` 绑定 manifest hash，检查服务、数据库 inode、实际运行树和候选树；复制生产 DB 到私密临时副本，在其上分别打开两版代码进行 schema6 / integrity 检查，释放临时副本；停止服务后的备份只作事故调查。失败回退代码时仍连接同一实时数据库，从不把备份覆盖线上库。

成功激活后，后续显式回滚需使用同一原 manifest 与 bundle、此前 `activation.json` 对应 run 目录、全新 run 目录以及 `rollback --execute`，复核完整前次 rollback 树和目前运行树。任一漂移或恢复不明时脚本保留锁并停止。此前本地 mock 验证与合成私有库演练不等于现场 systemd 与真实备份的恢复演练，也不替代独立审阅。

## 本时点文件 SHA-256

- `web/web后端/server.py`: `781d729d8e53a1b5b9f7d73561451bb4c9aac4c1278926a914738eed37684542`
- `web/web后端/board_validation.py`: `61e1a10401b44a941f482183771f6baf7814febdce01be86098f503acf7b13e4`
- `web/web后端/wechat_online.py`: `e4d6efe8d779e92fe7dcac041e48cdfb3bfdcba41d3a235d30310d402ad35081`
- `wechat/minigame/tools/validate-action.mjs`: `a761be30c9dffe562b94b4e2ccdb38e06c36f0169a1d6415dd79d1f93ce8f758`
- `web/tools/generate_online_roots.mjs`: `670a49009443cb028e405ea4633bf57f6cb831f1f52db8405cb2070e38135e5b`
- `wechat/tools/activate_service_schema6_release.py`: `2fb0264d6ba5930df0198f3cd5c9f5695547a8d886519a08fa4fa25c756b8390`
- `wechat/tools/prepare_schema6_service_bundle.py`: `b30ad139de3556fc1bba8956b54c8c732e570ef512c030bd9235f3d4461d195b`
- `wechat/tools/schema6_rehearsal.py`: `d4105e6a75cb0be177b1bc1585fcb420972a1832ee474799b8fd4afd59bac8ca`

补充：root-v2 旧客户端能力协商与三人 surface 建房测试已完成，随机棋盘 v4 的一组 JS→Python→Mini 真实 Node 哈希和状态初始化通过；schema6 隐私快照备份补充使用独立 `journal_mode=DELETE` 的合成库验证，事务相关本地测试为 19 passed。本记录仍是中间态，现场 preflight 与最终代码哈希以后续收据为准。
