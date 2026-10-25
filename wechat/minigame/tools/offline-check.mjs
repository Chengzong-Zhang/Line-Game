// Bounded, repeatable local acceptance. No AppID, login, Python service or profile needed.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gameRoot, startOfflineServer } from './offline-server.mjs';
import { runBrowserChecks } from './offline-browser-check.mjs';

const repo = path.resolve(gameRoot, '../..');
if (process.argv.slice(2).some(arg => arg !== '--browser-only')) throw new Error('Supported option: --browser-only');
const browserOnly = process.argv.includes('--browser-only');
const outputParent = path.join(repo, 'local_artifacts/wechat-offline-check');
await fs.mkdir(outputParent, { recursive: true });
const output = await fs.mkdtemp(path.join(outputParent, 'run-'));
const checks = [], startedAt = new Date().toISOString(), sha = value => createHash('sha256').update(value).digest('hex');
const report = { schemaVersion: 1, status: 'RUNNING', mode: browserOnly ? 'browser-only' : 'full', startedAt, node: process.version, rulesVersion: 'territory-v3', checks,
  output: path.relative(repo, output).split(path.sep).join('/'),
  notVerified: ['微信开发者工具编译', '真实微信登录与分享', '安卓与 iPhone 真机触摸和性能', '备案、审核与公开发布'] };
const receipt = path.join(output, 'result.json');
const persist = () => fs.writeFile(receipt, JSON.stringify(report, null, 2) + '\n');
await persist();
async function command(name, args, timeoutMs = 180000) {
  const start = Date.now(); let text = '', timedOut = false;
  const child = spawn(process.execPath, args, { cwd: gameRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { text = (text + chunk).slice(-250000); });
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
  const exitCode = await new Promise(resolve => { child.once('error', error => { text += error.message; resolve(-1); }); child.once('close', code => resolve(code ?? -1)); });
  clearTimeout(timer);
  const filename = `${name}.log`; await fs.writeFile(path.join(output, filename), text);
  const summary = text.split(/\r?\n/).filter(line => /tests |pass |fail |duration|✔|✖|# (tests|pass|fail)/.test(line)).slice(-8);
  checks.push({ name, status: exitCode === 0 && !timedOut ? 'PASS' : 'FAIL', command: ['node', ...args], exitCode, timedOut,
    elapsedMs: Date.now() - start, outputSha256: sha(text), summary });
  console.log(`${checks.at(-1).status}: ${name}`); await persist();
  if (exitCode !== 0 || timedOut) throw new Error(`${name} failed. ${text.slice(-5000)}`);
}
let server;
try {
  await command('build', ['tools/build.mjs']);
  const manifest = JSON.parse(await fs.readFile(path.join(gameRoot, 'dist/build-manifest.json'), 'utf8'));
  if (manifest.config.onlineEnabled) throw new Error('This check requires the offline build. Preserve config.local.json; use an isolated offline checkout.');
  report.build = manifest;
  const files = (await fs.readdir(path.join(gameRoot, 'tests'))).filter(name => name.endsWith('.test.mjs')).sort().map(name => `tests/${name}`);
  if (!browserOnly) await command('regressions', ['--test', '--test-timeout=180000', ...files], 240000);
  server = await startOfflineServer();
  report.browser = await runBrowserChecks({ origin: server.origin, output });
  report.status = report.browser.status.startsWith('PASS') ? (browserOnly ? 'PASS_BROWSER_ONLY_NOT_WECHAT_VERIFIED' : 'PASS_LOCAL_OFFLINE_NOT_WECHAT_VERIFIED') : 'FAILED';
} catch (error) { report.status = 'FAILED'; report.error = error.message; }
finally { if (server) await server.close(); }
report.finishedAt = new Date().toISOString();
report.sourceHashes = {};
for (const name of ['package.json', 'package-lock.json', 'preview/offline.html', 'preview/offline-host.js', 'preview/worker.js',
  'tools/offline-check.mjs', 'tools/offline-browser-check.mjs', 'tools/offline-server.mjs', 'tests/offline-host.test.mjs'])
  report.sourceHashes[`wechat/minigame/${name}`] = sha(await fs.readFile(path.join(gameRoot, name)));
await persist();
const escape = text => String(text ?? '').replace(/[&<>"']/g, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[value]));
const pass = report.status.startsWith('PASS');
const modeNote = browserOnly ? '本次只运行构建与浏览器检查，未重跑底层回归。' : '本次包含构建、底层回归和浏览器检查。';
const rows = `<li>${escape(modeNote)}</li>` + [...checks, ...(report.browser?.checks || [])].map(item => `<li class="${item.status === 'PASS' ? 'pass' : 'fail'}"><strong>${item.status === 'PASS' ? '通过' : '未通过'}</strong> ${escape(item.name)}${item.error ? `<p>${escape(item.error)}</p>` : ''}</li>`).join('');
const captures = (report.browser?.screenshots || []).map(item => `<a href="${escape(item.path)}"><img alt="${escape(item.path)}" src="${escape(item.path)}"></a>`).join('');
await fs.writeFile(path.join(output, 'report.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>生命线 · 免登录自测报告</title><style>body{font:16px system-ui;color:#244d3d;background:#f4f3e9;max-width:960px;margin:40px auto;padding:0 24px;line-height:1.7}h1{font-size:30px}li{list-style:none;padding:12px 16px;background:white;margin:8px 0;border-radius:10px}ul{padding:0}.pass strong{color:#22734b}.fail strong{color:#a73535}.shots{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px}img{width:100%;border:1px solid #dce2d3;border-radius:12px}.muted{color:#627661}code{overflow-wrap:anywhere}</style><h1>${pass ? '免登录自测已通过' : '免登录自测发现问题'}</h1><p>真实游戏构建包、Canvas 与后台计算线程；微信接口由本地测试环境模拟。</p><p class="muted">${escape(report.finishedAt)} · ${escape(report.browser?.browser?.channel || '')} ${escape(report.browser?.browser?.version || '')}</p>${report.error ? `<p>${escape(report.error)}</p>` : ''}<ul>${rows}</ul><p><a href="result.json">完整结果与源码哈希</a></p><h2>仍需微信环境验证</h2><p>${report.notVerified.map(escape).join('；')}。本报告不将浏览器测试等同于手机或微信验收。</p><h2>本次实际画面</h2><div class="shots">${captures}</div></html>`);
console.log(JSON.stringify({ status: report.status, report: path.join(output, 'report.html'), receipt, browserChecks: report.browser?.checks.length || 0 }, null, 2));
if (!pass) process.exitCode = 1;
