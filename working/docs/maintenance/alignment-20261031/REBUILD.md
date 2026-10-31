# 最终候选重建入口

共同运行源码为 `a7a541826d025213f17dca09689bed5ce72ed4c6`。新克隆须取得本审阅分支及其祖先，才能读取51e来源。宿主源码已纳Git，Node依赖、SDK、模型权重和本地签名另备，不能把单独Git克隆称作完整原生构建环境。输出必须为尚不存在的新目录，构建器拒绝覆盖。

## Web、Mini、Windows与itch

这些重建器先核验**51e5782d原始前端**及单独模型输入，然后在隔离副本依次应用已冻结增量。不能把已修改的a7前端误当51e基准传入。既有基准可用 `audit-platform-alignment.py` 对照Git对象核验；完整来源和额外模型文件由生成收据另行绑定。

在仓库根目录的PowerShell中，先把以下两个变量改为构建机已有且哈希匹配的输入目录：

```powershell
$alignmentFrontend = '准备好的51e前端及模型目录'
$alignmentMiniDependencies = '小游戏已安装的node_modules目录'
$alignmentDocs = 'working/docs/maintenance/alignment-20261031'
$alignmentWebPatches = @(
  "$alignmentDocs/topology-last-moves-overlay.patch",
  "$alignmentDocs/topology-test-cleanup-overlay.patch",
  "$alignmentDocs/theory-current-overlay.patch",
  "$alignmentDocs/legacy-action-sync-overlay.patch",
  "$alignmentDocs/common-replay-overlay.patch",
  "$alignmentDocs/common-legacy-App-overlay.patch",
  "$alignmentDocs/cache-alignment-overlay.patch",
  "$alignmentDocs/recovery-test-routing-overlay.patch"
)
$env:LIFELINE_MINI_FIXTURE_PATCH = (Resolve-Path "$alignmentDocs/mini-legacy-fixture-overlay.patch").Path
python working/tools/prepare-aligned-wechat-20261031.py $alignmentFrontend $alignmentMiniDependencies `
  working/local_artifacts/alignment-20261031/rebuild-mini-new `
  "$alignmentDocs/guide-overlay-v1.patch" "$alignmentDocs/turn-order-overlay-v3.patch" `
  "$alignmentDocs/mini-topology-latest-v1.patch" @alignmentWebPatches
```

该命令同时产生Web静态候选、完整713项串行回归结果及微信本地导入工程，不上传或激活服务。新增旧房间夹具以环境变量显式绑定，不能省略；最后的 `recovery-test-routing-overlay.patch` 仅更新Node恢复测试的结构断言，不影响发布运行资源。

Windows与itch使用同一组前端增量，再叠加各宿主适配。先按锁文件安装或显式指定依赖；Windows构建需要Electron和本机发行工具。示例：

```powershell
python working/tools/prepare-aligned-desktop-20261031.py $alignmentFrontend working/platform-hosts/desktop `
  working/local_artifacts/alignment-20261031/rebuild-desktop-new `
  "$alignmentDocs/guide-overlay-v1.patch" "$alignmentDocs/turn-order-overlay-v3.patch" @alignmentWebPatches

python working/tools/prepare-aligned-itch-20261031.py $alignmentFrontend working/platform-hosts/itch/itch `
  working/local_artifacts/alignment-20261031/rebuild-itch-new `
  "$alignmentDocs/guide-overlay-v1.patch" "$alignmentDocs/turn-order-overlay-v3.patch" @alignmentWebPatches
```

便携包、Mac资源导出、归档核对分别使用 `build-aligned-desktop-portable-20261031.py`、`export-desktop-macos-handoff-20261031.py`、`verify-aligned-web-20261031.py` / `verify-aligned-itch.mjs`；调用前读取各自Usage以提供已验候选与现有工具链。每个新候选都需重新绑定实际测试与文件哈希。

## Android、Harmony、iOS及Mac

移动端从当前共同工作树直接按 `mobile-shared-web-inventory.json`、235项宿主清单、17项移动差量与42项外部资源准备，不走上述51e叠层命令。`prepare-aligned-mobile-20261031.py --help` 和 `build-aligned-mobile-20261031.py --help` 给出输入选项；本轮已在新目录独立重建并与最终415文件dist清单同哈希。默认验证入口及原生包命令见 [移动构建说明](MOBILE-BUILD.md)。

iOS按用户确认交工程和最后资源，见 [iOS准备与Mac接续](IOS-PREPARATION.md)。macOS桌面接续见 [Mac构建说明](MACOS-BUILD-HANDOFF.md)。Windows上的资源核验不能代替这两端的Mac/Xcode编译和设备验收。
