# 指南内容与阅读审计（2026-10-31）

## 范围与依据

本次定位为游戏内指南舱：`GuideContent.js`、`GuideImplementation.js`、`GuideTopologyChapters.js`、生成文章和网页阅读器。没有发现需要另行猜测的独立指南仓。本次核对主工作区规则和 `SurfaceTerritory.js`，并比对统一网页及后续微信工作树；两者的拓扑章节相对于主工作区仅有模块导入的缓存版本差异。后续微信棋盘流程交付记录包含行动顺序、统一图形与起点编辑、3D 优化；这些记录不证明主工作区或其他端已同步，不能将其笼统写作当前各端均已上线。

## 发现和选择

- 数学与 Code 各保留一个拓扑第四章；旧 `topologyGuide` 使用数学文章及 `rulesMath-topology` 锚点，不新增重复卡片。
- `SurfaceTerritory.js` 逐个检查删去己方占点后的连通分量：不触及真实边界且不含敌方元素时计分。闭曲面没有真实边界，现补充即使屏幕上看不出被包围，符合条件的无敌方分量仍按规则计分；含敌分量整块不计分。该描述不将显示面积当作胜负。
- 长文、代码和公式需要约束阅读宽度并允许横向滚动，窄屏需保留标题和关闭按钮；章节目录需要真实跳转、支持双语和手机。
- 初版目录误筛 `heading1`：实际数学文章的章是 `heading2`，父任务在真实浏览器确认目录未出现。该缺陷已交由父任务修正；本报告不能把初版静态检查视为 UI 验收通过。
- 简明指南胜利条件中有凸包、收紧轮廓等技术术语，父任务正将技术细节移到数学/Code，简版保留正式分数与显示的区别。

## 本子任务修改与保护

更新 `GuideTopologyChapters.js` 的闭曲面双语说明；运行生成器同步四篇双语实现文章。`OnlineApp.js` 的指南组件及 `styles.css` 的指南样式先做了目录和排版增量，父任务接手修正。原有工作区修改未还原；基线分别保存在 `working/tmp/alignment-20261031/guide-before.diff`、`guide-before-hashes.json`、`guide-onlineapp-before.diff` 和 `guide-onlineapp-before-hash.json`。拓扑章节是未跟踪文件，原始 diff 不含全文；本子任务新增内容以“闭曲面没有真实边界”及其英文为定位。

## 验证与边界

以下命令在本子任务更改语义后执行，组合进程退出码 0，输出分别为 `Updated four bilingual implementation articles.`、`Verified four bilingual implementation articles.` 和 `verify-guide-content: PASS`：

```powershell
node web/tools/sync-implementation-guides.mjs
node web/tools/sync-implementation-guides.mjs --check
node --unhandled-rejections=strict web/web前端/tests/verify-guide-content.mjs
```

此回归确认生成文章、四章、拓扑旧入口/锚点、公式及源码摘录等，不能证明浏览器布局或真机可用。其后并行的语法和 diff 检查工具调用被中断，未取得结果，不计通过。子任务自建 `127.0.0.1:18762` 的只读 HTTP 服务在浏览器插件中超时；桌面浏览器访问审批超时。父任务另用可访问的本地服务实际打开页面，发现上述目录缺陷。目录修复后的浏览器复验、手机视口和微信真机验证以父任务最终结果为准。本任务未部署、上传、推送或启动训练。

## 主任务修复与真实浏览器复验

目录现在从真实解析块选择章级标题，四篇中英文章均能得到四章。目录可折叠，使用真实按钮跳转，保留唯一拓扑锚点。新版短规则移除凸包/收紧等实现细节，保留正式分数与显示的区别。

主任务仅针对 `51e5782d` 生成九文件窄补丁，全部 before/after SHA 与实际应用一致；旧 Android 正则 fallback、anchor 校验及新 root-v2 的 Code 摘录均保留。补丁在独立参考源码上应用后，生成器 --check、内容回归（11 处源码摘录）及拓扑指南回归均退出 0。干净整合分支重复上述三项检查也均通过。

IAB 在本机只读服务及 itch-guide-01 候选实际验证了四章目录显示、第四章跳转、Enter 折叠目录、五张中文规则图片加载。1280×720 桌面和 390×844 手机视口均可阅读；手机页面宽度与 scrollWidth 均为 390，阅读器 374，正文 327，没有页面级横向溢出。截图为本目录 `guide-desktop.jpg`、`guide-mobile.jpg`。

同一个候选还完成了人类开局、一次真实落子、双方连续 PASS 和蓝 3:红 1 的正式结算。该检查仅是有限短局，不代表所有曲面/AI/恢复/真实 itch CDN 或微信设备验收。
