# 三点限制教学增补验证 — 2026-10-13

状态：PASS-CURRENT（本地教学）；本次未部署服务器。用户已明确暂停上线。
分支：codex/territory-v2-page-correctness；资源版本：20261013e。

新增第四关 L4-three-point-limit，原结算顺延为第五关 L5-settle-score。关卡使用真实 territory-v2 引擎、6 边长、2 人。前缀为蓝方 [1,0]，红方跳过；先点击红叉 [0,1] 被引擎拒绝，再点击金色目标 [0,2] 完成合法扩张。只有先经历指定的拒绝，再走合法目标，才显示下一关。
说明与规则保持一致：普通扩张不能形成三个同色节点连续紧邻的结构，最小三角与直线都受限；直接切断敌线时例外。未改动 GameEngine 规则。

Node 检查：最小三角 [0,1] 与连续直线 [2,0] 都返回 INVALID_MOVE；完整前后快照一致，包含行动方、回合与历史。合法目标 [0,2] 成功，目标高亮按阶段切换。全部五关前缀与目标动作通过。
真实浏览器：完成连接、圈地、切断、三点限制与结算五关；提前点合法目标被退回教学起点，指定红叉拒绝后显示间距说明，再点合法目标成功进入第五关。新增关卡中英文均显示，英文320px视口实际完成合法重试。第五关完成后保留指南舱说明与按钮。页面控制台未见错误。

本次保留15组稳定视口记录：中文三点限制拒绝后5组，英文拒绝后3组、完成后2组，中文最终结算页5组。尺寸涵盖320×568、390×844、844×390、568×320、1280×720。页面无水平或竖直滚动，教学卡、画布与操作区均在视口内。
一个尺寸切换后的即时观察在 ResizeObserver 完成前仍记录旧画布尺寸，不作为稳定布局通过证据；随后568×320在完成绘制后重新确认画布248×286，处于实际画框内。

验证命令（退出0）：
- node --unhandled-rejections=strict web/web前端/tests/verify-tutorial.mjs
- node --unhandled-rejections=strict web/web前端/tests/verify-board-input.mjs
- node --unhandled-rejections=strict web/web前端/tests/verify-replay-codec.mjs
- node --check web/web前端/OnlineApp.js
- git diff --check -- web/web前端/OnlineApp.js web/web前端/TutorialRunner.js web/web前端/GameController.js web/web前端/Renderer.js web/web前端/main.js web/web前端/index.html

截图与原始视口记录：local_artifacts/tutorial-three-point-20261013/（本地忽略目录）。此前四关版本验收记录原样保留。本次未做手机实机触摸或完整读屏验收。

## 源码 SHA-256

- TutorialRunner.js: 1AD3CD525B054D6D2AE1A1D43350AF986253498A942B9600A89130EA34463F27
- OnlineApp.js: 20A10AFA474DCC4F34738B6267888961C5185ABE794B893FD1D1DF4E5E427F2A
- GameController.js: 215CCEC7E01A15825BDD24D48D9137159DAD4BB5BF02529B26A35A371E643E49
- Renderer.js: 6E0AD51DA8083C472B4E4B0EE42A6D00402E116B90DBCAB4D40B16C4795A3E24
- styles.css: A7F69042B73C503157EDDA9F1B21843A0E48956B6F390FD78CE646E159DB0F36
- main.js: B93F91E95714B43BFF79F7FD3FB35AD9F76A21189CC154A91047B813D9A3C1CF
- index.html: F5D11EF568CF829AB94162B098F71189C073D36DFA4FC4967D582DC83FD71E51
- tests/verify-tutorial.mjs: 4909CDAC57079F093DA6039A70D63F6EE9743F7F193306047D010A59B9FCAC05
