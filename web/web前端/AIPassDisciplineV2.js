// Product-only extension. Frozen training and the original full-round guard
// continue to import AIPassDiscipline.js unchanged.
import { applyPassDiscipline as applyV1, nativeDiscreteAreas } from "./AIPassDiscipline.js?v=20261025-terminal-v4";
import { saveState, restoreState } from "./AIEngine.js?v=20261025-terminal-v4";
import { isolatedSearchEngine } from "./MultiplayerSearch.js?v=20261025-terminal-v4";
import { multiplayerClock } from "./MultiplayerClock.js?v=20261025-terminal-v4";

export const PASS_DISCIPLINE_CONTRACT = Object.freeze({
  schema: "lifeline-ai-pass-discipline-v2",
  safetyScope: "v1 complete actual opponent round, or a separately identified v3 immutable birth-root protection invariant through arbitrary opponent-only sequences until the actor next acts or resigns, or native terminal",
  structuralEligibility: "explicit real policy PASS; v1 produced no witness; canonical PASS is nonterminal; retained nodes/coverage, all post-root nodes joined to birth by intact logical edges, every own LINE cell adjacent to birth, occupied coverage strictly exceeds pre-move native area",
  training: "product runtime only; frozen v1 teacher, labels, policies and experiment inputs are unchanged",
});
export { nativeDiscreteAreas };
const key = point => point === null ? "PASS" : point.join(",");
const pieces = (engine, player) => {
  const nodes = new Set(engine._getPlayerNodes(player).map(key));
  return { nodes, lines: engine._getPlayerLines(player), coverage: new Set([...nodes, ...engine._getPlayerLines(player).map(key)]) };
};
const contains = (all, required) => [...required].every(point => all.has(point));
const TIMEOUT = Symbol("v2 shared proof budget");

// This check is separate so independent review/tests can refute each premise.
// The decision function alone supplies the canonical root and native beforeArea.
export function protectedRootInvariantHolds(engine, player, before, beforeArea) {
  if (engine.rulesVersion !== "territory-v3" || engine.resignedPlayers.has(player)) return false;
  const after = pieces(engine, player), connected = engine._getOpponentConnectedPieces(player);
  const protectedKeys = new Set(engine.getAdjacentPositions(engine.initialPositions[player]).map(key));
  return contains(after.nodes, before.nodes) && contains(after.coverage, before.coverage)
    && contains(connected, after.nodes) && after.lines.every(line => protectedKeys.has(key(line)))
    && after.coverage.size > beforeArea;
}


// Synchronous SHA-256 also works in native Workers without crypto/TextEncoder.
// Rule records below contain ASCII field names, player IDs, numbers and hashes.
export function passDisciplineAsciiSha256(text) {
  const bytes = Array.from(text, c => c.charCodeAt(0));
  if (bytes.some(byte => byte > 127)) throw new Error("Non-ASCII rule-state hash input");
  const bitLength = bytes.length * 8; bytes.push(128);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let i = 7; i >= 0; i--) bytes.push(i >= 4 ? 0 : Math.floor(bitLength / 2 ** (8 * i)) & 255);
  const k = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  const hash = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const rotate = (value, count) => value >>> count | value << (32 - count);
  for (let offset = 0; offset < bytes.length; offset += 64) {
    const w = Array(64);
    for (let i = 0; i < 16; i++) w[i] = bytes[offset + i * 4] << 24 | bytes[offset + i * 4 + 1] << 16 | bytes[offset + i * 4 + 2] << 8 | bytes[offset + i * 4 + 3];
    for (let i = 16; i < 64; i++) w[i] = ((rotate(w[i - 15], 7) ^ rotate(w[i - 15], 18) ^ w[i - 15] >>> 3)
      + w[i - 16] + (rotate(w[i - 2], 17) ^ rotate(w[i - 2], 19) ^ w[i - 2] >>> 10) + w[i - 7]) | 0;
    let [a,b,c,d,e,f,g,h] = hash;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotate(e,6) ^ rotate(e,11) ^ rotate(e,25)) + ((e & f) ^ (~e & g)) + k[i] + w[i]) | 0;
      const t2 = ((rotate(a,2) ^ rotate(a,13) ^ rotate(a,22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h=g;g=f;f=e;e=(d+t1)|0;d=c;c=b;b=a;a=(t1+t2)|0;
    }
    [a,b,c,d,e,f,g,h].forEach((value, index) => { hash[index] = (hash[index] + value) | 0; });
  }
  return "sha256:" + hash.map(value => (value >>> 0).toString(16).padStart(8, "0")).join("");
}
export function passDisciplineRuleState(source) {
  return { gridSize: source.gridSize, playerCount: source.playerCount, boardShape: source.boardShape,
    startPlayer: source.startPlayer, rulesVersion: source.rulesVersion,
    initialPositions: Object.fromEntries(source.activePlayers.map(player => [player, [...source.initialPositions[player]]])),
    activePlayers: [...source.activePlayers], gridEntries: [...source.grid].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
    edges: Object.fromEntries(source.activePlayers.map(player => [player, [...source.edges[player]].sort()])),
    historyHashes: [...source.historyHashes].sort(), resignedPlayers: [...source.resignedPlayers].sort(),
    consecutiveSkips: source.consecutiveSkips, currentPlayer: source.currentPlayer,
    gameOver: source.gameOver, turnCount: source.turnCount, positionRevision: source.positionRevision };
}
export const passDisciplineStateHash = source => passDisciplineAsciiSha256(JSON.stringify(passDisciplineRuleState(source)));

export function applyPassDiscipline(source, rankedMoves, { player = source.currentPlayer, topN = 5,
  timeMs = 200, maxNodes = 10000, now = () => multiplayerClock.now(), ...options } = {}) {
  const original = Array.isArray(rankedMoves) ? rankedMoves : [];
  const requested = Math.max(0, Math.floor(topN));
  // Preserve v1 semantics for missing output, actual placements, terminal PASS,
  // older rules, malformed output and actor validation.
  const legacy = extra => applyV1(source, original, { ...options, player, topN, timeMs, maxNodes, now, ...extra });
  if (!requested || source.gameOver || source.rulesVersion !== "territory-v3"
    || original[0]?.type !== "pass" || original[0]?.point !== null) return legacy();
  if (player !== source.currentPlayer || source.resignedPlayers.has(player)) return legacy();
  if (!Number.isFinite(timeMs) || timeMs < 0 || !Number.isInteger(maxNodes) || maxNodes < 0) return legacy();
  const started = now();
  if (!Number.isFinite(started)) return legacy();
  let nodes = 0;
  const remainingTime = () => {
    const time = now(); if (!Number.isFinite(time)) throw new Error("Invalid PASS discipline clock");
    return Math.max(0, timeMs - (time - started));
  };
  const budget = () => { if (remainingTime() <= 0 || nodes >= maxNodes) throw TIMEOUT; };
  let oldResult;
  try {
    budget();
    const engine = isolatedSearchEngine(source), initial = saveState(engine);
    budget(); nodes++;
    if (!engine.skipTurn().success) throw new Error("Canonical nonterminal PASS failed");
    budget();
    if (engine.gameOver) return legacy({ timeMs: remainingTime(), maxNodes: maxNodes - nodes });
    // Keep one shared wall-clock/node budget. V1 gets the entire remaining
    // budget and runs first; fallback uses only its actually unspent budget.
    const oldBudget = Math.max(0, maxNodes - nodes);
    oldResult = legacy({ timeMs: remainingTime(), maxNodes: oldBudget });
    nodes += oldResult.receipt?.nodes ?? 0;
    if (oldResult.receipt?.witness || oldResult.moves[0]?.point !== null) return oldResult;
    budget(); restoreState(engine, initial);
    const before = pieces(engine, player), beforeArea = nativeDiscreteAreas(engine, [player])[player];
    const legal = engine.getLegalMoves(player).map(move => [...move.point]);
    const preferred = original.filter(move => Array.isArray(move?.point)).map(move => key(move.point));
    legal.sort((a, b) => {
      const ai = preferred.indexOf(key(a)), bi = preferred.indexOf(key(b));
      return (ai < 0 ? Infinity : ai) - (bi < 0 ? Infinity : bi) || a[1] - b[1] || a[0] - b[0];
    });
    for (const point of legal) {
      budget(); restoreState(engine, initial); nodes++;
      if (!engine.playMove(point).success) throw new Error("PASS discipline root ceased to be legal");
      budget();
      if (!protectedRootInvariantHolds(engine, player, before, beforeArea)) continue;
      const after = pieces(engine, player), birth = engine.initialPositions[player];
      budget();
      const sourceStateHash = passDisciplineStateHash(source), postRootStateHash = passDisciplineStateHash(engine);
      budget();
      const receipt = { schema: PASS_DISCIPLINE_CONTRACT.schema, status: "safe-profitable-expansion", complete: true,
        actor: player, rulesVersion: source.rulesVersion, positionRevision: source.positionRevision,
        sourceStateHash, safetyScope: PASS_DISCIPLINE_CONTRACT.safetyScope, passWouldEnd: false,
        nodes, elapsedMs: now() - started, legacyReceipt: oldResult.receipt,
        witness: { point: [...point], beforeArea, minimumReplyAreaLowerBound: after.coverage.size,
          profitKind: "strict-native-area-gain", proofType: "immutable-birth-root-protection-invariant",
          beforeNodesRetained: true, beforeCoverageRetained: true, allPostRootNodesBirthConnected: true,
          allPostRootLinesBirthProtected: true, birth: [...birth], postRootCoverage: after.coverage.size,
          sourceStateHash, postRootStateHash, completeOpponentRound: false,
          scope: "All opponent-only legal action sequences, including repeated actors after automatic PASS, until actor next acts or resigns, or native terminal; no reply enumeration claimed" } };
      const existing = original.find(move => Array.isArray(move.point) && key(move.point) === key(point));
      const selected = existing ? { ...existing } : { type: "move", point: [...point], score: after.coverage.size - beforeArea, visits: 1 };
      selected.passDiscipline = { schema: receipt.schema, status: receipt.status, profitKind: receipt.witness.profitKind,
        proofType: receipt.witness.proofType };
      return { moves: [selected, ...original.filter(move => key(move.point) !== key(point))].slice(0, requested), receipt };
    }
    return oldResult;
  } catch (error) {
    if (error !== TIMEOUT) throw error;
    // No incomplete structural certificate is ever emitted. Preserve the real
    // policy PASS, and preserve the old no-output error path via legacy().
    return oldResult ?? legacy({ timeMs: 0, maxNodes: 0 });
  }
}

export function withPassDiscipline(policy) {
  if (policy?.passDisciplineContract === PASS_DISCIPLINE_CONTRACT.schema) return policy;
  return { passDisciplineContract: PASS_DISCIPLINE_CONTRACT.schema, lastSearch: null,
    getTopMoves(source, player = source.currentPlayer, topN = 5, options = {}) {
      // Nested v1/v2 adapters expose raw policy output to exactly one outer
      // decision guard. Product Workers/room bots apply that outer guard once.
      const ranked = policy.getTopMoves(source, player, topN > 0 ? Math.max(5, topN) : topN,
        { ...options, passDisciplinePrechecked: true });
      const result = options.passDisciplinePrechecked === true ? { moves: ranked, receipt: null }
        : applyPassDiscipline(source, ranked, { player, topN });
      this.lastSearch = { ...(policy.lastSearch ?? {}), ...(result.receipt ? { passDiscipline: result.receipt } : {}) };
      return result.moves;
    } };
}
