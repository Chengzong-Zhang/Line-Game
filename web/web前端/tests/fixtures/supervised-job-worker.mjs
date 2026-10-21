// Recovery-only fixture. No game training or evaluation is performed.
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const option = (name) => process.argv[process.argv.indexOf(name) + 1];
const runRoot = resolve(option("--run-root")), configPath = resolve(option("--config"));
const sha = (value) => createHash("sha256").update(value).digest("hex");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const atomic = async (path, body) => {
  await writeFile(`${path}.tmp`, JSON.stringify(body));
  for (let attempt = 0; ; attempt++) {
    try { await rename(`${path}.tmp`, path); break; }
    catch (error) {
      if (process.platform !== "win32" || !["EPERM", "EBUSY", "EACCES"].includes(error.code) || attempt >= 7) throw error;
      await sleep(10 * (attempt + 1));
    }
  }
};
const exists = async (path) => { try { await readFile(path); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } };
const identity = sha(await readFile(configPath));
const config = JSON.parse(await readFile(configPath, "utf8"));
let checkpoint = { identity, units: [], sum: 0 };
const checkpointPath = resolve(runRoot, "checkpoint.json");
const progress = async (status) => atomic(resolve(runRoot, "progress.json"), { status, identity, progress_units: checkpoint.units.length });
try {
  await mkdir(runRoot, { recursive: true });
  if (await exists(checkpointPath)) {
    const { integrity, ...body } = JSON.parse(await readFile(checkpointPath, "utf8"));
    if (integrity !== sha(JSON.stringify(body)) || body.identity !== identity
      || body.units.some((unit, index) => unit !== index)
      || body.sum !== body.units.reduce((sum, unit) => sum + unit * unit, 0)) throw new Error("Corrupt fixture checkpoint.");
    checkpoint = body;
  }
  const attempt = Number(process.env.LIFELINE_SUPERVISOR_ATTEMPT);
  await progress("RUNNING");
  if (config.always_fail || attempt <= (config.fail_attempts ?? 0)) process.exit(1);
  if (config.hang) await sleep(60000);
  let newUnits = 0;
  while (checkpoint.units.length < config.units) {
    for (const name of ["STOP", "PAUSE"]) {
      if (await exists(resolve(runRoot, name))) { await progress(name === "STOP" ? "STOPPED" : "PAUSED"); process.exit(75); }
    }
    await sleep(config.delay_ms ?? 40);
    const unit = checkpoint.units.length;
    checkpoint.units.push(unit); checkpoint.sum += unit * unit;
    await atomic(checkpointPath, { ...checkpoint, integrity: sha(JSON.stringify(checkpoint)) });
    await progress("RUNNING");
    if (++newUnits >= (config.units_per_launch ?? Number.MAX_SAFE_INTEGER) && checkpoint.units.length < config.units) {
      await progress("YIELDED"); process.exit(75);
    }
  }
  await progress("COMPLETE");
} catch (error) {
  await progress("FATAL"); process.stderr.write(`${error.message}\n`); process.exitCode = 78;
}
