import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(root, '../..');
const target = process.argv[2];
if (!target) throw new Error('Usage: node tools/verify.mjs <receipt-directory> [python-executable]');
const destination = path.resolve(root, target); await fs.mkdir(destination, { recursive: true });
const sha = data => createHash('sha256').update(data).digest('hex');
const checks = [];
async function run(label, command, args, cwd = root, timeout = 240000) {
  console.log(`VERIFY ${label}`);
  const startedAt = new Date().toISOString(), start = Date.now();
  const child = spawn(command, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', timedOut = false;
  child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; });
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
  const exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); }); clearTimeout(timer);
  const summary = output.split(/\r?\n/).filter(line => /^# (tests|pass|fail|duration)|passed|PASS|checks passed|verified/i.test(line)).slice(-8);
  checks.push({ label, command: [command, ...args], cwd: path.relative(repo, cwd).split(path.sep).join('/'), startedAt,
    elapsedMs: Date.now() - start, exitCode, timedOut, outputSha256: sha(output), summary });
  console.log(`${label}: ${exitCode === 0 ? 'PASS' : 'FAIL'} (${Date.now() - start} ms)`);
  if (exitCode !== 0) console.log(output.slice(-12000));
  return exitCode === 0;
}
await run('minigame-build', process.execPath, ['tools/build.mjs']);
const tests = (await fs.readdir(path.join(root, 'tests'))).filter(n => n.endsWith('.test.mjs')).sort().map(n => `tests/${n}`);
await run('minigame-regressions', process.execPath, ['--test', '--test-timeout=180000', ...tests]);
for (const name of ['territory-v2', 'territory-v3', 'replay-codec', 'local-game-session', 'tutorial']) {
  await run(`web-${name}`, process.execPath, ['--unhandled-rejections=strict', `web/web前端/tests/verify-${name}.mjs`], repo);
}
if (process.argv[3]) await run('backend-and-real-transport-clients', path.resolve(root, process.argv[3]), ['-m', 'pytest', 'web/tests', '-q'], repo, 300000);
await run('desktop-compute-sample', process.execPath, ['tools/measure-compute.mjs', path.join(destination, 'desktop-compute.json')], root, 60000);
const manifest = JSON.parse(await fs.readFile(path.join(root, 'dist/build-manifest.json'), 'utf8'));
await fs.copyFile(path.join(root, 'dist/build-manifest.json'), path.join(destination, 'build-manifest.json'));
const sourceHashes = {};
for (const directory of ['src', 'tests', 'tools', 'preview']) {
  for (const name of await fs.readdir(path.join(root, directory), { recursive: true })) {
    if (directory === 'preview' && (name === 'generated' || name.startsWith(`generated${path.sep}`) || name.startsWith('generated/'))) continue;
    const file = path.join(root, directory, name);
    if ((await fs.stat(file)).isFile()) sourceHashes[`wechat/minigame/${directory}/${name.split(path.sep).join('/')}`] = sha(await fs.readFile(file));
  }
}
for (const name of ['web/web后端/wechat_online.py', 'web/web后端/server.py', 'web/web后端/requirements.txt',
  'web/tests/test_wechat_online.py', 'web/tests/test_wechat_client_e2e.py', 'web/tests/test_wechat_legacy_integration.py', 'web/tests/wechat_fixture_server.py',
  'web/tests/test_wechat_service_recovery.py', 'wechat/tools/maintain_store.py',
  'wechat/minigame/package.json', 'wechat/minigame/package-lock.json', 'wechat/minigame/project.config.json', 'wechat/minigame/game.json']) sourceHashes[name] = sha(await fs.readFile(path.join(repo, name)));
const success = checks.every(c => c.exitCode === 0 && !c.timedOut);
await fs.writeFile(path.join(destination, 'validation.json'), JSON.stringify({ schemaVersion: 1,
  status: success ? 'PASS_LOCAL_NOT_WECHAT_VERIFIED' : 'LOCAL_CHECKS_FAILED', finishedAt: new Date().toISOString(), node: process.version,
  rulesVersion: manifest.rulesVersion, packageBytes: manifest.totalBytes, checks, sourceHashes,
  notVerified: ['WeChat developer tools', 'real AppID login', 'allowlisted HTTPS/WSS', 'Android and iPhone devices', 'platform filing/review/publication'] }, null, 2) + '\n');
if (!success) process.exitCode = 1;
