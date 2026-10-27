"""Run a compiled candidate against isolated loopback Web/WeChat fixtures."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time

import httpx

HERE = Path(__file__).resolve().parent
SCENARIO_TIMEOUT_SECONDS = 120
STARTUP_TIMEOUT_SECONDS = 25


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def system_environment(temporary):
    allowed = {"PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC",
               "SYSTEMDRIVE", "PROGRAMFILES", "PROGRAMFILES(X86)",
               "LANG", "LC_ALL", "TZ"}
    environment = {key: value for key, value in os.environ.items()
                   if key.upper() in allowed}
    environment.update({
        "TEMP": str(temporary), "TMP": str(temporary), "TMPDIR": str(temporary),
        "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8",
        "PYTHONDONTWRITEBYTECODE": "1", "PYTHONNOUSERSITE": "1",
    })
    return environment


def process_options():
    if os.name == "nt":
        return {"creationflags": subprocess.CREATE_NO_WINDOW}
    return {"start_new_session": True}


def stop_owned_process(process, environment):
    """Stop only this runner's still-live process and its owned child tree."""
    report = {"wasRunning": process.poll() is None, "forced": False}
    if process.poll() is None:
        if os.name == "nt":
            # Popen's PID is our handle, never a discovered user/service PID.
            system_root = environment.get("SystemRoot", environment.get("SYSTEMROOT"))
            killer = str(Path(system_root) / "System32/taskkill.exe") if system_root else "taskkill.exe"
            try:
                stopped = subprocess.run(
                    [killer, "/PID", str(process.pid), "/T", "/F"],
                    env=environment, capture_output=True, timeout=15,
                    creationflags=subprocess.CREATE_NO_WINDOW, check=False)
                report["method"] = "owned_process_tree_taskkill"
                report["treeStopExitCode"] = stopped.returncode
                if stopped.returncode and process.poll() is None:
                    process.terminate()
                    report["method"] += "_terminate_fallback"
            except (OSError, subprocess.TimeoutExpired):
                process.terminate()
                report["method"] = "owned_process_terminate_fallback"
        else:
            os.killpg(process.pid, signal.SIGTERM)
            report["method"] = "owned_process_group_sigterm"
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            report["forced"] = True
            if os.name == "nt":
                process.kill()
            else:
                os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=10)
    report.update({"stopped": process.poll() is not None,
                   "exitCode": process.returncode})
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--stage", type=Path, required=True)
    parser.add_argument("--frontend-stage", type=Path,
                        help="Optional Web-only candidate; backend still runs from --stage.")
    parser.add_argument("--auth-mode", choices=("legacy-jwt", "password"), default="legacy-jwt",
                        help="Password mode uses the staged standalone ASGI entry and a synthetic legacy user DB.")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not all(path.is_absolute() for path in (args.candidate, args.stage, args.output)):
        parser.error("--candidate, --stage and --output must be absolute paths")
    candidate, stage, output = (path.resolve() for path in
                                (args.candidate, args.stage, args.output))
    frontend_stage = args.frontend_stage.resolve() if args.frontend_stage else stage
    if args.frontend_stage and not args.frontend_stage.is_absolute():
        parser.error("--frontend-stage must be absolute")
    if not (frontend_stage / "web/web前端/SharedRoomClient.js").is_file():
        parser.error("frontend stage must contain SharedRoomClient.js")
    if not candidate.is_dir() or not stage.is_dir():
        parser.error("candidate and stage must be existing directories")
    if output.exists() or output == candidate or output == stage:
        parser.error("output must be a new directory; existing evidence is never overwritten")
    if candidate in output.parents or stage in output.parents:
        parser.error("output must not modify the candidate or stage")
    output.mkdir(parents=True, exist_ok=False)

    report = {
        "schemaVersion": 1, "status": "FAIL", "scope": "COMPILED_VM_LOCAL_HTTP_WS_FIXTURE_ONLY",
        "startedAt": timestamp(), "scenarioTimeoutSeconds": SCENARIO_TIMEOUT_SECONDS,
        "startupTimeoutSeconds": STARTUP_TIMEOUT_SECONDS,
        "realWechatExchange": False, "productionDeployed": False,
        "systemEnvironmentAllowlist": True, "nodeReceivesServerSecrets": False,
        "fixtureDatabasesRemoved": False, "fixtureProcessStopped": True,
        "scenarioProcessStopped": True, "commands": [],
        "authMode": args.auth_mode,
    }
    server_process = scenario_process = None
    temporary = None
    environment = {}
    logs = []
    fixture_name = "password-online-fixture.py" if args.auth_mode == "password" else "compiled-online-fixture.py"
    stage_paths = {"wechatOnline": stage / "web/web后端/wechat_online.py"}
    stage_paths["standaloneAsgi" if args.auth_mode == "password" else "server"] = (
        stage / "wechat/tools/wechat_service_asgi_draft.py" if args.auth_mode == "password"
        else stage / "web/web后端/server.py")
    stage_paths.update({"frontend_" + name: frontend_stage / "web/web前端" / name
                        for name in ("OnlineApp.js", "GameEngine.js", "ReplayCodec.js",
                                     "GameController.js", "SharedRoomClient.js", "CrossPlatformNetwork.js")})
    report["frontendStage"] = str(frontend_stage)
    test_paths = {name: HERE / name for name in (
        "compiled-online-runner.py", fixture_name,
        "compiled-online-harness.mjs", "compiled-online-e2e.mjs")}
    try:
        report["stageHashes"] = {name: sha256(path) for name, path in stage_paths.items()}
        report["testHashes"] = {name: sha256(path) for name, path in test_paths.items()}
        scenario = HERE / "compiled-online-e2e.mjs"
        if not scenario.is_file():
            raise RuntimeError("SCENARIO_NOT_FOUND")
        temporary = Path(tempfile.mkdtemp(prefix="compiled-online-fixture-", dir=output)).resolve()
        environment = system_environment(temporary)
        node = shutil.which("node", path=next(
            (value for key, value in environment.items() if key.upper() == "PATH"), ""))
        if not node:
            raise RuntimeError("NODE_NOT_AVAILABLE")
        fixture_environment = {
            **environment,
            "LIFELINE_COMPILED_ONLINE_FIXTURE": "1",
            "LINE_GAME_DB_PATH": str(temporary / "web.sqlite3"),
            "WECHAT_DB_PATH": str(temporary / "wechat.sqlite3"),
            "JWT_SECRET_KEY": secrets.token_hex(32),
            "WECHAT_JWT_SECRET": secrets.token_hex(32),
            "WECHAT_ONLINE_ENABLED": "0",
            "LIFELINE_NODE": node,
            "BCRYPT_ROUNDS": "4",
        }
        if args.auth_mode == "password":
            fixture_environment.update({
                "LIFELINE_COMPILED_PASSWORD_FIXTURE": "1", "WECHAT_WEB_AUTH_MODE": "password",
                "JWT_SECRET_KEY": "replace-this-with-a-long-random-secret-key",
                "WECHAT_ONLINE_ENABLED": "1", "WECHAT_APP_ID": "fixture-app",
                "WECHAT_APP_SECRET": "fixture-placeholder-never-exchanged",
            })
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        origin = f"http://127.0.0.1:{port}"
        report["origin"] = origin
        server_command = [
            sys.executable, str(HERE / fixture_name),
            "--stage", str(stage), "--data-dir", str(temporary), "--port", str(port),
        ]
        report["commands"].append(server_command)
        server_stdout = (output / "server.stdout.log").open("wb")
        server_stderr = (output / "server.stderr.log").open("wb")
        logs.extend([server_stdout, server_stderr])
        server_process = subprocess.Popen(
            server_command, cwd=temporary, env=fixture_environment,
            stdin=subprocess.DEVNULL, stdout=server_stdout, stderr=server_stderr,
            **process_options())
        report["fixtureProcessStopped"] = False
        with httpx.Client(base_url=origin, timeout=0.5, trust_env=False) as client:
            deadline = time.monotonic() + STARTUP_TIMEOUT_SECONDS
            while True:
                if server_process.poll() is not None:
                    raise RuntimeError("FIXTURE_EXITED_BEFORE_READY")
                try:
                    response = client.get("/api/wechat/status")
                    status = response.json() if response.status_code == 200 else {}
                    if (status.get("enabled") and status.get("webLogin")
                            and (args.auth_mode != "password" or (status.get("webAuthMode") == "password" and status.get("passwordLogin") is True))):
                        report["observedAuthMode"] = status.get("webAuthMode", "legacy-jwt")
                        break
                except (httpx.HTTPError, ValueError):
                    pass
                if time.monotonic() >= deadline:
                    raise RuntimeError("FIXTURE_STARTUP_TIMEOUT")
                time.sleep(0.1)
        report["fixtureDatabasesCreated"] = all(
            (temporary / name).is_file() for name in ("web.sqlite3", "wechat.sqlite3"))
        if not report["fixtureDatabasesCreated"]:
            raise RuntimeError("FIXTURE_DATABASES_NOT_CREATED")
        if args.auth_mode == "password":
            report["legacyFixtureDatabaseSha256Before"] = sha256(temporary / "web.sqlite3")
        scenario_command = [
            node, str(scenario), "--origin", origin, "--candidate", str(candidate),
            "--stage", str(frontend_stage), "--output", str(output / "scenario.json"),
            "--auth-mode", args.auth_mode,
        ]
        report["commands"].append(scenario_command)
        scenario_stdout = (output / "scenario.stdout.log").open("wb")
        scenario_stderr = (output / "scenario.stderr.log").open("wb")
        logs.extend([scenario_stdout, scenario_stderr])
        scenario_process = subprocess.Popen(
            scenario_command, cwd=HERE, env=environment,
            stdin=subprocess.DEVNULL, stdout=scenario_stdout, stderr=scenario_stderr,
            **process_options())
        report["scenarioProcessStopped"] = False
        try:
            report["scenarioExitCode"] = scenario_process.wait(timeout=SCENARIO_TIMEOUT_SECONDS)
            report["scenarioTimedOut"] = False
        except subprocess.TimeoutExpired:
            report["scenarioTimedOut"] = True
            raise RuntimeError("SCENARIO_TIMEOUT") from None
        if report["scenarioExitCode"] != 0:
            raise RuntimeError("SCENARIO_FAILED")
        if not (output / "scenario.json").is_file():
            raise RuntimeError("SCENARIO_REPORT_MISSING")
        scenario_report = json.loads((output / "scenario.json").read_text(encoding="utf-8"))
        report["scenarioStatus"] = scenario_report.get("status")
        if not isinstance(report["scenarioStatus"], str) or not report["scenarioStatus"].startswith("PASS"):
            raise RuntimeError("SCENARIO_DID_NOT_REPORT_PASS")
        report["scenarioReportSha256"] = sha256(output / "scenario.json")
        if args.auth_mode == "password":
            report["legacyFixtureDatabaseSha256After"] = sha256(temporary / "web.sqlite3")
            report["legacyFixtureDatabaseUnchanged"] = (
                report["legacyFixtureDatabaseSha256Before"] == report["legacyFixtureDatabaseSha256After"])
            if not report["legacyFixtureDatabaseUnchanged"]:
                raise RuntimeError("LEGACY_FIXTURE_DATABASE_CHANGED")
        if server_process.poll() is not None:
            raise RuntimeError("FIXTURE_EXITED_DURING_SCENARIO")
        report["stageHashesAfter"] = {name: sha256(path) for name, path in stage_paths.items()}
        if report["stageHashesAfter"] != report["stageHashes"]:
            raise RuntimeError("STAGE_SOURCE_CHANGED_DURING_SCENARIO")
        report["status"] = "PASS_COMPILED_VM_LOCAL_HTTP_WS"
    except BaseException as error:
        # No exception text, inherited environment or credentials enter receipts.
        report["failureType"] = type(error).__name__
        report["failureCode"] = str(error) if isinstance(error, RuntimeError) else "RUNNER_ERROR"
    finally:
        for name, process in (("scenario", scenario_process), ("fixture", server_process)):
            if process is not None:
                try:
                    report[name + "Cleanup"] = stop_owned_process(process, environment)
                    report[name + "ProcessStopped"] = process.poll() is not None
                    if name == "scenario":
                        report.setdefault("scenarioExitCode", process.returncode)
                except Exception as error:
                    report[name + "CleanupFailure"] = type(error).__name__
                    report["status"] = "FAIL"
        for log in logs:
            log.close()
        if temporary is not None:
            # Only the resolved directory created by this invocation may be removed.
            safe = (temporary.parent == output and
                    temporary.name.startswith("compiled-online-fixture-"))
            if safe and report["fixtureProcessStopped"] and (
                    scenario_process is None or report["scenarioProcessStopped"]):
                try:
                    shutil.rmtree(temporary)
                    report["fixtureDatabasesRemoved"] = not temporary.exists()
                except OSError as error:
                    report["databaseCleanupFailure"] = type(error).__name__
            if not report["fixtureDatabasesRemoved"]:
                report["status"] = "FAIL"
        report["finishedAt"] = timestamp()
        try:
            report["stageHashesAfter"] = {name: sha256(path) for name, path in stage_paths.items()}
            report["stageSourcesUnchanged"] = report.get("stageHashes") == report["stageHashesAfter"]
            report["testHashesAfter"] = {name: sha256(path) for name, path in test_paths.items()}
            report["testSourcesUnchanged"] = report.get("testHashes") == report["testHashesAfter"]
            if not report["stageSourcesUnchanged"] or not report["testSourcesUnchanged"]:
                report["status"] = "FAIL"
        except OSError:
            report["stageSourcesUnchanged"] = False
            report["status"] = "FAIL"
        report["logHashes"] = {path.name: sha256(path) for path in output.glob("*.log")}
        (output / "result.json").write_text(
            json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({key: report.get(key) for key in (
        "status", "scenarioExitCode", "scenarioTimedOut",
        "fixtureProcessStopped", "fixtureDatabasesRemoved", "failureCode")}))
    return 0 if report["status"] == "PASS_COMPILED_VM_LOCAL_HTTP_WS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
