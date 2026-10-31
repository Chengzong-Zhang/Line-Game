# 五关教学与单屏前端上线记录

发布状态：DEPLOYED_PUBLIC_HASH_VERIFIED。发布时间（Asia/Shanghai）：2026-10-13T13:28:18.571890+08:00。
网址：https://lifelinegame.cn/ 。静态资源版本：20261013f。
发布身份：web-tutorial-five-lessons-20261013。

本次为已授权的前端增量更新：蓝方/红方教学、目标点/边界/切断高亮、第四关三点限制、第五关结算与指南舱入口，以及电脑/手机单屏布局。未替换 AI 模型，未重启原游戏服务。

棋谱贡献功能由另一对话先行发布；本次以已上线 B 版本为共同基线，把该功能的 44 行应用代码三方合入本地 E 版本，并保留两条贡献开关样式。候选与活目录均核对 TrainingContribution.js 的既有 SHA-256，默认关闭的贡献入口在本地合并候选浏览器中可见。生产贡献接口仍返回 enabled=true 与 anonymous-replay-training-v1。

合并候选独立保存在 local_artifacts/tutorial-release-20261013/frontend-v2；主工作区的已有改动未覆盖。release-manifest.json 同时记录主工作区 Git 基线、dirty 状态、贡献功能父提交及 7 个覆盖文件；frontend-changes.patch 保存从贡献分支到发布版本的增量。没有提交或推送用户的其他工作。

本次验证：
- 合并候选 verify-tutorial.mjs、verify-board-input.mjs、verify-territory-v2.mjs 退出 0；协作对话另行验证合并候选 verify-replay-codec.mjs 退出 0。
- 本地合并候选在真实浏览器正常启动首关，显示正确蓝红文案/高亮和默认关闭的贡献开关。完整五关及三点拒绝→合法重试先前已经本地实测。
- 远端包哈希、7 个覆盖文件与保留贡献依赖全部匹配；prepare 完成后原子目录交换返回 ATOMIC_SWITCH_OK。
- 公网 8 个文件 SHA-256 全部匹配；游戏 /api/health 返回 ok，贡献 status 路由健康；第二对话独立复核同样通过。
- 公网界面完整操作验收未完成：Cua 的打开/读取/截图调用多次超时；第二对话读到正常网页 DOM，但尺寸与截图也超时。不能将公网文件/接口校验提升为线上五关、手机实机或完整读屏验收通过。

回滚版本：/home/ubuntu/line-game/.deploy-artifacts/web-tutorial-five-lessons-20261013.rollback-web前端。
服务器回滚命令（需正常 SSH 登录；脚本先验证当前版与回滚版整树哈希）：
```
python3 /home/ubuntu/line-game/.deploy-artifacts/web-tutorial-five-lessons-20261013.atomic.py rollback --release-id web-tutorial-five-lessons-20261013
```

未执行生产回滚；没有因客户端浏览器工具超时撤回已验证文件。现有临时 SSH 授权由创建它的棋谱贡献对话负责收尾，本次未创建新密钥、未扩大访问权限，也未修改或删除该对话的授权文件。

## 后续独立桌面截图

2026-10-13 13:38（Asia/Shanghai），协作对话通过直接截图取得1280×720的正式网站界面。画布内角落入口、窄回合栏和一行10个表情可见，已在本对话再次查看图片。
截图保存在 local_artifacts/layout-release-verify-20261013/production-desktop.jpg（本地忽略，不提交），SHA-256：
d06e8f573fd005de6362135db6d40472c6edd8e03fcd777379c8a4f06fce1f68
。
该截图证明线上桌面展示可见；线上逐关操作、手机实机与完整读屏仍未完成。
