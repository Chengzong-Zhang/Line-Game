"""Ladder v1. Called inside the room's SQLite transaction, never by client results."""
import math
import json
import time

VERSION = "ladder-v1"
AI_WEIGHTS = {"greedy": 1, "minimax-2": 1.5, "minimax-3": 2, "minimax-4": 3}
TABLES = {
    "wx_ladder_stats": ["uid", "board", "games", "wins", "draws", "rated_games", "weighted", "rating", "points"],
    "wx_ladder_results": ["match_id", "board", "uid", "opponent", "day", "rated", "outcome", "difficulty", "delta", "created"],
}


def migrate(db):
    db.execute("CREATE TABLE IF NOT EXISTS wx_ladder_stats (uid TEXT NOT NULL, board TEXT NOT NULL, games INTEGER NOT NULL, wins INTEGER NOT NULL, draws INTEGER NOT NULL, rated_games INTEGER NOT NULL, weighted REAL NOT NULL, rating REAL NOT NULL, points INTEGER NOT NULL, PRIMARY KEY(uid,board))")
    db.execute("CREATE TABLE IF NOT EXISTS wx_ladder_results (match_id TEXT NOT NULL, board TEXT NOT NULL, uid TEXT NOT NULL, opponent TEXT NOT NULL, day INTEGER NOT NULL, rated INTEGER NOT NULL, outcome REAL NOT NULL, difficulty TEXT, delta INTEGER NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(match_id,uid))")
    db.execute("CREATE INDEX IF NOT EXISTS wx_ladder_pair_day ON wx_ladder_results(uid,opponent,day,rated)")
    db.execute("CREATE INDEX IF NOT EXISTS wx_ladder_board ON wx_ladder_stats(board,points DESC)")


def empty(uid, board):
    return dict(uid=uid, board=board, games=0, wins=0, draws=0, rated_games=0,
                weighted=0.0, rating=1000.0, points=1000 if board == "human" else 0)


def stats(db, uid, board):
    row = db.execute("SELECT * FROM wx_ladder_stats WHERE uid=? AND board=?", (uid, board)).fetchone()
    return dict(zip(TABLES["wx_ladder_stats"], row)) if row else empty(uid, board)


def points(s):
    n = s["rated_games"]
    raw = (1000 * s["weighted"] / (n + 10) + 2 * min(n, 100) if s["board"] == "ai"
           else s["rating"] + 2 * min(n, 50))
    return math.floor(raw + 0.5)


def save(db, s):
    s["points"] = points(s)
    db.execute("INSERT OR REPLACE INTO wx_ladder_stats VALUES (?,?,?,?,?,?,?,?,?)",
               tuple(s[k] for k in TABLES["wx_ladder_stats"]))


def settle(db, room):
    """Exactly once, same transaction as the accepted terminal state (including CAS)."""
    if room.get("ladderVersion") != VERSION or not room["state"]["gameOver"]:
        return
    if db.execute("SELECT 1 FROM wx_ladder_results WHERE match_id=?", (room["matchId"],)).fetchone():
        return
    ai = room.get("rankedAI")
    board = "ai" if ai else "human"
    players = room["players"]
    if not all(players.values()):
        return
    human_seats = ["BLACK"] if ai else ["BLACK", "WHITE"]
    before = {p: stats(db, players[p], board) for p in human_seats}
    now = int(time.time())
    day = (now + 8 * 3600) // 86400  # Asia/Shanghai, independent of server timezone.
    settings = room["settings"]
    # Custom roots and takebacks are practice; opening passes cannot farm draws.
    placements = {p: sum(a["type"] == "move" and a["player"] == p for a in room["actions"]) for p in players}
    eligible = (settings["rulesVersion"] == "territory-v3"
                and settings.get("startingPointMode", "default") == "default"
                and not room.get("undo", {}).get("usedCount", 0))
    resignation = any(a["type"] == "resign" for a in room["actions"])
    substantial = min(placements.values()) >= 2
    rated = eligible and (substantial or resignation)
    reason = "rated" if rated else "practice"
    if rated and not ai:
        used = db.execute("SELECT count(*) FROM wx_ladder_results WHERE uid=? AND opponent=? AND day=? AND rated=1",
                          (players["BLACK"], players["WHITE"], day)).fetchone()[0]
        if used >= 3:
            rated, reason = False, "pair_daily_limit"
    if rated and ai:
        used = db.execute("SELECT count(*) FROM wx_ladder_results WHERE uid=? AND board='ai' AND day=? AND rated=1",
                          (players["BLACK"], day)).fetchone()[0]
        if used >= 20:
            rated, reason = False, "ai_daily_limit"
    winner = room["state"]["winner"]
    receipt = {"version": VERSION, "board": board, "rated": rated, "reason": reason, "players": {}}
    for p in human_seats:
        s = dict(before[p])
        opponent = "WHITE" if p == "BLACK" else "BLACK"
        outcome = 0.5 if winner in (None, "DRAW") else float(winner == p)
        s["games"] += 1
        s["wins"] += int(outcome == 1)
        s["draws"] += int(outcome == 0.5)
        if rated:
            s["rated_games"] += 1
            if ai:
                s["weighted"] += AI_WEIGHTS[ai] * outcome
            else:
                difference = max(-3000, min(3000, before[opponent]["rating"] - s["rating"]))
                expected = 1 / (1 + 10 ** (difference / 400))
                s["rating"] += 16 * (outcome - expected)
        save(db, s)
        delta = s["points"] - before[p]["points"]
        db.execute("INSERT INTO wx_ladder_results VALUES (?,?,?,?,?,?,?,?,?,?)",
                   (room["matchId"], board, players[p], players[opponent], day, int(rated), outcome, ai, delta, now))
        receipt["players"][p] = {"points": s["points"], "delta": delta, "ratedGames": s["rated_games"]}
    room["ladderResult"] = receipt


def board(db, uid, kind, offset=0, limit=20):
    def public(s, rank=None):
        name = db.execute("SELECT COALESCE(p.display_name,w.display_name,'微信玩家') FROM (SELECT ? AS uid) x LEFT JOIN wx_profiles p ON p.uid=x.uid LEFT JOIN wx_web_accounts w ON w.uid=x.uid", (s["uid"],)).fetchone()[0]
        return {"displayName": name, "isMe": s["uid"] == uid, "points": s["points"],
                "games": s["games"], "wins": s["wins"], "draws": s["draws"],
                "winRate": round(s["wins"] / s["games"], 4) if s["games"] else 0,
                "ratedGames": s["rated_games"], "rank": rank}
    # SQL rank uses displayed integer points; equal scores share the same place.
    query = "SELECT *, RANK() OVER (ORDER BY points DESC) AS place FROM wx_ladder_stats WHERE board=? AND rated_games>=5"
    rows = db.execute(f"SELECT * FROM ({query}) ORDER BY points DESC,uid LIMIT ? OFFSET ?", (kind, limit, offset)).fetchall()
    entries = [public(dict(zip(TABLES["wx_ladder_stats"], r[:-1])), r[-1]) for r in rows]
    own = stats(db, uid, kind)
    rank = 1 + db.execute("SELECT count(*) FROM wx_ladder_stats WHERE board=? AND rated_games>=5 AND points>?", (kind, own["points"])).fetchone()[0] if own["rated_games"] >= 5 else None
    total = db.execute("SELECT count(*) FROM wx_ladder_stats WHERE board=? AND rated_games>=5", (kind,)).fetchone()[0]
    return {"version": VERSION, "board": kind, "entries": entries, "me": public(own, rank),
            "offset": offset, "hasMore": offset + limit < total, "total": total, "qualifyingGames": 5}


def merge_identity(db, uid, old_uid):
    # Both accounts belong to one person. Pool counts; use a game-weighted Elo
    # average, never add ratings. Self-play records are excluded after linking.
    ratings = {}
    for kind in ("ai", "human"):
        a, b = stats(db, uid, kind), stats(db, old_uid, kind)
        n = a["rated_games"] + b["rated_games"]
        ratings[kind] = (a["rating"] * a["rated_games"] + b["rating"] * b["rated_games"]) / n if n else 1000
    db.execute("DELETE FROM wx_ladder_results WHERE (uid=? AND opponent=?) OR (uid=? AND opponent=?)", (uid, old_uid, old_uid, uid))
    db.execute("UPDATE wx_ladder_results SET uid=? WHERE uid=?", (uid, old_uid))
    db.execute("UPDATE wx_ladder_results SET opponent=? WHERE opponent=?", (uid, old_uid))
    db.execute("DELETE FROM wx_ladder_stats WHERE uid IN (?,?)", (uid, old_uid))
    for kind in ("ai", "human"):
        s = empty(uid, kind)
        s["rating"] = ratings[kind]
        for rated, outcome, difficulty in db.execute("SELECT rated,outcome,difficulty FROM wx_ladder_results WHERE uid=? AND board=?", (uid, kind)):
            s["games"] += 1
            s["wins"] += int(outcome == 1)
            s["draws"] += int(outcome == 0.5)
            s["rated_games"] += rated
            if kind == "ai" and rated:
                s["weighted"] += AI_WEIGHTS[difficulty] * outcome
        if s["games"]:
            save(db, s)


def delete_identity(db, uid):
    db.execute("DELETE FROM wx_ladder_stats WHERE uid=?", (uid,))
    db.execute("DELETE FROM wx_ladder_results WHERE uid=?", (uid,))
    # Preserve the opponent's legitimate result without retaining this identity.
    db.execute("UPDATE wx_ladder_results SET opponent='deleted' WHERE opponent=?", (uid,))


def expire(db, now):
    # A disconnected player has 24 hours to resume their turn. A missing
    # terminal packet must not erase a ranked loss when room TTL cleanup runs.
    for raw, in db.execute("SELECT document FROM wx_rooms WHERE expires<=?", (now,)).fetchall():
        room = json.loads(raw)
        if room.get("ladderVersion") != VERSION or room["status"] != "playing":
            continue
        actor = room["state"]["currentPlayer"]
        room["actions"].append({"type": "resign", "player": actor})
        room["state"] = {**room["state"], "gameOver": True, "winner": "WHITE" if actor == "BLACK" else "BLACK"}
        settle(db, room)
