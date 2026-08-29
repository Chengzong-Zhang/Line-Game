from __future__ import annotations

import unittest

from lifeline_rl.alphazero.config import AlphaZeroConfig


class AlphaZeroConfigTests(unittest.TestCase):
    def test_legacy_representation_configs_infer_explicit_model_family(self) -> None:
        grid = AlphaZeroConfig.from_dict({"observation_mode": "grid_graph"})
        topology = AlphaZeroConfig.from_dict({"observation_mode": "topology"})
        self.assertEqual(grid.model_kind, "grid_gnn")
        self.assertEqual(topology.model_kind, "topology_gnn")

    def test_three_model_families_round_trip(self) -> None:
        pairs = (
            ("padded_cnn", "grid_graph"),
            ("grid_gnn", "grid_graph"),
            ("topology_gnn", "topology"),
        )
        for model_kind, observation_mode in pairs:
            with self.subTest(model_kind=model_kind):
                config = AlphaZeroConfig(
                    model_kind=model_kind,
                    observation_mode=observation_mode,
                )
                restored = AlphaZeroConfig.from_dict(config.to_dict())
                self.assertEqual(restored, config)

    def test_model_and_observation_mismatch_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "requires observation_mode"):
            AlphaZeroConfig(model_kind="topology_gnn", observation_mode="grid_graph")
        with self.assertRaisesRegex(ValueError, "model_kind"):
            AlphaZeroConfig(model_kind="invented")


if __name__ == "__main__":
    unittest.main()
