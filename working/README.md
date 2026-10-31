# 工作资料

- `docs/`：产品规范、发布记录、验证证据和文档导航。
- `task/`：任务计划与待办。
- `local_artifacts/`：本机产物入口；包含实验、检查点和独立 Git 工作副本，实体位置保留以保证旧路径和恢复配置有效。
- `.pytest_cache/`：pytest 自动生成的缓存，可删除。
- `output/`：需要保留的成品文件，例如最终 PDF。
- `tmp/`：临时制作资料及部分独立工作副本；清理前逐项确认，不递归删除。
- `softcopyright/`：本机软著准备材料。
- `archives/`：历史工作副本入口，不视为可删除缓存。
- `tools/setup-layout.ps1`：建立本机目录兼容入口；加 `-Check` 只检查。
- `skills/lifeline-dev/`：项目技能的可审阅源码；用 `tools/sync-lifeline-skill.py` 比较或安装到本机现有技能。

根目录的旧 `docs/`、`tasks/`、`output/`、`tmp/`、`softcopyright/` 是隐藏的兼容目录链接。文档和任务的实体已经迁入此目录，旧命令仍可使用。历史文档与冻结证据保留原文，历史相对链接可从旧 `docs/` 入口打开。新文档使用新路径。

平台入口是连接到已有独立工作副本的目录链接，修改其中源码会修改对应工作副本。入口不代表代码合并、同步或发布；不要递归清理这些链接。

新克隆在运行旧脚本前执行：

```powershell
powershell -ExecutionPolicy Bypass -File working/tools/setup-layout.ps1
```

脚本不复制平台工程，不下载依赖，不覆盖已有真实目录；本机不存在的平台会显示 `UNAVAILABLE`。缺少必需目标时，普通模式会建立空目录并显示 `CREATED EMPTY TARGET`，不会恢复其中的数据；`-Check` 会报错。退出码为 0 仍可能含有可选目标的 `UNAVAILABLE`，应逐项查看输出。其他系统需为上述旧路径建立相应符号链接，或直接使用新路径。
