// Fixed DEV-only checkpoint selection. No FINAL result is read here.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyArena } from './verify-neural-posttraining-v2.mjs';
import { sha } from './neural-posttraining-data.mjs';

export const PARENTS = Object.freeze(['padded-cnn-transfer-v1-seed2026092203', 'grid-gnn-transfer-v1-seed2026092202']);
export const STAGES = Object.freeze(['040', '080', '120']);
export function selectStages(rows) {
  const expected = PARENTS.flatMap(p => STAGES.map(s => `${p}-terminal-head-r3-s${s}`));
  assert.equal(rows.length, 6);
  assert.deepEqual(rows.map(r => r.id).sort(), [...expected].sort());
  return PARENTS.map(parent => {
    const eligible = rows.filter(r => r.parent_model_id === parent && r.plannedGames === 12
      && r.terminalGames === 12 && r.truncatedGames === 0 && Number.isFinite(r.meanScore));
    assert.ok(eligible.length, `No complete stage for ${parent}; keep fixed family, do not substitute`);
    eligible.sort((a, b) => b.meanScore - a.meanScore || a.id.localeCompare(b.id));
    return eligible[0];
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const dev = resolve(process.argv[2]), output = resolve(process.argv[3]);
    const identity = JSON.parse(await readFile(resolve(dev, 'identity.json'), 'utf8'));
    assert.equal(identity.config.seedNamespace, 'neural-terminal-headonly-r3-20261021-DEV-v1');
    assert.deepEqual(identity.config.sizes, [5, 7, 9]);
    assert.equal(identity.config.prefixesPerSize, 2);
    assert.equal(identity.plannedGames, 72);
    const verification = await verifyArena(dev, identity.candidateManifestPath);
    assert.equal(verification.status, 'PASS_APPLICATION_SCREEN_REPLAY');
    const summaryBytes = await readFile(resolve(dev, 'summary.json'));
    const selected = selectStages(JSON.parse(summaryBytes).models);
    const devManifest = JSON.parse(await readFile(identity.candidateManifestPath, 'utf8'));
    const sourcePath = resolve(devManifest.source_manifest);
    const sourceBytes = await readFile(sourcePath), source = JSON.parse(sourceBytes);
    assert.equal(sha(sourceBytes), devManifest.source_manifest_sha256);
    await mkdir(output, { recursive: true });
    const models = selected.map(row => {
      const original = source.models.find(m => m.id === row.id);
      assert.ok(original);
      const model = structuredClone(original);
      model.asset = resolve(dirname(sourcePath), original.asset);
      return model;
    });
    const manifest = { schema: 'lifeline-web-neural-distillation-candidates-v1', rulesVersion: 'territory-v2',
      source_manifest: sourcePath, source_manifest_sha256: sha(sourceBytes), models };
    const manifestBytes = JSON.stringify(manifest, null, 2) + '\n';
    await writeFile(resolve(output, 'candidate-manifest.json'), manifestBytes, { flag: 'wx' });
    const receipt = { status: 'PASS_FIXED_DEV_STAGE_SELECTION', devIdentity: identity.identity,
      sourceManifestSha256: sha(sourceBytes), devSummarySha256: sha(summaryBytes),
      devVerificationSha256: sha(await readFile(resolve(dev, 'verification.json'))),
      selected, selectedManifestSha256: sha(manifestBytes),
      selectorSha256: sha(await readFile(fileURLToPath(import.meta.url))),
      rule: 'Maximum complete DEV mean score within each of two fixed parent routes; earliest update on ties; no FINAL data.',
    };
    await writeFile(resolve(output, 'selection-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify(receipt));
  } catch (error) { console.error(error.stack); process.exitCode = 1; }
}
