> **中间审计记录**：下列候选、哈希和状态反映当时的构建，早于后续拓扑标记、指南和旧房协议修复。不得当成最终平台交付；以另行生成的 FINAL-PLATFORM-RECEIPTS.json 和 PLATFORM-DELIVERY.md 为准。macOS 接续见 MACOS-BUILD-HANDOFF.md。

# 2026-10-31 平台对齐现场审计

## 最新本地候选（v3）

共同前端与提交 `4d3d3c009d7747ce2d5e79713e69aa3e2c321ac8` 核对通过，逐 blob 结果见 `COMMON-SOURCE-VERIFICATION.json`。以下均是本机候选：

- Web 静态包 253 个文件的清单与 ZIP 哈希验证通过；服务器未激活。
- 微信小游戏 0.14.1 online 候选通过 706/706 串行回归和独立候选验包；未上传、未在微信设备或真实跨端房间验收。
- itch v3 包经过清单及模型核验、iframe 离线 smoke、中文图片与 Worker 加载和顺序组件测试；真实 itch CDN、授权联机与贡献服务未验收。
- Windows v3 目录包经过实际离线启动、24 关回放、首关通关、成就、备份导入导出、设置保存、旧会话/贡献队列及原局计时恢复测试；单文件候选也通过自身离线启动检查，内嵌 asar 与目录包一致。Steam 发行、真实商店和设备阶段未执行。

具体 SHA-256、测试计数和未执行阶段见 `LOCAL-PLATFORM-RECEIPTS.json`；下文保留早期定位及诊断经过，不将历史中间候选当作最终结果。

## 来源与候选边界

参考工作树 `wechat-topology-fix-20261030` 的 `51e5782d3117871167783dc53413f0e6e7578bdf` 是统一 Web/小游戏 `73ca7be2` 的后继；后续包含棋盘流程、明确轮次、共享服务和 0.14.0 修复。其历史交付收据 `working/docs/verification/wechat-board-flow-20261030/release-summary.json` 写明 Web 已激活、小游戏已上传且预览；设备验收、体验版配置、提审和公开均为 false。这是历史收据，并非本次在线状态复核。

独立 Web 快照的 355 个 Git 跟踪文件中，350 与该提交原字节一致、5 仅换行差异，0 内容不同或缺失；Git 未跟踪的模型等资源由包的模型清单另作哈希核对。可复现检查：`python working/tools/audit-platform-alignment.py <frontend> 51e5782d`。主仓同一集合为 105 原字节一致、31 换行等价、96 不同、123 缺失；不能整目录覆盖主仓，也不能将主仓未提交差异直接视作已整合。各外部工作树的 Git 状态在本环境遭权限拒绝，不能判断是否干净。

本次指南修复 `guide-overlay-v1.patch` 已用于构建 itch 候选；桌面和其他端还需以对应候选完成构建与验证。本报告及本地候选不代表七项任务已经完成。

## 实测与风险

- **itch**：旧脚本漏掉新版本 `frozen-workers` 目录与顶层 `.mjs`。隔离脚本补齐后，模型、清单、ZIP 字节哈希与 Worker 关键文件检查通过；`working/tools/prepare-aligned-itch-20261031.py` 可从指定输入新建候选。`itch-repro-04` 构建退出 0，389 文件，18 个模型资产，ZIP SHA-256 `5dd4b43399de2c7695e06ec08e1238bbe50fc468935ba25f782df8c48fe73418`；6 张中文名指南图片源与包路径及 SHA 一致。旧测试硬编码 v2，候选中按 v3 和新 Worker 契约修订。经审查，51e 原前端不读取旧渠道网络配置，因此新脚本增加禁用网络时的界面和重连守卫、启用时的明确 WSS 地址；旧的自愿贡献端点是 iframe 相对路径，目前拒绝启用贡献以免发错服务。初次浏览器检查的 loopback 连接遭限制，以上适配仍需真实浏览器、共享房和断网验证；04 比脚本当前版本早，未包含后续贡献控件隐藏修正。
- **Windows / Steam**：在隔离目录复用本地 Electron 构建 `win-unpacked`，asar 确认包含新 frozen Worker；`working/tools/prepare-aligned-desktop-20261031.py` 记录构建步骤。首次受限环境启动提前退出；本机启动后发现并修正联机入口绑定。旧宿主 24 关与 51e 规则回放通过；新的独立挑战引擎 24 关及 24 次进度保存模拟检查通过，当前接入独立挑战界面和备份入口。还需实际界面、旧存档和失败恢复验收；旧贡献授权/队列与重连守卫已修，行为回归未完；成就和 Steam 宿主亦待验收。预备包不应发行。
- **Android / HarmonyOS**：同一独立移动工程含大量原生桥与恢复逻辑。旧 Web 闭包实际拒绝新快照，报告数十个新拓扑/共享房/Worker 依赖未分类、旧模块缺失和哈希变化；不应关闭检查。另由移动构建任务在隔离目录继续。工具链实测线索：工程本地 JDK/Android SDK 存在；Harmony 以物理路径和 PowerShell 7 的 `build-harmony-native.ps1 -ValidateOnly` 取得本地工具链预检通过。预检不等于 HAP、设备或签名通过。
- **TapTap**：另有独立旧 Android 渠道工程；需在共享移动源码完成后恢复渠道适配和验证，不能复用旧安装包宣称同步。
- **iOS / macOS**：本机 iOS `project` 链接指向不存在的工作树，Windows 不能执行 Xcode 构建；需先恢复实际宿主并制作可复现资源候选，再在 Mac 上构建、签名和验收。

平台源码、包、真实交互、真机、上传与公开状态各自记录。具体矩阵见同目录 `platform-matrix.json`；原始包和详细本地输出在 `working/local_artifacts/alignment-20261031/`，不应提交为源码。

## 重建预备候选

以下均在主仓根目录运行，输出目录必须是本轮 artifacts 下尚不存在的新目录；两种构建都会复制宿主及已安装依赖，因此需要充足磁盘。不得把构建输出指向平台原工作树：

```powershell
python working/tools/prepare-aligned-itch-20261031.py `
  'working/local_artifacts/alignment-20261031/candidates/itch/web/web前端' `
  'working/platform-hosts/itch/itch' `
  'working/local_artifacts/alignment-20261031/itch-new-candidate' `
  'working/docs/maintenance/alignment-20261031/guide-overlay-v1.patch' `
  'working/docs/maintenance/alignment-20261031/turn-order-overlay-v3.patch'

python working/tools/prepare-aligned-desktop-20261031.py `
  'working/local_artifacts/alignment-20261031/candidates/itch/web/web前端' `
  'working/platform-hosts/desktop' `
  'working/local_artifacts/alignment-20261031/desktop-new-candidate' `
  'working/docs/maintenance/alignment-20261031/guide-overlay-v1.patch' `
  'working/docs/maintenance/alignment-20261031/turn-order-overlay-v3.patch'
```

依赖安装与快照说明见 `working/platform-hosts/README.md`。脚本记录完整基准提交、受控宿主原始提交及快照哈希、来源与依赖字节清单摘要、构建脚本哈希、产物哈希，并检查构建期间输入未改变。新增文件只接受已分类的模型资产并逐一记录哈希；其他额外文件会阻断。输入必须仍与 51e 的跟踪文件一致；可顺序追加指南和行动顺序补丁，脚本在隔离副本核对补丁精确文件列表及每个文件的修改前后 SHA 后应用，再添加平台适配。直接传入已修改的快照仍会被拒绝。基准缺文件、缺依赖或输出目录已存在时也停止。快照没有独立 Git 身份，旧 itch 原始收据的 `source_git_commit` 置空，另以 `alignment-provenance.json` 绑定来源和内容；不要把外层主仓 HEAD 误当作快照提交。

微信及网页共同候选可使用 `working/tools/prepare-aligned-wechat-20261031.py`，按其 `Usage` 传入 51e 原始前端、已安装的小游戏 `node_modules`、新输出目录、指南补丁和顺序补丁；脚本从 Git 对象导出同源宿主与测试、校验并暂存模型、打包 Web、串行运行 Mini 测试，再生成并验证本地 online 导入工程。Windows 本地单文件包使用 `working/tools/build-aligned-desktop-portable-20261031.py` 对已验目录包及本机工具链执行，另测单文件自身启动。

桌面旧 prepare 入口直接从 `working/local_artifacts` 兼容链接调用时可能因路径别名比较而跳过 renderer 更新；以上 Python 构建脚本使用 `Path.resolve()` 的物理路径。任何生成包均需重新跑相应设备与完整流程检查。
