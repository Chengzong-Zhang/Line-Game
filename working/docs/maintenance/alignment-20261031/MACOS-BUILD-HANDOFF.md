# macOS 桌面接续（本机未构建）

当前桌面宿主使用 Electron，主进程包含 macOS 关闭窗口分支，但已提供的构建脚本、离线冒烟测试和验证器均针对 Windows，不能由此推断 macOS 已兼容。Windows 本轮没有生成 macOS `.app`、DMG 或签名包，也未在 Mac 上启动或验收。

最终 Windows 桌面候选经验证后，从仓库根目录生成可携带的源码和资源包（把 `<final-desktop-candidate>` 替换为本次最终候选目录，输出路径必须是尚不存在的本轮本地工件）：

```powershell
python working/tools/export-desktop-macos-handoff-20261031.py `
  '<final-desktop-candidate>' `
  'working/local_artifacts/alignment-20261031/macos-handoff-source.zip'
```

导出器核对构建收据绑定的前端、renderer、包配置、锁文件及元信息，生成带逐文件哈希清单和独立收据的 ZIP；不收录 Windows 的依赖目录、发布目录和可执行包。它保留运行所需模型资源，因此 ZIP 仍仅供本地传递，不应提交进 Git。将该包传到 Mac、核对哈希并解压后，在解压的根目录执行：

```sh
npm ci
npm run desktop:prepare
npx electron-builder --mac dir
```

这些是待执行的接续命令，不是已验证的 macOS 构建流程。该宿主未配置独立的 macOS 图标、发行目标或签名；若命令失败，需要按日志修复并复验，不得把 Windows 构建测试记作 Mac 通过。生成的本地目录包还需核对资源、离线启动、存档与恢复、完整对局、回放、窗口生命周期、音效与辅助功能；适配现有 Windows 专用测试后才可记录自动验证。正式分发还需具备相应 Apple 签名、公证和真实设备验收；本记录不授予上传或发布权限。
