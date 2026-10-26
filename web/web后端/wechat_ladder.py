"""Skill-only ladder v2; authoritative results and ratings commit atomically."""
import importlib.util
import json
import math
from pathlib import Path
import time


def sibling(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


legacy = sibling("wechat_ladder_v1")
glicko = sibling("wechat_glicko2")
VERSION = "ladder-v2-glicko2"
AI_PROFILES = ("greedy", "minimax-2", "minimax-3", "minimax-4")
# An AI implementation/strength change must start a new fixed-opponent pool.
AI_POOL = "server-ai-v1"
CURRENT_TABLES = {
    "wx_skill_stats": ["uid", "board", "games", "wins", "draws", "rated_games", "rating", "deviation", "volatility", "updated", "points"],
    "wx_skill_results": ["match_id", "board", "uid", "opponent", "day", "rated", "outcome", "difficulty", "delta", "created", "opponent_rating", "opponent_deviation", "expected", "ordinal"],
}
TABLES = {**legacy.TABLES, **CURRENT_TABLES}


def migrate(db):
    legacy.migrate(db)  # v1 records remain in their original tables and scale.
    db.execute("CREATE TABLE IF NOT EXISTS wx_skill_stats (uid TEXT NOT NULL, board TEXT NOT NULL, games INTEGER NOT NULL, wins INTEGER NOT NULL, draws INTEGER NOT NULL, rated_games INTEGER NOT NULL, rating REAL NOT NULL, deviation REAL NOT NULL, volatility REAL NOT NULL, updated INTEGER NOT NULL, points INTEGER NOT NULL, PRIMARY KEY(uid,board))")
    db.execute("CREATE TABLE IF NOT EXISTS wx_skill_results (match_id TEXT NOT NULL, board TEXT NOT NULL, uid TEXT NOT NULL, opponent TEXT NOT NULL, day INTEGER NOT NULL, rated INTEGER NOT NULL, outcome REAL NOT NULL, difficulty TEXT, delta INTEGER NOT NULL, created INTEGER NOT NULL, opponent_rating REAL, opponent_deviation REAL, expected REAL, ordinal INTEGER NOT NULL, PRIMARY KEY(match_id,uid))")
    db.execute("CREATE INDEX IF NOT EXISTS wx_skill_pair_day ON wx_skill_results(uid,opponent,day,rated)")
    db.execute("CREATE INDEX IF NOT EXISTS wx_skill_board ON wx_skill_stats(board,points DESC)")


def bot_uid(profile):
    return f"ai:{AI_POOL}:{profile}"


def empty(uid, board):
    return dict(uid=uid, board=board, games=0, wins=0, draws=0, rated_games=0,
                rating=glicko.INITIAL_RATING, deviation=glicko.INITIAL_DEVIATION,
                volatility=glicko.INITIAL_VOLATILITY, updated=0, points=1500)


def stats(db, uid, board):
    row = db.execute("SELECT * FROM wx_skill_stats WHERE uid=? AND board=?", (uid, board)).fetchone()
    return dict(zip(CURRENT_TABLES["wx_skill_stats"], row)) if row else empty(uid, board)


def points(s):
    return math.floor(s["rating"] + 0.5)  # No game-count or win-rate bonus.


def save(db, s):
    if not all(math.isfinite(s[k]) for k in ("rating", "deviation", "volatility")):
        raise ValueError("Invalid ladder rating")
    s["points"] = points(s)
    db.execute("INSERT OR REPLACE INTO wx_skill_stats VALUES (?,?,?,?,?,?,?,?,?,?,?)",
               tuple(s[k] for k in CURRENT_TABLES["wx_skill_stats"]))


def elapsed(s, now):
    if s.get("uid", "").startswith("ai:"):
        return 0  # A fixed, versioned program does not change skill while idle.
    return max(0, now - s["updated"]) / 86400 * glicko.PERIODS_PER_DAY if s["updated"] else 0


def live_deviation(s, now):
    return glicko.deviation_at(s["deviation"], s["volatility"], elapsed(s, now))


def rated_update(s, opponent, outcome, now):
    r, rd, sigma = glicko.update(s["rating"], s["deviation"], s["volatility"],
        [(opponent["rating"], live_deviation(opponent, now), outcome)], periods=elapsed(s, now))
    s.update(rating=r, deviation=min(glicko.INITIAL_DEVIATION, max(glicko.MIN_DEVIATION, rd)),
             volatility=min(glicko.MAX_VOLATILITY, sigma), updated=now)
    s["rated_games"] += 1


def settle(db, room):
    if room.get("ladderVersion") == legacy.VERSION:
        return legacy.settle(db, room)
    if room.get("ladderVersion") != VERSION or not room["state"]["gameOver"]:
        return
    if db.execute("SELECT 1 FROM wx_skill_results WHERE match_id=?", (room["matchId"],)).fetchone():
        return
    ai, players = room.get("rankedAI"), room["players"]
    if not all(players.values()):
        return
    board = "ai" if ai else "human"
    identities = {**players, **({"WHITE": bot_uid(ai)} if ai else {})}
    before = {p: stats(db, identities[p], board) for p in players}
    now = int(time.time())
    day = (now + 8 * 3600) // 86400
    settings = room["settings"]
    placements = {p: sum(a["type"] == "move" and a["player"] == p for a in room["actions"]) for p in players}
    eligible = (settings["rulesVersion"] == "territory-v3"
                and settings.get("startingPointMode", "default") == "default"
                and not room.get("undo", {}).get("usedCount", 0))
    rated = eligible and (min(placements.values()) >= 2 or any(a["type"] == "resign" for a in room["actions"]))
    reason = "rated" if rated else "practice"
    if rated and not ai:
        used = db.execute("SELECT count(*) FROM wx_skill_results WHERE uid=? AND opponent=? AND day=? AND rated=1",
                          (identities["BLACK"], identities["WHITE"], day)).fetchone()[0]
        if used >= 3:
            rated, reason = False, "pair_daily_limit"
    if rated and ai:
        used = db.execute("SELECT count(*) FROM wx_skill_results WHERE uid=? AND board='ai' AND day=? AND rated=1",
                          (identities["BLACK"], day)).fetchone()[0]
        if used >= 20:
            rated, reason = False, "ai_daily_limit"
    winner = room["state"]["winner"]
    ordinal = db.execute("SELECT COALESCE(MAX(ordinal),0)+1 FROM wx_skill_results").fetchone()[0]
    receipt = {"version": VERSION, "board": board, "rated": rated, "reason": reason, "players": {}}
    # Both updates use pre-game states. AI profiles are calibrated opponents,
    # never assigned a difficulty multiplier or an invented fixed Elo.
    for p in players:
        s, opponent = dict(before[p]), before["WHITE" if p == "BLACK" else "BLACK"]
        outcome = 0.5 if winner in (None, "DRAW") else float(winner == p)
        is_bot = ai and p == "WHITE"
        if is_bot and not rated:
            continue
        s["games"] += 1
        s["wins"] += int(outcome == 1)
        s["draws"] += int(outcome == 0.5)
        if rated:
            rated_update(s, opponent, outcome, now)
        save(db, s)
        if is_bot:
            continue
        delta = s["points"] - before[p]["points"]
        db.execute("INSERT INTO wx_skill_results VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                   (room["matchId"], board, identities[p], opponent["uid"], day, int(rated), outcome, ai, delta, now,
                    opponent["rating"] if rated else None, live_deviation(opponent, now) if rated else None,
                    glicko.expected(before[p]["rating"], opponent["rating"], live_deviation(opponent, now)) if rated else None, ordinal))
        receipt["players"][p] = {"points": s["points"], "delta": delta, "ratedGames": s["rated_games"],
                                "provisional": live_deviation(s, now) > glicko.RANKABLE_DEVIATION}
    room["ladderResult"] = receipt


def board(db, uid, kind, offset=0, limit=20):
    now = int(time.time())

    def public(s, rank=None):
        name = db.execute("SELECT COALESCE(p.display_name,w.display_name,'微信玩家') FROM (SELECT ? AS uid) x LEFT JOIN wx_profiles p ON p.uid=x.uid LEFT JOIN wx_web_accounts w ON w.uid=x.uid", (s["uid"],)).fetchone()[0]
        rd = live_deviation(s, now)
        return {"displayName": name, "isMe": s["uid"] == uid, "points": s["points"],
                "games": s["games"], "wins": s["wins"], "draws": s["draws"],
                "winRate": round(s["wins"] / s["games"], 4) if s["games"] else 0,
                "ratedGames": s["rated_games"], "rank": rank, "provisional": rd > glicko.RANKABLE_DEVIATION,
                "ratingDeviation": round(rd, 1), "interval": [math.floor(s["rating"] - 2 * rd), math.ceil(s["rating"] + 2 * rd)]}

    db.create_function("skill_rd", 3, lambda rd, sigma, updated: glicko.deviation_at(rd, sigma,
        max(0, now - updated) / 86400 * glicko.PERIODS_PER_DAY if updated else 0), deterministic=True)
    eligible = "board=? AND uid NOT LIKE 'ai:%' AND rated_games>0 AND skill_rd(deviation,volatility,updated)<=?"
    args = (kind, glicko.RANKABLE_DEVIATION)
    query = f"SELECT *, RANK() OVER (ORDER BY points DESC) AS place FROM wx_skill_stats WHERE {eligible}"
    rows = db.execute(f"SELECT * FROM ({query}) ORDER BY points DESC,uid LIMIT ? OFFSET ?", (*args, limit, offset)).fetchall()
    entries = [public(dict(zip(CURRENT_TABLES["wx_skill_stats"], r[:-1])), r[-1]) for r in rows]
    own = stats(db, uid, kind)
    rank = (1 + db.execute(f"SELECT count(*) FROM wx_skill_stats WHERE {eligible} AND points>?", (*args, own["points"])).fetchone()[0]
            if own["rated_games"] and live_deviation(own, now) <= glicko.RANKABLE_DEVIATION else None)
    total = db.execute(f"SELECT count(*) FROM wx_skill_stats WHERE {eligible}", args).fetchone()[0]
    bots = []
    if kind == "ai":
        for profile in AI_PROFILES:
            s = stats(db, bot_uid(profile), kind)
            bots.append({"profile": profile, "points": s["points"], "provisional": live_deviation(s, now) > glicko.RANKABLE_DEVIATION})
    return {"version": VERSION, "board": kind, "entries": entries, "me": public(own, rank),
            "offset": offset, "hasMore": offset + limit < total, "total": total,
            "rankableDeviation": glicko.RANKABLE_DEVIATION, "aiOpponents": bots, "aiPool": AI_POOL}


def merge_identity(db, uid, old_uid):
    legacy.merge_identity(db, uid, old_uid)
    db.execute("DELETE FROM wx_skill_results WHERE (uid=? AND opponent=?) OR (uid=? AND opponent=?)", (uid, old_uid, old_uid, uid))
    db.execute("UPDATE wx_skill_results SET uid=? WHERE uid=?", (uid, old_uid))
    db.execute("UPDATE wx_skill_results SET opponent=? WHERE opponent=?", (uid, old_uid))
    db.execute("DELETE FROM wx_skill_stats WHERE uid IN (?,?)", (uid, old_uid))
    # Re-estimate from retained pre-game opponent snapshots, excluding self-play.
    # Never add or average two skill estimates.
    for kind in ("ai", "human"):
        s = empty(uid, kind)
        rows = db.execute("SELECT rated,outcome,created,opponent_rating,opponent_deviation FROM wx_skill_results WHERE uid=? AND board=? ORDER BY ordinal", (uid, kind))
        for rated, outcome, created, opponent_rating, opponent_rd in rows:
            s["games"] += 1
            s["wins"] += int(outcome == 1)
            s["draws"] += int(outcome == 0.5)
            if rated:
                opponent = {"rating": opponent_rating, "deviation": opponent_rd, "volatility": 0, "updated": created}
                rated_update(s, opponent, outcome, created)
        if s["games"]:
            save(db, s)


def delete_identity(db, uid):
    legacy.delete_identity(db, uid)
    db.execute("DELETE FROM wx_skill_stats WHERE uid=?", (uid,))
    db.execute("DELETE FROM wx_skill_results WHERE uid=?", (uid,))
    db.execute("UPDATE wx_skill_results SET opponent='deleted' WHERE opponent=?", (uid,))


def expire(db, now):
    legacy.expire(db, now)
    for raw, in db.execute("SELECT document FROM wx_rooms WHERE expires<=?", (now,)).fetchall():
        room = json.loads(raw)
        if room.get("ladderVersion") != VERSION or room["status"] != "playing":
            continue
        actor = room["state"]["currentPlayer"]
        room["actions"].append({"type": "resign", "player": actor})
        room["state"] = {**room["state"], "gameOver": True, "winner": "WHITE" if actor == "BLACK" else "BLACK"}
        settle(db, room)
