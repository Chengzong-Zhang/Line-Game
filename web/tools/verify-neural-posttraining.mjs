import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { root, sha, readJson, atomic, replay, teacherSample, modelFreeState, unseal } from "./neural-posttraining-data.mjs";
import { encodeResearchPosition, researchRelations } from "../web前端/ResearchAI.js";
import { GameEngine } from "../web前端/GameEngine.js";
import { loadArenaModels, prefix } from "./neural-posttraining-arena.mjs";

async function verifySources(hashes) {
  for (const [path, hash] of Object.entries(hashes)) assert.equal(sha(await readFile(resolve(root, path))), hash, path);
}
export async function verifyData(dir, configPath) {
  const manifest = await readJson(resolve(dir, "manifest.json")), config = await readJson(configPath);
  assert.equal(sha(await readFile(configPath)), manifest.config_sha256);
  assert.equal(manifest.identity, sha(JSON.stringify({ source_hashes: manifest.source_hashes, config_sha256: manifest.config_sha256 })));
  assert.equal((await readJson(resolve(dir, "progress.json"))).status, "COMPLETE");
  await verifySources(manifest.source_hashes);
  const report = { status: "PASS_DATA_REPLAY", episodes: 0, samples: 0, actions: 0, regeneratedTeacherLabels: 0,
    terminalEpisodes: 0, truncatedEpisodes: 0, trainSamples: 0, validationSamples: 0,
    manifest_sha256: sha(await readFile(resolve(dir, "manifest.json"))) };
  const teacherStrata = new Set(), ids = new Set();
  const plans = [];
  for (const size of config.sizes) for (const split of ["train", "validation"]) {
    for (let i = 0; i < (split === "train" ? config.trainReplicates : config.validationReplicates); i++) {
      plans.push({ id: `n${size}-${split}-${i}`, size, split, start: i % 2 ? "WHITE" : "BLACK" });
    }
  }
  for (const ref of manifest.episodes) {
    assert.ok(!ids.has(ref.id)); ids.add(ref.id);
    const bytes = await readFile(resolve(dir, ref.path)); assert.equal(sha(bytes), ref.sha256);
    const ep = JSON.parse(bytes);
    for (const key of ["id", "size", "split", "start"]) {
      assert.equal(ref[key], plans[report.episodes][key]); assert.equal(ep[key], ref[key]);
    }
    assert.equal(ep.datasetIdentity, manifest.identity);
    assert.equal(ep.samples.length, ref.samples);
    const e = replay({ ...ep, actions: [] });
    let sampleIndex = 0;
    for (const [ply, action] of ep.actions.entries()) {
      assert.equal(e.currentPlayer, action.player); assert.equal(e.gameOver, false);
      const encoded = encodeResearchPosition(e);
      if (encoded.legal.length) {
        const sample = ep.samples[sampleIndex++];
        assert.equal(sample.ply, ply); assert.equal(sample.player, e.currentPlayer);
        assert.deepEqual(sample.features, Array.from(encoded.features));
        assert.deepEqual(sample.legal, encoded.legal);
        assert.deepEqual(sample.relations, researchRelations(e, e.currentPlayer, true));
        assert.deepEqual(sample.modelFreeState, modelFreeState(e));
        assert.equal(sample.target.length, e.validPositions.length);
        assert.ok(sample.target.every((v, i) => Number.isFinite(v) && v >= 0 && (v === 0 || sample.legal.includes(i))));
        assert.ok(Math.abs(sample.target.reduce((a, b) => a + b, 0) - 1) < 1e-9);
        const stratum = `${ep.size}/${ep.split}`;
        if (!teacherStrata.has(stratum) && ply >= Math.floor(ep.actions.length / 2)) {
          assert.deepEqual(teacherSample(e, config, ply), sample);
          teacherStrata.add(stratum); report.regeneratedTeacherLabels++;
        }
        report.samples++;
        report[ep.split === "train" ? "trainSamples" : "validationSamples"]++;
      }
      assert.ok((action.point === null ? e.skipTurn() : e.playMove(action.point)).success);
      report.actions++;
    }
    assert.equal(sampleIndex, ep.samples.length);
    assert.equal(ep.terminal, e.gameOver);
    assert.equal(ep.truncated, !e.gameOver);
    if (!e.gameOver) assert.equal(ep.actions.length, config.maximumPlies);
    report[ep.terminal ? "terminalEpisodes" : "truncatedEpisodes"]++;
    report.episodes++;
  }
  assert.equal(report.episodes, config.sizes.length * (config.trainReplicates + config.validationReplicates));
  report.source_hashes = manifest.source_hashes;
  report.limitations = "All actions/features/relations/masks verified; teacher targets regenerated once per size/split, not exhaustively.";
  await atomic(resolve(dir, "verification.json"), report);
  return report;
}
export async function verifyArena(dir, candidatesPath) {
  const identity = await readJson(resolve(dir, "identity.json")), summary = await readJson(resolve(dir, "summary.json"));
  assert.equal(identity.identity, sha(JSON.stringify(identity.source_hashes)));
  assert.equal(summary.identity, identity.identity);
  assert.equal((await readJson(resolve(dir, "progress.json"))).status, "COMPLETE");
  const cp = unseal(await readJson(resolve(dir, "checkpoint.json")));
  assert.equal(cp.identity, identity.identity);
  assert.equal(cp.completed.length, identity.plannedGames);
  for (const ref of cp.completed) assert.equal(sha(await readFile(resolve(dir, ref.path))), ref.sha256);
  await verifySources(identity.source_hashes);
  const { candidates, policies } = await loadArenaModels(candidatesPath), config = identity.config;
  const report = { status: "PASS_APPLICATION_SCREEN_REPLAY", games: 0, actions: 0, sampledPolicyDecisions: 0,
    terminalGames: 0, truncatedGames: 0, promotionPass: false };
  for (const model of candidates) {
    const results = [];
    for (const size of config.sizes) for (let i = 0; i < config.prefixesPerSize; i++) for (const seat of ["BLACK", "WHITE"]) {
      const cluster = `n${size}-p${i}`, id = `${model.id}-${cluster}-${seat}`;
      const game = await readJson(resolve(dir, `games/${id}.json`));
      assert.equal(game.id, id); assert.equal(game.parentId, model.parent_model_id); assert.equal(game.candidateSeat, seat);
      const seed = parseInt(sha(`${config.seedNamespace}/${cluster}`).slice(0, 8), 16);
      const start = i % 2 ? "WHITE" : "BLACK";
      const initial = prefix(size, seed, config.prefixPlies, start);
      assert.deepEqual(game.actions.slice(0, game.prefixLength), initial);
      const engine = replay({ size, start, actions: [] });
      const samplePlies = new Set([game.prefixLength, Math.floor((game.prefixLength + game.actions.length) / 2)]);
      for (let j = 0; j < game.actions.length; j++) {
        const action = game.actions[j];
        assert.equal(engine.currentPlayer, action.player); assert.equal(engine.gameOver, false);
        if (j >= game.prefixLength) {
          const id = engine.currentPlayer === seat ? model.id : model.parent_model_id;
          assert.equal(action.modelId, id);
          if (samplePlies.has(j)) {
            const move = policies.get(id).getTopMoves(engine, engine.currentPlayer, 1)[0];
            assert.deepEqual(move?.point ?? null, action.point);
            report.sampledPolicyDecisions++;
          }
        }
        assert.ok((action.point === null ? engine.skipTurn() : engine.playMove(action.point)).success);
        report.actions++;
      }
      assert.equal(game.terminal, engine.gameOver);
      assert.equal(game.truncated, !engine.gameOver);
      if (engine.gameOver) {
        GameEngine.prototype._updateTerritories.call(engine);
        const black = engine.cachedTerritories.BLACK.area, white = engine.cachedTerritories.WHITE.area;
        const score = black === white ? 0.5 : (seat === "BLACK" ? black > white : white > black) ? 1 : 0;
        assert.deepEqual(game.outcome.scores, { BLACK: black, WHITE: white });
        assert.equal(game.outcome.candidateScore, score);
        report.terminalGames++;
      } else {
        assert.equal(game.outcome, null);
        assert.ok(game.actions.length >= config.maximumPlies || game.activityMs >= config.maximumGameMs);
        report.truncatedGames++;
      }
      report.games++; results.push(game);
    }
    const row = summary.models.find((v) => v.id === model.id);
    assert.equal(row.terminalGames, results.filter((r) => r.terminal).length);
    assert.equal(row.meanScore, results.every((r) => r.terminal)
      ? results.reduce((n, r) => n + r.outcome.candidateScore, 0) / results.length : null);
  }
  assert.equal(report.games, identity.plannedGames);
  assert.equal(report.terminalGames, summary.terminalGames);
  assert.equal(report.truncatedGames, summary.truncatedGames);
  assert.equal(summary.promotionPass, false);
  report.limitations = "All histories and terminal scores replayed; first and middle policy decisions per game re-evaluated. Exploratory screening only.";
  await atomic(resolve(dir, "verification.json"), report);
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), opt = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
  try {
    if (args.includes("--data-root")) console.log(JSON.stringify(await verifyData(resolve(root, opt("--data-root")),
      resolve(root, opt("--data-config", "web/tools/configs/neural-posttraining-data-20261021.json")))));
    if (args.includes("--arena-root")) console.log(JSON.stringify(await verifyArena(resolve(root, opt("--arena-root")),
      resolve(root, opt("--candidates", "local_artifacts/all-ai-posttraining-20261021/neural-training/candidate-manifest.json")))));
  } catch (e) { console.error(e.stack); process.exitCode = 1; }
}
