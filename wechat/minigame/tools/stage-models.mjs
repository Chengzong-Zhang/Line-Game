import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MODEL_CATALOG } from './model-packaging.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export async function stageModels(source) {
  if (!source || !path.isAbsolute(source)) throw new Error('Supply the absolute Web research-ai asset directory');
  const rows = [];
  // Check every input before creating files. Existing mismatched staging is
  // preserved and rejected, never overwritten or retrained.
  for (const entry of MODEL_CATALOG) {
    const data = await fs.readFile(path.join(source, entry.spec.asset));
    if (data.length !== entry.bytes || createHash('sha256').update(data).digest('hex') !== entry.spec.asset_sha256) {
      throw new Error(`Model does not match its Web manifest: ${entry.id}`);
    }
    const destination = path.join(root, entry.sourcePath);
    let existing = false;
    try { existing = true; if (!(await fs.readFile(destination)).equals(data)) throw new Error(`Staged file differs: ${entry.id}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; existing = false; }
    rows.push({ entry, destination, data, existing });
  }
  await fs.mkdir(path.join(root, 'model-assets'), { recursive: true });
  for (const row of rows) if (!row.existing) await fs.writeFile(row.destination, row.data, { flag: 'wx' });
  return { status: 'VERIFIED_WEB_MODELS_STAGED_LOCAL_ONLY', models: rows.length,
    bytes: rows.reduce((sum, row) => sum + row.data.length, 0) };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await stageModels(process.argv[2]), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
