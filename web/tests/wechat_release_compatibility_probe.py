"""Synthetic SQLite + real Node acceptance for the complete shared service.

This script uses temporary identities only. It never connects to WeChat or opens
a production database. The fixed v2 hashes were captured from uploaded 0.12.3's
validator with GameEngine SHA256 469b9c47377f47633589c29039ee849922ec525c17be859945209622586b8238.
"""
import argparse
import asyncio
import importlib.util
import json
from pathlib import Path
import tempfile


async def check(root):
    spec = importlib.util.spec_from_file_location("release_probe_api", root / "web/web后端/wechat_online.py")
    wx = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(wx)
    checks = []

    def passed(name):
        checks.append(name)

    async def rejected(call, code):
        try:
            await call
        except wx.HTTPException as error:
            assert error.detail == code, (error.detail, code)
        else:
            raise AssertionError("Expected rejection " + code)

    with tempfile.TemporaryDirectory(prefix="lifeline-release-probe-") as temporary:
        database = Path(temporary) / "synthetic.sqlite3"
        store = wx.WechatStore(database)
        svc = wx.WechatService(store, "synthetic-app", "synthetic-secret", "synthetic-jwt-secret-more-than-32-characters")
        host = store.identity("synthetic-host")
        guest = store.identity("synthetic-guest")
        old = await svc.mutate(guest, "create", {"gridSize": 7})
        assert old["settings"]["rulesVersion"] == "territory-v2"
        assert old["scores"] == {"BLACK": 0, "WHITE": 0}
        assert old["stateHash"] == "sha256:cca3a986d6026041569400551c0b677abf008e35d1475e8fb566d3a1a67c7ace"
        passed("legacy-create-default-v2-exact-uploaded-hash")

        room = await svc.mutate(host, "create", {"gridSize": 7, "rulesVersion": "territory-v3", "undoEnabled": True})
        assert room["settings"]["rulesVersion"] == "territory-v3" and room["scores"] == {"BLACK": 1, "WHITE": 1}
        passed("explicit-create-v3-open-lines-score")
        joined = await svc.mutate(guest, "join", {"code": room["code"]}, room["code"])
        assert joined["members"] == {"BLACK": True, "WHITE": True}
        assert store.room(old["code"])["status"] == "closed"
        passed("empty-own-room-atomically-released-on-join")

        async def command(uid, operation, body=None):
            nonlocal room
            room = await svc.mutate(uid, operation, {"matchId": room["matchId"], **(body or {})}, room["code"])
            return room

        await rejected(command(guest, "settings", {"settings": {"gridSize": 9}}), "SETTINGS_LOCKED")
        passed("guest-cannot-edit-settings")
        previous = store.room(room["code"])
        await rejected(command(host, "settings", {"settings": {"rulesVersion": "territory-v2"}}), "RULES_CHANGE_REQUIRES_NEW_ROOM")
        assert store.room(room["code"]) == previous
        passed("waiting-settings-cannot-convert-existing-rules")
        await command(host, "settings", {"settings": {"gridSize": 7, "undoEnabled": True}})
        assert room["settings"]["rulesVersion"] == "territory-v3"
        passed("waiting-settings-inherit-v3-when-omitted")
        await command(host, "settings", {"settings": {"gridSize": 7, "boardShape": "hexagon", "startingPointMode": "random",
                    "initialPositions": {"BLACK": [0, 6], "WHITE": [12, 6]}, "undoEnabled": True, "undoMaxCount": 2}})
        assert room["settings"]["initialPositions"] == {"BLACK": [0, 6], "WHITE": [12, 6]}
        passed("hexagon-and-frozen-random-start-settings")
        await command(host, "settings", {"settings": {"gridSize": 7, "undoEnabled": True, "undoMaxCount": 2}})
        await command(host, "ready")
        await command(host, "settings", {"settings": {"gridSize": 9, "undoEnabled": True, "undoMaxCount": 2}})
        assert room["ready"] == {"BLACK": False, "WHITE": False}
        await command(host, "settings", {"settings": {"gridSize": 7, "undoEnabled": True, "undoMaxCount": 2}})
        await command(host, "ready")
        await command(guest, "ready")
        assert room["status"] == "playing"
        passed("waiting-settings-reset-ready-and-both-players-start")

        move_body = {"expectedSeq": room["seq"], "beforeHash": room["stateHash"], "clientActionId": "release-probe-command-00001",
                     "action": {"type": "move", "point": [2, 0]}}
        await command(host, "actions", move_body)
        assert room["scores"]["BLACK"] == 3 and room["seq"] == 1
        passed("v3-server-move-scores-own-line-points")
        undo_body = {"expectedSeq": room["seq"], "beforeHash": room["stateHash"], "accept": True}
        await command(host, "undo", undo_body)
        assert room["undo"] == {"usedCount": 0, "pending": True, "votes": ["BLACK"]}
        await rejected(command(guest, "actions", {"expectedSeq": room["seq"], "beforeHash": room["stateHash"],
                       "clientActionId": "release-probe-command-00002", "action": {"type": "move", "point": [5, 0]}}), "UNDO_PENDING")
        passed("undo-first-vote-pauses-actions")
        await command(guest, "undo", undo_body)
        assert room["undo"] == {"usedCount": 1, "pending": False, "votes": []}
        assert room["seq"] == 0 and room["actions"] == [] and room["scores"] == {"BLACK": 1, "WHITE": 1}
        passed("undo-unanimous-vote-replays-authoritative-state")
        await command(host, "actions", move_body)
        assert room["seq"] == 0
        passed("acknowledged-undone-command-cannot-be-resurrected")
        move_body["clientActionId"] = "release-probe-command-00003"
        await command(host, "actions", move_body)
        undo_body = {"expectedSeq": room["seq"], "beforeHash": room["stateHash"], "accept": True}
        await command(host, "undo", undo_body)
        await command(guest, "undo", {**undo_body, "accept": False})
        assert not room["undo"]["pending"] and room["seq"] == 1 and room["undo"]["usedCount"] == 1
        passed("undo-rejection-keeps-position-and-budget")
        await command(host, "undo", undo_body)
        await command(guest, "undo", undo_body)
        await rejected(command(host, "undo", {"expectedSeq": room["seq"], "beforeHash": room["stateHash"], "accept": True}), "UNDO_UNAVAILABLE")
        passed("undo-budget-enforced")

        # Recreate an already-playing durable v2 document without new undo fields.
        left, right = store.identity("synthetic-old-left"), store.identity("synthetic-old-right")
        existing = await svc.mutate(left, "create", {"gridSize": 7})
        document = store.room(existing["code"])
        revision = document["revision"]
        document["settings"] = {"gridSize": 7, "playerCount": 2, "startPlayer": "BLACK", "rulesVersion": "territory-v2",
                                "turnTimerEnabled": False, "turnTimeLimitSeconds": 60, "hintEnabled": False, "hintMaxCount": 0}
        document.pop("undo", None)
        document["players"]["WHITE"] = right
        document["ready"] = {"BLACK": True, "WHITE": True}
        document["status"] = "playing"
        document["actions"] = [{"type": "move", "point": [1, 0], "player": "BLACK"}]
        document["actionIds"] = ["release-old-command-00001"]
        document["seq"] = 1
        document["state"] = {"stateHash": "sha256:b45b7ffb479fb377a724af34d9925d86e9801559d31bdccb27bec0be0214c1b4",
                             "currentPlayer": "WHITE", "gameOver": False, "winner": None, "scores": {"BLACK": 0, "WHITE": 0}}
        document["revision"] += 1
        store.commit(document, revision)
        restarted = wx.WechatService(wx.WechatStore(database), "synthetic-app", "synthetic-secret", "synthetic-jwt-secret-more-than-32-characters")
        result = await restarted.mutate(right, "actions", {"matchId": document["matchId"], "expectedSeq": 1,
                        "beforeHash": document["state"]["stateHash"], "clientActionId": "release-old-command-00002",
                        "action": {"type": "move", "point": [5, 0]}}, document["code"])
        assert result["stateHash"] == "sha256:21857a20f6c1fbea08fce84ee63ec885bea89b3ee4a89330da9338dabb35fd97"
        assert result["settings"]["rulesVersion"] == "territory-v2"
        passed("persisted-v2-room-survives-new-service-and-next-move-exact-hash")
        assert wx.WechatStore(database).room(document["code"])["seq"] == 2
        passed("sqlite-restart-preserves-acknowledged-moves")

        # A terminal action is still undoable by mutual consent, matching both
        # clients' result-screen controls; accepted termination never rewrites history.
        final_host, final_guest = store.identity("synthetic-final-host"), store.identity("synthetic-final-guest")
        terminal = await svc.mutate(final_host, "create", {"gridSize": 7, "rulesVersion": "territory-v3", "undoEnabled": True})
        terminal = await svc.mutate(final_guest, "join", {"code": terminal["code"]}, terminal["code"])
        for uid in (final_host, final_guest):
            terminal = await svc.mutate(uid, "ready", {"matchId": terminal["matchId"]}, terminal["code"])
        terminal = await svc.mutate(final_host, "actions", {"matchId": terminal["matchId"], "expectedSeq": 0,
                        "beforeHash": terminal["stateHash"], "clientActionId": "release-final-command-00001",
                        "action": {"type": "resign"}}, terminal["code"])
        assert terminal["status"] == "finished" and terminal["gameOver"]
        vote = {"matchId": terminal["matchId"], "expectedSeq": terminal["seq"], "beforeHash": terminal["stateHash"], "accept": True}
        for uid in (final_host, final_guest):
            terminal = await svc.mutate(uid, "undo", vote, terminal["code"])
        assert terminal["status"] == "playing" and not terminal["gameOver"] and terminal["seq"] == 0
        passed("terminal-undo-mutual-consent-restores-nonterminal-rule-state")

        fresh = store.identity("synthetic-settings-outsider")
        await rejected(svc.mutate(fresh, "create", {"gridSize": 7, "rulesVersion": "territory-v4"}), "INVALID_SETTINGS")
        await rejected(svc.mutate(fresh, "create", {"gridSize": 7, "playerCount": 7}), "INVALID_SETTINGS")
        await rejected(svc.mutate(fresh, "create", {"gridSize": 7, "turnTimerEnabled": 1}), "INVALID_SETTINGS")
        passed("unsupported-rules-player-count-and-malformed-timer-rejected")
        mixed = await svc.mutate(fresh, "create", {"gridSize": 7, "playerCount": 3, "turnTimerEnabled": True})
        assert mixed["settings"]["playerCount"] == 3 and mixed["settings"]["turnTimerEnabled"]
        assert set(mixed["scores"]) == {"BLACK", "WHITE", "PURPLE"}
        passed("three-player-room-and-authoritative-timer-config-accepted")

    return {"status": "PASS_SERVICE_RELEASE_COMPATIBILITY", "checks": checks, "count": len(checks),
            "networkUsed": False, "database": "temporary-synthetic-only", "verifier": "real-node"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--service-root", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(asyncio.run(check(args.service_root.resolve())), sort_keys=True))
