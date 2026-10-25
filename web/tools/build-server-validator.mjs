// Bundle native rule validation so deployed services cannot retain stale src/.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [toolRoot, output] = process.argv.slice(2);
if (!toolRoot || !output) throw Error('Expected tool-root and new output directory');
const esbuild = await import(pathToFileURL(path.resolve(toolRoot, 'node_modules/esbuild/lib/main.js')));
const out = path.resolve(output);
await fs.mkdir(out, { recursive: false });
const sourceHashes = {};
const sha = raw => createHash('sha256').update(raw).digest('hex');
const built = await esbuild.build({ absWorkingDir: root,
  entryPoints: ['wechat/minigame/tools/validate-action.mjs'],
  outfile: path.join(out, 'validate-action.mjs'), bundle: true, write: false,
  platform: 'node', format: 'esm', target: 'node18', metafile: true,
  plugins: [{ name: 'cache-imports', setup(ctx) {
    ctx.onResolve({ filter: /\?v=/ }, args => ({ path: path.resolve(args.resolveDir, args.path.split('?')[0]) }));
  }}], logLevel: 'silent',
});
if (built.errors.length || built.warnings.length) throw Error('Validator build diagnostics');
for (const name of Object.keys(built.metafile.inputs)) {
  if (name.startsWith('<') || name.startsWith('../') || path.isAbsolute(name)) throw Error('Unexpected validator input: ' + name);
  sourceHashes[name] = sha(await fs.readFile(path.join(root, name)));
}
if (Object.values(built.metafile.outputs).some(item => item.imports.length)) throw Error('Validator has unbundled dependencies');
const raw = built.outputFiles[0].contents;
await fs.writeFile(path.join(out, 'validate-action.mjs'), raw, { flag: 'wx' });
await fs.writeFile(path.join(out, 'manifest.json'), JSON.stringify({ schemaVersion: 1,
  bundleSha256: sha(raw), compiler: esbuild.version, sourceHashes }, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ status: 'VALIDATOR_BUNDLED', inputs: Object.keys(sourceHashes).length, bytes: raw.length }));
