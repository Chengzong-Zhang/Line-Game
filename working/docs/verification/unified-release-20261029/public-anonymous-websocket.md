# 公网匿名 legacy WebSocket 验证

2026-10-29 23:48（北京时间），不带令牌直接连接 `wss://lifelinegame.cn/ws`，服务端在握手阶段返回 HTTP 403。使用禁用代理的 curl 对 `https://lifelinegame.cn/api/health` 请求得到 HTTP 200；健康检查不代表联机功能通过。

发布候选源码中，`/ws` 在接受连接前要求有效令牌；`/api/login` 在账号密码验证成功后签发令牌。前后端检索未发现正式的匿名联机令牌入口。匿名棋谱贡献功能不提供联机令牌。

因此，没有创建房间，也没有执行第二客户端加入、开局、动作或 PASS、状态同步、断线重连及退出验证。此次匿名联机验收未完成；需要合法的游客入口或另行授权的登录方式才能继续。未创建账号或密码，未访问其他房间或用户数据。

具体观察和分项状态见 `public-anonymous-websocket.json`。握手使用 Python websockets 15.0.1，禁用代理、连接超时 15 秒；健康检查使用 `curl.exe --noproxy '*' -sS -o NUL -w '%{http_code}' --connect-timeout 15 --max-time 20 https://lifelinegame.cn/api/health`。
