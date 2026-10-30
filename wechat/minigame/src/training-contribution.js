import { modelForProfile } from './model-catalog.js';
import { controllerChoices, playerIds } from './controllers.js';
import { normalizePlayOptions } from './play-options.js';
import { normalizeGameSettings } from './state.js';
import { checksum } from './integrity.js';
import { CONTRIBUTION_V2_POLICY, CONTRIBUTION_V2_MAX_ACTIONS, normalizeV2Context,
  CONTRIBUTION_V3_POLICY, CONTRIBUTION_V3_MAX_ACTIONS, normalizeV3Context,
  CONTRIBUTION_V4_POLICY, CONTRIBUTION_V4_MAX_ACTIONS, normalizeV4Context } from '../../../web/tools/training_contribution_schema.mjs';

// CONTRIBUTION_POLICY remains the frozen v2 alias for existing callers.
export const CONTRIBUTION_POLICY = CONTRIBUTION_V2_POLICY;
export { CONTRIBUTION_V3_POLICY, CONTRIBUTION_V4_POLICY };
export const LEGACY_CONTRIBUTION_POLICY = 'anonymous-replay-training-v1';
export const CONTRIBUTION_STORAGE = 'lifeline-wx-training-contribution-v1';
export const CONTRIBUTION_NOTICE = '匿名棋谱贡献默认关闭，每次重新启动小游戏都需主动同意。开启后仅提交随后新开始并完整结束的本地对局：2–15 人的三角形、六边形或菱形棋盘（包括多起点），以及 2–6 人拓扑棋盘。上传内容包括棋盘定义、随机种子、完整动作与匿名玩法设置，也记录提示、计时和悔棋使用情况；不发送微信身份、昵称、头像或房间信息，服务器仍会接收连接所需的网络地址。当前局、恢复局、复盘、教学和联机对局不会上传。终局后自动后台上传；断网或服务未支持时保存在本机并有限重试。队列最多 100 局或 4 MiB，满时淘汰最早记录；单条新版棋谱最多 2 MiB，超限会提示。再次开启也会重试旧版待传棋谱。关闭会清空本机待传记录并停止提交，已收到的记录不会自动撤回。棋谱仅进入待审核区，不会自动训练或替换 AI。';
export const CONTRIBUTION_NOTICE_EN = 'Anonymous replay contribution is off by default and requires explicit consent after every Mini Game restart. Only local games newly started after consent and played to completion are submitted: triangle, hexagon and diamond boards for 2–15 players, including multiple roots, and topology boards for 2–6 players. The upload includes board definitions, random seeds, complete actions and anonymous settings, including hint, timer and undo usage. It excludes WeChat identity, nickname, avatar and room information; the server still receives the network address needed for the connection. Current, restored, replay, tutorial and online games are excluded. Completed games upload in the background; offline or unsupported-service records stay on this device with limited retries. The queue holds up to 100 games or 4 MiB and removes the oldest when full; each new-format upload is limited to 2 MiB and reports an oversize game. Enabling again also retries older pending records. Disabling clears the local queue and stops submissions; records already received are not withdrawn. Replays await review and never automatically train or replace an AI.';
export const CLEAR_PENDING_NOTICE = '当前网络或贡献服务不可用。确认后会清除本机全部待上传棋谱；已收到的记录不会撤回。';
export const CLEAR_PENDING_NOTICE_EN = 'The contribution service is unavailable. Confirm to clear every pending replay from this device. Records already received are not withdrawn.';
export const CONTRIBUTION_LIMITS = Object.freeze({ games: 100, queueBytes: 4 * 1024 * 1024, requestBytes: 2 * 1024 * 1024, automaticAttempts: 4 });
const MAX_QUEUE = CONTRIBUTION_LIMITS.games, MAX_ACTIONS = 512;
const clone = value => JSON.parse(JSON.stringify(value));
const stable = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const bytes = value => encodeURIComponent(JSON.stringify(value)).replace(/%[0-9A-F]{2}/g, 'x').length;
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const idPattern = /^sha256:[a-f0-9]{64}$/;
const usesLegacyProtection = settings => settings?.protectionRule === undefined || settings.protectionRule === 'symmetric-v1';
// Legacy contribution schemas cannot encode root-v2 or surface definitions.
// Reject them before creating a ticket as well as when completing the match.
const hasUnsupportedRootOrTopology = settings => settings && (
  (settings.rootMode !== undefined && settings.rootMode !== 'classic')
  || (settings.rootRulesVersion !== undefined && settings.rootRulesVersion !== 'root-v1')
  || ['initialRoots', 'boardDefinition', 'compiledBoard', 'boardHash', 'topologyProtocolVersion']
    .some(key => Object.prototype.hasOwnProperty.call(settings, key))
);

// v1 collector uses actors.*.kind, not a separate actor_kind field.
export function legacyContributionContext(session) {
  if (![2, 3].includes(session.settings.playerCount) || session.settings.boardShape && session.settings.boardShape !== 'triangle'
    || !usesLegacyProtection(session.settings)
    || session.settings.initialPositions || session.settings.startingPointMode && session.settings.startingPointMode !== 'default'
    || session.settings.undoEnabled || session.undoUsage?.usedCount) return null;
  const actors = {};
  for (const color of ['BLACK', 'WHITE', ...(session.settings.playerCount === 3 ? ['PURPLE'] : [])]) {
    const profile = session.controllerFor(color);
    if (profile === 'human') actors[color] = { kind: 'human' };
    else if (/^minimax-[234]$/.test(profile)) actors[color] = { kind: 'ai', strategy: 'minimax', depth: Number(profile.slice(-1)) };
    else {
      const model = modelForProfile(profile);
      // Greedy is a different algorithm and is not in the v1 collector schema.
      if (!model) return null;
      actors[color] = { kind: 'ai', strategy: model.research ? 'neural-puct' : 'model-free', modelId: model.id,
        ...(model.research ? { simulations: 16, cPuct: 1.5 } : {}) };
    }
  }
  return { source: 'local', actors, mixedProfiles: false,
    hintsEnabled: Boolean(session.settings.hintEnabled || session.hintsUsed) };
}

function sanitizeV1(settings, actions, context) {
  if (!settings || settings.rulesVersion !== 'territory-v2' || ![2, 3].includes(settings.playerCount)
    || !usesLegacyProtection(settings)
    || settings.boardShape && settings.boardShape !== 'triangle' || settings.initialPositions
    || settings.startingPointMode && settings.startingPointMode !== 'default' || settings.undoEnabled
    || !Number.isInteger(settings.gridSize) || settings.gridSize < 5 || settings.gridSize > 15
    || typeof settings.hintEnabled !== 'boolean' || typeof settings.turnTimerEnabled !== 'boolean'
    || !Number.isInteger(settings.hintMaxCount) || settings.hintMaxCount < 0 || settings.hintMaxCount > 100
    || !Number.isFinite(settings.turnTimeLimitSeconds) || settings.turnTimeLimitSeconds < 0 || settings.turnTimeLimitSeconds > 200) throw new Error('UNSUPPORTED');
  const players = ['BLACK', 'WHITE', ...(settings.playerCount === 3 ? ['PURPLE'] : [])];
  if (!players.includes(settings.startPlayer) || !Array.isArray(actions) || actions.length > MAX_ACTIONS
    || !exact(context, ['source', 'actors', 'mixedProfiles', 'hintsEnabled']) || context.source !== 'local'
    || context.mixedProfiles !== false || typeof context.hintsEnabled !== 'boolean'
    || (settings.hintEnabled && !context.hintsEnabled)
    || !exact(context.actors, players)) throw new Error('UNSUPPORTED');
  const actors = {};
  for (const color of players) {
    const actor = context.actors[color];
    if (settings.playerCount === 3 && actor?.kind !== 'human') throw new Error('UNSUPPORTED');
    if (exact(actor, ['kind']) && actor.kind === 'human') actors[color] = { kind: 'human' };
    else if (exact(actor, ['kind', 'strategy', 'depth']) && actor.kind === 'ai' && actor.strategy === 'minimax' && [2, 3, 4].includes(actor.depth)) actors[color] = clone(actor);
    else {
      const model = modelForProfile(`model:${actor?.modelId}`);
      const keys = model?.research ? ['kind', 'strategy', 'modelId', 'simulations', 'cPuct'] : ['kind', 'strategy', 'modelId'];
      if (!model || !exact(actor, keys) || actor.kind !== 'ai' || actor.strategy !== (model.research ? 'neural-puct' : 'model-free')
        || (model.research && (actor.simulations !== 16 || actor.cPuct !== 1.5))) throw new Error('UNSUPPORTED');
      actors[color] = clone(actor);
    }
  }
  const cleanActions = actions.map(action => {
    const type = action?.type, player = action?.player || action?.actor;
    if (!['move', 'skip', 'resign'].includes(type) || !players.includes(player)) throw new Error('INVALID_ACTION');
    if (type === 'move' && (!Array.isArray(action.point) || action.point.length !== 2 || !action.point.every(Number.isInteger))) throw new Error('INVALID_ACTION');
    return { type, player, ...(type === 'move' ? { point: [...action.point] } : {}) };
  });
  return { settings: Object.fromEntries(['rulesVersion', 'gridSize', 'playerCount', 'startPlayer', 'hintEnabled', 'hintMaxCount', 'turnTimerEnabled', 'turnTimeLimitSeconds'].map(key => [key, settings[key]])),
    actions: cleanActions, context: { source: 'local', actors, mixedProfiles: false, hintsEnabled: context.hintsEnabled } };
}

// Explicit profile ids preserve every shipped AI's actual identity. Resolved
// starting points and undo usage are gameplay metadata, never account fields.
export function contributionContext(session, version = 3) {
  try {
    const actors = Object.fromEntries(playerIds(session.settings.playerCount).map(player => {
      const profile = session.controllerFor(player);
      return [player, profile === 'human' ? { kind: 'human' } : { kind: 'ai', profile }];
    }));
    const options = normalizePlayOptions(session.settings);
    const context = { source: 'local', actors, mixedProfiles: false,
      hintsEnabled: Boolean(options.hintEnabled || session.hintsUsed),
      undo: { enabled: options.undoEnabled, maxCount: options.undoMaxCount, usedCount: session.undoUsage?.usedCount || 0 } };
    return (version === 4 ? sanitizeV4 : session.settings.rulesVersion === 'territory-v3' ? sanitizeV3 : sanitizeV2)(session.settings, [], context).context;
  } catch (_) { return null; }
}

function sanitizeV2(settings, actions, context) {
  if (!settings || settings.rulesVersion !== 'territory-v2' || !Number.isInteger(settings.gridSize)
    || hasUnsupportedRootOrTopology(settings)
    || !usesLegacyProtection(settings)
    || settings.gridSize < 5 || settings.gridSize > 15 || settings.playerCount > 6 || !playerIds(settings.playerCount).length) throw new Error('UNSUPPORTED');
  const players = playerIds(settings.playerCount), options = normalizePlayOptions(settings);
  const boardShape = settings.boardShape ?? (settings.playerCount >= 4 ? 'hexagon' : 'triangle');
  const startingPointMode = settings.startingPointMode ?? (settings.initialPositions ? 'custom' : 'default');
  if (!players.includes(settings.startPlayer) || !['triangle', 'hexagon'].includes(boardShape)
    || !['default', 'random', 'custom'].includes(startingPointMode)
    || !exact(context, ['source', 'actors', 'mixedProfiles', 'hintsEnabled', 'undo'])
    || context.source !== 'local' || context.mixedProfiles !== false || typeof context.hintsEnabled !== 'boolean'
    || (options.hintEnabled && !context.hintsEnabled) || !exact(context.actors, players)
    || !exact(context.undo, ['enabled', 'maxCount', 'usedCount']) || context.undo.enabled !== options.undoEnabled
    || context.undo.maxCount !== options.undoMaxCount || !Number.isInteger(context.undo.usedCount)
    || context.undo.usedCount < 0 || context.undo.usedCount > (options.undoEnabled ? options.undoMaxCount : 0)) throw new Error('UNSUPPORTED');
  const choices = controllerChoices({ ...settings, boardShape });
  const actors = Object.fromEntries(players.map(player => {
    const actor = context.actors[player];
    if (exact(actor, ['kind']) && actor.kind === 'human') return [player, { kind: 'human' }];
    if (!exact(actor, ['kind', 'profile']) || actor.kind !== 'ai' || actor.profile === 'human' || !choices.includes(actor.profile)) throw new Error('UNSUPPORTED');
    return [player, { kind: 'ai', profile: actor.profile }];
  }));
  let initialPositions;
  if (settings.initialPositions != null) {
    if (!exact(settings.initialPositions, players)) throw new Error('UNSUPPORTED');
    initialPositions = Object.fromEntries(players.map(player => {
      const point = settings.initialPositions[player];
      if (!Array.isArray(point) || point.length !== 2 || !point.every(value => Number.isInteger(value) && Math.abs(value) <= 30)) throw new Error('UNSUPPORTED');
      return [player, [...point]];
    }));
  } else if (startingPointMode !== 'default') throw new Error('UNSUPPORTED');
  if (!Array.isArray(actions) || actions.length > CONTRIBUTION_V2_MAX_ACTIONS) throw new Error('INVALID_ACTION');
  const cleanActions = actions.map(action => {
    const type = action?.type, player = action?.player || action?.actor;
    if (!['move', 'skip', 'resign'].includes(type) || !players.includes(player)) throw new Error('INVALID_ACTION');
    if (type === 'move' && (!Array.isArray(action.point) || action.point.length !== 2 || !action.point.every(Number.isInteger))) throw new Error('INVALID_ACTION');
    return { type, player, ...(type === 'move' ? { point: [...action.point] } : {}) };
  });
  return { settings: { rulesVersion: 'territory-v2', gridSize: settings.gridSize, playerCount: settings.playerCount,
    startPlayer: settings.startPlayer, boardShape, startingPointMode, ...options, ...(initialPositions ? { initialPositions } : {}) },
    actions: cleanActions, context: normalizeV2Context({ source: 'local', actors, mixedProfiles: false,
      hintsEnabled: context.hintsEnabled, undo: clone(context.undo) }, { ...settings, ...options, boardShape }) };
}
function sanitizeV3(settings, actions, context) {
  if (!settings || settings.rulesVersion !== 'territory-v3' || !Number.isInteger(settings.gridSize)
    || hasUnsupportedRootOrTopology(settings)
    || settings.gridSize < 5 || settings.gridSize > 15 || settings.playerCount > 6 || !playerIds(settings.playerCount).length) throw new Error('UNSUPPORTED');
  const players = playerIds(settings.playerCount), options = normalizePlayOptions(settings);
  const boardShape = settings.boardShape ?? (settings.playerCount >= 4 ? 'hexagon' : 'triangle');
  const startingPointMode = settings.startingPointMode ?? (settings.initialPositions ? 'custom' : 'default');
  if (!players.includes(settings.startPlayer) || !['triangle', 'hexagon'].includes(boardShape)
    || !['default', 'random', 'custom'].includes(startingPointMode)
    || !exact(context, ['source', 'actors', 'mixedProfiles', 'hintsEnabled', 'undo'])
    || context.source !== 'local' || context.mixedProfiles !== false || typeof context.hintsEnabled !== 'boolean'
    || (options.hintEnabled && !context.hintsEnabled) || !exact(context.actors, players)
    || !exact(context.undo, ['enabled', 'maxCount', 'usedCount']) || context.undo.enabled !== options.undoEnabled
    || context.undo.maxCount !== options.undoMaxCount || !Number.isInteger(context.undo.usedCount)
    || context.undo.usedCount < 0 || context.undo.usedCount > (options.undoEnabled ? options.undoMaxCount : 0)) throw new Error('UNSUPPORTED');
  const choices = controllerChoices({ ...settings, boardShape });
  const actors = Object.fromEntries(players.map(player => {
    const actor = context.actors[player];
    if (exact(actor, ['kind']) && actor.kind === 'human') return [player, { kind: 'human' }];
    if (!exact(actor, ['kind', 'profile']) || actor.kind !== 'ai' || actor.profile === 'human' || !choices.includes(actor.profile)) throw new Error('UNSUPPORTED');
    return [player, { kind: 'ai', profile: actor.profile }];
  }));
  let initialPositions;
  if (settings.initialPositions != null) {
    if (!exact(settings.initialPositions, players)) throw new Error('UNSUPPORTED');
    initialPositions = Object.fromEntries(players.map(player => {
      const point = settings.initialPositions[player];
      if (!Array.isArray(point) || point.length !== 2 || !point.every(value => Number.isInteger(value) && Math.abs(value) <= 30)) throw new Error('UNSUPPORTED');
      return [player, [...point]];
    }));
  } else if (startingPointMode !== 'default') throw new Error('UNSUPPORTED');
  if (!Array.isArray(actions) || actions.length > CONTRIBUTION_V3_MAX_ACTIONS) throw new Error('INVALID_ACTION');
  const cleanActions = actions.map(action => {
    const type = action?.type, player = action?.player || action?.actor;
    if (!['move', 'skip', 'resign'].includes(type) || !players.includes(player)) throw new Error('INVALID_ACTION');
    if (type === 'move' && (!Array.isArray(action.point) || action.point.length !== 2 || !action.point.every(Number.isInteger))) throw new Error('INVALID_ACTION');
    return { type, player, ...(type === 'move' ? { point: [...action.point] } : {}) };
  });
  return { settings: { rulesVersion: 'territory-v3', gridSize: settings.gridSize, playerCount: settings.playerCount,
    startPlayer: settings.startPlayer, boardShape, startingPointMode, ...options, ...(initialPositions ? { initialPositions } : {}) },
    actions: cleanActions, context: normalizeV3Context({ source: 'local', actors, mixedProfiles: false,
      hintsEnabled: context.hintsEnabled, undo: clone(context.undo) }, { ...settings, ...options, boardShape }) };
}
function sanitizeV4(settings, actions, context) {
  if (!settings || !['territory-v3', 'surface-v1'].includes(settings.rulesVersion)
    || !Number.isInteger(settings.gridSize) || settings.gridSize < 5 || settings.gridSize > 15
    || !playerIds(settings.playerCount).length || !playerIds(settings.playerCount).includes(settings.startPlayer)) throw new Error('UNSUPPORTED');
  const surface = settings.rulesVersion === 'surface-v1', options = normalizePlayOptions(settings);
  const keys = surface
    ? ['gridSize', 'playerCount', 'startPlayer', 'turnOrder', 'rulesVersion', 'boardShape', 'boardDefinition', 'boardHash', 'topologyProtocolVersion', 'rootMode', 'rootRulesVersion']
    : ['gridSize', 'playerCount', 'startPlayer', 'turnOrder', 'rulesVersion', 'boardShape', 'startingPointMode', 'initialPositions', 'rootMode', 'rootRulesVersion', 'initialRoots', 'protectionRule'];
  const cleanSettings = Object.fromEntries(keys.filter(key => settings[key] !== undefined).map(key => [key, clone(settings[key])]));
  Object.assign(cleanSettings, options);
  const normalized = normalizeGameSettings(cleanSettings);
  if (surface && (normalized.boardHash !== settings.boardHash || !settings.boardDefinition || settings.boardShape !== 'custom')) throw new Error('INVALID_TOPOLOGY');
  if (!surface && !['triangle', 'diamond', 'hexagon'].includes(normalized.boardShape ?? (settings.playerCount >= 4 ? 'hexagon' : 'triangle'))) throw new Error('INVALID_BOARD');
  const choices = surface ? ['human', 'topology-generic'] : controllerChoices(normalized);
  if (!Array.isArray(actions) || actions.length > CONTRIBUTION_V4_MAX_ACTIONS) throw new Error('INVALID_ACTION');
  const players = playerIds(settings.playerCount);
  const cleanActions = actions.map(action => {
    const type = action?.type, player = action?.player || action?.actor;
    if (!(surface ? ['move', 'skip', 'resign'] : ['move', 'skip', 'resign', 'root_relocate', 'root_add']).includes(type) || !players.includes(player)) throw new Error('INVALID_ACTION');
    if (surface && type === 'move') {
      if (typeof action.vertexId !== 'string' || !action.vertexId || action.point !== undefined) throw new Error('INVALID_ACTION');
      return { type, player, vertexId: action.vertexId };
    }
    if (['move', 'root_relocate', 'root_add'].includes(type)) {
      if (!Array.isArray(action.point) || action.point.length !== 2 || !action.point.every(Number.isInteger)) throw new Error('INVALID_ACTION');
      return { type, player, point: [...action.point] };
    }
    return { type, player };
  });
  if (!context?.actors || Object.values(context.actors).some(actor => actor?.kind === 'ai' && !choices.includes(actor.profile))) throw new Error('UNSUPPORTED');
  const cleanContext = normalizeV4Context(context, normalized);
  if (cleanContext.undo.enabled !== options.undoEnabled || cleanContext.undo.maxCount !== options.undoMaxCount) throw new Error('UNSUPPORTED');
  return { settings: normalized, actions: cleanActions, context: cleanContext };
}
const sanitize = (settings, actions, context, version) => version === 1 ? sanitizeV1(settings, actions, context)
  : version === 2 ? sanitizeV2(settings, actions, context)
    : version === 3 ? sanitizeV3(settings, actions, context) : version === 4 ? sanitizeV4(settings, actions, context) : (() => { throw new Error('UNSUPPORTED_VERSION'); })();
const policyForVersion = version => version === 1 ? LEGACY_CONTRIBUTION_POLICY
  : version === 2 ? CONTRIBUTION_V2_POLICY : version === 3 ? CONTRIBUTION_V3_POLICY : version === 4 ? CONTRIBUTION_V4_POLICY : null;
const signature = (clean, version) => stable({ settings: clean.settings, context: version === 1 ? clean.context
  : { ...clean.context, hintsEnabled: Boolean(clean.settings.hintEnabled), undo: { ...clean.context.undo, usedCount: 0 } } });
const isNativeTopologyReplay = document => document?.format === 'lifeline-topology-replay' && document.engineFamily === 'lifeline-topology-engine';
const documentTerminal = (document, version) => version === 4 && isNativeTopologyReplay(document)
  ? document.finalState?.topologyState?.ruleState?.gameOver === true : Boolean(document?.terminal);
const documentId = (document, version) => version === 4 && isNativeTopologyReplay(document)
  ? checksum(document) : document?.integrity?.canonicalDocumentHash;
const requestLimit = version => version === 4 ? CONTRIBUTION_LIMITS.requestBytes : 500000;
const queueLimit = version => version === 4 ? CONTRIBUTION_LIMITS.queueBytes : 768 * 1024;

export class TrainingContribution {
  constructor({ storage, request, origin, createReplay, onChange = () => {}, now = Date.now, version = 3,
    canRun = () => true, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    Object.assign(this, { storage, request, createReplay, onChange, now, version, canRun, setTimer, clearTimer });
    // No fallback to an arbitrary URL or authenticated account transport.
    this.origin = typeof origin === 'string' && /^https:\/\/[a-z0-9.-]+(?::443)?$/i.test(origin) ? origin : null;
    this.enabled = false; this.queue = []; this.received = []; this.status = 'off'; this.reason = null; this.generation = 0;
    this.active = false; this.transport = null; this.tickets = new WeakSet(); this.retryAt = 0;
    this.timer = null; this.foreground = true; this.connected = true; this.failures = 0; this.runEpoch = 0; this.disposed = false; this.dropped = 0;
    this.protocolSupportedUntil = new Map();
    this.itemKeys = new WeakMap(); this.itemSizes = new WeakMap();
    try {
      const raw = storage?.get(CONTRIBUTION_STORAGE);
      const saved = typeof raw === 'string' && raw.length < 4 * 1024 * 1024 + 65536 ? JSON.parse(raw) : null;
      if ([CONTRIBUTION_V4_POLICY, CONTRIBUTION_V3_POLICY, CONTRIBUTION_V2_POLICY, LEGACY_CONTRIBUTION_POLICY].includes(saved?.policy) && saved.enabled === true) {
        this.received = Array.isArray(saved.received) ? saved.received.filter(id => idPattern.test(id)).slice(-100) : [];
        for (const item of (Array.isArray(saved.queue) ? saved.queue : []).slice(-MAX_QUEUE)) {
          const itemVersion = item?.version ?? 1;
          if (![1, 2, 3, 4].includes(itemVersion) || !exact(item, item.version == null ? ['id', 'settings', 'actions', 'context'] : ['id', 'settings', 'actions', 'context', 'version'])
            || item.id !== null && !idPattern.test(item.id)) continue;
          try {
            const clean = sanitize(item.settings, item.actions, item.context, itemVersion);
            if (clean.actions.length && stable(clean) === stable({ settings: item.settings, actions: item.actions, context: item.context })
              && !this.received.includes(item.id) && !this.queue.some(row => item.id ? row.id === item.id : this.itemKey(row) === stable(clean))) {
              this.queue.push({ id: item.id, version: itemVersion, ...clean });
            }
          } catch (_) { /* Discard damaged or foreign records. */ }
        }
        // A failed opt-out write must never become silent permission on restart.
        // Recovery retains data, but every new launch requires active consent.
        this.trimQueue(); this.status = this.queue.length ? 'paused' : 'off'; this.reason = 'RESUME_CONSENT_REQUIRED';
      }
    } catch (_) { /* Storage is optional and cannot prevent play. */ }
  }
  snapshot() { return { enabled: this.enabled, pending: this.queue.length, status: this.status, reason: this.reason, dropped: this.dropped }; }
  stored() { return { policy: policyForVersion(this.version),
    enabled: this.enabled, queue: this.queue, received: this.received }; }
  itemKey(item) {
    if (!this.itemKeys.has(item)) this.itemKeys.set(item, stable({ settings: item.settings, actions: item.actions, context: item.context }));
    return this.itemKeys.get(item);
  }
  itemSize(item) {
    if (!this.itemSizes.has(item)) this.itemSizes.set(item, bytes(item));
    return this.itemSizes.get(item);
  }
  trimQueue() {
    let total = bytes({ ...this.stored(), queue: [] }) + this.queue.reduce((sum, item) => sum + this.itemSize(item) + 1, 0);
    while (this.queue.length > MAX_QUEUE || this.queue.length && total > queueLimit(this.version)) {
      total -= this.itemSize(this.queue.shift()) + 1; this.dropped++;
    }
  }
  save() {
    try { this.storage?.set(CONTRIBUTION_STORAGE, JSON.stringify(this.stored())); }
    catch (_) { if (this.enabled) this.status = 'storage-error'; else this.reason = 'OPT_OUT_STORAGE_FAILED'; }
    try { this.onChange(this.snapshot()); } catch (_) { /* UI cannot block play or cleanup. */ }
  }
  setEnabled(value) {
    if (this.enabled === (value === true) && (value === true || !this.queue.length)) return;
    this.generation++; this.enabled = value === true; this.tickets = new WeakSet();
    this.reason = null; this.failures = 0; this.retryAt = 0; this.cancelTimer();
    if (!this.enabled) {
      this.queue = []; this.received = []; try { this.transport?.abort(); } catch (_) {}
      try { this.storage?.remove?.(CONTRIBUTION_STORAGE); } catch (_) { /* save below is the fallback. */ }
    }
    this.status = this.enabled ? this.queue.length ? 'pending' : 'ready' : 'off'; this.save(); this.wake();
  }
  beginMatch({ settings, context, source, actionCount } = {}) {
    if (!this.enabled || source !== 'local' || actionCount !== 0) return null;
    try {
      const clean = sanitize(settings, [], context, this.version), ticket = Object.freeze({ generation: this.generation,
        signature: signature(clean, this.version) });
      this.tickets.add(ticket); this.reason = null;
      if (this.status === 'unsupported') { this.status = this.queue.length ? 'pending' : 'ready'; this.save(); }
      return ticket;
    } catch (_) { this.status = 'unsupported'; this.reason = context ? 'MATCH_SETTINGS_UNSUPPORTED' : 'AI_TYPE_UNSUPPORTED'; this.save(); return null; }
  }
  invalidateMatch(ticket, reason = 'MATCH_CHANGED') {
    if (!ticket || !this.tickets.has(ticket)) return;
    this.tickets.delete(ticket); this.reason = reason; this.status = this.enabled ? 'unsupported' : 'off'; this.save();
  }
  async completeMatch(ticket, { settings, actions, context, source, replay = false, tutorial = false } = {}) {
    if (!ticket || !this.tickets.has(ticket) || !this.enabled || ticket.generation !== this.generation
      || source !== 'local' || replay || tutorial) return false;
    let clean;
    try { clean = sanitize(settings, actions, context, this.version); }
    catch (_) { this.invalidateMatch(ticket); return false; }
    try {
      if (!clean.actions.length) return false;
      if (ticket.signature !== signature(clean, this.version)) {
        this.invalidateMatch(ticket); return false;
      }
      const document = await this.createReplay(clean.settings, clean.actions);
      if (!documentTerminal(document, this.version) || !this.enabled || ticket.generation !== this.generation || !this.tickets.has(ticket)) return false;
      const id = documentId(document, this.version);
      if (!idPattern.test(id)) return false;
      this.tickets.delete(ticket);
      if (this.received.includes(id) || this.queue.some(item => item.id === id)) return false;
      if (bytes(this.payload(document, clean.context, this.version)) > requestLimit(this.version)) { this.status = 'too-large'; this.save(); return false; }
      this.queue.push({ id, version: this.version, ...clean }); this.trimQueue(); this.status = 'pending'; this.save(); this.wake(); return true;
    } catch (_) { if (this.enabled && ticket.generation === this.generation) { this.status = 'retry'; this.save(); } return false; }
  }
  // Freeze only a terminal game reported by the session. The expensive canonical
  // replay is built later and still must prove completion before any submission.
  captureCompletedMatch(ticket, { settings, actions, context, source, terminal, replay = false, tutorial = false } = {}) {
    if (!ticket || !this.tickets.has(ticket) || !this.enabled || ticket.generation !== this.generation
      || terminal !== true || source !== 'local' || replay || tutorial) return false;
    try {
      const clean = sanitize(settings, actions, context, this.version);
      if (!clean.actions.length || ticket.signature !== signature(clean, this.version)) { this.invalidateMatch(ticket); return false; }
      this.tickets.delete(ticket);
      const key = stable(clean);
      if (this.queue.some(item => this.itemKey(item) === key)) return false;
      const item = { id: null, version: this.version, ...clean };
      this.itemKeys.set(item, key);
      if (bytes(item) > queueLimit(this.version) - 16000) { this.status = 'too-large'; this.save(); return false; }
      this.queue.push(item); this.trimQueue(); this.status = 'pending'; this.save(); this.wake(); return true;
    } catch (_) { this.invalidateMatch(ticket); return false; }
  }
  payload(replay, context, version = this.version) { return { format: 'lifeline-training-contribution', version, consent: true,
    consent_policy: policyForVersion(version), replay, context }; }
  canWork() {
    try { return !this.disposed && this.enabled && this.foreground && this.connected && this.canRun(); } catch (_) { return false; }
  }
  cancelTimer() { if (this.timer !== null) this.clearTimer(this.timer); this.timer = null; }
  wake() {
    if (!this.canWork() || this.active || !this.queue.length || this.timer !== null || this.failures >= CONTRIBUTION_LIMITS.automaticAttempts) return;
    this.timer = this.setTimer(() => { this.timer = null; void this.flush(); }, Math.max(250, this.retryAt - this.now()));
    this.timer?.unref?.();
  }
  setForeground(value) {
    this.foreground = value === true;
    if (!this.foreground) { this.runEpoch++; this.cancelTimer(); try { this.transport?.abort(); } catch (_) {} }
    else { this.failures = 0; this.wake(); }
  }
  networkChanged(status) {
    if (typeof status?.isConnected !== 'boolean') return;
    const wasConnected = this.connected; this.connected = status.isConnected;
    if (!this.connected) { this.runEpoch++; this.cancelTimer(); try { this.transport?.abort(); } catch (_) {} }
    else if (!wasConnected) { this.failures = 0; this.wake(); }
  }
  deferRetry(status) {
    this.failures++; this.status = status === 503 ? 'unavailable' : 'retry';
    this.retryAt = this.now() + Math.max(status === 429 ? 60000 : 15000, Math.min(120000, 15000 * 2 ** (this.failures - 1)));
  }
  async protocolAvailable(version, current) {
    if (version === 1 || this.now() < (this.protocolSupportedUntil.get(version) || 0)) return true;
    const policy = policyForVersion(version);
    if (!policy || ![2, 3, 4].includes(version)) return false;
    // Discover exact schema support without submitting a replay, and keep the
    // outbox while either independently versioned protocol is rolling out.
    this.transport = this.request({ url: `${this.origin}/api/training/contributions/status`, method: 'GET' });
    const response = await this.transport.promise;
    this.transport = null;
    if (!current()) return false;
    if (response.status < 200 || response.status >= 300) { this.deferRetry(response.status); this.reason = 'SERVER_STATUS_UNAVAILABLE'; return false; }
    const status = response.data;
    if (status?.enabled !== true || !Array.isArray(status.supported_versions) || !status.supported_versions.includes(version)
      || status.consent_policies?.[version] !== policy) {
      this.deferRetry(503); this.reason = 'PROTOCOL_NOT_AVAILABLE'; return false;
    }
    this.protocolSupportedUntil.set(version, this.now() + 5 * 60 * 1000); this.reason = null; return true;
  }
  async flush() {
    if (!this.canWork() || this.active || !this.queue.length || this.now() < this.retryAt) return;
    this.cancelTimer();
    if (!this.origin || !this.request || !this.createReplay) { this.status = 'unavailable'; this.save(); return; }
    const generation = this.generation, runEpoch = this.runEpoch,
      current = () => this.canWork() && generation === this.generation && runEpoch === this.runEpoch;
    this.active = true;
    try {
      // One game per turn keeps queued exports from monopolizing the single Worker.
      if (current() && this.queue.length) {
        const item = this.queue[0], clean = sanitize(item.settings, item.actions, item.context, item.version);
        if (!await this.protocolAvailable(item.version, current) || !current()) return;
        // Rebuild restored input through the same Web codec/Worker before any upload.
        const document = await this.createReplay(clean.settings, clean.actions);
        if (!current() || !this.queue.includes(item)) return;
        const id = documentId(document, item.version);
        if (!documentTerminal(document, item.version) || !idPattern.test(id) || item.id !== null && id !== item.id) {
          this.queue = this.queue.filter(row => row !== item); this.status = 'invalid'; this.save(); return;
        }
        item.id = id; this.itemSizes.delete(item); this.trimQueue();
        if (!this.queue.includes(item)) return;
        if (this.received.includes(id)) { this.queue = this.queue.filter(row => row !== item); this.status = 'received'; this.save(); return; }
        const data = this.payload(document, clean.context, item.version);
        if (bytes(data) > requestLimit(item.version)) { this.queue = this.queue.filter(row => row !== item); this.status = 'too-large'; this.save(); return; }
        this.save();
        this.transport = this.request({ url: `${this.origin}/api/training/contributions`, data });
        const response = await this.transport.promise;
        if (!current()) return;
        if (response.status < 200 || response.status >= 300) {
          // A server rollback can occur after the capability check. Do not
          // discard a locally verified v2/v3 replay on an ambiguous schema error.
          if ([2, 3, 4].includes(item.version) && [400, 422].includes(response.status)) {
            this.protocolSupportedUntil.delete(item.version); this.deferRetry(response.status); this.reason = 'SERVER_REJECTED'; return;
          }
          if ([400, 413, 415, 422].includes(response.status)) {
            this.queue = this.queue.filter(row => row !== item); this.status = 'invalid'; this.reason = 'SERVER_REJECTED'; return;
          }
          this.deferRetry(response.status); return;
        }
        const receipt = response.data;
        if (!/^[a-f0-9]{64}$/.test(receipt?.game_id || '') || !['duplicate', 'awaiting_review'].includes(receipt.status)) throw new Error('INVALID_RECEIPT');
        this.received = [...this.received, item.id].slice(-100); this.queue = this.queue.filter(row => row !== item);
        this.failures = 0; this.retryAt = 0; this.status = 'received'; this.save();
      }
    } catch (error) { if (current()) { if (error?.message === 'CANCELLED') { this.status = 'pending'; }
      else this.deferRetry(); } }
    finally { this.active = false; this.transport = null; this.save(); this.wake(); }
  }
  dispose() { this.disposed = true; this.generation++; this.tickets = new WeakSet(); this.cancelTimer(); try { this.transport?.abort(); } catch (_) {} }
}
