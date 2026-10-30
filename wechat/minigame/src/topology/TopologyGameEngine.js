import { compileBoard } from "./BoardCompiler.js?v=20261029-topology-round5";
import { compareStableIdentifiers, stableStringify } from "./BoardDefinition.js?v=20261029-topology-round5";
import { enumerateConnections, physicalPathKey } from "./BoardPaths.js?v=20261029-topology-round5";
import { computeTerritory } from "./SurfaceTerritory.js?v=20261029-topology-round5";
import { topologyStartingRoots, topologyStartingState } from "./TopologyStartingPoints.js?v=20261029-topology-round5";
import {
  decodeTopologyState,
  encodeTopologyState,
  TOPOLOGY_RULE_STATE_VERSION,
} from "./TopologyStateCodec.js?v=20261029-topology-round5";

/*
 * The legacy GameEngine is deliberately coordinate-first: its triangle and
 * hexagon implementation relies on a rectangular point matrix in several hot
 * paths.  Topology boards use canonical vertex IDs instead, so this small
 * sibling implementation keeps the public match contract while never making a
 * quotient board pretend to be a triangle.  GameEngine constructs it only when
 * a boardDefinition/compiledBoard option is explicitly supplied.
 */

const cloneJson = (value) => {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
};

const cloneConnection = (connection) => {
  const { owner: _owner, ...path } = connection;
  return {
  ...path,
  vertices: [...connection.vertices],
  edgeOccurrences: [...connection.edgeOccurrences],
  seamCrossings: (connection.seamCrossings ?? []).map((crossing) => ({ ...crossing })),
  };
};

function sameStringArray(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameSeamCrossings(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length
    && left.every((crossing, index) => JSON.stringify(crossing) === JSON.stringify(right[index]));
}

function samePhysicalPath(left, right) {
  const forward = sameStringArray(left.vertices, right.vertices);
  const reverse = sameStringArray(left.vertices, [...right.vertices].reverse());
  if (!forward && !reverse) return false;
  if (!sameStringArray(sorted(left.edgeOccurrences), sorted(right.edgeOccurrences))) return false;
  const seamKey = (crossing) => [
    [crossing.fromEdgeOccurrenceId, crossing.sourceVertexId].join("@"),
    [crossing.toEdgeOccurrenceId, crossing.targetVertexId].join("@"),
  ].sort().join("|");
  return sameStringArray(sorted((left.seamCrossings ?? []).map(seamKey)),
    sorted((right.seamCrossings ?? []).map(seamKey)));
}

function isExactCompiledConnection(left, right) {
  return left.pathId === right.pathId
    && left.startVertexId === right.startVertexId
    && left.endVertexId === right.endVertexId
    && left.directionState === right.directionState
    && sameStringArray(left.vertices, right.vertices)
    && sameStringArray(left.edgeOccurrences, right.edgeOccurrences)
    && sameSeamCrossings(left.seamCrossings, right.seamCrossings);
}

function assertExactCompiledConnection(board, path) {
  let candidates;
  try {
    // Reconstruct from only the path's pre-existing endpoint.  At the moment
    // such a connection was created, its start was the pending move; later
    // nodes and paths must not change the geometric identity of that ray.
    candidates = enumerateConnections(board, {
      coverageByPlayer: { [path.owner]: [path.endVertexId] },
    }, path.startVertexId, path.owner, { geometryOnly: true });
  } catch (error) {
    throw topologyError("INVALID_LOGIC_PATH", path.pathId + ": " + (error?.code ?? error?.message ?? "cannot trace"));
  }
  if (!candidates.some((candidate) => isExactCompiledConnection(candidate, path))) {
    throw topologyError("INVALID_LOGIC_PATH", path.pathId + ": does not reproduce a compiled ray");
  }
}

const topologyError = (code, detail = "") => {
  const error = new Error(detail ? code + ": " + detail : code);
  error.code = code;
  return error;
};

const sorted = (values) => [...values].sort((left, right) =>
  compareStableIdentifiers(String(left), String(right)));

function normalizeCompiledBoard(options) {
  if (options.compiledBoard) {
    const board = options.compiledBoard;
    if (!board || typeof board !== "object" || typeof board.boardHash !== "string"
      || !Array.isArray(board.sampleIds) || !board.definition) {
      throw topologyError("INVALID_COMPILED_BOARD");
    }
    const recompiled = compileBoard(board.definition);
    if (!recompiled.ok || recompiled.value.boardHash !== board.boardHash) {
      throw topologyError("INVALID_COMPILED_BOARD", "Definition does not reproduce boardHash.");
    }
    return recompiled.value;
  }
  const compiled = compileBoard(options.boardDefinition);
  if (!compiled.ok) {
    throw topologyError("INVALID_BOARD_DEFINITION",
      compiled.errors.map((error) => error.code + "@" + error.location).join(", "));
  }
  return compiled.value;
}

function graphDistances(board, start) {
  const distances = new Map([[start, 0]]);
  const queue = [start];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    for (const next of board.sampleAdjacency[current] ?? []) {
      if (!distances.has(next)) {
        distances.set(next, distances.get(current) + 1);
        queue.push(next);
      }
    }
  }
  return distances;
}

function selectInitialPositions(board, players, requested, aliases) {
  const starts = {};
  const claimed = new Set();
  const resolve = (value) => {
    if (typeof value === "string") {
      if (board.sampleIds.includes(value)) return value;
      return board.rawVertexToCanonical[value] ?? null;
    }
    if (Array.isArray(value) && value.length === 2 && value.every(Number.isInteger)) {
      return aliases.get(value.join(",")) ?? null;
    }
    return null;
  };

  for (const player of players) {
    const value = requested?.[player] ?? board.startingRoots?.[player] ?? board.startingVertices?.[player];
    if (value == null) continue;
    const values = Array.isArray(value) && !(value.length === 2 && value.every(Number.isInteger)) ? value : [value];
    if (!values.length || values.length > 6) throw topologyError("INVALID_START_ROOT_COUNT", player);
    starts[player] = values.map((root) => {
      const canonicalVertexId = resolve(root);
      if (!canonicalVertexId) throw topologyError("UNKNOWN_START_VERTEX", player);
      if (claimed.has(canonicalVertexId)) throw topologyError("DUPLICATE_START_VERTEX", player);
      claimed.add(canonicalVertexId);
      return canonicalVertexId;
    }).sort(compareStableIdentifiers);
  }

  const candidates = sorted(board.sampleIds);
  for (const player of players) {
    if (starts[player]) continue;
    const available = candidates.filter((id) => !claimed.has(id));
    if (!available.length) throw topologyError("INSUFFICIENT_START_VERTICES");
    if (!claimed.size) {
      starts[player] = [available[0]];
      claimed.add(available[0]);
      continue;
    }
    let best = available[0];
    let bestDistance = Number.NEGATIVE_INFINITY;
    for (const candidate of available) {
      const minimumDistance = Math.min(...[...claimed].map((source) =>
        graphDistances(board, source).get(candidate) ?? Number.NEGATIVE_INFINITY));
      if (minimumDistance > bestDistance
        || (minimumDistance === bestDistance && compareStableIdentifiers(candidate, best) < 0)) {
        best = candidate;
        bestDistance = minimumDistance;
      }
    }
    starts[player] = [best];
    claimed.add(best);
  }
  return starts;
}

function coordinateAliasesFor(board) {
  const aliases = new Map();
  for (const copy of board.atlas.pointCopies) {
    const key = copy.coordinate.join(",");
    const existing = aliases.get(key);
    // A chart coordinate which represents more than one quotient point is not
    // a valid persistence identity; callers must use its canonical ID.
    aliases.set(key, existing && existing !== copy.canonicalVertexId ? null : copy.canonicalVertexId);
  }
  return aliases;
}

function compiledBoardWithStarts(board, starts) {
  const current = topologyStartingRoots(board);
  const same = Object.keys(current).length === Object.keys(starts).length
    && Object.entries(starts).every(([player, roots]) => stableStringify(current[player]) === stableStringify(roots));
  if (same) return board;
  const sourceByCanonical = new Map(board.canonicalVertices.map((vertex) =>
    [vertex.id, vertex.sourceVertexIds[0]]));
  const definition = cloneJson(board.definition);
  definition.startingVertices = Object.fromEntries(Object.entries(starts).map(([player, roots]) => {
    const sources = roots.map((canonicalVertexId) => {
      const source = sourceByCanonical.get(canonicalVertexId);
      if (!source) throw topologyError("UNKNOWN_START_VERTEX", canonicalVertexId);
      return source;
    });
    return [player, sources.length === 1 ? sources[0] : sources];
  }));
  const compiled = compileBoard(definition);
  if (!compiled.ok) {
    throw topologyError("INVALID_STARTING_LAYOUT",
      compiled.errors.map((error) => error.code + "@" + error.location).join(", "));
  }
  return compiled.value;
}

function cloneTerritory(territory) {
  return {
    polygon: null,
    area: territory.area,
    displayArea: territory.displayArea ?? territory.area,
    renderPoints: [...(territory.renderPoints ?? [])],
    ...(territory.components ? { components: territory.components.map((component) => ({
      ...component,
      sampleIds: [...component.sampleIds],
    })) } : {}),
  };
}

function cloneTopologyPaths(paths) {
  return Object.fromEntries(Object.entries(paths).map(([player, map]) => [
    player,
    [...map.values()].map(cloneConnection),
  ]));
}

// This is deliberately a display-only atlas.  Canonical IDs remain the only
// identities exposed to rules, persistence and clicks; raw source IDs merely
// select which unfolded copy is drawn at a seam.
function buildTopologyViewBoard(board) {
  const copyIdFor = (sourceVertexId) => "copy:" + sourceVertexId;
  const pointCopies = board.atlas.pointCopies.map((copy) => ({
    id: copyIdFor(copy.sourceVertexId),
    canonicalVertexId: copy.canonicalVertexId,
    sourceVertexId: copy.sourceVertexId,
    coordinate: [...copy.coordinate],
  }));
  const edgeOccurrenceById = new Map(board.edgeOccurrences.map((occurrence) => [occurrence.id, occurrence]));
  const copiesForOccurrence = (occurrence) => occurrence?.vertices?.map(copyIdFor) ?? [];
  const realBoundarySegments = board.edgeClasses
    .filter((edgeClass) => edgeClass.occurrences.length === 1)
    .map((edgeClass) => {
      const occurrence = edgeClass.occurrences[0];
      return {
        id: "boundary:" + edgeClass.id,
        copyIds: copiesForOccurrence(occurrence),
      };
    });
  const seamPairs = (board.definition.seamPairs ?? []).map((pair) => {
    const left = edgeOccurrenceById.get(pair.edgeOccurrenceA);
    const right = edgeOccurrenceById.get(pair.edgeOccurrenceB);
    return {
      id: pair.id,
      edgeOccurrenceA: pair.edgeOccurrenceA,
      edgeOccurrenceB: pair.edgeOccurrenceB,
      endpointMap: [...pair.endpointMap],
      copyIds: [...copiesForOccurrence(left), ...copiesForOccurrence(right)],
    };
  });
  return {
    pointCopies,
    realBoundarySegments,
    seamPairs,
    faces: board.definition.faces.map((face) => ({
      id: face.id,
      copyIds: face.vertices.map(copyIdFor),
      canonicalVertexIds: face.vertices.map((id) => board.rawVertexToCanonical[id]),
    })),
    // Every occurrence is local to one chart and is safe to use as a guide
    // edge.  Paired occurrences remain visually separated at seams.
    displayEdges: board.edgeOccurrences.map((occurrence) => ({
      id: "guide:" + occurrence.id,
      copyIds: copiesForOccurrence(occurrence),
    })),
  };
}

function attachGameEnginePrototype(instance, basePrototype) {
  if (Object.getPrototypeOf(TopologyGameEngine.prototype) !== basePrototype) {
    Object.setPrototypeOf(TopologyGameEngine.prototype, basePrototype);
  }
  return instance;
}

export class TopologyGameEngine {
  constructor(options, runtime) {
    attachGameEnginePrototype(this, runtime.basePrototype);
    this._runtime = runtime;
    this.compiledBoard = normalizeCompiledBoard(options);
    this.rulesVersion = options.rulesVersion ?? runtime.surfaceRulesVersion;
    if (this.rulesVersion !== runtime.surfaceRulesVersion) {
      throw topologyError("UNSUPPORTED_TOPOLOGY_RULES_VERSION", String(this.rulesVersion));
    }

    this.boardShape = "custom";
    this.isTopologyBoard = true;
    this.playerCount = options.playerCount ?? Math.max(2,
      Object.keys(this.compiledBoard.startingVertices ?? {}).length || 2);
    if (!Number.isInteger(this.playerCount) || this.playerCount < 2 || this.playerCount > 6) {
      throw topologyError("INVALID_PLAYER_COUNT");
    }
    this.activePlayers = runtime.playerOrder.slice(0, this.playerCount);
    this.startPlayer = this.activePlayers.includes(options.startPlayer)
      ? options.startPlayer : this.activePlayers[0];
    if (options.turnOrder !== undefined && (!Array.isArray(options.turnOrder)
      || options.turnOrder.length !== this.activePlayers.length || new Set(options.turnOrder).size !== this.activePlayers.length
      || !options.turnOrder.every((player) => this.activePlayers.includes(player)) || options.turnOrder[0] !== this.startPlayer)) {
      throw topologyError("INVALID_TURN_ORDER");
    }
    this.explicitTurnOrder = options.turnOrder !== undefined;
    this.turnOrder = Object.freeze(this.explicitTurnOrder ? [...options.turnOrder] : [...this.activePlayers]);
    this.currentPlayer = this.startPlayer;
    const provisionalAliases = coordinateAliasesFor(this.compiledBoard);
    const selectedStarts = selectInitialPositions(
      this.compiledBoard, this.activePlayers, options.initialPositions, provisionalAliases,
    );
    // Starts are gameplay, not presentation.  When an application supplies a
    // start layout, freeze it back into the definition before exposing the
    // boardHash so saves, replays and rooms cannot describe a different game.
    this.compiledBoard = compiledBoardWithStarts(this.compiledBoard, selectedStarts);
    this.boardDefinition = cloneJson(this.compiledBoard.definition);
    this.boardHash = this.compiledBoard.boardHash;
    this.topologyContractVersion = this.compiledBoard.contractVersion;
    this._viewBoard = buildTopologyViewBoard(this.compiledBoard);
    this.gridSize = options.gridSize ?? Math.max(1, this.compiledBoard.sampleIds.length);
    this.boardVertices = this.compiledBoard.atlas.pointCopies
      .map((copy) => [...copy.coordinate]);
    this.validPositions = [...this.compiledBoard.sampleIds];
    this.positionKeys = new Set(this.validPositions);
    this._coordinateAliases = coordinateAliasesFor(this.compiledBoard);
    this.hasCustomInitialPositions = options.initialPositions != null;
    this.initialPositions = { ...this.compiledBoard.startingVertices };
    this.initialRoots = topologyStartingRoots(this.compiledBoard);

    this.grid = new Map(this.validPositions.map((id) => [id, runtime.pointState.EMPTY]));
    this.edges = Object.fromEntries(this.activePlayers.map((player) => [player, new Set()]));
    this.topologyPaths = Object.fromEntries(this.activePlayers.map((player) => [player, new Map()]));
    for (const player of this.activePlayers) {
      for (const root of this.initialRoots[player]) this._setState(root, this._getPlayerStates(player).node);
    }

    this.historyHashes = new Set();
    this.resignedPlayers = new Set();
    this.gameOver = false;
    this.consecutiveSkips = 0;
    this.passHistory = [];
    this.turnCount = 0;
    this.positionRevision = 0;
    this.deferTerritoryUpdates = Boolean(options.deferTerritoryUpdates);
    this._territoryStateRevision = 0;
    this._territoryCacheRevision = 0;
    this._isReplayingBatch = false;
    this.cachedTerritories = Object.fromEntries(this.activePlayers.map((player) => [player, {
      polygon: null, area: 0, displayArea: 0, renderPoints: [],
    }]));
    this._updateTerritories();
    this.historyHashes.add(this._computeStateHash(this.currentPlayer));
  }

  _canonicalId(value) {
    if (typeof value === "string") {
      if (this.positionKeys.has(value)) return value;
      return this.compiledBoard.rawVertexToCanonical[value] ?? null;
    }
    if (Array.isArray(value) && value.length === 2 && value.every(Number.isInteger)) {
      return this._coordinateAliases.get(value.join(",")) ?? null;
    }
    return null;
  }

  _getPlayerStates(player) {
    return this._runtime.playerPointStates[player];
  }

  _getOpponents(player) {
    return this.activePlayers.filter((candidate) => candidate !== player);
  }

  _getInitialPosition(player) {
    return this.initialPositions[player];
  }

  _getInitialPositions(player) {
    return [...this.initialRoots[player]];
  }

  _getState(point) {
    const id = this._canonicalId(point);
    return id ? this.grid.get(id) : undefined;
  }

  _setState(point, state) {
    const id = this._canonicalId(point);
    if (!id) throw topologyError("INVALID_TOPOLOGY_POSITION");
    this.grid.set(id, state);
  }

  isValidPosition(point) {
    return this._canonicalId(point) != null;
  }

  _assertValidPosition(point) {
    if (!this.isValidPosition(point)) throw topologyError("INVALID_TOPOLOGY_POSITION");
  }

  getCurrentPlayer() {
    return this.currentPlayer;
  }

  getValidPositions() {
    return [...this.validPositions];
  }

  getStateAt(point) {
    const id = this._canonicalId(point);
    return id ? this.grid.get(id) : null;
  }

  getBoardMatrix() {
    // Topology boards intentionally do not expose a fake rectangle. Renderers
    // consume topology.pointCopies / boardStates from the snapshot instead.
    return [];
  }

  getAdjacentPositions(point) {
    const id = this._canonicalId(point);
    return id ? [...(this.compiledBoard.sampleAdjacency[id] ?? [])] : [];
  }

  canConnect(pointA, pointB) {
    const start = this._canonicalId(pointA);
    const end = this._canonicalId(pointB);
    if (!start || !end || start === end) return false;
    return enumerateConnections(this.compiledBoard, { coverageByPlayer: { BLACK: [end] } }, start, "BLACK")
      .some((connection) => connection.endVertexId === end);
  }

  getLinePoints(start, end) {
    const left = this._canonicalId(start);
    const right = this._canonicalId(end);
    if (!left || !right || left === right) return [];
    for (const player of this.activePlayers) {
      for (const connection of this.topologyPaths[player].values()) {
        if ((connection.startVertexId === left && connection.endVertexId === right)
          || (connection.startVertexId === right && connection.endVertexId === left)) {
          return [...connection.vertices];
        }
      }
    }
    const coverageByPlayer = { BLACK: [right] };
    const candidate = enumerateConnections(this.compiledBoard, { coverageByPlayer }, left, "BLACK")
      .find((connection) => connection.endVertexId === right);
    return candidate ? [...candidate.vertices] : [];
  }

  canConnectWithBlocking(pointA, pointB, player = this.currentPlayer) {
    const start = this._canonicalId(pointA);
    const end = this._canonicalId(pointB);
    if (!start || !end || start === end) return false;
    const coverageByPlayer = this._coverageByPlayer(start);
    for (const owner of this.activePlayers) {
      coverageByPlayer[owner] = coverageByPlayer[owner].filter((id) => id !== end);
    }
    coverageByPlayer[player] ??= [];
    if (!coverageByPlayer[player].includes(end)) coverageByPlayer[player].push(end);
    return enumerateConnections(this.compiledBoard, { coverageByPlayer, nodesByPlayer: { [player]: [end] } }, start, player)
      .some((connection) => connection.endVertexId === end);
  }

  _coverageByPlayer(excludedId = null) {
    const coverageByPlayer = {};
    for (const player of this.activePlayers) {
      const { node, line } = this._getPlayerStates(player);
      coverageByPlayer[player] = this.validPositions.filter((id) =>
        id !== excludedId && (this.grid.get(id) === node || this.grid.get(id) === line));
    }
    return coverageByPlayer;
  }

  _getPlayerNodes(player) {
    const node = this._getPlayerStates(player).node;
    return this.validPositions.filter((id) => this.grid.get(id) === node);
  }

  _getPlayerLines(player) {
    const line = this._getPlayerStates(player).line;
    return this.validPositions.filter((id) => this.grid.get(id) === line);
  }

  _getEdges(player) {
    return this.edges[player];
  }

  _checkThreePointLimitation(vertexId, player) {
    const node = this._getPlayerStates(player).node;
    const adjacentNodes = this.getAdjacentPositions(vertexId)
      .filter((id) => this.grid.get(id) === node);
    if (adjacentNodes.length >= 2) return false;
    return adjacentNodes.every((id) => !this.getAdjacentPositions(id)
      .some((next) => next !== vertexId && this.grid.get(next) === node));
  }

  _isInProtectionZone(vertexId, player) {
    return this._getOpponents(player).some((opponent) =>
      this.initialRoots[opponent].some((root) => this.getAdjacentPositions(root).includes(vertexId)));
  }

  _isEnemyState(state, player) {
    return this._getOpponents(player).some((opponent) => {
      const states = this._getPlayerStates(opponent);
      return state === states.node || state === states.line;
    });
  }

  _isEnemyLineState(state, player) {
    return this._getOpponents(player)
      .some((opponent) => state === this._getPlayerStates(opponent).line);
  }

  _isOwnLineState(state, player) {
    return state === this._getPlayerStates(player).line;
  }

  _pathsIntactFor(player, connection) {
    const states = this._getPlayerStates(player);
    if (this.grid.get(connection.startVertexId) !== states.node
      || this.grid.get(connection.endVertexId) !== states.node) return false;
    return connection.vertices.every((vertexId) => !this._isEnemyState(this.grid.get(vertexId), player));
  }

  _rebuildTopology() {
    for (const player of this.activePlayers) {
      const line = this._getPlayerStates(player).line;
      for (const vertexId of this.validPositions) {
        if (this.grid.get(vertexId) === line) this.grid.set(vertexId, this._runtime.pointState.EMPTY);
      }
    }

    for (const player of this.activePlayers) {
      const paths = this.topologyPaths[player];
      for (const [pathId, connection] of [...paths]) {
        if (!this._pathsIntactFor(player, connection)) paths.delete(pathId);
      }
      this.edges[player] = new Set(sorted(paths.keys()));
      const line = this._getPlayerStates(player).line;
      const node = this._getPlayerStates(player).node;
      for (const connection of paths.values()) {
        for (const vertexId of connection.vertices) {
          if (this.grid.get(vertexId) === this._runtime.pointState.EMPTY) {
            this.grid.set(vertexId, line);
          } else if (this.grid.get(vertexId) === node) {
            // A node can sit on an existing logical path without breaking it.
          }
        }
      }
    }

    // A line attack may sever an explicit route.  Remove all disconnected
    // non-root structures and repeat once after their paths disappear.
    let removed = false;
    for (const player of this.activePlayers) {
      const states = this._getPlayerStates(player);
      const roots = this.initialRoots[player];
      const reachable = new Set(roots);
      const queue = [...roots];
      const adjacency = new Map();
      for (const connection of this.topologyPaths[player].values()) {
        if (!adjacency.has(connection.startVertexId)) adjacency.set(connection.startVertexId, []);
        if (!adjacency.has(connection.endVertexId)) adjacency.set(connection.endVertexId, []);
        adjacency.get(connection.startVertexId).push(connection.endVertexId);
        adjacency.get(connection.endVertexId).push(connection.startVertexId);
      }
      for (let index = 0; index < queue.length; index += 1) {
        for (const next of adjacency.get(queue[index]) ?? []) {
          if (!reachable.has(next)) {
            reachable.add(next);
            queue.push(next);
          }
        }
      }
      for (const vertexId of this.validPositions) {
        if (this.grid.get(vertexId) === states.node && !reachable.has(vertexId)) {
          this.grid.set(vertexId, this._runtime.pointState.EMPTY);
          removed = true;
        }
      }
    }
    if (removed) {
      for (const player of this.activePlayers) {
        for (const [pathId, connection] of [...this.topologyPaths[player]]) {
          if (!this._pathsIntactFor(player, connection)) this.topologyPaths[player].delete(pathId);
        }
      }
      this._rebuildTopology();
    }
  }

  _connectionsForPlacement(vertexId, player, originalState) {
    const position = {
      coverageByPlayer: this._coverageByPlayer(
        this._isOwnLineState(originalState, player) || this._isEnemyLineState(originalState, player)
          ? vertexId : null,
      ),
      nodesByPlayer: Object.fromEntries(this.activePlayers.map((owner) =>
        [owner, this._getPlayerNodes(owner)])),
    };
    return enumerateConnections(this.compiledBoard, position, vertexId, player);
  }

  _crawlTopology(player) {
    const nodes = this._getPlayerNodes(player);
    const nodeSet = new Set(nodes);
    for (const source of nodes) {
      const coverageByPlayer = this._coverageByPlayer(source);
      const candidates = enumerateConnections(this.compiledBoard, {
        coverageByPlayer,
        nodesByPlayer: { [player]: nodes.filter((id) => id !== source) },
      }, source, player);
      for (const path of candidates) {
        // The legacy crawl connects the first node in each direction.
        if (path.vertices.slice(1, -1).some((id) => nodeSet.has(id))) continue;
        if ([...this.topologyPaths[player].values()].some((existing) =>
          this.boardDefinition.topology.movementStrategy === "simple-rays-v3"
            ? physicalPathKey(this.compiledBoard, existing) === physicalPathKey(this.compiledBoard, path)
            : samePhysicalPath(existing, path))) continue;
        this.topologyPaths[player].set(path.pathId, cloneConnection(path));
      }
      this._rebuildTopology();
    }
  }

  _addNode(point, player = this.currentPlayer) {
    const vertexId = this._canonicalId(point);
    if (!vertexId || this.resignedPlayers.has(player)) return false;
    const originalState = this.grid.get(vertexId);
    const empty = originalState === this._runtime.pointState.EMPTY;
    const ownLine = this._isOwnLineState(originalState, player);
    const enemyLine = this._isEnemyLineState(originalState, player);
    if (!empty && !ownLine && !enemyLine) return false;
    if (this._isInProtectionZone(vertexId, player)) return false;
    const cutsEnemyPath = enemyLine && this._getOpponents(player).some((opponent) =>
      [...this.topologyPaths[opponent].values()].some((path) =>
        path.vertices.slice(1, -1).includes(vertexId) && this._pathsIntactFor(opponent, path)));
    if (!cutsEnemyPath && !this._checkThreePointLimitation(vertexId, player)) return false;

    const connections = this._connectionsForPlacement(vertexId, player, originalState);
    if (!connections.length) return false;
    this.grid.set(vertexId, this._getPlayerStates(player).node);
    for (const connection of connections) {
      this.topologyPaths[player].set(connection.pathId, cloneConnection(connection));
    }
    this._rebuildTopology();
    if (cutsEnemyPath) {
      this._crawlTopology(player);
      for (const opponent of this._getOpponents(player)) this._crawlTopology(opponent);
    }
    return this.grid.get(vertexId) === this._getPlayerStates(player).node;
  }

  _computeStateHash(nextPlayer) {
    const occupied = this.validPositions
      .filter((id) => this.grid.get(id) !== this._runtime.pointState.EMPTY)
      .map((id) => [id, this.grid.get(id)]);
    const paths = this.activePlayers.map((player) =>
      [...this.topologyPaths[player].values()]
        .sort((left, right) => compareStableIdentifiers(left.pathId, right.pathId)).map((connection) => [
        connection.pathId,
        connection.startVertexId,
        connection.endVertexId,
        connection.vertices,
      ]));
    return JSON.stringify([
      "topology-state-v1", this.boardHash, nextPlayer,
      this.activePlayers.filter((player) => this.resignedPlayers.has(player)),
      occupied, paths,
      ...(this.explicitTurnOrder ? [this.turnOrder] : []),
    ]);
  }

  _captureTopologyState() {
    return {
      grid: new Map(this.grid),
      edges: Object.fromEntries(this.activePlayers.map((player) => [player, new Set(this.edges[player])])),
      topologyPaths: Object.fromEntries(this.activePlayers.map((player) => [
        player,
        new Map([...this.topologyPaths[player]].map(([pathId, connection]) =>
          [pathId, cloneConnection(connection)])),
      ])),
      historyHashes: new Set(this.historyHashes),
      currentPlayer: this.currentPlayer,
      gameOver: this.gameOver,
      consecutiveSkips: this.consecutiveSkips,
      passHistory: this.passHistory.map((entry) => ({ ...entry })),
      resignedPlayers: new Set(this.resignedPlayers),
      turnCount: this.turnCount,
      positionRevision: this.positionRevision,
      territoryStateRevision: this._territoryStateRevision,
      territoryCacheRevision: this._territoryCacheRevision,
      cachedTerritories: Object.fromEntries(this.activePlayers.map((player) =>
        [player, cloneTerritory(this.cachedTerritories[player])])),
    };
  }

  _restoreTopologyState(state) {
    this.grid = new Map(state.grid);
    this.edges = Object.fromEntries(this.activePlayers.map((player) => [player, new Set(state.edges[player])]));
    this.topologyPaths = Object.fromEntries(this.activePlayers.map((player) => [
      player,
      new Map([...state.topologyPaths[player]].map(([pathId, connection]) =>
        [pathId, cloneConnection(connection)])),
    ]));
    this.historyHashes = new Set(state.historyHashes);
    this.currentPlayer = state.currentPlayer;
    this.gameOver = state.gameOver;
    this.consecutiveSkips = state.consecutiveSkips;
    this.passHistory = state.passHistory.map((entry) => ({ ...entry }));
    this.resignedPlayers = new Set(state.resignedPlayers);
    this.turnCount = state.turnCount;
    this.positionRevision = state.positionRevision;
    this._territoryStateRevision = state.territoryStateRevision;
    this._territoryCacheRevision = state.territoryCacheRevision;
    this.cachedTerritories = Object.fromEntries(this.activePlayers.map((player) =>
      [player, cloneTerritory(state.cachedTerritories[player])]));
  }

  _evaluateMove(point, player = this.currentPlayer) {
    if (this.resignedPlayers.has(player)) {
      return { legal: false, reason: "PLAYER_RESIGNED", state: null, isAttack: false };
    }
    const vertexId = this._canonicalId(point);
    if (!vertexId) return { legal: false, reason: "INVALID_MOVE", state: null, isAttack: false };
    const originalState = this.grid.get(vertexId);
    const state = this._captureTopologyState();
    try {
      if (!this._addNode(vertexId, player)) {
        return { legal: false, reason: "INVALID_MOVE", state: originalState, isAttack: false };
      }
      const stateHash = this._computeStateHash(this._getNextPlayer(player));
      if (this.historyHashes.has(stateHash)) {
        return {
          legal: false,
          reason: "SUPERKO_VIOLATION",
          state: originalState,
          isAttack: this._isEnemyLineState(originalState, player),
        };
      }
      return {
        legal: true,
        reason: null,
        state: originalState,
        isAttack: this._isEnemyLineState(originalState, player),
      };
    } finally {
      this._restoreTopologyState(state);
    }
  }

  getLegalMoves(player = this.currentPlayer) {
    const moves = [];
    for (const vertexId of this.validPositions) {
      const evaluation = this._evaluateMove(vertexId, player);
      if (evaluation.legal) moves.push({
        point: vertexId,
        vertexId,
        state: evaluation.state,
        isAttack: evaluation.isAttack,
      });
    }
    return moves;
  }

  _hasValidMoves(player) {
    return this.getLegalMoves(player).length > 0;
  }

  _switchPlayer() {
    const currentIndex = this.turnOrder.indexOf(this.currentPlayer);
    for (let offset = 1; offset <= this.turnOrder.length; offset += 1) {
      const next = this.turnOrder[(currentIndex + offset) % this.turnOrder.length];
      if (!this.resignedPlayers.has(next)) {
        this.currentPlayer = next;
        return;
      }
    }
  }

  _getNextPlayer(player = this.currentPlayer) {
    const currentIndex = this.turnOrder.indexOf(player);
    for (let offset = 1; offset <= this.turnOrder.length; offset += 1) {
      const next = this.turnOrder[(currentIndex + offset) % this.turnOrder.length];
      if (!this.resignedPlayers.has(next)) return next;
    }
    return player;
  }

  _getRemainingPlayers() {
    return this.activePlayers.filter((player) => !this.resignedPlayers.has(player));
  }

  _checkResignationFinish() {
    const remaining = this._getRemainingPlayers();
    if (remaining.length <= 1) {
      this.gameOver = true;
      if (remaining.length === 1) this.currentPlayer = remaining[0];
      return true;
    }
    return false;
  }

  _checkAndAutoSkip() {
    if (this.gameOver || this._checkResignationFinish()) return;
    if (!this._hasValidMoves(this.currentPlayer)) {
      this.consecutiveSkips += 1;
      if (this.consecutiveSkips >= this._getRemainingPlayers().length) {
        this.gameOver = true;
      } else {
        this._switchPlayer();
        this._checkAndAutoSkip();
      }
    }
  }

  _topologyPositionForTerritory() {
    return { ownedSampleIdsByPlayer: this._coverageByPlayer() };
  }

  _updateTerritories() {
    const position = this._topologyPositionForTerritory();
    for (const player of this.activePlayers) {
      const result = computeTerritory(this.compiledBoard, position, player);
      this.cachedTerritories[player] = {
        polygon: null,
        area: result.area,
        displayArea: result.area,
        renderPoints: sorted(new Set([...result.ownedSampleIds, ...result.enclosedSampleIds])),
        components: result.components.map((component) => ({
          ...component,
          sampleIds: [...component.sampleIds],
        })),
      };
    }
    this._territoryCacheRevision = this._territoryStateRevision;
  }

  _computeTerritory(player) {
    return cloneTerritory(this.cachedTerritories[player]);
  }

  hasPendingTerritoryUpdate() {
    return this._territoryCacheRevision !== this._territoryStateRevision;
  }

  getTerritoryStateRevision() {
    return this._territoryStateRevision;
  }

  applyTerritoryCache(territories, territoryStateRevision = this._territoryStateRevision) {
    if (territoryStateRevision !== this._territoryStateRevision || !territories) return false;
    const next = {};
    for (const player of this.activePlayers) {
      const territory = territories[player];
      if (!territory || !Number.isFinite(territory.area) || territory.area < 0
        || !Array.isArray(territory.renderPoints)
        || territory.renderPoints.some((id) => !this.positionKeys.has(id))) return false;
      if (territory.components != null && (!Array.isArray(territory.components)
        || territory.components.some((component) => !Array.isArray(component.sampleIds)
          || component.sampleIds.some((id) => !this.positionKeys.has(id))
          || typeof component.counted !== "boolean"))) return false;
      const components = territory.components
        ?? computeTerritory(this.compiledBoard, this._topologyPositionForTerritory(), player).components;
      next[player] = {
        polygon: null,
        area: territory.area,
        displayArea: Number.isFinite(territory.displayArea) ? territory.displayArea : territory.area,
        renderPoints: [...new Set(territory.renderPoints)],
        components: components.map((component) => ({ ...component, sampleIds: [...component.sampleIds] })),
      };
    }
    this.cachedTerritories = next;
    this._territoryCacheRevision = this._territoryStateRevision;
    return true;
  }

  getScoreboard() {
    return Object.fromEntries(this.activePlayers.map((player) =>
      [player, cloneTerritory(this.cachedTerritories[player])]));
  }

  getWinner() {
    if (!this.gameOver) return null;
    if (this.hasPendingTerritoryUpdate()) this._updateTerritories();
    const candidates = this._getRemainingPlayers();
    const players = candidates.length ? candidates : this.activePlayers;
    let winner = null;
    let area = Number.NEGATIVE_INFINITY;
    let draw = false;
    for (const player of players) {
      const value = this.cachedTerritories[player].area;
      if (value > area) {
        area = value;
        winner = player;
        draw = false;
      } else if (value === area) {
        draw = true;
      }
    }
    return draw ? "DRAW" : winner;
  }

  _getSnapshotLegalMoves() {
    return this.getLegalMoves(this.currentPlayer).map((move) => ({ ...move }));
  }

  getSnapshot() {
    const scores = this.getScoreboard();
    const paths = cloneTopologyPaths(this.topologyPaths);
    return {
      gridSize: this.gridSize,
      playerCount: this.playerCount,
      boardShape: this.boardShape,
      isTopologyBoard: true,
      boardHash: this.boardHash,
      boardDefinition: cloneJson(this.boardDefinition),
      topologyContractVersion: this.topologyContractVersion,
      topology: {
        canonicalVertices: this.compiledBoard.canonicalVertices.map((vertex) => ({
          id: vertex.id,
          sourceVertexIds: [...vertex.sourceVertexIds],
          atlasCoordinates: vertex.atlasCoordinates.map((coordinate) => [...coordinate]),
        })),
        canonicalAdjacency: cloneJson(this.compiledBoard.canonicalAdjacency),
        realBoundarySampleIds: [...this.compiledBoard.realBoundarySampleIds],
        pointCopies: this.compiledBoard.atlas.pointCopies.map((copy) => ({ ...copy, coordinate: [...copy.coordinate] })),
        startingRoots: cloneJson(this.initialRoots),
        protectionZones: this.validPositions.map((canonicalVertexId) => ({
          canonicalVertexId,
          owners: this.activePlayers.filter((owner) =>
            this.initialRoots[owner].some((root) => this.getAdjacentPositions(root).includes(canonicalVertexId))),
        })).filter((entry) => entry.owners.length),
        viewBoard: cloneJson(this._viewBoard),
      },
      boardVertices: this.boardVertices.map((coordinate) => [...coordinate]),
      initialPositions: { ...this.initialPositions },
      initialRoots: cloneJson(this.initialRoots),
      rulesVersion: this.rulesVersion,
      positionRevision: this.positionRevision,
      players: [...this.activePlayers],
      startPlayer: this.startPlayer,
      ...(this.explicitTurnOrder ? { turnOrder: [...this.turnOrder] } : {}),
      currentPlayer: this.currentPlayer,
      gameOver: this.gameOver,
      territoryPending: this.hasPendingTerritoryUpdate(),
      consecutiveSkips: this.consecutiveSkips,
      passHistory: this.passHistory.map((entry) => ({ ...entry })),
      resignedPlayers: [...this.resignedPlayers],
      turnCount: this.turnCount,
      boardMatrix: [],
      boardStates: Object.fromEntries(this.validPositions.map((id) => [id, this.grid.get(id)])),
      territories: scores,
      edges: Object.fromEntries(this.activePlayers.map((player) => [player, sorted(this.edges[player])])),
      topologyPaths: paths,
      winner: this.getWinner(),
      legalMoves: this._getSnapshotLegalMoves(),
    };
  }

  _createActionResult(success, reason) {
    return { success, reason, snapshot: this._isReplayingBatch ? null : this.getSnapshot() };
  }

  playMove(point) {
    if (this.gameOver) return this._createActionResult(false, "GAME_OVER");
    const state = this._captureTopologyState();
    if (!this._addNode(point, this.currentPlayer)) return this._createActionResult(false, "INVALID_MOVE");
    const stateHash = this._computeStateHash(this._getNextPlayer(this.currentPlayer));
    if (this.historyHashes.has(stateHash)) {
      this._restoreTopologyState(state);
      return this._createActionResult(false, "SUPERKO_VIOLATION");
    }
    this.historyHashes.add(stateHash);
    this.turnCount += 1;
    this.positionRevision += 1;
    this._territoryStateRevision += 1;
    this.consecutiveSkips = 0;
    this._switchPlayer();
    this._checkAndAutoSkip();
    if (!this.deferTerritoryUpdates || this.gameOver) this._updateTerritories();
    return this._createActionResult(true, null);
  }

  skipTurn() {
    if (this.gameOver) return this._createActionResult(false, "GAME_OVER");
    this.passHistory.push({ player: this.currentPlayer, turn: this.turnCount + this.passHistory.length + 1 });
    this.consecutiveSkips += 1;
    this.positionRevision += 1;
    if (this.consecutiveSkips >= this._getRemainingPlayers().length) {
      this.gameOver = true;
    } else {
      this._switchPlayer();
      this._checkAndAutoSkip();
    }
    return this._createActionResult(true, null);
  }

  resignPlayer(player = this.currentPlayer) {
    if (this.gameOver) return this._createActionResult(false, "GAME_OVER");
    if (!this.activePlayers.includes(player)) return this._createActionResult(false, "UNKNOWN_PLAYER");
    if (this.resignedPlayers.has(player)) return this._createActionResult(false, "PLAYER_ALREADY_RESIGNED");
    this.resignedPlayers.add(player);
    this.turnCount += 1;
    this.positionRevision += 1;
    this.consecutiveSkips = 0;
    if (!this._checkResignationFinish() && this.currentPlayer === player) {
      this._switchPlayer();
      this._checkAndAutoSkip();
    }
    return this._createActionResult(true, null);
  }

  getTopologyRuleState() {
    const vertexStateById = {};
    for (const vertexId of this.validPositions) {
      const state = this.grid.get(vertexId);
      if (state === this._runtime.pointState.EMPTY) continue;
      const owner = this.activePlayers.find((player) => {
        const states = this._getPlayerStates(player);
        return state === states.node || state === states.line;
      });
      if (!owner) throw topologyError("UNKNOWN_VERTEX_OWNER", vertexId);
      const states = this._getPlayerStates(owner);
      vertexStateById[vertexId] = {
        owner,
        node: state === states.node,
        line: state === states.line,
      };
    }
    const logicPaths = this.activePlayers.flatMap((player) =>
      [...this.topologyPaths[player].values()]
        .sort((left, right) => compareStableIdentifiers(left.pathId, right.pathId))
        .map((connection) => ({ ...cloneConnection(connection), owner: player })));
    return {
      stateVersion: TOPOLOGY_RULE_STATE_VERSION,
      rulesVersion: this.rulesVersion,
      currentPlayer: this.currentPlayer,
      ...(this.explicitTurnOrder ? { turnOrder: [...this.turnOrder] } : {}),
      startingVertices: topologyStartingState(this.compiledBoard),
      vertexStateById,
      logicPaths,
      historyHashes: sorted(this.historyHashes),
      superkoPolicy: "enforce",
      consecutivePasses: this.consecutiveSkips,
      passHistory: this.passHistory.map((entry) => ({ ...entry })),
      resignedPlayers: [...this.resignedPlayers],
      gameOver: this.gameOver,
      terminal: this.gameOver ? {
        winner: this.getWinner(),
        territories: Object.fromEntries(this.activePlayers.map((player) => [
          player,
          { area: this.cachedTerritories[player].area },
        ])),
      } : null,
      turnCount: this.turnCount,
      positionRevision: this.positionRevision,
    };
  }

  encodeTopologyState(limits = {}) {
    return encodeTopologyState(this.compiledBoard, this.getTopologyRuleState(), limits);
  }

  _restoreTopologyRuleState(ruleState) {
    if (!ruleState || ruleState.rulesVersion !== this.rulesVersion) {
      throw topologyError("RULES_VERSION_MISMATCH");
    }
    if (stableStringify(ruleState.startingVertices) !== stableStringify(topologyStartingState(this.compiledBoard))) {
      throw topologyError("STARTING_VERTICES_MISMATCH");
    }
    if (JSON.stringify(ruleState.turnOrder ?? null) !== JSON.stringify(this.explicitTurnOrder ? this.turnOrder : null)) throw topologyError("TURN_ORDER_MISMATCH");
    if (ruleState.currentPlayer !== null && !this.activePlayers.includes(ruleState.currentPlayer)) {
      throw topologyError("UNKNOWN_CURRENT_PLAYER");
    }
    const candidateGrid = new Map(this.validPositions.map((id) => [id, this._runtime.pointState.EMPTY]));
    for (const [vertexId, state] of Object.entries(ruleState.vertexStateById)) {
      if (!this.positionKeys.has(vertexId) || !this.activePlayers.includes(state.owner)) {
        throw topologyError("INVALID_VERTEX_STATE", vertexId);
      }
      if (state.node && state.line) throw topologyError("UNSUPPORTED_COMBINED_VERTEX_STATE", vertexId);
      const playerStates = this._getPlayerStates(state.owner);
      candidateGrid.set(vertexId, state.node ? playerStates.node : playerStates.line);
    }
    for (const player of this.activePlayers) {
      if (this.initialRoots[player].some((root) => candidateGrid.get(root) !== this._getPlayerStates(player).node)) {
        throw topologyError("MISSING_START_NODE", player);
      }
    }
    const candidatePaths = Object.fromEntries(this.activePlayers.map((player) => [player, new Map()]));
    for (const path of ruleState.logicPaths) {
      if (!this.activePlayers.includes(path.owner) || candidatePaths[path.owner].has(path.pathId)) {
        throw topologyError("INVALID_LOGIC_PATH", path.pathId);
      }
      // A decoded path is not trustworthy merely because its IDs belong to
      // this board. Reconstruct its exact direction, atlas crossings and
      // vertices from the compiled geometry before it can affect ownership,
      // scoring or Superko.
      assertExactCompiledConnection(this.compiledBoard, path);
      if (["simple-rays-v2", "simple-rays-v3"].includes(this.compiledBoard.definition.topology.movementStrategy)) {
        if (new Set(path.vertices).size !== path.vertices.length) throw topologyError("INVALID_LOGIC_PATH", "Self-crossing path");
        const inner = new Set(path.vertices.slice(1, -1));
        for (const other of candidatePaths[path.owner].values()) {
          if (other.vertices.slice(1, -1).some(id => inner.has(id))) {
            throw topologyError("INVALID_LOGIC_PATH", "Crossing path interiors");
          }
        }
      }
      candidatePaths[path.owner].set(path.pathId, cloneConnection(path));
    }
    const before = this._captureTopologyState();
    try {
      this.grid = candidateGrid;
      this.topologyPaths = candidatePaths;
      this.edges = Object.fromEntries(this.activePlayers.map((player) => [player, new Set()]));
      this._rebuildTopology();
      const restored = this.getTopologyRuleState();
      if (stableStringify(restored.vertexStateById) !== stableStringify(ruleState.vertexStateById)) {
        throw topologyError("INCONSISTENT_TOPOLOGY_STATE", "Path coverage does not reproduce vertex state.");
      }
      this.historyHashes = new Set(ruleState.historyHashes);
      this.currentPlayer = ruleState.currentPlayer ?? this.startPlayer;
      this.consecutiveSkips = ruleState.consecutivePasses;
      this.passHistory = ruleState.passHistory.map((entry) => ({ ...entry }));
      this.resignedPlayers = new Set(ruleState.resignedPlayers);
      this.gameOver = ruleState.gameOver;
      this.turnCount = ruleState.turnCount;
      this.positionRevision = ruleState.positionRevision;
      this._territoryStateRevision = this.positionRevision;
      this._territoryCacheRevision = this.positionRevision;
      this._updateTerritories();
    } catch (error) {
      this._restoreTopologyState(before);
      throw error;
    }
  }

  restoreTopologyState(json, limits = {}) {
    const decoded = decodeTopologyState(json, limits);
    if (decoded.boardHash !== this.boardHash) {
      throw topologyError("BOARD_HASH_MISMATCH");
    }
    this._restoreTopologyRuleState(decoded.ruleState);
    return true;
  }

  replayBatch(callback) {
    if (typeof callback !== "function"
      || Object.prototype.toString.call(callback) === "[object AsyncFunction]") {
      throw topologyError("INVALID_REPLAY_CALLBACK");
    }
    const transaction = createTopologyGameEngine({
      compiledBoard: this.compiledBoard,
      playerCount: this.playerCount,
      startPlayer: this.startPlayer,
      ...(this.explicitTurnOrder ? { turnOrder: [...this.turnOrder] } : {}),
      initialPositions: this.initialRoots,
      rulesVersion: this.rulesVersion,
      deferTerritoryUpdates: this.deferTerritoryUpdates,
    }, this._runtime);
    transaction._restoreTopologyState(this._captureTopologyState());
    transaction._isReplayingBatch = true;
    let result;
    try {
      result = callback(transaction);
      if (result && typeof result.then === "function") throw topologyError("INVALID_REPLAY_CALLBACK");
    } finally {
      transaction._isReplayingBatch = false;
    }
    if (!result?.success) {
      return { ...(result ?? {}), success: false, reason: result?.reason ?? "REPLAY_FAILED", snapshot: null };
    }
    transaction._updateTerritories();
    const snapshot = transaction.getSnapshot();
    this._restoreTopologyState(transaction._captureTopologyState());
    return { ...result, snapshot };
  }
}

export function createTopologyGameEngine(options, runtime) {
  return new TopologyGameEngine(options, runtime);
}

// GameEngine deliberately stays import-free so its established data-URL
// regression harness can exercise legacy rules in isolation. Product entry
// points import this module before constructing a custom board; registration
// gives every cache-busted GameEngine module identity the same synchronous
// topology constructor without turning a legacy import into a relative-import
// dependency.
const TOPOLOGY_GAME_ENGINE_FACTORY = Symbol.for("lifeline.topology-game-engine-factory.v1");
Object.defineProperty(globalThis, TOPOLOGY_GAME_ENGINE_FACTORY, {
  value: createTopologyGameEngine,
  configurable: true,
  writable: true,
});
