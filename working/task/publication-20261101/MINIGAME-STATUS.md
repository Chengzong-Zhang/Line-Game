# 微信小游戏发布状态（2026-11-01）

当前结果：**官方 CI 未上传成功，未确认体验版、审核或公开发布**。后两次官方最终提交返回 `-10008 invalid ip`（外层 `20003`）；需由账号主体在官方后台核实代码上传白名单、平台识别出口及远端版本。没有更换密钥、放宽白名单或关闭 TLS 校验，也不继续重试。

## 确认的候选和工具

- 候选 `0.14.1-12465505d4a7-iwZmMx`，AppID `wxf986ac5d7e8bb8a0`，游戏内首页及项目名称“生命线策略棋”。
- 35 项文件本次逐项大小/SHA-256 重验通过，总计 20,560,242 字节；候选收据 SHA-256 `5512f7ea5f62733b5fbb2d07e213c63f633e4a47a32903b116cca7dea1820ba6`。这不是微信服务器编译包哈希。
- 候选原构建环境及本轮隔离工具环境的原始 plan 检查通过；esbuild 0.28.2、官方 miniprogram-ci 2.1.31 与锁文件匹配。原目录只读，SDK/工具复制到本轮 ignored 目录，不提交 Git。
- 复用本机保留的对应 AppID 上传密钥，未生成或替换密钥，未把密钥内容放入聊天、日志或仓库。密钥是否可用不从文件存在性或 IP 拒绝推断。
- 在线地址 `https://lifelinegame.cn`，基础库 3.17.4。前轮 713/713 为冻结候选的本地测试记录，本轮重验文件并完成上传编译，但不冒充微信真机或云测。

## 三次尝试及已知阶段

所有尝试均使用同一候选、同一既存密钥、机器人2和隔离工具环境，每次都有独立持久收据。

| 尝试 | 环境与官方结果 | 结论 |
| --- | --- | --- |
| 1 | 受限执行环境在 `servicewechat.com` 初始化签名请求遇 DNS ENOTFOUND/20001。核对 SDK 顺序为 getCompiler → serialize → project.attr → getSignature/getrandstr。 | 发生于编译、打包和实际代码上传之前，没有提交代码。 |
| 2 | 获准本机网络后完成编译和 COS 传输，最终提交返回 -10008 invalid ip / 20003。 | 未获得成功收据；不证明密钥失效。 |
| 3 | 先用 Node 官方 IPv4 优先选项验证 IPv4 TLS 直连，仅在上传子进程使用这些选项。最终仍返回 invalid ip，平台显示出口仍为 IPv6。 | 独立连接测试不能证明 SDK 全链路出口；最终提交未成功。不再换出口或重试。 |

第1份收据：`working/tmp/publication-20261101/ci-isolated/local_artifacts/wechat-transfers/upload-0.14.1-7OZFO3/receipt.json`，SHA-256 `8956e57caa72b3fdbd6825f066d85d18815d9834bd0f8248062eccee5b895a50`，原始状态 STARTING_EXTERNAL_REQUEST；阶段判断以上述源码/错误栈核对为准。

第2份收据：同目录 `upload-0.14.1-ty5XDq/receipt.json`，SHA-256 `5e46357dfa31bdb713e7918c2edf33ff988e275d518961a4b1b26760860b22ed`。

第3份收据：同目录 `upload-0.14.1-W49Lus/receipt.json`，SHA-256 `1055978eb311eee35ea217945735bfffb48e9f88e6203c7499afbc9833614188`。

后两份状态均为 TRANSFER_FAILED_OR_REMOTE_OUTCOME_UNCONFIRMED。原始日志和精确出口只留本机 ignored 输出，精简报告不公开用户当前出口地址。

## 官方后台与备案

本次浏览器站点安全策略阻止访问微信官方后台；没有使用其它浏览器、隐藏后台接口或间接执行绕过拦截。官方 CI 上传为事先独立规划、用户已授权的代码上传流程，不表示后台访问限制解除。

用户已决定自行在官方后台填写备案，提供了当前退回原因及字段。退回说明为“游戏名称与提审游戏存在不一致”；自动名称“生命线策略棋”与旧手填“生命补给线策略棋”确有不一致。已按0.14.1候选准备 [逐字段填写稿](../../docs/maintenance/publication-20261101/mini-filing-ready-v1.md)。实际违规图示、当前选中代码版本、所有微信截图名称仍需主体现场核对，不能只改文字就宣称问题已消除。

候选路径：`C:/coding/py/line game/working/local_artifacts/alignment-20261031/wechat-final-source-20261101-r2/local_artifacts/wechat-candidates/0.14.1-12465505d4a7-iwZmMx/project`。若改用官方开发者工具上传，先核对该候选、账号和平台当前要求，上传后仍需分别确认体验版、设备、提审、审核和公开状态；本文不自动执行这条替代流程。
