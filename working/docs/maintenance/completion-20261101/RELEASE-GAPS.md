# 发布前缺口审计（2026-11-01）

## 范围与结论

本报告是对当前可见仓库源文件的只读静态核对。没有运行构建、预检、测试、真机操作、联网检查、签名、上传或发布。它记录当前源配置可证明的事实，并把 2026-11-01 交付收据当作历史执行记录；收据里的旧 PASS 不继承为本次真机、商店或渠道通过。

当前有 Web、微信、itch、Windows、Android 和 Harmony 的本地候选/工程材料，但尚无证据证明所有包已同步上线。Web 部署、微信上传/体验版/审核/发布、itch 上传/CDN、Steam 上传/客户端验收均未完成；Android 仅交付 debug APK，Harmony 仅交付未签名 HAP。iOS native-v1 正由另一位 Terra 处理，本轮不读取、不修改其未稳定源码，结果另报。

核对过仓库约定、`lifeline-dev` 技能、交付清单、平台交付说明、移动构建说明、最终收据，以及 `working/platform-hosts/` 中可见的移动、桌面、itch 宿主源。微信小游戏源在 `wechat/minigame/`。第一轮未读取 TapTap checkout；后续经授权只读检查了独立路径 `C:/Users/zcz/.codex/worktrees/lifeline-taptap/line game/mobile`，其 Git HEAD 为 `98325afa266094a0f22639372c2bab99365e7272`，分支 `codex/taptap-android-release`，远端为 `origin`。该 checkout 的工作区大量修改/新增且不干净；下文区分已提交基线与当前未提交源，不能把 HEAD 当作当前 TapTap 候选的完整来源。没有读取或输出签名密钥/口令，也没有把缺失文件视作已检查。

## 当前源静态事实

### Android / Harmony：签名、隐私与发布预检

- Android Gradle 只在本机签名材料齐全且 keystore 路径绝对、文件存在时配置 release 签名；release 任务缺材料会失败。见 `working/platform-hosts/mobile/android/app/build.gradle:17-23,41-65`。候选身份仍是 `DEVELOPMENT_CANDIDATE_NOT_FROZEN`，Android 与 Harmony 的证书指纹均为 `null`：`working/platform-hosts/mobile/config/release-identity-candidate.json:2,18-21`。
- `release-readiness.mjs` 会分别阻止身份未冻结、证书指纹缺失、签名材料缺失、APK/HAP 未通过静态签名核验，以及隐私 HTTPS URL、责任主体、客服、备案和渠道材料缺失：`working/platform-hosts/mobile/tools/release-readiness.mjs:73-95,132-152`。对应候选证据文件状态为 `NOT_PROVIDED`，隐私 URL、责任主体、客服、备案为空，渠道材料为空：`working/platform-hosts/mobile/config/release-evidence-candidate.json:2-9`。
- Android manifest 当前声明网络与网络状态权限（`working/platform-hosts/mobile/android/app/src/main/AndroidManifest.xml:40-41`）；Harmony 声明网络、网络信息和振动权限（`working/platform-hosts/mobile/harmony/entry/src/main/module.json5:27-31`）。静态权限清单本身不能证明隐私政策、数据清单、SDK 披露或渠道合规已经审阅通过。
- 两端的原生能力清单明确 `channelLogin`、`realName` 尚未实现：Android `working/platform-hosts/mobile/android/app/src/main/java/cn/lifelinegame/mobile/LifelineCapabilitiesPlugin.java:44-45`；Harmony `working/platform-hosts/mobile/harmony/entry/src/main/ets/bridge/LifelineNativeProxy.ets:448-451`。这说明通用宿主当前没有渠道登录/实名能力，不等于其渠道合规已完成。
- 2026-11-01 最终收据历史上记录：Android debug APK、未签名 Harmony HAP、每端 12/12 关键资源匹配；116/116 集成检查使用合成原生桥/服务，非设备验收。具体记录见 `working/docs/maintenance/alignment-20261031/FINAL-PLATFORM-RECEIPTS.json:78-90`。交付文档也明确正式 Android 签名/覆盖升级、Harmony 签名和真机安装未验证：`working/docs/maintenance/alignment-20261031/MOBILE-BUILD.md:8-12,20-24`。

**最短接续**：先在本机完成并冻结准确应用身份、版本及证书指纹，补齐并核验政策 URL、责任主体、客服、备案及渠道材料；再分别准备 Android/Harmony 本机签名材料，在新的隔离输出跑各自签名预检、发行构建及包验签；最后真机验证首次安装、覆盖升级/存档、权限/隐私呈现、前后台与网络。Harmony 未签名 HAP 及用户接受的接续步骤按 `HARMONY-SIGNING-HANDOFF.md` 执行。这里的“签名材料未在本报告读取或输出”是凭据处理边界，不表示已核验其外部是否存在。

### TapTap：渠道 SDK、防沉迷与更新

- 通用移动宿主中 `channelLogin` 与 `realName` 明确为未实现（上述 Android/Harmony 能力行）；历史移动构建说明称 TapTap 旧工程未接入渠道登录、防沉迷和更新，通用 debug APK 不是渠道验收：`working/docs/maintenance/alignment-20261031/MOBILE-BUILD.md:24`。
- 独立 TapTap checkout 当前配置把渠道服务明确标成未集成：`mobile/config/taptap-release.json:17-20` 中 `login`、`antiAddiction`、`update` 均为 `not-integrated`；Android 能力声明也将 `channelLogin`、`realName` 标成 `not-implemented`：`mobile/android/app/src/main/java/cn/lifelinegame/mobile/LifelineCapabilitiesPlugin.java:42-43`。本配置同时标记 `privacyPolicy.status` 为 `unconfigured`（同文件 `:12-15`）。渠道检查器要求这三项继续保持未集成，遇到直接 TapTap SDK 依赖/Gradle/Manifest 信号会拒绝候选，避免误报集成：`mobile/tools/taptap-release.mjs:91-95,171-187,312-321`。所以目前没有发现 TapTap 登录 SDK、实名认证/防沉迷 SDK 或 TapTap 更新 SDK 的接线；项目自有移动联网/同意门禁不是这些渠道服务的替代。
- TapTap 构建入口 `mobile/tools/build-taptap-android.mjs:356-407,471-479` 要求正式候选配有已发布、直连 HTTPS、内容哈希匹配的隐私政策；当前 `unconfigured` 配置不能形成联网正式发行候选。网络同意门禁要求在主游戏导入前选择联网或本地模式，未配置政策时限制网络：`mobile/tools/taptap-release.mjs:206-270,361-375`。这仍是源码静态保证，不证明设备实际网络行为。
- `mobile/package.json:14-15,26-27` 提供 `verify:taptap` 和 `build:taptap`。checkout 中的 `release/taptap/README.md:3,16-19` 与 `BUILD_AND_VALIDATION_RECORD.md:3,71-76` 记录当前候选为内部测试包、非正式签名，真机/上传/提交/公开未运行；内部包记录不能代替当前 dirty source 的独立复验。政策发布审计 `PRIVACY_POLICY_PUBLICATION_AUDIT.md` 是 2026-10-23 的历史公网检查，称当时建议的 URL 尚不存在；本轮没有联网复查，不把当时 404 说成当前状态。
- 当前独立 checkout 的相关源边界：`mobile/package.json`、`android/app/build.gradle`、`android/app/src/main/AndroidManifest.xml`、`tools/build-taptap-android.mjs`、`tools/taptap-release.mjs`、`config/taptap-release.json`、`src/network-privacy-gate.js`、`release/taptap/*` 与部分 Web 源处于修改或未跟踪状态（以该 checkout 本次 `git status --short --branch` 为准）。因此上述结论是对当前现场源的静态观察，不是对某个干净提交或可发行 APK 的证明；没有运行其测试/构建。

**最短接续**：发行主体先确认是否需要接入 TapTap 服务；按当前官方 SDK 与渠道要求落实登录、实名/防沉迷、更新及隐私披露，或明确维持不提供渠道功能的资格/审核路线；发布并核验隐私政策后，冻结干净源、签正式 APK，做真实设备与渠道资格验收，再分别记录后台上传、审核和公开状态。不得把通用 Android debug 包或内部测试包当 TapTap 验收。当前 TapTap 工作区含未提交源，正式包不能由该 dirty 状态直接构建。

### Windows / Steam 发行层

- Steam 适配默认返回未配置状态；`working/platform-hosts/desktop/desktop/src/steam-adapter.cjs:1-14`。发行说明当前明确只有本地模板与验证，没有 Steamworks 账号、AppID、depot、SDK、上传或 Steam 客户端验收：`working/platform-hosts/desktop/desktop/steam/README.md:3-5`。
- SteamPipe 说明要求真实 owned AppID/depot 才能生成本地 Preview 配置；脚本不调用 SteamCMD、不给 live 上传：`working/platform-hosts/desktop/desktop/steam/README.md:66-87`。Steam Cloud 仍是禁用设计稿：`working/platform-hosts/desktop/desktop/steam/README.md:117-128`。
- 历史最终收据记录 Windows 本地便携包/离线检查通过，但正式签名未声明、Steam 上传未运行：`working/docs/maintenance/alignment-20261031/FINAL-PLATFORM-RECEIPTS.json:52-63`。

**最短接续**：确认 Steamworks 账号、已拥有的 AppID/depot 和目标测试分支；冻结将发行的 Windows 候选及中英文商店素材/权利核查；按 Steam 模板生成并验证 Preview depot 映射，在 Steam 客户端测试启动、更新、回滚和存档；之后分别登记上传、商店审核、测试分支和公开阶段。不要提前启用 Cloud：当前存档未按 Steam 账号隔离。

### 微信小游戏

- 当前源提供构建、测试、候选准备和候选核验入口，未提供上传命令：`wechat/minigame/package.json:7-16`。候选工具写入 `PREPARED_LOCAL_NOT_UPLOADED`，并把开发者工具导入、物理设备、真实登录、跨端设备对局、上传、发布记为 `NOT_RUN`：`wechat/minigame/tools/prepare-candidate.mjs:240-255`；产出的说明要求另核账号上传/体验权限：同文件 `:261-264`。
- `wechat/minigame/project.config.json:15` 当前 `uploadWithSourceMap` 为 `true`。这只是工程配置事实；上传前应在实际候选和开发者工具核实源映射是否被提交/暴露及其处理方式，不据此推断已上传。
- 最终收据历史上记载 0.14.1 本地候选、713 项测试通过、35 项候选文件校验通过；设备验收、上传、发布均为 `NOT_RUN`：`working/docs/maintenance/alignment-20261031/FINAL-PLATFORM-RECEIPTS.json:27-41`。这些是旧候选记录，不是本次重新运行或微信真机/账号验收。

**最短接续**：先确认当前冻结微信候选的源码/依赖是否受本轮变更影响；仅当微信输入发生变化时才重新生成并核验包，未变化时保留该冻结包。检查 `uploadWithSourceMap` 与隐私/合法域名配置后，在微信开发者工具实际导入，使用当前账号/设备走启动、前后台、授权、真实登录及跨端房间流程；上传后核实包哈希、体验版实际指向、体验权限和云测/真机记录；最后分开登记提审、审核通过与公开发布。上传成功不等于体验版已切换或公开。

### Web、itch.io 与各自发布阶段

- Web 本地 ZIP 的交付收据记有 257 个文件及包校验，但部署为 `NOT_RUN`：`working/docs/maintenance/alignment-20261031/FINAL-PLATFORM-RECEIPTS.json:20-25`。该候选 ZIP 不证明当前线上版本/服务与本地代码同源。
- Web 有面向公网的哈希/健康检查器，定义通过条件为文件哈希、健康状态及贡献服务状态：`web/tools/verify_frontend_release.py:31-44`；部署后核验入口存在不构成已执行证据。本轮共同 Web 只有补充验证工作；若其源/依赖未变化，保留已冻结 Web 包，不要求重建，只补跑适用的线上检查与代表性规则/联机验证。只有 Web 源或依赖确有变化时才重新构建并走线上基线、原子激活和回滚流程。不得在本轮未联网检查的情况下声称当前公开站点版本。
- itch 说明区分本地包、butler 上传、hosted-preview 检查和公开状态：`working/platform-hosts/itch/itch/README.md:20-39`。最终收据历史上记录离线 ZIP 和本机 iframe smoke；真实 itch CDN、上传为 `NOT_RUN`：`working/docs/maintenance/alignment-20261031/FINAL-PLATFORM-RECEIPTS.json:44-49`。若 itch 的来源/依赖未变化，保留冻结包，仅补实际托管页验证；只有其输入改变才重建。之后经授权上传至既有项目，在真实 itch 托管页验证相对路径/iframe/全屏/存储及公开开关，再分别登记上传、托管验收与公开。

## 阻塞与环境分类

| 类别 | 当前证据/边界 | 后续动作 |
|---|---|---|
| 本地源/工具 | 本轮只读静态检查；未运行 release preflight、测试或构建。旧收据不能替代本次补验。 | 对未变化的平台保留冻结候选并补其缺失阶段的验证；只在该平台源码或依赖变化时重建，随后保存新收据。 |
| 网络/远端 | 本轮未进行网络请求；没有本次线上哈希、健康、上传端或 CDN 证据。 | 经授权后分别核实 Web 线上基线/服务、微信与 itch 实际托管状态；不要用 HTTP 可达替代功能验收。 |
| 工具权限 | 没有尝试申请额外工具权限，也没有因权限拦截而停工。 | 有本地工具缺失时先记录具体缺项和替代接续条件。 |
| Android/Harmony 签名 | 当前源中的身份/证书指纹仍未冻结；旧交付为 Android debug 和 Harmony unsigned。用户接受保留未签 HAP。本轮不读/打印本地签名凭据。 | 按隔离发行预检/签名构建流程继续；Harmony 已有获用户接受的接续路线。 |
| Mac / iOS | 用户当前没有 Mac；iOS native-v1 由另一位 Terra 处理，本轮未接触其未稳定源码。macOS 包历史上是源码/资源 ZIP，不是已构建 `.app`。 | 另行交付 iOS 审计；有 Mac 后才执行 Xcode 编译、签名、设备/商店验证。 |
| 真机/渠道账号 | 本轮没有真机测试、渠道登录或商店操作；缺少的是对应证据，不把账号/设备是否存在推断为已检查。 | 具备设备/账号后按每个平台单独留验收收据。 |

## 旧收据边界

`FINAL-PLATFORM-RECEIPTS.json` 的 `scope` 明确限定为本地包和有界测试，不表示真机/跨客户端、商店上传、服务部署或公开发布（第 78-100 行）；`PLATFORM-DELIVERY.md:3,10-15` 也逐项列出未上传、未部署和未验阶段。本报告引用这些文件只为还原 2026-11-01 的已记录历史状态，不把其中的 PASS 记作本次设备/渠道检查，也不将已有本地候选表述成所有包同步上线。本轮唯一改变的平台源在 iOS；共同 Web 是补充验证。其余平台若源码和依赖未变化可沿用冻结候选，不能把重建/全量重测扩展到未变化平台；仅受影响平台需要相应重建与回归。
