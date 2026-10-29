# 最终服务候选：服务器隔离预检（2026-10-29）

本次仅向 `.deploy-artifacts` 新建隔离目录、上传候选并执行预检。没有执行 activate、停止服务、替换生产数据库或读取房间/个人记录。预检结束后 `lifeline-game.service`、`lifeline-wechat.service` 和 `lifeline-training-contributions.service` 均为 active。预检不证明浏览器、微信设备、正式上传或公众发布。

| 服务 | 结果 | 候选 manifest SHA-256 | 服务器预检目录 |
| --- | --- | --- | --- |
| Legacy Web | `PASS_LEGACY_RELEASE_PREFLIGHT`、`liveChanged:false` | `3a4bf9d497d47f7cc410a5247b3ded149f59a0182a6f8a1624bd07f2a8ec91a4` | `.deploy-artifacts/unified-legacy-final-20261029-r1/check-r1` |
| Collector | `PASS_COLLECTOR_PREFLIGHT_NO_LIVE_CHANGE` | `ce38db5634faee889632c29f6a9ff45fb5cc089709e19cde904fc94463ac0cc6` | `.deploy-artifacts/unified-collector-final-20261029-r1/check-r1` |
| WeChat 共享服务 | `PREFLIGHT_PASSED_NO_LIVE_CHANGE` | `be66a221143f501ecb6b20869c333558d0c6279b96c89ba36a9ccdc9060d03d7` | `.deploy-artifacts/wechat-service-all-20261029-r6-check` |

WeChat 最终包为 266 个运行时文件，源码与包哈希逐项匹配；实际生产服务 98 个文件的完整基线、systemd 单元与两个数据库文件身份参与预检。服务器日志证实：现有 schema6 数据库的私密副本可由候选和回滚代码分别打开；真 Node 的 12 项合成检查包括既有房间、随机菱形、双榜、排行 AI、拓扑顶点/幂等、每方多个起点、random-board-v4 跨语言哈希和 root-v2 动作恢复。没有生成或替换真实用户记录。上传传输包 SHA-256 为 `cba972a49f70bfd410fd7297164fb0e34d276f0f93bf2ffc611e69777c6f90db`。

本地机器可读各独立 JSON 收据：`legacy-final-preflight-r1.json`、`collector-final-preflight-r1.json`、`wechat-final-preflight-r6.json`。三套候选的最终 activation 和代码 rollback 命令已交唯一发布执行者；回滚均保持当前实时数据库，不自动恢复旧数据库快照。中断、漂移、健康失败或锁保留时须先读取对应日志与收据，禁止盲目重发或跳过哈希门禁。
