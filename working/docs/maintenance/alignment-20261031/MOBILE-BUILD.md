# 移动端诊断候选（2026-11-01）

当前候选以共同源码 `a7a541826d025213f17dca09689bed5ce72ed4c6` 为基线。隔离重建得到 415 个 Web 资源，dist manifest SHA-256 为 `442108b90b86b9db5f680b301640f01eae276496f7147f77052138a7a1c5b52b`，与移动候选一致。已恢复移动触觉设置和成功本地指针落子反馈，以及在线对局中通过原生独立页打开教程；物理震动和原生教程页面尚未在设备验证。

`npm run verify` 现执行本轮 `verify:alignment`：aligned 源闭包、移动桥、凭据、存档、回放、教程、触觉、双端 App 与共享房合成测试均通过；其中 App 集成检查为 116/116。原 r16 冻结验证链保留为 `npm run verify:legacy-r16`，其旧模型、导出和缓存断言面向旧基线，本轮没有声称该链通过。发布预检与设备验收仍独立，见 [集成映射](MOBILE-INTEGRATION-MAP.json) 和 [凭据恢复审计](CREDENTIAL-RECOVERY.md)。

## 本机诊断包

- Android debug APK：`local_artifacts/alignment-20261031/mobile/mobile/local_artifacts/FINAL-v2-android-a7a54182/lifeline-debug-a7a54182.apk`，SHA-256 `26f3d57eb6c67e086887e0a7bc52d22f0c9bf430fc9acadbab683f39a762b124`。已使用本机离线 Android 工具链构建；正式签名配置不完整，签名、覆盖升级和渠道验收未验证。
- Harmony unsigned HAP：`local_artifacts/alignment-20261031/mobile/mobile/local_artifacts/FINAL-v2-harmony-a7a54182/entry-default-unsigned.hap`，SHA-256 `59109aacc7794cc17f1f86502d9f3d4b99f3c432116aba195b13e699ce139633`。Hvigor 本机构建成功，工程未配置签名；未签名文件不能视为真机可安装包。

两个包各有 12 项关键引擎、指南、移动适配及样式资源经解包与最终 dist 字节比对一致，见 [收据](FINAL-MOBILE-PACKAGE-RECEIPT.json)。没有真机、真实服务联机、应用升级、渠道审核或公开发布证据。此前 `FINAL-android-a7a54182`、`FINAL-harmony-a7a54182` 和 v3 包均为中间版本，保留但不作为当前候选。

## 可重建材料

`working/platform-hosts/mobile/` 的 `HOST-SNAPSHOT.json` 校验 235 项宿主文件。`mobile-shared-web-inventory.json` 与对应 overlay/hash 绑定 368 项共同源码和 17 项移动差量；42 项模型及相关资源须从单独的本地资源根显式提供，不能仅凭 Git 重建。原冻结清单保留；旧 `mobile-integration-overlay.patch` 是历史证据，不是当前输入。

使用 `working/tools/prepare-aligned-mobile-20261031.py`，将 `--web-root` 指向上述共同提交的工作树，显式指定 `--resources` 和新的 `--destination`；验证输入和差量后可用 `working/tools/build-aligned-mobile-20261031.py` 进行离线诊断构建。本次复制已有依赖至独立目录后，Web 构建输出与候选同哈希。

## 平台边界

TapTap 旧工程与通用 Android 包名相同，但渠道登录、防沉迷和更新未接入，通用 debug 包不是渠道验收。iOS 源码与资源准备见 [iOS 准备记录](IOS-PREPARATION.md)；Windows 未生成或验收 IPA，项目特有的安全存储、凭据、触觉和返回桥仍需 Mac/Xcode 接续与真机验证。旧两字段凭据缺少可信服务来源绑定，排行榜恢复仍按失败关闭处理。

早期源整合、旧版 v3 包及中间检查记录保留在本目录与隔离工件中；其旧失败数量与哈希不代表本次最终候选。
