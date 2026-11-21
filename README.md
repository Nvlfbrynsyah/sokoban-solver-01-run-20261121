# Sokoban solver

Run with Node.js 22 (22.18 or later, with native TypeScript stripping) or newer. No installation is needed.

```sh
node main.ts
MAKEFUN_INPUT_DIR=kit/practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

The solver reads five XSB boards from `/input/i001/level.txt` through `/input/i005/level.txt` and writes lowercase LURD moves to the corresponding `/output/<id>/solution.txt`. The environment variables above override the two roots for local runs.

The solver finds articulation points and separates the rooms at their hallway doors. It solves each room independently with A* over pushes, using BFS to group equivalent player positions and reconstruct the walks between pushes. Reverse push distances and a Hungarian assignment give a lower bound on remaining pushes. Dead squares (including non-goal corners), blocked 2×2 patterns, and frozen boxes prune unsolvable states. Hallway walks join the room solutions. A box pushed into the hallway cannot return, so summing the rooms’ push optima gives the level’s push optimum.

If splitting or stitching fails, the solver tries whole-board push A*, then move A*. Search uses fixed work limits and deterministic tie-breaking.
