# 微信天梯 v2 本地验证

2026-10-26。状态：`IMPLEMENTED_TESTED_LOCAL_NOT_DEPLOYED`。

将 v1 的参与度积分改为 Glicko-2 实力分，AI 和人类各自独立评级；新玩家和未校准 AI 标为暂定，按 RD 可靠性入榜。参数出处、公式、边界和校准限制见 [评分规范](../product/WECHAT_LADDER_V2.md)。本记录是实现者自检，不是独立审计或实际棋力校准。

## 验证范围与结果

| 检查 | 结果 |
| --- | --- |
| 评级、权威结算、账号、资料、迁移、预检、备份恢复 | 113 通过，1 项已知旧登录集成故障排除；48.77 秒 |
| 天梯界面、异步状态、双语说明、授权说明、对战舱、服务打包 | 46/46 通过；最终复查 22.33 秒 |
| 公开算法算例 | 1500 / RD 200 / σ 0.06 对三个已知对手的结果，复现 1464.06 / RD 151.52 / σ 0.059996 |
| 小程序构建 | 成功；主包 1,655,882 字节，总包 19,809,698 字节；默认离线配置，只证明构建与打包 |
| 独立服务候选 | 61 个文件，649,887 字节；schema 5；依赖完整性、源文件逐字节比对通过 |
| 浏览器实际交互 | 两榜、暂定分、规则页、AI 开局、合法落子、服务器 AI 回应、认输、结算和榜单刷新通过 |

后端命令（工作目录为本平台工作树根目录）：

```powershell
.\.venv\Scripts\python.exe -m pytest web/tests/test_wechat_ladder.py web/tests/test_wechat_accounts.py web/tests/test_wechat_profiles.py web/tests/test_wechat_profile_preflight.py web/tests/test_wechat_service_recovery.py web/tests/test_wechat_service_preflight.py -q -k 'not actual_legacy_login_bridges_only_existing_unexpired_web_accounts'
```

排除项 `test_actual_legacy_login_bridges_only_existing_unexpired_web_accounts` 已在 v1 阶段失败：旧 `server.py` 未挂载 `/api/wechat/login/web`，返回 405。本轮没有修改该文件，不能据此宣称全仓库通过。

客户端命令（工作目录 `wechat/minigame`）：

```text
node --test --test-concurrency=4 tests/ladder.test.mjs tests/service-package.test.mjs tests/online-consent.test.mjs tests/help-result.test.mjs tests/cabins-ui.test.mjs
node --input-type=module -e "import { buildGame } from './tools/build.mjs'; const m=await buildGame(); console.log(JSON.stringify({status:'BUILT_NOT_WECHAT_VERIFIED',totalBytes:m.totalBytes,mainPackageBytes:m.mainPackageBytes}));"
node tools/prepare-service.mjs --output '../../local_artifacts/wechat-ladder-v2-service-20261026-r1'
node tools/prepare-service.mjs --verify '../../local_artifacts/wechat-ladder-v2-service-20261026-r1' --check-sources
node tools/preview.mjs --online-fixture
```

测试覆盖取消场次 / 胜率直接奖励、强对手与弱对手差异、稳定评级与暂定评级差异、AI 先验不按档名分高低、AI 不占玩家排名且不因闲置增加 RD、真人闲置仅增加不确定性、并列与分页、重复结算、旧数据保留及旧房结算、账号删除 / 合并、恢复保留当前评级。

## 浏览器证据

本机 127.0.0.1 隔离服务，模拟微信身份，真实本机 HTTP / WebSocket / SQLite；不是微信开发者工具或真机。五张截图位于 [证据目录](wechat-ladder-v2-20261026/)。验证完成已关闭测试页并停止本次预览。

- 初始 AI / 人类榜均显示 1500 暂定，0 局，不进入正式榜；四档 AI 初值相同。
- 玩家对入门 AI 合法落子，观察服务器 AI 实际回应，再认输。结算显示 −162 → 1338 暂定；AI 更新为 1662 暂定，正式榜仍为空。这是新账号的定级变化，不是成熟评级的典型扣分。
- 修正实际浏览器发现的规则页 `undefined` 标题，补齐中英文标题并加入既有界面回归；隐私说明同步为按历史对局重新估计合并账号评级。
- 截图标题含工作树原有“生命线策略棋”改名；该改名不是本轮改动，提交只包含新增天梯译文。

## 稳定评级算例

给定本人 1500 / RD 60、对手 RD 60、σ 0.06、即时周期 t=0：

| 对手实力分 | 预期成绩 E | 本人获胜涨分（未取整） |
| ---: | ---: | ---: |
| 1200 | 0.8451 | 3.11 |
| 1500 | 0.5000 | 9.89 |
| 1800 | 0.1549 | 16.95 |

以上由模型计算，不是固定奖励表；相邻排名仍可能交换。单次失误不轻易抹掉长期明显优势，不意味着任何分差下都不会被反超。

## 可复现边界与发布状态

源位置 `C:/Users/zcz/.codex/worktrees/wechat-minigame/line game`，分支 `codex/wechat-minigame`，本轮基于 `42fafe3`。工作树有大量此前未提交的平台依赖，测试在这份工作树完成，不能称为干净克隆的全平台复现。任务文件和证据哈希见 [receipt.json](wechat-ladder-v2-20261026/receipt.json)。

候选位于本地 `local_artifacts/wechat-ladder-v2-service-20261026-r1`，不入 Git。清单 SHA-256：`704cc1b736d0268efcd12b3038f77c69c3a8ddd27e12b11c8ec8bfda2ec1b5c0`。原 v1 候选及冻结证据保持原样。

本次未连接生产服务器、未读取真实对局、未做实测参数拟合，也未推送、部署、上传微信、提交审核或公开发布。AI 池仍需真实数据校准；修改 AI 程序或对局规格后须换池重新校准。数据库升级须配套客户端、服务、停写备份和 schema 5 回滚路径。
