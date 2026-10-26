"""Conservative ranking and authoritative configured/multiplayer AI challenges."""
import importlib.util
import json
import secrets
import sqlite3
import time

import pytest

from test_wechat_ladder import env, get_board, header, ladder, post, room_fixture, wx, ROOT


PLAYERS = ["BLACK", "WHITE", "PURPLE", "GREEN", "ORANGE", "CYAN"]


def setup(count=3, shape="hexagon", mode="random", human="BLACK", profile="greedy"):
    return {"settings": {"gridSize": 5, "playerCount": count, "boardShape": shape,
            "startPlayer": "BLACK", "startingPointMode": mode, "rulesVersion": "territory-v3"},
            "controllers": {p: "human" if p == human else profile for p in PLAYERS[:count]}}


def act(env, room, action, name="configured-action"):
    return post(env, f"rooms/{room['code']}/actions", {"matchId": room["matchId"], "expectedSeq": room["seq"],
        "beforeHash": room["stateHash"], "clientActionId": name + secrets.token_hex(8), "action": action})


def maintenance():
    spec = importlib.util.spec_from_file_location("v3_maintenance", ROOT / "wechat/tools/maintain_store.py")
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


def test_first_match_ranks_provisional_player_below_established_equal_skill(env):
    _, service, sessions = env
    a, b, veteran = [s["account"]["uid"] for s in sessions]
    with service.store.connect() as db:
        s = ladder.empty(veteran, "human")
        s.update(rating=1500, deviation=60, updated=int(time.time()), games=30, rated_games=30)
        ladder.save(db, s)
        ladder.settle(db, room_fixture((a, b)))
    board = get_board(env)
    assert board["me"]["rank"] == 2 and board["me"]["provisional"]
    assert board["me"]["rating"] > 1500 and board["me"]["points"] < 1380
    assert len(board["entries"]) == 3
    assert get_board(env, who=1)["me"]["rank"] == 3


@pytest.mark.parametrize("count,shape,profile", [
    (2, "hexagon", "greedy"), (3, "triangle", "three-player-policy-v1"),
    (4, "hexagon", "multiplayer-easy-v1"), (5, "hexagon", "hex-player-policy-v1"),
    (6, "triangle", "greedy"),
])
def test_random_configured_ai_all_seat_counts_reply_and_settle_once(env, count, shape, profile):
    request = setup(count, shape, profile=profile)
    room = post(env, "ranked-ai", request)
    assert len(room["members"]) == count
    assert room["settings"]["startingPointMode"] == "random"
    assert len(room["settings"]["initialPositions"]) == count
    positions = room["settings"]["initialPositions"]
    response = env[0].get(f"/api/wechat/rooms/{room['code']}", headers=header(env[2][0]))
    assert response.json()["settings"]["initialPositions"] == positions
    room = act(env, room, {"type": "skip"})
    assert room["seq"] >= 2 and any(a["player"] != "BLACK" for a in room["actions"])
    for _ in range(30):
        if room["gameOver"] or room["currentPlayer"] == "BLACK":
            break
        room = post(env, f"rooms/{room['code']}/advance-ai", {"matchId": room["matchId"]})
    else:
        pytest.fail("AI turns did not return to the human or finish within 30 batches")
    if not room["gameOver"]:
        room = act(env, room, {"type": "resign"})
    assert room["ladderResult"]["rated"]
    own = get_board(env, "ai")["me"]
    assert (own["games"], own["ratedGames"], own["rank"]) == (1, 1, 1)
    assert len(get_board(env, "ai")["aiOpponents"]) == count - 1
    with env[1].store.connect() as db:
        before = ladder.stats(db, env[2][0]["account"]["uid"], "ai")
        ladder.settle(db, env[1].store.room(room["code"]))
        assert ladder.stats(db, before["uid"], "ai") == before
    assert maintenance().inspect_store(env[1].store.database)["status"] == "PASS_SQLITE_STRUCTURE_ONLY"


def test_nonblack_human_server_opening_and_resigned_multiplayer_finish(env):
    room = post(env, "ranked-ai", setup(3, "hexagon", "default", human="PURPLE"))
    assert room["player"] == "PURPLE" and room["seq"] == 2 and room["currentPlayer"] == "PURPLE"
    room = act(env, room, {"type": "resign"})
    assert room["rankedForfeit"] and room["status"] == "finished"
    assert not room["gameOver"], "Do not fabricate an engine winner for remaining AI"
    assert room["ladderResult"]["players"]["PURPLE"]["ratedGames"] == 1
    assert maintenance().inspect_store(env[1].store.database)["status"] == "PASS_SQLITE_STRUCTURE_ONLY"


def test_random_rematch_resamples_but_retains_context_and_custom_layouts_separate(env):
    room = post(env, "ranked-ai", setup())
    key = env[1].store.room(room["code"])["rankedContext"]["key"]
    roots = room["settings"]["initialPositions"]
    room = act(env, room, {"type": "resign"})
    rematch = post(env, f"rooms/{room['code']}/rematch", {"matchId": room["matchId"]})
    assert rematch["matchId"] != room["matchId"]
    assert env[1].store.room(room["code"])["rankedContext"]["key"] == key
    # The protocol resamples, but two random draws may legitimately coincide.
    assert len(rematch["settings"]["initialPositions"]) == 3
    request = setup(mode="custom"); request["settings"]["initialPositions"] = roots
    first = wx.verify_rules({}, [], ranked_setup=request)
    second = wx.verify_rules({}, [], ranked_setup={**request, "settings": {**request["settings"], "initialPositions": dict(reversed(list(roots.items())))}})
    assert first["context"]["key"] == second["context"]["key"] != key
    swapped = dict(roots); swapped["BLACK"], swapped["WHITE"] = swapped["WHITE"], swapped["BLACK"]
    third = wx.verify_rules({}, [], ranked_setup={**request, "settings": {**request["settings"], "initialPositions": swapped}})
    assert third["context"]["key"] != first["context"]["key"]


def test_multiplayer_information_is_normalized():
    s = ladder.empty("human", "ai"); s.update(deviation=90)
    opponent = ladder.empty("ai:test", "ai"); opponent.update(deviation=60)
    one, five = dict(s), dict(s)
    ladder.update_evidence(one, [ladder.evidence(opponent, 1, 100)], 100)
    ladder.update_evidence(five, [ladder.evidence(opponent, 1, 100, 1/5) for _ in range(5)], 100)
    assert one["rating"] == pytest.approx(five["rating"])
    assert one["deviation"] == pytest.approx(five["deviation"])
    assert one["rated_games"] == five["rated_games"] == 1


@pytest.mark.parametrize("scores,resigned,expected", [
    ({"BLACK": 8, "WHITE": 8, "PURPLE": 10}, [], [.5, 0]),
    ({"BLACK": 8, "WHITE": 10, "PURPLE": 7}, ["WHITE"], [1, 1]),
    ({"BLACK": 8, "WHITE": 1, "PURPLE": 1}, ["BLACK"], [0, 0]),
])
def test_multiplayer_settlement_compares_official_scores_and_resignations(env, scores, resigned, expected):
    public = post(env, "ranked-ai", setup())
    room = env[1].store.room(public["code"])
    # Settlement receives authoritative engine output, never client scores.
    room["state"].update(gameOver=True, scores=scores, resigned=resigned)
    room["actions"] = [{"type": "move", "player": "BLACK"}]
    with env[1].store.connect() as db:
        ladder.settle(db, room)
        observations = json.loads(db.execute("SELECT opponents FROM wx_skill_evidence").fetchone()[0])
        opponents = [p for p in room["players"] if p != "BLACK"]
        assert dict(zip(opponents, [o["outcome"] for o in observations])) == dict(zip(["WHITE", "PURPLE"], expected))
        assert [o["weight"] for o in observations] == [.5, .5]
        assert room["ladderResult"]["players"]["BLACK"]["ratedGames"] == 1


def test_schema5_estimates_survive_and_backup_merge_delete_keep_evidence(env, tmp_path):
    service = env[1]; a = env[2][0]["account"]["uid"]
    with service.store.connect() as db:
        s = ladder.empty(a, "human"); s.update(rating=1700, deviation=100, games=2, rated_games=2, updated=int(time.time()))
        ladder.save(db, s)
        for table in ladder.EXTRA_TABLES: db.execute(f"DROP TABLE {table}")
        db.execute("PRAGMA user_version=5")
    wx.WechatStore(service.store.database)
    own = get_board(env)["me"]
    assert own["rating"] == 1700 and own["points"] == 1500 and own["rank"] == 1
    room = post(env, "ranked-ai", setup()); act(env, room, {"type": "resign"})
    tool = maintenance(); backup = tmp_path / "backup.sqlite3"
    receipt = tool.copy_store(service.store.database, backup)
    restored = tmp_path / "restored.sqlite3"
    tool.copy_store(backup, restored, expected_sha256=receipt["sha256"], current_store=service.store.database)
    assert wx.WechatStore(restored).leaderboard(a, "ai", 0)["me"] == get_board(env, "ai")["me"]
    b = env[2][1]["account"]["uid"]
    with service.store.connect() as db:
        ladder.merge_identity(db, b, a)
        assert ladder.stats(db, b, "ai")["rated_games"] == 1
        ladder.delete_identity(db, b)
        assert not db.execute("SELECT 1 FROM wx_skill_evidence WHERE uid IN (?,?)", (a,b)).fetchone()
    tool.inspect_store(service.store.database)


def test_schema5_backup_restore_stays_schema5_until_service_migration(env, tmp_path):
    service = env[1]
    with service.store.connect() as db:
        for table in ladder.EXTRA_TABLES: db.execute(f"DROP TABLE {table}")
        db.execute("PRAGMA user_version=5")
    tool = maintenance(); backup = tmp_path / "v5-backup.sqlite3"; restored = tmp_path / "v5-restored.sqlite3"
    receipt = tool.copy_store(service.store.database, backup)
    tool.copy_store(backup, restored, expected_sha256=receipt["sha256"], current_store=service.store.database)
    with sqlite3.connect(restored) as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == 5
        assert not db.execute("SELECT 1 FROM sqlite_master WHERE name='wx_skill_contexts'").fetchone()
    wx.WechatStore(restored)
    with sqlite3.connect(restored) as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == 6
    assert tool.inspect_store(restored)["status"] == "PASS_SQLITE_STRUCTURE_ONLY"


def test_expiry_forfeits_human_even_during_bot_turn_and_evidence_tampering_is_rejected(env):
    public = post(env, "ranked-ai", setup())
    room = env[1].store.room(public["code"])
    room["state"]["currentPlayer"] = "WHITE"
    room["expiresAt"] = 1
    with env[1].store.connect() as db:
        db.execute("UPDATE wx_rooms SET document=?,expires=1 WHERE code=?", (json.dumps(room), room["code"]))
        ladder.expire(db, 2)
        result = db.execute("SELECT outcome,rated FROM wx_skill_results").fetchone()
        assert result == (0, 1)
        stored = json.loads(db.execute("SELECT document FROM wx_rooms").fetchone()[0])
        assert not stored["state"]["gameOver"], "Forfeit does not invent an engine winner"
        raw = json.loads(db.execute("SELECT opponents FROM wx_skill_evidence").fetchone()[0])
        raw[0]["weight"] = .6; raw[1]["weight"] = .4
        db.execute("UPDATE wx_skill_evidence SET opponents=?", (json.dumps(raw),))
    with pytest.raises(ValueError, match="Invalid skill evidence"):
        maintenance().inspect_store(env[1].store.database)


@pytest.mark.parametrize("change", [
    {"controllers": {"BLACK": "human", "WHITE": "human", "PURPLE": "greedy"}},
    {"controllers": {"BLACK": "human", "WHITE": "minimax-4", "PURPLE": "minimax-4"}},
    {"winner": "BLACK"},
])
def test_client_cannot_claim_results_or_incompatible_ai(env, change):
    post(env, "ranked-ai", {**setup(), **change}, status=422)
