# 三个舱入口图标与落子提示 — 2026-10-13

最终状态：`DEPLOYED_PUBLIC_VERIFIED`。图标放大与删除普通落子成功提示已上线 G 版本；本地交互、六组模拟视口、8 项公网资源和服务健康检查均为 `PASS-CURRENT`。手机实机触摸仍未验收。

## 修改范围

- 棋盘舱、联机舱、指南舱图标容器：电脑 28→40px，手机 20→32px；实际图案统一为电脑 28px、手机 26px。
- 合法普通落子的反馈返回空字符串，不再显示“落子已接受（坐标）”；成功动作会清除旧误点提示。非法落子、误点、网络失败、跳过和认输反馈保留。
- 发布资源版本为 `20261013g`。发布包基于已上线 F 的独立完整候选，只覆盖 `index.html`、`main.js`、`OnlineApp.js`、`styles.css` 四项，保留五关教学、训练贡献功能、规则与模型资源。
- 分支为 `codex/territory-v2-page-correctness`，工作区包含其他未提交工作，本次不混合提交或推送。

## 本次验证

- 真实浏览器在隔离本地预览 `http://127.0.0.1:8780/` 实际落子：行动方从蓝方变为红方，页面不含“落子已接受”，没有成功反馈段落。误点画布空白处仍显示“请点击棋盘上的节点”；下一次合法红方落子后提示清除，行动方再次切换。
- 1280×720、981×720、390×844、320×568、844×390、568×320 共六组视口：页面没有宽高溢出，三个入口完整位于画布边界内；电脑按钮 58px 高、手机按钮 48px 高。三个入口在手机视口均实际打开并关闭。
- 图标尺寸与实际图案尺寸均从 DOM 记录，手机预览贡献开关仍默认关闭。检查结束后临时视口覆盖已重置。
- 初次连续切换视口时保存的 `preview-390.jpg` 是绘制尚未稳定的截屏，不作为手机视觉通过证据；稳定截图另存 `preview-mobile-390-stable.jpg`，真实完整画面已查看。
- 合并候选执行 `node --check .../frontend/OnlineApp.js`、`node --unhandled-rejections=strict .../frontend/tests/verify-board-input.mjs`、`node --unhandled-rejections=strict .../frontend/tests/verify-tutorial.mjs`，退出 0。`git diff --check` 通过。浏览器模拟视口不等于手机实机触摸验收。
- `python local_artifacts/board-icons-release-20261013/verify_public.py before` 退出 0：当前 F 的 8 项公网 SHA-256 匹配且游戏健康接口正常。

清单、包哈希、六组布局和反馈原始记录见 [紧凑验证证据](verification/board-icons-feedback-20261013/release-manifest.json)。本地截图与候选在 `local_artifacts/board-icons-release-20261013/`。

## 发布准备

发布身份：`web-board-icons-feedback-20261013`；压缩包 SHA-256：`b89862c4a3a2c112a54582744c6350901c3d4dcb39e166051e1bf3e4daa1675a`，60073 字节。

原子切换沿用现有部署机制，并在锁内检查整个生产目录必须仍与 F 的已核验整树哈希一致，防止覆盖并行更新。保留前端回滚目录，原游戏服务不重启。部署脚本已完成 Python 编译与 PowerShell 语法检查。

发布前默认 SSH 无可用认证，上一轮临时授权已撤回。使用可见的 SSH 密码登录窗口输入已有服务器密码，随后发送更新包、校验和原子发布自动完成。本次未新建 SSH 密钥，未在聊天或工件中索取、保存密码。

## 发布完成

2026-10-13 13:58:30（Asia/Shanghai）原子切换返回 `ATOMIC_SWITCH_OK`，SSH 退出 0。上线后 `python local_artifacts/board-icons-release-20261013/verify_public.py after` 退出 0：四个更新文件及四个保留依赖共 8 项公网 SHA-256 全部匹配 G 候选，健康接口正常。

- 活目录整树 SHA-256：`e62b6bbe500f7379746e922b6f7bbee600b55c8d01ec2bb26da300825c76dd99`。
- 回滚目录：`/home/ubuntu/line-game/.deploy-artifacts/web-board-icons-feedback-20261013.rollback-web前端`，保留已验收 F。
- 正式网站刷新后正常显示三个放大的图标，用户既有棋局和术语偏好仍保留；没有为线上验收重置用户棋局或替用户追加落子。
- 线上截图：`local_artifacts/board-icons-release-20261013/production-desktop.jpg`。激活、SSH 退出及公网核验收据已保存到对应紧凑证据目录。首次控制台中文路径出现编码问题，使用同一 Windows 编码的可逆转换恢复并核对固定回滚路径，原始输出保留。

回滚命令：`python3 /home/ubuntu/line-game/.deploy-artifacts/web-board-icons-feedback-20261013.atomic.py rollback --release-id web-board-icons-feedback-20261013`。本次未执行回滚、未重启原游戏服务、未改动研究任务或其他用户工作。
