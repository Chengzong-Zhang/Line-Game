import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash, webcrypto } from "node:crypto";
import GameEngine from "../GameEngine.js?v=20260910d";
import { createResearchModel, loadResearchManifest, loadResearchModel, NeuralPUCTAI, encodeResearchPosition, researchRelations } from "../ResearchAI.js?v=20261012a";
import { saveState, restoreState } from "../AIEngine.js?v=20260921c";
import { serializeEngineState } from "../AIStateProtocol.js?v=20260830a";
import { researchProfile, loadResearchSelection, persistResearchSelection } from "../ResearchAIOptions.js?v=20261012a";

if (!globalThis.crypto?.subtle) globalThis.crypto = webcrypto;
const assetRoot = new URL("../assets/research-ai/", import.meta.url);
const transfer = JSON.parse(await readFile(new URL("transfer-v1/manifest.json", assetRoot), "utf8"));
assert.equal(transfer.models.length, 9);
assert.equal(transfer.default_seed, 2026092201);
assert.match(transfer.default_selection_basis, /not a strength ranking/);
const oldFetch = globalThis.fetch;
let corrupt = null;
globalThis.fetch = async (url) => {
  const bytes = await readFile(url);
  if (String(url).includes(corrupt ?? "impossible-asset-name")) bytes[0] ^= 1;
  return new Response(bytes);
};
const fingerprint = (engine) => JSON.stringify({ state: serializeEngineState(engine), cache: saveState(engine),
  territories: engine.cachedTerritories, replaying: engine._isReplayingBatch });
const report = { status: "PASS", models: 9, sizes: [5, 15], forward_cases: 0, puct_cases: 0,
  rule_equivalence: false, strength_evaluated: false, formal_ready: false };
try {
  const combined = await loadResearchManifest();
  assert.equal(combined.models.length, 12);
  for (const spec of combined.models) {
    const bytes = await readFile(new URL(spec.asset, assetRoot));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), spec.asset_sha256);
  }
  const broken = transfer.models[0];
  corrupt = broken.asset;
  await assert.rejects(loadResearchModel(broken.id), /哈希/);
  corrupt = null;
  for (const spec of transfer.models) {
    assert.equal(spec.evidence_tier, "pilot");
    assert.equal(spec.status, "PILOT_ONLY");
    assert.equal(spec.compatibility_status, "COMPATIBILITY_TRIAL");
    assert.deepEqual(spec.trained_board_sizes, Array.from({ length: 11 }, (_, i) => i + 5));
    assert.equal(researchProfile(spec.model_kind.replaceAll("_", "-"), String(spec.seed)).modelId, spec.id);
    const model = await loadResearchModel(spec.id);
    for (let size = 5; size <= 15; size++) for (const startPlayer of ["BLACK", "WHITE"]) {
      const engine = new GameEngine({ gridSize: size, playerCount: 2, startPlayer, rulesVersion: "territory-v2" });
      engine.playMove(engine.getLegalMoves(engine.currentPlayer)[0].point);
      const before = fingerprint(engine);
      const legal = new Set(engine.getLegalMoves(engine.currentPlayer).map((m) => m.point.join(",")));
      const policy = model.evaluate(engine);
      assert.ok(Number.isFinite(policy.value) && Math.abs(policy.value) <= 1);
      assert.equal(policy.priors.length, legal.size + 1);
      assert.ok(Math.abs(policy.priors.reduce((sum, p) => sum + p.prior, 0) - 1) < 1e-6);
      for (const p of policy.priors) {
        assert.ok(Number.isFinite(p.prior) && p.prior >= 0);
        if (p.type === "pass") assert.equal(p.actionIndex, size * (size + 1) / 2);
        else assert.ok(legal.has(p.point.join(",")));
      }
      assert.equal(fingerprint(engine), before);
      report.forward_cases++;
      if ([5, 15].includes(size)) {
        const moves = new NeuralPUCTAI(model, { simulations: 3, cPuct: 1.5 }).getTopMoves(engine, engine.currentPlayer, 1000);
        assert.equal(moves.reduce((sum, m) => sum + m.visits, 0), 3);
        for (const move of moves) {
          assert.ok(move.type === "pass" || legal.has(move.point.join(",")));
          assert.ok(Number.isFinite(move.meanValue) && Math.abs(move.meanValue) <= 1);
          assert.ok(Number.isInteger(move.visits) && move.visits >= 0);
        }
        assert.equal(fingerprint(engine), before);
        report.puct_cases++;
      }
    }
    assert.throws(() => model.evaluate(new GameEngine({ gridSize: 5, playerCount: 3, rulesVersion: "territory-v2" })), /双人/);
    assert.throws(() => model.evaluate(new GameEngine({ gridSize: 5, rulesVersion: "territory-v1" })), /双人/);
    const engine = new GameEngine({ gridSize: 5, rulesVersion: "territory-v2" });
    assert.throws(() => new NeuralPUCTAI(model).getTopMoves(engine, "WHITE"), /当前/);
    const raw = await readFile(new URL(spec.asset, assetRoot));
    const buffer = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
    const bad = structuredClone(spec); bad.tensors[1].offset--;
    assert.throws(() => createResearchModel(bad, buffer), /张量/);
  }
  // Historical manifest entries must remain loadable through the real loader.
  for (const spec of combined.models.filter((s) => !s.seed)) await loadResearchModel(spec.id);
  const engine = new GameEngine({ gridSize: 5, rulesVersion: "territory-v2" });
  const before = fingerprint(engine);
  const spec = transfer.models[0];
  const blockedEngine = new GameEngine({ gridSize: 5, rulesVersion: "territory-v2" });
  const blockedPoint = blockedEngine.getLegalMoves()[0].point;
  const saved = saveState(blockedEngine);
  assert.equal(blockedEngine.playMove(blockedPoint).success, true);
  const blockedHash = blockedEngine._computeStateHash(blockedEngine.currentPlayer);
  restoreState(blockedEngine, saved);
  blockedEngine.historyHashes.add(blockedHash);
  assert.equal(blockedEngine._evaluateMove(blockedPoint, blockedEngine.currentPlayer).legal, false);
  const maskedModel = await loadResearchModel(spec.id);
  assert.ok(maskedModel.evaluate(blockedEngine).priors.every((p) => p.point === null || p.point.join(",") !== blockedPoint.join(",")));
  const blockedBefore = fingerprint(blockedEngine);
  assert.ok(new NeuralPUCTAI(maskedModel, { simulations: 2 }).getTopMoves(blockedEngine, blockedEngine.currentPlayer, 1000)
    .every((m) => m.point === null || m.point.join(",") !== blockedPoint.join(",")));
  assert.equal(fingerprint(blockedEngine), blockedBefore);
  const constant = { spec, evaluate: (e) => ({ value: 0.75, priors: [{ point: e.getLegalMoves(e.currentPlayer)[0].point, prior: 1 }] }) };
  const move = new NeuralPUCTAI(constant, { simulations: 1 }).getTopMoves(engine, "BLACK", 1)[0];
  assert.equal(move.visits, 1); assert.equal(move.meanValue, -0.75); assert.equal(move.prior, 1);
  assert.equal(fingerprint(engine), before);
  const passOnly = { spec, evaluate: (e) => ({ value: 0.5, priors: [{ point: null, actionIndex: e.validPositions.length, prior: 1 }] }) };
  const pass = new NeuralPUCTAI(passOnly, { simulations: 2 }).getTopMoves(engine, "BLACK", 1)[0];
  assert.equal(pass.type, "pass"); assert.equal(pass.point, null); assert.equal(pass.actionIndex, 15);
  assert.equal(pass.visits, 2); assert.ok(Math.abs(pass.meanValue) <= 1);
  assert.equal(fingerprint(engine), before);
  let calls = 0;
  const crashing = { spec, evaluate: (e) => { if (++calls > 1) throw new Error("injected forward error"); return constant.evaluate(e); } };
  assert.throws(() => new NeuralPUCTAI(crashing).getTopMoves(engine, "BLACK"), /injected/);
  assert.equal(fingerprint(engine), before);
  const map = new Map(); const storage = { getItem: (k) => map.get(k), setItem: (k, v) => map.set(k, v) };
  assert.equal(loadResearchSelection(storage), "2026092201");
  for (const seed of ["2026092201", "2026092202", "2026092203", "legacy"]) {
    persistResearchSelection(seed, storage); assert.equal(loadResearchSelection(storage), seed);
  }
  assert.throws(() => researchProfile("grid-gnn", "unknown"));

  const fixturesFlag = process.argv.indexOf("--fixtures");
  if (fixturesFlag !== -1) {
    const fixtures = JSON.parse(await readFile(process.argv[fixturesFlag + 1], "utf8"));
    let maxLogitError = 0, maxValueError = 0, comparisons = 0;
    for (const fixture of fixtures.positions) {
      const e = new GameEngine({ gridSize: fixture.size, startPlayer: fixture.start, rulesVersion: "territory-v2" });
      fixture.state.board.forEach((v, i) => e.grid.set(e.validPositions[i].join(","), v));
      for (const owner of ["BLACK", "WHITE"]) e.edges[owner] = new Set(fixture.state.edges[owner].map(([a, b]) => [e.validPositions[a].join(","), e.validPositions[b].join(",")].sort().join("|")));
      e.currentPlayer = fixture.state.currentPlayer; e.consecutiveSkips = fixture.state.consecutiveSkips;
      const encoded = encodeResearchPosition(e);
      assert.deepEqual([...encoded.features], fixture.features.flat().map(Math.fround));
      const relations = researchRelations(e, e.currentPlayer, true);
      const expected = fixture.relations.map((edges) => {
        const rows = Array.from({ length: e.validPositions.length }, () => []);
        for (const [a, b] of edges) { rows[a].push(b); rows[b].push(a); }
        return rows.map((row) => [...new Set(row)].sort((a, b) => a - b));
      });
      assert.deepEqual(relations, expected);
      for (const [id, prediction] of Object.entries(fixture.predictions)) {
        const model = await loadResearchModel(id);
        const result = model.spec.model_kind === "padded_cnn" ? model.forwardCnn(e, encoded) : model.forwardGnn(e, encoded);
        const logits = [...result.pointScores, result.passScore];
        maxLogitError = Math.max(maxLogitError, ...logits.map((x, i) => Math.abs(x - prediction.logits[i])));
        maxValueError = Math.max(maxValueError, Math.abs(result.value - prediction.value));
        comparisons++;
      }
    }
    assert.ok(maxLogitError < 3e-5, `Python/Web logit error: ${maxLogitError}`);
    assert.ok(maxValueError < 3e-5, `Python/Web value error: ${maxValueError}`);
    const differences = [];
    let states = 0, rejected = 0;
    const summarize = (e) => ({ board: e.validPositions.map((p) => e._getState(p)),
      edges: Object.fromEntries(["BLACK", "WHITE"].map((p) => [p, [...e.edges[p]].map((edge) => edge.split("|").map((key) => e._keyToIdx.get(key)).sort((a, b) => a - b)).sort((a, b) => a[0] - b[0] || a[1] - b[1])])),
      currentPlayer: e.currentPlayer, consecutiveSkips: e.consecutiveSkips, turnCount: e.turnCount, gameOver: e.gameOver,
      legal: e.gameOver ? [] : e.getLegalMoves(e.currentPlayer).map((m) => e._keyToIdx.get(m.point.join(","))).sort((a, b) => a - b),
      scores: e.gameOver ? Object.fromEntries(["BLACK", "WHITE"].map((p) => [p, e.cachedTerritories[p].area])) : null,
      winner: e.gameOver ? e.getWinner() : null });
    for (const replay of fixtures.replays) {
      const e = new GameEngine({ gridSize: replay.size, startPlayer: replay.start, rulesVersion: "territory-v2" });
      for (const [ply, step] of replay.steps.entries()) {
        if (ply) {
          const applied = step.action === null ? e.skipTurn() : e.playMove(step.action);
          if (!applied.success) { rejected++; differences.push({ size: replay.size, start: replay.start, ply, rejected: applied.reason }); break; }
        }
        if (e.gameOver) e._updateTerritories();
        const actual = summarize(e); states++;
        const fields = Object.keys(actual).filter((key) => JSON.stringify(actual[key]) !== JSON.stringify(step.state[key]));
        if (fields.length) differences.push({ size: replay.size, start: replay.start, ply, fields,
          expected: Object.fromEntries(fields.map((k) => [k, step.state[k]])),
          actual: Object.fromEntries(fields.map((k) => [k, actual[k]])) });
      }
    }
    report.numeric_parity = { positions: fixtures.positions.length, comparisons, maxLogitError, maxValueError, tolerance: 3e-5 };
    report.rule_differential = { prefixes: fixtures.replays.length, states, rejected, differences,
      scope: "bounded 12-move prefixes plus explicit passes, both starts, sizes 5–15; not exhaustive rule equivalence" };
  }
} finally { globalThis.fetch = oldFetch; }
const reportFlag = process.argv.indexOf("--report");
if (reportFlag !== -1) await writeFile(process.argv[reportFlag + 1], JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ ...report, rule_differential: report.rule_differential && { ...report.rule_differential, differences: report.rule_differential.differences.length } }));
