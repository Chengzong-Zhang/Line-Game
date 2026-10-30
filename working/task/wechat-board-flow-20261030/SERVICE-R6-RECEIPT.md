# 行动顺序共享服务候选 r4：本地核验与部署交接

2026-10-30（北京时间）。本文件是本地候选及只读现场核验记录，不表示服务已切换、小游戏已上传或设备已验收。生产操作由主控唯一执行。

## 已核对的线上基线

- `lifeline-wechat.service` active/running；服务目录 `/home/ubuntu/line-game/.deploy-artifacts/wechat-service-20261021/release`。
- 数据库 `/var/lib/lifeline-wechat/wechat.sqlite3`，device `64514`、inode `1053174`，schema 6；与其独立的旧 Web 数据库为 `/tmp/line-game/game.db`，device `64514`、inode `685015`。运行时 venv Python 3.10.12。
- 当前完整运行树 266/266 与远端 `wechat-service-all-20261029-r6` 清单的 candidate 一致；原清单 SHA-256 `be66a221143f501ecb6b20869c333558d0c6279b96c89ba36a9ccdc9060d03d7`。
- 只读聚合在采样时有 1 个未过期、进行中的 ranked 房间，普通 waiting/playing 房间为 0；该 ranked 房的版本与 r6 runtime fingerprint `4d36330909bacc0f2e69657da168b01194a617536d8589048b45c26de013ab6a` 一致。此计数仅为采样，切换时可能变化；没有输出账户、令牌或棋谱正文。

## 本地冻结候选

- r6 原始服务和清单的本地私有快照：`working/tmp/ranked-predecessor-r6-20261030-snapshot`；原 manifest SHA 如上，树内 266/266 文件与清单一致。原始副本留本地，不提交 Git。
- 新候选：`working/tmp/wechat-service-all-20261030-r4`，清单 SHA-256 `d756e423ec1ada529b36bd146213f6d6d84253d99b1669e3a2ab210e63abdfaa`，594 项；其中 327 项与当前工作树对应源逐项相同，266 项为完整前驱，另 1 项为前驱原清单。新的 ranked runtime fingerprint 为 `6e8f99d6e218a33c6363d1efe1ee827954da269eee3854d61bfdc846946cf331`。
- 本地传输包：`working/tmp/wechat-service-all-20261030-r4-transport.tar.gz`，70,382,598 字节，SHA-256 `f38d8d185e2cd6075f9976db1e392c75a52ec7c114fd58d338a1b73ccaa697d8`。它包含 `bundle/` 和 `ops/`，没有环境文件、凭据或数据库；留本地，不提交 Git。
- 版本化本地工具 SHA-256：prepare `88dc452aceaebc22cdc75fa82865e33eac923a6024243c8a9b35684e6ba85d2f`，adapter `5e85762c4a5d678653d7b6ea9a93746a1838d744c449ad91aa12bbc6ddccd13b`，adapter 同目录基础工具 `0af020007957f534846068c97fb4c58e7a557752777c5cde63540e9584034878`，synthetic rehearsal `035a3c6c88fe222a5d9e77321262bff21d8f83ff83e149f899c67137d4804a6d`。

旧 ranked 房的用户行动、自动 PASS、认输、悔棋及 AI 回复，按其房间 context 的 r6 fingerprint 路由到清单固定的旧 validator，整树完整校验；新房用新运行时。未知版本、文件篡改拒绝；未安装旧快照时保留原 `AI_VERSION_CHANGED` 防护。无环境变量或客户端路径可选择旧代码目录。排行 context 不迁移、不更写。此设计只给已确认 r6 指纹特例，不能覆盖其他历史指纹。

## 验证记录

- `C:/Users/zcz/anaconda3/python.exe -B -X utf8 working/task/wechat-board-flow-20261030/verify-r6-ranked-bridge.py --candidate-root working/tmp/wechat-service-all-20261030-r4/service`：隔离合成 SQLite 中旧 r6 建局 → 新服务接管 → 旧真人和 AI 行动 → 旧排行结算；校验原 context、缺快照原防护、未知版本及篡改拒绝；新局按新排列和新 fingerprint 建立。检测实际 validator 路径。
- 同一候选 `probe.py --service-root .../service`：12 项临时数据库/真实 Node 合成验证通过；`rehearsal.py --candidate .../service --rollback .../snapshot/service --workdir <新临时目录>`：`PASS_SCHEMA6_SYNTHETIC_BOTH_REVISIONS`，只创建合成数据库，不读取生产库。
- `python -B -m pytest -q web/tests/test_ranked_predecessor_bridge.py web/tests/test_wechat_ladder_v3.py web/tests/test_turn_order_room.py web/tests/test_shared_room_seats.py`：34 passed；`python -B -m pytest -q web/tests/test_wechat_schema6_r6_release.py web/tests/test_wechat_schema6_release_activation.py`：37 passed、1 skipped；Windows 跳过的是无法创建符号链接。另在 Linux 仅使用临时合成文件验证文件和目录符号链接均拒绝：`PASS_LINUX_SYMLINK_REJECT`。
- `python -B -m pytest -q web/tests/test_shared_turn_order_http.py`：隔离 HTTP/SQLite + 真实 Node 房间，普通及拓扑非轮转顺序经过 Web SharedRoomClient 加入和 GameController 恢复，hash/行动方一致；不是浏览器或微信真机验收。
- `node web/web前端/tests/verify-online-recovery.mjs`：首轮旧测试 stub 漏列已有 `ROOT_ACTION_APPLIED` 而失败；补齐该常量和事件预期后通过。`verify-topology-online-v1.mjs` 通过。

r4 逐文件对照完成后，任何源码、适配器或探针变化都需生成新候选并重新验证。兼容前驱不等于能无损退回 r6：一旦新顺序或新 fingerprint 房间存在，旧代码不理解它们。新版适配器在停服后仅以 SQL 返回匿名聚合、临近交换再检查；不兼容或未知结构阻止回退。自动回退不安全时保留锁并报告恢复阻塞，需人工处理。不会通过还原旧数据库掩盖该状态。

## 由主控执行的传输及事务命令

以下是明确待执行的命令，**本子任务未执行**。新路径必须不存在；上传/解包前后核对哈希。`ops/activate_profile_service_live.py` 与新版 adapter 必须同目录；不设置新服务环境变量，不覆盖 unit 或数据库。进程环境会在 adapter 内存中用于检查身份和预检，但不会输出环境值。

```powershell
scp -p 'C:/Users/zcz/.codex/worktrees/wechat-topology-fix-20261030/line game/working/tmp/wechat-service-all-20261030-r4-transport.tar.gz' lifeline-cloud:/home/ubuntu/line-game/.deploy-artifacts/wechat-service-all-20261030-r4-transport.tar.gz
ssh lifeline-cloud "printf '%s  %s\n' f38d8d185e2cd6075f9976db1e392c75a52ec7c114fd58d338a1b73ccaa697d8 /home/ubuntu/line-game/.deploy-artifacts/wechat-service-all-20261030-r4-transport.tar.gz | sha256sum -c - && mkdir -m 700 /home/ubuntu/line-game/.deploy-artifacts/wechat-service-all-20261030-r4-transport && tar -xzf /home/ubuntu/line-game/.deploy-artifacts/wechat-service-all-20261030-r4-transport.tar.gz -C /home/ubuntu/line-game/.deploy-artifacts/wechat-service-all-20261030-r4-transport"
ssh lifeline-cloud "sudo -n python3 -B /home/ubuntu/line-game/.deploy-artifacts/wechat-service-all-20261030-r4-transport/ops/activate_service_schema6_r6_release.py preflight --manifest /home/ubuntu/line-game/.deploy-artifacts/wechat-service-all-20261030-r4-transport/bundle/release-manifest.json --expected-sha256 d756e423ec1ada529b36bd146213f6d6d84253d99b1669e3a2ab210e63abdfaa --bundle /home/ubuntu/line-game/.deploy-artifacts/wechat-service-all-20261030-r4-transport/bundle --run-dir /home/ubuntu/line-game/.deploy-artifacts/wechat-service-all-20261030-r4-check"
ssh lifeline-cloud "sudo -n python3 -B /home/ubuntu/line-game/.deploy-artifacts/wechat-service-all-20261030-r4-transport/ops/activate_service_schema6_r6_release.py activate --manifest /home/ubuntu/line-game/.deploy-artifacts/wechat-service-all-20261030-r4-transport/bundle/release-manifest.json --expected-sha256 d756e423ec1ada529b36bd146213f6d6d84253d99b1669e3a2ab210e63abdfaa --bundle /home/ubuntu/line-game/.deploy-artifacts/wechat-service-all-20261030-r4-transport/bundle --run-dir /home/ubuntu/line-game/.deploy-artifacts/wechat-service-all-20261030-r4-activate --execute"
```

命令前必须确认当前 live 树、unit、DB inode 与候选一致，完成隔离 HTTP/双版本验证，并理解 no-copy 的限制：没有本轮生产数据库备份，服务健康检查与代码回滚不是生产 DB 备份。预检/激活各使用独立全新 run-dir；若中断先查 durable journal、活跃版本和健康状态，不盲重试。显式 rollback 使用同一 manifest/bundle、`rollback --previous-run .../wechat-service-all-20261030-r4-activate --run-dir .../wechat-service-all-20261030-r4-rollback --execute`，触发上述停服后房间兼容门禁。

`lifeline-game.service` 的四位旧 WS 房间是独立运行服务，新 Web 创建与 Mini 均走八位共享服务；本轮不依赖部署其 `server.py` 改动。若今后要向旧 WS 客户端开放新排列，需单独 no-copy 候选、兼容与回滚验证。贡献收件箱也是独立服务，需单独验证与发布。
