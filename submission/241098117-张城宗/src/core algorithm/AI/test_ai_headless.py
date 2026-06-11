import os

os.environ["SDL_VIDEODRIVER"] = "dummy"

import pygame

pygame.init()

import sys

sys.path.insert(
    0, os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
)

from ai_engine import MinimaxAI
from ai_game import AITriangularGame


def main() -> None:
    game = AITriangularGame()
    ai = MinimaxAI(depth=2)
    successful_moves = 0

    for step in range(5):
        player = game.current_player
        move = ai.get_best_move(game, player)
        score = game.evaluate(player)

        if move is None:
            print(f"Step {step + 1}: AI({player.name}) -> skip, score={score:.1f}")
            game.handle_skip()
        else:
            assert game._is_legal_move(move, player), (
                f"AI returned illegal move {move} for {player.name}"
            )
            before_hash = game._compute_state_hash(player)
            game.handle_click(game._get_screen_pos(*move))
            after_hash = game._compute_state_hash(game.current_player)

            assert before_hash != after_hash, f"Move {move} did not change the board"
            assert game.current_player != player or game.game_over, (
                f"Turn did not switch after {player.name} played {move}"
            )
            successful_moves += 1
            print(
                f"Step {step + 1}: AI({player.name}) -> {move}, "
                f"score={score:.1f}"
            )

        if game.game_over:
            break

    pygame.quit()
    assert successful_moves > 0, "AI did not make any move"
    print(f"验证通过：AI 成功完成 {successful_moves} 次合法走棋")


if __name__ == "__main__":
    main()
