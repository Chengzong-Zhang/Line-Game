// Compare the minified native Worker against the pre-migration Web public
// loaders/inference, supplied as a preserved reference directory. No training,
// browser automation, upload, service or account is involved.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { MODEL_CATALOG } from '../src/model-catalog.js';
import { sut } from '../tests/helpers.mjs';

const [referenceDirectory, output] = process.argv.slice(2);
if (!path.isAbsolute(referenceDirectory || '') || !path.isAbsolute(output || '')) throw new Error('Absolute reference directory and output file required');
const root = fileURLToPath(new URL('../', import.meta.url)), repo = path.resolve(root, '../..');
const web = path.join(repo, 'web/web前端');
const referenceHashes = {};
const bundled = await build({ stdin: { contents: "export * from './ResearchAI.js'; export * from './ModelFreeAI.js';", resolveDir: web },
  bundle: true, format: 'esm', platform: 'node', write: false,
  define: { 'import.meta.url': JSON.stringify(pathToFileURL(path.join(web, 'model-reference.js')).href) },
  plugins: [{ name: 'reference-web', setup(ctx) {
    ctx.onResolve({ filter: /\?v=/ }, args => ({ path: path.resolve(args.resolveDir, args.path.split('?')[0]) }));
    ctx.onLoad({ filter: /[/\\](ResearchAI|ModelFreeAI)\.js$/ }, async args => {
      const filename = path.basename(args.path), contents = await fs.readFile(path.join(referenceDirectory, filename), 'utf8');
      referenceHashes[filename] = createHash('sha256').update(contents).digest('hex');
      return { contents, resolveDir: web, loader: 'js' };
    });
  } }] });
const reference = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const toBuffer = data => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
const fetchBefore = globalThis.fetch;
globalThis.fetch = async url => {
  const filename = fileURLToPath(url), base = path.basename(filename);
  if (base.endsWith('.json')) {
    assert.ok(['manifest.json', 'model-free-manifest.json'].includes(base));
    return { ok: true, json: async () => JSON.parse(await fs.readFile(filename, 'utf8')) };
  }
  const entry = MODEL_CATALOG.find(model => path.basename(model.spec.asset) === base);
  assert.ok(entry, 'Reference may load only catalogued Web weights');
  return { ok: true, arrayBuffer: async () => toBuffer(await fs.readFile(path.join(root, entry.sourcePath))) };
};
const scheduler = new sut.ComputeScheduler(() => {
  const thread = new Worker(new URL('../tests/worker-thread.mjs', import.meta.url), { execArgv: [] });
  return { postMessage: message => thread.postMessage(message), onMessage: fn => thread.on('message', fn),
    onError: fn => thread.on('error', fn), terminate: () => thread.terminate() };
}, { timeoutMs: 60000 });
const records = [];
const receipt = { schemaVersion: 1, status: 'RUNNING', startedAt: new Date().toISOString(),
  environment: { node: process.version, platform: process.platform, arch: process.arch },
  scope: 'Exact Web/production Worker outputs and unchanged rule state; not model strength or native device performance', referenceHashes, records };
await fs.mkdir(path.dirname(output), { recursive: true });
const persist = () => fs.writeFile(output, JSON.stringify(receipt, null, 2) + '\n');
await persist();
try {
  for (const entry of MODEL_CATALOG) {
    const model = entry.research ? await reference.loadResearchModel(entry.id) : await reference.loadModelFreeModel(entry.id);
    const algorithm = entry.research ? new reference.NeuralPUCTAI(model, { simulations: 16, cPuct: 1.5 }) : new reference.ModelFreeAI(model);
    const raw = toBuffer(await fs.readFile(path.join(root, entry.sourcePath)));
    for (const size of [5, ...(!entry.research || entry.id.endsWith('2026092201') ? [15] : [])]) {
      const settings = sut.settingsFor(size), actions = [{ type: 'move', point: [1, 0], player: 'BLACK' }, { type: 'move', point: [2, 0], player: 'WHITE' }];
      const engine = sut.restoreGame(settings, actions), before = sut.ruleView(engine);
      const expected = algorithm.getTopMoves(engine, engine.currentPlayer, 3);
      assert.equal(sut.ruleView(engine).stateHash, before.stateHash, 'Reference search must preserve history and state');
      const start = performance.now();
      const actual = await scheduler.request('ANALYZE', { settings, actions, profile: entry.profile, model: { id: entry.id, raw } },
        { epoch: records.length, revision: 2, rulesVersion: 'territory-v2', player: engine.currentPlayer }, 2);
      const elapsedMs = Math.round((performance.now() - start) * 100) / 100;
      assert.deepEqual(actual.moves, expected, `Exact reference outputs: ${entry.id} size ${size}`);
      assert.equal(actual.stateHash, before.stateHash); assert.equal(actual.player, engine.currentPlayer);
      for (const move of actual.moves) {
        const fresh = sut.restoreGame(settings, actions);
        assert.equal(sut.applyAction(fresh, move.point ? { type: 'move', point: move.point } : { type: 'skip' }).success, true);
      }
      records.push({ id: entry.id, size, prefixActions: actions.length, workerElapsedMs: elapsedMs,
        stateHash: before.stateHash, outputSha256: createHash('sha256').update(JSON.stringify(actual.moves)).digest('hex'),
        modelSha256: entry.spec.asset_sha256, exactOutputMatch: true, stateUnchanged: true, legalSuggestions: true });
      console.log(`PASS ${entry.id} size=${size} worker=${elapsedMs}ms`); await persist();
    }
  }
  receipt.status = 'PASS_EXACT_WEB_WORKER_PARITY_NOT_DEVICE_VERIFIED';
} catch (error) { receipt.status = 'FAIL'; receipt.error = error.message; process.exitCode = 1; }
finally {
  scheduler.cancel(); globalThis.fetch = fetchBefore;
  receipt.finishedAt = new Date().toISOString();
  receipt.workerSha256 = createHash('sha256').update(await fs.readFile(path.join(root, 'dist/workers/index.js'))).digest('hex');
  await persist();
}
console.log(JSON.stringify({ status: receipt.status, cases: records.length, output, error: receipt.error }));
