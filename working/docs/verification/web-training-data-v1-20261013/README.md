# 网页自愿棋谱贡献与精选训练

本次实现玩家自愿开启、完整本地对局自动贡献的入口，手机和电脑使用相同协议。默认关闭；不采集账号、聊天、房间号、设备标识或 IP。基础设施访问日志不属于棋谱数据集。关闭后取消请求、清空本机待上传队列；此前已收到的棋谱继续保留。采集本身不改变线上模型。

棋谱保留规则版本、尺寸、先手、完整动作链与历史约束。手机断网时保留最多 5 局完整记录，刷新或重新联网后重试；服务器以实际动作序列去重，使用 SQLite 事务持久保存，接收后状态为 awaiting_review。账号系统和原有数据库不参与这套存储。

服务器必须重新执行 Web GameEngine，检查当前行动方、合法步、PASS、哈希链、动作效果和终局分数；浏览器声称的赢家不能作为权威。单局上限 512 动作 / 512000 字节，校验超时 20 秒，每实例并发 2、每分钟 12 次提交，数据正文上限 256 MiB。达到上限拒收，不删除既有数据。接口默认关闭，部署时需显式设置 LIFELINE_CONTRIBUTIONS_DIR；原始棋谱与 SQLite 不进入 Git，也不在静态目录内。

精选使用明确的 human-review-v1 审核记录和 game_id；合法、完整并不代表高水平，击败弱 AI 也不自动精选。v1 自动排除少于 8 个落子、三人局、非 territory-v2、提示辅助、读秒自动跳过、中途切换角色/AI/计时设置或来源不明的棋局。中途开启贡献或刷新后无法追溯角色的棋局保留为 mixedProfiles，不能精选。AI 角色是客户端声明，审核要检查来源；只学习审核通过的人类 move/PASS，保留双方胜负作为网页规则下的价值标签，不模仿旧 AI 动作或认输动作。不能仅依据赢家筛掉所有输棋方。

训练/验证按完整动作序列的稳定 game_id 分组，重复棋谱不会跨组。特征、11 通道顺序、row-major 编号、三类邻接、历史驱动 legal mask、最后一个 PASS 都由 Web 引擎生成；Python 只训练张量，不用研究环境重算胜负。两个既知 Python/Web 终局分差仍存在，本次未修正旧冻结实验。

离线操作示例（目录均是本地原始数据，不提交）：

```powershell
python web/web后端/training_contributions.py --inbox local_artifacts/web-training-inbox --export local_artifacts/web-training-export-v1
node web/tools/curate_web_replays.mjs local_artifacts/web-training-export-v1 local_artifacts/reviews-v1.json local_artifacts/web-training-dataset-v1
python research/iclr2027/scripts/train_reviewed_web.py --dataset local_artifacts/web-training-dataset-v1 --base-manifest web/web前端/assets/research-ai/transfer-v1/manifest.json --base-id topology-gnn-transfer-v1-seed2026092201 --output local_artifacts/web-human-v1-candidate --id web-human-v1-candidate --steps 20
```

reviews-v1.json 的格式为 `{"policy":"human-review-v1","approved_game_ids":["完整64位game_id"]}`。训练要求实际存在且整局分离的训练/验证样本，不以空验证集继续。

训练器是有界候选生成器：每次最多 100 次更新，训练循环最多 60 秒，每次更新保存模型、optimizer、RNG、计数器和 SHA-256 索引；相同参数加 --resume 从已验证进度恢复。数据、来源、基础权重或配置不匹配即停止。它不是后台长期训练服务，未启动任何长期任务；长任务仍须另行满足 AGENTS.md 的监督、自动恢复、预算和中断演练要求。

候选有新的 ID、F32、manifest、父模型来源、网页精选数据哈希与实际微调尺寸；不覆盖旧 checkpoint、模型或冻结协议。工程验证使用 20 局明确的 synthetic fixture：16 局训练、4 局验证、114 个人类角色测试动作。这些不是实际玩家数据，更不是棋力证据。三个训练更新用于 smoke；中断/恢复应与干净运行得到相同 F32。

上线采集、数据精选、候选训练、独立棋力评估及模型替换是不同状态。只有匹配网页规则、先后手平衡、固定对手/搜索预算且独立保留的评估显示改进后，才可建议替换线上模型。本次未声称任何胜率提升，也不自动发布候选。

生产部署采用独立 systemd 采集服务，回环端口 8005，仅由 Nginx 的 /api/training/ 路径转发；原对局服务保持运行。Node 22 从官方发行源单独下载并校验，限制在本版本目录，不修改系统包。服务崩溃后有界自动重启，开机启动；数据在 /home/ubuntu/line-game-data/training-contributions-v1，不在网页公开路径。前端原子切换，完整旧前端和 Nginx 配置分别保留供回滚。最终上线状态与公网校验由 deployment.json 另行记录。
