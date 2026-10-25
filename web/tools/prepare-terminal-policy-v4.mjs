import { readFile, mkdir, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateTerminalProtocol, TERMINAL_V4_SOURCES } from "./train-terminal-policy-v4.mjs";
import { loadPassOpportunityParent } from "./train-pass-opportunity-v3.mjs";
import { atomic, root, sha } from "./neural-posttraining-data-v2.mjs";

export async function prepareTerminalMain(args) {
  const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : null;
  if (!option("--run-root") || !option("--config")) throw Error("Use --run-root NEW_DIRECTORY --config FROZEN_TERMINAL_PROTOCOL");
  const runRoot = resolve(option("--run-root")), configBytes = await readFile(resolve(option("--config")));
  const config = validateTerminalProtocol(JSON.parse(configBytes));
  let names = []; try { names = await readdir(runRoot); } catch (e) { if (e.code !== "ENOENT") throw e; }
  if (names.length) throw Error("Refuse to overwrite any existing terminal run");
  const parentAliases = [...new Set([...config.parents.map(p => p.alias), "easy", "three-v4", "three-v1", "hex-v1"])];
  const parents = await Promise.all(parentAliases.map(alias => loadPassOpportunityParent(alias)));
  const paths = [...TERMINAL_V4_SOURCES, "web/tools/prepare-terminal-policy-v4.mjs", "web/tools/supervise-three-player-job.mjs", ...parents.map(p => p.path)];
  const sources = Object.fromEntries(await Promise.all(paths.map(async p => [p, sha(await readFile(resolve(root, p)))])));
  await mkdir(runRoot, { recursive: true }); await atomic(resolve(runRoot, "protocol.json"), config);
  await atomic(resolve(runRoot, "frozen-sources.json"), { schema: "lifeline-terminal-policy-frozen-v4", sources, parents });
  const job = { schema: "lifeline-supervised-job-v1", run_root: runRoot, cwd: root,
    command: [process.execPath, resolve(root, "web/tools/train-terminal-policy-v4.mjs"), "--run-root", runRoot, "--config", resolve(runRoot, "protocol.json"),
      "--max-new-units", String(config.supervision.worker_units ?? 8), "--max-seconds", String(Math.max(1, config.supervision.worker_wall_seconds - 5))],
    identity_files: [...paths, resolve(runRoot, "protocol.json"), resolve(runRoot, "frozen-sources.json")], ...config.supervision };
  await atomic(resolve(runRoot, "job.json"), job);
  return { status: "PREPARED_TERMINAL_ONLY_NOT_STARTED", runRoot, parents: config.parents.map(p => p.alias), planned_episodes: config.parents.length * config.episodes_per_parent };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await prepareTerminalMain(process.argv.slice(2)))); }
  catch (e) { console.error(e.stack); process.exitCode = 78; }
}
