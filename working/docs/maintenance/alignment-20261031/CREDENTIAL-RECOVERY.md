# 移动端凭据提交与恢复审计（2026-10-31）

隔离候选的 Android 和 Harmony 凭据保存采用持久 `pending → ciphertext → present` 提交次序。读取遇到 pending 拒绝，用户显式清除成功后解除；不宣称失败后旧凭据仍可用。Android 读取与保存、清除和页面租约轮换使用同一锁，避免读取跨过屏障变化并拿到尚未确认的密文。Harmony 复用全局凭据操作队列。两端提交失败都先阻止进程内读取/再次保存，并尽力重新持久化 pending；明确清除并确认后可继续。

边界：如果最后的 present 实际已持久化、但其回读失败，而补写 pending 也持续失败，则本进程内仍阻断，跨进程重启后的磁盘结果不可确定；此实现不能宣称所有硬件故障或突然断电下都能保留旧值或确定提交结果。正常中断在已持久 pending 阶段会保持不可读。失败状态需要用户清除后重新登录，不能把它描述成成功恢复原账号。测试均使用合成凭据，未读取真实凭据。

验证（当前隔离候选）：

- Android `verify-android-credential-store.py` 使用已有 JDK 和工作区临时目录：20/20，退出码 0，覆盖三次写入各自失败及最终提交后回读失败、待恢复、模拟进程重启及显式清除；使用 JCA 和 AtomicFile 宿主替身，不等于 AndroidKeyStore、Android SDK 或真机断电验证。收据 `working/tmp/alignment-20261031/android-credential-v4/receipt.json`。
- `node mobile/tests/verify-harmony-credential-store.mjs`：18/18，退出码 0，含三次 flush、最终回读失败，以及清除进程内标记后 pending 仍拒绝读取；ArkTS 由 TypeScript 转译，HUKS 和 Preferences 为受控替身，不等于 Harmony SDK 或设备验证。
- `node mobile/tests/verify-dual-session-authority.mjs`、`node mobile/tests/verify-harmony-native-bridge.mjs` 和 Android `verify-android-session-store.py`（12/12）：退出码 0，验证原普通/拓扑双键路径未在这些回归中退化。

最终移动补丁和 manifest 由整合任务统一绑定当前原生文件与测试哈希。此前 mobile-dual-session 补丁早于本次凭据变更，不单独代表最终候选。

## 准入范围与设备验项

现有结果支持隔离候选继续 SDK 构建与受控环境联调，不足以宣称原生设备凭据恢复已通过。Android 与 Harmony 真机需分别覆盖：旧账号已存时登录替换；各阶段受控 I/O 失败或应用被终止后重启，核对不会自动使用未确认凭据；失败可见并可明确清除、重新登录；页面切换/租约轮换与并发退出；正常登录、退出、重新启动；并确认普通与拓扑存档未受影响。硬件密钥库、原生文件/Preferences 的实际 durability 及应用升级迁移均需各自证据。所有故障注入使用测试账号及隔离存储。
