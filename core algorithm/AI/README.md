# Python/Pygame 桌面示例

这是 LIFELINE 的 legacy v1 lineage 桌面版本，提供 Minimax + Alpha-Beta 人机对战、三档搜索深度、Top-5 候选和提示。当前浏览器版本的独立棋手选择、神经 AI 与复盘功能见[项目 README](../../README.md)。

## 启动

在仓库根目录执行：

```powershell
python -m pip install pygame
$env:PYTHONPATH = (Resolve-Path "core algorithm").Path
python "core algorithm/AI/main_ai.py"
```

- `1`：人人对战；`2`：人类蓝方；`3`：人类红方。
- `E`、`M`、`H`：搜索深度 2、3、4。
- `Enter` 或空格开始，鼠标落子，`H` 请求提示。
- 原始双人版：`python "core algorithm/triangular_game.py"`。

## 文件

| 文件 | 职责 |
| --- | --- |
| `../triangular_game.py` | 原始规则与 Pygame 棋盘 |
| `ai_engine.py` | Minimax、Alpha-Beta、走法排序与启发式评估 |
| `ai_game.py` | AI 回合、后台计算与候选显示 |
| `main_ai.py` | 启动入口 |
| `test_ai_headless.py` | 不打开窗口的合法走棋检查 |

```powershell
$env:PYTHONPATH = (Resolve-Path "core algorithm").Path
python "core algorithm/AI/test_ai_headless.py"
```

早期课程文档、录屏讲稿与文档提取文本已集中到 [docs/archive/course-demo](../../docs/archive/course-demo/)。AI 使用总结与最初开发计划保留在本目录，供历史来源核对。
