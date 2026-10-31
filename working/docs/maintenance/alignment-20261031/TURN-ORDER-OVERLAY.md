# Web 行动顺序设置（2026-10-31）

## 范围与行为

从 `51e5782d` 前端加已验指南 overlay 的隔离候选增量实现，不修改规则引擎。设置显示颜色、序号、拖动及可键盘/触控操作的上移下移按钮；第一项是先手，支持中英文。普通棋盘为 2–15 人；拓扑棋盘限 2–6 人。人数变动保留仍存在的相对顺序并补上新席位，旧设置缺少 `turnOrder` 时按原引擎颜色循环并旋转到先手。重复或无效席位不被接受。

本地修改属于新局草稿，开始新局才提交。共享房通过房主可访问的“房间设置与行动顺序”按钮编辑和保存；访客不能修改。旧四位房保留先手控制，已有先手变化同步转换草稿顺序但使用旧协议。恢复和接收设置保留完整显式顺序，延迟解除同步标志，避免 Vue 批处理将恢复值当成用户编辑写回。更新 `index.html → main.js → OnlineApp.js → LocalPlayerSetup.js` 缓存版本及样式版本，避免旧浏览器资源继续显示下拉。主设置界面隐藏旧先手下拉；`LocalPlayerSetup` 默认保留它供其他调用者兼容。保留根玩法与既有指南内容。

## 工件与验证

- `turn-order-overlay-v1.patch`：从本轮 51e + guide-v1 前态生成的独立增量，`turn-order-overlay-v1-hashes.json` 记录每个文件的修改前后 SHA-256；新文件修改前为 null。隔离前态执行 `git apply --check` 退出码 0。宿主适配须在此之后叠加并重新绑定清单。
- `node web/web前端/tests/verify-turn-order-setup.mjs`（通过 `LIFELINE_TEST_VUE_PACKAGE` 指向现有 Vue 所属 package.json）：退出码 0。覆盖 3/6/15 席重排与真实规则引擎下一席、6 人拓扑状态、旧设置回退、重复拒绝、人数变化、真实 Vue setup 的组件事件、草稿不改变活动引擎、新局提交、非房主拒绝及房主可编辑、非草稿进行中拒绝、普通存档恢复。测试中的宿主与网络为受控替身，不声称真实跨端房间通过。
- `node web/web前端/tests/verify-local-game-session.mjs`、`verify-local-player-setup.mjs` 和 `verify-guide-content.mjs`：退出码 0。
- 父任务实际 IAB 验收：旧下拉不再显示；拖拽、按钮和 Enter 可用；英文 390px 视口无横向溢出；实际三人新局按 3→1→2 行动，刷新后恢复第 2 位及历史。共享房真实联机仍需单独验收。Node/替身测试不等同微信设备或发布验收。
