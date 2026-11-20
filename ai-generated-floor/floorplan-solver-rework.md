# Floor Plan Generation — Solver Rework

Companion to `floorplan-generation-analysis.md`. This document records the
changes applied after the second review, and the acceptance criteria used to
verify them.

---

## Problem recap (measured, not estimated)

From `ai-generated-floor-plan-112026.json`:

| Metric | Before |
|---|---|
| Rooms reachable from the entrance | 4 / 11 |
| Rooms with no door | 3 (`bed_1`, `bath_2`, `storage_1`) |
| Required links without a shared wall | 4 (`foyer–hall`, `foyer–storage`, `hall–bed_1`, `bed_1–bath_2`) |
| Footprint fill (room area / bounding box) | 58% |
| Exterior perimeter for 119 m² | 70.0 m (1.6× an equal-area square) |
| Total area drift | +5.3% |
| Per-room area drift | foyer +33%, bath_2 +25%, storage_1 +25% |

Root causes: greedy zone ordering, free-floating row offsets that only align
with the immediately previous row, no lookahead, and a repair loop that can
only edit zones/areas/links and discarded its own patch when it disconnected
the graph.

---

## 1. New placement algorithm

The shelf packer is replaced by a **guillotine treemap (kd-tree) over a single
rectangular envelope**, with a search over room order and envelope aspect.

### Guarantees

- The building envelope is a rectangle; every room is inside it and the rooms
  tile it exactly (no gaps, no overlaps, no notches).
- The entrance room is the first tile, anchored at the top-left corner, so the
  main entrance always has an exterior wall.
- Every room is grid-snapped (0.5 m default) with a minimum 1.0 m dimension.
- Every requested link that can share a wall is scored and preferred.
- Any room that still ends up without a usable door gets a fallback access
  door to an adjacent reachable room, so the finished plan is always walkable.

### Layout

1. Compute per-room layout areas (`max(area_m2, 1 m²)` so tiny rooms are still
   buildable).
2. Choose an envelope `W × H` from the total area and a target aspect.
3. Recursively split each region along the axis and at the split point that
   keeps both child regions closest to square, using cumulative room areas.
4. Score the result:
   - satisfied links (shared edge ≥ 0.7 m) — primary key,
   - all-room aspect compliance (ratio ≤ 2) — secondary key,
   - aspect, minimum dimension, per-room area error, window rooms on the
     envelope, entrance at the top-left.
5. Search:
   - BFS and DFS orders from the entrance with three neighbour sortings,
   - seeded random permutations,
   - local pair swaps for up to three passes.
6. Pick the best candidate and derive walls/openings from the room edges.

Deterministic: the PRNG is seeded from the semantic plan, so the same input
produces the same layout.

## 2. Opening and reachability rules

- Entrance door: exterior wall of the entrance room, preferring `y = 0`.
- Link doors: placed on the longest shared segment that fits the requested
  width; `open`/`arch` still use a 1.5 m door cut-out for renderer
  compatibility.
- Fallback access: after link doors, BFS through actual door openings from the
  entrance. Any unreachable room is connected to an adjacent reachable room
  (circulation rooms preferred) and a warning is emitted.
- Windows: placed only on envelope-facing segments, entrance wall excluded.

## 3. Critique upgrades

New diagnostics (all actionable and included in repair context):

| Code | Meaning |
|---|---|
| `link-without-opening` | A declared link has no door on its shared wall |
| `unreachable-room` | No door path from the entrance to this room |
| `not-compact` | Room area / bounding box < 0.78 |
| `room-area-drift` | A single room differs from its target by >25% and >1 m² |

Existing `room-overlap`, `disconnected-geometry`, `missing-shared-wall`,
`no-exterior-wall`, `missing-entrance-exterior`, and total `area-drift` are
kept. `no-exterior-wall` is now measured against the envelope, not against
"a segment with one room".

## 4. Repair loop fixes

- Link removals that would disconnect the room graph are dropped one at a
  time and reported instead of discarding the whole patch.
- The plan is re-solved after every applied patch (unchanged).
- Repair remains bounded at two iterations.
- `solveWithoutRepair` (pasted JSON) now benefits from the new solver but
  still does not call the AI.

## 5. AI output-budget fixes

- Output-token budgets raised: 2048 (program), 1536 (links), 1024 (windows),
  1024 (repair), up from 900/700/700/600.
- Gemini `finishReason === "MAX_TOKENS"` with partial text now raises an error
  instead of returning truncated JSON as success.
- Ollama `done_reason === "length"` is rejected in both streaming and
  non-streaming paths.
- Correction prompts keep the existing output but are truncated if oversized.

## 6. Acceptance criteria and measured result

Regression fixture: the 11-room program from the failing run
(`floorplan-generation-analysis.md` §5).

| Check | Before | After |
|---|---|---|
| Rooms placed | 11 | 11 |
| Rooms reachable from `foyer_1` | 4 | **11** |
| Sealed rooms | 3 | **0** |
| Footprint fill | 58% | **~100%** (rectangular envelope) |
| Total area drift | +5.3% | ≤10% |
| Doors | 7 | **11** (6 requested + 4 accessibility + entrance) |
| Windows placed | 7 | **7** |
| Requested links realized | 6 | 6 (4 links remain geometrically impossible for this graph) |

The 11-room graph asks a single 8 m² hall to share walls with four rooms and a
foyer while also keeping the living/dining/kitchen cluster together. The
kd-tree solver keeps the plan compact and walkable, realizes the entrance and
hall links first, and converts the remaining links into reported accessibility
doors. A corridor-aware solver / circulation normalization is the next step
(tracked in the follow-ups) to realize the full graph without fallback doors.

Existing solver, critique, and AI-service tests must continue to pass — they
do (167 tests).

---

## Follow-ups (not in this change)

- 2D preview inside the assistant card before applying.
- Enforce pass-2 circulation rules in `validateLinks` (no bedroom-only path,
  ensuite bathrooms zoned with their bedroom).
- Auto-size circulation when the hall must serve more rooms than its area can
  reasonably reach.
