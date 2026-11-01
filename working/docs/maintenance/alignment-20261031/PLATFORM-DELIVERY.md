# 2026-11-01 本地平台交付

本轮结果是**本地候选和范围内的验证**：没有部署网页或服务、上传微信/itch/Steam，也没有完成真实设备、跨端联机、商店审核或公开发布。共同运行时以 `a7a541826d025213f17dca09689bed5ce72ed4c6` 为核对基准。完整文件哈希与逐平台状态见 [最终收据](FINAL-PLATFORM-RECEIPTS.json)；旧的 `LOCAL-PLATFORM-RECEIPTS.json` 是中间版本，不用于最终交付。

用户已确认没有鸿蒙签名材料，本轮保留未签名HAP与 [签名接续步骤](HARMONY-SIGNING-HANDOFF.md)；签名与真机安装留待具备条件后验证。

| 平台 | 本轮交付和验证 | 尚未完成 |
| --- | --- | --- |
| 网页 | 本地静态 ZIP 及预览；257 个归档文件与清单一致。 | 服务部署和线上验收。 |
| 微信小游戏 | 0.14.1 本地导入工程；完整 713 项测试全通过，35 项候选文件校验通过。 | 开发者工具导入、真实账号/设备与跨端联机验收、上传、体验版、审核及发布。 |
| itch | 离线 ZIP；打包校验和 Chrome iframe 启动、中文图片、Worker、旧队列及无外联检查通过。 | itch CDN、实际上传；联机版需单独配置并验收。 |
| Windows / Steam | 目录包与便携 EXE；24 关引擎回放、实际首关、存档导入导出及离线启动通过；便携 EXE 另行启动检查通过。 | 正式签名、第二设备与 Steam 客户端验收、商店上传。 |
| macOS | 887 文件的源码与资源接续 ZIP，逐文件哈希核验通过。 | 这不是 `.app`；Mac 构建、签名、公证及设备验收均未进行。见 [Mac 接续说明](MACOS-BUILD-HANDOFF.md)。 |
| Android / HarmonyOS | 本地 Android debug APK 与 Harmony 未签名 HAP 均已构建，各有 12 项关键资源与最终 dist 一致；合成桥 App 会话 116/116、共享房、触觉和在线教程检查通过。 | 未签名 HAP 不能视为可安装包；真机、正式签名、真实服务和跨端验收见 [移动构建说明](MOBILE-BUILD.md)。 |
| TapTap / iOS | 原有渠道或工程准备状态见移动与 iOS 专项记录。 | 渠道接入、Mac/Xcode 或相关设备验收，不因其他端通过而视作完成。 |

本地候选的实际路径：

- 网页 ZIP：`working/local_artifacts/alignment-20261031/wechat-final-source-20261101-r2/web-release/frontend-overlay.zip`
- 微信导入工程：`working/local_artifacts/alignment-20261031/wechat-final-source-20261101-r2/local_artifacts/wechat-candidates/0.14.1-12465505d4a7-iwZmMx/project`
- itch ZIP：`working/local_artifacts/alignment-20261031/itch-final-source-20261101/local_artifacts/itch-html5/lifeline-html5-20261031-local-alignment-preliminary.zip`
- Windows 便携包：`working/local_artifacts/alignment-20261031/desktop-final-source-20261101/desktop/portable-final-20261101/LIFELINE-0.14.0-local.1-x64-portable.exe`
- Android debug APK：`working/local_artifacts/alignment-20261031/mobile/mobile/local_artifacts/FINAL-v2-android-a7a54182/lifeline-debug-a7a54182.apk`
- Harmony 未签名 HAP：`working/local_artifacts/alignment-20261031/mobile/mobile/local_artifacts/FINAL-v2-harmony-a7a54182/entry-default-unsigned.hap`
- macOS 源码与资源接续 ZIP：`working/local_artifacts/alignment-20261031/macos-handoff-source-20261101.zip`

旧的微信全量测试首次运行发现 1 个旧 Web 房间夹具未挂载控制器且未响应协议握手；独立测试补丁补齐实际前提并保留原断言，随后从纯源重新构建，全量 713/713 通过。旧回归结果、预检包和最终包各自保留。

共同源的逐文件对照及其限制见 [源码覆盖记录](FINAL-COMMON-SOURCE-COVERAGE.json)：候选中缺少默认分支保留的历史测试与五份旧模型/训练资产，因此不把候选说成与整个 Git 树逐字节相同。平台构建脚本、受控宿主快照、独立模型清单和各补丁的前后哈希记录构建输入；模型与生成安装包不提交普通 Git 历史。

移动端旧宿主在没有有效存档、但已有“完成教程”标记时跳过新手教程；当前共同流程在无有效存档时仍显示教程。这是已知行为差异，不能把本地构建通过解读为行为完全一致。凭据异常恢复边界见 [凭据恢复审计](CREDENTIAL-RECOVERY.md)。
