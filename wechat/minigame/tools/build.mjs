import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readClientConfig, validateClientConfig } from './client-config.mjs';
import { nativeWebCompatibility } from './web-compat.mjs';
import { MODEL_CATALOG, MODEL_PACKAGES, GUIDE_ASSETS, RUNTIME_FILES, SUBPACKAGE_ENTRY,
  MAIN_BUDGET, SUBPACKAGE_BUDGET, TOTAL_BUDGET } from './model-packaging.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(root, '../..');
export async function buildGame(output = path.join(root, 'dist'), { config: override } = {}) {
  const config = override === undefined ? (await readClientConfig(root)).config : validateClientConfig(override);
  await fs.mkdir(output, { recursive: true });
  const sources = new Set();
  const compatibility = await nativeWebCompatibility(repo, sources);
  const plugin = { name: 'web-cache-imports', setup(ctx) {
    ctx.onResolve({ filter: /\?v=/ }, (args) => ({ path: path.resolve(args.resolveDir, args.path.split('?')[0]) }));
  }};
  const common = { bundle: true, platform: 'browser', target: 'es2018', format: 'iife', charset: 'utf8',
    minify: true, plugins: [plugin, compatibility.plugin], loader: { '.md': 'text' }, metafile: true, logLevel: 'warning', legalComments: 'eof',
    // Only pure inference exports are used. Browser fetch loaders are removed
    // by tree shaking; the native IIFE has no import.meta/module URL.
    define: { __APP_CONFIG__: JSON.stringify(config), 'import.meta.url': 'undefined' } };
  for (const [entry, dest] of [['src/game.js', 'game.js'], ['src/workers/index.js', 'workers/index.js']]) {
    const result = await build({ ...common, absWorkingDir: root, entryPoints: [entry], outfile: path.join(output, dest) });
    for (const input of Object.keys(result.metafile.inputs)) {
      if (!input.startsWith('<')) sources.add(path.resolve(root, input));
    }
  }
  await fs.copyFile(path.join(root, 'game.json'), path.join(output, 'game.json'));
  await fs.copyFile(path.join(root, 'THIRD_PARTY_NOTICES.txt'), path.join(output, 'THIRD_PARTY_NOTICES.txt'));
  sources.add(path.join(root, 'THIRD_PARTY_NOTICES.txt'));
  for (const asset of GUIDE_ASSETS) {
    const source = path.join(repo, 'web/web前端/guide/guide-images', asset.source);
    await fs.mkdir(path.dirname(path.join(output, asset.path)), { recursive: true });
    await fs.copyFile(source, path.join(output, asset.path));
    sources.add(source);
  }
  const game = JSON.parse(await fs.readFile(path.join(root, 'game.json'), 'utf8'));
  if (JSON.stringify(game.subpackages) !== JSON.stringify(MODEL_PACKAGES)) throw new Error('Model subpackage configuration mismatch');
  for (const pack of MODEL_PACKAGES) {
    await fs.mkdir(path.join(output, pack.root), { recursive: true });
    await fs.writeFile(path.join(output, pack.root, 'game.js'), SUBPACKAGE_ENTRY);
  }
  for (const model of MODEL_CATALOG) {
    const source = path.join(root, model.sourcePath);
    let data;
    try { data = await fs.readFile(source); }
    catch (error) { if (error.code !== 'ENOENT') throw error; throw new Error(`Missing staged Web model ${model.id}; run tools/stage-models.mjs with the Web asset directory`); }
    if (data.length !== model.bytes || createHash('sha256').update(data).digest('hex') !== model.spec.asset_sha256) {
      throw new Error(`Model integrity failure: ${model.id}`);
    }
    await fs.writeFile(path.join(output, model.assetPath), data); sources.add(source);
  }
  const files = RUNTIME_FILES;
  const outputs = await Promise.all(files.map(async (name) => {
    const data = await fs.readFile(path.join(output, name));
    return { path: name, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
  }));
  const manifest = { schemaVersion: 2, rulesVersion: 'territory-v3', config, outputs, sourceHashes: {},
    nativeCompatibility: Object.fromEntries(Object.entries(compatibility.records).sort(([left], [right]) => left.localeCompare(right))) };
  for (const source of [...sources].sort()) {
    const relative = path.relative(repo, source).split(path.sep).join('/');
    manifest.sourceHashes[relative] = createHash('sha256').update(await fs.readFile(source)).digest('hex');
  }
  manifest.runtimeBytes = outputs.reduce((sum, item) => sum + item.bytes, 0);
  manifest.subpackages = MODEL_PACKAGES.map(pack => ({ ...pack,
    bytes: outputs.filter(item => item.path.startsWith(`${pack.root}/`)).reduce((sum, item) => sum + item.bytes, 0) }));
  const mainRuntimeBytes = outputs.filter(item => !item.path.startsWith('models/')).reduce((sum, item) => sum + item.bytes, 0);
  manifest.totalBytes = manifest.runtimeBytes;
  manifest.mainPackageBytes = mainRuntimeBytes;
  for (let i = 0; i < 5; i++) {
    const bytes = Buffer.byteLength(`${JSON.stringify(manifest, null, 2)}\n`);
    manifest.totalBytes = manifest.runtimeBytes + bytes; manifest.mainPackageBytes = mainRuntimeBytes + bytes;
  }
  if (manifest.mainPackageBytes > MAIN_BUDGET || manifest.totalBytes > TOTAL_BUDGET
    || manifest.subpackages.some(pack => pack.bytes > SUBPACKAGE_BUDGET)) throw new Error('Project package budget exceeded');
  await fs.writeFile(path.join(output, 'build-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const file of await fs.readdir(output, { recursive: true, withFileTypes: true })) {
    if (!file.isFile()) continue;
    const relative = path.relative(output, path.join(file.parentPath, file.name)).split(path.sep).join('/');
    if (![...files, 'build-manifest.json'].includes(relative)) throw new Error(`Unexpected packaged file: ${relative}`);
  }
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = await buildGame();
  console.log(JSON.stringify({ status: 'BUILT_NOT_WECHAT_VERIFIED', bytes: manifest.totalBytes, files: manifest.outputs }, null, 2));
}
