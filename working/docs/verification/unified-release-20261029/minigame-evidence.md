# 微信小游戏本地候选验收记录

日期：2026-10-29。状态：`PREPARED_LOCAL_NOT_UPLOADED`。在线候选版本 0.13.0，面向 `https://lifelinegame.cn`；本记录不证明微信开发者工具、真机、体验版、审核或公开发布。

源码整合了 0.12.20 的现有小游戏宿主与拓扑、多根、菱形、旧房退出、能力协商、复盘、领土绘制及指南等更新。终局策略使用仓库已有的独立准入证据，未训练或晋级新模型。三维预览的 WebGL 离屏画布仅完成 Node 几何和不支持时的 UI 回退检查，实际微信环境尚未验收。

- 最终构建：`npm run build`，退出码 0。离线构建 manifest SHA-256 `792c19d7dd7e8305a2f92ec0412835125ea6d99d27a003ac011d49dd2a1eae15`。
- 最终串行回归：在 `wechat/minigame` 下运行 `node --test --test-concurrency=1 --test-timeout=180000 tests/*.test.mjs`，642 通过、0 失败、0 跳过，日志 `working/tmp/minigame-integration-serial-20261029.tap`。首次完整并行检查为 577 项中 511 通过、66 失败，保留其数目作为整合初期状态；后续修复了真实故障并重新运行。本地测试不等于设备验收。
- 旧 0.11.2 冻结参考中的 302 个棋局检查点：原引擎与 0.12.20 快照逐字段相同，候选除新增根元数据外与之相同；最终回归分别校验新增根元数据、冻结快照哈希、旧 schema 1 读取与重放，没有更改黄金文件。
- v3 自愿贡献仅允许可表达的经典单根普通对局；新增拒绝多根、拓扑和根操作及票据失效测试。F₂ 同调的微信兼容实现与 Web 在六种固定曲面和相对同调/边链例上比较一致。
- 在线候选位于本机 `working/local_artifacts/wechat-candidates/0.13.0-50c5b0ecbb24-a2gujg`，35 文件，20,502,618 字节；候选收据 SHA-256 `14562b248ce6acb92747330a8ca8319e7f5fab0be71986f7ae545cfce2584bc4`，在线 manifest SHA-256 `50c5b0ecbb245d4a797cd0bebfd75261060cc1af8d80984de5e96c09cd84e5d5`。
- 在线候选与完成回归的离线构建拥有相同的 201 项源码哈希；复核时每项与现场文件一致。两者 Worker SHA-256 均为 `c592855acf73f47503c5ad5ccf149e15670cebbed5911287ae620cb64f4e4cb2`。在线与离线主包配置不同。
- 官方传输脚本 `plan --candidate <候选目录> --online` 以 `PLAN_ONLY_NO_KEY_READ_NO_NETWORK` 通过；没有预览、上传、切换体验版或提审。

完整文件复验：`node wechat/minigame/tools/prepare-candidate.mjs --verify "<候选目录>"`。构建结果在源码或配置变化后必须重新生成并验证；正式发布状态以平台收据和真实设备检查为准。
