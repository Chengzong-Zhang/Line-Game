# 画布内舱入口与桌面表情栏复核（2026-10-13）

状态：`PASS-CURRENT_LOCAL_BROWSER_LAYOUT`。这是同日一屏布局验证之后的追加修改，历史验证记录保持原样。本次未提交、推送或发布。

## 本轮修改

- `BoardCanvas` 的工具插槽移到 Canvas 所在的 `.board-canvas-surface` 内；Canvas 覆盖完整画框，三个舱入口的边界均包含在 Canvas 边界内。
- Renderer 使用 `topInset: 52` 保留顶部工具栏空间。新增回归确认：整体 Canvas 高度增加 52px 时，棋盘网格间距保持不变，节点不会进入顶部工具区域。
- 桌面回合栏限定为紧凑宽度，10 个表情使用单行布局。宽度 981–1119px 时，表情仍独占一整行；更宽时与回合和操作按钮同排。
- 去掉回合提示下方多余边距。1280×720 的稳定布局中，回合栏宽 180px，底部操作区高 62px。
- 本轮入口缓存版本为 `20261013c`；教学对话在共享工作区继续自己的增量修改，后续版本以其追加记录为准。

## 验证

| 检查 | 结果 |
| --- | --- |
| `node --unhandled-rejections=strict "web/web前端/tests/verify-board-input.mjs"` | PASS，退出码 0，包含顶部预留区域的网格间距回归 |
| `node --unhandled-rejections=strict "web/web前端/tests/verify-territory-v2.mjs"` | PASS，退出码 0 |
| `node --check "web/web前端/OnlineApp.js"` 与修改文件的 `git diff --check` | PASS，退出码 0 |
| 实际浏览器入口操作 | 棋盘舱、联机舱均可在画布内点击打开和关闭 |
| 布局矩阵 | 320×568、390×844、844×390、981×600、1024×600、1120×720、1280×720、1920×1080 全部通过 |

每个视口检查页面宽高等于视口宽高、三个入口均位于 Canvas 内、常用按钮完整可见且至少 44px、表情占用一行。手机表情仍允许横向滑动。浏览器视口测试不构成手机实机触摸验收。

本地截图：`local_artifacts/board-sizing-20261013/toolbar-refined-desktop.jpg`。
原始浏览器观测：`local_artifacts/board-sizing-20261013/toolbar-refinement-layouts.json`；连续切换视口的即时采样与最后稳定的 1280×720 观测分别保留。
