"""Offline synthetic Mini contribution -> real collector acceptance and dedup.

No HTTP, credentials, account stores, production paths, or training are used.
The synthetic trajectory and isolated SQLite inbox remain under local_artifacts.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[3]
COLLECTOR = ROOT / "web/web后端/training_contributions.py"
SOURCES = (
    "wechat/minigame/src/training-contribution.js",
    "wechat/minigame/src/contribution-transport.js",
    "wechat/minigame/src/integrity.js",
    "wechat/minigame/src/model-catalog.js",
    "wechat/minigame/tests/contribution-collector-check.py",
    "web/web前端/GameEngine.js",
    "web/web前端/ReplayCodec.js",
    "web/web前端/ResearchAI.js",
    "web/tools/validate_contribution.mjs",
    "web/tools/training_contribution_schema.mjs",
    "web/web后端/training_contributions.py",
)
GENERATOR = r"""
import assert from 'node:assert/strict';
import { TrainingContribution, contributionContext } from './wechat/minigame/src/training-contribution.js';
import { checksum } from './wechat/minigame/src/integrity.js';
import GameEngine from './web/web前端/GameEngine.js';
import { createReplayDocument } from './web/web前端/ReplayCodec.js';
const settings = { rulesVersion: 'territory-v2', gridSize: 5, playerCount: 2, startPlayer: 'BLACK',
  hintEnabled: true, hintMaxCount: 3, turnTimerEnabled: true, turnTimeLimitSeconds: 30 };
const context = contributionContext({ settings, hintsUsed: 1,
  controllerFor: color => color === 'BLACK' ? 'human' : 'minimax-2' });
const engine = new GameEngine(settings), actions = [];
for (let turn = 0; turn < 8 && !engine.gameOver; turn++) {
  const point = engine.getLegalMoves(engine.currentPlayer)[0]?.point;
  assert.ok(point);
  const action = { type: 'move', player: engine.currentPlayer, point: [...point] };
  assert.equal(engine.playMove(point).success, true); actions.push(action);
}
while (!engine.gameOver) {
  const action = { type: 'skip', player: engine.currentPlayer };
  assert.equal(engine.skipTurn().success, true); actions.push(action);
  assert.ok(actions.length <= 12);
}
const saved = new Map(); let payload;
const client = new TrainingContribution({
  storage: { get: key => saved.get(key), set: (key, value) => saved.set(key, value) },
  origin: 'https://synthetic.invalid', createReplay: (config, list) => createReplayDocument(config, list, checksum),
  request: ({ url, data, method }) => {
    if (method === 'GET') return { promise: Promise.resolve({ status: 200, data: { enabled: true,
      supported_versions: [1, 2], consent_policies: { 2: 'anonymous-replay-training-v2' } } }), abort() {} };
    assert.equal(url, 'https://synthetic.invalid/api/training/contributions');
    payload = data;
    return { promise: Promise.resolve({ status: 503, data: {} }), abort() {} };
  },
});
assert.equal(client.enabled, false);
client.setEnabled(true);
const ticket = client.beginMatch({ settings, context, source: 'local', actionCount: 0 });
assert.ok(ticket);
assert.equal(await client.completeMatch(ticket, { settings, context, actions, source: 'local' }), true);
await client.flush();
assert.ok(payload?.replay?.terminal);
assert.equal(client.queue.length, 1);
process.stdout.write(JSON.stringify(payload));
"""


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def hashes() -> dict[str, str]:
    return {name: digest(ROOT / name) for name in SOURCES}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifacts", type=Path, default=ROOT / "local_artifacts/wechat-contribution-20261021")
    args = parser.parse_args()
    allowed = (ROOT / "local_artifacts").resolve()
    artifact_root = args.artifacts.resolve()
    if not artifact_root.is_relative_to(allowed):
        raise ValueError("Artifacts must remain under this checkout's local_artifacts")
    artifact_root.mkdir(parents=True, exist_ok=True)
    run_dir = Path(tempfile.mkdtemp(prefix="collector-check-", dir=artifact_root))
    (run_dir / "SYNTHETIC-ONLY.txt").write_text(
        "Engineering fixture only. These actions are synthetic, not human evidence.\n"
        "Do not use this SQLite inbox or payload for model training or production.\n", encoding="utf-8")
    node = shutil.which("node")
    if not node:
        raise RuntimeError("Node is required")
    before = hashes()
    receipt = {
        "status": "FAIL", "scope": "LOCAL_SYNTHETIC_MINI_PAYLOAD_AND_PYTHON_COLLECTOR",
        "timestamp": datetime.now(timezone.utc).isoformat(), "realNetworkUsed": False,
        "productionModified": False, "humanTrainingEvidence": False, "trainingRun": False,
        "command": [sys.executable, "-B", str(Path(__file__).resolve()), "--artifacts", str(artifact_root)],
        "runDirectory": str(run_dir), "sourceHashesBefore": before,
    }
    try:
        (run_dir / "generator.mjs.txt").write_text(GENERATOR, encoding="utf-8")
        generated = subprocess.run([node, "--input-type=module", "--unhandled-rejections=strict"],
                                   cwd=ROOT, input=GENERATOR, capture_output=True,
                                   encoding="utf-8", timeout=45, check=False)
        (run_dir / "generator.stderr.txt").write_text(generated.stderr, encoding="utf-8")
        if generated.returncode:
            raise RuntimeError(f"Synthetic Mini generator exited {generated.returncode}")
        payload_path = run_dir / "synthetic-payload.json"
        payload_path.write_text(generated.stdout, encoding="utf-8")
        payload = json.loads(generated.stdout)
        spec = importlib.util.spec_from_file_location("isolated_contribution_collector_check", COLLECTOR)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        assert payload["version"] == 2 and payload["consent_policy"] == "anonymous-replay-training-v2"
        assert set(payload) == {"format", "version", "consent", "consent_policy", "replay", "context"}
        assert payload["consent"] is True and payload["context"]["source"] == "local"
        assert payload["context"]["actors"] == {"BLACK": {"kind": "human"}, "WHITE": {"kind": "ai", "profile": "minimax-2"}}
        assert payload["context"]["hintsEnabled"] is True
        assert payload["replay"]["config"]["turnTimerEnabled"] is True
        assert payload["replay"]["config"]["turnTimeLimitSeconds"] == 30
        store = module.ContributionStore(run_dir / "synthetic-inbox", node=node)
        first = store.accept(payload)
        second = module.ContributionStore(run_dir / "synthetic-inbox", node=node).accept(payload)
        assert first["status"] == "awaiting_review" and second["status"] == "duplicate"
        assert first["game_id"] == second["game_id"] and re.fullmatch(r"[a-f0-9]{64}", first["game_id"])
        with store.connect() as connection:
            rows = connection.execute("SELECT game_id,document FROM inbox_v2").fetchall()
        assert len(rows) == 1
        record = json.loads(rows[0][1])
        assert set(record) == {"game_id", "replay", "engine_sources", "protocol_version", "context", "consent_policy", "status"}
        assert record["protocol_version"] == 2
        assert record["context"] == payload["context"] and record["replay"] == payload["replay"]
        receipt.update({"status": "PASS_LOCAL_COLLECTOR_ACCEPTANCE_AND_RESTART_DEDUP",
                        "firstReceipt": first, "repeatReceipt": second, "storedRows": len(rows),
                        "contextValidated": True, "storedReplayUnchanged": True,
                        "storedFields": sorted(record), "payloadBytes": payload_path.stat().st_size,
                        "payloadSha256": digest(payload_path), "actions": len(payload["replay"]["actions"]),
                        "documentHash": payload["replay"]["integrity"]["canonicalDocumentHash"],
                        "identityFieldsAbsent": True})
    except Exception as error:
        receipt["error"] = f"{type(error).__name__}: {error}"
    finally:
        receipt["sourceHashesAfter"] = hashes()
        receipt["sourceFilesUnchangedDuringVerification"] = before == receipt["sourceHashesAfter"]
        if not receipt["sourceFilesUnchangedDuringVerification"]:
            receipt["status"] = "STALE_SOURCE_CHANGED_DURING_VERIFICATION"
        receipt_path = run_dir / "receipt.json"
        receipt_path.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"status": receipt["status"], "receipt": str(receipt_path),
                          "storedRows": receipt.get("storedRows"), "error": receipt.get("error")}, ensure_ascii=False))
    return 0 if receipt["status"] == "PASS_LOCAL_COLLECTOR_ACCEPTANCE_AND_RESTART_DEDUP" else 1


if __name__ == "__main__":
    raise SystemExit(main())
