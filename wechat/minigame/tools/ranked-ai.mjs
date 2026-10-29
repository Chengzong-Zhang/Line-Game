// Authoritative AI reuses the compatibility checks, models and algorithms of practice.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomInt } from 'node:crypto';
import { executeTask } from '../src/worker-runtime.js';
import { rankedSetupInput } from '../src/ranked-setup.js';
import { controllerChoices, playerIds } from '../src/controllers.js';
import { randomInitialPositions, resolveInitialPositions } from '../src/core.js';
import { modelForProfile } from '../src/model-catalog.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const digest = value => createHash('sha256').update(value).digest('hex');
const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(k => [k, ordered(value[k])])) : value;
let fingerprint;
export async function runtimeFingerprint() {
  if (!fingerprint) fingerprint = (async () => {
    const files = new Map();
    async function visit(file) {
      file = path.resolve(file);
      if (files.has(file)) return;
      if (!file.startsWith(root + path.sep)) throw Error('INVALID_AI_DEPENDENCY');
      const data = await fs.readFile(file); files.set(file, data);
      if (!file.endsWith('.json')) for (const match of data.toString().matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g))
        await visit(path.resolve(path.dirname(file), match[1].split('?')[0]));
    }
    await visit(fileURLToPath(import.meta.url));
    return digest([...files].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([name, data]) =>
      path.relative(root, name).split(path.sep).join('/') + ':' + digest(data)).join('\n'));
  })();
  return fingerprint;
}

export async function prepareRankedMatch(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw Error('INVALID_SETTINGS');
  let input;
  if (Object.keys(request).length === 1 && typeof request.profile === 'string') {
    input = rankedSetupInput({ gridSize: 7, playerCount: 2, boardShape: 'triangle' }, { BLACK: 'human', WHITE: request.profile });
  } else {
    if (Object.keys(request).sort().join(',') !== 'controllers,settings' || !request.settings) throw Error('INVALID_SETTINGS');
    const allowed = ['gridSize', 'playerCount', 'boardShape', 'startPlayer', 'startingPointMode', 'rulesVersion', 'protectionRule', 'initialPositions'];
    if (Object.keys(request.settings).some(key => !allowed.includes(key)) || request.settings.rulesVersion !== 'territory-v3') throw Error('INVALID_SETTINGS');
    input = rankedSetupInput(request.settings, request.controllers);
  }
  const { settings, controllers } = input;
  if (settings.startingPointMode === 'random') settings.initialPositions = randomInitialPositions(settings.gridSize,
    settings.playerCount, () => randomInt(0x100000000) / 0x100000000, settings.boardShape);
  if (settings.startingPointMode === 'custom') settings.initialPositions = resolveInitialPositions(settings.gridSize,
    settings.playerCount, settings.initialPositions, settings.boardShape);
  Object.assign(settings, { turnTimerEnabled: false, turnTimeLimitSeconds: 60, hintEnabled: false, hintMaxCount: 0,
    undoEnabled: false, undoMaxCount: 3 });
  const humanPlayer = playerIds(settings.playerCount).find(p => controllers[p] === 'human');
  const context = { version: 'ranked-context-v1', runtime: await runtimeFingerprint(),
    gridSize: settings.gridSize, playerCount: settings.playerCount, boardShape: settings.boardShape,
    startPlayer: settings.startPlayer, startingPointMode: settings.startingPointMode,
    rulesVersion: settings.rulesVersion, protectionRule: settings.protectionRule, humanPlayer, controllers,
    ...(settings.startingPointMode === 'custom' ? { initialPositions: settings.initialPositions } : {}) };
  const state = executeTask({ kind: 'STATE', payload: { settings, actions: [] } });
  return { settings, controllers, humanPlayer, context: { ...context, key: digest(JSON.stringify(ordered(context))) }, ...state };
}

export async function rankedReply(settings, actions, profile, expectedRuntime) {
  if (settings.rulesVersion !== 'territory-v3' || profile === 'human' || !controllerChoices(settings).includes(profile)) throw Error('INVALID_RANKED_AI');
  if (expectedRuntime && expectedRuntime !== await runtimeFingerprint()) throw Error('AI_VERSION_CHANGED');
  const entry = modelForProfile(profile);
  let model;
  if (entry) {
    const bytes = await fs.readFile(path.join(root, 'wechat/minigame', entry.sourcePath));
    model = { id: entry.id, raw: new Uint8Array(bytes).buffer };
  }
  const result = await executeTask({ kind: 'AI', payload: { settings, actions, profile, ...(model ? { model } : {}) } });
  if (!playerIds(settings.playerCount).includes(result.player) || !Array.isArray(result.moves)) throw Error('INVALID_AI_REPLY');
  const aiAction = result.moves[0]?.point ? { type: 'move', point: result.moves[0].point, player: result.player }
    : { type: 'skip', player: result.player };
  return { ...executeTask({ kind: 'APPLY', payload: { settings, actions, action: aiAction } }), aiAction };
}
