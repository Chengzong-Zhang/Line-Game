import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));

// WeChat uses miniprogramRoot for compileType=game too. An unknown
// minigameRoot field silently selects the project folder, breaking Workers
// and potentially selecting sources/dependencies instead of the release bundle.
test('both WeChat projects select only the built package with the documented root key', async () => {
  for (const project of [root, path.resolve(root, '../device-bench')]) {
    const config = await readJson(path.join(project, 'project.config.json'));
    assert.equal(config.compileType, 'game');
    assert.equal(config.miniprogramRoot, 'dist/');
    assert.equal(Object.hasOwn(config, 'minigameRoot'), false);
    assert.equal(config.setting.urlCheck, true);
  }
});

test('the selected game package resolves its entry point and Worker directory', async () => {
  const project = await readJson(path.join(root, 'project.config.json'));
  const packageRoot = path.resolve(root, project.miniprogramRoot);
  assert.equal(path.relative(root, packageRoot), 'dist');
  const game = await readJson(path.join(packageRoot, 'game.json'));
  assert.equal((await fs.stat(path.join(packageRoot, 'game.js'))).isFile(), true);
  assert.equal((await fs.stat(path.join(packageRoot, game.workers))).isDirectory(), true);
  assert.equal((await fs.stat(path.join(packageRoot, game.workers, 'index.js'))).isFile(), true);
  for (const excluded of ['node_modules', 'src', 'config.local.json', 'project.private.config.json']) {
    await assert.rejects(fs.stat(path.join(packageRoot, excluded)), { code: 'ENOENT' });
  }
});
