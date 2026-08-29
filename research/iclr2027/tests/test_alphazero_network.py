from __future__ import annotations

import math
import types
import unittest

from lifeline_rl import LifelineGame, Player

try:
    import torch
except ImportError:  # Core-only environments must still collect the suite.
    torch = None


@unittest.skipUnless(torch is not None, "PyTorch training extra is not installed")
class AlphaZeroNetworkTests(unittest.TestCase):
    @staticmethod
    def _experience(game: LifelineGame, visits: tuple[int, ...]):
        legal = set(game.legal_moves())
        return types.SimpleNamespace(
            grid_size=game.grid_size,
            board=tuple(game.grid),
            physical_edges=game.physical_edges,
            logical_edges=(
                tuple(sorted(game.edges[Player.BLACK])),
                tuple(sorted(game.edges[Player.WHITE])),
            ),
            current_player=game.current_player.value,
            consecutive_skips=game.consecutive_skips,
            legal_action_mask=tuple(
                int(point in legal) for point in game.valid_positions
            )
            + (1,),
            root_visits=visits,
            z=0.0,
        )

    def test_mixed_size_padding_relocates_each_pass_target(self) -> None:
        from lifeline_rl.alphazero.network import collate_positions

        small = LifelineGame(5)
        large = LifelineGame(7)
        small_visits = (0,) * small.num_points + (4,)
        large_visits = (0,) * large.num_points + (4,)
        batch = collate_positions(
            [self._experience(small, small_visits), self._experience(large, large_visits)],
            "grid_graph",
        )
        self.assertEqual(tuple(batch.policy_targets.shape), (2, large.num_points + 1))
        self.assertEqual(float(batch.policy_targets[0, -1]), 1.0)
        self.assertEqual(float(batch.policy_targets[1, -1]), 1.0)
        self.assertFalse(bool(batch.node_mask[0, small.num_points:].any()))
        self.assertFalse(bool(batch.legal_action_mask[0, small.num_points:-1].any()))

    def test_representation_changes_relations_not_parameters(self) -> None:
        from lifeline_rl.alphazero.network import (
            NetworkConfig,
            PolicyValueNetwork,
            collate_positions,
        )

        game = LifelineGame(5)
        self.assertTrue(game.play_move((0, 3)).success)
        grid = collate_positions([game], "grid_graph")
        topology = collate_positions([game], "topology")
        self.assertEqual(float(grid.adjacency[:, 1:].sum()), 0.0)
        self.assertGreater(float(topology.adjacency[:, 1:].sum()), 0.0)

        first = PolicyValueNetwork(NetworkConfig(16, 1))
        second = PolicyValueNetwork(NetworkConfig(16, 1))
        self.assertEqual(first.parameter_count, second.parameter_count)

    def test_masked_policy_value_training_step_is_finite(self) -> None:
        from lifeline_rl.alphazero.network import (
            NetworkConfig,
            PolicyValueNetwork,
            collate_positions,
        )

        torch.manual_seed(7)
        game = LifelineGame(5)
        legal_indices = [
            index
            for index, point in enumerate(game.valid_positions)
            if point in set(game.legal_moves())
        ] + [game.num_points]
        visits = tuple(1 if index in legal_indices else 0 for index in range(game.num_points + 1))
        batch = collate_positions([self._experience(game, visits)], "grid_graph")
        model = PolicyValueNetwork(NetworkConfig(16, 1))
        optimizer = torch.optim.AdamW(model.parameters(), lr=1e-3)
        before = [parameter.detach().clone() for parameter in model.parameters()]
        logits, values = model(
            batch.node_features,
            batch.adjacency,
            batch.node_mask,
            batch.legal_action_mask,
        )
        probabilities = torch.softmax(logits, dim=1)
        self.assertEqual(
            float(probabilities[~batch.legal_action_mask].sum()),
            0.0,
        )
        policy_loss = -(batch.policy_targets * torch.log_softmax(logits, dim=1)).sum(1).mean()
        value_loss = torch.mean((values - batch.value_targets) ** 2)
        loss = policy_loss + value_loss
        self.assertTrue(math.isfinite(float(loss)))
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        optimizer.step()
        self.assertTrue(
            any(not torch.equal(old, new) for old, new in zip(before, model.parameters()))
        )


if __name__ == "__main__":
    unittest.main()
