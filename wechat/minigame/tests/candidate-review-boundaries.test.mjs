import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { prepareCandidate, verifyCandidate } from '../tools/prepare-candidate.mjs';
import { BASE_RUNTIME_FILES, LEGACY_MODEL_PACKAGE_FILES, PACKAGE_FILES } from '../tools/model-packaging.mjs';
import { planTransfer } from '../../ci/transfer.mjs';

const digest = data => createHash('sha256').update(data).digest('hex');
const writeJson = (file, value) => fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);

async function fixture(t) {
  const parent = path.resolve(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(parent, 'lifeline-candidate-boundaries-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), parent);
    assert.ok(path.basename(directory).startsWith('lifeline-candidate-boundaries-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const prepared = await prepareCandidate({
    outputBase: directory, online: true, apiBase: 'https://play.example.com',
  });
  return { directory, ...prepared };
}

test('a candidate cannot use a floating base library even when both metadata fields agree', async t => {
  const prepared = await fixture(t);
  const projectFile = path.join(prepared.importDirectory, 'project.config.json');
  const receiptFile = path.join(prepared.directory, 'candidate.json');
  const originalProject = JSON.parse(await fs.readFile(projectFile, 'utf8'));
  for (const libVersion of ['latest', 'dev', '3.14', '3.14.2-beta']) {
    await writeJson(projectFile, { ...originalProject, libVersion });
    const data = await fs.readFile(projectFile);
    await writeJson(receiptFile, {
      ...prepared.receipt,
      baseLibrary: libVersion,
      files: prepared.receipt.files.map(file => file.path === 'project.config.json'
        ? { ...file, bytes: data.length, sha256: digest(data) } : file),
    });
    await assert.rejects(verifyCandidate(prepared.directory), /base library|configuration|library/i);
    await assert.rejects(planTransfer({ candidateDirectory: prepared.directory, online: true }),
      /base library|configuration|library/i);
  }
  await writeJson(projectFile, originalProject);
  await writeJson(receiptFile, prepared.receipt);
  assert.equal((await verifyCandidate(prepared.directory)).baseLibrary, originalProject.libVersion);
});

test('every legacy schema rejects online configuration after its own package inventory is satisfied', async t => {
  const prepared = await fixture(t);
  for (const schemaVersion of [1, 2, 3]) {
    const packaged = schemaVersion === 1 ? [...BASE_RUNTIME_FILES, 'build-manifest.json']
      : schemaVersion === 2 ? LEGACY_MODEL_PACKAGE_FILES : PACKAGE_FILES;
    const allowed = new Set(['project.config.json', ...packaged.map(file => `dist/${file}`)]);
    const directory = path.join(prepared.directory, `legacy-schema-${schemaVersion}`);
    const files = prepared.receipt.files.filter(file => allowed.has(file.path));
    for (const file of files) {
      const destination = path.join(directory, 'project', file.path);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(path.join(prepared.importDirectory, file.path), destination);
    }
    for (const profile of ['online', 'offline']) {
      await writeJson(path.join(directory, 'candidate.json'), {
        ...prepared.receipt, schemaVersion, profile, files,
      });
      await assert.rejects(verifyCandidate(directory), /Legacy candidate must remain offline/);
      await assert.rejects(planTransfer({ candidateDirectory: directory, online: true }),
        /Legacy candidate must remain offline/);
    }
  }
});
