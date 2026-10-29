# 服务激活状态（2026-10-29）

三项服务均已激活，正式收据分别为 `ACTIVATED_LEGACY_UNIFIED_RELEASE`、`ACTIVATED_COLLECTOR_UNIFIED_RELEASE` 和 `ACTIVATED_SERVICE_RELEASE`，且均记录 `databaseRestored:false`。只读复核时三个服务均运行中，进程工作目录与预期一致。

- Legacy Web：4/4 个目标源码与最终清单一致，公网 `/api/health` 返回 HTTP 200、`status:ok`，敏感词过滤器就绪。
- Collector：144/144 文件与最终清单一致，公网 `/api/training/contributions/status` 返回 HTTP 200，声明启用 v1/v2/v3；新记录的目标仍为 `awaiting_review`。
- 微信共享服务：266/266 文件与最终清单一致，公网 `/api/wechat/status` 返回 HTTP 200，声明 `territory-v2`、`territory-v3`、`surface-v1`、`board-topology-v1`、`board-hash-v1` 和 `root-v1/v2`；status 报告普通房间支持 2–15 人。拓扑房当前另有限制，不能据此推断 15 人拓扑已支持。
- 三个数据库的当前 device/inode 与激活前采集值一致；旧代码回滚内容分别核对 legacy 4/4、collector 9/9、微信 98/98。核查未读取用户房间、个人记录或数据库行，也没有将旧数据库备份恢复到生产。

机器可读证据：[server-activation-receipt.json](server-activation-receipt.json)，SHA-256 `a5185e811d43e8f1f99179be1fcf944aa656007522dbe7f3270c0f79f670a49d`。状态、哈希和 HTTP 检查不证明浏览器交互、真实跨端对局、微信真机、官方上传、审核或公众发布；网页前端原子切换为独立阶段，不包含在本收据中。
