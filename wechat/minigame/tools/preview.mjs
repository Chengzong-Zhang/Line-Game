import { build } from 'esbuild';
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixture, proxyFixtureHttp, proxyFixtureSocket } from './preview-fixture.mjs';
import { MODEL_CATALOG } from '../src/model-catalog.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length > 1 || args.some(arg => !['--online-fixture', '--build-only'].includes(arg))) throw new Error('Supported options: --online-fixture or --build-only');
await build({ absWorkingDir: root, entryPoints: ['src/app.js'], outfile: 'preview/generated/app.js', bundle: true,
  format: 'iife', globalName: 'Lifeline', platform: 'browser', loader: { '.md': 'text' }, target: 'es2018', plugins: [{ name: 'web-cache-imports', setup(ctx) {
    ctx.onResolve({ filter: /\?v=/ }, (args) => ({ path: path.resolve(args.resolveDir, args.path.split('?')[0]) }));
  } }] });
if (args.includes('--build-only')) process.exit(0);
const fixture = args.includes('--online-fixture')
  ? await startFixture(path.resolve(root, '../..'), process.env.LIFELINE_PREVIEW_PYTHON || path.resolve(root, '../../.venv/Scripts/python.exe')) : null;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json' };
const publicFiles = new Set(['/preview/index.html', '/preview/host.js', '/preview/online.js', '/preview/worker.js', '/preview/generated/app.js',
  '/dist/workers/index.js', '/dist/game.js', '/dist/game.json', ...MODEL_CATALOG.map(model => `/dist/${model.assetPath}`)]);
const port = Number(process.env.LIFELINE_PREVIEW_PORT || 8791);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid preview port');
const origin = `http://127.0.0.1:${port}`;
const trustedRequest = request => request.headers.host === `127.0.0.1:${port}`
  && (!request.headers.origin || request.headers.origin === origin)
  && !['cross-site'].includes(request.headers['sec-fetch-site']);
const server = createServer(async (request, response) => {
  try {
    if (!trustedRequest(request)) { response.writeHead(403); response.end('Local preview only'); return; }
    const url = new URL(request.url, origin);
    if (url.origin !== origin || !request.url.startsWith('/') || request.url.startsWith('//')) throw new Error('DENIED');
    if (url.pathname === '/preview/runtime.json' && request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ onlineFixture: Boolean(fixture) })); return;
    }
    if (fixture && url.pathname.startsWith('/api/wechat/') && ['GET', 'POST'].includes(request.method)) {
      proxyFixtureHttp(fixture.origin, request, response); return;
    }
    if (request.method !== 'GET') throw new Error('DENIED');
    const requested = url.pathname === '/' ? '/preview/index.html' : decodeURIComponent(url.pathname);
    if (!publicFiles.has(requested)) throw new Error('DENIED');
    const file = path.resolve(root, `.${requested}`);
    if (!file.startsWith(`${root}${path.sep}`)) throw new Error('DENIED');
    const bytes = await fs.readFile(file);
    response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); response.end(bytes);
  } catch (_) { response.writeHead(404); response.end('Not found'); }
});
server.on('upgrade', (request, socket, head) => {
  if (!fixture || !trustedRequest(request) || request.url !== '/api/wechat/ws') { socket.destroy(); return; }
  proxyFixtureSocket(fixture.origin, request, socket, head);
});
server.on('error', error => { fixture?.stop(); console.error(error.message); process.exit(1); });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { fixture?.stop(); server.close(); process.exit(0); });
server.listen(port, '127.0.0.1', () => {
  console.log(`Preview: ${origin}/ (browser UI only)`);
  if (fixture) console.log(`Isolated fixture: ${origin}/?player=blue and ${origin}/?player=red (fake WeChat identities, real loopback HTTP/WS; database kept under local_artifacts)`);
});
