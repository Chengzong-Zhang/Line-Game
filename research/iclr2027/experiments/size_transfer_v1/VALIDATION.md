# 初稿验证记录

验证时间：2026-09-22 14:03（Asia/Shanghai）。状态：`DRAFT_COMPATIBILITY_VALIDATED`。

环境：Windows、Python 3.10.20、PyTorch 2.7.1+cu118；本轮验证设备为 CPU。

| 检查 | 结果 | 证据边界 |
|---|---|---|
| 新迁移/计划测试 | 8/8 通过 | 包含合成小模型的权重迁移、状态重置、严格恢复、配置/哈希拒绝、不覆盖输出、计划预算和推理 |
| 既有训练器恢复回归 | 1/1 通过 | 合成经验的下一次更新与完整状态恢复一致 |
| 既有模型家族回归 | 5/5 通过 | 混合尺寸 batch、PASS/mask、表示隔离、padding、参数预算 |
| 真实 Padded-CNN 源权重 | 44/44 局面推理通过 | 5–15、两起始玩家、初始及一步后局面 |
| 真实 Grid-GNN 源权重 | 44/44 局面推理通过 | 同上 |
| 真实 Topology-GNN 源权重 | 44/44 局面推理通过 | 同上 |
| 真实 Topology-GNN 初始化和严格恢复 | 通过 | 新权重逐张量等于源；新优化器/经验池为空；计数为 0 |
| 计划生成 | 27 个阶段任务 | B/C/D × 3 增量种子 × 3 阶段，共 1,728 次局数尝试上限 |

合并测试共 14 项，退出码 0；真实权重检查和初始化/恢复脚本退出码 0。临时计划、初始化模型及 checkpoint 在临时目录中验证后清理，未写入旧实验目录。没有执行科研自对弈训练或完整棋力对局；既有回归测试中的微型梯度更新只属于测试。

机器可读来源和实现哈希见 [validation_receipt.json](validation_receipt.json)。`script_sha256` 和 `tests_sha256` 对应此次验证文件；`training_source_hash` 对应此次仓库中的训练源文件集合，其他任务后续修改可能使其变化，应重新验证而不是禁用检查。

合并测试复现命令（PowerShell，在仓库根目录执行）：

```powershell
Set-Location 'C:\coding\py\line game'
@'
import sys, unittest
from pathlib import Path
root = Path('research/iclr2027').resolve()
sys.path.insert(0, str(root))
suite = unittest.TestSuite()
for pattern in ('test_size_transfer_draft.py', 'test_alphazero_trainer.py', 'test_alphazero_model_families.py'):
    suite.addTests(unittest.defaultTestLoader.discover(str(root / 'tests'), pattern=pattern))
result = unittest.TextTestRunner(verbosity=2).run(suite)
sys.exit(not result.wasSuccessful())
'@ | & 'C:\Users\zcz\anaconda3\envs\rl310\python.exe' -
```

三种真实权重推理复现命令：

```powershell
Set-Location 'C:\coding\py\line game'
@'
import json, runpy, torch
torch.set_num_threads(1)
draft = runpy.run_path('research/iclr2027/scripts/size_transfer_draft.py')
sources = runpy.run_path('research/iclr2027/scripts/export_web_research_models.py')['MODELS']
for source in sources:
    report = draft['probe'](source['checkpoint'], source['checkpoint_sha256'])
    print(json.dumps({'model': source['model_kind'], 'status': report['status'],
                      'positions': len(report['positions']), 'strength_evaluated': False}))
'@ | & 'C:\Users\zcz\anaconda3\envs\rl310\python.exe' -
```

尚未验证：长跑监督、硬中断后的逐单元恢复、CUDA 恢复一致性、规则跨引擎一致性、全尺寸对战棋力、节省算力比例、正式统计功效。下一位 AI 必须先完成 [实验方案](EXPERIMENT_PLAN.md) 的工程与规则门槛；本记录不是长期训练启动许可或棋力验收。
