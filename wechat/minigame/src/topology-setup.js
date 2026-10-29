import {
  addBoundaryVertex,
  addSeamPair,
  compileBoard,
  createBoardDraft,
  createSurfacePreset,
  generateBoard,
  closeBoundaryDraft,
  undoBoundaryVertex,
} from './core.js';
import { createTopologyStartingDefinition, topologyStartingRoots } from './topology/TopologyStartingPoints.js';
import { createDoubleTorusBoardDefinition, createDoubleSphereBoardDefinition } from './topology/RandomSurfaceBoard.js';

export const TOPOLOGY_SETUP_CONTRACT_VERSION = 'board-topology-v1';

const copyJson = (value) => value == null ? value : JSON.parse(JSON.stringify(value));

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
    ...changes,
  };
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
  const base = freshSetup({ draft, mode: 'definition', defaultDefinition: copyJson(options.definition) });
  const result = compileDefinition(base, options.definition, { mode: 'definition' });
  return result.ok ? result.setup : result.setup;
}

export function addTopologyBoundaryVertex(setup, coordinate) {
  if (!setup?.draft) return failure(setup ?? freshSetup(), 'NO_CUSTOM_DRAFT', 'A custom draft is required.');
  const result = addBoundaryVertex(setup.draft, coordinate);
  if (!result.ok) return failure(setup, result.code, result.detail);
  return { ok: true, setup: { ...setup, mode: 'custom', draft: result.draft, definition: null, compiled: null,
    boardHash: null, selectedBoundaryOccurrenceIds: [], errors: [] } };
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
  return { ok: true, setup: { ...setup, mode: 'custom', draft: result.draft, definition: null, compiled: null,
    boardHash: null, selectedBoundaryOccurrenceIds: [], errors: [] } };
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
  const compiled = compileBoard(closed.definition);
  if (!compiled.ok) return { ok: false, setup: { ...setup, errors: copyJson(compiled.errors) }, errors: copyJson(compiled.errors) };
  const draft = {
    ...closed.draft,
    boundaryOccurrenceIds: boundaryOccurrenceIds(compiled.value),
    candidateDefinition: copyJson(closed.definition),
  };
  return { ok: true, setup: settled(setup, compiled.value, closed.definition, {
    mode: 'custom', draft, selectedBoundaryOccurrenceIds: [], random: null, defaultDefinition: copyJson(closed.definition),
  }), compiled: compiled.value };
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
  const seamPair = {
    id: `wx-seam:${setup.draft.seamPairs.length}`,
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
    draft, selectedBoundaryOccurrenceIds: [], defaultDefinition: copyJson(added.definition),
  }), compiled: compiled.value };
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
    return compileDefinition(setup, definition);
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
  return changeTopologyStarts(setup, { mode: 'custom', playerCount, roots });
}

/** Return a plain complete definition plus its compiled board identity for game creation. */
export function topologySetupResult(setup) {
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
