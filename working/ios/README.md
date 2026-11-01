# iOS 工程

[native-v1/](native-v1/) 是本轮新增的 Swift 原生桥与 Xcode/SwiftPM 工程源码；[web-native-v1/](web-native-v1/) 保存独立的 iOS 网页接线与契约回归。新实现覆盖凭据、存档与故障恢复、页面租约、生命周期/网络、棋谱文件、触觉及独立教学宿主。

工程和资源生成、候选哈希、验证范围与 Mac 接续命令见 [iOS native-v1 说明](../docs/maintenance/completion-20261101/IOS-NATIVE-V1.md)。本机未执行 Swift 编译、XCTest 或 iOS 真机测试；默认生成版本保留原生验收门禁，测试入口只供 Mac 验证。

[alignment-20261031/](alignment-20261031/) 是先前冻结的受控工程快照，原样保留。其 [旧准备记录](../docs/maintenance/alignment-20261031/IOS-PREPARATION.md) 和工程包反映当时尚无原生桥的状态，不代表新实现已通过原生验收。

生成的 `public/`、依赖、安装包、签名和日志不进入普通 Git 历史。不要将新文件添加到 `working/platform-hosts/mobile/` 的冻结宿主集合；新 iOS 接线从那里读取共享契约，保持 Android/Harmony 的旧重建入口有效。
