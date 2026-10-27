// Explicit, loopback-only browser fixture. Never imported by the game bundle.
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function startFixture(repo, python) {
  const reserved = createServer();
  reserved.listen(0, '127.0.0.1'); await once(reserved, 'listening');
  const port = reserved.address().port;
  await new Promise(resolve => reserved.close(resolve));
  const parent = path.join(repo, 'local_artifacts', 'wechat-browser-fixture');
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'run-'));
  const child = spawn(python, [path.join(repo, 'web/tests/wechat_fixture_server.py'), String(port), path.join(directory, 'fixture.sqlite3')],
    { cwd: repo, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let error = '', stopped = false;
  child.stderr.on('data', chunk => { error = (error + chunk).slice(-2000); });
  child.on('error', exception => { error = exception.message; });
  const stop = () => { if (!stopped) { stopped = true; child.kill(); } };
  // Covers Ctrl+C, server startup failure, and ordinary process exit.
  process.once('exit', stop);
  const origin = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      if (child.exitCode !== null || child.signalCode || !child.pid) throw new Error(error || 'Fixture exited');
      try {
        const response = await fetch(`${origin}/api/wechat/status`, { signal: AbortSignal.timeout(500) });
        if (response.ok && (await response.json()).enabled) { ready = true; break; }
      } catch (_) { /* Wait for this fixture to bind. */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error('Loopback fixture startup timed out');
    return { origin, directory, stop };
  } catch (exception) { stop(); throw exception; }
}

export function proxyFixtureHttp(origin, request, response) {
  // Only the caller's allowlisted /api/wechat path reaches this function.
  const upstream = httpRequest(new URL(request.url, origin), {
    method: request.method,
    headers: { 'content-type': 'application/json', ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}) },
    timeout: 22000,
  }, result => {
    response.writeHead(result.statusCode, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    result.pipe(response);
  });
  upstream.on('timeout', () => upstream.destroy());
  upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
  request.on('aborted', () => upstream.destroy());
  request.pipe(upstream);
}

export function proxyFixtureSocket(origin, request, socket, head) {
  const upstream = httpRequest(new URL('/api/wechat/ws', origin), { headers: {
    connection: 'Upgrade', upgrade: 'websocket',
    'sec-websocket-key': request.headers['sec-websocket-key'], 'sec-websocket-version': '13',
  } });
  const close = () => { upstream.destroy(); socket.destroy(); };
  upstream.on('error', close); socket.on('error', close);
  upstream.on('response', close);
  upstream.on('upgrade', (response, peer, remaining) => {
    const headers = Object.entries(response.headers).map(([key, value]) => `${key}: ${value}`).join('\r\n');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${headers}\r\n\r\n`);
    if (remaining.length) socket.write(remaining);
    if (head.length) peer.write(head);
    socket.pipe(peer); peer.pipe(socket);
    peer.on('error', () => socket.destroy());
    socket.on('close', () => peer.destroy()); peer.on('close', () => socket.destroy());
  });
  upstream.end();
}
