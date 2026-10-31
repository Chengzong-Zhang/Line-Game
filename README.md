# LIFELINE（生命线）

LIFELINE 是一款在网格上落子、连线和争夺领土的策略游戏。保护与起点相连的结构，也可以切断对手的关键连接，改变整片棋局。

**[在线试玩](https://lifelinegame.cn/) · [游戏规则](web/web前端/guide/rule/essential%20rule.md) · [Web 开发说明](web/README.md) · [文档导航](working/docs/README.md)**

## 体验游戏

Web 工程包含本地与房间对局、人机对战、教学、保存恢复、棋谱导入导出和复盘，以及中英文界面。棋盘、人数、AI 和联机能力取决于实际使用的版本；各平台的工作副本和发布包可能不同步。

本整合分支的常规棋盘支持 2–15 人，拓扑引擎支持 2–6 人；7–15 人使用随机或自定义起点。支持三角形、六边形等棋盘，包含拓扑棋盘预设、棋盘编辑与随机生成入口。拓扑棋盘使用独立规则；可用 AI 和复盘能力随棋盘及模式变化。多人 AI 提供简单、中等、困难、终极选项，通用棋盘使用简单和困难选项，终极模型的棋力仍在评估。

| 来源 | 当前可确认的范围 |
| --- | --- |
| 本整合分支 | 整合 Web/小游戏共同能力及本轮指南、行动顺序、最近落子和恢复修复；常规 2–15 人、拓扑 2–6 人。 |
| 原主目录的独立工作副本 | 部分旧入口仍为 2–6 人，且有大量先前未提交工作；本轮保留原状，没有覆盖或全部提交。 |
| 网页与微信渠道 | 有各自的部署或上传记录；真实设备、跨端及渠道接受状态须按候选版本核对，不能从源码或上传记录推断。 |
| 移动端和桌面端 | 由共同前端和受控宿主构建本地候选；签名、设备和渠道状态见交付记录。 |

本轮的源码来源、安装候选、验证与未验范围见 [交付记录](working/task/alignment-20261031/DELIVERY.md)。完整问题清单和执行要求见 [详细提示词](working/task/alignment-20261031/EXECUTION-PROMPT.md)。

本地限次悔棋可在棋盘设置中开启，额度为每局 1–10 次，默认关闭。它撤回自己最近一手及后续回应，不能连续回退到更早的手数；不返还提示次数，回退后重新读秒，已用次数随存档恢复。设置修改在开始新局后生效。

神经模型需另行下载权重；模型适用范围及试用状态见 [AI 兼容说明](working/docs/product/LIFELINE_AI_COMPATIBILITY.md)。模型估值不是实际胜率，权重种子顺序也不代表棋力排名。

## 本地运行 Web

需要 Python 3.10+ 和现代浏览器。页面使用 Vue 和 MathJax CDN，首次加载需要联网。

```powershell
git clone https://github.com/Chengzong-Zhang/Line-Game.git
cd Line-Game
python -m pip install -r "web/web后端/requirements.txt"
python -m uvicorn server:app --app-dir "web/web后端" --host 127.0.0.1 --port 8000
```

打开 <http://127.0.0.1:8000/>。Windows 也可运行 `powershell -ExecutionPolicy Bypass -File "web/start/start_online_server.ps1"`，脚本会选择可用端口。先选择人类或 Minimax 对局；神经模型的权重下载位置和命令见 [Web 说明](web/README.md)。

## 规则与实现

当前工作副本的 Web 常规新局默认使用 `territory-v3`，拓扑棋盘使用自己的规则版本；旧存档与棋谱保留所存版本。v3 中，节点和线点属于己方领土；没有敌方元素的封闭空腔也计入正式离散分数 `area`。连接与断联以显式逻辑边和起点为准。`renderPoints` 枚举计分点，`polygon` / `displayArea` 不替代正式比分。规则介绍见[游戏规则](web/web前端/guide/rule/essential%20rule.md)和[代码与工程设计](web/web前端/guide/interesting/why-code.zh.md)。

Superko 历史影响合法行动，因此保存、恢复、搜索与复盘需要完整规则状态。Web 前端负责规则与渲染，后端处理账号及房间同步；Python/Pygame 和冻结研究环境有各自版本，不应默认与 Web 逐状态等价。

## 项目入口

| 目录 | 内容 |
| --- | --- |
| [web/](web/) | 浏览器前端、后端、启动脚本和测试 |
| [wechat/](wechat/) | 微信小游戏入口及平台说明 |
| [mobile/](mobile/) · [platform/](platform/) | 移动端、桌面端及渠道工程入口 |
| [working/platform-hosts/](working/platform-hosts/README.md) | 可审阅、逐文件哈希固定的平台宿主源码与重建说明 |
| [working/ios/](working/ios/alignment-20261031/) | iOS 工程与 Mac/Xcode 接续材料 |
| [core algorithm/](core%20algorithm/) | Python/Pygame 和基础算法 |
| [research/](research/README.md) | 冻结研究材料与实验入口 |
| [working/docs/](working/docs/README.md) · [working/task/](working/task/) | 产品规范、验证记录与任务 |
| [working/](working/README.md) | 本地工作资料和目录兼容说明 |

平台 `project/` 在此 Windows 工作区是指向独立工作副本的链接，并非合并后的源码；新克隆不会自动包含这些本机链接。不要递归删除链接或其目标。新克隆可用 `powershell -ExecutionPolicy Bypass -File working/tools/setup-layout.ps1` 建立兼容入口；加 `-Check` 检查，其中 `UNAVAILABLE` 表示对应可选平台目标不存在。详情见 [工作资料](working/README.md)。

这些目录和历史发布记录只说明代码或当时的工作，不能单独证明当前安装包、线上服务或商店已经同步和发布。按目标版本查阅 [发布记录](working/docs/releases/)与[验证证据](working/docs/verification/)。

## 开发与验证

按改动选择对应测试，例如从仓库根目录运行：

```powershell
node --unhandled-rejections=strict "web/web前端/tests/verify-territory-v3.mjs"
node --unhandled-rejections=strict "web/web前端/tests/verify-replay-codec.mjs"
python -m unittest discover -s web/tests -v
```

Python/Pygame 示例和依赖见[桌面示例说明](core%20algorithm/AI/README.md)；研究环境和协议见[研究入口](research/iclr2027/README.md)。开发、冻结实验、长任务恢复和产物管理约定见 [AGENTS.md](AGENTS.md)。自动化检查不能代替浏览器、真机或跨端联机验收。
