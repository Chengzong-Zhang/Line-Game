import assert from 'node:assert/strict';
import { PARENTS, STAGES, selectStages } from '../../tools/select-neural-headonly-stage.mjs';
const rows = PARENTS.flatMap(parent_model_id => STAGES.map(stage => ({
  id: `${parent_model_id}-terminal-head-r3-s${stage}`, parent_model_id, plannedGames: 12,
  terminalGames: 12, truncatedGames: 0, meanScore: 0.5,
})));
assert.ok(selectStages(rows).every(row => row.id.endsWith('s040')), 'Ties must choose earliest checkpoint');
const changed = structuredClone(rows); changed[1].meanScore = 0.75;
assert.ok(selectStages(changed)[0].id.endsWith('s080'));
changed[1].terminalGames = 11; changed[1].truncatedGames = 1;
assert.ok(selectStages(changed)[0].id.endsWith('s040'), 'Incomplete winner is ineligible');
assert.throws(() => selectStages(rows.slice(1)));
const duplicate = structuredClone(rows); duplicate[1] = duplicate[0]; assert.throws(() => selectStages(duplicate));
for (const row of changed.filter(row => row.parent_model_id === PARENTS[1])) row.terminalGames = 0;
assert.throws(() => selectStages(changed), /No complete stage/);
console.log(JSON.stringify({ status: 'PASS_FIXED_NEURAL_HEADONLY_SELECTION', checks: ['maximum-score', 'earliest-tie', 'incomplete-stage-excluded', 'missing-and-duplicate-rejected', 'no-route-substitution'] }));
