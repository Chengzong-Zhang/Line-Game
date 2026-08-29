"""Pure-PyTorch CNN, Grid-GNN, and Topology-GNN policy/value families.

PyTorch is deliberately an optional dependency.  Importing :mod:`lifeline_rl`
or the dependency-free PUCT/replay modules does not import this file.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable, Mapping, Sequence

try:
    import torch
    from torch import Tensor, nn
except ImportError as exc:  # pragma: no cover - exercised in the core-only env
    raise ImportError(
        "AlphaZero neural training requires PyTorch; install the 'train' extra "
        "with: python -m pip install -e .\\research\\iclr2027[train]"
    ) from exc

from ..core import LifelineGame, Player, PointState
from .puct import PolicyValue


MODEL_OBSERVATION_MODES = ("grid_graph", "topology")
MODEL_KINDS = ("padded_cnn", "grid_gnn", "topology_gnn")
NODE_FEATURES = 11
RELATION_COUNT = 3  # physical lattice, current-player logical, opponent logical

_OBSERVATION_MODE_BY_MODEL_KIND = {
    "padded_cnn": "grid_graph",
    "grid_gnn": "grid_graph",
    "topology_gnn": "topology",
}


@dataclass(frozen=True)
class NetworkConfig:
    """Shared depth/width controls for every policy/value model family.

    ``message_passing_layers`` denotes graph-message blocks for a GNN and
    masked residual-convolution blocks for the padded CNN.  Widths are allowed
    to differ between model families when matching a parameter budget.
    """

    hidden_channels: int = 64
    message_passing_layers: int = 3

    def __post_init__(self) -> None:
        if self.hidden_channels < 4:
            raise ValueError("hidden_channels must be at least 4")
        if self.message_passing_layers < 1:
            raise ValueError("message_passing_layers must be at least 1")

    def to_dict(self) -> dict[str, int]:
        return {
            "hidden_channels": self.hidden_channels,
            "message_passing_layers": self.message_passing_layers,
        }

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "NetworkConfig":
        return cls(
            hidden_channels=int(data["hidden_channels"]),
            message_passing_layers=int(data["message_passing_layers"]),
        )


@dataclass(frozen=True)
class TensorBatch:
    """Padded mixed-board-size batch; the final column always means PASS."""

    node_features: Tensor
    adjacency: Tensor
    node_mask: Tensor
    legal_action_mask: Tensor
    policy_targets: Tensor | None = None
    value_targets: Tensor | None = None

    def to(self, device: str | torch.device) -> "TensorBatch":
        return TensorBatch(
            node_features=self.node_features.to(device),
            adjacency=self.adjacency.to(device),
            node_mask=self.node_mask.to(device),
            legal_action_mask=self.legal_action_mask.to(device),
            policy_targets=(
                None if self.policy_targets is None else self.policy_targets.to(device)
            ),
            value_targets=(
                None if self.value_targets is None else self.value_targets.to(device)
            ),
        )


def observation_mode_for_model(model_kind: str) -> str:
    """Return the observation encoder required by ``model_kind``."""

    try:
        return _OBSERVATION_MODE_BY_MODEL_KIND[model_kind]
    except (KeyError, TypeError) as exc:
        raise ValueError(f"model_kind must be one of {MODEL_KINDS}") from exc


def _validate_forward_inputs(
    node_features: Tensor,
    adjacency: Tensor,
    node_mask: Tensor,
    legal_action_mask: Tensor,
) -> tuple[int, int, Tensor]:
    if node_features.ndim != 3 or node_features.shape[-1] != NODE_FEATURES:
        raise ValueError("node_features must have shape [batch, nodes, 11]")
    batch, nodes, _ = node_features.shape
    if adjacency.shape != (batch, RELATION_COUNT, nodes, nodes):
        raise ValueError("adjacency has an incompatible shape")
    if node_mask.shape != (batch, nodes):
        raise ValueError("node_mask has an incompatible shape")
    if legal_action_mask.shape != (batch, nodes + 1):
        raise ValueError("legal_action_mask has an incompatible shape")
    if not bool(torch.all(legal_action_mask.bool().any(dim=1))):
        raise ValueError("terminal/all-masked positions cannot be evaluated")
    mask = node_mask.to(dtype=node_features.dtype)
    return batch, nodes, mask


class _RelationalBlock(nn.Module):
    def __init__(self, channels: int, relation_count: int = RELATION_COUNT):
        super().__init__()
        self.self_projection = nn.Linear(channels, channels)
        self.relation_projections = nn.ModuleList(
            nn.Linear(channels, channels, bias=False) for _ in range(relation_count)
        )
        self.normalization = nn.LayerNorm(channels)

    def forward(self, hidden: Tensor, adjacency: Tensor, node_mask: Tensor) -> Tensor:
        update = self.self_projection(hidden)
        for relation, projection in enumerate(self.relation_projections):
            messages = torch.bmm(adjacency[:, relation], hidden)
            update = update + projection(messages)
        hidden = self.normalization(hidden + torch.relu(update))
        return hidden * node_mask.unsqueeze(-1)


class PolicyValueNetwork(nn.Module):
    """Backward-compatible three-relation topology policy/value network.

    New code should construct an explicit model family through
    :func:`build_policy_value_network`.  Keeping this class preserves D9--D10
    checkpoints and the original ``PolicyValueNetwork(NetworkConfig(...))``
    API.
    """

    model_kind = "topology_gnn"
    observation_mode = "topology"

    def __init__(
        self,
        config: NetworkConfig | None = None,
        *,
        _relation_indices: tuple[int, ...] = tuple(range(RELATION_COUNT)),
    ):
        super().__init__()
        self.config = config or NetworkConfig()
        if not _relation_indices or any(
            relation < 0 or relation >= RELATION_COUNT
            for relation in _relation_indices
        ):
            raise ValueError("relation indices are outside the encoded relations")
        self._relation_indices = _relation_indices
        channels = self.config.hidden_channels
        self.input_projection = nn.Linear(NODE_FEATURES, channels)
        self.blocks = nn.ModuleList(
            _RelationalBlock(channels, len(self._relation_indices))
            for _ in range(self.config.message_passing_layers)
        )
        self.point_policy = nn.Sequential(
            nn.Linear(channels, channels),
            nn.ReLU(),
            nn.Linear(channels, 1),
        )
        self.pass_policy = nn.Sequential(
            nn.Linear(channels, channels),
            nn.ReLU(),
            nn.Linear(channels, 1),
        )
        self.value_head = nn.Sequential(
            nn.Linear(channels, channels),
            nn.ReLU(),
            nn.Linear(channels, 1),
            nn.Tanh(),
        )

    def forward(
        self,
        node_features: Tensor,
        adjacency: Tensor,
        node_mask: Tensor,
        legal_action_mask: Tensor,
    ) -> tuple[Tensor, Tensor]:
        _, _, mask = _validate_forward_inputs(
            node_features,
            adjacency,
            node_mask,
            legal_action_mask,
        )
        hidden = torch.relu(self.input_projection(node_features)) * mask.unsqueeze(-1)
        selected_adjacency = adjacency[:, self._relation_indices]
        for block in self.blocks:
            hidden = block(hidden, selected_adjacency, mask)

        denominator = mask.sum(dim=1, keepdim=True).clamp_min(1.0)
        pooled = hidden.sum(dim=1) / denominator
        point_logits = self.point_policy(hidden).squeeze(-1)
        pass_logit = self.pass_policy(pooled)
        logits = torch.cat((point_logits, pass_logit), dim=1)
        logits = logits.masked_fill(~legal_action_mask.bool(), torch.finfo(logits.dtype).min)
        value = self.value_head(pooled).squeeze(-1)
        return logits, value

    @property
    def parameter_count(self) -> int:
        return sum(parameter.numel() for parameter in self.parameters())


class GridGNNPolicyValueNetwork(PolicyValueNetwork):
    """GNN baseline that can consume only physical triangular-lattice edges."""

    model_kind = "grid_gnn"
    observation_mode = "grid_graph"

    def __init__(self, config: NetworkConfig | None = None):
        super().__init__(config, _relation_indices=(0,))


class TopologyGNNPolicyValueNetwork(PolicyValueNetwork):
    """Relation-GNN over physical, own-logical, and opponent-logical edges."""

    model_kind = "topology_gnn"
    observation_mode = "topology"


class _PaddedCNNBlock(nn.Module):
    """Residual convolution whose padding is zeroed after every block."""

    def __init__(self, channels: int):
        super().__init__()
        self.first = nn.Conv2d(channels, channels, kernel_size=3, padding=1)
        self.second = nn.Conv2d(channels, channels, kernel_size=3, padding=1)

    def forward(self, hidden: Tensor, spatial_mask: Tensor) -> Tensor:
        update = torch.relu(self.first(hidden)) * spatial_mask
        update = self.second(update)
        return torch.relu(hidden + update) * spatial_mask


def _triangle_side(point_count: int) -> int:
    """Return ``s`` for ``point_count == s * (s + 1) // 2``."""

    if point_count <= 0:
        raise ValueError("each batch row must contain at least one board point")
    side = (int((8 * point_count + 1) ** 0.5) - 1) // 2
    if side * (side + 1) // 2 != point_count:
        raise ValueError("node_mask does not describe a triangular board")
    return side


def _nodes_to_padded_triangle(
    node_features: Tensor,
    node_mask: Tensor,
) -> tuple[Tensor, Tensor, tuple[int, ...]]:
    """Map row-major triangular nodes to a masked square CNN tensor."""

    batch, nodes, channels = node_features.shape
    counts = tuple(int(value) for value in node_mask.sum(dim=1).detach().cpu().tolist())
    sides = tuple(_triangle_side(count) for count in counts)
    expected_mask = (
        torch.arange(nodes, device=node_mask.device).unsqueeze(0)
        < node_mask.sum(dim=1, keepdim=True)
    )
    if not bool(torch.equal(node_mask.bool(), expected_mask)):
        raise ValueError("node_mask must be a contiguous prefix for every board")

    max_side = max(sides)
    padded = node_features.new_zeros((batch, channels, max_side, max_side))
    spatial_mask = node_features.new_zeros((batch, 1, max_side, max_side))
    for batch_index, side in enumerate(sides):
        cursor = 0
        for y_coordinate in range(side):
            row_width = side - y_coordinate
            next_cursor = cursor + row_width
            padded[batch_index, :, y_coordinate, :row_width] = node_features[
                batch_index, cursor:next_cursor
            ].transpose(0, 1)
            spatial_mask[batch_index, :, y_coordinate, :row_width] = 1.0
            cursor = next_cursor
    return padded, spatial_mask, sides


def _padded_triangle_to_nodes(
    padded: Tensor,
    sides: tuple[int, ...],
    nodes: int,
) -> Tensor:
    """Invert :func:`_nodes_to_padded_triangle` while retaining batch padding."""

    batch, channels, _, _ = padded.shape
    flattened = padded.new_zeros((batch, nodes, channels))
    for batch_index, side in enumerate(sides):
        cursor = 0
        for y_coordinate in range(side):
            row_width = side - y_coordinate
            next_cursor = cursor + row_width
            flattened[batch_index, cursor:next_cursor] = padded[
                batch_index, :, y_coordinate, :row_width
            ].transpose(0, 1)
            cursor = next_cursor
    return flattened


class PaddedCNNPolicyValueNetwork(nn.Module):
    """Topology-blind baseline over a zero-padded triangular board image."""

    model_kind = "padded_cnn"
    observation_mode = "grid_graph"

    def __init__(self, config: NetworkConfig | None = None):
        super().__init__()
        self.config = config or NetworkConfig()
        channels = self.config.hidden_channels
        self.input_projection = nn.Conv2d(NODE_FEATURES, channels, kernel_size=1)
        self.blocks = nn.ModuleList(
            _PaddedCNNBlock(channels)
            for _ in range(self.config.message_passing_layers)
        )
        self.point_policy = nn.Sequential(
            nn.Linear(channels, channels),
            nn.ReLU(),
            nn.Linear(channels, 1),
        )
        self.pass_policy = nn.Sequential(
            nn.Linear(channels, channels),
            nn.ReLU(),
            nn.Linear(channels, 1),
        )
        self.value_head = nn.Sequential(
            nn.Linear(channels, channels),
            nn.ReLU(),
            nn.Linear(channels, 1),
            nn.Tanh(),
        )

    def forward(
        self,
        node_features: Tensor,
        adjacency: Tensor,
        node_mask: Tensor,
        legal_action_mask: Tensor,
    ) -> tuple[Tensor, Tensor]:
        _, nodes, mask = _validate_forward_inputs(
            node_features,
            adjacency,
            node_mask,
            legal_action_mask,
        )
        padded, spatial_mask, sides = _nodes_to_padded_triangle(
            node_features,
            node_mask,
        )
        hidden_image = torch.relu(self.input_projection(padded)) * spatial_mask
        for block in self.blocks:
            hidden_image = block(hidden_image, spatial_mask)
        hidden = _padded_triangle_to_nodes(hidden_image, sides, nodes)
        hidden = hidden * mask.unsqueeze(-1)

        denominator = mask.sum(dim=1, keepdim=True).clamp_min(1.0)
        pooled = hidden.sum(dim=1) / denominator
        point_logits = self.point_policy(hidden).squeeze(-1)
        pass_logit = self.pass_policy(pooled)
        logits = torch.cat((point_logits, pass_logit), dim=1)
        logits = logits.masked_fill(
            ~legal_action_mask.bool(), torch.finfo(logits.dtype).min
        )
        value = self.value_head(pooled).squeeze(-1)
        return logits, value

    @property
    def parameter_count(self) -> int:
        return sum(parameter.numel() for parameter in self.parameters())


def build_policy_value_network(
    model_kind: str,
    config: NetworkConfig | None = None,
) -> PolicyValueNetwork | PaddedCNNPolicyValueNetwork:
    """Construct one of the preregistered D11--D12 model families."""

    constructors: dict[str, type[nn.Module]] = {
        "padded_cnn": PaddedCNNPolicyValueNetwork,
        "grid_gnn": GridGNNPolicyValueNetwork,
        "topology_gnn": TopologyGNNPolicyValueNetwork,
    }
    try:
        constructor = constructors[model_kind]
    except (KeyError, TypeError) as exc:
        raise ValueError(f"model_kind must be one of {MODEL_KINDS}") from exc
    model = constructor(config)
    assert isinstance(model, (PolicyValueNetwork, PaddedCNNPolicyValueNetwork))
    return model


# A descriptive alias for callers that prefer ``create_*`` naming.
create_policy_value_network = build_policy_value_network
PolicyValueModel = PolicyValueNetwork | PaddedCNNPolicyValueNetwork


@dataclass(frozen=True)
class ParameterBudgetMatch:
    """Nearest integer-width architecture for a requested parameter budget."""

    model_kind: str
    target_parameter_count: int
    config: NetworkConfig
    parameter_count: int

    @property
    def ratio(self) -> float:
        return self.parameter_count / self.target_parameter_count

    @property
    def relative_error(self) -> float:
        absolute_error = abs(self.parameter_count - self.target_parameter_count)
        return absolute_error / self.target_parameter_count

    def to_dict(self) -> dict[str, Any]:
        return {
            "model_kind": self.model_kind,
            "target_parameter_count": self.target_parameter_count,
            "parameter_count": self.parameter_count,
            "ratio": self.ratio,
            "relative_error": self.relative_error,
            "config": self.config.to_dict(),
        }


def match_parameter_budget(
    model_kind: str,
    target_parameter_count: int,
    *,
    message_passing_layers: int = 3,
    minimum_hidden_channels: int = 4,
    maximum_hidden_channels: int = 512,
) -> ParameterBudgetMatch:
    """Find the closest model width without perturbing the caller's RNG state."""

    observation_mode_for_model(model_kind)
    if (
        isinstance(target_parameter_count, bool)
        or not isinstance(target_parameter_count, int)
        or target_parameter_count <= 0
    ):
        raise ValueError("target_parameter_count must be a positive integer")
    if minimum_hidden_channels < 4:
        raise ValueError("minimum_hidden_channels must be at least 4")
    if maximum_hidden_channels < minimum_hidden_channels:
        raise ValueError(
            "maximum_hidden_channels must be at least minimum_hidden_channels"
        )

    def candidate(width: int) -> ParameterBudgetMatch:
        config = NetworkConfig(width, message_passing_layers)
        # Model initialization consumes random numbers.  Budget planning must
        # not silently alter a subsequent seeded training run.
        with torch.random.fork_rng(devices=[]):
            model = build_policy_value_network(model_kind, config)
        return ParameterBudgetMatch(
            model_kind=model_kind,
            target_parameter_count=target_parameter_count,
            config=config,
            parameter_count=model.parameter_count,
        )

    low = minimum_hidden_channels
    high = maximum_hidden_channels
    nearest: ParameterBudgetMatch | None = None
    while low <= high:
        width = (low + high) // 2
        current = candidate(width)
        if nearest is None or (
            current.relative_error,
            current.config.hidden_channels,
        ) < (
            nearest.relative_error,
            nearest.config.hidden_channels,
        ):
            nearest = current
        if current.parameter_count < target_parameter_count:
            low = width + 1
        elif current.parameter_count > target_parameter_count:
            high = width - 1
        else:
            break

    # Check the two integer widths surrounding the crossing explicitly.
    for width in {high, low}:
        if minimum_hidden_channels <= width <= maximum_hidden_channels:
            current = candidate(width)
            if nearest is None or (
                current.relative_error,
                current.config.hidden_channels,
            ) < (
                nearest.relative_error,
                nearest.config.hidden_channels,
            ):
                nearest = current
    assert nearest is not None
    return nearest


def match_model_families(
    reference_model_kind: str,
    reference_config: NetworkConfig,
    *,
    model_kinds: Sequence[str] = MODEL_KINDS,
    minimum_hidden_channels: int = 4,
    maximum_hidden_channels: int = 512,
) -> dict[str, ParameterBudgetMatch]:
    """Match all requested families to one reference model's parameter count."""

    with torch.random.fork_rng(devices=[]):
        reference = build_policy_value_network(reference_model_kind, reference_config)
    target = reference.parameter_count
    matches: dict[str, ParameterBudgetMatch] = {}
    for model_kind in model_kinds:
        matches[model_kind] = match_parameter_budget(
            model_kind,
            target,
            message_passing_layers=reference_config.message_passing_layers,
            minimum_hidden_channels=minimum_hidden_channels,
            maximum_hidden_channels=maximum_hidden_channels,
        )
    return matches


def _logical_edge_pair(raw: Any) -> tuple[Sequence[Sequence[int]], Sequence[Sequence[int]]]:
    if isinstance(raw, Mapping):
        return raw[Player.BLACK.value], raw[Player.WHITE.value]
    if isinstance(raw, Sequence) and len(raw) == 2:
        return raw[0], raw[1]
    raise ValueError("logical_edges must contain BLACK and WHITE relations")


def _position_fields(position: Any) -> dict[str, Any]:
    if isinstance(position, LifelineGame):
        if position.game_over:
            raise ValueError("terminal positions are not network inputs")
        legal = set(position.legal_moves())
        return {
            "grid_size": position.grid_size,
            "board": tuple(position.grid),
            "physical_edges": position.physical_edges,
            "logical_edges": (
                tuple(sorted(position.edges[Player.BLACK])),
                tuple(sorted(position.edges[Player.WHITE])),
            ),
            "current_player": position.current_player.value,
            "consecutive_skips": position.consecutive_skips,
            "legal_action_mask": tuple(
                int(point in legal) for point in position.valid_positions
            )
            + (1,),
            "root_visits": None,
            "z": None,
        }
    return {
        "grid_size": int(position.grid_size),
        "board": tuple(position.board),
        "physical_edges": tuple(position.physical_edges),
        "logical_edges": position.logical_edges,
        "current_player": str(position.current_player),
        "consecutive_skips": int(getattr(position, "consecutive_skips", 0)),
        "legal_action_mask": tuple(position.legal_action_mask),
        "root_visits": tuple(position.root_visits),
        "z": float(position.z),
    }


def _node_features(fields: Mapping[str, Any], geometry: LifelineGame) -> list[list[float]]:
    player = Player(fields["current_player"])
    opponent = LifelineGame.opponent(player)
    own_node = PointState.BLACK_NODE if player is Player.BLACK else PointState.WHITE_NODE
    own_line = PointState.BLACK_LINE if player is Player.BLACK else PointState.WHITE_LINE
    opponent_node = (
        PointState.BLACK_NODE if opponent is Player.BLACK else PointState.WHITE_NODE
    )
    opponent_line = (
        PointState.BLACK_LINE if opponent is Player.BLACK else PointState.WHITE_LINE
    )
    categories = (
        PointState.EMPTY,
        own_node,
        own_line,
        opponent_node,
        opponent_line,
    )
    scale = float(geometry.grid_size - 1)
    skips = min(max(int(fields.get("consecutive_skips", 0)), 0), 2) / 2.0
    boundary = set(geometry.boundary_indices)
    own_start = geometry.point_to_index[geometry.initial_positions[player]]
    opponent_start = geometry.point_to_index[geometry.initial_positions[opponent]]
    features: list[list[float]] = []
    for index, (point, raw_state) in enumerate(zip(geometry.valid_positions, fields["board"])):
        state = PointState(int(raw_state))
        features.append(
            [float(state == category) for category in categories]
            + [
                point[0] / scale,
                point[1] / scale,
                float(index in boundary),
                float(index == own_start),
                float(index == opponent_start),
                skips,
            ]
        )
    return features


def collate_positions(
    positions: Iterable[Any],
    observation_mode: str,
    *,
    device: str | torch.device = "cpu",
) -> TensorBatch:
    """Encode games or replay experiences with explicit mixed-size padding."""

    if observation_mode not in MODEL_OBSERVATION_MODES:
        raise ValueError(f"observation_mode must be one of {MODEL_OBSERVATION_MODES}")
    fields_batch = [_position_fields(position) for position in positions]
    if not fields_batch:
        raise ValueError("cannot collate an empty batch")
    max_nodes = max(len(fields["board"]) for fields in fields_batch)
    batch_size = len(fields_batch)
    node_features = torch.zeros(batch_size, max_nodes, NODE_FEATURES, dtype=torch.float32)
    adjacency = torch.zeros(
        batch_size,
        RELATION_COUNT,
        max_nodes,
        max_nodes,
        dtype=torch.float32,
    )
    node_mask = torch.zeros(batch_size, max_nodes, dtype=torch.bool)
    legal_mask = torch.zeros(batch_size, max_nodes + 1, dtype=torch.bool)
    target_flags = [fields["root_visits"] is not None for fields in fields_batch]
    if any(target_flags) and not all(target_flags):
        raise ValueError("cannot mix target-bearing experiences with inference positions")
    has_targets = all(target_flags)
    policy_targets = (
        torch.zeros(batch_size, max_nodes + 1, dtype=torch.float32)
        if has_targets
        else None
    )
    value_targets = (
        torch.zeros(batch_size, dtype=torch.float32) if has_targets else None
    )

    for batch_index, fields in enumerate(fields_batch):
        geometry = LifelineGame(fields["grid_size"])
        nodes = geometry.num_points
        if len(fields["board"]) != nodes:
            raise ValueError("board length does not match grid_size")
        node_features[batch_index, :nodes] = torch.tensor(
            _node_features(fields, geometry), dtype=torch.float32
        )
        node_mask[batch_index, :nodes] = True

        black_edges, white_edges = _logical_edge_pair(fields["logical_edges"])
        player = Player(fields["current_player"])
        own_edges, opponent_edges = (
            (black_edges, white_edges)
            if player is Player.BLACK
            else (white_edges, black_edges)
        )
        relations: tuple[Sequence[Sequence[int]], ...] = (
            fields["physical_edges"],
            own_edges if observation_mode == "topology" else (),
            opponent_edges if observation_mode == "topology" else (),
        )
        for relation_index, edges in enumerate(relations):
            for raw_edge in edges:
                first, second = int(raw_edge[0]), int(raw_edge[1])
                if not (0 <= first < nodes and 0 <= second < nodes and first != second):
                    raise ValueError("relation edge is outside the board")
                adjacency[batch_index, relation_index, first, second] = 1.0
                adjacency[batch_index, relation_index, second, first] = 1.0
        degrees = adjacency[batch_index, :, :nodes, :nodes].sum(dim=-1, keepdim=True)
        adjacency[batch_index, :, :nodes, :nodes] /= degrees.clamp_min(1.0)

        raw_legal = tuple(bool(value) for value in fields["legal_action_mask"])
        if len(raw_legal) != nodes + 1 or not any(raw_legal):
            raise ValueError("experience has an invalid legal-action mask")
        legal_mask[batch_index, :nodes] = torch.tensor(raw_legal[:nodes])
        legal_mask[batch_index, max_nodes] = raw_legal[nodes]

        if has_targets:
            assert policy_targets is not None and value_targets is not None
            visits = tuple(int(value) for value in fields["root_visits"])
            if len(visits) != nodes + 1 or any(value < 0 for value in visits):
                raise ValueError("experience has invalid root visits")
            total = sum(visits)
            if total <= 0:
                raise ValueError("experience root visits must have positive mass")
            policy_targets[batch_index, :nodes] = torch.tensor(
                visits[:nodes], dtype=torch.float32
            ) / float(total)
            policy_targets[batch_index, max_nodes] = visits[nodes] / float(total)
            if bool((policy_targets[batch_index] > 0)[~legal_mask[batch_index]].any()):
                raise ValueError("illegal actions cannot have target visits")
            value_targets[batch_index] = float(fields["z"])

    return TensorBatch(
        node_features=node_features.to(device),
        adjacency=adjacency.to(device),
        node_mask=node_mask.to(device),
        legal_action_mask=legal_mask.to(device),
        policy_targets=(None if policy_targets is None else policy_targets.to(device)),
        value_targets=(None if value_targets is None else value_targets.to(device)),
    )


class TorchPolicyValueEvaluator:
    """Adapter from a PyTorch network to the dependency-free PUCT protocol."""

    def __init__(
        self,
        model: PolicyValueModel,
        observation_mode: str | None = None,
        device: str | torch.device = "cpu",
    ):
        if observation_mode is None:
            observation_mode = getattr(model, "observation_mode", None)
        if observation_mode not in MODEL_OBSERVATION_MODES:
            raise ValueError(f"observation_mode must be one of {MODEL_OBSERVATION_MODES}")
        self.model = model
        self.observation_mode = observation_mode
        self.device = torch.device(device)
        self.model.to(self.device)

    def evaluate(self, game: LifelineGame) -> PolicyValue:
        batch = collate_positions([game], self.observation_mode, device=self.device)
        was_training = self.model.training
        self.model.eval()
        with torch.no_grad():
            logits, value = self.model(
                batch.node_features,
                batch.adjacency,
                batch.node_mask,
                batch.legal_action_mask,
            )
            priors = torch.softmax(logits[0], dim=0).cpu().tolist()
        if was_training:
            self.model.train()
        return PolicyValue(value=float(value[0].cpu()), priors=tuple(priors))
