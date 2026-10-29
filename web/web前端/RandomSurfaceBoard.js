import { createCylinderBoardDefinition, createMobiusBoardDefinition, createTorusBoardDefinition, createKleinBottleBoardDefinition } from './BoardPresets.js?v=20261029-unified-r1';
import { compileBoard } from './BoardCompiler.js?v=20261029-unified-r1';
import { edgeOccurrenceId, undirectedKey } from './BoardDefinition.js?v=20261029-unified-r1';
import './TopologyGameEngine.js?v=20261029-unified-r1';
import { GameEngine } from './GameEngine.js?v=20261029-unified-r1';
import { analyzeBoardAlgebra } from './TopologyAlgebra.js?v=20261029-unified-r1';

// Annulus and cylinder are distinct presentations of the same surface class.
export const RANDOM_SURFACE_WEIGHTS_V4 = Object.freeze({ disk: 30, annulus: 15, 'planar-two-holes': 10, cylinder: 10, mobius: 8, torus: 12, klein: 5, sphere: 5, 'double-torus': 5 });
const GROUPS = Object.freeze({ disk: 30, 'two-boundaries': 25, 'planar-two-holes': 10, mobius: 8, torus: 12, klein: 5, sphere: 5, 'double-torus': 5 });
const PLAYERS = ['BLACK', 'WHITE', 'PURPLE', 'GREEN', 'ORANGE', 'CYAN'];
const EXPECTED = {
  disk: [1, true, 1], annulus: [0, true, 2], 'planar-two-holes': [-1, true, 3],
  cylinder: [0, true, 2], mobius: [0, false, 1], torus: [0, true, 0],
  klein: [0, false, 0], sphere: [2, true, 0], 'double-torus': [-2, true, 0],
};
const EXPECTED_BETTI = { disk: [1, 0, 0], annulus: [1, 1, 0], 'planar-two-holes': [1, 2, 0], cylinder: [1, 1, 0], mobius: [1, 1, 0], torus: [1, 2, 1], klein: [1, 2, 1], sphere: [1, 0, 1], 'double-torus': [1, 4, 1] };
const failure = (code, location, detail) => ({ ok: false, stats: { attempts: 0 }, errors: [{ code, location, detail }] });

function patch(gridSize, holes = [], trimFaces = []) {
  const d = createCylinderBoardDefinition({ gridSize });
  d.seamPairs = [];
  d.topology = { ...d.topology, family: 'planar', preset: holes.length ? `planar-${holes.length}-holes` : 'disk' };
  const removed = new Set([...holes, ...trimFaces]);
  d.faces = d.faces.filter(face => !removed.has(face.id));
  if (trimFaces.length) {
    const used = new Set(d.faces.flatMap(face => face.vertices));
    d.vertices = d.vertices.filter(vertex => used.has(vertex.id));
    d.startingVertices = { BLACK: 'v:1,0', WHITE: `v:${gridSize - 2},${gridSize - 2}` };
  }
  return d;
}

function chooseHoles(gridSize, count, random) {
  const candidates = [];
  for (let x = 1; x < gridSize - 2; x++) for (let y = 1; y < gridSize - 2; y++) candidates.push([x, y]);
  for (let i = candidates.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [candidates[i], candidates[j]] = [candidates[j], candidates[i]]; }
  if (count === 1) return [`u:${candidates[0].join(',')}`];
  for (let i = 0; i < candidates.length; i++) for (let j = i + 1; j < candidates.length; j++) {
    const corners = ([x, y]) => new Set([`${x},${y}`, `${x + 1},${y}`, `${x},${y + 1}`]);
    const left = corners(candidates[i]), right = corners(candidates[j]);
    if ([...left].every(key => !right.has(key))) return [candidates[i], candidates[j]].map(p => `u:${p.join(',')}`);
  }
  throw new Error('No disjoint interior holes');
}

function randomDisk(gridSize, random) {
  const d = patch(gridSize), width = gridSize - 1, minimum = Math.max(2, width - 2);
  const profile = Array.from({ length: width }, () => minimum + Math.floor(random() * (width - minimum + 1)));
  d.faces = d.faces.filter(face => {
    const match = /^[ud]:(\d+),(\d+)$/.exec(face.id);
    return match && Number(match[2]) < profile[Number(match[1])];
  });
  const used = new Set(d.faces.flatMap(face => face.vertices));
  d.vertices = d.vertices.filter(vertex => used.has(vertex.id));
  d.startingVertices = { BLACK: 'v:0,0', WHITE: `v:${width},0` };
  return d;
}

// Double a planar patch along all of its boundary edges. The copies have
// disjoint atlas coordinates but identical local coordinates and face winding.
export function createDoubleTorusBoardDefinition({ gridSize = 9, holeFaces = ['u:1,1', `u:${gridSize - 3},${gridSize - 3}`], trimFaces = [] } = {}) {
  if (!Number.isInteger(gridSize) || gridSize < 5 || gridSize > 15) throw new Error('gridSize must be 5 through 15');
  if (!Array.isArray(holeFaces) || holeFaces.length !== 2) throw new Error('Two disjoint interior holes are required');
  const corners = holeFaces.map(id => {
    const match = /^u:(\d+),(\d+)$/.exec(id);
    if (!match) throw new Error('Invalid hole face');
    const x = Number(match[1]), y = Number(match[2]);
    if (x < 1 || y < 1 || x >= gridSize - 2 || y >= gridSize - 2) throw new Error('Hole meets the outer boundary');
    return [`${x},${y}`, `${x + 1},${y}`, `${x},${y + 1}`];
  });
  if (corners[0].some(id => corners[1].includes(id))) throw new Error('Hole closures must be disjoint');
  const allowedTrim = new Set(['u:0,0', `d:${gridSize - 2},${gridSize - 2}`]);
  if (!Array.isArray(trimFaces) || new Set(trimFaces).size !== trimFaces.length || trimFaces.some(id => !allowedTrim.has(id))) throw new Error('Invalid outer corner trim');
  return doublePatch(gridSize, holeFaces, 'double-torus', trimFaces);
}

export function createDoubleSphereBoardDefinition({ gridSize = 9 } = {}) {
  if (!Number.isInteger(gridSize) || gridSize < 5 || gridSize > 15) throw new Error('gridSize must be 5 through 15');
  return doublePatch(gridSize, [], 'double-sphere');
}

function doublePatch(gridSize, holeFaces, preset, trimFaces = []) {
  const d = patch(gridSize, holeFaces, trimFaces), back = 'back:', offset = gridSize + 1;
  const occurrences = new Map();
  for (const face of d.faces) for (let i = 0; i < 3; i++) {
    const key = undirectedKey(face.vertices[i], face.vertices[(i + 1) % 3]);
    const entries = occurrences.get(key) ?? [];
    entries.push(edgeOccurrenceId(face.id, i)); occurrences.set(key, entries);
  }
  d.vertices.push(...d.vertices.map(v => ({ id: back + v.id, coordinate: [v.coordinate[0] + offset, v.coordinate[1]] })));
  d.faces.push(...d.faces.map(f => ({ id: back + f.id, vertices: f.vertices.map(id => back + id) })));
  d.seamPairs = [...occurrences.values()].filter(entries => entries.length === 1).map(([id], index) => ({
    id: `double:${index}`, edgeOccurrenceA: id, edgeOccurrenceB: back + id, endpointMap: [0, 1],
  }));
  d.topology = { ...d.topology, family: 'surface', preset };
  return d;
}

function template(kind, gridSize, random = null) {
  const holes = count => random ? chooseHoles(gridSize, count, random) : ['u:1,1', `u:${gridSize - 3},${gridSize - 3}`].slice(0, count);
  const trims = () => random ? ['u:0,0', `d:${gridSize - 2},${gridSize - 2}`].filter(() => random() < 0.5) : [];
  switch (kind) {
    case 'disk': return random ? randomDisk(gridSize, random) : patch(gridSize);
    case 'annulus': return patch(gridSize, holes(1), trims());
    case 'planar-two-holes': return patch(gridSize, holes(2), trims());
    case 'cylinder': return createCylinderBoardDefinition({ gridSize });
    case 'mobius': return createMobiusBoardDefinition({ gridSize });
    case 'torus': return createTorusBoardDefinition({ gridSize });
    case 'klein': return createKleinBottleBoardDefinition({ gridSize });
    case 'sphere': return createDoubleSphereBoardDefinition({ gridSize });
    case 'double-torus': return createDoubleTorusBoardDefinition({ gridSize, holeFaces: holes(2), trimFaces: trims() });
  }
}

export function isRandomSurfaceManifold(board, kind) {
  const expected = EXPECTED[kind];
  if (!expected || !board.vertexLinks.every(v => v.manifold)
    || board.eulerCharacteristic !== expected[0] || board.orientable !== expected[1]
    || board.boundaryComponents.length !== expected[2]
    || board.edgeClasses.some(e => e.occurrences.length < 1 || e.occurrences.length > 2)) return false;
  const visited = new Set(), queue = [board.sampleIds[0]];
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]; if (visited.has(id)) continue; visited.add(id);
    for (const next of board.sampleAdjacency[id]) if (!visited.has(next)) queue.push(next);
  }
  if (visited.size !== board.sampleIds.length) return false;
  const degree = new Map();
  for (const edge of board.edgeClasses) if (edge.occurrences.length === 1) for (const id of edge.canonicalVertices) degree.set(id, (degree.get(id) ?? 0) + 1);
  return [...degree.values()].every(n => n === 2);
}

function graphDistances(board, start) {
  const distances = new Map([[start, 0]]), queue = [start];
  for (let i = 0; i < queue.length; i++) for (const next of board.sampleAdjacency[queue[i]]) {
    if (!distances.has(next)) { distances.set(next, distances.get(queue[i]) + 1); queue.push(next); }
  }
  return distances;
}

function layout(definition, base, count, distance, random) {
  const candidates = base.sampleIds, chosen = [candidates[Math.floor(random() * candidates.length)]], maps = [graphDistances(base, chosen[0])];
  while (chosen.length < count) {
    let best = -1, choices = [];
    for (const id of candidates) {
      if (chosen.includes(id)) continue;
      const d = Math.min(...maps.map(m => m.get(id) ?? -1));
      if (d > best) { best = d; choices = [id]; } else if (d === best) choices.push(id);
    }
    if (best < distance || !choices.length) return null;
    const next = choices[Math.floor(random() * choices.length)]; chosen.push(next); maps.push(graphDistances(base, next));
  }
  const source = new Map(base.canonicalVertices.map(v => [v.id, v.sourceVertexIds[0]]));
  const result = { ...definition, startingVertices: Object.fromEntries(chosen.map((id, i) => [PLAYERS[i], source.get(id)])) };
  const compiled = compileBoard(result);
  if (!compiled.ok) return null;
  const game = new GameEngine({ compiledBoard: compiled.value, playerCount: count, deferTerritoryUpdates: true });
  // Check each seat against the real rules, not only graph spacing.
  if (!PLAYERS.slice(0, count).every(player => compiled.value.sampleIds.some(id => game._evaluateMove(id, player).legal))) return null;
  return result;
}

const viabilityCache = new Map();
function feasibility(kind, settings, prng) {
  const key = `${kind}:${settings.gridSize}:${settings.playerCount}:${settings.minStartDistance}`;
  if (viabilityCache.has(key)) return viabilityCache.get(key);
  const d = template(kind, settings.gridSize), compiled = compileBoard(d);
  if (!compiled.ok || !isRandomSurfaceManifold(compiled.value, kind)) { viabilityCache.set(key, null); return null; }
  const random = prng(`v4-feasibility:${key}`);
  let witness = null;
  for (let i = 0; i < 32 && !witness; i++) witness = layout(d, compiled.value, settings.playerCount, settings.minStartDistance, random);
  const value = witness ? { definition: d, board: compiled.value } : null;
  viabilityCache.set(key, value); return value;
}

export function generateRandomSurfaceBoard(options, seed, createPrng) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return failure('INVALID_OPTIONS', 'options', 'options must be an object');
  const settings = { gridSize: options.gridSize ?? 9, playerCount: options.playerCount ?? 2, minStartDistance: options.minStartDistance ?? 2, maxAttempts: options.maxAttempts ?? 24 };
  if (!Number.isInteger(settings.gridSize) || settings.gridSize < 5 || settings.gridSize > 15) return failure('INVALID_GRID_SIZE', 'options.gridSize', 'gridSize must be 5 through 15');
  if (!Number.isInteger(settings.playerCount) || settings.playerCount < 2 || settings.playerCount > 6) return failure('INVALID_PLAYER_COUNT', 'options.playerCount', 'playerCount must be 2 through 6');
  if (!Number.isInteger(settings.minStartDistance) || settings.minStartDistance < 1) return failure('INVALID_MIN_START_DISTANCE', 'options.minStartDistance', 'minStartDistance must be positive');
  if (!Number.isInteger(settings.maxAttempts) || settings.maxAttempts < 0 || settings.maxAttempts > 256) return failure('INVALID_MAX_ATTEMPTS', 'options.maxAttempts', 'maxAttempts must be 0 through 256');
  if (!settings.maxAttempts) return failure('ATTEMPT_BUDGET_EXHAUSTED', 'options.maxAttempts', 'no attempts were permitted');
  const tested = Object.keys(RANDOM_SURFACE_WEIGHTS_V4).map(kind => [kind, feasibility(kind, settings, createPrng)]);
  const eligible = tested.filter(([, value]) => value);
  const excluded = Object.fromEntries(tested.filter(([, value]) => !value).map(([kind]) => [kind, 'no validated opening or surface found within the bounded feasibility search']));
  if (!eligible.length) return failure('NO_FEASIBLE_SURFACE', 'options', 'no supported category has a validated opening');
  const supported = new Map(eligible), groups = Object.entries(GROUPS).filter(([group]) => group === 'two-boundaries' ? supported.has('annulus') || supported.has('cylinder') : supported.has(group));
  const random = createPrng(`${seed}:random-board-v4`), total = groups.reduce((sum, [, weight]) => sum + weight, 0);
  let choice = random() * total, group = groups[groups.length - 1][0];
  for (const [name, weight] of groups) { choice -= weight; if (choice < 0) { group = name; break; } }
  let category = group;
  if (group === 'two-boundaries') {
    if (!supported.has('annulus')) category = 'cylinder';
    else if (!supported.has('cylinder')) category = 'annulus';
    else category = random() < 0.6 ? 'annulus' : 'cylinder';
  }
  const selected = [category, supported.get(category)];
  const [kind] = selected;
  for (let attempt = 1; attempt <= settings.maxAttempts; attempt++) {
    const candidate = template(kind, settings.gridSize, random);
    const candidateBoard = compileBoard(candidate);
    if (!candidateBoard.ok || !isRandomSurfaceManifold(candidateBoard.value, kind)) continue;
    const definition = layout(candidate, candidateBoard.value, settings.playerCount, settings.minStartDistance, random);
    if (!definition) continue;
    const faceIds = new Set(candidate.faces.map(face => face.id));
    const holeFaces = kind === 'double-torus' ? Array.from({ length: settings.gridSize - 3 }, (_, x) => Array.from({ length: settings.gridSize - 3 }, (_, y) => `u:${x + 1},${y + 1}`)).flat().filter(id => !faceIds.has(id)) : null;
    const trimFaces = kind === 'double-torus' ? ['u:0,0', `d:${settings.gridSize - 2},${settings.gridSize - 2}`].filter(id => !faceIds.has(id)) : null;
    definition.generator = { generatorVersion: 'random-board-v4', seed, attempt, options: settings, category: kind, categoryWeights: RANDOM_SURFACE_WEIGHTS_V4, eligibleCategories: eligible.map(([name]) => name), excludedCategories: excluded, ...(holeFaces ? { holeFaces, trimFaces } : {}) };
    const compiled = compileBoard(definition);
    if (!compiled.ok || !isRandomSurfaceManifold(compiled.value, kind)) continue;
    const algebra = analyzeBoardAlgebra(compiled.value);
    if (!algebra.chainCondition || !algebra.surface.manifold || !algebra.surface.connected || algebra.betti.some((b, i) => b !== EXPECTED_BETTI[kind][i])) continue;
    return { ok: true, definition: compiled.value.definition, boardHash: compiled.value.boardHash, stats: { attempts: attempt, category: kind, eligibleCategories: eligible.map(([name]) => name), excludedCategories: excluded, eulerCharacteristic: compiled.value.eulerCharacteristic, orientable: compiled.value.orientable, boundaryCount: compiled.value.boundaryComponents.length, betti: algebra.betti }, errors: [] };
  }
  return { ok: false, stats: { attempts: settings.maxAttempts, category: kind }, errors: [{ code: 'ATTEMPT_BUDGET_EXHAUSTED', location: 'generator', detail: 'selected surface category failed its bounded retries' }] };
}
