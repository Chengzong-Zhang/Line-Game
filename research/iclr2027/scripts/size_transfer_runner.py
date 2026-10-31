"""Recoverable size-transfer training runner.

This module deliberately sits beside, rather than inside, the historical
``AlphaZeroTrainer``.  It commits one self-play game and one optimizer update
per durable transaction, so a worker failure can replay at most the current
uncommitted transaction.  The runner is research infrastructure: it does not
turn a smoke/pilot run into formal evidence.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import random
import subprocess
import sys
import time
from typing import Any, Mapping
from uuid import uuid4

try:
    import torch
except ImportError as exc:  # pragma: no cover
    raise ImportError("size_transfer_runner requires PyTorch") from exc

from lifeline_rl.alphazero.config import AlphaZeroConfig
from lifeline_rl.alphazero.self_play import play_self_play_game
from lifeline_rl.alphazero.trainer import AlphaZeroTrainer


SCHEMA_VERSION = 1
PAUSE_EXIT = 75
STOP_EXIT = 76
MAX_NO_PROGRESS_FAILURES = 3


class RunnerIntegrityError(RuntimeError):
    """The durable run state is corrupt, ambiguous, or incompatible."""


class InjectedCrash(RuntimeError):
    """Test-only failure injection; never used by normal CLI execution."""


def _tuple_tree(value: Any) -> Any:
    if isinstance(value, list):
        return tuple(_tuple_tree(item) for item in value)
    if isinstance(value, tuple):
        return tuple(_tuple_tree(item) for item in value)
    return value


def _canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def _digest(value: Any) -> str:
    return hashlib.sha256(_canonical(value).encode("utf-8")).hexdigest()


def _atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    with temporary.open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def _read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise RunnerIntegrityError(f"cannot read JSON state: {path}") from exc
    if not isinstance(value, dict):
        raise RunnerIntegrityError(f"JSON state must be an object: {path}")
    return value


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    records: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as exc:
                raise RunnerIntegrityError(f"corrupt JSONL at {path}:{line_number}") from exc
            if not isinstance(value, dict):
                raise RunnerIntegrityError(f"JSONL record is not an object at {path}:{line_number}")
            records.append(value)
    return records


def _append_unique(path: Path, record: Mapping[str, Any], key: str) -> None:
    records = _read_jsonl(path)
    expected = _canonical(dict(record))
    for old in records:
        if old.get(key) == record.get(key):
            if _canonical(old) != expected:
                raise RunnerIntegrityError(f"conflicting duplicate {key}={record.get(key)!r} in {path}")
            return
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8", newline="\n") as handle:
        handle.write(expected + "\n")
        handle.flush()
        os.fsync(handle.fileno())


def _pid_is_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":
        # Windows interprets signal 0 as CTRL_C_EVENT, not a read-only probe.
        import ctypes
        from ctypes import wintypes

        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
        kernel.GetExitCodeProcess.restype = wintypes.BOOL
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel.CloseHandle.restype = wintypes.BOOL
        handle = kernel.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return ctypes.get_last_error() != 87  # Invalid PID; other errors fail closed.
        try:
            exit_code = wintypes.DWORD()
            if not kernel.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
                return True
            return exit_code.value == 259  # STILL_ACTIVE
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except (OSError, ValueError):
        return False
    return True


class WorkerLock:
    """Small exclusive lock; stale locks are retained and fail closed."""

    def __init__(self, path: Path):
        self.path = path
        self.owned = False

    def __enter__(self) -> "WorkerLock":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {"pid": os.getpid(), "started_at": time.time(), "schema_version": 1}
        try:
            with self.path.open("x", encoding="utf-8", newline="\n") as handle:
                json.dump(payload, handle, sort_keys=True)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
        except FileExistsError as exc:
            try:
                prior = _read_json(self.path)
            except RunnerIntegrityError:
                raise RunnerIntegrityError(f"worker lock is present and corrupt: {self.path}") from exc
            if _pid_is_alive(int(prior.get("pid", -1))):
                raise RunnerIntegrityError(f"another worker is active (pid={prior['pid']})")
            raise RunnerIntegrityError(f"stale worker lock requires explicit operator cleanup: {self.path}") from exc
        self.owned = True
        return self

    def __exit__(self, exc_type, exc, traceback) -> None:
        if self.owned:
            self.path.unlink(missing_ok=True)
            self.owned = False


def _counter_subset(trainer: AlphaZeroTrainer) -> dict[str, int]:
    return trainer.counters.to_dict()


def _same_counter(left: Mapping[str, Any], right: Mapping[str, Any]) -> bool:
    return dict(left) == dict(right)


class RecoverableRunner:
    """Run one already initialized stage with transaction-level recovery."""

    def __init__(self, run_directory: str | Path, *, device: str = "cpu", fault_after: str | None = None):
        self.run_directory = Path(run_directory).resolve()
        self.device = device
        self.fault_after = fault_after
        self.transactions = self.run_directory / "transactions"
        self.transactions.mkdir(parents=True, exist_ok=True)
        self.config = AlphaZeroConfig.load(self.run_directory / "resolved_config.json")
        self.initialization = _read_json(self.run_directory / "initialization.json")
        if self.initialization.get("status") != "INITIALIZED_ONLY":
            raise RunnerIntegrityError("stage is not an initialized, runnable stage")
        if self.initialization.get("config_hash") != self.config.fingerprint():
            raise RunnerIntegrityError("initialization/config hash mismatch")
        if self.initialization.get("current_source_hash") != AlphaZeroTrainer.current_source_hash():
            raise RunnerIntegrityError("current source hash changed since initialization")
        self.trainer = AlphaZeroTrainer(self.config, self.run_directory, device=device)
        self.trainer.resume(self.run_directory / "checkpoints")
        self._verify_logs()

    @property
    def game_log(self) -> Path:
        return self.run_directory / "committed_games.jsonl"

    @property
    def update_log(self) -> Path:
        return self.run_directory / "committed_updates.jsonl"

    @property
    def metrics_log(self) -> Path:
        return self.run_directory / "committed_metrics.jsonl"

    def _verify_logs(self) -> None:
        # A worker may die after the transaction checkpoint is durable but
        # before its derived JSONL line is appended.  Reconcile committed
        # transactions first; never silently accept a missing derived record.
        for path in self._transaction_files():
            record = _read_json(path)
            self._check_transaction_hash(record, path)
            if record.get("status") == "COMMITTED":
                self._append_logs_for_transaction(record)
        for path, key in (
            (self.game_log, "game_index"),
            (self.update_log, "gradient_step"),
            (self.metrics_log, "iteration"),
        ):
            records = _read_jsonl(path)
            seen: set[Any] = set()
            for record in records:
                if key not in record:
                    raise RunnerIntegrityError(f"missing {key} in {path.name}")
                identity = record[key]
                if identity in seen:
                    raise RunnerIntegrityError(f"duplicate {key}={identity!r} in {path.name}")
                seen.add(identity)

    def _trip(self, event: str) -> None:
        if self.fault_after == event:
            raise InjectedCrash(event)

    def _transaction_files(self) -> list[Path]:
        return sorted(self.transactions.glob("*.json"))

    def _write_transaction(self, name: str, record: dict[str, Any]) -> Path:
        path = self.transactions / name
        if path.exists():
            raise RunnerIntegrityError(f"transaction id already exists: {path.name}")
        record = {"schema_version": SCHEMA_VERSION, **record}
        record["record_hash"] = _digest(record)
        _atomic_json(path, record)
        return path

    def _update_transaction(self, path: Path, changes: Mapping[str, Any]) -> dict[str, Any]:
        current = _read_json(path)
        self._check_transaction_hash(current, path)
        current.pop("record_hash", None)
        current.update(changes)
        current["record_hash"] = _digest(current)
        _atomic_json(path, current)
        return current

    @staticmethod
    def _check_transaction_hash(record: Mapping[str, Any], path: Path) -> None:
        stored = record.get("record_hash")
        body = dict(record)
        body.pop("record_hash", None)
        if stored != _digest(body):
            raise RunnerIntegrityError(f"transaction hash mismatch: {path.name}")

    def _checkpoint(self) -> dict[str, Any]:
        # Never reuse AlphaZeroTrainer's iteration-based default filename:
        # the checkpoint file is committed before latest.json, so overwriting
        # the old target would invalidate its still-current manifest if that
        # second atomic replacement failed.
        checkpoint_dir = self.run_directory / "checkpoints"
        checkpoint_path = checkpoint_dir / f"runner-{uuid4().hex}.pt"
        if checkpoint_path.exists():
            raise RunnerIntegrityError(f"checkpoint path unexpectedly exists: {checkpoint_path}")
        return self.trainer.save(path=checkpoint_path)

    def _apply_game(self, record: Mapping[str, Any]) -> None:
        before = record["before_counters"]
        after = record["after_counters"]
        current = _counter_subset(self.trainer)
        if _same_counter(current, after):
            return
        if not _same_counter(current, before):
            raise RunnerIntegrityError("game transaction counter gap or duplicate")
        experiences = record["experiences"]
        if experiences:
            from lifeline_rl.alphazero.replay import Experience
            self.trainer.replay_buffer.add_game(Experience.from_dict(item) for item in experiences)
        self.trainer.counters.environment_steps = int(after["environment_steps"])
        self.trainer.counters.games_attempted = int(after["games_attempted"])
        self.trainer.counters.games_completed = int(after["games_completed"])
        self.trainer.counters.games_truncated = int(after["games_truncated"])
        self.trainer.counters.next_game_id = int(after["next_game_id"])
        self.trainer.self_play_rng.setstate(_tuple_tree(record["self_play_rng_after"]))

    def _apply_update(self, record: Mapping[str, Any]) -> dict[str, Any]:
        before = record["before_counters"]
        after = record["after_counters"]
        current = _counter_subset(self.trainer)
        if _same_counter(current, after):
            return dict(record["metrics"])
        if not _same_counter(current, before):
            raise RunnerIntegrityError("update transaction counter gap or duplicate")
        metrics = self.trainer.train_batch()
        if not _same_counter(_counter_subset(self.trainer), after):
            raise RunnerIntegrityError("optimizer update counter does not match transaction")
        # A crash at update_prepare leaves metrics empty.  The update is then
        # replayed from the checkpoint immediately before train_batch and the
        # recovered metrics are committed into the transaction.  Once metrics
        # are present, compare them strictly under the restored CPU fixture.
        if record.get("metrics") and _canonical(metrics) != _canonical(record["metrics"]):
            raise RunnerIntegrityError("optimizer update metric mismatch during recovery")
        return metrics

    def _apply_iteration(self, record: Mapping[str, Any]) -> None:
        current = _counter_subset(self.trainer)
        before = record["before_counters"]
        after = record["after_counters"]
        if _same_counter(current, after):
            return
        if not _same_counter(current, before):
            raise RunnerIntegrityError("iteration transaction counter gap or duplicate")
        self.trainer.counters.iteration = int(after["iteration"])

    def _recover_transactions(self) -> None:
        files = self._transaction_files()
        uncommitted_seen = False
        for path in files:
            record = _read_json(path)
            self._check_transaction_hash(record, path)
            status = record.get("status")
            if status == "COMMITTED":
                continue
            if status != "PREPARED" or uncommitted_seen:
                raise RunnerIntegrityError(f"transaction ordering/status is invalid: {path.name}")
            uncommitted_seen = True
            kind = record.get("kind")
            if kind == "game":
                self._apply_game(record)
            elif kind == "update":
                metrics = self._apply_update(record)
                if not record["metrics"]:
                    record = self._update_transaction(
                        path,
                        {
                            "metrics": metrics,
                            "update_record": {
                                "gradient_step": record["after_counters"]["gradient_steps"],
                                "iteration": record["before_counters"]["iteration"],
                                **metrics,
                            },
                        },
                    )
            elif kind == "iteration":
                self._apply_iteration(record)
            else:
                raise RunnerIntegrityError(f"unknown transaction kind: {kind!r}")
            manifest = self._checkpoint()
            self._trip(f"{kind}_checkpoint")
            record = self._update_transaction(path, {"status": "COMMITTED", "checkpoint": manifest})
            self._append_logs_for_transaction(record)

    def _append_logs_for_transaction(self, record: Mapping[str, Any]) -> None:
        if record["kind"] == "game":
            _append_unique(self.game_log, record["game_record"], "game_index")
        elif record["kind"] == "update":
            _append_unique(self.update_log, record["update_record"], "gradient_step")
        elif record["kind"] == "iteration":
            _append_unique(self.metrics_log, record["metric_record"], "iteration")

    def _new_game(self) -> None:
        before = _counter_subset(self.trainer)
        game_index = self.trainer.counters.next_game_id
        game_seed = self.trainer.self_play_rng.getrandbits(63)
        grid_size = self.trainer.self_play_rng.choice(self.config.board_sizes)
        rng_after = self.trainer.self_play_rng.getstate()
        result = play_self_play_game(
            self.trainer.searcher,
            self.trainer._self_play_config(grid_size),
            game_seed,
            game_index=game_index,
            replay_buffer=None,
        )
        after = dict(before)
        after["environment_steps"] += len(result.actions)
        after["games_attempted"] += 1
        after["next_game_id"] += 1
        if result.terminated:
            after["games_completed"] += 1
        else:
            after["games_truncated"] += 1
        record = {
            "kind": "game",
            "status": "PREPARED",
            "transaction_id": f"game-{game_index:08d}",
            "before_counters": before,
            "after_counters": after,
            "self_play_rng_after": rng_after,
            "experiences": [sample.to_dict() for sample in result.experiences],
            "game_record": {**result.to_dict(), "iteration": before["iteration"]},
        }
        path = self._write_transaction(f"{record['transaction_id']}.json", record)
        self._trip("game_prepare")
        self._apply_game(record)
        manifest = self._checkpoint()
        self._trip("game_checkpoint")
        committed = self._update_transaction(path, {"status": "COMMITTED", "checkpoint": manifest})
        self._append_logs_for_transaction(committed)

    def _new_update(self) -> None:
        before = _counter_subset(self.trainer)
        expected = dict(before)
        expected["gradient_steps"] += 1
        # ReplayBuffer.sample(batch_size) returns exactly batch_size examples;
        # examples_seen is part of the durable counter and must advance in the
        # transaction expectation together with gradient_steps.
        expected["examples_seen"] += self.config.batch_size
        # The transaction is written before train_batch consumes replay/global RNG.
        # Recovery therefore re-enters train_batch from the exact checkpoint RNG.
        path = self._write_transaction(
            f"update-{before['gradient_steps'] + 1:08d}.json",
            {
                "kind": "update",
                "status": "PREPARED",
                "transaction_id": f"update-{before['gradient_steps'] + 1:08d}",
                "before_counters": before,
                "after_counters": expected,
                "metrics": {},
                "update_record": {"gradient_step": expected["gradient_steps"], "iteration": before["iteration"]},
            },
        )
        self._trip("update_prepare")
        metrics = self.trainer.train_batch()
        record = _read_json(path)
        record["metrics"] = metrics
        record["update_record"] = {
            "gradient_step": expected["gradient_steps"],
            "iteration": before["iteration"],
            **metrics,
        }
        body = dict(record)
        body.pop("record_hash", None)
        record["record_hash"] = _digest(body)
        _atomic_json(path, record)
        manifest = self._checkpoint()
        self._trip("update_checkpoint")
        committed = self._update_transaction(path, {"status": "COMMITTED", "checkpoint": manifest})
        self._append_logs_for_transaction(committed)
        return dict(committed["metrics"])

    def _new_iteration(self, update_metrics: list[dict[str, Any]]) -> None:
        before = _counter_subset(self.trainer)
        after = dict(before)
        after["iteration"] += 1
        metric = {
            "schema_version": 1,
            "iteration": after["iteration"],
            "games_completed": before["games_completed"],
            "games_truncated": before["games_truncated"],
            "gradient_steps_this_iteration": len(update_metrics),
            "buffer_size": len(self.trainer.replay_buffer),
            "counters": after,
            "model_kind": self.config.model_kind,
            "observation_mode": self.config.observation_mode,
            "parameter_count": self.trainer.model.parameter_count,
            "loss": (sum(item["loss"] for item in update_metrics) / len(update_metrics)) if update_metrics else None,
        }
        record = {
            "kind": "iteration",
            "status": "PREPARED",
            "transaction_id": f"iteration-{after['iteration']:08d}",
            "before_counters": before,
            "after_counters": after,
            "metric_record": metric,
        }
        path = self._write_transaction(f"{record['transaction_id']}.json", record)
        self._trip("iteration_prepare")
        self._apply_iteration(record)
        manifest = self._checkpoint()
        self._trip("iteration_checkpoint")
        committed = self._update_transaction(path, {"status": "COMMITTED", "checkpoint": manifest})
        self._append_logs_for_transaction(committed)

    def _committed_game_for_iteration(self, iteration: int) -> dict[str, Any] | None:
        matches = [
            record for record in _read_jsonl(self.game_log)
            if record.get("iteration") == iteration
        ]
        if len(matches) > 1:
            raise RunnerIntegrityError(
                f"multiple committed games for iteration={iteration}"
            )
        return matches[0] if matches else None

    def _committed_updates_for_iteration(self, iteration: int) -> list[dict[str, Any]]:
        return [
            record for record in _read_jsonl(self.update_log)
            if record.get("iteration") == iteration
        ]

    def run(self, *, max_iterations: int | None = None) -> str:
        with WorkerLock(self.run_directory / ".worker.lock"):
            self._recover_transactions()
            start_iteration = self.trainer.counters.iteration
            limit = self.config.iterations if max_iterations is None else min(self.config.iterations, start_iteration + max_iterations)
            update_count = 0
            while self.trainer.counters.iteration < limit:
                if (self.run_directory / "STOP").exists():
                    return "STOPPED"
                if (self.run_directory / "PAUSE").exists():
                    return "PAUSED"
                # A crash can occur after the game/update transaction is
                # committed but before the enclosing iteration transaction.
                # Finish that iteration instead of generating a second game.
                existing_game = self._committed_game_for_iteration(
                    self.trainer.counters.iteration
                )
                if existing_game is None:
                    self._new_game()
                    metrics: list[dict[str, Any]] = []
                    if len(self.trainer.replay_buffer) >= self.config.batch_size:
                        for _ in range(self.config.training_steps_per_iteration):
                            update_metrics = self._new_update()
                            update_count += 1
                            metrics.append(update_metrics)
                else:
                    metrics = self._committed_updates_for_iteration(
                        self.trainer.counters.iteration
                    )
                    if len(metrics) > self.config.training_steps_per_iteration:
                        raise RunnerIntegrityError(
                            "more committed updates than the iteration budget"
                        )
                    # A crash at game_prepare/game_checkpoint can leave the
                    # game durable while the enclosing iteration is not.  In
                    # that case the game must be reused, but the iteration's
                    # optimizer budget still has to be completed.  Replaying
                    # only the already logged updates would silently under-
                    # train the iteration and make recovery non-equivalent.
                    if len(self.trainer.replay_buffer) >= self.config.batch_size:
                        missing_updates = (
                            self.config.training_steps_per_iteration - len(metrics)
                        )
                        for _ in range(missing_updates):
                            update_metrics = self._new_update()
                            update_count += 1
                            metrics.append(update_metrics)
                self._new_iteration(metrics)
            receipt = {
                "schema_version": 1,
                "status": "COMPLETE_NOT_FORMAL",
                "formal_ready": False,
                "config_hash": self.config.fingerprint(),
                "source_hash": self.initialization.get("current_source_hash"),
                "counters": self.trainer.counters.to_dict(),
                "gradient_updates_committed": len(_read_jsonl(self.update_log)),
                "training_started": True,
            }
            _atomic_json(self.run_directory / "stage_receipt.json", receipt)
            return receipt["status"]


def append_evaluation_record(run_directory: str | Path, record: Mapping[str, Any]) -> None:
    """Durably append one stable evaluation unit after strict JSONL validation."""

    required = {"evaluation_id", "status", "game_ids"}
    missing = required.difference(record)
    if missing:
        raise ValueError(f"evaluation record is missing: {sorted(missing)}")
    if not isinstance(record["evaluation_id"], str) or not record["evaluation_id"]:
        raise ValueError("evaluation_id must be non-empty")
    if not isinstance(record["game_ids"], list) or len(set(record["game_ids"])) != len(record["game_ids"]):
        raise ValueError("evaluation game_ids must be a duplicate-free list")
    _append_unique(Path(run_directory) / "evaluation_receipts.jsonl", record, "evaluation_id")


def supervise(
    run_directory: str | Path,
    *,
    max_restarts: int = MAX_NO_PROGRESS_FAILURES,
    python: str | None = None,
    device: str = "cpu",
) -> str:
    """Supervise a worker until completion, pause/stop, or bounded no-progress failures."""

    run = Path(run_directory).resolve()
    executable = python or sys.executable
    events = run / "supervisor_events.jsonl"
    failures = 0
    previous_progress: tuple[int, int, int] | None = None
    while True:
        command = [
            executable,
            str(Path(__file__).resolve()),
            "worker",
            "--run-dir",
            str(run),
            "--device",
            device,
        ]
        # Use the repository root, not a depth derived from the output path;
        # pilot runs may be placed outside the repository.
        repository_root = Path(__file__).resolve().parents[3]
        research_root = Path(__file__).resolve().parents[1]
        child_env = os.environ.copy()
        existing_pythonpath = child_env.get("PYTHONPATH")
        child_env["PYTHONPATH"] = os.pathsep.join(
            item for item in (str(research_root), existing_pythonpath) if item
        )
        completed = subprocess.run(
            command,
            cwd=str(repository_root),
            env=child_env,
            check=False,
        )
        try:
            config = AlphaZeroConfig.load(run / "resolved_config.json")
            trainer = AlphaZeroTrainer(config, run, device="cpu")
            trainer.resume(run / "checkpoints")
            current = (trainer.counters.iteration, trainer.counters.next_game_id, trainer.counters.gradient_steps)
        except Exception as exc:
            raise RunnerIntegrityError("supervisor could not inspect worker progress") from exc
        event = {
            "schema_version": 1,
            "timestamp": time.time(),
            "returncode": completed.returncode,
            "progress": {
                "iteration": current[0],
                "next_game_id": current[1],
                "gradient_steps": current[2],
            },
            "command": command,
        }
        with events.open("a", encoding="utf-8", newline="\n") as handle:
            handle.write(_canonical(event) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        if (run / "STOP").exists():
            return "STOPPED"
        if (run / "PAUSE").exists():
            return "PAUSED"
        if run.joinpath("stage_receipt.json").is_file():
            return _read_json(run / "stage_receipt.json").get("status", "UNKNOWN")
        if completed.returncode == 0:
            return "WORKER_EXITED_WITHOUT_RECEIPT"
        if previous_progress == current:
            failures += 1
        else:
            failures = 0
        previous_progress = current
        if failures >= max_restarts:
            raise RuntimeError(f"worker failed {failures} times without progress; last exit={completed.returncode}")


def _main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    worker = sub.add_parser("worker")
    worker.add_argument("--run-dir", type=Path, required=True)
    worker.add_argument("--device", default="cpu")
    worker.add_argument("--fault-after")
    supervisor = sub.add_parser("supervise")
    supervisor.add_argument("--run-dir", type=Path, required=True)
    supervisor.add_argument("--max-restarts", type=int, default=MAX_NO_PROGRESS_FAILURES)
    supervisor.add_argument("--device", default="cpu")
    args = parser.parse_args(argv)
    torch.set_num_threads(1)
    if args.command == "worker":
        status = RecoverableRunner(args.run_dir, device=args.device, fault_after=args.fault_after).run()
        print(json.dumps({"status": status}, ensure_ascii=False))
        return 0 if status not in {"STOPPED", "PAUSED"} else (STOP_EXIT if status == "STOPPED" else PAUSE_EXIT)
    print(json.dumps({
        "status": supervise(
            args.run_dir,
            max_restarts=args.max_restarts,
            device=args.device,
        )
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
