"""Probe copied production structure and synthetic replays, never live writes."""
import argparse
import importlib.util
import json
from pathlib import Path
import shutil
import sqlite3


def signatures(path):
    with sqlite3.connect(path) as db:
        assert db.execute("PRAGMA quick_check").fetchall() == [("ok",)]
        names = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        result = {}
        for table in ("inbox", "inbox_v2", "inbox_v3"):
            if table not in names:
                continue
            # Inspect only schema/counts in the private copy. Real replay
            # contents and identifiers are never selected or exported.
            count = db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            schema = db.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone()[0]
            result[table] = (count, schema)
        return result


def verify(service_root, fixtures, data, node, version):
    spec = importlib.util.spec_from_file_location("collector_candidate", service_root / "web/backend/training_contributions.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    migration = data / "migration"
    migration.mkdir()
    copy = migration / "contributions.sqlite3"
    shutil.copyfile(data / "migration.sqlite3", copy)
    before = signatures(copy)
    module.ContributionStore(migration, node=node)
    after = signatures(copy)
    assert all(after.get(name) == value for name, value in before.items()), "Existing schema/counts changed"
    assert {"inbox", "inbox_v2"}.issubset(after)
    if version == 3:
        assert "inbox_v3" in after
    store = module.ContributionStore(data / "synthetic", node=node)
    for v in range(1, version + 1):
        payload = json.loads((fixtures / f"v{v}.json").read_text(encoding="utf-8"))
        assert store.accept(payload)["status"] == "awaiting_review"
        assert store.accept(payload)["status"] == "duplicate"
        payload["consent"] = False
        try:
            store.accept(payload)
        except ValueError:
            pass
        else:
            raise AssertionError("Missing consent accepted")
    return {"status": "PASS_COLLECTOR_MIGRATION_AND_FIXTURES", "versions": list(range(1, version + 1)),
            "existingSchemaAndCountsPreserved": True, "realRowsCompared": False,
            "sqliteIntegrity": True, "productionDatabaseWritten": False,
            "scope": "copied SQLite and isolated synthetic submissions; no public submissions"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("service-root", "fixtures", "data"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--node", required=True)
    parser.add_argument("--version", type=int, choices=(2, 3), required=True)
    args = parser.parse_args()
    print(json.dumps(verify(args.service_root, args.fixtures, args.data, args.node, args.version)))
