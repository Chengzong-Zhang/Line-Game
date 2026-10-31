# 目录与文档归并 — 2026-10-14

本次将文档统一到 `docs/`，保留可玩应用和研究源码的现有入口。

- 产品规范与契约归入 `docs/product/`，四个平台计划归入 `docs/platforms/`。
- 更新与上线记录归入 `docs/releases/`，仓库维护记录归入 `docs/maintenance/`；原验证收据保留在 `docs/verification/`。
- Web 架构统一为 `docs/web/architecture.md`，Web 的入口说明统一为 `web/README.md`。
- 早期课程资料、提示词和工程全文归入 `docs/archive/`；示例图片归入 `docs/assets/`。本机配置退出版本管理并保存在本机忽略目录。
- 根 README 更新当前玩法、独立棋手选择、9 种 AI、模型权重获取、启动方式与代码入口。
- “妙处 · Code”统一中英文当前版本，旧长文作为历史资料保留；短入口兼容原文章地址。
- 修复 Markdown 链接被显示成原文、网址冒号导致错误分段的问题。网页仅将有效 HTTP/HTTPS 目标渲染为链接，并为新窗口设置 `noopener noreferrer`。

本次检查了 34 份文档、103 个本地链接，运行了指南、棋手配置、棋谱、联机恢复及规则回归，并在真实浏览器中核对中英文的 8 个章节和 10 个源码链接。详见 [验证记录](../verification/repository-layout-20261014/validation.json)和[目录迁移表](../verification/repository-layout-20261014/directory-moves.json)。

冻结研究协议、结果与源码的路径及内容保持原样；自动化回归测试保留。
