# 微信天梯 v3 本地验证

日期：2026-10-26。基线：`287914a`；实现提交：`039936b`；分支：`codex/wechat-minigame`。

结果：服务端 **131 passed / 1 deselected**，客户端 **109 passed**，原生 Node 独立服务候选与 schema 6 冒烟通过。相关回归、实际浏览器交互和构建完成；没有上线、上传或推送。

## 覆盖与证据

- [产品规则与参数依据](../../product/WECHAT_LADDER_V3.md)：R−2RD、首局上榜、AI 配置范围、归一化多人比较及统计限制。
- [收据](receipt.json)：构建字节数、候选目录、验证数量和边界。
- [完整来源快照](source-snapshot.json)：任务文件及实际运行依赖的本机字节哈希，包含原有未提交依赖；不是一个可直接从基线提交重建的干净平台快照。
- [候选运行验证](candidate-smoke.json)：独立服务目录的二人二进制模型、三人困难 AI、六人简单 AI 实际出招与规则重放一致，schema 6 正常创建。随后再次按完整清单及源文件校验。
- [首局上榜](first-match-ladder.png)、[多人认输结算](multiplayer-forfeit.png)、[随机六边形出招](random-hex-ai-reply.png)、[重新随机开局](random-rematch.png)。截图来自隔离测试身份，既有未提交产品改名未纳入本任务提交。

## 可复现命令

在平台工作树根目录：

```powershell
.\.venv\Scripts\python.exe -m pytest web/tests/test_wechat_ladder.py web/tests/test_wechat_ladder_v3.py web/tests/test_wechat_accounts.py web/tests/test_wechat_profiles.py web/tests/test_wechat_profile_preflight.py web/tests/test_wechat_service_recovery.py web/tests/test_wechat_service_preflight.py -q -k 'not actual_legacy_login_bridges_only_existing_unexpired_web_accounts'
node wechat/minigame/tools/prepare-service.mjs --verify local_artifacts/wechat-ladder-v3-20261026/server-final --check-sources
```

旧版网页登录桥测试预先排除：当前旧 `server.py` 未挂载 `/api/wechat/login/web`，返回 405，属于既有集成缺口；不能据此宣称全仓库测试通过。pytest 仍有 Starlette/httpx 的既有弃用警告。

在 `wechat/minigame`：

```text
node --test --test-concurrency=4 --test-reporter=dot tests/ranked-v3.test.mjs tests/ladder.test.mjs tests/service-package.test.mjs tests/online-consent.test.mjs tests/help-result.test.mjs tests/cabins-ui.test.mjs tests/network-recovery.test.mjs tests/multiplayer-reconnection.test.mjs tests/online-emotes.test.mjs tests/online-navigation.test.mjs
node tools/preview.mjs --online-fixture
```

预览必须选择 `?player=blue` 或 `?player=red`。本次先修正了一个不支持的测试身份参数，之后完成三人随机六边形、混合 AI 出招、刷新恢复、认输、首局上榜和重新随机开局；最后核对新版认输说明和 AI 实力估计标签。测试标签页与本次预览进程已关闭。

服务端覆盖 2–6 席、非蓝方真人、所有起点模式、配置哈希、重复结算、单局多人信息归一化、正式领土/认输比较、闲置弃局、旧评级迁移、schema 5/6 备份恢复、身份合并/删除及证据篡改拒绝。客户端实际调用 29 种现有兼容 AI，覆盖自动推进、复盘/后台取消、失败停止、过期响应丢弃、首局排名与多人认输界面。

小游戏候选调用 `buildGame` 输出到新的 `local_artifacts/wechat-ladder-v3-20261026/minigame`，保持本机默认离线构建配置，只用于验证打包与依赖，不是可直接上线的联机发布包。独立服务候选位于同目录下 `server-final`。较早的 `server` 目录保留为临时验证记录，不是最终候选。

## 尚未验证的阶段

微信开发工具/手机真机、代码上传、体验版、生产部署与生产 schema 6 迁移均未执行。本地浏览器的真实 HTTP/WS 仅连接隔离服务，不是生产联机验收。没有以出招兼容性检查代替棋力校准；冷启动、跨配置可比性和多人近似的实测误差仍待真实数据检验。
