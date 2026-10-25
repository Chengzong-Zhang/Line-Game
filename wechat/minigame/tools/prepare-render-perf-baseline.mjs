// Freeze the currently checked-out (including dirty) implementation BEFORE edits.
// Never overwrite an earlier baseline or use HEAD as a substitute for dirty code.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(root, '../..'), output = path.resolve(process.argv[2] || '');
if (!process.argv[2]) throw Error('Usage: node tools/prepare-render-perf-baseline.mjs <new output directory>');
await fs.mkdir(output, { recursive: false });
const files = ['board', 'scheduler', 'session', 'app', 'platform', 'worker-runtime', 'core'].map(name => `wechat/minigame/src/${name}.js`);
files.push('web/web前端/GameEngine.js');
const hashes = [];
for (const name of files) {
  const data = await fs.readFile(path.join(repo, name)), target = path.join(output, name);
  await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, data);
  hashes.push({ path: name, sha256: createHash('sha256').update(data).digest('hex') });
}
const common = { bundle: true, platform: 'node', write: false, format: 'esm', loader: { '.md': 'text' },
  define: { 'import.meta.url': 'undefined' }, plugins: [{ name: 'query', setup(b) {
    b.onResolve({ filter: /\?v=/ }, a => ({ path: path.resolve(a.resolveDir, a.path.split('?')[0]) }));
  } }] };
for (const name of ['board', 'scheduler', 'session']) {
  const result = await build({ ...common, entryPoints: [path.join(root, `src/${name}.js`)] });
  await fs.writeFile(path.join(output, `${name}.mjs`), result.outputFiles[0].text);
}
const worker = await build({ ...common, format: 'iife', entryPoints: [path.join(root, 'src/workers/index.js')] });
await fs.writeFile(path.join(output, 'worker.js'), worker.outputFiles[0].text);
await fs.writeFile(path.join(output, 'source-hashes.json'), JSON.stringify(hashes, null, 2));
console.log(JSON.stringify({ status: 'BASELINE_FROZEN', output, files: hashes.length }));
