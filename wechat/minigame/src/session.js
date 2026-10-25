import { createLocalGameSession, TUTORIAL_LEVELS, randomInitialPositions, startingPointSettings,
  createLocalUndoTimeline, planLocalUndo, consumeLocalUndo, recordUndoAction } from './core.js';
import { settingsFor, MODES } from './state.js';
import { presetControllers, validateControllers, controllersMode, defaultAIProfile, playerIds } from './controllers.js';
import { normalizePlayOptions, validatePlayProgress, validateUndoUsage } from './play-options.js';
import { TurnClock } from './turn-clock.js';
import { modelForProfile } from './model-catalog.js';

const clone = (value) => JSON.parse(JSON.stringify(value));

export class GameSession {
  constructor(scheduler, store, onChange = () => {}, { clock, timedTurns = true, allowUndo = true, models } = {}) {
    this.scheduler = scheduler; this.store = store; this.onChange = onChange;
    this.settings = settingsFor(); this.actions = []; this.mode = 'ai-white'; this.difficulty = 'normal';
    this.snapshot = null; this.stateHash = null; this.busy = false; this.epoch = 0;
    this.hidden = false; this.paused = false; this.error = null; this.saveError = false;
    this.replayIndex = null; this.tutorial = null; this.savedGame = null; this.hintPoint = null;
    this.replayView = null; this.controllers = null;
    this.models = models; this.modelLoading = null; this.replayStateHash = null;
    this.replayPlaying = false; this.replayTimer = null; this.replayGeneration = 0; this.replayInterval = 1000;
    this.hintsUsed = 0; this.clockHolds = 0; this.timedTurns = timedTurns; this.allowUndo = allowUndo;
    this.undoUsage = { usedCount: 0, blockedPlayers: [] }; this.undoTimeline = createLocalUndoTimeline(); this.undoPending = false;
    this.clock = new TurnClock(() => this.onChange(), () => {
      if (this.timedTurns && this.settings.turnTimerEnabled && !this.clockHolds && !this.tutorial && this.canPlay()) {
        void this.act({ type: 'skip' });
      }
    }, clock);
    this.clock.reset(this.settings.turnTimeLimitSeconds * 1000);
  }
  notify() { this.syncClock(); this.onChange(); }
  syncClock() {
    if (this.timedTurns && this.settings.turnTimerEnabled && !this.clockHolds && !this.tutorial && this.canPlay()) this.clock.start();
    else this.clock.suspend();
  }
  holdClock() {
    this.clockHolds++; this.syncClock(); let released = false;
    return () => { if (!released) { released = true; this.clockHolds--; this.notify(); } };
  }
  get hintsRemaining() { return playerIds(this.settings.playerCount).length && this.settings.hintEnabled !== false
    ? Math.max(0, (this.settings.hintMaxCount ?? 3) - this.hintsUsed) : 0; }
  get undoRemaining() { return this.allowUndo && this.settings.undoEnabled ? Math.max(0, this.settings.undoMaxCount - this.undoUsage.usedCount) : 0; }
  undoPlan() {
    if (!this.undoRemaining || !this.snapshot || this.snapshot.gameOver || this.hidden || this.tutorial
      || this.replayIndex !== null || this.undoPending) return null;
    const actions = this.actions.map(action => ({ ...action, type: { move: 'player_move', skip: 'player_skip', resign: 'player_resign' }[action.type] || action.type,
      ...(action.type === 'resign' ? { color: action.player } : {}) }));
    return planLocalUndo({ settings: this.settings, actions, usage: this.undoUsage, currentPlayer: this.snapshot.currentPlayer,
      players: Object.fromEntries(playerIds(this.settings.playerCount).map(player => [player, { choice: this.controllerFor(player) }])),
      timeline: this.undoTimeline(this.settings, actions) });
  }
  get undoAvailable() { try { return Boolean(this.undoPlan()); } catch (_) { return false; } }
  async undo() {
    const plan = this.undoPlan(); if (!plan) return false;
    const actions = this.actions.slice(0, plan.actionIndex), usage = consumeLocalUndo(this.undoUsage, plan);
    const epoch = this.begin();
    this.undoPending = true;
    try {
      const result = await this.scheduler.request('STATE', { settings: this.settings, actions }, this.context(), 0);
      if (!this.isCurrent(epoch)) return false;
      this.actions = actions; this.snapshot = result.snapshot; this.stateHash = result.stateHash; this.undoUsage = usage;
      this.clock.reset(this.settings.turnTimeLimitSeconds * 1000); this.busy = false; this.paused = false;
      this.undoPending = false; this.save(); this.notify(); void this.maybeAI(); return true;
    } catch (error) { this.failed(epoch, error); return false; }
    finally { if (epoch === this.epoch) { this.undoPending = false; this.notify(); } }
  }
  capture() {
    return { session: createLocalGameSession(this.settings, this.actions), mode: this.mode, difficulty: this.difficulty,
      ...(this.controllers ? { controllers: clone(this.controllers) } : {}),
      ...(this.undoUsage.usedCount ? { undoUsage: clone(this.undoUsage) } : {}),
      ...(this.settings.turnTimerEnabled || this.hintsUsed ? { progress: { remainingMs: this.clock.remaining(), hintsUsed: this.hintsUsed } } : {}) };
  }
  context() {
    return { epoch: this.epoch, revision: this.actions.length, rulesVersion: this.settings.rulesVersion,
      player: this.snapshot?.currentPlayer || this.settings.startPlayer };
  }
  begin({ keepReplayPlayback = false } = {}) {
    if (!keepReplayPlayback) this.stopReplayPlayback();
    this.scheduler.cancel({ keepIdle: true }); this.epoch++; this.busy = true; this.error = null; this.hintPoint = null;
    this.modelLoading = null;
    this.undoPending = false;
    this.notify(); return this.epoch;
  }
  isCurrent(epoch) { return epoch === this.epoch && !this.hidden; }
  save() {
    if (!this.snapshot || this.tutorial || this.replayIndex !== null) return;
    try { this.store.save(this.capture()); this.saveError = false; }
    catch (_) { this.saveError = true; }
  }
  async load(settings, actions = [], options = {}) {
    const epoch = this.begin();
    try {
      settings = { ...settings, ...normalizePlayOptions(settings) };
      const controllers = validateControllers(options.controllers, settings);
      const progress = validatePlayProgress(options.progress, settings);
      const undoUsage = validateUndoUsage(options.undoUsage, settings);
      const result = await this.scheduler.request('STATE', { settings, actions }, { ...this.context(), epoch }, 0);
      if (!this.isCurrent(epoch)) return false;
      if (options.expectedHash && result.stateHash !== options.expectedHash) throw new Error('STATE_MISMATCH');
      this.settings = clone(settings); this.actions = clone(actions);
      this.mode = settings.playerCount > 2 ? 'human' : MODES.includes(options.mode) ? options.mode : this.mode;
      this.controllers = controllers;
      if (controllers) this.mode = controllersMode(controllers);
      this.difficulty = options.difficulty === 'easy' ? 'easy' : 'normal';
      this.hintsUsed = progress.hintsUsed; this.clock.reset(progress.remainingMs);
      this.undoUsage = undoUsage; this.undoPending = false;
      this.snapshot = result.snapshot; this.stateHash = result.stateHash;
      this.busy = false; this.paused = Boolean(options.paused);
      if (options.save !== false) this.save();
      this.notify();
      if (!this.paused && options.autoplay !== false) void this.maybeAI();
      return true;
    } catch (error) { this.failed(epoch, error); return false; }
  }
  async restore() {
    let stored;
    try { stored = this.store.read(); }
    catch (_) { this.error = 'SAVE_READ_FAILED'; this.notify(); return false; }
    for (const record of stored.records) {
      const p = record.payload;
      const expectedEpoch = this.epoch + 1;
      const loaded = await this.load(p.session.settings, p.session.actions,
        { ...p, save: false, autoplay: false, paused: true });
      if (this.epoch !== expectedEpoch) return false;
      if (loaded) {
        if (stored.damaged.length || record !== stored.records[0]) this.error = 'RECOVERED_BACKUP';
        this.notify(); return true;
      }
    }
    if (stored.records.length || stored.damaged.length) this.error = 'SAVE_INVALID';
    this.notify(); return false;
  }
  async newGame(size, mode = 'ai-white', difficulty = 'normal', playerCount = 2, options = {}) {
    if (this.replayIndex !== null) this.exitReplay();
    if (this.tutorial) this.restoreOriginal();
    this.tutorial = null; this.replayIndex = null; this.savedGame = null;
    const initial = { ...settingsFor(size, playerCount, options.startPlayer || 'BLACK'), ...normalizePlayOptions(options.playOptions),
      ...(options.boardShape ? { boardShape: options.boardShape } : {}) };
    const modeOfStarts = options.startingPointMode || (playerCount > 6 ? 'random' : 'default');
    const starts = modeOfStarts === 'random' ? randomInitialPositions(size, playerCount, Math.random, initial.boardShape) : options.initialPositions;
    Object.assign(initial, startingPointSettings({ ...initial, startingPointMode: modeOfStarts,
      ...(starts ? { initialPositions: starts } : {}) }));
    return this.load(initial, [],
      { mode, difficulty, controllers: options.controllers });
  }
  controllerFor(player) { return (this.controllers || presetControllers(this.mode, this.difficulty, this.settings))[player] || 'human'; }
  isAITurn() {
    if (!playerIds(this.settings.playerCount).length) return false;
    return this.controllerFor(this.snapshot?.currentPlayer) !== 'human';
  }
  canPlay() {
    return this.snapshot && !this.snapshot.gameOver && !this.busy && !this.hidden && !this.paused
      && this.replayIndex === null && !this.tutorial?.done && (!this.isAITurn() || this.tutorial);
  }
  async act(action, fromAI = false) {
    if (this.busy || this.hidden || this.replayIndex !== null || this.snapshot?.gameOver) return false;
    if (!fromAI && !this.canPlay()) return false;
    const tutorial = this.tutorial;
    if (tutorial) {
      const level = TUTORIAL_LEVELS[tutorial.index];
      const expected = level.restriction && !tutorial.restrictionObserved
        ? { type: 'move', point: level.restriction.point } : level.objective;
      if (action.type !== expected.type || (expected.point && String(action.point) !== String(expected.point))) {
        this.error = 'FOLLOW_HIGHLIGHT'; this.notify(); return false;
      }
    }
    const actor = this.snapshot.currentPlayer;
    const normalized = { ...action, player: action.player || actor };
    const epoch = this.begin();
    try {
      const result = await this.scheduler.request('APPLY', { settings: this.settings, actions: this.actions,
        action: normalized }, this.context(), 0);
      if (!this.isCurrent(epoch)) return false;
      this.actions = [...this.actions, normalized]; this.snapshot = result.snapshot; this.stateHash = result.stateHash;
      this.undoUsage = recordUndoAction(this.undoUsage, normalized.player);
      this.clock.reset(this.settings.turnTimeLimitSeconds * 1000);
      this.busy = false;
      if (tutorial) tutorial.done = true;
      this.save(); this.notify(); void this.maybeAI(); return true;
    } catch (error) {
      if (this.isCurrent(epoch) && tutorial && TUTORIAL_LEVELS[tutorial.index].restriction
        && !tutorial.restrictionObserved && error.message === 'INVALID_MOVE') {
        tutorial.restrictionObserved = true; this.busy = false; this.error = null; this.notify(); return false;
      }
      this.failed(epoch, error); return false;
    }
  }
  async maybeAI() {
    if (!this.snapshot || this.snapshot.gameOver || !this.isAITurn() || this.tutorial
      || this.replayIndex !== null || this.paused || this.busy || this.hidden) return;
    const epoch = this.begin();
    const positionHash = this.stateHash;
    try {
      const profile = this.controllerFor(this.snapshot.currentPlayer);
      const model = await this.prepareModel(profile, epoch);
      if (!this.isCurrent(epoch)) return;
      const result = await this.scheduler.request('AI', { settings: this.settings,
        actions: this.actions, difficulty: this.difficulty, profile, ...(model ? { model } : {}) }, this.context(), 1);
      if (!this.isCurrent(epoch)) return;
      if (result.stateHash !== positionHash || result.player !== this.snapshot.currentPlayer) throw new Error('STALE_AI');
      this.busy = false;
      await this.act(result.moves[0]?.point ? { type: 'move', point: result.moves[0].point } : { type: 'skip' }, true);
    } catch (error) { this.failed(epoch, error); }
  }
  async hint() {
    if (!this.canPlay() || this.tutorial) return;
    if (!this.hintsRemaining) { this.error = this.settings.hintEnabled === false ? 'HINT_DISABLED' : 'HINT_LIMIT'; this.notify(); return false; }
    const epoch = this.begin(), hash = this.stateHash;
    try {
      const profile = defaultAIProfile(this.settings), model = await this.prepareModel(profile, epoch);
      if (!this.isCurrent(epoch)) return false;
      const result = await this.scheduler.request('HINT', { settings: this.settings, actions: this.actions,
        difficulty: 'easy', profile, ...(model ? { model } : {}) }, this.context(), 2);
      if (!this.isCurrent(epoch)) return;
      if (hash !== result.stateHash || result.player !== this.snapshot.currentPlayer) throw new Error('STALE_HINT');
      this.hintPoint = result.moves[0]?.point || null;
      if (this.hintPoint) { this.hintsUsed++; this.save(); }
      this.busy = false; this.notify(); return Boolean(this.hintPoint);
    } catch (error) { this.failed(epoch, error); }
  }
  failed(epoch, error) {
    if (!this.isCurrent(epoch) || error.message === 'CANCELLED') return;
    this.stopReplayPlayback();
    this.busy = false; this.modelLoading = null; this.error = error.message; this.paused = true; this.notify();
  }
  pause() {
    this.stopReplayPlayback();
    this.undoPending = false;
    this.epoch++; this.scheduler.cancel(); this.busy = false; this.modelLoading = null; this.paused = true; this.save(); this.notify();
  }
  resume() { this.hidden = false; this.paused = false; this.error = null; this.notify(); void this.maybeAI(); }
  hide() { this.pause(); this.hidden = true; }
  show() { this.hidden = false; this.notify(); }
  async replay(index, { autoplay = false } = {}) {
    if (!this.snapshot || this.tutorial || this.hidden || !Number.isInteger(index)) return false;
    if (this.replayIndex === null) {
      this.replayView = { snapshot: clone(this.snapshot), stateHash: this.stateHash };
      this.replayIndex = this.actions.length;
      this.replayStateHash = this.stateHash;
    }
    const target = Math.max(0, Math.min(this.actions.length, index));
    const epoch = this.begin({ keepReplayPlayback: autoplay });
    try {
      const result = await this.scheduler.request('STATE', { settings: this.settings,
        actions: this.actions.slice(0, target) }, this.context(), 0);
      if (!this.isCurrent(epoch)) return false;
      // Commit cursor and board together; cancellation must not mislabel an older board.
      this.snapshot = result.snapshot; this.replayStateHash = result.stateHash; this.replayIndex = target; this.busy = false; this.notify(); return true;
    } catch (error) { this.failed(epoch, error); return false; }
  }
  stopReplayPlayback() {
    this.replayGeneration++; clearTimeout(this.replayTimer); this.replayTimer = null; this.replayPlaying = false;
  }
  startReplayPlayback() {
    if (this.replayIndex === null || this.replayIndex >= this.actions.length || this.hidden || this.busy) return false;
    this.stopReplayPlayback(); this.replayPlaying = true;
    const generation = this.replayGeneration;
    const step = async () => {
      if (!this.replayPlaying || generation !== this.replayGeneration || this.hidden || this.replayIndex === null) return;
      const loaded = await this.replay(this.replayIndex + 1, { autoplay: true });
      if (generation !== this.replayGeneration) return;
      if (!loaded || this.replayIndex >= this.actions.length) { this.stopReplayPlayback(); this.notify(); return; }
      this.replayTimer = setTimeout(step, this.replayInterval);
    };
    this.replayTimer = setTimeout(step, this.replayInterval); this.notify(); return true;
  }
  async inspectReplay() {
    if (this.replayIndex === null || this.hidden) return null;
    const cursor = this.replayIndex, epoch = this.begin();
    try {
      const result = await this.scheduler.request('REPLAY_STEP', { settings: this.settings, actions: this.actions, cursor }, this.context(), 0);
      if (!this.isCurrent(epoch) || this.replayIndex !== cursor) return null;
      if (result.stateHash !== this.replayStateHash) throw new Error('STATE_MISMATCH');
      this.busy = false; this.notify(); return result;
    } catch (error) { this.failed(epoch, error); return null; }
  }
  async forkReplay({ keepPlayers = false, archive } = {}) {
    if (this.replayIndex === null || this.hidden || this.busy || this.tutorial || !this.snapshot || this.snapshot.gameOver) return false;
    const cursor = this.replayIndex, expectedHash = this.replayStateHash;
    const original = this.capture(), settings = clone(this.settings), actions = clone(this.actions.slice(0, cursor));
    const mode = keepPlayers ? this.mode : 'human', controllers = keepPlayers ? clone(this.controllers) : null;
    const epoch = this.begin();
    try {
      if (typeof archive !== 'function') throw new Error('BRANCH_ARCHIVE_REQUIRED');
      const result = await this.scheduler.request('STATE', { settings, actions }, this.context(), 0);
      if (!this.isCurrent(epoch) || this.replayIndex !== cursor) return false;
      if (result.stateHash !== expectedHash || result.snapshot.gameOver) throw new Error('STATE_MISMATCH');
      const payload = { session: createLocalGameSession(settings, actions), mode, difficulty: this.difficulty,
        ...(controllers ? { controllers } : {}) };
      // Both writes are synchronous. Preserve the complete original before the
      // branch becomes the automatic save. Commit memory only after both writes;
      // the original archive also survives an unverified branch save.
      archive(original);
      this.store.save(payload);
      this.settings = settings; this.actions = actions; this.mode = mode; this.controllers = controllers;
      this.snapshot = result.snapshot; this.stateHash = result.stateHash;
      this.replayIndex = null; this.replayStateHash = null; this.replayView = null;
      this.hintsUsed = 0; this.clock.reset(settings.turnTimeLimitSeconds * 1000);
      this.undoUsage = { usedCount: 0, blockedPlayers: [] };
      this.busy = false; this.paused = true; this.saveError = false;
      this.notify(); return true;
    } catch (error) { this.failed(epoch, error); return false; }
  }
  async prepareModel(profile, epoch) {
    if (!modelForProfile(profile)) return null;
    if (!this.models) throw new Error('MODELS_UNAVAILABLE');
    this.modelLoading = { profile, progress: 0 }; this.notify();
    try {
      return await this.models.load(profile, () => this.isCurrent(epoch), progress => {
        if (this.isCurrent(epoch)) { this.modelLoading = { profile, progress }; this.notify(); }
      });
    } finally { if (this.isCurrent(epoch)) { this.modelLoading = null; this.notify(); } }
  }
  async analyzeReplay(profile) {
    if (this.replayIndex === null || this.hidden || !playerIds(this.settings.playerCount).length || this.snapshot?.gameOver) return null;
    const cursor = this.replayIndex, positionHash = this.replayStateHash, player = this.snapshot.currentPlayer;
    const epoch = this.begin();
    try {
      const model = await this.prepareModel(profile, epoch);
      if (!this.isCurrent(epoch)) return null;
      const result = await this.scheduler.request('ANALYZE', { settings: this.settings,
        actions: this.actions.slice(0, cursor), profile, ...(model ? { model } : {}) }, this.context(), 2);
      if (!this.isCurrent(epoch) || this.replayIndex !== cursor) return null;
      if (result.stateHash !== positionHash || result.player !== player || result.profile !== profile) throw new Error('STALE_AI');
      this.busy = false; this.notify(); return { ...result, cursor };
    } catch (error) { this.failed(epoch, error); return null; }
  }
  async exitReplay() {
    this.begin(); this.busy = false; this.paused = true;
    this.replayIndex = null;
    this.replayStateHash = null;
    if (this.replayView) { this.snapshot = this.replayView.snapshot; this.stateHash = this.replayView.stateHash; }
    this.replayView = null; this.notify(); return true;
  }
  async tutorialLevel(index) {
    let saved = this.savedGame;
    if (!this.tutorial) {
      if (this.replayIndex !== null) this.exitReplay();
      saved = this.snapshot ? { ...this.capture(), snapshot: clone(this.snapshot), stateHash: this.stateHash } : null;
    }
    const level = TUTORIAL_LEVELS[index];
    if (!level) return this.exitTutorial();
    const loaded = await this.load({ ...settingsFor(level.gridSize), startPlayer: level.startPlayer }, level.prefix,
      { mode: 'human', difficulty: 'easy', save: false, autoplay: false });
    if (loaded) {
      this.savedGame = saved; this.tutorial = { index, done: false, restrictionObserved: false }; this.replayIndex = null; this.notify();
    }
    return loaded;
  }
  restoreOriginal() {
    const saved = this.savedGame;
    this.tutorial = null; this.savedGame = null;
    if (saved) {
      this.settings = saved.session.settings; this.actions = saved.session.actions;
      this.mode = saved.mode; this.difficulty = saved.difficulty;
      this.controllers = saved.controllers || null;
      this.undoUsage = validateUndoUsage(saved.undoUsage, this.settings);
      const progress = validatePlayProgress(saved.progress, this.settings);
      this.hintsUsed = progress.hintsUsed; this.clock.reset(progress.remainingMs);
      this.snapshot = saved.snapshot; this.stateHash = saved.stateHash;
    } else { this.snapshot = null; this.actions = []; this.stateHash = null; }
    return Boolean(saved);
  }
  async exitTutorial() {
    this.begin(); this.busy = false; this.paused = true;
    if (this.restoreOriginal()) { this.notify(); return true; }
    return this.newGame(7, 'ai-white');
  }
}
