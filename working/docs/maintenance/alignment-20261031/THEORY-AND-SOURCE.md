# 当前理论文章与补源验证（2026-11-01）

## 指南当前入口

Theory 中英概览现在来自 `GuideContent.js`，生成器同步六篇文章。删除活跃内容中跨棋类“优越性”、把上界当紧确增长率，以及每步历史集合都严格增长的断言。普通三角棋盘的格点/共轴端点对计数仍保留；完整状态、PASS、终局、拓扑与 AI 结论边界分别说明。

原 2026-08-26 长篇文件逐字节保留为 `why-theory.20260826.zh.md` / `.en.md`，明确属于当时的二/三人规则快照。当前短文不是对历史长篇的重新证明或现行全部规则的形式验证。

实际 OnlineApp 调用共同 `loadGuideMarkdownAssets`，非 200、断网、正文读取失败及空正文均使用内嵌文本；语言加载代际仍阻止迟到结果覆盖新语言。入口、GuideContent 和文章请求版本一起更新。生成正文与内嵌文本精确相同，TeX 使用 `String.raw` 保留反斜线。

验证命令均退出 0：

```powershell
node web/tools/sync-implementation-guides.mjs --check
node web/web前端/tests/verify-guide-content.mjs
node web/web前端/tests/verify-guide-asset-fallback.mjs
node web/web前端/tests/verify-topology-last-moves.mjs
node web/web前端/tests/verify-topology-app-persistence-v1.mjs
```

最后一项测试已补齐真实卸载回调清理，自然退出，避免残留定时器阻塞验证。Web 拓扑恢复补丁与 Theory 增量分开冻结；后继移动宿主必须按语义移植，不得反向覆盖自身存档/原生桥。

## 已完成能力补源

从 `origin/main` 6da96325 取回防守教师工具、退休入口保护与真实依赖。首次有界验证暴露旧入口缺静态依赖，补齐五个依赖模块后完整验证通过。来源与逐文件 SHA 见 `source-supplement.json`。没有启动产品训练、强度评估或模型晋级。

`verify-defensive-training-v1.mjs` 本身使用临时目录中的微型标签和三步拟合，验证完成深度、两轮对手行动、全合法根含 PASS、精确值、断点恢复、重复工作者、暂停与证据损坏拒绝。结果为 `PASS_BOUNDED_TEACHER_AND_RECOVERY_ONLY`，生产模型训练数为 0，强度未验证。该结果取代 SOURCE-COVERAGE 初审时“尚未运行”的状态，历史初审保留。

Python 先吸收主分支 81 行新增/17 行删除的正式计分与每方标记修复，再从原主工作区逐方法审阅移植五个离散计分/显示方法；补齐初始缓存与空领土整数计分。原主工作区文件未覆盖，拓扑/起点相关 dirty 增量未被隐式移入。

固定回归均退出 0：

```powershell
python -X utf8 "core algorithm/test_latest_move_highlight.py"
python -X utf8 "core algorithm/test_territory_render.py"
node web/web前端/tests/verify-defensive-training-v1.mjs
```

Python 计分覆盖开链、单空腔、含敌内孔、双空腔与逐格绘制；标记覆盖真实落子、非法落子、显式/自动 PASS、被切断与 AI 试探不污染。此边界不等于 Python 和所有拓扑前端已逐行为等价。
