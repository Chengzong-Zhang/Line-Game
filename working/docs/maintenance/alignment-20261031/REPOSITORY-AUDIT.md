# 仓库入口与布局审计（2026-10-31）

## 范围和基线

本次只检查主工作副本的 README、文档入口与 Windows 本地兼容链接，不宣称其他工作树或远端已经整合。开始检查时分支为 `codex/project-layout-20261026`，HEAD 为 `44ee3331`，origin 为 `https://github.com/Chengzong-Zhang/Line-Game.git`；整合负责人随后建立了 `codex/project-alignment-20261031`。开始时 `README.md` 已有未提交改动：本地悔棋及 v3 计分；本次保留其内容和含义。其他本次入口文件没有已跟踪改动。全树当时有 94 条已跟踪变更、展开后 1875 条状态记录；不属于本次任务的修改均未清理。

## 发现与处理

1. 原 README 将工作区代码、历史功能和跨平台入口并列，容易被误读为各渠道当前状态。新版突出试玩、本地运行、源码职责和状态边界，具体功能以目标版本验证为准。仓库内 `web/README.md` 的旧能力清单仍需随最终统一版本另行复核。
2. `GameController.js` 的常规默认版本为 v3，后端 `server.py` 的默认值也是 v3；拓扑棋盘使用独立规则版本，裸 `GameEngine` 默认 v1。新版保留原有 v3 计分描述并明确版本边界。
3. `working/docs/` 和 `working/task/` 是资料入口。平台 `project/` 是到独立工作树的 junction，不是整合结果。冻结研究和本机产物保持实体位置，没有移动、删除或修改其内容。
4. `setup-layout.ps1 -Check` 对不存在的可选平台输出 `UNAVAILABLE` 但仍可退出 0；本机 iOS 入口即为此情况。脚本普通模式在必需目标缺失时会创建空目录，现明确输出 `CREATED EMPTY TARGET`；空目录不表示数据已恢复。该脚本未被作为普通模式运行，本次没有创建或改变任何链接。
5. 本机众多 worktree 包含独立开发、实验或冻结证据，另有标记 prunable 的旧工作树；未经逐项核实，不应批量清理。是否真正需要及可否移除属于后续独立审计。
6. 整合负责人通过 GitHub connector 只读检查：远端公开仓库默认分支为 `main`，README 文件 SHA 为 `42e1e7bccea67aa7cb95c89d7428af652b3e32ba`；其宣称 2–15 人、9 种策略、三档、v2 和旧 docs 布局，不能直接等同主工作副本。主工作副本的常规及拓扑引擎均限制 2–6 人；较新微信工作副本的常规引擎为 2–15 人，7–15 人需要随机或自定义起点，而拓扑引擎仍为 2–6 人。此为源码检查，不代表渠道运行验收。README 已补充差异，整合提交与远端更新仍待单独审阅。

## 验证

- `powershell -NoProfile -ExecutionPolicy Bypass -File working/tools/setup-layout.ps1 -Check`：退出 0；其余项目输出 OK，`mobile/ios/project` 为 UNAVAILABLE。该结果不证明平台源码相同或可构建。
- `node --unhandled-rejections=strict web/web前端/tests/verify-territory-v3.mjs`：退出 0，开放、闭合、Cyan 及终局计分测试通过；不代表完整游戏或跨平台验收。
- `git diff --check -- README.md working/README.md working/docs/README.md working/tools/setup-layout.ps1`：退出 0。
- 使用 Python 提取本次四个 Markdown 文件的相对链接、URL 解码并检查本机路径：退出 0，未发现缺失；未检查远端网站或未来提交中的文件集合。

## 后续边界

本审计的执行者未独立连接 GitHub；上述远端 README 事实来自整合负责人的只读检查。没有提交、推送、发布或构建安装包。主工作树大量未提交内容和目录迁移需由整合负责人逐文件复核并选择性纳入版本管理；确认目标提交中导航链接均存在后再审阅发布。各平台来源、功能覆盖、包与设备验收应依各自的同步报告核实。

## 主任务的干净整合副本

主任务随后从已核实的 Web/Mini 后继 `51e5782d` 建立了受管理的独立工作副本 `C:/Users/zcz/.codex/worktrees/lifeline-alignment-20261031/line game`，分支为 `codex/lifeline-alignment-20261031`。原主目录的旧修改保持原状。指南已作为九文件窄增量提交 `2342f7f6`，没有将原主目录整个 dirty 纳入。

该来源仍有 88 个旧 `docs/` 文件，主任务在新副本中逐文件迁至 `working/docs/` 并核对 SHA-256 内容不变，旧路径建立本机兼容 junction。没有移动研究环境。为使导航可用，另从已存在的目录整理提交 `83b7a608` 补入 22 个缺少的正式导航/历史文档与素材；其历史状态不等于本轮新验证。完整移动与来源清单为 `layout-integration.json`。此段说明独立整合副本的动作，不改变上面针对原主目录的审计范围。
