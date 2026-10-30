import {
  addBoundaryVertex,
  addSeamPair,
  compileBoard,
  createBoardDraft,
  createSurfacePreset,
  generateBoard,
  closeBoundaryDraft,
  undoBoundaryVertex,
  startBoundaryRing,
  deleteBoundaryRing,
  createLegacyBoardDefinition,
  resolveInitialPositions,
} from './core.js';
import { createTopologyStartingDefinition, topologyStartingRoots } from './topology/TopologyStartingPoints.js';
import { createDoubleTorusBoardDefinition, createDoubleSphereBoardDefinition } from './topology/RandomSurfaceBoard.js';

export const TOPOLOGY_SETUP_CONTRACT_VERSION = 'board-topology-v1';

const copyJson = (value) => value == null ? value : JSON.parse(JSON.stringify(value));

/** Chart-only adapter for editing ordinary boards; this does not change their game rules. */
export function createTopologyEditorLegacyDefinition({ gridSize = 5, boardShape = 'triangle', playerCount = 2, initialRoots = null } = {}) {
  if (!Number.isInteger(gridSize) || gridSize < 3 || !['triangle', 'hexagon', 'diamond'].includes(boardShape))
    throw new Error('Invalid ordinary board shape or size.');
  let definition;
  if (boardShape !== 'diamond') definition = createLegacyBoardDefinition({ gridSize, boardShape });
  else {
    const vertices = [], faces = [];
    const id = (x, y) => `v:${x},${y}`;
    for (let y = 0; y < gridSize; y++) for (let x = 0; x < gridSize; x++) vertices.push({ id: id(x, y), coordinate: [x, y] });
    for (let y = 0; y < gridSize - 1; y++) for (let x = 0; x < gridSize - 1; x++) {
      faces.push({ id: `u:${x},${y}`, vertices: [id(x,y), id(x+1,y), id(x,y+1)] });
      faces.push({ id: `d:${x},${y}`, vertices: [id(x+1,y), id(x+1,y+1), id(x,y+1)] });
    }
    definition = { schemaVersion: 1, coordinateSystem: 'triangular-axial-v1',
      topology: { family: 'planar', movementStrategy: 'simple-rays-v1', territoryStrategy: 'surface-discrete-v1',
        specialVertexPolicy: 'stop', preset: 'legacy-diamond' }, vertices, faces, seamPairs: [], scoring: { strategy: 'canonical-vertices-v1' } };
  }
  const roots = initialRoots ?? Object.fromEntries(Object.entries(resolveInitialPositions(gridSize, playerCount, null, boardShape))
    .map(([player, coordinate]) => [player, [coordinate]]));
  definition.startingVertices = Object.fromEntries(Object.entries(roots).map(([player, coordinates]) => {
    if (!Array.isArray(coordinates) || !coordinates.length || coordinates.some(c => !Array.isArray(c) || c.length !== 2 || !c.every(Number.isInteger)))
      throw new Error(`Invalid roots for ${player}.`);
    const ids = coordinates.map(([x, y]) => `v:${x},${y}`);
    return [player, ids.length === 1 ? ids[0] : ids];
  }));
  const checked = compileBoard(definition);
  if (!checked.ok) throw new Error(`Invalid ordinary board roots: ${checked.errors.map(e => e.code).join(', ')}`);
  return definition;
}

function setupError(code, detail) {
  return { code, detail };
}

function boundaryOccurrenceIds(compiled) {
  return compiled.edgeClasses
    .filter((edgeClass) => edgeClass.occurrences.length === 1)
    .flatMap((edgeClass) => edgeClass.occurrences.map((occurrence) => occurrence.id));
}

function freshSetup(changes = {}) {
  return {
    contractVersion: TOPOLOGY_SETUP_CONTRACT_VERSION,
    mode: 'custom',
    draft: createBoardDraft(),
    definition: null,
    defaultDefinition: null,
    compiled: null,
    boardHash: null,
    selectedBoundaryOccurrenceIds: [],
    seamReverse: false,
    random: null,
    errors: [],
    warnings: [],
    geometryChanged: false,
    ...changes,
  };
}

// Recover chart contours from the face mesh, including edges that have been
// glued. These are source coordinates, not the quotient's canonical vertices.
function contoursFromDefinition(definition) {
  if (definition.editorBoundaries?.length) return copyJson(definition.editorBoundaries);
  const vertices = new Map((definition.vertices ?? []).map(v => [v.id, v.coordinate]));
  const edges = new Map();
  for (const face of definition.faces ?? []) for (let i = 0; i < 3; i++) {
    const a = face.vertices[i], b = face.vertices[(i + 1) % 3], key = [a, b].sort().join('|');
    const entry = edges.get(key) ?? { a, b, count: 0 }; entry.count++; edges.set(key, entry);
  }
  const remaining = [...edges.values()].filter(e => e.count === 1);
  const rings = [];
  while (remaining.length) {
    const edge = remaining.pop(), ids = [edge.a, edge.b];
    while (ids[ids.length - 1] !== ids[0]) {
      const end = ids[ids.length - 1];
      const index = remaining.findIndex(e => e.a === end || e.b === end);
      if (index < 0 || ids.length > edges.size + 1) return null;
      const next = remaining.splice(index, 1)[0]; ids.push(next.a === end ? next.b : next.a);
    }
    ids.pop();
    if (ids.length < 3 || ids.some(id => !vertices.has(id))) return null;
    rings.push(ids.map(id => [...vertices.get(id)]));
  }
  return rings.length ? rings : null;
}

function draftFromDefinition(definition, compiled) {
  const rings = contoursFromDefinition(definition);
  if (!rings) return null;
  const draft = createBoardDraft({ topology: definition.topology, scoring: definition.scoring });
  return { ...draft, rings, path: copyJson(rings[rings.length - 1]), closed: true,
    seamPairs: copyJson(definition.seamPairs ?? []), candidateDefinition: copyJson(definition),
    boundaryOccurrenceIds: boundaryOccurrenceIds(compiled) };
}

// Carry source roots by their chart coordinate across a contour or seam edit.
// A vanished or merged root is never silently replaced with a default root.
function preserveRoots(previous, definition) {
  const oldVertices = new Map((previous?.vertices ?? []).map(v => [v.id, v.coordinate.join(',')]));
  const newVertices = new Map((definition.vertices ?? []).map(v => [v.coordinate.join(','), v.id]));
  const startingVertices = {}, removedRoots = [];
  for (const [player, raw] of Object.entries(previous?.startingVertices ?? {})) {
    const values = Array.isArray(raw) ? raw : [raw], kept = [];
    for (const id of values) {
      const next = newVertices.get(oldVertices.get(id));
      if (next) kept.push(next); else removedRoots.push({ player, vertexId: id });
    }
    if (kept.length) startingVertices[player] = kept.length === 1 ? kept[0] : kept;
  }
  if (Object.keys(startingVertices).length) definition.startingVertices = startingVertices;
  return removedRoots;
}

function finishGeometryEdit(setup, edit) {
  if (!edit.ok) return failure(setup, edit.code, edit.detail);
  const warnings = [...(edit.removedSeams ?? []).map(id => setupError('REMOVED_SEAM', id))];
  if (!edit.definition) {
    const roots = Object.entries(setup.definition?.startingVertices ?? {}).flatMap(([player, value]) =>
      (Array.isArray(value) ? value : [value]).map(vertexId => setupError('REMOVED_ROOT', `${player}: ${vertexId}`)));
    return { ok: true, setup: { ...setup, mode: 'custom', draft: edit.draft, definition: null, compiled: null,
      boardHash: null, geometryChanged: true, selectedBoundaryOccurrenceIds: [], errors: [], warnings: [...warnings, ...roots] } };
  }
  const definition = copyJson(edit.definition);
  for (const root of preserveRoots(setup.definition, definition)) warnings.push(setupError('REMOVED_ROOT', `${root.player}: ${root.vertexId}`));
  const compiled = compileBoard(definition);
  if (!compiled.ok) return { ok: false, setup: { ...setup, errors: copyJson(compiled.errors) }, errors: copyJson(compiled.errors) };
  const draft = { ...edit.draft, candidateDefinition: copyJson(definition), boundaryOccurrenceIds: boundaryOccurrenceIds(compiled.value) };
  return { ok: true, setup: settled(setup, compiled.value, definition, { mode: 'custom', draft, geometryChanged: true,
    warnings, selectedBoundaryOccurrenceIds: [], random: null }), compiled: compiled.value };
}

function settled(setup, compiled, definition, changes = {}) {
  return {
    ...setup,
    definition: copyJson(definition),
    compiled,
    boardHash: compiled.boardHash,
    errors: [],
    ...changes,
  };
}

function failure(setup, code, detail) {
  return { ok: false, setup: { ...setup, errors: [setupError(code, detail)] }, errors: [setupError(code, detail)] };
}

function compileDefinition(setup, definition, changes = {}) {
  const compiled = compileBoard(definition);
  if (!compiled.ok) return { ok: false, setup: { ...setup, errors: copyJson(compiled.errors) }, errors: copyJson(compiled.errors) };
  return { ok: true, setup: settled(setup, compiled.value, definition, changes), compiled: compiled.value };
}

/** Create an immutable UI state for preset, random, or hand-drawn topology boards. */
export function createTopologySetup(options = {}) {
  const draft = createBoardDraft(options);
  if (!options.definition) return freshSetup({ draft });
  const base = freshSetup({ draft, mode: 'definition', defaultDefinition: copyJson(options.definition),
    requiredPlayers: Object.keys(options.definition.startingVertices ?? {}) });
  const result = compileDefinition(base, options.definition, { mode: 'definition' });
  if (result.ok) result.setup.draft = draftFromDefinition(options.definition, result.compiled);
  return result.ok ? result.setup : result.setup;
}

export function addTopologyBoundaryVertex(setup, coordinate) {
  if (!setup?.draft) return failure(setup ?? freshSetup(), 'NO_CUSTOM_DRAFT', 'A custom draft is required.');
  const result = addBoundaryVertex(setup.draft, coordinate);
  if (!result.ok) return failure(setup, result.code, result.detail);
  return { ok: true, setup: { ...setup, mode: 'custom', draft: result.draft,
    geometryChanged: true, selectedBoundaryOccurrenceIds: [], errors: [] } };
}

// Touch editing accepts straight lattice segments between tapped corners.
// The rule-facing draft still stores each unit edge, exactly like the Web editor.
export function extendTopologyBoundary(setup, coordinate, { close = false } = {}) {
  const path = setup?.draft?.path;
  if (!path?.length) return addTopologyBoundaryVertex(setup, coordinate);
  if (!Array.isArray(coordinate) || coordinate.length !== 2 || !coordinate.every(Number.isInteger)) {
    return failure(setup, 'INVALID_COORDINATE', 'Choose a grid point.');
  }
  const last = path[path.length - 1], dx = coordinate[0] - last[0], dy = coordinate[1] - last[1];
  if (!(dx === 0 || dy === 0 || dx === -dy) || (dx === 0 && dy === 0)) {
    return failure(setup, 'NON_LATTICE_EDGE', 'Follow a straight grid line.');
  }
  const length = Math.max(Math.abs(dx), Math.abs(dy)), step = [dx / length, dy / length];
  let next = setup;
  for (let i = 1; i <= length - (close ? 1 : 0); i++) {
    const result = addTopologyBoundaryVertex(next, [last[0] + i * step[0], last[1] + i * step[1]]);
    if (!result.ok) return { ...result, setup: { ...setup, errors: result.errors } };
    next = result.setup;
  }
  return close ? closeTopologyBoundary(next) : { ok: true, setup: next };
}

export function undoTopologyBoundary(setup) {
  if (!setup?.draft) return failure(setup ?? freshSetup(), 'NO_CUSTOM_DRAFT', 'A custom draft is required.');
  const result = undoBoundaryVertex(setup.draft);
  if (!result.ok) return failure(setup, result.code, result.detail);
  if (result.definition) return finishGeometryEdit(setup, result);
  return { ok: true, setup: { ...setup, mode: 'custom', draft: result.draft,
    geometryChanged: true, selectedBoundaryOccurrenceIds: [], errors: [] } };
}

/**
 * Close a hand-drawn boundary, compile it, then derive the selectable boundary
 * occurrences from the actual compiler output.  We never infer these IDs from
 * the Canvas stroke or from the input coordinate order.
 */
export function closeTopologyBoundary(setup) {
  if (!setup?.draft) return failure(setup ?? freshSetup(), 'NO_CUSTOM_DRAFT', 'A custom draft is required.');
  const closed = closeBoundaryDraft(setup.draft);
  if (!closed.ok) return failure(setup, closed.code, closed.detail);
  return finishGeometryEdit(setup, closed);
}

export function startTopologyBoundaryRing(setup) {
  if (!setup?.draft) return failure(setup ?? freshSetup(), 'NO_CUSTOM_DRAFT', 'This board cannot be converted to editable contours.');
  const result = startBoundaryRing(setup.draft);
  if (!result.ok) return failure(setup, result.code, result.detail);
  return { ok: true, setup: { ...setup, draft: result.draft, errors: [], selectedBoundaryOccurrenceIds: [] } };
}

export function deleteTopologyBoundaryRing(setup, index) {
  if (!setup?.draft) return failure(setup ?? freshSetup(), 'NO_CUSTOM_DRAFT', 'No editable contour.');
  if (!setup.draft.closed) return failure(setup, 'OPEN_BOUNDARY', 'Close or undo the current contour before deleting another.');
  return finishGeometryEdit(setup, deleteBoundaryRing(setup.draft, index));
}

export function selectTopologyBoundaryOccurrence(setup, occurrenceId) {
  if (!setup?.compiled || typeof occurrenceId !== 'string') {
    return failure(setup ?? freshSetup(), 'INVALID_BOUNDARY_OCCURRENCE', 'Compile a custom board before choosing a seam edge.');
  }
  const valid = new Set(boundaryOccurrenceIds(setup.compiled));
  if (!valid.has(occurrenceId)) return failure(setup, 'INVALID_BOUNDARY_OCCURRENCE', occurrenceId);
  const current = setup.selectedBoundaryOccurrenceIds ?? [];
  let next;
  if (current.includes(occurrenceId)) next = current.filter((id) => id !== occurrenceId);
  else if (current.length < 2) next = [...current, occurrenceId];
  else next = [occurrenceId];
  return { ok: true, setup: { ...setup, selectedBoundaryOccurrenceIds: next, errors: [] } };
}

export function toggleTopologySeamDirection(setup) {
  if (!setup) return freshSetup({ seamReverse: true });
  return { ...setup, seamReverse: !setup.seamReverse, errors: [] };
}

export function addSelectedTopologySeam(setup) {
  if (!setup?.draft?.closed || !setup.definition || !setup.compiled) {
    return failure(setup ?? freshSetup(), 'BOARD_NOT_CLOSED', 'Close and compile the custom board before adding a seam.');
  }
  const selected = setup.selectedBoundaryOccurrenceIds ?? [];
  if (selected.length !== 2) return failure(setup, 'SEAM_SELECTION_INCOMPLETE', 'Choose exactly two boundary edge occurrences.');
  let seamIndex = 0;
  while (setup.draft.seamPairs.some(pair => pair.id === `wx-seam:${seamIndex}`)) seamIndex++;
  const seamPair = {
    id: `wx-seam:${seamIndex}`,
    edgeOccurrenceA: selected[0],
    edgeOccurrenceB: selected[1],
    endpointMap: setup.seamReverse ? [1, 0] : [0, 1],
  };
  const added = addSeamPair(setup.draft, seamPair);
  if (!added.ok) return failure(setup, added.code, added.detail);
  const compiled = compileBoard(added.definition);
  if (!compiled.ok) return { ok: false, setup: { ...setup, errors: copyJson(compiled.errors) }, errors: copyJson(compiled.errors) };
  const draft = {
    ...added.draft,
    boundaryOccurrenceIds: boundaryOccurrenceIds(compiled.value),
    candidateDefinition: copyJson(added.definition),
  };
  return { ok: true, setup: settled(setup, compiled.value, added.definition, {
    draft, selectedBoundaryOccurrenceIds: [], geometryChanged: true,
  }), compiled: compiled.value };
}

export function removeTopologySeam(setup, id) {
  if (!setup?.draft?.closed || !setup.definition) return failure(setup ?? freshSetup(), 'BOARD_NOT_CLOSED', 'Close the contour first.');
  const pairs = setup.draft.seamPairs.filter(pair => pair.id !== id);
  if (pairs.length === setup.draft.seamPairs.length) return failure(setup, 'INVALID_SEAM', String(id));
  const definition = copyJson(setup.definition); definition.seamPairs = copyJson(pairs);
  const compiled = compileBoard(definition);
  if (!compiled.ok) return { ok: false, setup: { ...setup, errors: copyJson(compiled.errors) }, errors: copyJson(compiled.errors) };
  const draft = { ...setup.draft, seamPairs: copyJson(pairs), candidateDefinition: copyJson(definition),
    boundaryOccurrenceIds: boundaryOccurrenceIds(compiled.value) };
  return { ok: true, setup: settled(setup, compiled.value, definition, { draft, geometryChanged: true,
    selectedBoundaryOccurrenceIds: [], warnings: [] }) };
}

// A click on an owned root removes it, another available point adds it.
// Move is atomic so the last root may be relocated without an invalid gap.
export function setTopologyRootAtVertex(setup, player, vertexId, options = {}) {
  const board = setup?.compiled;
  if (!board || !board.sampleIds.includes(vertexId)) return failure(setup ?? freshSetup(), 'UNKNOWN_START_VERTEX', String(vertexId));
  if (!['BLACK', 'WHITE', 'PURPLE', 'GREEN', 'ORANGE', 'CYAN'].includes(player)) return failure(setup, 'INVALID_START_PLAYER', String(player));
  const roots = topologyStartingRoots(board), own = [...(roots[player] ?? [])];
  if (Object.entries(roots).some(([other, values]) => other !== player && values.includes(vertexId)))
    return failure(setup, 'DUPLICATE_START_VERTEX', 'This point belongs to another player.');
  if (options.moveFrom != null) {
    const from = own.indexOf(options.moveFrom);
    if (from < 0) return failure(setup, 'UNKNOWN_START_VERTEX', String(options.moveFrom));
    if (own.includes(vertexId) && vertexId !== options.moveFrom) return failure(setup, 'DUPLICATE_START_VERTEX', 'This point already has a root.');
    own[from] = vertexId;
  } else if (own.includes(vertexId)) {
    if (own.length === 1) return failure(setup, 'LAST_START_ROOT', 'Every player must keep at least one root.');
    own.splice(own.indexOf(vertexId), 1);
  } else {
    if (own.length >= 6) return failure(setup, 'START_ROOTS_FULL', 'At most six roots per player.');
    own.push(vertexId);
  }
  roots[player] = own;
  const source = new Map(board.canonicalVertices.map(v => [v.id, v.sourceVertexIds[0]]));
  const definition = copyJson(setup.definition);
  definition.startingVertices = Object.fromEntries(Object.entries(roots).filter(([, ids]) => ids.length)
    .map(([p, ids]) => [p, ids.length === 1 ? source.get(ids[0]) : ids.map(id => source.get(id))]));
  const compiled = compileBoard(definition);
  if (!compiled.ok) return { ok: false, setup: { ...setup, errors: copyJson(compiled.errors) }, errors: copyJson(compiled.errors) };
  const draft = setup.draft ? { ...setup.draft, candidateDefinition: copyJson(definition) } : null;
  return { ok: true, setup: settled(setup, compiled.value, definition, { draft, warnings: setup.warnings ?? [] }) };
}

export function topologyEditorRootsByCoordinate(setup) {
  const board = setup?.compiled;
  if (!board) return {};
  const copies = new Map();
  for (const copy of board.atlas.pointCopies) if (!copies.has(copy.canonicalVertexId)) copies.set(copy.canonicalVertexId, [...copy.coordinate]);
  return Object.fromEntries(Object.entries(topologyStartingRoots(board)).map(([player, roots]) =>
    [player, roots.map(id => copies.get(id)).filter(Boolean)]));
}

export function useTopologyPreset(setup, name, options = {}) {
  let definition;
  try {
    definition = name === 'double-torus' ? createDoubleTorusBoardDefinition(options)
      : name === 'double-sphere' ? createDoubleSphereBoardDefinition(options) : createSurfacePreset(name, options);
    if (name === 'double-torus' || name === 'double-sphere') {
      const gridSize = options.gridSize ?? 9;
      definition.generator = { generatorVersion: 'surface-preset-v1', options: { gridSize },
        ...(name === 'double-torus' ? { holeFaces: options.holeFaces ?? ['u:1,1', `u:${gridSize - 3},${gridSize - 3}`], trimFaces: options.trimFaces ?? [] } : {}) };
    }
    if (options.playerCount) {
      const compiled = compileBoard(definition);
      if (!compiled.ok) return failure(setup ?? freshSetup(), 'INVALID_SURFACE_PRESET', 'Could not compile the board.');
      definition = createTopologyStartingDefinition(compiled.value, { playerCount: options.playerCount, mode: 'default' });
    }
  }
  catch (error) { return failure(setup ?? freshSetup(), 'INVALID_SURFACE_PRESET', error.message); }
  const base = { ...(setup ?? freshSetup()), mode: 'preset', draft: null, selectedBoundaryOccurrenceIds: [], random: null, defaultDefinition: copyJson(definition) };
  return compileDefinition(base, definition, { mode: 'preset' });
}

export function generateTopologyBoard(setup, options = {}, seed = 'topology-random') {
  const generated = generateBoard(options, seed);
  if (!generated.ok) return { ok: false, setup: { ...(setup ?? freshSetup()), errors: copyJson(generated.errors) },
    errors: copyJson(generated.errors), stats: copyJson(generated.stats) };
  const base = { ...(setup ?? freshSetup()), mode: 'random', draft: null, selectedBoundaryOccurrenceIds: [], defaultDefinition: copyJson(generated.definition) };
  const compiled = compileDefinition(base, generated.definition, {
    mode: 'random', random: { seed, generatorVersion: generated.definition.generator?.generatorVersion, stats: copyJson(generated.stats) },
  });
  return { ...compiled, stats: copyJson(generated.stats) };
}

export function changeTopologyStarts(setup, options) {
  if (!setup?.compiled) return failure(setup ?? freshSetup(), 'BOARD_NOT_READY', 'Create a board first.');
  try {
    const defaults = options?.mode === 'default' && setup.defaultDefinition ? compileBoard(setup.defaultDefinition) : null;
    if (defaults && !defaults.ok) return { ok: false, setup: { ...setup, errors: copyJson(defaults.errors) }, errors: copyJson(defaults.errors) };
    const definition = createTopologyStartingDefinition(defaults?.value ?? setup.compiled, options);
    const result = compileDefinition(setup, definition);
    if (result.ok) {
      if (result.setup.draft) result.setup.draft = { ...result.setup.draft, candidateDefinition: copyJson(definition) };
      result.setup.requiredPlayers = Object.keys(definition.startingVertices ?? {});
    }
    return result;
  } catch (error) {
    return failure(setup, error.code || 'INVALID_STARTING_LAYOUT', error.message);
  }
}

// Reopening an existing surface after changing seats must freeze the very same
// root layout that the engine will use. Retain every root of surviving seats.
export function reconcileTopologySetupPlayers(setup, playerCount) {
  if (!setup?.compiled) return { ok: true, setup };
  const players = ['BLACK', 'WHITE', 'PURPLE', 'GREEN', 'ORANGE', 'CYAN'].slice(0, playerCount);
  if (!Number.isInteger(playerCount) || playerCount < 2 || playerCount > 6) return failure(setup, 'INVALID_PLAYER_COUNT', 'Use two through six players.');
  const board = setup.compiled, previous = topologyStartingRoots(board);
  const roots = Object.fromEntries(players.filter(player => previous[player]?.length).map(player => [player, [...previous[player]]]));
  const claimed = new Set(Object.values(roots).flat());
  for (const player of players) {
    if (roots[player]) continue;
    const distance = new Map([...claimed].map(id => [id, 0])), queue = [...claimed];
    for (let i = 0; i < queue.length; i++) for (const next of board.sampleAdjacency[queue[i]] ?? []) {
      if (!distance.has(next)) { distance.set(next, distance.get(queue[i]) + 1); queue.push(next); }
    }
    let best = null, score = -1;
    for (const id of board.sampleIds) if (!claimed.has(id) && (distance.get(id) ?? Infinity) > score) {
      best = id; score = distance.get(id) ?? Infinity;
    }
    if (!best) return failure(setup, 'INSUFFICIENT_START_VERTICES', 'There are not enough unclaimed starting points.');
    roots[player] = [best]; claimed.add(best);
  }
  const result = changeTopologyStarts(setup, { mode: 'custom', playerCount, roots });
  if (result.ok) result.setup.requiredPlayers = players;
  return result;
}

/** Return a plain complete definition plus its compiled board identity for game creation. */
export function topologySetupResult(setup) {
  if (setup?.draft && !setup.draft.closed) return { ok: false, errors: [setupError('OPEN_BOUNDARY', 'Close the current contour before saving.')] };
  const roots = setup?.compiled ? topologyStartingRoots(setup.compiled) : {};
  const missing = (setup?.requiredPlayers ?? []).filter(player => !roots[player]?.length);
  if (missing.length) return { ok: false, errors: missing.map(player => setupError('MISSING_START_ROOT', player)) };
  if (!setup?.compiled || !setup.definition || typeof setup.boardHash !== 'string') {
    return { ok: false, errors: copyJson(setup?.errors ?? [setupError('BOARD_NOT_READY', 'Create a preset, random board, or closed custom boundary.')]) };
  }
  return {
    ok: true,
    definition: copyJson(setup.definition),
    boardHash: setup.boardHash,
    compiled: setup.compiled,
    mode: setup.mode,
    random: copyJson(setup.random),
  };
}
