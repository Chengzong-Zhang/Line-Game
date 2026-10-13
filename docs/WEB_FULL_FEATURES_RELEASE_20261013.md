# Web 完整功能发布 — 2026-10-13

当前状态：`DEPLOYED_VERIFIED`。2026-10-13 21:18:19（北京时间）完成原子切换，SSH 退出 0；74/74 项公网运行资源哈希、游戏健康和棋谱收件状态均通过。独立公网页面加载检查也通过，已确认新资源版本、应用挂载、棋盘和第一关教学渲染。

- 目标：[生命线](https://lifelinegame.cn/)。发布身份：`web-replay-ai-contribution-20261013`。
- 资源版本：`20261013-full-features1`，统一全部运行模块的缓存版本。
- 发布分支：`codex/replay-ai-contribution-release-20261013`，运行版本提交：`09b64f1`。源主工作区的已有修改未重置或混合提交。
- 74 项运行资源，20,340,566 字节；发布包 18,010,300 字节，SHA-256 `62e786e25e85a1190d1e07a132af9d7a1700af338662de9d5686bb218b12ccb2`。二进制权重只进入本地发布包，不写入普通 Git 历史。

功能范围：复盘时间轴旁退出按钮；人人对战、AI 先手、AI 后手、AI 与 AI 对战及暂停/继续；完整本地对局的匿名棋谱上传、断网队列和重试；当前五关教学、移动/桌面布局、指南与 17 个已导出的模型资源。服务器已启用原有棋谱接收服务，本次未重启游戏进程，未改账号数据库，未启动训练。棋谱接收后处于待审核状态；用户可关闭贡献，教学和复盘不上传。

本次候选验证：25 个运行模块语法检查、18 个 Web 回归、5 个棋谱接收测试均退出 0。真实浏览器通过 17/17 模型的模块 Worker、权重哈希、合法候选和源局面保持检查。研究模型为兼容性试用；这些结果不构成棋力评估或正式研究结论。

真实本地浏览器完成 AI 互战十步对局，蓝方 8 / 红方 6；测试接收服务收到完整棋谱且双方角色均为 AI。暂停/继续及退出复盘恢复原局通过；390 像素宽布局无横向溢出，退出按钮约 145.4 × 44 像素。以上交互验证针对冻结候选；公网校验覆盖相同候选的全部资源和首次加载，未在生产环境发送测试棋谱。

发布前公网核对：实际活版本为 `web-full-current-20261013` / `20261013-replay5`，游戏健康与棋谱收件状态正常；该版本缺少本次 AI 对战与收件入口集成。客户端已保存四项前驱锚点哈希；服务器在锁内重新核验锚点与整个活目录。准备与激活间任何前端变更都会拒绝覆盖。

发布方式：现有 SSH 密码认证，不创建密钥、不保存密码。用户在可见 SSH 窗口输入密码后，上传包校验→前驱核对→完整旧目录复制→候选校验→`renameat2(RENAME_EXCHANGE)` 原子切换→74 项公网 SHA-256 和健康检查自动执行。运行中模型、账号、收件数据库与其他目录不属于交换范围。

回滚准备：旧前端已完整保存在 `/home/ubuntu/line-game/.deploy-artifacts/web-replay-ai-contribution-20261013.rollback-web前端`。回滚同样要求活目录和回滚目录与激活收据一致，不能覆盖其他已发布版本。激活前目录 SHA-256 为 `34210e429493273da026bf1e276e8c53afc805d123afc8dd518c0e881acb6e72`；新活目录 SHA-256 为 `3dc1fd2e91cb49d27aa431cd832b6a702c934a31781714d1da792c95331b0e41`。

需要回滚时使用：`python3 /home/ubuntu/line-game/.deploy-artifacts/web-replay-ai-contribution-20261013.atomic.py rollback --release-id web-replay-ai-contribution-20261013`。

本地成功发布目录：`C:\coding\py\line game\local_artifacts\replay-ai-contribution-release-20261013-attempt2`。首次认证尝试退出 255，未修改生产；其历史证据保留在 `C:\coding\py\line game\local_artifacts\replay-ai-contribution-release-20261013-v4`。原始包、截图、SSH 输出和测试日志留本地；紧凑清单、验证与激活收据保存在 `docs/verification/full-features-release-20261013/` 并进入版本管理。

公网验证收据：`activation.json` 为 `ATOMIC_SWITCH_OK`，`public-after.json` 为 `PASS_PUBLIC_HASH_AND_HEALTH`，棋谱收件启用且同意政策为 `anonymous-replay-training-v1`；`public-page-render.json` 为 `PASS_PUBLIC_PAGE_RENDER`。Firecrawl 在不跳过 TLS 校验、`maxAge: 0` 的首次加载中返回 HTTP 200，确认 `20261013-full-features1`。内置浏览器直连曾返回 `net::ERR_CONNECTION_CLOSED`，所以其生产交互检查未完成；独立页面渲染成功与完整资源哈希验证分别记录。

真实手机触摸、Safari、完整 v1.0 发布门及正式棋力结论未验证。本次是上述功能增量发布。
