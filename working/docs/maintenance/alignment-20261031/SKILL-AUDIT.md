# 技能更新与安装

用户本轮点名的维护对象为现有 `lifeline-dev`。保留名称和原有界面元数据，不另建 `lifelinegame` 别名副本。

## 变更

- 建立完整可版本管理源码 `working/skills/lifeline-dev/`，含入口、agents 元数据及全部参考，共 9 个文件。
- 新增仓库/README/目录/指南舱维护参考，以及拓扑棋盘/完整根集/行动顺序/接缝/3D 状态参考。
- 更新正式资料路径、共同 Web/Mini 来源选择、旧包依赖遗漏检查、隔离宿主构建和本地工具链定位。
- 补充防守教师入口和完整状态约束，保留旧研究、发布权限与证据边界。
- 增加 `working/tools/sync-lifeline-skill.py`，默认只比较；`--install` 仅同步本技能，保存旧文件备份并逐文件验证哈希，不删除目标额外文件。

## 验证与安装

1. 默认 `python` 缺少 PyYAML，第一次 quick_validate 未执行成功；没有把后续搜索退出码当验证通过。
2. 使用已有 `C:/Users/zcz/anaconda3/python.exe -X utf8` 运行 skill-creator 的 `quick_validate.py working/skills/lifeline-dev`：退出 0，`Skill is valid!`。
3. `python -X utf8 working/tools/sync-lifeline-skill.py`：比较成功，5 个新增/改变文件，4 个保留文件。
4. 精准获得本机目录写入权限后运行 `python -X utf8 working/tools/sync-lifeline-skill.py --install`：退出 0，9 文件全部哈希一致；安装位置 `C:/Users/zcz/.codex/skills/lifeline-dev`。
5. 对已安装路径再次运行相同 quick_validate：退出 0，`Skill is valid!`。

安装前后逐文件哈希在 [skill-install.json](skill-install.json)。旧文件本机备份在 `working/tmp/alignment-20261031/skill-before-install/`。结构校验不证明所有未来任务行为正确；本轮仓库、指南与跨平台任务另有实际执行证据。文件已经安装，不声明运行中的模型上下文已自动热更新。

独立审阅后进一步明确：采用 Web/Mini 已完成能力的并集，并保留每个目标端原有挑战、档案、备份、原生恢复及兼容行为，逐项建立前后覆盖回归。公开维护副本移除了不必要的私人聊天标识。最终副本再次通过结构校验并实际安装；上述 JSON 是最后一次安装的前后哈希，历次旧文件按内容哈希分别备份，没有覆盖先前备份。

## 2026-11-01 验证后再安装

新增指南外部/内嵌回退一致性、历史文章适用范围、双协议路由与有效旧断言保留、隐私同意不扩展及测试资源清理的工作方法。它们位于按需参考文件，未增加发布或训练权限。再次运行 skill-creator quick_validate 退出0，实际安装9文件并逐文件核对SHA；最新安装收据见 skill-install.json。除本技能之外的目录未变更。
