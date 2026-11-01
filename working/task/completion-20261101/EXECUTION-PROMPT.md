# LIFELINE 后续接续提示词

请接续本会话已经完成的仓库整理与平台对齐，不从旧分支重新覆盖，也不要把本地候选当作已经公开发布。先读当前工作区 `AGENTS.md` 和 `C:/Users/zcz/.codex/skills/lifeline-dev/SKILL.md`，再核对实际源码与收据；记忆与历史报告只能帮助定位。

## 用户目标和已确认取舍

原始七项要求是：整理 GitHub 并重写 README；整理项目文件夹；完善现有生命线开发技能；对齐多个平台；以 Web 与微信已完成能力的并集同步各平台安装材料；更新指南舱正文；改善指南阅读 UI。完整原始问题、计划和上一轮执行提示词在 `working/task/alignment-20261031/EXECUTION-PROMPT.md`，结果在同目录 `DELIVERY.md`。

用户随后要求继续补齐，并明确同意按“iOS 原生桥 → 最终浏览器验收 → 发布前检查”推进。用户没有 Mac，已经接受工程与 Mac 接续步骤；没有鸿蒙签名材料，已经接受未签名 HAP 和签名接续。不要重复询问这两个问题，不生成假 IPA 或假签名，不把环境限制笼统称作网络问题。

用户授权 Luna/Terra 子 agent，由主 agent 根据难度选择档位。本轮两位 Terra xhigh 分别实现原生核心与工程/JS 接线，Luna high 核对发布差距；协同前划定文件所有权，避免在同一文件并写。没有新的授权时，不部署服务器、不上传官方渠道、不合并 main、不签约/付费、不启动新训练或晋级模型。

## 正式来源与目录

- 当前整合工作区：`C:/Users/zcz/.codex/worktrees/lifeline-alignment-20261031/line game`。
- 当前分支：`codex/lifeline-alignment-20261031`；远端 `https://github.com/Chengzong-Zhang/Line-Game.git`；既有草稿 PR #1。
- 本轮起点 `f748f417b2f7cc79aa84320e5c3a802982ddc764`；共同运行源码冻结点 `a7a541826d025213f17dca09689bed5ce72ed4c6`。接续时查实际 HEAD，不把这两个快照冒充当前提交。
- 正式文档/任务：`working/docs/`、`working/task/`。新 scratch 和大包分别放 `working/tmp/`、`working/local_artifacts/`；平台 `project/` 是其它工作树的导航链接。
- 原目录 `C:/coding/py/line game` 有大量旧 dirty 及已冻结依赖/大包；只按授权读取，不整体覆盖或全量暂存。
- 旧 iOS 工程 `working/ios/alignment-20261031/`、旧平台收据和统一交付包保持原样。本轮 iOS 新实现与新候选独立保存。

## iOS 原生工程的完成范围

新源位于 `working/ios/native-v1/`；iOS 专用 JS 接线与回归位于 `working/ios/web-native-v1/`，生成与静态核验入口为 `working/tools/ios-prepare-native-v1.py` 和 `working/tools/ios-verify-native-v1.mjs`。具体最终候选、哈希、命令和限制以本轮 `working/docs/maintenance/completion-20261101/IOS-NATIVE-V1.md` 为准。

`working/platform-hosts/mobile/` 是完整文件集合受控的旧冻结宿主，不能直接往该目录添 iOS 源码或测试；否则旧 Android/Harmony 生成器会因集合漂移拒绝构建。本轮新 iOS 接线独立保存，仅从旧宿主读取未变的共享契约，不修改旧清单或降低校验。

审阅或修改时保留以下契约：

1. 凭据使用 Keychain，持久状态为 pending→credential→present；失败关闭，显式清除才允许重新登录。不要把极端连续 I/O 失败说成跨断电绝对原子。清凭据不得清普通/拓扑对局。
2. 普通与拓扑存档使用独立白名单键和 revision envelope，保留墓碑/冲突处理；写入及回读确认后才返回 durable。pending 期间拒读/拒静默覆盖，提供重试及逐键二次确认清理，保留本地恢复标志和备份。
3. 只比较 JS 自报 origin 或 challenge 不够。根 WebView 必须在消息入口检查真实 frameInfo 主框架与本地源；页面租约由当前原生 epoch、随机 nonce 与根页面 challenge 核实后发放。
4. Capacitor 8.5.3 会排队执行原生调用，同 URL 重载也须拒绝旧租约。存档、恢复、导入/分享、触感、教程、网络订阅/停止在原生执行前验证当前租约；凭据另外绑定 owner generation。
5. 导入是用户选中的单个 UTF-8 JSON，4,000,000 字节上限，取消/并发/代际正确；导入后的完整棋谱仍由隔离引擎验证，失败不替换当前局。系统分享返回不是收件或投递证明。
6. 独立教程使用无原生桥、非持久 WebView 与本地资源，不覆盖原局。网络状态只报告链路可用性，不能冒充互联网已验证。触感仅由成功本地指针行动触发，后台、过期和旧页面请求抑制。
7. 官方内建 addListener 队列可能跨导航，不能只靠 reset 宣称旧 callback 已隔离。当前 iOS 接线采用租约快照轮询；保留间隔、停表/恢复和短暂后台补发的明确范围，真机上验及时性。
8. 默认候选继续显示“待原生验证”门禁；`--native-trial` 仅供有 Mac 后的显式测试，不能直接当发行版本。App 所用 required-reason API 清单与完整产品隐私声明分别审阅。

本机未发现 Swift/Xcode 工具链。本轮 JS/DOM mock、工程引用/资源哈希验证不等于 Swift 编译、XCTest 执行、Keychain 断电验证或 iOS 真机通过。

## 在 Mac 上的必要续做

按本轮 iOS 专项说明，从同一来源生成新的 native-trial 候选；先执行 SwiftPM 存储核心测试，再解析精确 Capacitor 8.5.3 依赖并执行无签名模拟器构建。使用现场 Xcode 的实际可用模拟器，不猜固定设备名称。

必须验：根页面/同源 iframe/外部 iframe、同 URL 重载、顶层跳转、Web 内容进程结束、队列旧调用、Keychain 每个写入/回读失败、普通/拓扑独立恢复、登录错误恢复、后台/前台/短暂中断、断网与系统链路、文件取消/超限/重复选择、分享取消/返回、教程关闭与原局保持、Canvas/Worker/资源、横竖屏与安全区。静态来源允许的极低概率 callback ID 碰撞边界不能省略；如触及敏感返回，需在实际桥实现中验证或修补后再解除门禁。

完成模拟器和设备验收后，再单独处理 Team/证书、正式图标/启动图、完整产品数据与 SDK 披露、Archive/TestFlight 和 App Store；每一阶段单独留证据，不用资源 hash 代替。

## 本轮浏览器验收与其它平台

最终冻结 Web ZIP SHA 为 `36bf12e741ff5b14e839a61e48003b1cc6142e37275b248ba29bc69a55e4e51d`，257 项资源已重新核验。实际浏览器完成普通双人三角与红方先手环面：双方 Canvas 落子、刷新恢复、连续 PASS 和终局；普通棋谱四步导出/导入/复盘；390px 手机指南四章目录定位与无页面横向溢出。见 `working/docs/maintenance/completion-20261101/BROWSER-ACCEPTANCE.md` 及截图。不要重复宣称最后浏览器补验仍被授权超时阻断，也不要将本机验收升级成线上或跨端验收。

其它平台未变的冻结包继续保留，只在相关源码/依赖变化时重建受影响平台。Android 旧交付为 debug APK，Harmony 为 unsigned HAP；Windows 为本地便携包；macOS 为源/资源包；WeChat 0.14.1 为本地导入工程；itch 为本机 iframe 验过的离线包。旧最终收据在 `working/docs/maintenance/alignment-20261031/FINAL-PLATFORM-RECEIPTS.json`，逐平台差距和真实源码依据在本轮 `RELEASE-GAPS.md`。

TapTap 独立 checkout `codex/taptap-android-release` 的 HEAD 为 `98325afa266094a0f22639372c2bab99365e7272`，但存在大量旧 dirty；当前登录/防沉迷/更新为未接入，隐私配置未完成。不要只绑定 HEAD 就声称渠道已同步。Steam 仍为发行模板，实际 AppID/depot、客户端、上传及商店阶段未验。

## 可靠交付

每次修改后运行受影响的现有回归，保留失败反例；不要改旧冻结预期制造通过。相关检查通过后不重复启动无关全平台构建。每份新候选绑定来源、配置、完整资源清单和 hash；测试、构建、签名、设备、上传、服务激活、审核与公开分别记录。

Git 提交只含本任务源码/测试/配置/文档/紧凑证据；安装大包、SDK、依赖、密钥、环境和原始轨迹留本地忽略目录。推送前审阅 staged diff、凭据和大文件，跑相关验证，不强推、不改写共享历史。保留草稿 PR 的审阅状态，不据此合并或部署。

网络故障、执行权限、工具缺失、Mac、签名、设备和渠道账号分别定位。SSH 如确有本任务授权，使用 `lifeline-cloud` 现有非交互密钥连接，不向用户索要密码，不打印私钥或 token。发现外部限制时继续完成不依赖它的工程，交付准确的接续步骤，不反复确认已接受的范围。
