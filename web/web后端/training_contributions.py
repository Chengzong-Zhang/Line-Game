"""Opt-in, bounded, quarantined replay inbox. Never changes live models."""
from __future__ import annotations
import argparse
import asyncio
from contextlib import contextmanager
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import threading
import time
from fastapi import APIRouter, HTTPException, Request

POLICY = "anonymous-replay-training-v1"
POLICIES = {1: POLICY, 2: "anonymous-replay-training-v2", 3: "anonymous-replay-training-v3"}
SUPPORTED_RULES_VERSIONS = {2: ["territory-v2"], 3: ["territory-v3"]}
COLORS = ("BLACK", "WHITE", "PURPLE", "GREEN", "ORANGE", "CYAN")
V3_COLORS = COLORS + ("PINK", "BROWN", "LIME", "NAVY", "GOLD", "TEAL", "MAGENTA", "SLATE", "CORAL")
THREE_PLAYER_MODEL_ID = "three-player-policy-v1"
THREE_PLAYER_MODEL_IDS = frozenset({THREE_PLAYER_MODEL_ID, "three-player-policy-v2", "three-player-search-v4-round12"})
MAX_REQUEST_BYTES = 512000
VALIDATOR = Path(__file__).resolve().parents[1] / "tools/validate_contribution.mjs"

def normalize_context(context, version=1):
    if version == 3:
        if not isinstance(context, dict) or set(context) != {"source", "actors", "mixedProfiles", "hintsEnabled", "undo"}:
            raise ValueError("Unexpected v3 context fields")
        if context["source"] != "local" or type(context["mixedProfiles"]) is not bool or type(context["hintsEnabled"]) is not bool:
            raise ValueError("Invalid v3 context")
        actors = context["actors"]
        if not isinstance(actors, dict) or len(actors) not in range(2, 16) or set(actors) != set(V3_COLORS[:len(actors)]):
            raise ValueError("Invalid v3 actors")
        for actor in actors.values():
            if not isinstance(actor, dict): raise ValueError("Invalid v3 actor")
            if actor.get("kind") == "human" and set(actor) == {"kind"}: continue
            if actor.get("kind") != "ai" or set(actor) != {"kind", "profile"} or not isinstance(actor.get("profile"), str) \
                or not re.fullmatch(r"[a-zA-Z0-9_.:-]{1,96}", actor["profile"]):
                raise ValueError("Invalid v3 AI profile")
        undo = context["undo"]
        if not isinstance(undo, dict) or set(undo) != {"enabled", "maxCount", "usedCount"} \
            or type(undo["enabled"]) is not bool or type(undo["maxCount"]) is not int or not 1 <= undo["maxCount"] <= 10 \
            or type(undo["usedCount"]) is not int or not 0 <= undo["usedCount"] <= undo["maxCount"] \
            or (not undo["enabled"] and undo["usedCount"] != 0):
            raise ValueError("Invalid v3 undo declaration")
        return context
    if version == 2:
        if not isinstance(context, dict) or set(context) != {"source", "actors", "mixedProfiles", "hintsEnabled", "undo"}:
            raise ValueError("Unexpected v2 context fields")
        if context["source"] != "local" or type(context["mixedProfiles"]) is not bool or type(context["hintsEnabled"]) is not bool:
            raise ValueError("Invalid v2 context")
        actors = context["actors"]
        if not isinstance(actors, dict) or len(actors) not in range(2, 7) or set(actors) != set(COLORS[:len(actors)]):
            raise ValueError("Invalid v2 actors")
        for actor in actors.values():
            if not isinstance(actor, dict): raise ValueError("Invalid v2 actor")
            if actor.get("kind") == "human" and set(actor) == {"kind"}: continue
            # Exact profile/count/shape/size compatibility is checked by the
            # shared JavaScript schema after this privacy and size boundary.
            if actor.get("kind") != "ai" or set(actor) != {"kind", "profile"} or not isinstance(actor.get("profile"), str) \
                or not re.fullmatch(r"[a-zA-Z0-9_.:-]{1,96}", actor["profile"]):
                raise ValueError("Invalid v2 AI profile")
        undo = context["undo"]
        if not isinstance(undo, dict) or set(undo) != {"enabled", "maxCount", "usedCount"} \
            or type(undo["enabled"]) is not bool or type(undo["maxCount"]) is not int or not 1 <= undo["maxCount"] <= 10 \
            or type(undo["usedCount"]) is not int or not 0 <= undo["usedCount"] <= undo["maxCount"] \
            or (not undo["enabled"] and undo["usedCount"] != 0):
            raise ValueError("Invalid v2 undo declaration")
        return context
    if not isinstance(context, dict) or set(context) != {"source", "actors", "mixedProfiles", "hintsEnabled"}:
        raise ValueError("Unexpected context fields")
    if context["source"] != "local" or type(context["mixedProfiles"]) is not bool or type(context["hintsEnabled"]) is not bool:
        raise ValueError("Invalid context")
    actors = context["actors"]
    if not isinstance(actors, dict) or set(actors) not in ({"BLACK", "WHITE"}, {"BLACK", "WHITE", "PURPLE"}):
        raise ValueError("Invalid actors")
    for actor in actors.values():
        if not isinstance(actor, dict) or actor.get("kind") not in ("human", "ai"):
            raise ValueError("Invalid actor")
        if set(actor) - {"kind", "strategy", "modelId", "seed", "simulations", "cPuct", "depth"}:
            raise ValueError("Unexpected actor fields")
        if actor["kind"] == "human" and set(actor) != {"kind"}:
            raise ValueError("Human actor must have no identifiers")
        if actor["kind"] == "ai" and actor.get("strategy") not in {"minimax", "mcts", "neural-puct", "model-free", "three-player"}:
            raise ValueError("Unknown AI strategy")
        if actor.get("strategy") == "three-player":
            if set(actors) != {"BLACK", "WHITE", "PURPLE"} or actor.get("modelId") not in THREE_PLAYER_MODEL_IDS:
                raise ValueError("Invalid three-player AI identity")
        elif actor.get("modelId") in THREE_PLAYER_MODEL_IDS:
            raise ValueError("Three-player model requires its matching strategy")
        for key, value in actor.items():
            if key in ("kind", "strategy", "modelId"):
                if not isinstance(value, str) or not re.fullmatch(r"[a-zA-Z0-9_.-]{1,96}", value):
                    raise ValueError("Invalid actor label")
            elif type(value) not in (int, float) or not 0 <= value <= 10**10:
                raise ValueError("Invalid actor number")
    return context

class ContributionStore:
    def __init__(self, directory, *, node="node", maximum_bytes=256 * 1024**2):
        self.directory = Path(directory).resolve(); self.node = node; self.maximum_bytes = maximum_bytes
        self.directory.mkdir(parents=True, exist_ok=True)
        self.database = self.directory / "contributions.sqlite3"
        with self.connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("CREATE TABLE IF NOT EXISTS inbox (game_id TEXT PRIMARY KEY, document TEXT NOT NULL, received_at INTEGER NOT NULL)")
            # Modern protocols stay out of the legacy default curation/export path.
            db.execute("CREATE TABLE IF NOT EXISTS inbox_v2 (game_id TEXT PRIMARY KEY, document TEXT NOT NULL, received_at INTEGER NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS inbox_v3 (game_id TEXT PRIMARY KEY, document TEXT NOT NULL, received_at INTEGER NOT NULL)")
    @contextmanager
    def connect(self):
        connection = sqlite3.connect(self.database, timeout=10)
        try:
            with connection: yield connection
        finally: connection.close()
    def accept(self, payload):
        if not isinstance(payload, dict) or set(payload) != {"format", "version", "consent", "consent_policy", "replay", "context"}:
            raise ValueError("Unexpected contribution fields")
        version = payload["version"]
        if type(version) is not int or version not in POLICIES or payload["format"] != "lifeline-training-contribution" \
            or payload["consent"] is not True or payload["consent_policy"] != POLICIES[version]:
            raise ValueError("Contribution consent/schema required")
        context = normalize_context(payload["context"], version)
        raw = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode()
        if len(raw) > MAX_REQUEST_BYTES: raise ValueError("Payload too large")
        process = subprocess.run([self.node, str(VALIDATOR)], input=raw, capture_output=True, timeout=20, check=False)
        if process.returncode: raise ValueError("Replay validation failed")
        verified = json.loads(process.stdout)
        game_id = verified["game_id"]
        colors = V3_COLORS if version == 3 else COLORS
        expected_colors = set(colors[:verified["replay"]["config"]["playerCount"]])
        if set(context["actors"]) != expected_colors: raise ValueError("Actor/config mismatch")
        if version == 1 and any(actor.get("strategy") == "three-player" for actor in context["actors"].values()):
            if verified["replay"]["config"]["playerCount"] != 3 or verified["replay"]["rulesVersion"] != "territory-v2":
                raise ValueError("Three-player AI requires a territory-v2 three-player replay")
        if version in (2, 3) and (verified.get("protocol_version") != version or verified.get("context") != context):
            raise ValueError(f"V{version} context verification mismatch")
        document = json.dumps({**verified, "context": context, "consent_policy": POLICIES[version], "status": "awaiting_review"}, ensure_ascii=False, allow_nan=False)
        table = {1: "inbox", 2: "inbox_v2", 3: "inbox_v3"}[version]
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            existing = db.execute(f"SELECT document FROM {table} WHERE game_id=?", (game_id,)).fetchone()
            if existing:
                # Actor/undo declarations are outside the gameplay ID but remain
                # material provenance; never mask a conflict as a duplicate.
                if version in (2, 3) and json.loads(existing[0])["context"] != context:
                    raise ValueError("Conflicting gameplay metadata")
                return {"game_id": game_id, "status": "duplicate"}
            size = sum(db.execute(f"SELECT COALESCE(SUM(length(CAST(document AS BLOB))),0) FROM {name}").fetchone()[0]
                       for name in ("inbox", "inbox_v2", "inbox_v3"))
            if size + len(document.encode()) > self.maximum_bytes: raise OverflowError("Inbox full")
            db.execute(f"INSERT INTO {table} VALUES (?,?,?)", (game_id, document, int(time.time())))
        return {"game_id": game_id, "status": "awaiting_review"}
    def export(self, output, *, version=1):
        if type(version) is not int or version not in POLICIES: raise ValueError("Invalid export version")
        table = {1: "inbox", 2: "inbox_v2", 3: "inbox_v3"}[version]
        target = Path(output); target.mkdir(parents=True, exist_ok=False)
        with self.connect() as db:
            rows = db.execute(f"SELECT game_id,document FROM {table} ORDER BY game_id").fetchall()
        for game_id, document in rows:
            (target / f"{game_id}.json").write_text(document, encoding="utf-8")
        return len(rows)

def create_router(store=None):
    router = APIRouter(prefix="/api/training")
    gate = asyncio.Semaphore(2)
    rate_lock = threading.Lock(); arrivals = []
    def get_store():
        nonlocal store
        if store is None:
            directory = os.environ.get("LIFELINE_CONTRIBUTIONS_DIR")
            if not directory: raise HTTPException(503, "Collection not enabled")
            store = ContributionStore(directory, node=os.environ.get("LIFELINE_NODE", "node"))
        return store
    @router.get("/contributions/status")
    async def status(): return {"enabled": store is not None or bool(os.environ.get("LIFELINE_CONTRIBUTIONS_DIR")),
        "consent_policy": POLICY, "supported_versions": [1, 2, 3], "consent_policies": POLICIES,
        "supported_rules_versions": SUPPORTED_RULES_VERSIONS,
        "max_request_bytes": MAX_REQUEST_BYTES, "max_actions": {1: 512, 2: 3000, 3: 3000},
        "destination": "awaiting_review"}
    @router.post("/contributions")
    async def contribute(request: Request):
        inbox = get_store()
        origin = request.headers.get("origin")
        if origin and origin.rstrip("/") != str(request.base_url).rstrip("/"):
            raise HTTPException(403, "Same-origin contribution required")
        if request.headers.get("content-type", "").split(";")[0] != "application/json": raise HTTPException(415, "JSON required")
        chunks = bytearray()
        async for part in request.stream():
            chunks.extend(part)
            if len(chunks) > MAX_REQUEST_BYTES: raise HTTPException(413, "Payload too large")
        with rate_lock:
            now = time.monotonic(); arrivals[:] = [t for t in arrivals if now - t < 60]
            if len(arrivals) >= 12: raise HTTPException(429, "Contribution rate limit reached", headers={"Retry-After": "60"})
            arrivals.append(now)
        if gate.locked(): raise HTTPException(429, "Contribution validator busy", headers={"Retry-After": "10"})
        try:
            payload = json.loads(chunks)
            async with gate:
                return await asyncio.to_thread(inbox.accept, payload)
        except (ValueError, KeyError, TypeError, json.JSONDecodeError): raise HTTPException(422, "Invalid replay contribution")
        except (OverflowError, subprocess.TimeoutExpired): raise HTTPException(503, "Contribution inbox busy or full")
    return router

if __name__ == "__main__":
    parser = argparse.ArgumentParser(); parser.add_argument("--inbox", required=True); parser.add_argument("--export", required=True)
    parser.add_argument("--version", type=int, choices=(1, 2, 3), default=1)
    args = parser.parse_args(); print(json.dumps({"exported_games": ContributionStore(args.inbox).export(args.export, version=args.version)}))
