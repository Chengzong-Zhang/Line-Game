// Local, immutable Node 22 validator builds; no application source is replaced.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { nativeWebCompatibility } from '../../wechat/minigame/tools/web-compat.mjs';

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), '../..');
const ENTRY = 'wechat/minigame/tools/validate-action.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
const slash = value => value.split(path.sep).join('/');
const ordinary = async file => assert.ok(!(await fs.lstat(file)).isSymbolicLink(), `Symlink rejected: ${file}`);
const nameFor = file => {
  const name = slash(path.relative(ROOT, file));
  assert.ok(name && !name.startsWith('../') && !path.isAbsolute(name), `Outside repository: ${file}`);
  return name;
};
const ref = async file => ({ path: file, sha256: sha(await fs.readFile(file)) });
const SOURCE_REQUIRED = [ENTRY, 'wechat/minigame/src/state.js', 'web/web前端/GameEngine.js',
  'web/tools/build-server-validator-v2.mjs', 'wechat/minigame/tools/web-compat.mjs', 'wechat/minigame/compat/web/manifest.json'];

export async function verifyValidatorInputsV2(directory) {
  const out = path.resolve(directory), bundle = path.join(out, 'validate-action.mjs');
  const manifest = JSON.parse(await fs.readFile(path.join(out, 'manifest.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.kind, 'standalone-native-rule-validator-v2');
  assert.equal(manifest.target, 'node22');
  assert.equal(manifest.compiler, '0.25.12');
  assert.ok(manifest.sourceHashes && SOURCE_REQUIRED.every(name => /^[a-f0-9]{64}$/.test(manifest.sourceHashes[name] || '')),
    'Missing required validator source hashes');
  assert.deepEqual(Object.keys(manifest.compilerHashes || {}).sort(), ['binary', 'javascript', 'lock', 'package'],
    'Missing required compiler hashes');
  assert.equal(manifest.bundleSha256, sha(await fs.readFile(bundle)));
  for (const [name, expected] of Object.entries(manifest.sourceHashes)) {
    assert.ok(/\.(js|mjs|json)$/.test(name) && (SOURCE_REQUIRED.includes(name) || name.startsWith('wechat/minigame/src/')
      || name.startsWith('web/web前端/') || name.startsWith('wechat/minigame/compat/web/')
      || name.startsWith('wechat/minigame/node_modules/@noble/hashes/')), `Unexpected validator hash path: ${name}`);
    const file = path.resolve(ROOT, name); assert.equal(nameFor(file), name); await ordinary(file);
    assert.equal(sha(await fs.readFile(file)), expected, `Validator source changed: ${name}`);
  }
  const compilerPackage = path.resolve(manifest.compilerHashes.package.path);
  assert.equal(slash(compilerPackage).split('/').slice(-3).join('/'), 'node_modules/esbuild/package.json');
  const toolRoot = path.resolve(compilerPackage, '../../..');
  const expectedCompiler = { package: compilerPackage, lock: path.join(toolRoot, 'package-lock.json'),
    javascript: path.join(toolRoot, 'node_modules/esbuild/lib/main.js'),
    binary: path.join(toolRoot, `node_modules/@esbuild/${process.platform}-${process.arch}/${process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild'}`) };
  for (const [key, item] of Object.entries(manifest.compilerHashes)) {
    assert.equal(path.resolve(item.path), expectedCompiler[key], 'Unexpected compiler hash path');
    await ordinary(item.path); assert.equal(sha(await fs.readFile(item.path)), item.sha256, 'Compiler input changed');
  }
  // Recompile in memory to establish the complete graph instead of trusting
  // deletable lists in a resealed manifest. No candidate files are replaced.
  const rebuilt = await compileValidatorV2(toolRoot);
  assert.equal(rebuilt.manifest.bundleSha256, manifest.bundleSha256, 'Validator bytes differ from current complete build');
  assert.deepEqual(rebuilt.manifest.sourceHashes, manifest.sourceHashes, 'Incomplete or changed validator source graph');
  assert.deepEqual(rebuilt.manifest.compilerHashes, manifest.compilerHashes, 'Compiler identity differs from actual build');
  assert.deepEqual(rebuilt.manifest.nativeCompatibility, manifest.nativeCompatibility, 'Missing or changed native compatibility graph');
  return { status: 'PASS_REBUILT_NODE22_VALIDATOR_INPUTS', manifest, out, bundle };
}

export async function verifyValidatorBundleV2(directory, { node = process.execPath } = {}) {
  const { manifest, out, bundle } = await verifyValidatorInputsV2(directory);
  const version = spawnSync(node, ['--version'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(version.status, 0); assert.match(version.stdout.trim(), /^v22\./, 'Node 22 required for runtime probes');
  const { GameEngine, PLAYER_ORDER } = await import(pathToFileURL(path.join(ROOT, 'web/web前端/GameEngine.js')));
  const { serializeRuleState, canonicalize } = await import(pathToFileURL(path.join(ROOT, 'web/web前端/ReplayCodec.js')));
  const records = [];
  const view = engine => {
    const snapshot = engine.getSnapshot();
    return { stateHash: `sha256:${sha(canonicalize(serializeRuleState(engine)))}`,
      currentPlayer: snapshot.currentPlayer, gameOver: snapshot.gameOver, winner: snapshot.winner,
      resignedPlayers: snapshot.resignedPlayers,
      scores: Object.fromEntries(snapshot.players.map(color => [color, snapshot.territories[color].area])) };
  };
  const check = (settings, actions, engine, action, label) => {
    const child = spawnSync(node, [bundle], { input: JSON.stringify({ settings, actions, ...(action ? { action } : {}) }),
      encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, cwd: out });
    assert.equal(child.status, 0, `${label}: ${child.stderr || child.error || 'validator failed'}`);
    const observed = JSON.parse(child.stdout), expected = view(engine);
    assert.deepEqual(observed, expected, `Canonical GameEngine mismatch: ${label}`);
    records.push({ players: settings.playerCount, kind: action ? 'APPLY' : 'STATE', label,
      action: action || null, replayedActions: actions.length, ...observed });
  };
  for (const count of [2, 6, 7, 15]) {
    const settings = { gridSize: 5, playerCount: count, boardShape: count === 2 ? 'triangle' : 'hexagon',
      startPlayer: 'BLACK', rulesVersion: 'territory-v3' };
    if (count > 6) {
      const points = []; for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) if (x + y >= 4 && x + y <= 12) points.push([x, y]);
      settings.startingPointMode = 'custom';
      settings.initialPositions = Object.fromEntries(PLAYER_ORDER.slice(0, count).map((color, i) => [color, points[i * 4]]));
    }
    const engine = new GameEngine(settings), actions = [];
    assert.ok(engine.activePlayers.every(color => engine.getSnapshot().territories[color].area === 1));
    check(settings, actions, engine, null, `${count}-initial`);
    const move = { type: 'player_move', color: engine.currentPlayer, point: engine.getLegalMoves()[0]?.point };
    assert.ok(move.point); assert.equal(engine.playMove(move.point).success, true);
    check(settings, actions, engine, move, `${count}-move`); actions.push(move);
    check(settings, actions, engine, null, `${count}-history`);
    const pass = { type: 'player_skip', color: engine.currentPlayer };
    assert.equal(engine.skipTurn().success, true);
    check(settings, actions, engine, pass, `${count}-PASS`); actions.push(pass);
    const resign = { type: 'player_resign', color: engine.currentPlayer };
    assert.equal(engine.resignPlayer(resign.color).success, true);
    check(settings, actions, engine, resign, `${count}-resign`);
    if (count > 6) {
      const points = []; for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) if (x + y >= 4 && x + y <= 12) points.push([x, y]);
      const dense = { ...settings, initialPositions: Object.fromEntries(PLAYER_ORDER.slice(0, count).map((color, i) => [color, points[i]])) };
      const blocked = new GameEngine(dense);
      assert.equal(blocked.getLegalMoves().length, 0); assert.equal(blocked.gameOver, false);
      check(dense, [], blocked, null, `${count}-dense-custom-initial`);
      const skip = { type: 'player_skip', color: blocked.currentPlayer };
      assert.equal(blocked.skipTurn().success, true);
      check(dense, [], blocked, skip, `${count}-dense-custom-PASS`);
    }
  }
  return { schema: 'lifeline-native-validator-probes-v2', status: 'PASS_NODE22_CANONICAL_STATE_APPLY_2_6_7_15',
    node: version.stdout.trim(), bundleSha256: manifest.bundleSha256, records,
    scope: 'Local Node 22 STATE/APPLY, replay history, PASS, resignation and native discrete area; no server, browser or device claim.' };
}

async function compileValidatorV2(toolRoot) {
  const tool = path.resolve(toolRoot), sources = new Map();
  const remember = async file => {
    await ordinary(file); const bytes = await fs.readFile(file), name = nameFor(file);
    if (sources.has(name)) assert.equal(sha(bytes), sources.get(name), `Source drift: ${name}`);
    sources.set(name, sha(bytes)); return bytes;
  };
  await remember(SELF); await remember(path.join(ROOT, 'wechat/minigame/tools/web-compat.mjs'));
  await remember(path.join(ROOT, 'wechat/minigame/compat/web/manifest.json'));
  const compilerPackage = path.join(tool, 'node_modules/esbuild/package.json');
  assert.equal(JSON.parse(await fs.readFile(compilerPackage, 'utf8')).version, '0.25.12');
  const esbuild = await import(pathToFileURL(path.join(tool, 'node_modules/esbuild/lib/main.js')));
  assert.equal(esbuild.version, '0.25.12');
  const compilerHashes = { package: await ref(compilerPackage), lock: await ref(path.join(tool, 'package-lock.json')),
    javascript: await ref(path.join(tool, 'node_modules/esbuild/lib/main.js')),
    binary: await ref(path.join(tool, `node_modules/@esbuild/${process.platform}-${process.arch}/${process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild'}`)) };
  const compatibility = await nativeWebCompatibility(ROOT, new Set());
  const built = await esbuild.build({ absWorkingDir: ROOT, entryPoints: [ENTRY], outfile: path.join(ROOT, 'local_artifacts/.validator-memory-only/validate-action.mjs'),
    bundle: true, write: false, platform: 'node', format: 'esm', target: 'node22', metafile: true, logLevel: 'silent',
    plugins: [{ name: 'captured-native-validator-inputs', setup(build) {
      build.onResolve({ filter: /\?v=/ }, args => ({ path: path.resolve(args.resolveDir, args.path.split('?')[0]) }));
      build.onLoad({ filter: /\.(?:js|mjs|json)$/ }, async args => {
        const name = nameFor(args.path);
        assert.ok(name === ENTRY || name.startsWith('wechat/minigame/src/') || name.startsWith('web/web前端/')
          || name.startsWith('wechat/minigame/node_modules/@noble/hashes/'), `Unexpected validator dependency: ${name}`);
        const canonical = await remember(args.path), adapted = await compatibility.load(args);
        if (adapted) {
          const item = compatibility.records[name], override = await remember(path.join(ROOT, item.override));
          assert.equal(sha(override), sha(adapted.contents));
          assert.equal(sha(canonical), item.canonicalSha256); return adapted;
        }
        return { contents: canonical, loader: name.endsWith('.json') ? 'json' : 'js' };
      });
    } }] });
  assert.equal(built.errors.length, 0); assert.equal(built.warnings.length, 0);
  for (const name of Object.keys(built.metafile.inputs)) assert.ok(sources.has(nameFor(path.resolve(ROOT, name))), `Uncaptured input: ${name}`);
  assert.ok(Object.values(built.metafile.outputs).every(item => item.imports.length === 0), 'Unbundled validator dependency');
  assert.equal(built.outputFiles.length, 1);
  for (const [name, expected] of sources) assert.equal(sha(await fs.readFile(path.join(ROOT, name))), expected, `Changed during build: ${name}`);
  const raw = built.outputFiles[0].contents;
  const manifest = { schemaVersion: 1, kind: 'standalone-native-rule-validator-v2', target: 'node22',
    status: 'BUILT_LOCAL_NOT_DEPLOYED', bundleSha256: sha(raw), bundleBytes: raw.length,
    compiler: esbuild.version, compilerHashes, sourceHashes: Object.fromEntries([...sources].sort(([a], [b]) => a.localeCompare(b, 'en'))),
    nativeCompatibility: compatibility.records };
  return { manifest, raw };
}

export async function buildValidatorBundleV2({ toolRoot, output, node = process.execPath }) {
  const out = path.resolve(output), { manifest, raw } = await compileValidatorV2(toolRoot);
  await fs.mkdir(out, { recursive: false });
  await fs.writeFile(path.join(out, 'validate-action.mjs'), raw, { flag: 'wx' });
  await fs.writeFile(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  const probes = await verifyValidatorBundleV2(out, { node });
  await fs.writeFile(path.join(out, 'verification.json'), JSON.stringify(probes, null, 2) + '\n', { flag: 'wx' });
  const receipt = { schema: 'lifeline-native-validator-build-v2', status: 'BUILT_AND_VERIFIED_LOCAL_NOT_DEPLOYED',
    bundle: await ref(path.join(out, 'validate-action.mjs')), manifest: await ref(path.join(out, 'manifest.json')),
    verification: await ref(path.join(out, 'verification.json')), compilerHashes: manifest.compilerHashes,
    sourceCount: Object.keys(manifest.sourceHashes).length, nativeCompatibilityCount: Object.keys(manifest.nativeCompatibility).length,
    probes: probes.records.length, recordedAtUtc: new Date().toISOString() };
  await fs.writeFile(path.join(out, 'build-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  try {
    const args = process.argv.slice(2), option = name => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
    const node = option('--node') || process.execPath;
    if (args[0] === 'verify-inputs') {
      assert.ok(option('--bundle'));
      const result = await verifyValidatorInputsV2(path.dirname(path.resolve(option('--bundle'))));
      console.log(JSON.stringify({ status: result.status, bundleSha256: result.manifest.bundleSha256,
        sourceCount: Object.keys(result.manifest.sourceHashes).length,
        nativeCompatibilityCount: Object.keys(result.manifest.nativeCompatibility).length }));
    } else if (args[0] === 'verify') {
      assert.ok(option('--bundle')); console.log(JSON.stringify(await verifyValidatorBundleV2(path.dirname(path.resolve(option('--bundle'))), { node })));
    } else {
      assert.ok(args[0] === 'build' && option('--tool-root') && option('--output'), 'Use build --tool-root DIR --output NEW_DIR [--node NODE22]');
      console.log(JSON.stringify(await buildValidatorBundleV2({ toolRoot: option('--tool-root'), output: option('--output'), node })));
    }
  } catch (error) { console.error(error.stack); process.exitCode = 1; }
}
