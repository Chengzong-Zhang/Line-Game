# Code: Turning a Position into a Reliable Program

[GitHub source](https://github.com/Chengzong-Zhang/Line-Game) · [Project README](https://github.com/Chengzong-Zhang/Line-Game/blob/main/README.md)

LIFELINE connects three parts: rules that transform nodes and links, AI that searches legal successor positions, and asynchronous computation that safely returns to the current game.

## 1. One Board, Two Layers

The physical `grid` stores occupancy at each lattice point. Logical `edges` store actual connections between nodes. A continuous sequence of colored line cells does not by itself establish graph connectivity.

- Canvas renders nodes, links, and territory from the physical state.
- BFS follows logical edges to check whether a structure remains connected to its base.
- A move on an enemy line severs connections, after which disconnected structures are removed.

The rule authority is [GameEngine.js](https://github.com/Chengzong-Zhang/Line-Game/blob/main/web/web%E5%89%8D%E7%AB%AF/GameEngine.js).

## 2. A Move Is a Transaction

A move may change nodes, automatic links, the opponent's structure, the turn, and history. A failed check must restore the original position.

```text
Check coordinates, occupancy, protection, and the triangle restriction
→ Save the rule state
→ Add the node and legal links
→ Resolve cuts and disconnected structures
→ Check Superko
→ Commit the action and next turn, or restore the previous state
```

Superko depends on history. Identical boards with different `historyHashes` can have different legal moves, so search, saved games, Worker snapshots, and replay must preserve the history set.

## 3. Territory Follows Discrete Rules

The Web page and new rooms use `territory-v2`. The engine evaluates valid closed boundaries, candidate walls, player-corner normalization, and discrete flood fill. Final scores use the rule-defined `area`.

Geometric display area and fast AI territory estimates serve separate purposes. Neither replaces final rule scoring.

The bare engine retains a `territory-v1` compatibility entry. Python/Pygame follows a legacy v1 lineage, while research environments follow their frozen protocols. Cross-implementation comparisons require an explicit rule version and matching inputs.

## 4. Choosing an AI Move

Local two-player games configure blue and red independently. Beyond human play, nine AI strategies are available:

| Strategy | Decision process |
| --- | --- |
| Minimax | Alpha-Beta search over legal successors with candidate ordering and heuristic evaluation |
| Padded-CNN + PUCT | Convolutional board features produce priors and values for PUCT search |
| Grid-GNN + PUCT | Messages follow lattice adjacency, followed by PUCT search |
| Topology-GNN + PUCT | Uses lattice adjacency and both players' actual links, followed by PUCT search |
| DQN / PPO / SAC / GAIL / GAN | Exported models choose among the current legal actions |

Minimax difficulty levels correspond to depths 2, 3, and 4. PUCT combines network priors, value estimates, and visit counts within a search budget. Search values are not calibrated win probabilities.

The browser reads `.f32` weights directly. Transfer models were trained on sizes 5–15 and remain `PILOT_ONLY`; older models were trained on 5/7/9. Their integration with the current rules is a compatibility trial. Seeds identify training replicas rather than strength rankings.

See [AIEngine.js](https://github.com/Chengzong-Zhang/Line-Game/blob/main/web/web%E5%89%8D%E7%AB%AF/AIEngine.js), [ResearchAI.js](https://github.com/Chengzong-Zhang/Line-Game/blob/main/web/web%E5%89%8D%E7%AB%AF/ResearchAI.js), and [ModelFreeAI.js](https://github.com/Chengzong-Zhang/Line-Game/blob/main/web/web%E5%89%8D%E7%AB%AF/ModelFreeAI.js).

## 5. Worker Responses Belong to a Position

AI, hints, and territory calculations use Workers. Each response must match the request ID, engine identity, position revision, rules version, and player.

Restarting, changing settings, or making another move invalidates earlier results. AI actions are checked for legality again before execution. The protocol is defined in [AIStateProtocol.js](https://github.com/Chengzong-Zhang/Line-Game/blob/main/web/web%E5%89%8D%E7%AB%AF/AIStateProtocol.js).

## 6. Replays Must Be Verifiable

A replay records the rules version, initial configuration, actions, and terminal summary. Import first replays the actions in an isolated engine, checking actors, effects, hashes, and the final state before replacing the current game.

The timeline, inspector, and AI comparison use the selected historical position without changing the active game. See [ReplayCodec.js](https://github.com/Chengzong-Zhang/Line-Game/blob/main/web/web%E5%89%8D%E7%AB%AF/ReplayCodec.js).

## 7. Browser, Server, and Training

```text
web/web前端/     Rules, Canvas, player setup, Workers, replays, tutorials
web/web后端/     Accounts, room synchronization, anonymous replay collection
web/tools/       Replay validation, curation, release manifests, public checks
research/        Research environments, training, protocols, results, papers
core algorithm/  Python/Pygame desktop examples
docs/            Product contracts, platform plans, release evidence, archives
```

The server handles accounts and room synchronization; the complete board rules run in the browser. Anonymous replay contribution is voluntary and uses a separate collection and curation workflow.

## 8. Checking the Contracts

Automated regressions cover rules, complete state, asynchronous result ownership, independent player setup, and replay. Browser checks cover actual UI, Canvas, and Worker behavior. Frozen research evidence is recorded separately from engineering checks.

The [documentation index](https://github.com/Chengzong-Zhang/Line-Game/blob/main/docs/README.md) links to each area. The [historical engineering notes](https://github.com/Chengzong-Zhang/Line-Game/blob/main/docs/archive/engineering/legacy-code.md) preserve the original Python/Pygame explanation.
