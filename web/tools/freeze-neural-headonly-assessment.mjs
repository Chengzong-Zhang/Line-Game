// Instantiate the tested, versioned assessment with the two DEV-selected
// checkpoints. Run once before FINAL; no FINAL file is read by this tool.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sha } from './neural-posttraining-data.mjs';
import { selectStages } from './select-neural-headonly-stage.mjs';

const base = resolve('local_artifacts/neural-terminal-headonly-r3-20261021');
const final = resolve(base, 'final'), sourcePath = resolve(base, 'training/candidate-manifest.json');
const selectionBytes = await readFile(resolve(final, 'selection-receipt.json'));
const selection = JSON.parse(selectionBytes);
const devBytes = await readFile(resolve(base, 'dev/summary.json'));
assert.equal(sha(devBytes), selection.devSummarySha256);
assert.deepEqual(selectStages(JSON.parse(devBytes).models), selection.selected);
const ids = selection.selected.map(row => row.id);
const sourceHash = sha(await readFile(sourcePath));
assert.equal(sourceHash, selection.sourceManifestSha256);
assert.equal(sha(await readFile(resolve(final, 'candidate-manifest.json'))), selection.selectedManifestSha256);
const replaceOnce = (text, from, to) => {
  assert.equal(text.split(from).length - 1, 1, `Template anchor mismatch: ${from.slice(0, 50)}`);
  return text.replace(from, to);
};
let code = await readFile('web/tools/assess-neural-confirmation-v2.mjs', 'utf8');
assert.equal(sha(code), '3fbef52d5b855e2046dfd11721c820c7693a9ecbd0b1babf613be18c8469e28c');
code = code.replace(/export const EXPECTED_CANDIDATES=Object.freeze\(\[[\s\S]*?\]\);/,
  `export const EXPECTED_CANDIDATES=Object.freeze(${JSON.stringify(ids)});`);
code = code.replaceAll('familySize:7', 'familySize:2').replaceAll('2026102137', '2026102191')
  .replaceAll('lifeline-neural-confirmation-gate-v1', 'lifeline-neural-headonly-confirmation-gate-v1')
  .replaceAll('FRESH_PAIRED_CONFIRMATION_WITH_EXTERNAL_HOLM_GATE', 'HEADONLY_FRESH_CONFIRMATION_WITH_EXTERNAL_HOLM_GATE')
  .replaceAll('ai-improvement-round2-20261021-neural-confirmation-FINAL-v1', 'neural-terminal-headonly-r3-20261021-FINAL-v1')
  .replaceAll('69c6f45209f08c9acef9cb0b1a01264185e8a711789428dac362b4b3812a9545', sourceHash)
  .replace(/\b420\b/g, '120').replaceAll('confirmation-assessment-v2.json', 'confirmation-assessment.json')
  .replaceAll('lifeline-neural-confirmation-assessment-v2', 'lifeline-neural-headonly-confirmation-assessment-v1')
  .replaceAll('Seven selected models form the fixed Holm family; selection used the prior screen, not these confirmation openings.',
    'Two fixed routes form the Holm family; checkpoint selection used only the new DEV set, not these FINAL openings.')
  .replaceAll('seven-model multiplicity', 'two-model multiplicity');
code = replaceOnce(code, '  await observe(SELF);',
  `  await observe(SELF);\n  assert.equal(sha(await observe(resolve(runRoot,'selection-receipt.json'))),${JSON.stringify(sha(selectionBytes))},'DEV selection receipt drift');`);
const assessmentPath = 'web/tools/assess-neural-headonly-r3.mjs';
await writeFile(assessmentPath, code, { flag: 'wx' });

let test = await readFile('web/web前端/tests/verify-neural-confirmation-assessment-v2.mjs', 'utf8');
test = test.replaceAll('assess-neural-confirmation-v2.mjs', 'assess-neural-headonly-r3.mjs')
  .replaceAll('verify-neural-confirmation-assessment-v2.mjs', 'verify-neural-headonly-assessment.mjs')
  .replaceAll('FRESH_PAIRED_CONFIRMATION_WITH_EXTERNAL_HOLM_GATE', 'HEADONLY_FRESH_CONFIRMATION_WITH_EXTERNAL_HOLM_GATE')
  .replaceAll('ai-improvement-round2-20261021-neural-confirmation-FINAL-v1', 'neural-terminal-headonly-r3-20261021-FINAL-v1')
  .replaceAll('neural-confirmation-assessment-tests-', 'neural-headonly-assessment-tests-')
  .replaceAll('length:7', 'length:2').replaceAll('0.05/7', '0.05/2').replaceAll('pValue:0.008', 'pValue:0.026')
  .replace(/\b420\b/g, '120')
  .replaceAll('local_artifacts/all-ai-posttraining-20261021/neural-training/candidate-manifest.json',
    'local_artifacts/neural-terminal-headonly-r3-20261021/training/candidate-manifest.json');
test = test.replace(/const wanted=\[[\s\S]*?\];/, `const wanted=${JSON.stringify(ids)};`);
test = test.replaceAll('m.parent_model_id===id', 'm.id===id');
test = replaceOnce(test, "const run=resolve(base,'arena');await mkdir(resolve(run,'games'),{recursive:true});",
  `const run=resolve(base,'arena');await mkdir(resolve(run,'games'),{recursive:true});\nawait writeFile(resolve(run,'selection-receipt.json'),await readFile(${JSON.stringify(resolve(final, 'selection-receipt.json'))}));`);
const testPath = 'web/web前端/tests/verify-neural-headonly-assessment.mjs';
await writeFile(testPath, test, { flag: 'wx' });
const receipt = { status: 'FROZEN_BEFORE_FINAL', selectedIds: ids, sourceManifestSha256: sourceHash,
  selectionSha256: sha(selectionBytes), assessmentSha256: sha(code), testSha256: sha(test),
  numericGate: { familySize: 2, gamesPerModel: 60, minimumMeanScore: 0.55, minimumPerSizeScore: 0.45, holmAlpha: 0.05 },
  generatedFrom: 'assess-neural-confirmation-v2.mjs; same verified math and replay checks, predeclared two-model family and fresh seeds' };
await writeFile(resolve(final, 'assessment-freeze.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(receipt));
