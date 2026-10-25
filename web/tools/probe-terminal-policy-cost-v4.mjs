// Bounded cost/coverage observations only. These runs never admit runtime models.
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { terminalPolicyTrainMain, terminalTrainingCoverage } from "./train-terminal-policy-v4.mjs";
import { atomic, readJson, root, unseal } from "./neural-posttraining-data-v2.mjs";

export async function probeTerminalPolicyCost({ nativeTail = false } = {}) {
  const base = await mkdtemp(resolve(root, "local_artifacts/terminal-v4-native-cost-")), results = [];
  const template = JSON.parse(await readFile(resolve(root, "web/tools/configs/terminal-policy-v4.draft.json"), "utf8"));
  for (const [alias, cell] of [["three-v4", { players: 3, shape: "triangle", size: 7 }],
    ["three-v4", { players: 3, shape: "triangle", size: 9 }],
    ...[4, 5, 6].map(players => ["hex-v1", { players, shape: "hexagon", size: 5 }])]) {
    if (nativeTail && cell.shape !== "hexagon") continue;
    const name = `${cell.players}p-${cell.shape}-${cell.size}`, runRoot = resolve(base, name), configPath = resolve(base, `${name}.json`);
    const config = structuredClone(template); config.status = "BOUNDED_ACTUAL_GAME_COST_PILOT_NOT_FORMAL";
    config.parents = [{ alias, cells: [cell] }]; config.episodes_per_parent = 1; config.maximum_game_plies = 200; config.minimum_actual_updates_per_parent = 1;
    config.analysis = { max_attempts_per_episode: 6, learner_turns: nativeTail ? template.analysis.learner_turns_by_cell[name] : [0, 2, 6, 12, 20, 30], max_nodes: 100000,
      time_ms: 2500, action_mask: "lexicographic-defense-prefix-0-1-4" };
    await writeFile(configPath, JSON.stringify(config)); const started = performance.now(); let code = null, error = null;
    try { code = await terminalPolicyTrainMain(["--run-root", runRoot, "--config", configPath, "--max-new-units", "1000", "--max-seconds", "30"]); }
    catch (e) { error = e.message; }
    const elapsedMs = performance.now() - started, cp = unseal(await readJson(resolve(runRoot, "checkpoint.json"))), model = cp.models[alias];
    const coverage = await terminalTrainingCoverage(runRoot, model.completed);
    const episodes = await Promise.all(model.completed.map(async record => {
      const value = unseal(await readJson(resolve(runRoot, record.path)));
      return { id: value.id, plies: value.steps.length, natural: value.naturalTerminal, updated: value.modelUpdated,
        eligible: value.eligibleSamples.length, reward: value.terminalReward };
    }));
    const result = { alias, cell, runRoot, elapsedMs, code, error, episodes,
      actualUpdates: model.actualUpdates, eligibleSamples: model.eligibleSamples, coverage,
      inFlightPlies: cp.active?.steps.length ?? 0, contextOnlyIfNoEligibleSamples: model.eligibleSamples === 0 };
    results.push(result); await atomic(resolve(base, "cost-summary.json"), { status: "BOUNDED_NATIVE_COST_PROGRESS", results });
    console.log(JSON.stringify(result));
  }
  const receipt = { status: "BOUNDED_NATIVE_GAME_COST_PILOT_COMPLETE", base, results,
    command: `node web/tools/probe-terminal-policy-cost-v4.mjs${nativeTail ? " --native-tail" : ""}`, formal_training_started: false,
    runtime_admitted: false, limitation: "Each cell is one bounded actual game; failed analyses supply no gradient and do not establish strength." };
  await atomic(resolve(base, "cost-summary.json"), receipt); return receipt;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await probeTerminalPolicyCost({ nativeTail: process.argv.includes("--native-tail") }); } catch (e) { console.error(e.stack); process.exitCode = 78; }
}
