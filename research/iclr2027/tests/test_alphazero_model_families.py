from __future__ import annotations

import unittest

from lifeline_rl import LifelineGame

try:
    import torch
except ImportError:  # Core-only environments must still collect the suite.
    torch = None


@unittest.skipUnless(torch is not None, "PyTorch training extra is not installed")
class AlphaZeroModelFamilyTests(unittest.TestCase):
    @staticmethod
    def _forward(model, batch):
        return model(
            batch.node_features,
            batch.adjacency,
            batch.node_mask,
            batch.legal_action_mask,
        )

    def test_factory_exposes_three_preregistered_families(self) -> None:
        from lifeline_rl.alphazero.network import (
            MODEL_KINDS,
            NetworkConfig,
            TorchPolicyValueEvaluator,
            build_policy_value_network,
            observation_mode_for_model,
        )

        expected_modes = {
            "padded_cnn": "grid_graph",
            "grid_gnn": "grid_graph",
            "topology_gnn": "topology",
        }
        self.assertEqual(set(MODEL_KINDS), set(expected_modes))
        for model_kind, observation_mode in expected_modes.items():
            model = build_policy_value_network(model_kind, NetworkConfig(8, 1))
            self.assertEqual(model.model_kind, model_kind)
            self.assertEqual(model.observation_mode, observation_mode)
            self.assertEqual(observation_mode_for_model(model_kind), observation_mode)
            self.assertGreater(model.parameter_count, 0)
            evaluation = TorchPolicyValueEvaluator(model).evaluate(LifelineGame(5))
            self.assertEqual(len(evaluation.priors), LifelineGame(5).num_points + 1)
            self.assertAlmostEqual(sum(evaluation.priors), 1.0, places=6)
        with self.assertRaises(ValueError):
            build_policy_value_network("unknown", NetworkConfig(8, 1))

    def test_all_families_support_mixed_sizes_pass_and_masked_training(self) -> None:
        from lifeline_rl.alphazero.network import (
            MODEL_KINDS,
            NetworkConfig,
            build_policy_value_network,
            collate_positions,
            observation_mode_for_model,
        )

        torch.manual_seed(11)
        games = [LifelineGame(5), LifelineGame(7)]
        for model_kind in MODEL_KINDS:
            batch = collate_positions(
                games,
                observation_mode_for_model(model_kind),
            )
            model = build_policy_value_network(model_kind, NetworkConfig(8, 1))
            logits, values = self._forward(model, batch)
            self.assertEqual(tuple(logits.shape), (2, games[1].num_points + 1))
            self.assertEqual(tuple(values.shape), (2,))
            self.assertTrue(bool(torch.isfinite(values).all()))
            probabilities = torch.softmax(logits, dim=1)
            self.assertEqual(float(probabilities[~batch.legal_action_mask].sum()), 0.0)
            loss = -torch.log_softmax(logits, dim=1)[
                torch.arange(2), games[1].num_points
            ].mean() + values.square().mean()
            model.zero_grad(set_to_none=True)
            loss.backward()
            gradients = [
                parameter.grad
                for parameter in model.parameters()
                if parameter.grad is not None
            ]
            self.assertTrue(gradients)
            self.assertTrue(all(bool(torch.isfinite(grad).all()) for grad in gradients))

    def test_grid_gnn_and_cnn_cannot_consume_logical_relations(self) -> None:
        from lifeline_rl.alphazero.network import (
            NetworkConfig,
            build_policy_value_network,
            collate_positions,
        )

        torch.manual_seed(19)
        game = LifelineGame(5)
        self.assertTrue(game.play_move((0, 3)).success)
        grid_batch = collate_positions([game], "grid_graph")
        topology_batch = collate_positions([game], "topology")
        self.assertGreater(float(topology_batch.adjacency[:, 1:].sum()), 0.0)

        for model_kind in ("padded_cnn", "grid_gnn"):
            model = build_policy_value_network(model_kind, NetworkConfig(8, 1)).eval()
            grid_output = self._forward(model, grid_batch)
            topology_output = self._forward(model, topology_batch)
            for first, second in zip(grid_output, topology_output):
                self.assertTrue(torch.equal(first, second), model_kind)

        topology_model = build_policy_value_network(
            "topology_gnn", NetworkConfig(8, 1)
        ).eval()
        grid_logits, grid_value = self._forward(topology_model, grid_batch)
        topology_logits, topology_value = self._forward(topology_model, topology_batch)
        self.assertTrue(
            not torch.equal(grid_logits, topology_logits)
            or not torch.equal(grid_value, topology_value)
        )

    def test_padded_cnn_small_position_is_invariant_to_batch_padding(self) -> None:
        from lifeline_rl.alphazero.network import (
            NetworkConfig,
            build_policy_value_network,
            collate_positions,
        )

        torch.manual_seed(23)
        small = LifelineGame(5)
        large = LifelineGame(9)
        single = collate_positions([small], "grid_graph")
        mixed = collate_positions([small, large], "grid_graph")
        model = build_policy_value_network("padded_cnn", NetworkConfig(8, 2)).eval()
        single_logits, single_value = self._forward(model, single)
        mixed_logits, mixed_value = self._forward(model, mixed)
        self.assertTrue(
            torch.allclose(
                single_logits[0, : small.num_points],
                mixed_logits[0, : small.num_points],
                rtol=1e-6,
                atol=1e-6,
            )
        )
        self.assertTrue(
            torch.allclose(single_logits[0, -1], mixed_logits[0, -1], atol=1e-6)
        )
        self.assertTrue(torch.allclose(single_value[0], mixed_value[0], atol=1e-6))

    def test_parameter_budget_matching_reports_ratio_and_preserves_rng(self) -> None:
        from lifeline_rl.alphazero.network import (
            NetworkConfig,
            match_model_families,
        )

        torch.manual_seed(29)
        state_before = torch.random.get_rng_state().clone()
        matches = match_model_families("topology_gnn", NetworkConfig(64, 3))
        self.assertTrue(torch.equal(state_before, torch.random.get_rng_state()))
        self.assertEqual(set(matches), {"padded_cnn", "grid_gnn", "topology_gnn"})
        for model_kind, match in matches.items():
            self.assertEqual(match.model_kind, model_kind)
            self.assertLess(match.relative_error, 0.01)
            self.assertAlmostEqual(
                match.ratio,
                match.parameter_count / match.target_parameter_count,
            )
            self.assertEqual(match.to_dict()["config"], match.config.to_dict())


if __name__ == "__main__":
    unittest.main()
