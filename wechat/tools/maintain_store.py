"""Offline operator utility; never opens a production application or prints rows.

Backup uses SQLite's snapshot API, including committed WAL data. Restore always
creates a new file and requires the backup receipt's SHA-256. No overwrite mode.
"""
import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import time
import unicodedata

TABLES = {
    "wx_users": ["subject", "uid"],
    "wx_rooms": ["code", "revision", "expires", "document"],
    "wx_commands": ["room", "match_id", "command_id", "uid", "hash"],
}
ACCOUNT_TABLES = {
    "wx_web_accounts": ["subject", "uid", "display_name"],
    "wx_link_codes": ["digest", "web_subject", "expires", "created"],
}
PROFILE_TABLES = {"wx_profiles": ["uid", "display_name", "avatar_mime", "avatar_blob", "avatar_hash", "updated"]}


def digest(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def readonly(path):
    source = Path(path).resolve(strict=True)
    if not source.is_file():
        raise ValueError("Source must be an existing database file")
    return sqlite3.connect(source.as_uri() + "?mode=ro", uri=True, timeout=5)


def inspect_connection(db):
    if db.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
        raise ValueError("Database integrity check failed")
    tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if tables not in (set(TABLES), set(TABLES) | set(ACCOUNT_TABLES), set(TABLES) | set(ACCOUNT_TABLES) | set(PROFILE_TABLES)):
        raise ValueError("Unexpected database schema; only the dedicated WeChat database is supported")
    version = db.execute("PRAGMA user_version").fetchone()[0]
    if version not in (0, 1, 2, 3) or (version >= 2) != ("wx_web_accounts" in tables) or (version == 3) != ("wx_profiles" in tables):
        raise ValueError("Database schema version is not supported")
    for table, columns in {**TABLES, **ACCOUNT_TABLES, **PROFILE_TABLES}.items():
        if table not in tables:
            continue
        if [row[1] for row in db.execute(f"PRAGMA table_info({table})")] != columns:
            raise ValueError("Database schema version is not supported")
    users = {}
    for subject, uid in db.execute("SELECT subject,uid FROM wx_users"):
        if not re.fullmatch(r"[0-9a-f]{64}", subject) or not re.fullmatch(r"[0-9a-f]{32}", uid):
            raise ValueError("Invalid identity record")
        users[uid] = subject
    if "wx_web_accounts" in tables:
        web_subjects = set()
        for subject, uid, name in db.execute("SELECT * FROM wx_web_accounts"):
            if (not re.fullmatch(r"[0-9a-f]{64}", subject) or not re.fullmatch(r"[0-9a-f]{32}", uid)
                    or not isinstance(name, str) or not 1 <= len(name) <= 50):
                raise ValueError("Invalid Web identity record")
            users.setdefault(uid, subject)
            web_subjects.add(subject)
        for code_hash, subject, expires, created in db.execute("SELECT * FROM wx_link_codes"):
            if (not re.fullmatch(r"[0-9a-f]{64}", code_hash) or subject not in web_subjects
                    or type(expires) is not int or type(created) is not int or expires < created):
                raise ValueError("Invalid account binding record")
    if "wx_profiles" in tables:
        for uid, name, mime, image, image_hash, updated in db.execute("SELECT * FROM wx_profiles"):
            if (uid not in users or type(updated) is not int or updated < 0
                    or (name is not None and (not isinstance(name, str) or not 1 <= len(name) <= 24
                        or name != name.strip() or any(unicodedata.category(c) in ("Cc", "Cf", "Cs") for c in name)))):
                raise ValueError("Invalid player profile")
            if image is None:
                if mime is not None or image_hash is not None:
                    raise ValueError("Invalid player avatar")
            elif (not isinstance(image, bytes) or not 0 < len(image) <= 256 * 1024
                    or mime not in ("image/png", "image/jpeg") or hashlib.sha256(image).hexdigest() != image_hash):
                raise ValueError("Invalid player avatar")
    rooms = {}
    for code, revision, expires, raw in db.execute("SELECT code,revision,expires,document FROM wx_rooms"):
        room = json.loads(raw)
        if not isinstance(room, dict) or not re.fullmatch(r"[A-Z2-9]{8}", code):
            raise ValueError("Invalid room record")
        if (room.get("code") != code or room.get("revision") != revision or room.get("expiresAt") != expires
                or type(revision) is not int or revision < 1 or type(expires) is not int
                or not re.fullmatch(r"[0-9a-f]{32}", room.get("matchId", ""))):
            raise ValueError("Inconsistent room metadata")
        members = room.get("players", {})
        if set(members) != {"BLACK", "WHITE"} or members["BLACK"] not in users or (members["WHITE"] is not None and members["WHITE"] not in users):
            raise ValueError("Room refers to a missing identity")
        actions, ids = room.get("actions"), room.get("actionIds")
        if (not isinstance(actions, list) or not isinstance(ids, list) or len(actions) != room.get("seq")
                or len(ids) != len(actions) or len(set(ids)) != len(ids) or len(actions) > 3000):
            raise ValueError("Inconsistent room action sequence")
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", room.get("state", {}).get("stateHash", "")):
            raise ValueError("Invalid rule-state checksum")
        rooms[code] = room
    commands = 0
    current_ids = {code: set() for code in rooms}
    for code, match_id, command_id, uid, hash_value in db.execute("SELECT * FROM wx_commands"):
        if (code not in rooms or uid not in users or uid not in rooms[code]["players"].values()
                or not re.fullmatch(r"[0-9a-f]{32}", match_id)
                or not re.fullmatch(r"[a-zA-Z0-9_-]{16,80}", command_id)
                or not re.fullmatch(r"[0-9a-f]{64}", hash_value)):
            raise ValueError("Invalid or orphaned command record")
        if match_id == rooms[code]["matchId"]:
            current_ids[code].add(command_id)
        commands += 1
    if any(current_ids[code] != set(room["actionIds"]) for code, room in rooms.items()):
        raise ValueError("Accepted action IDs do not match the idempotency records")
    return {"users": len(users), "rooms": len(rooms), "commands": commands}


def inspect_store(source):
    with closing(readonly(source)) as db:
        db.execute("BEGIN")
        counts = inspect_connection(db)
    return {"status": "PASS_SQLITE_STRUCTURE_ONLY", "counts": counts,
            "ruleReplayVerified": False}


def identity_snapshot(source):
    with closing(readonly(source)) as db:
        db.execute("BEGIN"); inspect_connection(db)
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        return {"wechat": dict(db.execute("SELECT uid,subject FROM wx_users")),
                "web": sorted(db.execute("SELECT subject,uid,display_name FROM wx_web_accounts")) if "wx_web_accounts" in tables else [],
                "profiles": sorted(db.execute("SELECT * FROM wx_profiles")) if "wx_profiles" in tables else [],
                "version": 3 if "wx_profiles" in tables else 2 if "wx_web_accounts" in tables else 1}


def copy_store(source, destination, *, expected_sha256=None, current_store=None):
    source = Path(source).resolve(strict=True)
    destination = Path(destination).resolve()
    if source == destination or destination.exists():
        raise ValueError("Destination must be a new file; existing databases are never overwritten")
    if not destination.parent.is_dir():
        raise ValueError("Create the intended destination directory first")
    if expected_sha256 is not None:
        if not re.fullmatch(r"[0-9a-f]{64}", expected_sha256) or digest(source) != expected_sha256:
            raise ValueError("Backup SHA-256 does not match the supplied receipt")
        if current_store is None:
            raise ValueError("Restore needs the latest retained database to preserve account deletions")
        current_store = Path(current_store).resolve(strict=True)
        if current_store in (source, destination):
            raise ValueError("The retained current database must be separate from the backup and destination")
        current_users = identity_snapshot(current_store)
    dropped_users, dropped_rooms = 0, 0
    with closing(readonly(source)) as incoming:
        if expected_sha256 is not None and incoming.execute("PRAGMA journal_mode").fetchone()[0].lower() != "delete":
            raise ValueError("Restore requires a standalone backup produced by this tool")
        incoming.execute("BEGIN")
        expected_counts = inspect_connection(incoming)
        # Exclusive reservation avoids races with another operator and preserves
        # all pre-existing files. Failed partial copies are retained for inspection.
        fd = os.open(destination, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.close(fd)
        deadline = time.monotonic() + 30
        def progress(_status, _remaining, _total):
            if time.monotonic() > deadline:
                raise TimeoutError("Snapshot exceeded 30 seconds; partial destination retained")
        with closing(sqlite3.connect(destination, timeout=5)) as outgoing:
            incoming.backup(outgoing, pages=128, progress=progress, sleep=0.05)
            outgoing.execute("PRAGMA journal_mode=DELETE")
            if inspect_connection(outgoing) != expected_counts:
                raise ValueError("Snapshot counts changed during copy")
            if expected_sha256 is not None:
                retained_uids = set(current_users["wechat"]) | {row[1] for row in current_users["web"]}
                backup_uids = set()
                for uid, subject in outgoing.execute("SELECT uid,subject FROM wx_users"):
                    if uid in current_users["wechat"] and current_users["wechat"][uid] != subject:
                        raise ValueError("Current identity mapping conflicts with the backup")
                    backup_uids.add(uid)
                tables = {row[0] for row in outgoing.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                if ("wx_web_accounts" in tables and current_users["version"] < 2
                        or "wx_profiles" in tables and current_users["version"] < 3):
                    raise ValueError("Current identity schema predates the backup")
                if "wx_web_accounts" in tables:
                    backup_uids.update(row[0] for row in outgoing.execute("SELECT uid FROM wx_web_accounts"))
                stale = backup_uids - retained_uids
                with outgoing:
                    for code, raw in outgoing.execute("SELECT code,document FROM wx_rooms").fetchall():
                        if stale.intersection(json.loads(raw)["players"].values()):
                            outgoing.execute("DELETE FROM wx_commands WHERE room=?", (code,))
                            outgoing.execute("DELETE FROM wx_rooms WHERE code=?", (code,)); dropped_rooms += 1
                    for uid in stale:
                        outgoing.execute("DELETE FROM wx_commands WHERE uid=?", (uid,))
                    # Restore old game state, but retain the latest identity and
                    # binding state. Otherwise a backup could resurrect a deleted
                    # account or a revoked Web -> WeChat link.
                    outgoing.execute("DELETE FROM wx_users")
                    outgoing.executemany("INSERT INTO wx_users(subject,uid) VALUES (?,?)",
                                         [(subject, uid) for uid, subject in current_users["wechat"].items()])
                    if "wx_web_accounts" in tables or current_users["version"] >= 2:
                        outgoing.execute("CREATE TABLE IF NOT EXISTS wx_web_accounts (subject TEXT PRIMARY KEY, uid TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL)")
                        outgoing.execute("CREATE TABLE IF NOT EXISTS wx_link_codes (digest TEXT PRIMARY KEY, web_subject TEXT NOT NULL, expires INTEGER NOT NULL, created INTEGER NOT NULL)")
                        outgoing.execute("DELETE FROM wx_web_accounts")
                        outgoing.executemany("INSERT INTO wx_web_accounts VALUES (?,?,?)", current_users["web"])
                        # One-time credentials must never be revived by restore.
                        outgoing.execute("DELETE FROM wx_link_codes")
                        outgoing.execute("PRAGMA user_version=2")
                    if current_users["version"] == 3:
                        outgoing.execute("CREATE TABLE IF NOT EXISTS wx_profiles (uid TEXT PRIMARY KEY, display_name TEXT, avatar_mime TEXT, avatar_blob BLOB, avatar_hash TEXT, updated INTEGER NOT NULL)")
                        outgoing.execute("DELETE FROM wx_profiles")
                        outgoing.executemany("INSERT INTO wx_profiles VALUES (?,?,?,?,?,?)", current_users["profiles"])
                        outgoing.execute("PRAGMA user_version=3")
                dropped_users = len(stale)
                expected_counts = inspect_connection(outgoing)
        if expected_sha256 is not None and digest(source) != expected_sha256:
            raise ValueError("Backup changed during restore; do not activate the destination")
        if expected_sha256 is not None and identity_snapshot(current_store) != current_users:
            raise ValueError("Current identities changed during restore; do not activate the destination")
    return {"schemaVersion": 1, "status": "PASS_RESTORED_NEW_FILE" if expected_sha256 else "PASS_STANDALONE_BACKUP",
            "sha256": digest(destination), "bytes": destination.stat().st_size, "counts": expected_counts,
            "ruleReplayVerified": False, "deletedAccountsExcluded": dropped_users, "relatedRoomsExcluded": dropped_rooms}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    operations = parser.add_subparsers(dest="operation", required=True)
    inspect = operations.add_parser("inspect"); inspect.add_argument("source", type=Path)
    for operation in ("backup", "restore"):
        command = operations.add_parser(operation)
        command.add_argument("source", type=Path); command.add_argument("destination", type=Path)
        if operation == "restore":
            command.add_argument("--sha256", required=True)
            command.add_argument("--current-store", type=Path, required=True)
    args = parser.parse_args()
    try:
        result = inspect_store(args.source) if args.operation == "inspect" else copy_store(
            args.source, args.destination, expected_sha256=getattr(args, "sha256", None), current_store=getattr(args, "current_store", None))
    except (OSError, sqlite3.Error, ValueError, TypeError, KeyError, TimeoutError) as error:
        # Structural errors and path errors only; no database row or credential output.
        print(json.dumps({"status": "FAILED_NO_ACTIVATION", "errorType": type(error).__name__}))
        raise SystemExit(1) from None
    print(json.dumps(result))


if __name__ == "__main__":
    main()
