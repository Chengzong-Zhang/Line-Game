import sys, os
from typing import Optional, List, Tuple

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
from triangular_game import TriangularGame, Player, PointState


class MinimaxAI:
    def __init__(self, depth: int = 3):
        self.depth = depth

    def get_legal_moves(self, game, player: Player) -> List[Tuple[int, int]]:
        return [pos for pos in game.grid if game._is_legal_move(pos, player)]

    def order_moves(
        self,
        game,
        moves: List[Tuple[int, int]],
        player: Player,
    ) -> List[Tuple[int, int]]:
        opponent_line = (
            PointState.WHITE_LINE if player == Player.BLACK else PointState.BLACK_LINE
        )
        own_line = (
            PointState.BLACK_LINE if player == Player.BLACK else PointState.WHITE_LINE
        )
        ordered_moves = [[], [], []]

        for pos in moves:
            if game.grid[pos] == opponent_line:
                ordered_moves[0].append(pos)
            elif any(
                game.grid[adjacent] == own_line
                for adjacent in game._get_adjacent_positions(pos)
            ):
                ordered_moves[1].append(pos)
            else:
                ordered_moves[2].append(pos)

        return (ordered_moves[0] + ordered_moves[1] + ordered_moves[2])[:20]

    def minimax(
        self,
        game,
        depth: int,
        alpha: float,
        beta: float,
        maximizing_player: bool,
        ai_player: Player,
    ) -> float:
        if game.game_over:
            return game.evaluate(ai_player)
        if depth == 0:
            return game.evaluate(ai_player)

        legal_moves = self.get_legal_moves(game, game.current_player)
        if not legal_moves:
            snapshot = game._save_state()
            game.consecutive_skips += 1
            if game.consecutive_skips >= 2:
                game.game_over = True
            else:
                game._switch_player()
            score = self.minimax(
                game, depth - 1, alpha, beta, not maximizing_player, ai_player
            )
            game._restore_state(snapshot)
            return score

        ordered = self.order_moves(game, legal_moves, game.current_player)
        if maximizing_player:
            best_val = float("-inf")
            for pos in ordered:
                snapshot = game._save_state()
                game._apply_move_for_ai(pos)
                val = self.minimax(game, depth - 1, alpha, beta, False, ai_player)
                game._restore_state(snapshot)
                best_val = max(best_val, val)
                alpha = max(alpha, best_val)
                if beta <= alpha:
                    break
            return best_val

        best_val = float("inf")
        for pos in ordered:
            snapshot = game._save_state()
            game._apply_move_for_ai(pos)
            val = self.minimax(game, depth - 1, alpha, beta, True, ai_player)
            game._restore_state(snapshot)
            best_val = min(best_val, val)
            beta = min(beta, best_val)
            if beta <= alpha:
                break
        return best_val

    def get_best_move(
        self, game, ai_player: Player
    ) -> Optional[Tuple[int, int]]:
        legal_moves = self.get_legal_moves(game, ai_player)
        if not legal_moves:
            return None

        ordered = self.order_moves(game, legal_moves, ai_player)
        best_move = None
        best_val = float("-inf")
        for pos in ordered:
            snapshot = game._save_state()
            game._apply_move_for_ai(pos)
            val = self.minimax(
                game,
                self.depth - 1,
                float("-inf"),
                float("inf"),
                False,
                ai_player,
            )
            game._restore_state(snapshot)
            if val > best_val:
                best_val = val
                best_move = pos
        return best_move

    def get_top_moves(
        self, game, ai_player: Player, top_n: int = 5
    ) -> List[Tuple[Tuple[int, int], float]]:
        legal_moves = self.get_legal_moves(game, ai_player)
        if not legal_moves:
            return []

        ordered = self.order_moves(game, legal_moves, ai_player)
        scored_moves = []
        for pos in ordered:
            snapshot = game._save_state()
            game._apply_move_for_ai(pos)
            score = self.minimax(
                game,
                self.depth - 1,
                float("-inf"),
                float("inf"),
                False,
                ai_player,
            )
            game._restore_state(snapshot)
            scored_moves.append((pos, score))

        scored_moves.sort(key=lambda item: item[1], reverse=True)
        return scored_moves[:top_n]
