"""Real SQLite, HTTP auth and Node rules/AI; no production data or services."""
import importlib.util
import json
from pathlib import Path
import secrets
import sqlite3
import time

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("ladder_wx_test", ROOT / "web/web后端/wechat_online.py")
wx = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wx)
ladder = wx.ladder


@pytest.fixture
def env(tmp_path):
    async def exchange(code, *_):
        return "test-only-" + code
    store = wx.WechatStore(tmp_path / "ladder.sqlite3")
    svc = wx.WechatService(store, "fixture-app", "fixture-secret", "fixture-signing-secret-at-least-32-bytes", exchange=exchange)
    app = FastAPI()
    app.include_router(wx.create_router(svc))
    with TestClient(app) as client:
        sessions = [client.post("/api/wechat/login", json={"code": name}).json() for name in ("a", "b", "c")]
        yield client, svc, sessions


def header(session):
    return {"Authorization": "Bearer " + session["token"]}


def post(env, path, body=None, who=0, status=200):
    client, _, sessions = env
    response = client.post("/api/wechat/" + path, json=body or {}, headers=header(sessions[who]))
    assert response.status_code == status, response.text
    return response.json()


def get_board(env, board="human", who=0):
    response = env[0].get("/api/wechat/ladder/" + board, headers=header(env[2][who]))
    assert response.status_code == 200, response.text
    return response.json()


def room_fixture(uids, winner="BLACK", profile=None, **changes):
    room = {"ladderVersion": ladder.VERSION, "matchId": secrets.token_hex(16), "players": dict(zip(("BLACK", "WHITE"), uids)),
            "settings": {"rulesVersion": "territory-v3"}, "state": {"gameOver": True, "winner": winner},
            "actions": [{"type": "move", "player": p} for _ in range(2) for p in ("BLACK", "WHITE")], "undo": {"usedCount": 0}}
    if profile:
        room["rankedAI"] = profile
        room["players"]["WHITE"] = "ai:" + profile
    room.update(changes)
    return room


def test_published_glicko2_example():
    rating, rd, sigma = ladder.glicko.update(1500, 200, 0.06, [(1400, 30, 1), (1550, 100, 0), (1700, 300, 0)])
    assert rating == pytest.approx(1464.06, abs=0.01)
    assert rd == pytest.approx(151.52, abs=0.01)
    assert sigma == pytest.approx(0.059996, abs=0.000001)


def test_game_count_and_win_rate_never_add_skill_points():
    for kind in ("ai", "human"):
        s = ladder.empty("x", kind)
        s.update(rating=1723.4)
        assert ladder.points(s) == 1723
        assert ladder.points({**s, "games": 10000, "rated_games": 10000, "wins": 10000}) == 1723
        same = ladder.glicko.update(1500, 60, .06, [(1500, 60, .5)] * 100, periods=0)
        assert same[0] == 1500, 'more expected results improve confidence, not skill'


def test_human_strong_opponents_and_small_loss_do_not_erase_large_lead(env):
    _, svc, sessions = env
    a, b = [s["account"]["uid"] for s in sessions[:2]]
    with svc.store.connect() as db:
        for uid, rating in ((a, 1500), (b, 1900)):
            s = ladder.empty(uid, "human"); s.update(rating=rating, deviation=45, updated=int(time.time()), rated_games=50, games=50); ladder.save(db, s)
        game = room_fixture((a, b))
        ladder.settle(db, game)
        assert 8 < game["ladderResult"]["players"]["BLACK"]["delta"] < 20
        assert ladder.stats(db, b, "human")["points"] > ladder.stats(db, a, "human")["points"]
        before = ladder.stats(db, a, "human")["points"]
        ladder.settle(db, room_fixture((a, b), "WHITE"))
        assert 0 <= before - ladder.stats(db, a, "human")["points"] <= 16


def test_duplicate_result_and_daily_pair_limit_and_stats(env):
    _, svc, sessions = env
    uids = [s["account"]["uid"] for s in sessions[:2]]
    with svc.store.connect() as db:
        game = room_fixture(uids)
        ladder.settle(db, game); ladder.settle(db, game)
        for _ in range(3): ladder.settle(db, room_fixture(uids, None))
        s = ladder.stats(db, uids[0], "human")
        assert (s["games"], s["rated_games"], s["wins"], s["draws"]) == (4, 3, 1, 3)
        assert 1500 < s["points"] < 1663


def test_ai_daily_cap_and_beijing_day_boundary(env, monkeypatch):
    _, svc, sessions = env
    uids = [s["account"]["uid"] for s in sessions[:2]]
    monkeypatch.setattr(ladder.time, "time", lambda: 86399 - 28800)
    with svc.store.connect() as db:
        for _ in range(21): ladder.settle(db, room_fixture(uids, profile="minimax-4"))
        assert ladder.stats(db, uids[0], "ai")["rated_games"] == 20
        monkeypatch.setattr(ladder.time, "time", lambda: 86400 - 28800)
        ladder.settle(db, room_fixture(uids, profile="minimax-4"))
        assert ladder.stats(db, uids[0], "ai")["rated_games"] == 21


def test_qualifiers_ties_pagination_and_no_public_identity(env):
    client, svc, sessions = env
    with svc.store.connect() as db:
        for index, session in enumerate(sessions):
            s = ladder.empty(session["account"]["uid"], "human")
            s.update(games=1000 if index else 5, rated_games=1000 if index else 5,
                     deviation=200 if index == 2 else 60, updated=int(time.time()))
            ladder.save(db, s)
    board = get_board(env)
    assert [e["rank"] for e in board["entries"]] == [1, 1]
    assert board["me"]["rank"] == 1
    assert get_board(env, who=2)["me"]["rank"] is None
    raw = json.dumps(board)
    assert all(s["account"]["uid"] not in raw for s in sessions)
    assert client.get("/api/wechat/ladder/human").status_code == 401
    for suffix in ("unknown", "human?offset=-1", "ai?offset=10001"):
        assert client.get("/api/wechat/ladder/" + suffix, headers=header(sessions[0])).status_code == 422


@pytest.mark.parametrize("change", [{"undo": {"usedCount": 1}}, {"settings": {"rulesVersion": "territory-v3", "startingPointMode": "custom"}}, {"actions": []}])
def test_practice_results_do_not_award_points(env, change):
    _, svc, sessions = env
    uids = [s["account"]["uid"] for s in sessions[:2]]
    with svc.store.connect() as db:
        game = room_fixture(uids, None, **change); ladder.settle(db, game)
        assert not game["ladderResult"]["rated"]
        assert ladder.stats(db, uids[0], "human")["games"] == 1
        assert ladder.stats(db, uids[0], "human")["points"] == 1500


def test_new_human_game_terminal_retry_restart_and_leave(env):
    room = post(env, "rooms", {"rulesVersion": "territory-v3"})
    post(env, "rooms/join", {"code": room["code"]}, who=1)
    endpoint = f"rooms/{room['code']}"
    post(env, endpoint + "/ready", {"matchId": room["matchId"]})
    room = post(env, endpoint + "/ready", {"matchId": room["matchId"]}, who=1)
    body = {"matchId": room["matchId"], "expectedSeq": room["seq"], "beforeHash": room["stateHash"], "clientActionId": "terminal-command-000001", "action": {"type": "resign"}}
    result = post(env, endpoint + "/actions", body)
    assert result["ladderResult"]["players"]["BLACK"]["delta"] < 0
    assert result["ladderResult"]["players"]["BLACK"]["provisional"]
    assert post(env, endpoint + "/actions", body)["ladderResult"] == result["ladderResult"]
    assert get_board(env)["me"]["games"] == 1
    assert wx.WechatStore(env[1].store.database).leaderboard(env[2][0]["account"]["uid"], "human", 0)["me"]["games"] == 1
    assert post(env, endpoint + "/undo", {"matchId": room["matchId"]}, status=409)["detail"] == "RANKED_RESULT_FINAL"
    post(env, endpoint + "/rematch", {"matchId": room["matchId"]})
    room = post(env, endpoint + "/rematch", {"matchId": room["matchId"]}, who=1)
    post(env, endpoint + "/ready", {"matchId": room["matchId"]})
    post(env, endpoint + "/ready", {"matchId": room["matchId"]}, who=1)
    post(env, endpoint + "/leave", {"matchId": room["matchId"]}, who=1)
    assert get_board(env)["me"]["wins"] == 1


@pytest.mark.parametrize("profile", ladder.AI_PROFILES)
def test_real_server_ai_reply_is_durable_and_client_cannot_supply_result(env, profile):
    room = post(env, "ranked-ai", {"profile": profile})
    assert room["status"] == "playing" and room["rankedAI"] == profile
    endpoint = f"rooms/{room['code']}/actions"
    body = {"matchId": room["matchId"], "expectedSeq": 0, "beforeHash": room["stateHash"], "clientActionId": "ai-human-command-00001", "action": {"type": "move", "point": [1, 0]}}
    result = post(env, endpoint, body)
    assert result["seq"] == 2 and result["currentPlayer"] == "BLACK"
    assert result["actions"][1]["player"] == "WHITE"
    assert post(env, endpoint, body)["stateHash"] == result["stateHash"]
    terminal = post(env, endpoint, {**body, "clientActionId": "ai-resign-command-0001", "expectedSeq": 2, "beforeHash": result["stateHash"], "action": {"type": "resign"}})
    assert terminal["ladderResult"]["board"] == "ai"
    assert get_board(env, "ai")["me"]["ratedGames"] == 1
    assert get_board(env, "human")["me"]["games"] == 0
    assert post(env, "ranked-ai", {"profile": "imaginary"}, status=422)["detail"] == "INVALID_AI_DIFFICULTY"


def test_failed_ai_reply_rolls_back_human_move(env):
    room = post(env, "ranked-ai", {"profile": "greedy"})
    def unavailable(*args, **kwargs): wx.fail("RULE_SERVICE_UNAVAILABLE", 503)
    env[1].ai_verifier = unavailable
    post(env, f"rooms/{room['code']}/actions", {"matchId": room["matchId"], "expectedSeq": 0, "beforeHash": room["stateHash"], "clientActionId": "ai-unavailable-000001", "action": {"type": "move", "point": [1, 0]}}, status=503)
    assert env[1].store.room(room["code"])["seq"] == 0


def test_real_engine_draw_counts_for_both_players_but_opening_passes_do_not_rate(env):
    room = post(env, "rooms", {"rulesVersion": "territory-v3"})
    post(env, "rooms/join", {"code": room["code"]}, who=1)
    endpoint = f"rooms/{room['code']}"
    post(env, endpoint + "/ready", {"matchId": room["matchId"]})
    room = post(env, endpoint + "/ready", {"matchId": room["matchId"]}, who=1)
    for who in (0, 1):
        room = post(env, endpoint + "/actions", {"matchId": room["matchId"], "expectedSeq": room["seq"], "beforeHash": room["stateHash"], "clientActionId": f"draw-command-player-{who}", "action": {"type": "skip"}}, who=who)
    assert room["winner"] == "DRAW"
    for who in (0, 1):
        own = get_board(env, who=who)["me"]
        assert (own["games"], own["draws"], own["ratedGames"], own["points"]) == (1, 1, 0, 1500)


def test_stale_cas_cannot_partially_settle(env):
    room = post(env, "ranked-ai", {"profile": "greedy"})
    svc = env[1]
    raw = svc.store.room(room["code"])
    raw["state"] = {**raw["state"], "gameOver": True, "winner": "WHITE"}
    raw["actions"] = [{"type": "resign", "player": "BLACK"}]
    with pytest.raises(HTTPException): svc.store.commit(raw, 999)
    assert get_board(env, "ai")["me"]["games"] == 0


def test_expired_turn_forfeits_once_without_short_disconnect_penalty(env):
    room = post(env, "ranked-ai", {"profile": "greedy"})
    assert get_board(env, "ai")["me"]["games"] == 0
    with env[1].store.connect() as db: db.execute("UPDATE wx_rooms SET expires=0 WHERE code=?", (room["code"],))
    assert get_board(env, "ai")["me"]["games"] == 1
    assert get_board(env, "ai")["me"]["games"] == 1


def test_account_deletion_and_merge_do_not_duplicate_ratings(env):
    _, svc, sessions = env
    a, b, c = [s["account"]["uid"] for s in sessions]
    with svc.store.connect() as db:
        ladder.settle(db, room_fixture((a, c)))
        ladder.settle(db, room_fixture((b, c)))
        ladder.settle(db, room_fixture((a, b)))
        ladder.merge_identity(db, a, b)
        s = ladder.stats(db, a, "human")
        assert s["games"] == 2 and 1500 < s["rating"] < 2000
        assert ladder.stats(db, b, "human")["games"] == 0
    svc.store.delete_account(a)
    with svc.store.connect() as db:
        assert not db.execute("SELECT 1 FROM wx_skill_results WHERE uid=? OR opponent=?", (a, a)).fetchone()


def test_migration_and_backup_restore_preserve_scores(env, tmp_path):
    room = post(env, "ranked-ai", {"profile": "greedy"})
    post(env, f"rooms/{room['code']}/leave", {"matchId": room["matchId"]})
    spec = importlib.util.spec_from_file_location("ladder_maintenance", ROOT / "wechat/tools/maintain_store.py")
    maintenance = importlib.util.module_from_spec(spec); spec.loader.exec_module(maintenance)
    backup = tmp_path / "backup.sqlite3"
    receipt = maintenance.copy_store(env[1].store.database, backup)
    destination = tmp_path / "restored.sqlite3"
    maintenance.copy_store(backup, destination, expected_sha256=receipt["sha256"], current_store=env[1].store.database)
    restored = wx.WechatStore(destination)
    assert restored.leaderboard(env[2][0]["account"]["uid"], "ai", 0)["me"] == get_board(env, "ai")["me"]
    with restored.connect() as db: assert db.execute("PRAGMA user_version").fetchone()[0] == 5


def test_v3_migration_preserves_users_and_rejects_partial_ladder_tables(env):
    store = env[1].store
    with store.connect() as db:
        original = db.execute("SELECT * FROM wx_users ORDER BY uid").fetchall()
        for table in ladder.TABLES: db.execute(f"DROP TABLE {table}")
        db.execute("PRAGMA user_version=3")
    upgraded = wx.WechatStore(store.database)
    with upgraded.connect() as db:
        assert db.execute("SELECT * FROM wx_users ORDER BY uid").fetchall() == original
        assert db.execute("PRAGMA user_version").fetchone()[0] == 5
        db.execute("DROP TABLE wx_ladder_results")
    with pytest.raises(ValueError): wx.WechatStore(store.database)


def test_unknown_ai_profiles_share_prior_and_learn_actual_results(env):
    _, svc, sessions = env
    a, b = [s["account"]["uid"] for s in sessions[:2]]
    initial = get_board(env, "ai")
    assert {bot["points"] for bot in initial["aiOpponents"]} == {1500}
    assert all(bot["provisional"] for bot in initial["aiOpponents"])
    with svc.store.connect() as db:
        ladder.settle(db, room_fixture((a, b), "WHITE", profile="greedy"))
        ladder.settle(db, room_fixture((b, a), "BLACK", profile="minimax-4"))
        # Observed results, not the difficulty name, determine the ordering.
        assert ladder.stats(db, ladder.bot_uid("greedy"), "ai")["rating"] > 1500
        assert ladder.stats(db, ladder.bot_uid("minimax-4"), "ai")["rating"] < 1500
        for p in ladder.AI_PROFILES:
            bot = ladder.stats(db, ladder.bot_uid(p), "ai")
            bot.update(deviation=45, rated_games=100, games=100, updated=int(time.time()))
            ladder.save(db, bot)
    assert get_board(env, "ai")["entries"] == [], 'bots never occupy human leaderboard positions'


def test_beating_measured_stronger_ai_earns_more_and_stable_ratings_move_less():
    g = ladder.glicko
    weak = g.update(1500, 45, .06, [(1200, 45, 1)], periods=0)[0]
    strong = g.update(1500, 45, .06, [(1800, 45, 1)], periods=0)[0]
    provisional = g.update(1500, 350, .06, [(1800, 45, 1)], periods=0)[0]
    assert 1500 < weak < strong < provisional


def test_inactivity_changes_uncertainty_not_skill_and_removes_stale_rank(env, monkeypatch):
    _, svc, sessions = env
    uid = sessions[0]["account"]["uid"]
    now = int(time.time())
    with svc.store.connect() as db:
        s = ladder.empty(uid, "human")
        s.update(rating=1800, deviation=60, updated=now, games=50, rated_games=50)
        ladder.save(db, s)
    assert get_board(env)["me"]["rank"] == 1
    monkeypatch.setattr(ladder.time, "time", lambda: now + 86400 * 365)
    own = get_board(env)["me"]
    assert own["points"] == 1800 and own["rank"] is None and own["provisional"]
    bot = {**s, "uid": ladder.bot_uid("greedy")}
    assert ladder.live_deviation(bot, now + 86400 * 365) == 60


def test_schema4_upgrade_archives_v1_without_synthetic_v2_scores(env):
    store = env[1].store
    uids = [s["account"]["uid"] for s in env[2][:2]]
    with store.connect() as db:
        old_room = room_fixture(uids, ladderVersion="ladder-v1")
        ladder.legacy.settle(db, old_room)
        original = {table: db.execute(f"SELECT * FROM {table}").fetchall() for table in ladder.legacy.TABLES}
        for table in ladder.CURRENT_TABLES: db.execute(f"DROP TABLE {table}")
        db.execute("PRAGMA user_version=4")
    upgraded = wx.WechatStore(store.database)
    with upgraded.connect() as db:
        assert all(db.execute(f"SELECT * FROM {table}").fetchall() == rows for table, rows in original.items())
        assert ladder.stats(db, uids[0], "human")["rated_games"] == 0
        ladder.settle(db, room_fixture(uids, ladderVersion="ladder-v1"))
        assert ladder.legacy.stats(db, uids[0], "human")["games"] == 2
        assert ladder.stats(db, uids[0], "human")["games"] == 0
