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

`node_modules`、生成目录、SDK、包、模型权重和本地凭据不纳入这些快照。需要另备来自既有 Web 资产清单、哈希匹配的模型文件，以及51e源基准和完整补丁链。最终补丁顺序与命令见 [重建说明](../docs/maintenance/alignment-20261031/REBUILD.md)，不能只应用早期指南和顺序两份补丁。可用环境变量 `LIFELINE_ITCH_DEPENDENCIES`、`LIFELINE_DESKTOP_DEPENDENCIES` 指向本机已安装的相同依赖目录；脚本记录完整依赖哈希并在构建前后检查。使用既有依赖不等同验证其来源，按发布要求进一步审查。

构建器校验快照文件的完整集合与摘要，不会把当前主仓 HEAD 伪装成原宿主 HEAD。候选应在干净的本轮 `working/local_artifacts/alignment-20261031/` 新目录生成，验证真实设备、账号、商店与上传状态仍是独立步骤。

`mobile/` 是235项受控Android/Harmony宿主源及对应清单，保留普通/拓扑原生存档、凭据、回放、触觉、教程、前后台与返回逻辑。它是构建输入，需先用仓库工具结合共同前端和17项移动差量重建为完整工程；模型等42项外部资源须显式提供，SDK和签名不在此快照。在重建后的移动工程中，默认 `npm run verify` 执行 `verify:alignment`，原冻结链保留为 `verify:legacy-r16`。具体命令和调试/未签名包范围见 [移动构建说明](../docs/maintenance/alignment-20261031/MOBILE-BUILD.md)。iOS受控工程另在 `working/ios/alignment-20261031/`，Mac接续及能力门禁见 [iOS记录](../docs/maintenance/alignment-20261031/IOS-PREPARATION.md)。
