// Isolated candidate only. A time-limited shallow result is a quality tradeoff,
// never an equivalent replacement for a completed four-ply Hard search.
import { MinimaxAI } from './AIEngine.js';
import { GameEngine } from './GameEngine.js';
import { multiplayerClock } from './MultiplayerClock.js';

const EXPIRED = Symbol('budgeted Minimax iteration expired');
const check = (condition, message) => { if (!condition) throw new Error(message); };
const nonnegative = value => Number.isFinite(value) && value >= 0;

function copy(value) {
  if (value instanceof Map) return new Map([...value].map(([key, item]) => [key, copy(item)]));
  if (value instanceof Set) return new Set([...value].map(copy));
  if (Array.isArray(value)) return value.map(copy);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)]));
  return value;
}

function isolatedEngine(source) {
  const engine = new GameEngine({ gridSize: source.gridSize, playerCount: source.playerCount,
    boardShape: source.boardShape, initialPositions: source.initialPositions,
    startPlayer: source.startPlayer, rulesVersion: source.rulesVersion,
    deferTerritoryUpdates: source.deferTerritoryUpdates });
  // Passing the actual roots preserves their positions; preserve the separate
  // flag too, because a default-root game must remain a default-root game.
  engine.hasCustomInitialPositions = source.hasCustomInitialPositions;
  engine._restoreReplayState(source._captureReplayState());
  for (const name of ['lastMove', 'lastMoves', 'lastAction']) {
    if (Object.prototype.hasOwnProperty.call(source, name)) engine[name] = copy(source[name]);
  }
  engine._isReplayingBatch = true;
  return engine;
}

export class BudgetedMinimaxAI extends MinimaxAI {
  constructor({ timeMs = 3000, reserveMs = Math.min(200, timeMs / 4), maxDepth = 8,
    now = multiplayerClock.now } = {}) {
    check(Number.isFinite(timeMs) && timeMs > 0 && nonnegative(reserveMs) && reserveMs < timeMs
      && Number.isInteger(maxDepth) && maxDepth >= 1 && maxDepth <= 8 && typeof now === 'function',
    'Invalid budgeted Minimax settings');
    super(maxDepth, { now, iterativeDeepening: false, maxExtraDepth: 0 });
    Object.assign(this, { timeMs, reserveMs, maxDepth });
  }

  searchTime() {
    const time = this.now();
    check(nonnegative(time) && (this._budgetClockPrevious === undefined || time >= this._budgetClockPrevious),
      'Invalid or backward budgeted Minimax clock');
    this._budgetClockPrevious = time;
    return time;
  }

  checkSearchBudget() {
    if (this._searchDeadline !== undefined && this.searchTime() >= this._searchDeadline) throw EXPIRED;
  }

  minimax(engine, depth, alpha, beta, aiPlayer) {
    const context = this._budgetContext;
    if (context) context.maxMinimaxPly = Math.max(context.maxMinimaxPly, context.iterationDepth - depth);
    return super.minimax(engine, depth, alpha, beta, aiPlayer);
  }

  evaluate(engine, aiPlayer) {
    const context = this._budgetContext;
    if (context) {
      if (engine.gameOver) context.terminalEvaluations++;
      else context.nonterminalEvaluations++;
    }
    return super.evaluate(engine, aiPlayer);
  }

  getTopMoves(source, aiPlayer, topN = 5, { startedAt, deadline } = {}) {
    check(!this._budgetContext, 'Budgeted Minimax search is already running');
    check(Number.isInteger(topN) && topN > 0, 'Budgeted Minimax needs a positive integer topN');
    check(source?.currentPlayer === aiPlayer && source.activePlayers?.includes(aiPlayer)
      && typeof source._captureReplayState === 'function', 'Invalid budgeted Minimax actor or engine');
    check(startedAt === undefined || nonnegative(startedAt), 'Invalid budgeted Minimax startedAt');
    check(deadline === undefined || nonnegative(deadline), 'Invalid budgeted Minimax deadline');
    const previous = { depth: this.depth, deadline: this._searchDeadline,
      clock: this._budgetClockPrevious, context: this._budgetContext };
    this._budgetClockPrevious = undefined;
    const context = { iterationDepth: 0, maxMinimaxPly: 0, maxReachedPly: 0,
      terminalEvaluations: 0, nonterminalEvaluations: 0 };
    this._budgetContext = context;
    let started, ended, totalDeadline, searchDeadline, preparationMs = 0, moves = [],
      completedDepth = 0, interrupted = false, partialDiscarded = false,
      terminalTreeSolved = false, failure = null, fallback = null;
    const iterations = [];
    try {
      const entered = this.searchTime();
      started = startedAt ?? entered;
      check(started <= entered, 'Budgeted Minimax startedAt lies in the future');
      totalDeadline = Math.min(started + this.timeMs, deadline ?? Infinity);
      check(Number.isFinite(started + this.timeMs) && Number.isFinite(totalDeadline),
        'Budgeted Minimax deadline overflow');
      searchDeadline = Math.max(started, totalDeadline - this.reserveMs);
      this._searchDeadline = searchDeadline;
      if (!source.gameOver) {
        const engine = isolatedEngine(source), rootRevision = engine.positionRevision;
        // Count actual native transitions in both Minimax and the unchanged
        // four-action cut-chain overlay. Recursion depth is reported separately.
        for (const name of ['playMove', 'skipTurn']) {
          const native = engine[name];
          engine[name] = function (...args) {
            const result = native.apply(this, args);
            // Native placements and explicit PASS each advance this revision
            // once; automatic skip normalization does not advance it.
            if (result.success) context.maxReachedPly = Math.max(context.maxReachedPly, this.positionRevision - rootRevision);
            return result;
          };
        }
        // Prepare a legal placement before attempting a timed iteration. This
        // mandatory native work is included in elapsed/overrun measurements.
        const legal = this.getLegalMoves(engine, aiPlayer), ordered = this.orderMoves(engine, legal, aiPlayer);
        const point = ordered[0] ?? null;
        fallback = point === null ? 'legal-pass' : 'legal-placement';
        moves = [{ point, ...(point === null ? { type: 'pass' } : {}), score: 0,
          fallback: true, scoreSource: 'unsearched-legal-fallback' }];
        preparationMs = this.searchTime() - started;
        for (let depth = 1; depth <= this.maxDepth; depth++) {
          this.depth = depth;
          context.iterationDepth = depth;
          context.terminalEvaluations = 0; context.nonterminalEvaluations = 0;
          let began = false;
          try {
            this.checkSearchBudget();
            began = true;
            // Inherited root cap/order, exact-root pruning, PASS, risk penalty
            // and four-action defensive/offensive overlay remain unchanged.
            const ranking = this.searchAtDepth(engine, aiPlayer, topN);
            this.checkSearchBudget();
            terminalTreeSolved = context.terminalEvaluations > 0 && context.nonterminalEvaluations === 0;
            iterations.push({ ...this.lastSearch, complete: true, terminalTreeSolved });
            moves = ranking; completedDepth = depth; fallback = null;
            if (terminalTreeSolved) break;
          } catch (error) {
            if (error !== EXPIRED) throw error;
            iterations.push({ ...(began ? this.lastSearch : { nodes: 0, leaves: 0, rootActions: 0 }),
              depth, complete: false, began });
            interrupted = true; partialDiscarded = began;
            break;
          }
        }
      }
      ended = this.searchTime();
      return moves;
    } catch (error) {
      failure = error;
      ended = this._budgetClockPrevious;
      throw error;
    } finally {
      this.depth = previous.depth; this._searchDeadline = previous.deadline;
      this._budgetContext = previous.context; this._budgetClockPrevious = previous.clock;
      this.lastSearch = { algorithm: 'budgeted-minimax-candidate-v1', requestedDepth: this.maxDepth,
        completedDepth, depth: completedDepth, maxReachedPly: context.maxReachedPly,
        maxMinimaxPly: context.maxMinimaxPly, iterations, interrupted, partialDiscarded,
        terminalTreeSolved, terminalSolvedScope: 'preserved 20-placement-plus-PASS candidate tree',
        rootPlacementCap: 20, fullLegalTeacher: false, fallback,
        shallowQualityTradeoff: completedDepth < 4 && !terminalTreeSolved,
        shallowerThanRequested: completedDepth < this.maxDepth && !terminalTreeSolved,
        timeMs: this.timeMs, guardReserveMs: this.reserveMs,
        startedAt: started ?? null, totalDeadline: totalDeadline ?? null,
        searchDeadline: searchDeadline ?? null, preparationMs,
        elapsedMs: started === undefined || ended === undefined ? 0 : ended - started,
        remainingMs: totalDeadline === undefined || ended === undefined ? 0 : Math.max(0, totalDeadline - ended),
        softOverrunMs: searchDeadline === undefined || ended === undefined ? 0 : Math.max(0, ended - searchDeadline),
        totalOverrunMs: totalDeadline === undefined || ended === undefined ? 0 : Math.max(0, ended - totalDeadline),
        error: failure ? String(failure.message ?? failure) : null,
        scope: 'Cooperative deadline including preparation; caller must share remaining total budget with its PASS guard. A shallow completed iteration or unsearched fallback is a quality tradeoff; no training label or strength claim.' };
    }
  }
}
