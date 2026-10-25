// Keep browser product sources canonical. Only the native game build applies
// these reviewed WeChat adaptations; pin both sides so drift cannot be hidden.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const sha = value => createHash('sha256').update(value).digest('hex');
const slash = value => value.split(path.sep).join('/');

export async function nativeWebCompatibility(repo, sourceFiles) {
  const manifestName = 'wechat/minigame/compat/web/manifest.json';
  const manifestPath = path.join(repo, manifestName);
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (manifest.schemaVersion !== 1 || !manifest.overrides) throw new Error('WEB_COMPAT_MANIFEST');
  sourceFiles.add(manifestPath);
  sourceFiles.add(path.join(repo, 'wechat/minigame/tools/web-compat.mjs'));
  const records = {};
  const load = async args => {
      const relative = slash(path.relative(repo, args.path));
      const entry = manifest.overrides[relative];
      if (!entry) return;
      if (!relative.startsWith('web/web前端/')
          || !entry.override.startsWith('wechat/minigame/compat/web/')
          || entry.override.split('/').some(part => !part || part === '.' || part === '..')) {
        throw new Error('WEB_COMPAT_PATH');
      }
      const canonical = await fs.readFile(args.path);
      const overridePath = path.join(repo, entry.override);
      const override = await fs.readFile(overridePath);
      if (sha(canonical) !== entry.canonicalSha256 || sha(override) !== entry.overrideSha256) {
        throw new Error(`WEB_COMPAT_SOURCE_DRIFT:${relative}`);
      }
      sourceFiles.add(args.path); sourceFiles.add(overridePath);
      records[relative] = { canonicalSha256: entry.canonicalSha256,
        override: entry.override, overrideSha256: entry.overrideSha256 };
      return { contents: override, loader: 'js', resolveDir: path.dirname(args.path) };
  };
  return { records, load, plugin: { name: 'pinned-native-web-compatibility', setup(build) {
    build.onLoad({ filter: /[\\/]web前端[\\/].*\.js$/ }, load);
  } } };
}
