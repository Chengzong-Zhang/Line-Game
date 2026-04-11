import GameEngine, { Player } from "./GameEngine.js";
import Renderer from "./Renderer.js";

function clonePoint(point) {
  return [point[0], point[1]];
}

function distanceBetween(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

export class GameController {
  constructor(canvas, options = {}) {
    if (!(canvas instanceof HTMLCanvasElement)) {
      throw new Error("GameController expects a valid <canvas> element.");
    }

    this.canvas = canvas;
    this.options = options;
    this.engine = new GameEngine(options.engine ?? {});
    this.renderer = new Renderer(canvas, options.renderer ?? {});
    this.stateChangeListener = typeof options.onStateChange === "function" ? options.onStateChange : null;

    this._isInitialized = false;
    this._boundHandleClick = this._handleClick.bind(this);
    this._boundHandleTouchStart = this._handleTouchStart.bind(this);
  }

  init() {
    if (!this._isInitialized) {
      this.canvas.addEventListener("click", this._boundHandleClick);
      this.canvas.addEventListener("touchstart", this._boundHandleTouchStart, { passive: false });
      this._isInitialized = true;
    }

    const snapshot = this.engine.getSnapshot();
    this.renderer.render(snapshot);
    this._emitStateChange(snapshot);
    return snapshot;
  }

  destroy() {
    if (this._isInitialized) {
      this.canvas.removeEventListener("click", this._boundHandleClick);
      this.canvas.removeEventListener("touchstart", this._boundHandleTouchStart);
      this._isInitialized = false;
    }
    this.renderer.destroy();
  }

  setStateChangeListener(listener) {
    this.stateChangeListener = typeof listener === "function" ? listener : null;
  }

  _emitStateChange(snapshot) {
    if (this.stateChangeListener) {
      this.stateChangeListener(this._buildGameState(snapshot));
    }
  }

  _buildGameState(snapshot = this.engine.getSnapshot()) {
    const black = snapshot.territories?.[Player.BLACK] ?? { area: 0, polygon: null };
    const white = snapshot.territories?.[Player.WHITE] ?? { area: 0, polygon: null };

    return {
      currentPlayer: snapshot.currentPlayer,
      gameOver: snapshot.gameOver,
      winner: snapshot.winner,
      turnCount: snapshot.turnCount,
      consecutiveSkips: snapshot.consecutiveSkips,
      scores: {
        [Player.BLACK]: black.area,
        [Player.WHITE]: white.area,
      },
      territories: snapshot.territories,
      legalMoves: snapshot.legalMoves,
      snapshot,
    };
  }

  _getCanvasRelativePosition(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: clientX - rect.left,
      y: clientY - rect.top,
    };
  }

  _findNearestGridPoint(pixelX, pixelY) {
    const snapshot = this.engine.getSnapshot();
    const validPoints = typeof this.engine.getValidPositions === "function"
      ? this.engine.getValidPositions()
      : this._deriveValidPoints(snapshot.gridSize);

    let nearestPoint = null;
    let nearestDistance = Number.POSITIVE_INFINITY;

    for (const point of validPoints) {
      const pixelPoint = this.renderer.getPointPixelCoordinates(point);
      const distance = distanceBetween({ x: pixelX, y: pixelY }, pixelPoint);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestPoint = point;
      }
    }

    const threshold = this.renderer.getHitRadius();
    if (!nearestPoint || nearestDistance > threshold) {
      return null;
    }

    return clonePoint(nearestPoint);
  }

  _deriveValidPoints(gridSize) {
    const points = [];
    for (let y = 0; y < gridSize; y += 1) {
      for (let x = 0; x < gridSize - y; x += 1) {
        points.push([x, y]);
      }
    }
    return points;
  }

  _processPointer(clientX, clientY) {
    if (this.engine.getSnapshot().gameOver) {
      return {
        success: false,
        reason: "GAME_OVER",
        state: this.getGameState(),
      };
    }

    const relative = this._getCanvasRelativePosition(clientX, clientY);
    const point = this._findNearestGridPoint(relative.x, relative.y);
    if (!point) {
      return {
        success: false,
        reason: "MISS",
        state: this.getGameState(),
      };
    }

    const result = this.engine.playMove(point);
    if (result.success) {
      this.renderer.render(result.snapshot);
      this._emitStateChange(result.snapshot);
    }

    return {
      success: result.success,
      reason: result.reason,
      point,
      state: this._buildGameState(result.snapshot),
    };
  }

  _handleClick(event) {
    this._processPointer(event.clientX, event.clientY);
  }

  _handleTouchStart(event) {
    event.preventDefault();
    const touch = event.touches[0];
    if (!touch) {
      return;
    }
    this._processPointer(touch.clientX, touch.clientY);
  }

  skipTurn() {
    const result = this.engine.skipTurn();
    if (result.success) {
      this.renderer.render(result.snapshot);
      this._emitStateChange(result.snapshot);
    }
    return {
      success: result.success,
      reason: result.reason,
      state: this._buildGameState(result.snapshot),
    };
  }

  resetGame() {
    this.engine = new GameEngine(this.options.engine ?? {});
    const snapshot = this.engine.getSnapshot();
    this.renderer.render(snapshot);
    this._emitStateChange(snapshot);
    return this._buildGameState(snapshot);
  }

  getGameState() {
    return this._buildGameState(this.engine.getSnapshot());
  }
}

export default GameController;
