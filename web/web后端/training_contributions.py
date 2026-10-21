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
THREE_PLAYER_MODEL_ID = "three-player-policy-v1"
THREE_PLAYER_MODEL_IDS = frozenset({THREE_PLAYER_MODEL_ID, "three-player-policy-v2"})
MAX_REQUEST_BYTES = 512000
VALIDATOR = Path(__file__).resolve().parents[1] / "tools/validate_contribution.mjs"

def normalize_context(context):
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
    @contextmanager
    def connect(self):
        connection = sqlite3.connect(self.database, timeout=10)
        try:
            with connection: yield connection
        finally: connection.close()
    def accept(self, payload):
        if not isinstance(payload, dict) or set(payload) != {"format", "version", "consent", "consent_policy", "replay", "context"}:
            raise ValueError("Unexpected contribution fields")
        context = normalize_context(payload["context"])
        raw = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode()
        if len(raw) > MAX_REQUEST_BYTES: raise ValueError("Payload too large")
        process = subprocess.run([self.node, str(VALIDATOR)], input=raw, capture_output=True, timeout=20, check=False)
        if process.returncode: raise ValueError("Replay validation failed")
        verified = json.loads(process.stdout)
        game_id = verified["game_id"]
        expected_colors = {"BLACK", "WHITE", *(["PURPLE"] if verified["replay"]["config"]["playerCount"] == 3 else [])}
        if set(context["actors"]) != expected_colors: raise ValueError("Actor/config mismatch")
        if any(actor.get("strategy") == "three-player" for actor in context["actors"].values()):
            if verified["replay"]["config"]["playerCount"] != 3 or verified["replay"]["rulesVersion"] != "territory-v2":
                raise ValueError("Three-player AI requires a territory-v2 three-player replay")
        document = json.dumps({**verified, "context": context, "consent_policy": POLICY, "status": "awaiting_review"}, ensure_ascii=False, allow_nan=False)
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if db.execute("SELECT 1 FROM inbox WHERE game_id=?", (game_id,)).fetchone():
                return {"game_id": game_id, "status": "duplicate"}
            size = db.execute("SELECT COALESCE(SUM(length(CAST(document AS BLOB))),0) FROM inbox").fetchone()[0]
            if size + len(document.encode()) > self.maximum_bytes: raise OverflowError("Inbox full")
            db.execute("INSERT INTO inbox VALUES (?,?,?)", (game_id, document, int(time.time())))
        return {"game_id": game_id, "status": "awaiting_review"}
    def export(self, output):
        target = Path(output); target.mkdir(parents=True, exist_ok=False)
        with self.connect() as db:
            rows = db.execute("SELECT game_id,document FROM inbox ORDER BY game_id").fetchall()
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
    async def status(): return {"enabled": store is not None or bool(os.environ.get("LIFELINE_CONTRIBUTIONS_DIR")), "consent_policy": POLICY}
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
    args = parser.parse_args(); print(json.dumps({"exported_games": ContributionStore(args.inbox).export(args.export)}))
