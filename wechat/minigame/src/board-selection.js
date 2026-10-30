import { compileBoard } from './topology/BoardCompiler.js';
import { utf8Bytes } from './topology/PortableUtf8.js';

export const BOARD_SELECTION_STORAGE = 'lifeline-wx-board-selection-v2';
export const TOPOLOGY_PRESETS = Object.freeze([
  ['cylinder', '圆柱', 'Cylinder'], ['mobius', '莫比乌斯带', 'Möbius strip'],
  ['torus', '环面', 'Torus'], ['klein', '克莱因瓶', 'Klein bottle'],
  ['tetrahedron', '三角锥', 'Tetrahedron'], ['cone', '圆锥', 'Cone'],
  ['sphere', '球面', 'Sphere'], ['double-sphere', '双片球面', 'Two-chart sphere'],
  ['double-torus', '双把手', 'Double torus'],
]);
const clone = value => JSON.parse(JSON.stringify(value));

function normalize(value) {
  if (value?.schemaVersion !== 1 || !['ordinary', 'topology'].includes(value.kind)) throw new Error('INVALID_BOARD_SELECTION');
  if (value.kind === 'ordinary') {
    if (!['triangle', 'hexagon', 'diamond'].includes(value.shape)) throw new Error('INVALID_BOARD_SELECTION');
    return { schemaVersion: 1, kind: 'ordinary', shape: value.shape, expanded: Boolean(value.expanded) };
  }
  if (!Number.isInteger(value.size) || value.size < 5 || value.size > 15
      || !Number.isInteger(value.playerCount) || value.playerCount < 2 || value.playerCount > 6
      || ![...TOPOLOGY_PRESETS.map(row => row[0]), 'random', 'custom'].includes(value.preset)) throw new Error('INVALID_BOARD_SELECTION');
  const compiled = compileBoard(value.definition);
  if (!compiled.ok || compiled.value.boardHash !== value.boardHash) throw new Error('INVALID_BOARD_SELECTION');
  const players = ['BLACK', 'WHITE', 'PURPLE', 'GREEN', 'ORANGE', 'CYAN'].slice(0, value.playerCount);
  const controllers = Object.fromEntries(players.map(player => [player,
    ['human', 'topology-generic'].includes(value.controllers?.[player]) ? value.controllers[player] : 'human']));
  return { schemaVersion: 1, kind: 'topology', size: value.size, playerCount: value.playerCount,
    preset: value.preset, expanded: Boolean(value.expanded), controllers,
    definition: clone(compiled.value.definition), boardHash: compiled.value.boardHash };
}

export function readBoardSelection(storage) {
  try {
    const raw = storage?.get(BOARD_SELECTION_STORAGE);
    if (typeof raw !== 'string' || utf8Bytes(raw).length > 1100 * 1024) return null;
    return normalize(JSON.parse(raw));
  } catch (_) { return null; }
}

export function saveBoardSelection(storage, value) {
  const normalized = normalize(value), raw = JSON.stringify(normalized);
  if (utf8Bytes(raw).length > 1100 * 1024) throw new Error('BOARD_SELECTION_TOO_LARGE');
  storage.set(BOARD_SELECTION_STORAGE, raw);
  return normalized;
}
