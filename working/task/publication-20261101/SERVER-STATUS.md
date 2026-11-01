# 服务器发布状态（2026-11-01）

## 当前状态

- Web：`web-alignment-20261031-local` 已原子激活，入口 <https://lifelinegame.cn/>。资源版本 `20261031-alignment-local`；冻结 ZIP SHA-256 `36bf12e741ff5b14e839a61e48003b1cc6142e37275b248ba29bc69a55e4e51d`，257 项。该冻结清单自身的 `commit` 为 null、标记 dirty；其来源关联与局限按原有 `FINAL-COMMON-SOURCE-COVERAGE.json` 和最终交付收据，不将它冒称为某个完整 Git 树的逐字节构建。
- 原线上完整树 SHA-256 `eb75936a25a06643ea055fa1865c71575dd12a844584a5a7feb56ad014901707`；已激活树 `157dd306ffd6ad47824167d463c6c20e039a328f0e1e203862de0f247955864a`。激活后再次分别计算活动树与回滚树，均与收据一致。回滚目录 `/home/ubuntu/line-game/.deploy-artifacts/web-alignment-20261031-local.rollback-web前端`，原子工具会在回滚前拒绝任何活动或回滚树漂移。
- 微信共享服务保持 `wechat-service-all-20261030-r4`；现场 594 项运行文件与该发布清单完全一致，服务及 Nginx 为 active。本轮共同源码基准 `a7a541826d025213f17dca09689bed5ce72ed4c6` 至本轮源码提交 `be527b9600ce0458c9c9170cb50b4e3a13fcc73d` 没有 Web 服务端改动，故没有替换或重启服务，也没有迁移或恢复数据库。服务清单是完整运行快照，包含旧客户端资源，不能把它与整个本地仓库视作同一文件集合。

## 前置及发布后验证

- 原线上清单 SHA-256 `b02767bdd3986f44d8c4408c675b9d9f5239769118a71335453760854273c690`，完整树与 10 月 30 日激活收据一致。候选对线上同名文件 159 项相同、93 项改变，另有 5 项新增；线上 9 项额外文件按 overlay 方式保留。详情见 [资源比较](../../docs/maintenance/publication-20261101/server-resource-comparison.json)。
- 以现有原子工具在服务器独立临时目录演练：准备不改变在线树、漂移拒绝激活、保留额外文件和完整树回滚，均通过。实际准备与激活分别校验线上树及候选树；[准备](../../docs/maintenance/publication-20261101/server-prepare.json)、[激活与回滚核验](../../docs/maintenance/publication-20261101/server-activation.json)、[演练](../../docs/maintenance/publication-20261101/server-atomic-rehearsal.json)分别留档。
- 在隔离的候选资源与现有 Node 依赖夹具中，前端打包回归 6/6 通过；普通与拓扑共享房 HTTP/行动顺序及 Web 控制器恢复回归 2/2 通过。共同 Web App 的共享房与旧房间 VM 测试分别通过，均为合成服务测试。原工作树没有本地模型文件及 `@noble/hashes` 依赖，直接测试出现缺文件/依赖失败；已补齐隔离夹具后重新通过。所测 HTTP 房间使用临时数据库与合成身份，不触及生产用户数据。
- 服务健康、账号/登录能力、`territory-v2`、`territory-v3`、`surface-v1`、拓扑、房间设置和悔棋能力检查正常；贡献服务支持版本 1–4。见 [服务只读核验](../../docs/maintenance/publication-20261101/server-service-audit.json)。
- 激活后通过生产 Nginx 的 HTTPS 入口，域名证书校验开启、服务器本机解析到 `127.0.0.1`，257/257 候选资源哈希、健康及贡献服务均通过；旧 Worker 两个历史 token 和未知 token 指向当前资源共 162/162 路由通过。见 [HTTPS 核验](../../docs/maintenance/publication-20261101/server-public-https.json)和 [Worker 路由](../../docs/maintenance/publication-20261101/server-worker-routes.json)。服务器 loopback 不代表外网浏览器、真实微信设备或跨端联机验收。

## 回滚

如确认需要回滚，先重新核对激活收据、当前线上和回滚树，以及是否有其他发布；调用已留在服务器的原始工具，命令为 `python3 /home/ubuntu/line-game/.deploy-artifacts/web-alignment-20261031-local.atomic.py rollback --release-id web-alignment-20261031-local`。工具在两树哈希不匹配时拒绝回滚；回滚后重新检查 HTTPS、版本与服务。此命令仅为恢复路径，本轮未执行。

主 agent 负责独立浏览器验收、Git 与小游戏渠道阶段；本页不代表小游戏设备、体验版、审核或公开发布已完成。
