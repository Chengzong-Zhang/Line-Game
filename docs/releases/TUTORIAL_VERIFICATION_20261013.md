# LIFELINE 教学引导验证 — 2026-10-13

状态：PASS-CURRENT（本地 Web 界面）；尚未上线，未做手机实机触摸或完整读屏验收。
分支：codex/territory-v2-page-correctness。资源版本：20261013d。规则：territory-v2，教学 6 边长、2 人。

本次与“增大移动端和网页端棋盘”对话协作，保留其单屏布局、工具栏和 topInset:52。
教学统一为蓝方/红方；第二关说明真实的一条已有边及两条新增连接；高亮目标点、连接/闭合边界、红方被切线段、快照差异中的清除点；结算按钮有金色轮廓。完成目标后锁定棋盘，换关清空旧提示，收尾提供“请看指南舱”和实际打开指南舱的按钮。

真实浏览器：Codex In-app Browser。中文桌面与英文 320px 手机视口均实际完成四关；中文收尾的“查看指南舱”已点击并打开指南弹窗，恢复普通对局后棋盘可操作。页面控制台未见错误。
中文第四关操作前/完成后：320×568、390×844、844×390、568×320、1280×720、1366×768，共12组。英文完成页：320×568、568×320、1280×720，共3组。15组均 page=viewport，教学卡、操作区与教学按钮在屏内。英文首关320×568另行截图检查通过。

验证命令（均退出 0）：
- node --unhandled-rejections=strict web/web前端/tests/verify-tutorial.mjs
- node --unhandled-rejections=strict web/web前端/tests/verify-board-input.mjs
- node --unhandled-rejections=strict web/web前端/tests/verify-replay-codec.mjs
- git diff --check -- web/web前端/OnlineApp.js web/web前端/TutorialRunner.js web/web前端/GameController.js web/web前端/Renderer.js web/web前端/styles.css web/web前端/main.js web/web前端/index.html

本地视觉证据（受 .gitignore 保护，不提交）：local_artifacts/tutorial-20261013/；含 first-desktop.jpg、cut-result.jpg、finish-mobile.jpg、guide-open-mobile.jpg、browser-layouts.json、english-layouts.json。

## 本次源码 SHA-256

- TutorialRunner.js: 176E6C1A91D29466E512734402ABE7135DF63AF6C2CD94B70EBE1DEB0CCA28CF
- OnlineApp.js: 4BF9A8FB218DEABC0910878A7BF31B702CBFC2730DF7D6279C6B4591CF565F9F
- GameController.js: 44A7FE335386C40EBBB75D656DBCF44ED92675ECFB4921E813BBAFF790ADD6C2
- Renderer.js: DE6E0EE86317482A01141AE1223C597555C7FF0C4BC1BE0C9C84E0FCFDB025CB
- styles.css: A7F69042B73C503157EDDA9F1B21843A0E48956B6F390FD78CE646E159DB0F36
- main.js: 1CFE3A925B2F6E3365E5BDE9BF14D57D424611367C3F0DA507BBA7AEA23AD68F
- index.html: F8061FD3EA1B3446039860B079304A7A31794AE59DF2021ABB7EFC1AF89EB7A0
- tests/verify-tutorial.mjs: 3B744C8FDBB199B102BA3CA1CBAC4430D88C63688A677072452B3DECBDA8D531
