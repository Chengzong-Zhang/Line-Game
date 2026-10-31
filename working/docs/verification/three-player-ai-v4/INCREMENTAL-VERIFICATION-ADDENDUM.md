# v4 独立核验增量恢复补充

在校准及三个开发 arena 完成后、正式独立核验开始前，冻结增量核验器 `web/tools/verify-three-player-v4-arena-v2.mjs`。SHA256：`5eed127324e4e14a0e618926f241bb60a0ed39af9ef157616386fd2628d34fb7`。

本版本直接由既有 supervisor 管理，替代协议中整批核验适配器的执行方式。每局保存独立 proof；恢复只重做未提交局，已完成 proof 与原始对局的字节哈希重新检查。解析与哈希使用同一次读取的数据，PASS 前再次校验全部输入、源码、对局及 proof 哈希。原 arena、旧核验器和统计/晋级规则均保持冻结。

实际进程终止、孤儿 proof 接续、已完成字节/mtime 保持、半写隔离、proof 损坏拒绝及核验期间替换 game/proof 的拒绝检查均通过，收据见 `incremental-verifier-recovery.json`。独立只读审计关闭此前完整性意见。

核验命令：`node --unhandled-rejections=strict web/tools/verify-three-player-v4-arena-v2.mjs --run-root <arena> --verify-root <independent-output> --max-seconds 240`。各核验有独立目录、job、checkpoint、proof、worker/supervisor 退出记录；240 秒主动让出、330 秒 worker 上限、1800 秒总上限、最多 3 次异常重启和 3 次无进展退出。PAUSE/STOP 与明确 resume 沿用原监督协议。
