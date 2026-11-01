# iOS native-v1 本地候选与 Mac 接续（2026-11-01）

状态：**MAC-VERIFICATION-PENDING**。这里记录 Windows 本地源码准备、静态检查与 JS 模拟，不代表 Swift/Xcode 编译、iOS 运行、签名、安装、TestFlight、商店审核或发布。默认门禁候选阻止启动；仅 `--native-trial` 候选开放给后续 Mac 调试，仍不是可发行包。

## 来源与候选

- 新工程：`working/ios/native-v1/`；旧 `working/ios/alignment-20261031/` 与旧收据未修改。工程接入自有插件、主控制器、SwiftPM 8.5.3 和独立 SwiftPM 测试目标。普通与拓扑对局独立恢复；启动时原生 pending 屏障不自动清空，玩家可重试或确认清除单个存档。清除不可撤销；未提供原生待确认副本导出。
- iOS JS 源码和测试独立位于 `working/ios/web-native-v1/`。旧 `working/platform-hosts/mobile/` 对照 `HOST-SNAPSHOT.json` 的 235 个文件，集合及 SHA-256 均匹配，缺失、额外、变化均为 0。
- 输入 dist：`C:/coding/py/line game/working/local_artifacts/alignment-20261031/mobile/mobile/dist`。415 个文件逐一 SHA-256 等于 `ios-final-442108/ios-preparation-receipt.json` 的 `source_files`；其中 `dist_manifest_sha256=442108b90b86b9db5f680b301640f01eae276496f7147f77052138a7a1c5b52b` 与 `working/docs/maintenance/alignment-20261031/FINAL-MOBILE-PACKAGE-RECEIPT.json` 一致。输入 dist 只读。排序 JSON inventory 的 SHA-256 为 `a86083a8ecfdd641cd15b88f1cedddf2834249ab1464de1ed3ea4404c5c5520e`；算法是 UTF-8 `json.dumps(inventory,sort_keys=True,separators=(',',':'))`。
- 使用 Capacitor Core npm 8.5.3，本项目 SwiftPM 固定 8.5.3；无需将 Android 的 `@capacitor/app`、`filesystem`、`share` 当作已接入 iOS。工程源码 inventory 同算法 SHA-256 为 `7969c23c309c9af7dd6b9ac662af410b4aba297a46a6b5889c5c3fece87163e7`，每项哈希保存在候选收据。
- 两份候选在 `working/tmp/completion-20261101/`，每份含 452 个工程/资源文件及一份收据；本地 ZIP 内逐项解压字节哈希与其候选逐文件匹配。ZIP 是本地交接材料，不进入 Git。

| 候选 | 收据 SHA-256 | ZIP SHA-256 | ZIP 字节 |
| --- | --- | --- | ---: |
| `ios-native-v1-gated-r7` | `9c021a8d6f7b0508292fa5fea879a7e615f78008087ef9783cbefa6e97d951de` | `5cd6fa77acfe8356d4b3f08f0fda64470727a28c443ebf5af1e2c063e964629c` | 43,285,022 |
| `ios-native-v1-trial-r7` | `b93722a320195c5709ad1b50f1a4d64b7029c33d4bec30dc9d8ad15505d7eb6f` | `eac9f8c4397dfbc3fb1989f84b05bced232370f6fb65ed3af1142aed0cb95928` | 43,286,121 |

ZIP 路径分别为 `working/tmp/completion-20261101/ios-native-v1-gated-r7.zip` 与 `working/tmp/completion-20261101/ios-native-v1-trial-r7.zip`。r1–r6 是过期临时输出，不用于接续。

主 agent 独立重生成 gated 候选后，全部 453 个文件（452 个工程/资源及收据）与 r7 路径/字节哈希一致；两份 ZIP 逐项校验并复制到正式本机交付目录 `working/local_artifacts/completion-20261101/delivery/`，文件名为 `LIFELINE-iOS-native-v1-gated.zip` 与 `LIFELINE-iOS-native-v1-trial.zip`。最终复制件、字节数和 SHA-256 见 [独立交付收据](IOS-ARTIFACTS.json)。安装大包仅留本地，不进入 Git。

## 生成和核验

从仓库根目录 PowerShell 执行。`--output` 必须是仓库内**不存在的新目录**；以下命令中的 r7 已存在时，应换一个新名称。`--check` 必须匹配创建时的 `--native-trial` 状态。生成器对原 dist 和工程没有写入权限需求，不进行安装、签名、编译或发布。

```powershell
$iosArgs = @(
  '--dist', 'C:/coding/py/line game/working/local_artifacts/alignment-20261031/mobile/mobile/dist',
  '--dist-receipt', 'C:/coding/py/line game/working/local_artifacts/alignment-20261031/mobile/mobile/ios-final-442108/ios-preparation-receipt.json',
  '--release-receipt', 'working/docs/maintenance/alignment-20261031/FINAL-MOBILE-PACKAGE-RECEIPT.json',
  '--capacitor-core', 'C:/coding/py/line game/working/local_artifacts/alignment-20261031/mobile/mobile/node_modules/@capacitor/core',
  '--assets', 'C:/coding/py/line game/working/local_artifacts/alignment-20261031/mobile/mobile/ios-final-442108/App/App/Assets.xcassets'
)
python working/tools/ios-prepare-native-v1.py @iosArgs --output 'working/tmp/completion-20261101/ios-native-v1-gated-r7'
python working/tools/ios-prepare-native-v1.py @iosArgs --output 'working/tmp/completion-20261101/ios-native-v1-trial-r7' --native-trial
python working/tools/ios-prepare-native-v1.py @iosArgs --output 'working/tmp/completion-20261101/ios-native-v1-gated-r7' --check
python working/tools/ios-prepare-native-v1.py @iosArgs --output 'working/tmp/completion-20261101/ios-native-v1-trial-r7' --native-trial --check
node working/tools/ios-verify-native-v1.mjs working/tmp/completion-20261101/ios-native-v1-gated-r7
node working/tools/ios-verify-native-v1.mjs working/tmp/completion-20261101/ios-native-v1-trial-r7
python working/tools/ios-verify-privacy-native-v1.py working/tmp/completion-20261101/ios-native-v1-gated-r7
python working/tools/ios-verify-privacy-native-v1.py working/tmp/completion-20261101/ios-native-v1-trial-r7
node --experimental-vm-modules working/ios/web-native-v1/tests/verify-ios-bridge-v1.mjs
node --experimental-vm-modules working/ios/web-native-v1/tests/verify-ios-document-lease-v1.mjs
node --experimental-vm-modules working/ios/web-native-v1/tests/verify-ios-session-recovery-v1.mjs
node --experimental-vm-modules working/ios/web-native-v1/tests/verify-ios-credential-recovery-v1.mjs
node --experimental-vm-modules working/ios/web-native-v1/tests/verify-ios-polling-v1.mjs
node --experimental-vm-modules working/ios/web-native-v1/tests/verify-ios-tutorial-fallback-v1.mjs
```

本轮上述两次完整性检查、两个候选的门禁/工程/教程 URL/16 个桥接模块静态引用检查、两份隐私清单静态检查及六项 JS 模拟测试均通过。JS 测试不编译 Swift，也不证明 WKWebView 行为或系统 API。`PrivacyInfo.xcprivacy` 只列本 app 使用的 SystemBootTime `35F9.1` 与 FileTimestamp `C617.1`；完整产品数据收集、跟踪、第三方 SDK 披露与隐私审核仍需另行核对。

这两个 reason 来自 [Apple 的 required-reason API 官方说明](https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacyaccessedapitypes/nsprivacyaccessedapitype)：本 app 只用 systemUptime 衡量应用内事件间隔，只在自己的缓存目录读取文件时间/大小；此声明不是完整产品隐私报告。

生命周期和网络采用带当前文档租约的 **1 秒轮询**，不是实时原生推送。原生记录 inactive 版本；两次轮询之间完整经历后台再返回时，下一次快照补发 background/foreground。`pagehide` 停止生命周期计时器、`pageshow` 重启；网络订阅清理停表，原生后台及文档失效时停止网络监测。上述行为经过计时器模拟，后台挂起、短暂中断和恢复时序需真机验证。

## Mac 接续

将 **trial ZIP** 校验 SHA-256 后完整解压至 Mac，保留目录结构；SwiftPM 获取固定 8.5.3 依赖需要可用网络。先在解压目录运行 `swift test`，再运行：

```sh
xcodebuild -project App/App.xcodeproj -scheme App -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

上述命令是待执行步骤，未在本机运行。解决编译或配置问题后在模拟器和真机分别核验：启动、完整对局、普通/拓扑保存恢复、故障中断与逐键确认清理、登录信息恢复、前后台与网络恢复、短暂后台、教程隔离与返回、分享/导入、触感及页面重载拒绝旧请求；并检查应用隐私清单实际进入产物。签名、真机安装、Archive、TestFlight 和 App Store 上架分别另需环境与相应授权。可用 Mac 后应重新核验候选收据及各输入，任何源码或资源改变都生成新候选，不改写本收据。

## 原生实现与必须保留的边界

接口依据本机已校验的官方 `@capacitor/ios@8.5.3` 压缩包源码核对：`WebViewDelegationHandler.swift` 的 script handler 不检查 `frameInfo`；`CAPBridgeViewController.swift` 定义控制器建立/注册次序；`CapacitorBridge.swift` 提供 `registerPluginInstance`，并将插件调用排队执行。新控制器在原 handler 前检查主框架/本地源，所有敏感和副作用请求再验证原生页面租约，存档的校验与 I/O 位于同锁内。iOS 接线避免使用无租约的内建事件监听器。

Mac 上必须另外测试同源和外部 iframe、同 URL 重载、顶层跳转、Web 内容进程结束、旧请求排队后执行，以及原生返回跨导航。Capacitor 自身 `toJs/toJsError` 仍会异步排队返回，官方 `native-bridge.js` 的 callback ID 随机起点不是代际证明；本轮没有修改该依赖，也没有验证所有极端回调碰撞情形，因此不声称跨文档异步返回已获绝对隔离。默认原生门禁保持，真实桥的敏感返回须在 Mac 上验证或补强后才准入。

Keychain 与文件使用 pending 屏障、原子替换和回读；若最后提交回读与随后补写屏障连续硬件失败，跨进程磁盘状态仍无法完全证明。这是确认失败的边界，不是已完成断电原子性验证。SwiftPM 故障反例源码已经提供，尚未运行；不要将 JS mock 的成功改写为 Keychain 或文件系统故障注入成功。
