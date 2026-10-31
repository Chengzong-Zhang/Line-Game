# 浏览器 AI 更新：2026-10-13

本次范围为网页 AI 更新：9 个 transfer_all 模型、seed 明确选择、保留旧模型、去掉模型标题中的 5–15，并为每个 AI 对手提供一句中英文特点简介。网站运行规则仍以 Web GameEngine 为权威，迁移模型保持 PILOT_ONLY / COMPATIBILITY_TRIAL，未经独立棋力评估，不是正式研究结果。

本地网页运行时的保存/复盘模块是当前 AI 界面的依赖，一并纳入候选；不包含其他论文草稿、数据库、账号数据、TLS 文件、原始轨迹或训练 checkpoint。主工作区保留，发布源码位于独立 codex/web-ai-release-20261013 分支。

权重不进入普通 Git 历史，17 个 F32（9 个迁移、3 个旧 PUCT、5 个既有其他方法）在同名 GitHub Release 中单独提供，SHA-256 以三个模型 manifest 为准。克隆后可运行：

```powershell
python web/fetch_research_ai_assets.py
node --unhandled-rejections=strict web/web前端/tests/verify-research-ai.mjs
node --unhandled-rejections=strict web/web前端/tests/verify-research-worker.mjs
```

11 项 Node 回归均通过，18 个中文/英文 AI 简介选择均实际检查，见 preflight.json。此前数值与有界规则差分证据保留在 docs/verification/web-size-transfer-v1-20261012；两处终局计分差异仍存在，不能声称 Python/Web 规则全等价。手机实机与独立棋力评估未执行。

服务器发布方式为复制完整旧前端到候选目录、仅叠加允许的运行时文件、验证逐文件/目录哈希，随后使用 renameat2(RENAME_EXCHANGE) 原子交换。旧前端完整保留为回滚目录；既有后端和数据库不参与此包。公共发布状态与回滚路径以单独的 deployment.json 为准。
