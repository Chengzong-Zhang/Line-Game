"""Read-only local preflight. Never loads .env, starts services or prints secrets.

Run under the intended service environment. This does not contact WeChat, prove
credentials valid, or verify production HTTPS/WSS and platform domain settings.
"""
from __future__ import annotations

from contextlib import closing
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
EXPECTED_APP_ID = "wxf986ac5d7e8bb8a0"
DEFAULT_WEB_SECRET = "replace-this-with-a-long-random-secret-key"
REQUIRED = ("WECHAT_ONLINE_ENABLED", "WECHAT_APP_ID", "WECHAT_APP_SECRET",
            "WECHAT_JWT_SECRET", "JWT_SECRET_KEY", "WECHAT_DB_PATH")
LIMITS = ["WECHAT_CREDENTIAL_VALIDITY_NOT_VERIFIED", "DATABASE_WRITE_ACCESS_NOT_VERIFIED",
          "HTTPS_WSS_NOT_VERIFIED", "PLATFORM_DOMAINS_NOT_VERIFIED",
          "SINGLE_ASGI_WORKER_REQUIRED", "NO_SERVICE_STARTED"]


def load_backend_schema(root):
    """Import only the side-effect-free module, never server/database."""
    path = root / "web/web后端/wechat_online.py"
    spec = importlib.util.spec_from_file_location("_lifeline_preflight_schema", path)
    if spec is None or spec.loader is None:
        raise ImportError("Schema module unavailable")
    previous = sys.dont_write_bytecode
    try:
        sys.dont_write_bytecode = True
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    finally:
        sys.dont_write_bytecode = previous
    return module.WechatStore.validate_schema


def file_state(path):
    if not path.exists():
        return None
    stat = path.stat()
    return stat.st_size, stat.st_mtime_ns


def legacy_database_paths(environment):
    explicit = environment.get("LINE_GAME_DB_PATH", "").strip()
    if explicit:
        return {Path(explicit).expanduser().resolve()}
    # database.py defaults to tempfile.gettempdir()/line-game/game.db. A first
    # gettempdir() call can WRITE probe files while selecting a usable directory.
    # Reuse its cached choice, or conservatively exclude every candidate from
    # the same CPython chooser without performing those write probes.
    if tempfile.tempdir is not None:
        candidates = [os.fsdecode(tempfile.tempdir)]
    else:
        candidates = tempfile._candidate_tempdir_list()
        candidates += [environment[key] for key in ("TMPDIR", "TEMP", "TMP") if environment.get(key)]
    return {(Path(directory) / "line-game/game.db").resolve() for directory in candidates}


def inspect_database(value, environment, schema_validator):
    path = Path(value)
    if not path.is_absolute():
        return "DATABASE_PATH_NOT_ABSOLUTE", None
    path = path.resolve()
    # Reject explicit and default Web paths before either database exists.
    legacy_paths = legacy_database_paths(environment)
    if path in legacy_paths or (path.exists() and any(old.exists() and os.path.samefile(path, old) for old in legacy_paths)):
        return "DATABASE_IS_LEGACY_WEB_PATH", None
    if not path.exists():
        ancestor = path.parent
        while not ancestor.exists() and ancestor != ancestor.parent:
            ancestor = ancestor.parent
        if not ancestor.is_dir():
            return "DATABASE_PARENT_NOT_DIRECTORY", None
        return None, "NEW_DATABASE_PATH_NOT_CREATED"
    if not path.is_file():
        return "DATABASE_PATH_NOT_FILE", None
    sidecars = [Path(str(path) + suffix) for suffix in ("-wal", "-journal")]
    before = [file_state(p) for p in [path, *sidecars]]
    if any(state and state[0] for state in before[1:]):
        # SQLite mode=ro may create -shm, while immutable ignores WAL. Refuse a
        # live WAL/hot journal instead of ignoring committed schema changes.
        return "DATABASE_NEEDS_QUIESCENT_SNAPSHOT", None
    try:
        with closing(sqlite3.connect(path.as_uri() + "?mode=ro&immutable=1", uri=True, timeout=2)) as db:
            db.execute("PRAGMA query_only=ON")
            schema_validator(db)
            if db.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
                return "DATABASE_INTEGRITY_FAILED", None
            version = db.execute("PRAGMA user_version").fetchone()[0]
    except (ValueError, sqlite3.DatabaseError):
        return "DATABASE_SCHEMA_UNSUPPORTED_OR_CORRUPT", None
    if before != [file_state(p) for p in [path, *sidecars]]:
        return "DATABASE_CHANGED_DURING_CHECK", None
    return None, {3: "VALID_V3_READ_ONLY", 2: "VALID_V2_READ_ONLY"}.get(version, "VALID_V1_MIGRATION_NOT_RUN")


def probe_profile_images():
    """Exercise synthetic PNG/JPEG codecs in memory before activating profiles."""
    try:
        from PIL import Image, __version__
        major = int(__version__.split(".")[0])
        if not 11 <= major < 13:
            return "PILLOW_VERSION_UNSUPPORTED", None
        for kind in ("PNG", "JPEG"):
            with Image.new("RGB", (2, 2), (30, 90, 60)) as picture:
                encoded = io.BytesIO()
                picture.save(encoded, format=kind)
            encoded.seek(0)
            with Image.open(encoded) as decoded:
                decoded.load()
                if decoded.size != (2, 2) or decoded.format != kind:
                    return "PROFILE_IMAGE_CODEC_UNAVAILABLE", None
        return None, "PASS_PILLOW_PNG_JPEG_SYNTHETIC_PROBE"
    except ImportError:
        return "PILLOW_UNAVAILABLE", None
    except (OSError, ValueError, AttributeError, KeyError):
        return "PROFILE_IMAGE_CODEC_UNAVAILABLE", None


def inspect_legacy_password_database(value):
    """Inspect schema only; never fetch password hashes or create SQLite files."""
    path = Path(value)
    if not path.is_absolute():
        return "WEB_DATABASE_PATH_NOT_ABSOLUTE", None
    path = path.resolve()
    if not path.is_file():
        return "WEB_DATABASE_MISSING_OR_NOT_FILE", None
    sidecars = [Path(str(path) + suffix) for suffix in ("-wal", "-journal")]
    before = [file_state(p) for p in [path, *sidecars]]
    if any(state and state[0] for state in before[1:]):
        return "WEB_DATABASE_NEEDS_QUIESCENT_SNAPSHOT", None
    try:
        with closing(sqlite3.connect(path.as_uri() + "?mode=ro&immutable=1", uri=True, timeout=2)) as db:
            db.execute("PRAGMA query_only=ON")
            db.set_progress_handler(lambda: 1, 500000)
            if db.execute("SELECT type FROM sqlite_master WHERE name='users'").fetchone() != ("table",):
                return "WEB_DATABASE_SCHEMA_UNSUPPORTED", None
            columns = {row[1]: row for row in db.execute("PRAGMA table_info(users)")}
            if (not {"id", "username", "password_hash"}.issubset(columns)
                    or columns["id"][2].upper() != "INTEGER" or not columns["id"][5]
                    or any(not columns[name][3] or not columns[name][2].upper().startswith(("TEXT", "VARCHAR"))
                           for name in ("username", "password_hash"))):
                return "WEB_DATABASE_SCHEMA_UNSUPPORTED", None
            unique_username = False
            for row in db.execute("PRAGMA index_list(users)"):
                if row[2] and (len(row) < 5 or not row[4]):
                    name = row[1].replace('"', '""')
                    if [item[2] for item in db.execute(f'PRAGMA index_info("{name}")')] == ["username"]:
                        unique_username = True
            if not unique_username:
                return "WEB_DATABASE_SCHEMA_UNSUPPORTED", None
    except sqlite3.DatabaseError:
        return "WEB_DATABASE_SCHEMA_UNSUPPORTED", None
    if before != [file_state(p) for p in [path, *sidecars]]:
        return "WEB_DATABASE_CHANGED_DURING_CHECK", None
    return None, "LEGACY_USERS_SCHEMA_READ_ONLY_PASSWORDS_NOT_READ"


def child_environment(environment):
    # No AppSecret, JWT, database path, NODE_OPTIONS or proxy credentials reach
    # dependency probes. Runtime system fields are the only inherited values.
    names = {"path", "pathext", "systemroot", "windir", "lang", "lc_all", "tz"}
    return {key: value for key, value in environment.items() if key.lower() in names}


def probe_rules(environment, root):
    node = environment.get("LIFELINE_NODE", "node")
    if not isinstance(node, str) or not node:
        return "NODE_EXECUTABLE_UNAVAILABLE", None
    # Resolve using the intended process PATH; do not silently use another PATH.
    executable = shutil.which(node, path=environment.get("PATH", environment.get("Path", "")))
    if not executable:
        return "NODE_EXECUTABLE_UNAVAILABLE", None
    flags = {"capture_output": True, "timeout": 15, "check": False, "env": child_environment(environment),
             "cwd": root, "creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0)}
    try:
        version = subprocess.run([executable, "--version"], **flags)
        matched = re.fullmatch(rb"v(\d+)\.\d+\.\d+\s*", version.stdout)
        if version.returncode or not matched or int(matched[1]) < 22:
            return "NODE_VERSION_UNSUPPORTED", None
        validator = root / "wechat/minigame/tools/validate-action.mjs"
        if not validator.is_file():
            return "RULE_VALIDATOR_PATH_MISSING", None
        payload = {"settings": {"gridSize": 5, "playerCount": 2, "startPlayer": "BLACK", "rulesVersion": "territory-v2",
                                "turnTimerEnabled": False, "turnTimeLimitSeconds": 60, "hintEnabled": False, "hintMaxCount": 0},
                   "actions": []}
        result = subprocess.run([executable, str(validator)], input=json.dumps(payload).encode(), **flags)
        if result.returncode or len(result.stdout) > 8192:
            return "RULE_VALIDATOR_DEPENDENCIES_UNAVAILABLE", None
        data = json.loads(result.stdout)
        if (not isinstance(data, dict) or not isinstance(data.get("stateHash"), str)
                or not re.fullmatch(r"sha256:[0-9a-f]{64}", data["stateHash"])
                or data.get("currentPlayer") != "BLACK" or data.get("gameOver") is not False
                or not isinstance(data.get("scores"), dict)
                or any(type(data["scores"].get(p)) is not int or data["scores"][p] < 0 for p in ("BLACK", "WHITE"))):
            return "RULE_VALIDATOR_RESPONSE_INVALID", None
        return None, "PASS_FIXED_POSITION_DEPENDENCY_PROBE"
    except subprocess.TimeoutExpired:
        return "RULE_VALIDATOR_TIMEOUT", None
    except (OSError, ValueError):
        return "RULE_VALIDATOR_UNAVAILABLE", None


def check_service_config(environment=None, *, root=ROOT):
    environment = dict(os.environ if environment is None else environment)
    root = Path(root)
    issues, checks = [], {}
    mode = environment.get("WECHAT_WEB_AUTH_MODE", "legacy-jwt")
    if mode not in ("legacy-jwt", "password"):
        issues.append({"field": "WECHAT_WEB_AUTH_MODE", "code": "WEB_AUTH_MODE_UNSUPPORTED"})
    required = tuple(key for key in REQUIRED if key != "JWT_SECRET_KEY") + ("LINE_GAME_DB_PATH",) if mode == "password" else REQUIRED
    values = {key: environment.get(key, "").strip() for key in set(REQUIRED) | {"LINE_GAME_DB_PATH"}}
    missing = [key for key in required if not values[key]]
    checks["webAuthMode"] = mode if mode in ("legacy-jwt", "password") else "UNSUPPORTED"
    for key in missing:
        issues.append({"field": key, "code": "MISSING"})
    if values["WECHAT_ONLINE_ENABLED"] and environment["WECHAT_ONLINE_ENABLED"] != "1":
        issues.append({"field": "WECHAT_ONLINE_ENABLED", "code": "ONLINE_DISABLED"})
    if values["WECHAT_APP_ID"] and values["WECHAT_APP_ID"] != EXPECTED_APP_ID:
        issues.append({"field": "WECHAT_APP_ID", "code": "APP_ID_MISMATCH"})
    for key in (("WECHAT_JWT_SECRET",) if mode == "password" else ("WECHAT_JWT_SECRET", "JWT_SECRET_KEY")):
        secret = values[key]
        if secret and (len(secret) < 32 or secret == DEFAULT_WEB_SECRET):
            issues.append({"field": key, "code": "SIGNING_SECRET_WEAK_OR_DEFAULT"})
        if secret and environment[key] != secret:
            issues.append({"field": key, "code": "SIGNING_SECRET_SURROUNDING_WHITESPACE"})
    wechat_secret = values["WECHAT_JWT_SECRET"]
    if wechat_secret and wechat_secret in (values["JWT_SECRET_KEY"], values["WECHAT_APP_SECRET"]):
        issues.append({"field": "WECHAT_JWT_SECRET", "code": "SIGNING_SECRET_NOT_INDEPENDENT"})
    try:
        schema_validator = load_backend_schema(root)
        checks["backendImports"] = "PASS_NO_SERVER_IMPORT"
    except (ImportError, OSError, AttributeError):
        schema_validator = None
        issues.append({"field": "PYTHON_BACKEND", "code": "BACKEND_DEPENDENCIES_UNAVAILABLE"})
    error, status = probe_profile_images()
    if error:
        issues.append({"field": "PROFILE_IMAGES", "code": error})
    else:
        checks["profileImages"] = status
    if values["WECHAT_DB_PATH"] and schema_validator:
        try:
            error, status = inspect_database(values["WECHAT_DB_PATH"], environment, schema_validator)
            if error:
                issues.append({"field": "WECHAT_DB_PATH", "code": error})
            else:
                checks["database"] = status
        except (OSError, ValueError):
            issues.append({"field": "WECHAT_DB_PATH", "code": "DATABASE_PATH_UNAVAILABLE"})
    if mode == "password" and values["LINE_GAME_DB_PATH"]:
        try:
            error, status = inspect_legacy_password_database(values["LINE_GAME_DB_PATH"])
            if error:
                issues.append({"field": "LINE_GAME_DB_PATH", "code": error})
            else:
                checks["webAccountDatabase"] = status
            import bcrypt  # Dependency availability only; no passwords read.
            checks["passwordVerifier"] = "BCRYPT_AVAILABLE_NOT_AUTHENTICATED"
        except (ImportError, OSError, ValueError):
            issues.append({"field": "LINE_GAME_DB_PATH", "code": "WEB_PASSWORD_AUTH_DEPENDENCY_UNAVAILABLE"})
    error, status = probe_rules(environment, root)
    if error:
        issues.append({"field": "LIFELINE_NODE", "code": error})
    else:
        checks["rules"] = status
    return {"schemaVersion": 1, "status": "BLOCKED_MISSING_CONFIGURATION" if missing else
            "BLOCKED_INVALID_CONFIGURATION" if issues else "PASS_LOCAL_CONFIGURATION_NOT_DEPLOYED",
            "issues": issues, "checks": checks, "limits": LIMITS}


def main():
    # The JSON contract deliberately excludes exception messages, values and
    # paths, even when a local dependency prints a secret in its stderr.
    try:
        result = check_service_config()
    except Exception:
        result = {"schemaVersion": 1, "status": "BLOCKED_PREFLIGHT_ERROR",
                  "issues": [{"field": "PREFLIGHT", "code": "UNEXPECTED_LOCAL_CHECK_FAILURE"}]}
    print(json.dumps(result, ensure_ascii=True))
    return 0 if result["status"] == "PASS_LOCAL_CONFIGURATION_NOT_DEPLOYED" else 2


if __name__ == "__main__":
    raise SystemExit(main())
