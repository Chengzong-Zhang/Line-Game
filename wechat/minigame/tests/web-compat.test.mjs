import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { nativeWebCompatibility } from '../tools/web-compat.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const source = 'web/web前端/Synthetic.js';
const override = 'wechat/minigame/compat/web/Synthetic.js';

async function fixture(t) {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'lifeline-web-compat-'));
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const canonical = 'export const platform = "browser";\n';
  const native = 'export const platform = "wechat";\n';
  for (const [relative, text] of [[source, canonical], [override, native]]) {
    await fs.mkdir(path.dirname(path.join(repo, relative)), { recursive: true });
    await fs.writeFile(path.join(repo, relative), text);
  }
  const manifest = { schemaVersion: 1, overrides: { [source]: {
    canonicalSha256: sha(canonical), override, overrideSha256: sha(native),
  } } };
  const manifestPath = path.join(repo, 'wechat/minigame/compat/web/manifest.json');
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  const sources = new Set();
  const result = await nativeWebCompatibility(repo, sources);
  let load;
  result.plugin.setup({ onLoad(_options, callback) { load = callback; } });
  return { repo, native, manifest, manifestPath, sources, result,
    load: () => load({ path: path.join(repo, source) }) };
}

test('native compatibility preserves canonical files and binds both inputs', async t => {
  const f = await fixture(t);
  const before = await fs.readFile(path.join(f.repo, source));
  const loaded = await f.load();
  assert.equal(loaded.contents.toString(), f.native);
  assert.equal(loaded.resolveDir, path.dirname(path.join(f.repo, source)));
  assert.deepEqual(await fs.readFile(path.join(f.repo, source)), before);
  for (const relative of [source, override, 'wechat/minigame/compat/web/manifest.json',
    'wechat/minigame/tools/web-compat.mjs']) assert.ok(f.sources.has(path.join(f.repo, relative)));
  assert.deepEqual(f.result.records[source], f.manifest.overrides[source]);
  assert.deepEqual(await f.load(), loaded);
});

for (const changed of [source, override]) test(`native compatibility rejects drift: ${changed}`, async t => {
  const f = await fixture(t);
  await fs.appendFile(path.join(f.repo, changed), '\n// changed after review');
  await assert.rejects(f.load(), /WEB_COMPAT_SOURCE_DRIFT/);
});

test('native compatibility rejects traversal outside its reviewed source folder', async t => {
  const f = await fixture(t);
  f.manifest.overrides[source].override = 'wechat/minigame/compat/web/../Synthetic.js';
  await fs.writeFile(f.manifestPath, JSON.stringify(f.manifest));
  const next = await nativeWebCompatibility(f.repo, new Set());
  let load;
  next.plugin.setup({ onLoad(_options, callback) { load = callback; } });
  await assert.rejects(load({ path: path.join(f.repo, source) }), /WEB_COMPAT_PATH/);
});

test('unlisted browser modules use the canonical source loader', async t => {
  const f = await fixture(t);
  let load;
  f.result.plugin.setup({ onLoad(_options, callback) { load = callback; } });
  assert.equal(await load({ path: path.join(f.repo, 'web/web前端/Other.js') }), undefined);
});
