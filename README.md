# LIFELINE（生命线）

一款在三角网格上进行的圈地策略游戏：落子会自动连线，切断一条关键连接，就可能让整片失去基点连接的结构消失。胜负按最终领土结算。

**[在线试玩](https://lifelinegame.cn/) · [游戏规则](web/web前端/guide/rule/essential%20rule.md) · [代码与工程设计](web/web前端/guide/interesting/why-code.zh.md) · [文档导航](docs/README.md)**

## 现在可以玩什么

- 本地 2–6 人对局与账号房间联机：2/3 人使用三角棋盘，4/5/6 人使用正六边形棋盘；Web 边长支持 5–15 个格点。六边形功能的本地验证范围见[说明](docs/product/LIFELINE_HEX_BOARD_20261020.md)。
- 双人局分别为蓝方、红方选择棋手和先手，支持人人、人机及 AI 对战。
- 三人局支持配置 1 或 2 个 AI 席位；4–6 人六边形局支持真人轮流对战。
- 9 种 AI 策略：Minimax、Padded-CNN + PUCT、Grid-GNN + PUCT、Topology-GNN + PUCT、DQN、PPO、SAC、GAIL、GAN。
- Minimax 提供简单、中等、困难三档；神经模型提供版本和种子选择。
- 读秒、限次提示、局面保存与刷新恢复、分步教学。
- 棋谱导出、隔离校验后导入、逐步复盘、局面检查器及 AI 对比。
- 可自愿贡献匿名的完整本地棋谱，供筛选与训练。
- 中英文界面、Canvas 棋盘与响应式布局。

神经模型的训练范围和版本状态见[模型兼容说明](docs/product/LIFELINE_AI_COMPATIBILITY.md)与资产清单。迁移模型属于 `PILOT_ONLY` / `COMPATIBILITY_TRIAL`；搜索估值不能当成真实胜率，种子顺序也不表示棋力排名。

## 本地启动 Web

需要 Python 3.10+ 和现代浏览器。页面使用 Vue、MathJax CDN，首次加载需要联网。

```powershell
git clone https://github.com/Chengzong-Zhang/Line-Game.git
cd Line-Game
python -m pip install -r "web/web后端/requirements.txt"
python -m uvicorn server:app --app-dir "web/web后端" --host 127.0.0.1 --port 8000
```

打开 <http://127.0.0.1:8000/>。Windows 也可使用会自动选择端口的启动脚本：

```powershell
powershell -ExecutionPolicy Bypass -File "web/start/start_online_server.ps1"
```

在对局设置中分别选择蓝红双方的棋手，再从主界面开始对局。未下载权重时，先选择人类或 Minimax；Minimax 无需额外权重。

### 神经模型权重

权重通过 [GitHub Release](https://github.com/Chengzong-Zhang/Line-Game/releases/tag/web-ai-transfer-v1-20261013) 分发，克隆源码不会自动下载 `.f32` 文件。

- 文件名包含 `transfer-v1-seed` 的 9 个权重放入 `web/web前端/assets/research-ai/transfer-v1/`。
- 其余 8 个权重放入 `web/web前端/assets/research-ai/`。
- 资产清单随源码提供；[Web 说明](web/README.md)给出了批量下载命令。

## 目录与职责

```text
Line-Game/
├── web/                    浏览器玩法、联机服务、发布工具与回归测试
│   ├── web前端/            Vue / Canvas / 规则引擎 / Worker / 棋谱
│   ├── web后端/            FastAPI / 账号 / 房间 / 匿名棋谱收件
│   ├── start/              本地启动脚本
│   ├── tools/              模型、棋谱与原子发布工具
│   └── tests/              后端回归测试
├── core algorithm/         Python/Pygame 桌面版本与 Minimax 示例
├── research/               研究源码、冻结协议、聚合结果与论文
├── docs/                   统一文档入口
│   ├── product/            玩法、棋谱、教学、发布门槛与 AI 契约
│   ├── platforms/          各平台的迁移计划
│   ├── web/                Web 架构说明
│   ├── releases/           网页更新及上线记录
│   ├── verification/       紧凑验证证据
│   ├── maintenance/        仓库整理记录
│   ├── archive/            早期课程资料、提示词与工程说明
│   └── assets/             文档示例图片
└── AGENTS.md               版本管理与实验可靠运行约定
```

生成的压缩包、录屏、数据库、缓存、原始轨迹与检查点保留在本机；自动化回归测试保留在源码中。

## 规则与工程设计

Web 页面和新房间采用 `territory-v2`：物理格点记录占用，显式逻辑边决定连通性；攻击后按基点连通性清除失联结构，领土按有效闭环与离散覆盖格点结算。

Superko 的历史集合会影响合法动作，因此保存、恢复、搜索与复盘都需要完整规则状态。AI、提示和领土计算使用 Worker，并校验请求与局面归属，防止迟到结果影响新对局。

前端负责棋盘规则与渲染，后端负责账号、房间同步和棋谱收件。Python/Pygame 是 legacy v1 lineage；研究环境按各自冻结协议运行，三者不自动视为逐状态等价。

详细解释见[妙处 · Code](web/web前端/guide/interesting/why-code.zh.md)、[Web 架构](docs/web/architecture.md)和[研究入口](research/README.md)。

## Python/Pygame 示例

```powershell
python -m pip install pygame
$env:PYTHONPATH = (Resolve-Path "core algorithm").Path
python "core algorithm/AI/main_ai.py"
```

原始双人入口是 `core algorithm/triangular_game.py`；操作与无头检查见[桌面示例说明](core%20algorithm/AI/README.md)。

## 开发与验证

前端回归需要 Node.js，可按改动选择：

```powershell
node --unhandled-rejections=strict "web/web前端/tests/verify-territory-v2.mjs"
node --unhandled-rejections=strict "web/web前端/tests/verify-local-player-setup.mjs"
node --unhandled-rejections=strict "web/web前端/tests/verify-replay-codec.mjs"
node --unhandled-rejections=strict "web/web前端/tests/verify-online-recovery.mjs"
python -m unittest discover -s web/tests -v
```

研究环境的依赖、协议与验证入口见 [research/iclr2027](research/iclr2027/README.md)。长任务须具备检查点、自动恢复、独立监督和停止入口；冻结实验与正式结果按 [AGENTS.md](AGENTS.md) 管理。
