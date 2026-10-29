import assert from 'node:assert/strict';
import { createBoardDraft, addBoundaryVertex, closeBoundaryDraft, startBoundaryRing, addSeamPair, deleteBoundaryRing } from '../BoardEditor.js';
import { compileBoard } from '../BoardCompiler.js';

function draw(draft, coordinates) {
  for (const point of coordinates) { const r = addBoundaryVertex(draft, point); assert.equal(r.ok, true); draft = r.draft; }
  return closeBoundaryDraft(draft);
}
const outer = [[0,0],[1,0],[2,0],[3,0],[4,0],[4,1],[4,2],[4,3],[4,4],[3,4],[2,4],[1,4],[0,4],[0,3],[0,2],[0,1]];
let base = draw(createBoardDraft(), outer).draft;
const desired = base.boundaryOccurrenceIds.find(id => {
  const [face, side] = [id.slice(0,id.lastIndexOf(':')), Number(id.slice(id.lastIndexOf(':')+1))];
  const v = base.candidateDefinition.faces.find(x => x.id === face).vertices;
  return [v[side],v[(side+1)%3]].sort().join('|') === 'v:0,0|v:1,0';
});
assert.ok(desired);
let paired;
for (const other of base.boundaryOccurrenceIds) for (const endpointMap of [[0,1],[1,0]]) {
  if (other === desired) continue;
  const r = addSeamPair(base, { id:'seam:1', edgeOccurrenceA:desired, edgeOccurrenceB:other, endpointMap });
  if (r.ok && compileBoard(r.definition).ok) { paired = r.draft; break; }
  if (paired) break;
}
assert.ok(paired, 'found a valid seam');
const original = structuredClone(paired);
let next = startBoundaryRing(paired); assert.ok(next.ok);
const hole = draw(next.draft, [[1,1],[2,1],[1,2]]);
assert.ok(hole.ok); assert.deepEqual(hole.removedSeams, []);
assert.equal(hole.draft.seamPairs.length, 1); assert.ok(compileBoard(hole.definition).ok);
assert.deepEqual(paired, original, 'editing the draft does not mutate the selected board');
const restored = deleteBoundaryRing(hole.draft, 1);
assert.ok(restored.ok); assert.equal(restored.draft.seamPairs.length, 1); assert.ok(compileBoard(restored.definition).ok);
next = startBoundaryRing(paired); assert.ok(next.ok);
const extension = draw(next.draft, [[0,0],[1,0],[1,-1]]);
assert.ok(extension.ok); assert.deepEqual(extension.removedSeams, ['seam:1']);
assert.equal(extension.draft.seamPairs.length, 0);
assert.deepEqual(paired, original);

console.log('PASS: seam preservation/removal and immutable draft');
