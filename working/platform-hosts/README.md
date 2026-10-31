# 可复现的平台宿主源码快照

`desktop/` 与 `itch/` 是源代码构建输入，不是平台发布、安装或线上状态。原工作树入口仍见 `platform/`，没有替换原工作树。每个 `HOST-SNAPSHOT.json` 逐文件绑定 SHA-256、原始 Git blob 与差异状态；复制时桌面 64/64、itch 18/18 原字节匹配所记录的本地宿主提交。原宿主提交不在 GitHub 对应仓库中可查询，因此这里以受控源码快照保留，而不是假设新电脑能获取旧工作树。

在联网的构建环境，先按各自锁文件安装依赖（网络、包管理器和 Electron 工具链的提供是构建环境的责任）：

```powershell
Push-Location working/platform-hosts/itch/itch
npm ci
Pop-Location
Push-Location working/platform-hosts/desktop
npm ci
Pop-Location
```

`node_modules`、生成目录、SDK、包、模型权重和本地凭据不纳入这些快照。需要另备来自既有 Web 资产清单、哈希匹配的模型文件，且所需 51e 源基准及本次两份补丁必须可用。此时按 `working/docs/maintenance/alignment-20261031/PLATFORM-AUDIT.md` 的命令构建：itch 宿主改为 `working/platform-hosts/itch/itch`，desktop 宿主改为 `working/platform-hosts/desktop`。可用环境变量 `LIFELINE_ITCH_DEPENDENCIES`、`LIFELINE_DESKTOP_DEPENDENCIES` 指向本机已安装的相同依赖目录；脚本记录完整依赖哈希并在构建前后检查。使用既有依赖不等同验证其来源，按发布要求进一步审查。

构建器校验快照文件的完整集合与摘要，不会把当前主仓 HEAD 伪装成原宿主 HEAD。候选应在干净的本轮 `working/local_artifacts/alignment-20261031/` 新目录生成，验证真实设备、账号、商店与上传状态仍是独立步骤。
