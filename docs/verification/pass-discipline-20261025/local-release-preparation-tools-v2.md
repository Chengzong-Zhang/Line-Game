# 本地发布准备工具 v2

范围：独立 Node 22 规则校验包与本地发布 payload。没有部署、上传、联网、数据库替换、模型晋级或修改训练冻结源码。

最终模型晋级、源码提交和完整 Web 包冻结后，使用全新的输出目录重建：

```powershell
node web/tools/build-server-validator-v2.mjs build --tool-root 'C:/coding/py/line game/local_artifacts/territory-v3-hard-worker-20261024/toolroot' --output local_artifacts/terminal-validator-v2-promoted-20261026-r1
python web/tools/prepare_terminal_policy_20261025.py --web-bundle <完整Web包目录> --validator-bundle local_artifacts/terminal-validator-v2-promoted-20261026-r1/validate-action.mjs --before-json <本次SSH现场哈希快照.json> --output local_artifacts/web-terminal-policy-20261025-r1
```

Web 包目录需有 `release-manifest.json` 和 `frontend-overlay.zip`；validator 文件旁需保留 `manifest.json`、`verification.json`、`build-receipt.json`。已有输出目录会被拒绝。源 commit 在组装时读取当前 HEAD，并要求 Web manifest 的 commit 一致。评估状态的模型不能生成发布 payload。

`before-json` 可直接包含以下 12 项，也可放在顶层 `before` 字段中。三个前端键必须是 64 位小写 SHA256；其余九项为现场文件 SHA256，现场不存在的文件可用 JSON `null`。文件必须来自本次服务器只读检查；工具仅校验结构和绑定，不声称快照仍与远端一致。

```json
{
  "siteManifest": "<SHA256>",
  "siteTree": "<SHA256>",
  "wechatFrontendTree": "<SHA256>",
  "legacy-server": "<SHA256 or null>",
  "legacy-bridge": "<SHA256 or null>",
  "legacy-runtime": "<SHA256 or null>",
  "legacy-package": "<SHA256 or null>",
  "wechat-server": "<SHA256 or null>",
  "wechat-bridge": "<SHA256 or null>",
  "wechat-runtime": "<SHA256 or null>",
  "wechat-package": "<SHA256 or null>",
  "wechat-validator": "<SHA256 or null>"
}
```

生成物是 `payload.zip`、`deployment-manifest.json`、原 deployer 的字节副本 `remote-release.py`、本地 `payload/` 和 `preparation.json`。zip 恰好包含原 deployer 的九个 `TARGETS` 与两个 `EXTRAS`，没有改变 deployer 行为。校验包与完整前端的所有来源、native override、编译器、包内文件、当前 HEAD 及验收摘要均绑定哈希；再次在内存重编译核对校验包完整依赖闭包。编译器使用 esbuild 0.25.12，目标为 Node 22。

验证状态：EVAL 构建 `local_artifacts/terminal-validator-v2-eval-20261026-r4`，567317 字节，91 个来源、26 个 native override。24 个实际 Node 22 对照通过：2/6/7/15 人的 STATE、真实落子 APPLY、历史重放、PASS、认输，以及 7/15 人密集起点无合法落点时的 STATE/PASS。前后状态哈希、离散分数、行动方、赢家和认输列表均与规范 GameEngine 相同。这是本地运行证据，不是服务部署或设备验收。

可运行回归：

```powershell
python -m unittest web/tools/tests/test_terminal_payload_20261025.py
node web/web前端/tests/verify-server-validator-bundle-v2.mjs --bundle <当前同源校验包目录>/validate-action.mjs
```

Python 14/14 通过，使用小型结构 fixture，独立重编译调用由 fixture mock；实际闭包另由真实包测试验证。真实包 10/10 检查通过，回执 `local_artifacts/validator-v2-input-tests-sLoPbz/receipt.json`。反例包括删除 source/compiler 清单、只保留最小来源集合、删除全部或单个 native override，以及将哈希路径指向 env 文件；未读取 env 文件。旧 r1/r2 失败探针、r3 旧绑定版本保持原样，r4 仍是评估阶段产物；最终晋级后必须重建。
