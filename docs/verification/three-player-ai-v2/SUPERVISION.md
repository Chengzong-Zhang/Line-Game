# Bounded local job supervision

`web/tools/supervise-three-player-job.mjs` supervises one resumable worker.
It does not select a model or establish a scientific result.

```text
node web/tools/supervise-three-player-job.mjs --job ABSOLUTE_JOB_JSON
node web/tools/supervise-three-player-job.mjs --job ABSOLUTE_JOB_JSON --resume
```

The job file has this schema (replace placeholders with absolute paths):

```json
{
  "schema": "lifeline-supervised-job-v1",
  "run_root": "ABSOLUTE_RUN_DIRECTORY",
  "cwd": "ABSOLUTE_REPOSITORY",
  "command": ["ABSOLUTE_NODE", "ABSOLUTE_WORKER", "--run-root", "ABSOLUTE_RUN_DIRECTORY"],
  "identity_files": ["ABSOLUTE_WORKER", "ABSOLUTE_FROZEN_CONFIG"],
  "max_wall_seconds": 1800,
  "worker_wall_seconds": 300,
  "max_restarts": 3,
  "max_no_progress_exits": 3,
  "poll_ms": 200,
  "stop_grace_seconds": 3
}
```

Include every source, parent model, and configuration that affects the worker
in `identity_files`. The supervisor additionally hashes itself and the complete
job file. Source/configuration drift and corrupt JSON stop the job. The worker
must verify its own full checkpoint integrity, semantic invariants, and input
identity before resuming.

Launch the supervisor as an independent hidden process on Windows with
`Start-Process -WindowStyle Hidden`, redirecting stdout and stderr to the local
run directory. The worker host is separate from CPU-heavy work and terminates
its child when supervisor IPC closes. Both supervisor and worker host hold
exclusive OS leases. No login task or automatic login restart is installed.
After an unexpected supervisor exit, rerun the same command; its original
persisted deadline and retry counters still apply.

Create `PAUSE` or `STOP` inside the run directory for an intentional stop.
Completed units and interrupted evidence are retained. The supervisor gives the
worker a short checkpoint grace period before terminating it. Explicit
`--resume` clears these marker files and resumes validated progress. Only an
explicit resume of a paused/stopped/interrupted/budget-exhausted job grants a new
bounded wall-time window. Fatal corruption and exhausted retries require
investigation and a new run directory.

The worker writes `progress.json` with a nonempty `identity`, nonnegative integer
`progress_units`, and one of `RUNNING`, `YIELDED`, `PAUSED`, `STOPPED`, `COMPLETE`,
`FAILED`, or `FATAL`. Exit codes are 0 for complete, 75 for yield/pause/stop,
78 for nonretryable input/evidence corruption, and 1 for a transient failure.
Even a previously complete job invokes the idempotent worker again to validate
its full evidence; it must not repeat completed units.

The run directory retains integrity-sealed supervisor state, lifecycle events,
worker PID/exit receipts, and worker logs. These raw artifacts remain local.
Windows may terminate a child process tree before its host can write an exit
receipt; the recovery test records this honestly and checks that the exact child
PID is no longer alive before restart.

Verification:

```text
node --unhandled-rejections=strict web/web前端/tests/verify-supervised-three-player-job.mjs
```

The compact receipt `supervisor-recovery-receipt.json` records 13 passing
Windows recovery cases and exact source hashes. This fixture verifies process
lifetime, unit preservation, pause/stop, corruption rejection, and bounded
retries. Real trainer recovery, arena recovery, model strength, and application
integration require their separate checks.
