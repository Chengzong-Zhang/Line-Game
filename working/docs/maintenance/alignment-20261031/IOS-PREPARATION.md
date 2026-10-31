# iOS 工程与资源准备（2026-10-31）

## 已准备

隔离候选 `working/local_artifacts/alignment-20261031/mobile/mobile/ios-final-442108/` 包含基于已安装 Capacitor CLI 8.5.3 官方 SPM 模板的 Xcode 工程源码。复用现有 `cn.lifelinegame.mobile`、显示名“生命线”和现有 Capacitor `server` 配置；没有填写 Apple 团队、签名、证书或商店信息。`CapApp-SPM/Package.swift` 将 Capacitor SwiftPM 版本精确指定为 8.5.3；Mac 上解析该远程依赖仍需实际验证。模板图标和启动图是官方占位资源，发行前需替换为已核准的项目素材。

官方 `@capacitor/ios@8.5.3` npm 包已精准获取并校验 SHA-256 `597187fb8f4d1f2409ed742dd0d94008bb6e20270ac9210b4adb07de5401c771`，其元数据与已安装的 Core/CLI 版本一致；脚本无 npm 安装、无安装脚本，也没有升级其他依赖。此工程使用官方 CLI 模板及单独锁定的远程 SwiftPM 包，npm 压缩包用于版本与来源核验，并未假称它已经完成 Xcode 依赖解析。

构建收据绑定的移动 Web dist 含 415 个文件，manifest SHA-256 `442108b90b86b9db5f680b301640f01eae276496f7147f77052138a7a1c5b52b`。全部 415 文件复制并逐项核验；另保留原 `mobile-entry.js` 为 `mobile-entry.upstream.js`，iOS 实际入口替换成中英双语能力门禁，共 416 个 public 文件。原因是当前 Capacitor 移动入口在 native 平台调用 Android/Harmony 专属插件，iOS 尚无对应实现；直接启动会误报存档恢复失败，不能宣称产品可玩或原生等价。门禁不清除存档、不访问凭据，也不进入游戏。

## 可复现与验证

- `python working/tools/ios-prepare-alignment-20261031.py --output local_artifacts/alignment-20261031/mobile/mobile/ios-final-442108 --check`：核验来源 dist 与原构建收据逐文件一致、模板及官方包 hash、整个 iOS 项目与资源快照及脚本 hash；退出码 0。
- `python working/tools/ios-prepare-alignment-20261031.py --output working/tmp/alignment-20261031/ios-repro-442108`：仅在不存在的目录生成，不覆盖现有工程。独立目录重生成后，415 项来源、416 项资源、436 个项目文件的路径与 hash 均与候选一致。
- `node working/tools/ios-verify-gate-20261031.mjs`：合成 DOM 下中英文门禁内容通过；不等于 iOS WebView 或设备验收。
- 本次没有 Xcode、iOS SDK、iOS 模拟器或设备运行证据，没有 IPA、签名、上传或发布。

详尽文件 hash 和来源记录在候选 `ios/ios-preparation-receipt.json`；生成脚本在 `working/tools/ios-prepare-alignment-20261031.py`。若移动 dist 改变，`--check` 会失败，需以新的已验证 dist 和新目录重新生成并复核，不覆盖此快照。

## 用户确认的本轮范围与版本管理

用户确认当前没有 Mac，接受工程与 Mac 接续步骤，本轮不要求 IPA。iOS 已以 manifest `442108...` 的移动 dist 重新生成并独立复现；旧快照继续保留，不作为本轮最终候选。

可纳入版本控制的精简工程源/配置位于 `working/ios/alignment-20261031/`，其 `source-manifest.json` 精确列出 18 个源码、Xcode 工程、SwiftPM、plist、storyboard、资源元数据和 config 文件及 SHA-256，并绑定本次 dist；这些源与新候选一致（受控 `.gitignore` 保留 config 文件，按原记录与模板不同）。同时纳入 `working/tools/ios-prepare-alignment-20261031.py`、`working/tools/ios-verify-gate-20261031.mjs`、本报告。模板占位 PNG 和生成的 `public/` 为可重生成资源，不纳入 Git；npm 压缩包、签名与安装包也不纳入。此受控源码快照不等于完整可运行 Xcode 包，资源需按脚本及来源记录生成。移动宿主补丁由整合任务统一纳入版本管理。

## Mac 接续与门禁

将整个候选及其项目来源带到 Mac；在 `mobile/ios/App` 下先运行 `xcodebuild -resolvePackageDependencies -project App.xcodeproj -scheme App`，核对解析到的官方 Capacitor 8.5.3，再运行 `xcodebuild -project App.xcodeproj -scheme App -configuration Debug -sdk iphonesimulator CODE_SIGNING_ALLOWED=NO build`。这两条命令尚未在本次环境执行，scheme、SPM tag/构建依赖及 Xcode 版本需在 Mac 上现场核实。先用模拟器验证仅显示能力门禁与资源可加载；不要直接运行 `cap sync ios` 覆盖门禁或把该工程当成可发布游戏。

解除门禁之前需完成并验证 iOS 原生桥：凭据 Keychain 与租约/故障恢复；普通与拓扑双键原子存档、旧数据迁移与冲突；App 生命周期/后台恢复；棋谱导入与分享；触觉、网络状态、教程宿主及能力报告，按 iOS 平台实际实现或明确提供不误导的降级；接入匹配的 Capacitor App/Filesystem/Share iOS 插件并检查依赖闭包。应验证网络地址/CSP、离线资源、Worker/模型、多人及跨端同步、横竖屏/安全区、无障碍、安装升级与断电/进程回收。签名、Team/证书、隐私清单、真机、Archive/TestFlight 和商店审核分别是后续步骤，均未经本次验证或授权执行。
