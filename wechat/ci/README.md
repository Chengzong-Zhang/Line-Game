# 微信无界面预览与上传

**当前最新开发版本与官方在线预览为 0.9.1**，分别于 2026-10-21 北京时间 16:17:01 / 16:15:36 完成；两次 SDK 正常返回、退出 0，各 35 个文件与候选一致。见[最新候选](../release/EXPERIENCE_CANDIDATE_0.9.1_ONLINE_20261021.md)与[收据](../../docs/verification/wechat-ui-091-integration-20261021/README.md)。尚未配置体验版/成员、提审或公开发布。以下 0.9.0 结果与旧命令示例保留为历史，勿重复执行旧上传。

## 0.9.0 传输记录及通用说明（历史版本示例）

当前最新预览及已上传开发版本为 **0.9.0 在线候选**，于 2026-10-21 13:38（北京时间）生成，SDK 2.1.31 正常返回、进程退出 0。候选为 `local_artifacts/wechat-candidates/0.9.0-678faf05a27b-m2lcdk`；二维码为 `local_artifacts/wechat-transfers/preview-0.9.0-xPJpeQ/preview-qr.jpg`。见[本轮收据](../../docs/verification/wechat-ui-090-integration-20261021/README.md)。

同版[开发版本已上传](../../docs/verification/wechat-ui-090-integration-20261021/upload-receipt.json)，SDK 正常返回、进程退出 0，尚未配置体验版本/成员。本次没有提审或公开发布。

此包启用现有 `https://lifelinegame.cn` 服务。旧在线预览已由用户报告建房成功，但网页加入失败；当前 r3 网页修复和 r4 表情更新均已部署，七项公网资源核对一致，见[当前部署结果](../../docs/verification/wechat-emotes-deploy-20261021/DEPLOYED_R4.md)。无需重复上传代码。上传及部署成功不等同于新版手机验收、双端对局、体验版配置、提审或发布。原 0.8.2 离线与在线候选保留，以下旧版命令和收据均为历史示例。

0.7.1 及 0.1.0 真实预览和当时上传 IP 错误保留为历史，见 [0.7.1 预览](../../docs/verification/wechat-preview-071-20261020/README.md)及 [旧上传记录](../../docs/verification/wechat-account-preview-20261019/README-r6.md)。此目录只负责开发交付，不进入小游戏包。

[官方 CI 文档](https://developers.weixin.qq.com/miniprogram/dev/devtools/ci.html) 明确支持小游戏和不打开开发者工具的预览/上传。常规 [开发者工具命令行](https://developers.weixin.qq.com/miniprogram/dev/devtools/cli.html) 仍依赖工具服务端口，可能启动工具；为遵守用户当前不用 Computer Use 的要求，本轮没有调用它。

## 已有账号条件与后续维护

当前账号的代码上传密钥与白名单已经用于成功预览，无需重新提供或重复生成。以后仅在密钥失效或官方明确返回新出口 IP 时，在微信公众平台“管理 → 开发管理 → 开发设置 → 小程序代码上传”中更新对应项。保留白名单，不通过关闭它来绕过配置。这个密钥与 AppSecret 不同；不要把内容粘贴到聊天或放进游戏目录，只提供本机文件路径。

本人已提供并更新本机代码上传密钥，受限副本位于仓库外；代码上传密钥的签名认证和真实预览均已成功；这不代表游戏运行时的微信身份换码已验证。此前代理出口和后续变化的出口曾触发白名单错误：仅对本次子进程的 `servicewechat.com` 设置 `NO_PROXY`，本人在保留原条目后追加实际返回的 IP，再次预览成功。没有关闭白名单或修改全局代理；无需提供额外 access_token、AppSecret 或再次生成密钥。

## 当前准备结果

- 当前 0.9.0 官方预览使用在线配置；开发默认 dist 仍为离线配置。构建和交付依赖分开放置，历史候选不覆盖。
- 默认只生成计划，不读取密钥或加载有网络能力的 SDK；`preview` / `upload` 同样必须明确带 `--execute` 才执行。schema 4 在线候选另须显式 `--online`；schema 1/2/3 旧离线候选保持兼容。
- 标准下载文件名 `private.<AppID>.key` 必须与候选账号一致，账号不一致时在读取文件或加载 SDK 前停止。
- 执行前核对候选文件哈希，再复制到新的本地目录。SDK 使用副本，原候选不会被编译缓存或二维码污染。
- 真实预览成功后保存二维码；真实上传成功后记录平台返回的包体。只记录允许字段，不把密钥路径、密钥内容、完整请求或 SDK 错误对象写入收据。
- 没有自动重试。若进程中断、服务器结果不明或二维码保存失败，先核对收据与后台结果，再决定是否重试。
- **代码上传成功不等于已经配置体验版，也不等于提审或公开发布。** 选择体验版本、体验成员和分享入口仍需后台步骤。

## 可执行入口

当前机器依赖已准备。新环境先在 `wechat/minigame` 安装锁定依赖并构建，再在本目录运行 `npm.cmd ci --ignore-scripts --no-audit --no-fund`。

以下命令在本目录执行。第一条没有网络上传行为。当前机器执行真实预览时，在该命令的进程环境中为 `NO_PROXY` 保留已有项并加入 `servicewechat.com`；不要修改全局代理。若再次出现 `invalid ip`，以官方响应的实际 IP 核对白名单，不自动循环重试。

```powershell
npm.cmd run plan -- --candidate '../../local_artifacts/wechat-candidates/0.8.2-123d05f496da-0WuGMv'
```

只有真实密钥路径、账号条件和对应操作已明确时，再执行预览或上传。下面路径是占位示例，不代表实际文件存在：

```powershell
npm.cmd run preview -- --candidate '../../local_artifacts/wechat-candidates/0.8.2-123d05f496da-0WuGMv' --private-key 'C:\Users\zcz\.wechat-upload\private.key' --execute
npm.cmd run upload -- --candidate '../../local_artifacts/wechat-candidates/0.8.2-123d05f496da-0WuGMv' --private-key 'C:\Users\zcz\.wechat-upload\private.key' --execute
```

### 未来在线候选的明确入口

仅在真实服务及域名准备好后使用。以下命令在**仓库根目录**执行，域名与候选路径都是占位，不能直接作为当前配置：

```powershell
node wechat/minigame/tools/prepare-candidate.mjs --online --api-base 'https://实际域名'
node wechat/ci/transfer.mjs plan --online --candidate '<真实候选路径>'
```

在线准备会生成 schema 4 候选，在新输出目录构建两次并核对一致性，不改当前 `dist/`、`config.local.json` 或任何冻结候选。在线候选执行 `plan`、`preview`、`upload` 均须 `--online`，缺失时在传输前拒绝；真实 `preview` / `upload` 仍须上传密钥路径与 `--execute`。`--online` 表示明确选择在线候选，不会部署服务、关闭域名校验或验证微信登录。`plan` 不发生外部请求。

AppSecret 和服务签名密钥只放服务器；传输工具只使用代码上传密钥，**不要把 AppSecret 放入游戏、候选或传输命令**。历史 0.8.2 离线候选保留；当前 0.9.0 在线预览已使用上述显式入口，生成预览仍不能替代真实跨端验收。

默认使用 CI 机器人 1，后台已有其他 CI 流程时可用 `--robot 2` 等指定 1–30 的机器人编号。预览二维码、编译副本和收据保存在忽略目录 `local_artifacts/wechat-transfers/`，不进入 Git 或游戏包。`STARTING_EXTERNAL_REQUEST` 或未确认状态不能当作成功，也不能盲目重复上传。

验证命令为 `npm.cmd test`。此前 **8 项 CI 测试通过**，使用注入的模拟 SDK，包含账号与密钥文件名不匹配拦截；这些是此前工具的历史证据；本轮在线候选支持的验证结果应以新收据为准，不能直接继承历史计数。历史 7 项与 SDK 加载检查见 [前期记录](../../docs/verification/wechat-ci-20261019/README.md)，后续 8 项见 [首次账号记录](../../docs/verification/wechat-account-preview-20261019/README.md)，旧 0.1.0 修正版预览与当时反馈见 [历史记录](../../docs/verification/wechat-account-preview-20261019/README-r5.md)。模拟二维码只是测试夹具，不提供给同学，不算微信预览成功。

上游 SDK 的安装包含弃用依赖提示；已保留其锁定依赖，没有擅自替换间接依赖。这不是依赖安全审计，也不影响现有小游戏运行包的依赖范围。
