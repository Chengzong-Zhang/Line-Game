# 六边形对局的 AI 席位

日期：2026-10-21。范围：本地工作区 Web 功能；未提交、未推送、未部署。此文接续 [4–6 人棋盘](LIFELINE_HEX_BOARD_20261020.md)，不修改原三人模型及其训练收据。

## 玩家体验与模型边界

4/5/6 人正六边形对局中，每个本地席位可独立选择真人或六边形 AI，可设置一个或多个 AI 对手。尺寸仍为每边 5–15 个格点，出生顶点和游戏规则不变。六边形 AI 使用 `hex-player` 策略、`hex-player-policy-v1` 模型；三人模式使用独立的三人模型及版本注册表，双人和三人模型不作为六边形策略使用。

本地存档保留各席位、已开始/暂停状态及动作历史；旧真人六边形存档继续可读。恢复六边形存档时，仅接受真人或 `hex-player` 席位；拒绝双人/三人策略和含六边形 AI 的 `territory-v1` 存档。六边形完整棋谱仍可导出和复盘，但不进入现有三角棋盘训练贡献队列。

模型加载和棋力结论分开判断：能够加载并合法落子不证明比旧模型或真人更强。训练方法、样本与评价结果以本次新模型的独立收据为准。

## 账号房间契约

3–6 人房间可设置 0 到“人数减一”个 AI，至少保留一名真人。双人房间不启用这些 AI 席位；含 AI 的房间使用 `territory-v2`。AI 自动准备，所有真人准备并在线后才开始倒计时。每次顺序执行一个行动方；轮到真人时停止自动行动。

含 AI 的房间由后端从完整已接受动作日志重建 Web 规则状态，再校验真人动作或生成 AI 动作，保留 Superko 历史。真人身份来自经过认证的 WebSocket 席位，客户端提交的颜色或玩家编号不能替换该身份；AI 席位不能被真人冒领，非房主不能修改 AI 数量，修改配置不能挤掉现有真人。

房间重开、设置变更和断线使旧任务失效；断线会取消当前计算，重连保留完整已接受历史。重开重新准备 AI，旧局的结果或错误不得覆盖新局。替换登录连接后，旧连接正在等待校验的动作也不能提交。

单次 Node 计算限制为 15 秒，运行进程异常最多尝试 3 次；重试从同一已接受历史重建，不重复提交已接受动作。配置或历史损坏直接失败，不按进程异常反复重试。模型加载失败时返回规则引擎的一个合法动作作为降级，并标记 `aiFallback`；这不是训练模型成功运行的证据。普通全真人房间继续沿用原转发协议。

## 验证入口

| 命令 | 验证内容 |
| --- | --- |
| `node --unhandled-rejections=strict "web/web前端/tests/verify-hex-ai-persistence.mjs"` | 4/5/6 人一个/多个 AI、暂停与动作恢复、旧真人存档、错误策略拒绝 |
| `node --unhandled-rejections=strict "web/web前端/tests/verify-hex-online-bot-bridge.mjs"` | 各人数一个/多个训练模型席位、完整历史、降级合法性、身份与配置拒绝 |
| `python -m unittest discover -s web/tests -p test_hex_online_bots.py -v` | 4/5/6 人房间矩阵、认证 WebSocket 一人对五 AI、准备/顺序执行、断线/重连、重开/过期请求、冒领与修改席位拒绝 |
| `python -m unittest discover -s web/tests -p test_online_bots.py -v` | 原三人 AI 房间、有限恢复和中断回归 |
| `node --unhandled-rejections=strict "web/web前端/tests/verify-online-bot-node-crypto.mjs"` | 模拟缺少全局 Web Crypto 的 Node 配置，补入 `node:crypto.webcrypto`，验证 SHA-256 与真实六边形模型落子 |

当前记录：存档脚本、4/5/6 人真实训练模型桥接、完整六边形 AI 房间 7 项测试均通过，正常模型动作明确断言 `fallback=false`；包含经认证的本地 FastAPI WebSocket 一人对五 AI，每个 AI 顺序落子。旧三人桥接、六边形真人房间 3 项回归及三人 AI 房间 13 项回归已通过。服务器测试使用本地 FastAPI 与 Node，不代表生产部署或真实远程多客户端验收。浏览器交互验收由主任务另行记录。

最终模型按产品的全合法候选范围训练完成后，已重新执行模型桥接和全部 7 项六边形 AI 房间测试，均退出 0；后端测试耗时 15.552 秒。本次接通验证绑定 `assets/research-ai/hex-player-policy-v1.json`，文件 SHA-256 为 `74aa7f945c3ea7ff5ca3edc9e7bdc431dc0ec5ad56d2563ce6d6d24c0494162b`。该哈希绑定模型文件及本次接通结果，不代替独立棋力评价。
