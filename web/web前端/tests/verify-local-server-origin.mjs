import assert from "node:assert/strict";
import { resolveWebSocketUrl } from "../NetworkManager.js";

for (const port of [8000, 8004, 8012, 8013]) {
  assert.equal(resolveWebSocketUrl(new URL(`http://127.0.0.1:${port}/`)), `ws://127.0.0.1:${port}/ws`);
}
assert.equal(resolveWebSocketUrl(new URL("https://lifelinegame.cn/")), "wss://lifelinegame.cn/ws");
assert.equal(resolveWebSocketUrl(new URL("http://[::1]:8012/")), "ws://[::1]:8012/ws");
assert.equal(resolveWebSocketUrl(null), "ws://localhost:8000/ws");
console.log("verify-local-server-origin: PASS (same-origin local ports, IPv6 and production HTTPS)");
