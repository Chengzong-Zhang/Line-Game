// Bounded local supervision. Workers own scientific checkpoint validation;
// this process owns lifetime, duplicate exclusion, budgets and retry evidence.
import { createHash } from "node:crypto";
import { fork, spawn } from "node:child_process";
import { createServer } from "node:net";
import { appendFile, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { closeSync, openSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const exists = async (path) => { try { await readFile(path); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } };
const remove = async (path) => { try { await unlink(path); } catch (error) { if (error.code !== "ENOENT") throw error; } };
function seal(body) { return { ...body, integrity: sha(JSON.stringify(body)) }; }
function verifySeal(value) {
  const { integrity, ...body } = value;
  if (integrity !== sha(JSON.stringify(body))) throw new Error("Corrupt supervisor state integrity.");
  return body;
}
async function atomic(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  for (let attempt = 0; ; attempt++) {
    try { await rename(temporary, path); break; }
    catch (error) {
      if (process.platform !== "win32" || !["EPERM", "EBUSY", "EACCES"].includes(error.code) || attempt >= 7) throw error;
      await sleep(10 * (attempt + 1));
    }
  }
}
async function readJSON(path, optional = false) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (optional && error.code === "ENOENT") return null; throw new Error(`Invalid JSON ${path}: ${error.message}`); }
}
async function lease(runRoot, role) {
  const canonical = process.platform === "win32" ? runRoot.toLowerCase() : runRoot;
  const port = (role === "supervisor" ? 20000 : 40000) + parseInt(sha(`${role}:${canonical}`).slice(0, 8), 16) % 20000;
  const server = createServer((socket) => socket.destroy());
  try {
    await new Promise((done, fail) => {
      server.once("error", fail);
      server.listen({ host: "127.0.0.1", port, exclusive: true }, done);
    });
  } catch (error) {
    error.exitCode = error.code === "EADDRINUSE" ? 76 : 78;
    throw error;
  }
  server.unref();
  return { port, close: () => new Promise((done) => server.close(done)) };
}
function positive(value, fallback, name, maximum = 86400) {
  value ??= fallback;
  if (!Number.isFinite(value) || value <= 0 || value > maximum) throw new Error(`Invalid ${name}.`);
  return value;
}
async function loadJob(path) {
  const raw = await readFile(path);
  const job = JSON.parse(raw);
  if (job.schema !== "lifeline-supervised-job-v1" || !Array.isArray(job.command)
      || job.command.length < 2 || job.command.some((part) => typeof part !== "string" || !part)
      || !isAbsolute(job.run_root ?? "") || !isAbsolute(job.cwd ?? "")
      || !Array.isArray(job.identity_files) || job.identity_files.length < 2) {
    throw new Error("Invalid supervisor job. Use absolute run_root/cwd and frozen identity_files.");
  }
  job.max_wall_seconds = positive(job.max_wall_seconds, 1800, "max_wall_seconds");
  job.worker_wall_seconds = positive(job.worker_wall_seconds, 300, "worker_wall_seconds");
  job.stop_grace_seconds = positive(job.stop_grace_seconds, 3, "stop_grace_seconds", 30);
  job.poll_ms = positive(job.poll_ms, 200, "poll_ms", 2000);
  for (const [key, fallback] of [["max_restarts", 3], ["max_no_progress_exits", 3]]) {
    job[key] ??= fallback;
    if (!Number.isInteger(job[key]) || job[key] < 0 || job[key] > 100 || (key === "max_no_progress_exits" && !job[key])) {
      throw new Error(`Invalid ${key}.`);
    }
  }
  const identityFiles = {};
  for (const path of [SELF, ...job.identity_files.map((path) => resolve(job.cwd, path))]) {
    identityFiles[path] = sha(await readFile(path));
  }
  const identity = sha(JSON.stringify({ raw_job_sha256: sha(raw), identity_files: identityFiles }));
  return { job, identity, identityFiles, rawHash: sha(raw) };
}

// This lightweight host remains responsive while the worker runs CPU code.
// The IPC channel closes on supervisor death, so the host kills/reaps its own
// child. Its separate OS lease prevents a replacement from overlapping it.
async function hostMain(jobPath, attempt, expectedIdentity) {
  const { job, identity } = await loadJob(jobPath);
  if (identity !== expectedIdentity) throw new Error("Job drift before worker spawn.");
  const runRoot = await realpath(job.run_root);
  const guard = await lease(runRoot, "worker-host");
  let child, cancelled = null;
  const terminate = (reason) => {
    cancelled ??= reason;
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  };
  process.on("disconnect", () => terminate("SUPERVISOR_EXIT"));
  process.on("message", (message) => { if (message?.type === "cancel") terminate(message.reason ?? "CANCELLED"); });
  const stdout = openSync(resolve(runRoot, `worker-${attempt}.stdout.log`), "a");
  const stderr = openSync(resolve(runRoot, `worker-${attempt}.stderr.log`), "a");
  try {
    if (!process.connected) throw new Error("Supervisor disconnected before worker spawn.");
    child = spawn(job.command[0], job.command.slice(1), {
      cwd: job.cwd, windowsHide: true, stdio: ["ignore", stdout, stderr],
      env: { ...process.env, LIFELINE_SUPERVISOR_ATTEMPT: String(attempt) },
    });
    const completion = new Promise((done) => {
      child.once("error", (error) => done({ exit_code: null, signal: null, spawn_error: error.code ?? error.message }));
      child.once("close", (code, signal) => done({ exit_code: code, signal }));
    });
    const started = Date.now();
    const launch = { attempt, host_pid: process.pid, worker_pid: child.pid, started_epoch_ms: started, identity };
    await atomic(resolve(runRoot, `worker-${attempt}.launch.json`), launch);
    if (process.connected) process.send({ type: "started", ...launch });
    const result = await completion;
    const receipt = { ...launch, ...result, cancelled, finished_epoch_ms: Date.now() };
    await atomic(resolve(runRoot, `worker-${attempt}.exit.json`), receipt);
    if (process.connected) process.send({ type: "finished", ...receipt });
  } finally {
    terminate("HOST_EXIT");
    closeSync(stdout); closeSync(stderr);
    await guard.close();
    if (process.connected) process.disconnect();
  }
}

async function supervisorMain(jobPath, resume) {
  const frozen = await loadJob(jobPath), { job, identity } = frozen;
  await mkdir(job.run_root, { recursive: true });
  const runRoot = await realpath(job.run_root);
  const guard = await lease(runRoot, "supervisor");
  const statePath = resolve(runRoot, "supervisor-state.json");
  let state, host = null, exitRequested = null;
  const save = async () => atomic(statePath, seal({ ...state, updated_epoch_ms: Date.now() }));
  const event = async (type, details = {}) => appendFile(resolve(runRoot, "supervisor-events.jsonl"),
    `${JSON.stringify({ type, time_epoch_ms: Date.now(), supervisor_pid: process.pid, ...details })}\n`);
  const finish = async (status, exitCode, details = {}) => {
    state = { ...state, status, ...details, active_attempt: null, worker_pid: null };
    await save(); await event(status, details);
    return exitCode;
  };
  const marker = async () => (await exists(resolve(runRoot, "STOP"))) ? "STOPPED"
    : (await exists(resolve(runRoot, "PAUSE"))) ? "PAUSED" : null;
  const progress = async () => {
    const value = await readJSON(resolve(runRoot, "progress.json"), true);
    // Check syntax here; semantic/hash validation remains the worker's job.
    await readJSON(resolve(runRoot, "checkpoint.json"), true);
    if (!value) return null;
    if (!["RUNNING", "YIELDED", "PAUSED", "STOPPED", "COMPLETE", "FAILED", "FATAL"].includes(value.status)
        || typeof value.identity !== "string" || !value.identity
        || !Number.isSafeInteger(value.progress_units) || value.progress_units < 0) throw new Error("Invalid worker progress contract.");
    if (state.worker_identity && value.identity !== state.worker_identity) throw new Error("Worker progress identity drift.");
    if (value.progress_units < state.progress_units) throw new Error("Worker progress regressed.");
    state.worker_identity ??= value.identity;
    state.progress_units = value.progress_units;
    return value;
  };
  const checkIdentity = async () => {
    if (sha(await readFile(jobPath)) !== frozen.rawHash) throw new Error("Supervisor job configuration drift.");
    for (const [path, hash] of Object.entries(frozen.identityFiles)) {
      if (sha(await readFile(path)) !== hash) throw new Error(`Frozen source/configuration drift: ${path}`);
    }
  };
  const onSignal = () => { exitRequested = "INTERRUPTED"; };
  process.on("SIGINT", onSignal); process.on("SIGTERM", onSignal);
  try {
    const previous = await readJSON(statePath, true);
    if (previous) {
      state = verifySeal(previous);
      if (state.identity !== identity) throw new Error("Frozen job identity changed; use a new run root.");
    } else {
      state = { schema: "lifeline-supervisor-state-v1", identity, status: "PREPARED",
        attempts: 0, abnormal_exits: 0, no_progress_exits: 0, progress_units: 0,
        worker_identity: null, active_attempt: null, deadline_epoch_ms: Date.now() + job.max_wall_seconds * 1000 };
    }
    state.supervisor_pid = process.pid;
    state.supervisor_lease_port = guard.port;
    if (resume) {
      await remove(resolve(runRoot, "PAUSE")); await remove(resolve(runRoot, "STOP"));
      if (["PAUSED", "STOPPED", "BUDGET_EXHAUSTED", "INTERRUPTED"].includes(state.status)) {
        state.deadline_epoch_ms = Date.now() + job.max_wall_seconds * 1000;
      }
      await event("EXPLICIT_RESUME");
    }
    if (state.status === "FATAL" || state.status === "RETRY_EXHAUSTED") throw new Error("Terminal failure requires investigation and a new run root.");
    if (state.status === "COMPLETE") {
      if ((await progress())?.status !== "COMPLETE") throw new Error("Completed supervisor has inconsistent worker progress.");
      // Invoke the idempotent worker again so it validates its own full
      // checkpoint/evidence before repeating COMPLETE. No completed unit may
      // rerun. COMPLETE remains an operational status, not a strength claim.
    }
    if (!resume && ["PAUSED", "STOPPED", "INTERRUPTED"].includes(state.status)) return await finish(state.status, 75);
    if (state.active_attempt !== null) {
      await event("RECOVER_SUPERVISOR_EXIT", { prior_attempt: state.active_attempt });
      await progress();
      state.abnormal_exits++;
      state.no_progress_exits = state.progress_units > (state.attempt_start_units ?? 0) ? 0 : state.no_progress_exits + 1;
      state.active_attempt = null;
      if (state.abnormal_exits > job.max_restarts || state.no_progress_exits >= job.max_no_progress_exits) {
        return await finish("RETRY_EXHAUSTED", 1);
      }
    }
    await save();
    while (true) {
      await checkIdentity();
      const current = await progress();
      const paused = await marker();
      if (paused) return await finish(paused, 75);
      if (exitRequested) return await finish(exitRequested, 75);
      if (Date.now() >= state.deadline_epoch_ms) return await finish("BUDGET_EXHAUSTED", 75);
      if (current?.status === "FATAL") throw new Error("Worker reported fatal configuration/checkpoint error.");
      const before = state.progress_units;
      const attempt = state.attempts + 1;
      state.attempts = attempt; state.active_attempt = attempt; state.attempt_start_units = before; state.status = "RUNNING";
      await save();
      await event("WORKER_START", { attempt, progress_units: before });
      let outcome = null, hostExit = null, cancellation = null, noticeAt = null, fatalError = null;
      const started = Date.now();
      host = fork(SELF, ["--worker-host", jobPath, String(attempt), identity], {
        cwd: job.cwd, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      host.on("message", (message) => {
        if (message?.type === "started") state.worker_pid = message.worker_pid;
        if (message?.type === "finished") outcome = message;
      });
      host.on("error", (error) => { hostExit = { code: 1, error: error.message }; });
      host.on("exit", (code, signal) => { hostExit = { code, signal }; });
      while (!hostExit) {
        try {
          await checkIdentity(); await progress();
          const requested = await marker();
          if (requested && noticeAt === null) { noticeAt = Date.now(); cancellation = requested; }
          if (exitRequested) cancellation = exitRequested;
          if (Date.now() >= state.deadline_epoch_ms) cancellation = "BUDGET_EXHAUSTED";
          if (!cancellation && Date.now() - started >= job.worker_wall_seconds * 1000) cancellation = "WORKER_TIMEOUT";
        } catch (error) { fatalError = error; cancellation = "FATAL"; }
        // PAUSE/STOP first allow a safe worker checkpoint; budget is a hard cap.
        const readyToCancel = cancellation && (!["PAUSED", "STOPPED"].includes(cancellation)
          || Date.now() - noticeAt >= job.stop_grace_seconds * 1000);
        if (readyToCancel && host.connected) host.send({ type: "cancel", reason: cancellation });
        await save();
        await sleep(job.poll_ms);
      }
      host = null;
      await progress();
      if (fatalError) throw fatalError;
      if (!outcome && hostExit.code === 76) {
        // A recently orphaned host is still reaping its worker. No second worker
        // ran; preserve this attempt's receipt and let the bounded wall cap govern.
        await event("WORKER_LEASE_BUSY", { attempt });
        state.active_attempt = null;
        await save(); await sleep(Math.max(250, job.poll_ms));
        continue;
      }
      const code = outcome?.exit_code ?? hostExit.code;
      await event("WORKER_EXIT", { attempt, code, signal: outcome?.signal ?? hostExit.signal,
        cancellation, progress_units: state.progress_units });
      const last = await progress();
      if (cancellation && ["PAUSED", "STOPPED", "BUDGET_EXHAUSTED", "INTERRUPTED"].includes(cancellation)) {
        return await finish(cancellation, 75);
      }
      if (code === 78 || last?.status === "FATAL") throw new Error("Worker rejected corrupt or changed evidence.");
      if (code === 0) {
        if (last?.status !== "COMPLETE") throw new Error("Worker exit 0 without COMPLETE progress.");
        return await finish("COMPLETE", 0);
      }
      if (last && ["PAUSED", "STOPPED"].includes(last.status)) return await finish(last.status, 75);
      const improved = state.progress_units > before;
      state.no_progress_exits = improved ? 0 : state.no_progress_exits + 1;
      const yielded = code === 75 && last?.status === "YIELDED";
      if (!yielded) state.abnormal_exits++;
      state.active_attempt = null;
      if (state.abnormal_exits > job.max_restarts || state.no_progress_exits >= job.max_no_progress_exits) {
        return await finish("RETRY_EXHAUSTED", 1);
      }
      await save();
      await sleep(Math.min(1000, 100 * Math.max(1, state.abnormal_exits)));
    }
  } catch (error) {
    if (host?.connected) {
      host.send({ type: "cancel", reason: "FATAL" });
      await new Promise((done) => host.once("exit", done));
      host = null;
    }
    if (state) await finish("FATAL", 78, { error: error.message });
    else await atomic(resolve(runRoot, `supervisor-rejection-${Date.now()}.json`), { status: "FATAL", error: error.message });
    process.stderr.write(`${error.message}\n`);
    return 78;
  } finally {
    process.off("SIGINT", onSignal); process.off("SIGTERM", onSignal);
    await guard.close();
  }
}

try {
  if (process.argv[2] === "--worker-host") {
    await hostMain(resolve(process.argv[3]), Number(process.argv[4]), process.argv[5]);
  } else {
    const index = process.argv.indexOf("--job");
    if (index < 0 || !process.argv[index + 1]) throw new Error("Usage: node supervise-three-player-job.mjs --job ABSOLUTE_JOB_JSON [--resume]");
    process.exitCode = await supervisorMain(resolve(process.argv[index + 1]), process.argv.includes("--resume"));
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = error.exitCode ?? 78;
}
