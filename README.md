# TriAxis

A two-player abstract strategy game played on a triangular grid — invented in middle school, coded in college.

## Background

I invented the rules of this game during evening self-study in middle school, playing it on paper with classmates. Years later, after learning to program in college, I built this digital version entirely from scratch — bringing an old idea to life.

## Gameplay

Two players — **Blue** and **Red** — each start with one node at opposite corners of a triangular grid (9 rows).

On each turn, click an empty point to place a node. The move is valid only if the new node can connect to one of your existing nodes. Connections form automatically along three axes:

- Horizontal (same row)
- Vertical (same column)
- Diagonal (x + y = constant)

An opponent's piece on the line blocks your connection. You can place your node **directly on an opponent's line** to cut it — any opponent nodes that become disconnected from their starting point are immediately removed.

## Rules

- Your node must connect to your existing network to be placed.
- You cannot place a node in the opponent's **protection zone** (the points adjacent to their starting node).
- **Three-point limit:** you cannot create a cluster of 3 or more adjacent nodes.
- Disconnected nodes and lines are automatically removed.

## Requirements

- Python 3.x
- pygame

```bash
pip install pygame
```

## How to Run

```bash
python triangular_game.py
```

## Controls

- **Left click** — place a node at the selected grid point
