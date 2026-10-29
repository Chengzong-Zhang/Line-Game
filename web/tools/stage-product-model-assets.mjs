// Reuse only the already published, hash-bound model assets. Never trains or promotes.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MODEL_CATALOG } from '../../wechat/minigame/src/model-catalog.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = process.argv[2];
if (!source || !path.isAbsolute(source)) throw new Error('Supply the absolute existing product model asset directory.');
const target = path.join(repo, 'web/web前端/assets/research-ai');
const pending = [];
for (const model of MODEL_CATALOG) {
  const relative = model.spec.asset;
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).some(part => part === '..')) throw new Error('Invalid model path');
  const bytes = await fs.readFile(path.join(source, relative));
  if (bytes.length !== model.bytes || createHash('sha256').update(bytes).digest('hex') !== model.spec.asset_sha256) throw new Error(`Published model identity mismatch: ${model.id}`);
  const destination = path.join(target, relative);
  try {
    if (!(await fs.readFile(destination)).equals(bytes)) throw new Error(`Existing model differs: ${model.id}`);
  } catch (error) { if (error.code !== 'ENOENT') throw error; pending.push({ destination, bytes }); }
}
for (const { destination, bytes } of pending) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, bytes, { flag: 'wx' });
}
console.log(JSON.stringify({ status: 'EXISTING_PRODUCT_MODELS_VERIFIED', models: MODEL_CATALOG.length, newFiles: pending.length,
  bytes: MODEL_CATALOG.reduce((sum, entry) => sum + entry.bytes, 0), trainingStarted: false }));
