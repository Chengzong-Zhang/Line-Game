# 移动端普通局与拓扑局持久化（2026-10-31）

## 实现

在 `working/local_artifacts/alignment-20261031/mobile` 隔离候选内，普通键 `lifeline-local-game-session-v1` 与拓扑键 `lifeline-topology-local-game-session-v1` 各自使用版本化 envelope、独立修订号、独立冲突/损坏阻止写入和独立 native 镜像。拓扑记录沿用完整 `topologyState`、棋盘定义、规范路径、根集、顺序、历史及本地局元数据，不以 grid 替代。旧的普通单键 native `session.json` 和两类 Web 原始非 envelope 记录保留兼容迁移；Android 拓扑保存到独立 `topology-session.json`，Harmony preferences 使用独立键。一个键的清除只写该键墓碑，不删除另一个。

`persistTopologyLocalGameSession` 和 `clearTopologyLocalGameSession` 保持同步布尔结果。`LifelinePlatform.flushSessionMirror()` 等待两键各自的最新原生写入，任一失败 reject；调用方必须先检查同步保存结果再 await flush，不能在失败后后台化。状态报告包含 `details.key`，聚合时错误/冲突优先于其他键的成功。拓扑存档解析支持原始记录及 revisioned envelope；完整性沿用已有拓扑 codec 与 session 验证，不声称这能验证所有历史动作与状态之间的因果一致性。

## 交付和验证

- 可复现补丁 `working/tmp/alignment-20261031/mobile-dual-session.patch`；输入及输出 SHA-256 位于同目录 `mobile-dual-session-hashes.json`。它以 `lifeline-mobile` 宿主和 `wechat-topology-fix-20261030` Web 工作树为输入，已在隔离输入上执行 `git apply --check`，退出码 0。补丁不包含由并行任务负责的两个桥接调用文件和 OnlineApp 生命周期修改，需一并绑定后再构建。
- `node mobile/tests/verify-dual-session-authority.mjs`：通过，覆盖真实拓扑引擎状态、旧格式迁移、双键独立版本、重启、跨键清除、同修订冲突、局部及原生写失败和恢复。使用内存 native double，不代表设备断电持久性。
- `node mobile/tests/verify-harmony-native-bridge.mjs`：通过既有 ArkTS 转译与模拟宿主测试，不代表 Harmony SDK 编译、真机或闪存持久性验证。
- `python mobile/tests/verify-android-session-store.py --java-bin <已有 JDK 的 bin>`：退出码 0，12 项通过，含两键独立保存、插件实例重启和清除不影响另一键；测试编译 Android Java 源码并使用宿主 AtomicFile 替身，不等于 Android SDK 或真机持久性验证。首次调用缺少参数及默认临时目录权限失败，指定本机 JDK 和工作区临时目录后通过。
- 旧 `verify-session-integration.mjs` 的 native 替身已更新支持拓扑键；仍需针对最终生成入口重跑。Android/Harmony 编译、应用前后台、进程重启及真机断电/失败验收由整合任务继续，不能将 Node/模拟通过称为真机通过。
