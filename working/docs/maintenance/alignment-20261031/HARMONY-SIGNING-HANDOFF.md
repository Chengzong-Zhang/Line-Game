# 鸿蒙未签名包与签名接续

2026-11-01，用户确认没有可用签名材料，本轮接受**保留未签名 HAP 与签名接续步骤**。本轮交付范围已确定；签名、真机安装和渠道发布作为后续阶段分别验证。

## 保留的交付

- 文件：`C:/coding/py/line game/working/local_artifacts/alignment-20261031/delivery-final-20261101/LIFELINE-Harmony-unsigned.hap`。
- SHA-256：`59109aacc7794cc17f1f86502d9f3d4b99f3c432116aba195b13e699ce139633`；本次确认后重新读取文件核对一致，没有重新编译或修改包。
- 共同源码：`a7a541826d025213f17dca09689bed5ce72ed4c6`；移动资源清单：`442108b90b86b9db5f680b301640f01eae276496f7147f77052138a7a1c5b52b`。
- 已完成本机编译及12项关键资源验包，详见 [移动构建记录](MOBILE-BUILD.md) 和 [原构建收据](FINAL-MOBILE-PACKAGE-RECEIPT.json)。原收据和未签名包保持原样。

## 以后具备签名条件时

1. 从本轮已核验资源重建新的完整移动工程副本，按 [重建入口](REBUILD.md) 准备 Harmony 工程、SDK 与本机工具链。`working/platform-hosts/mobile/` 是受控输入快照，不能直接当作含全部生成资源的独立工程使用。保留本轮冻结包和原构建目录。
2. 在 DevEco Studio 的签名设置中按当前工具流程申请或导入开发证书、配套 profile 和本机密钥库。开发调试 profile 的设备名单按工具要求填写。核对待签工程的应用身份；本轮受控宿主的 bundleName 为 `cn.lifelinegame.mobile.harmony`。证书、profile 与应用身份需匹配。
3. 需要先做开发设备安装时，在新工程副本中配置开发签名并生成新的签名包；安装后验证存档、返回/前后台、凭据、触觉、独立教学、导入导出及真实联机。开发签名和安装成功不代表发行签名或商店验收。
4. 需要正式签名构建时，先核准应用标识、版本与证书链指纹，并按工程现有发布身份流程冻结 `config/release-identity-candidate.json`。当前正式构建入口要求身份为 `FROZEN` 且 Harmony 证书链 SHA-256 已填写；本轮没有代填或冻结这些信息。

## 现有签名构建入口

在**重建后的完整移动工程**中，参照 `config/release-signing/harmony-signing.example.json` 在本机新建签名配置；不要覆盖已有签名文件。默认读取位置是该工程的 `local_artifacts/release-signing/harmony-signing.json`，字段为：

| 字段 | 用途 |
| --- | --- |
| `storeFile` | 本机密钥库文件的绝对路径 |
| `storePassword` | 密钥库密码，仅在本机填写 |
| `keyAlias` | 对应密钥别名 |
| `keyPassword` | 密钥密码，仅在本机填写 |
| `signAlg` | 当前入口要求 `SHA256withECDSA` |
| `profile` | 匹配应用与证书的 profile 绝对路径 |
| `certpath` | 证书文件的绝对路径 |

材料留在本机受控位置；签名配置和生成的含材料配置不得提交仓库、粘贴到聊天或保留在公开日志中。模板中的占位值不能用于实际签名。

上述身份、材料与工具链准备好后，可在完整移动工程根目录使用已有隔离构建入口。下例路径变量需替换为构建机的绝对路径，两个输出目录均须尚不存在：

```powershell
$harmonyMobileRoot = '重建后的完整移动工程绝对路径'
Push-Location $harmonyMobileRoot
node tools/harmony-release-build-entry.mjs --prepare-only `
  --artifact-directory (Join-Path $harmonyMobileRoot 'local_artifacts/harmony-sign-preflight-new')
node tools/harmony-release-build-entry.mjs `
  --artifact-directory (Join-Path $harmonyMobileRoot 'local_artifacts/harmony-signed-new')
Pop-Location
```

工具链不在默认位置时，使用入口支持的 `--tool-root`、`--java-home`；非默认本机签名配置可用 `--signing-config`。入口在新的隔离目录中生成签名配置并构建，不修改受控的 Harmony build profile；预检缺材料时拒绝继续。它重建新的签名输出，不把本轮未签名文件原地替换。

正式构建入口还会检查签名输出、证书链、应用标识/版本、非调试标志及打包 Web 资源，保留新哈希和紧凑收据。随后仍需真实设备、覆盖升级/存档与渠道验证；Huawei 渠道 `.app` 打包和提交属于另一步骤。

本页命令已对照仓库现有脚本参数，因用户当前没有材料，本轮没有执行签名预检、签名构建或账号/证书申请，也没有生成或声称存在已签名 HAP。
