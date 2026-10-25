// Test and diagnostic bundles must apply the same reviewed native adapters as
// the release builder, rather than importing browser resource URLs into Node.
import { build as esbuild } from 'esbuild';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { nativeWebCompatibility } from './web-compat.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export async function build(options) {
  const compatibility = await nativeWebCompatibility(repo, new Set());
  return esbuild({ ...options, plugins: [...(options.plugins || []), compatibility.plugin] });
}

export async function readNativeWebSource(name) {
  const filename = path.join(repo, 'web/web前端', name);
  const compatibility = await nativeWebCompatibility(repo, new Set());
  const native = await compatibility.load({ path: filename });
  return (native ? native.contents : await fs.readFile(filename)).toString('utf8');
}
