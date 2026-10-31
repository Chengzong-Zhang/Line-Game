# 移动端

- [ios/](ios/)：iOS 工程和候选版本入口。
- [android/](android/)：Android 原生工程与共享 Capacitor 构建工程。
- [harmonyos/](harmonyos/)：HarmonyOS 工程与共享构建工具。

`project/` 入口连接到已有独立工作副本。Android 与 HarmonyOS 共用同一个移动端项目，避免复制依赖后出现两份互不一致的代码。`local_artifacts/` 保留原有本机资料。
