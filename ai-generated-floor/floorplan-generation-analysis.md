# AI Floor Plan Generation — Diagnosis

Analysis of `ai-generated-floor-plan-112026.json` + `ai-reponse112026.json`.

The geometry is not random — it reproduces exactly the output of the solver in
`src/services/floorPlanLayoutSolver.ts`. The problem is circulation/compactness,
not room areas.

---

## 1. What was generated

- 11 rooms
- 39 wall segments
- 14 openings: 7 doors + 7 windows

Converted from feet to meters, the packing is:

| Band (m) | Rooms (x-range in m) |
|---|---|
| y 0–4 | foyer 0–2 · living 2–8.5 · dining 8.5–11.5 |
| y 4–6.5 | kitchen 6.5–10.5 · bath_2 10.5–12.5 · bath_1 12.5–15 · storage 15–16.5 |
| y 6.5–8.5 | hall 10.5–14.5 |
| y 8.5–12.5 | bed_1 5.5–9.5 · bed_2 9.5–12.5 · bed_3 12.5–15.5 |

Areas are actually fine: **119 m² solved vs 113 m² requested (+5%)**, well inside
the 20% tolerance. The failure is **circulation and compactness**.

---

## 2. The fatal defects

### 2.1 Only 4 of 11 rooms are reachable from the entrance

From the foyer you can reach: living → dining → kitchen. That is the whole
usable house.

### 2.2 The rest is two disconnected islands plus three sealed rooms

- Hall + bath_1 + bed_2 + bed_3 form a second island, connected to nothing in
  the front half.
- bed_1, bath_2 and storage_1 have **no door at all**.

### 2.3 Four of the ten AI links could not be built

The solver emitted only 6 link doors (+1 entrance):

- Placed: `foyer–living`, `living–dining` (arch → 1.5 m door),
  `dining–kitchen`, `hall–bath_1`, `hall–bed_2`, `hall–bed_3`
- Missing: `foyer–hall`, `foyer–storage`, `hall–bed_1`, `bed_1–bath_2`

These missing links are exactly the four `"...do not share a wall segment"`
warnings.

### 2.4 The footprint is a staircase

Bands start at x = 0 → 6.5 → 10.5 → 5.5 m. Rooms cover 119 m² inside a
16.5 × 12.5 m bounding box (~58% fill). The living room and bed_1 have windows
facing deep notches between the shifted bands.

### 2.5 The saved plan looks empty

`SceneFile` has no room data (`src/types/floorplan.ts:62`), and `importPlan`
clears furniture (`src/store/floorPlanStore.ts:432`). The applied result is
walls with no labels and no furniture.

---

## 3. Root causes in the code

### a. Zone-band ordering made a valid plan structurally impossible

`buildRows` (`floorPlanLayoutSolver.ts:182–281`) orders bands greedily by
cross-zone link count. Here `service` had 2 links from `front`, so the order
became **front → service → core → private**. That puts a whole service band
between `foyer` (front) and `hall` (core), so `foyer→hall` can *never* share a
wall, regardless of offsets.

### b. Shelf packing + previous-row-only alignment

`buildRoomRectangles` (`:342–408`) packs rooms into rows with shared heights,
then shifts each row by a free offset. `alignmentScoreWithPreviousRow`
(`:287–328`) only looks at the **immediately previous** row. Consequences:

- `foyer→hall` (rows 1 and 3) is invisible to the optimizer.
- The offset loop (`:353–375`) optimizes `hall→bath_1` instead and lands the
  hall at x = 10.5 — far from the foyer.
- Every row may start anywhere up to the widest row, so no common envelope
  exists and rooms only touch partially or not at all.
- Rooms that do not share the row height get kicked into another band,
  splitting zones unpredictably.

### c. Links are validated only after layout

`placeWidth` / link placement (`:714–724`) just warns and drops the door when
rooms do not share a wall. There is no re-pack attempt.

### d. The critique is too weak

`floorPlanLayoutCritique.ts` checks only:

- rectangle overlap,
- geometric touching,
- linked-pair shared wall,
- window rooms having *a* free edge,
- entrance free edge,
- 20% total area drift (`:21`).

It does **not** check:

- reachability from the entrance through actual openings (`:192` only checks
  linkage adjacency),
- whether every link got an opening,
- envelope compactness / holes,
- whether a "hall" actually sits between the entrance and the private rooms.

### e. The repair loop cannot fix geometry and throws its own patch away

`floorPlanAiService.ts:750–802`: the AI patch may only change `zone`,
`area_m2` and links. In this run it proposed:

- `bath_2 → private`
- remove `foyer–hall` and `foyer–storage`

That disconnects the graph, so `applyRepairPatch` → `validateSemanticFloorPlan`
throws `room-link graph is disconnected`; the catch discards the **entire**
patch and keeps the broken layout. The user sees:

```
Layout repair 1 could not be applied: ...
```

Even if applied, moving `bath_2` to `private` still leaves it two bands away
from `bed_1` — unfixable by semantics alone.

### f. Output truncation is real in the log

`ai-reponse112026.json` shows pass-1 attempt 1 cut at `"grid_unit_m`, and three
pass-2 attempts cut mid-JSON.

- `geminiService.ts:484–505` only treats truncation as an error when *no* text
  was produced; if `finishReason === MAX_TOKENS` with partial text, it is
  returned as a success.
- Budgets are tight: 900 / 700 / 700 tokens for the passes and 600 for repairs
  (`floorPlanAiService.ts:953–975`, `:782`). With a thinking model, thinking
  tokens eat that budget.
- The Ollama path has the same hole — it never checks
  `done_reason === "length"` (`localAiService.ts:279–328`).

This causes retry churn, not the bad layout.

---

## 4. Proposed fix plan

### Phase 1 — Replace the placement core (the real fix)

A shelf packer cannot honor a circulation graph with cycles. Use a slice-tree /
BSP over one rectangular envelope:

- envelope area = total program + 10–15% circulation, snapped to the 0.5 m grid,
  target aspect 1.0–1.6;
- recursively split by cumulative area, choosing the axis/cut that keeps linked
  rooms on the cut line they need to share;
- score with hard constraints:
  - every link shares ≥ 0.9 m of wall,
  - every room is reachable from the entrance,
  - aspect 0.6–1.7,
  - fill ratio ≥ 0.8;
- soft constraint: per-room area error ≤ 10%;
- seeded restarts + local swaps over room order (≤ 32 rooms, milliseconds);
- merge collinear edges into long walls, then cut door/window openings on the
  correct shared segment.

Lighter alternative: keep shelf rows but fix the building width, order bands as
front → core → private with service rooms attached to the rooms they serve, and
backtrack over band/room order until all links are adjacent. Faster to ship,
still a heuristic.

### Phase 2 — Hard validation gates

Add diagnostics:

- `unreachable-room` (BFS through openings),
- `link-without-opening`,
- `not-compact` / `envelope-hole`,
- 15% per-room area drift.

Treat these as blocking: do not offer "Replace current plan" when they exist,
or show a red invalid state.

### Phase 3 — Repair loop

Apply only the valid subset of a patch (reject removals that disconnect), and
add deterministic geometric repair: permute band order / room order, re-solve,
keep the best-scoring layout. Stop asking the LLM to fix geometry it cannot
move.

### Phase 4 — Output budget / truncation

- Raise pass budgets to ~2–4k tokens.
- Treat `MAX_TOKENS` with partial text as an error.
- Check Ollama `done_reason`.
- Request minified JSON.
- Stop appending the full truncated blob into correction prompts.

### Phase 5 — UX + regression tests

- 2D preview in the chat card before apply (currently only
  "39 walls · 14 openings" + warnings — `LocalAiAssistant.tsx:905–943`).
- Keep room labels in the scene or generate furniture on apply.
- Add a regression test with this exact 11-room program asserting:
  - 11 openings (10 links + entrance),
  - all rooms reachable,
  - one compact envelope.

---

## 5. Test fixture (from this run)

```json
{
  "grid_unit_m": 0.5,
  "entrance_room": "foyer_1",
  "rooms": [
    { "id": "foyer_1", "type": "hallway", "area_m2": 6.0, "zone": "front", "windows": 0 },
    { "id": "living_1", "type": "living_room", "area_m2": 25.0, "zone": "front", "windows": 2 },
    { "id": "dining_1", "type": "dining_room", "area_m2": 12.0, "zone": "front", "windows": 1 },
    { "id": "kitchen_1", "type": "kitchen", "area_m2": 10.0, "zone": "service", "windows": 1 },
    { "id": "hall_1", "type": "hallway", "area_m2": 8.0, "zone": "core", "windows": 0 },
    { "id": "bed_1", "type": "bedroom", "area_m2": 16.0, "zone": "private", "windows": 1 },
    { "id": "bed_2", "type": "bedroom", "area_m2": 12.0, "zone": "private", "windows": 1 },
    { "id": "bed_3", "type": "bedroom", "area_m2": 11.0, "zone": "private", "windows": 1 },
    { "id": "bath_1", "type": "bathroom", "area_m2": 6.0, "zone": "service", "windows": 0 },
    { "id": "bath_2", "type": "bathroom", "area_m2": 4.0, "zone": "service", "windows": 0 },
    { "id": "storage_1", "type": "storage", "area_m2": 3.0, "zone": "service", "windows": 0 }
  ],
  "links": [
    { "from": "foyer_1", "to": "living_1", "connection": "door" },
    { "from": "foyer_1", "to": "hall_1", "connection": "door" },
    { "from": "foyer_1", "to": "storage_1", "connection": "door" },
    { "from": "living_1", "to": "dining_1", "connection": "arch" },
    { "from": "dining_1", "to": "kitchen_1", "connection": "door" },
    { "from": "hall_1", "to": "bed_1", "connection": "door" },
    { "from": "hall_1", "to": "bed_2", "connection": "door" },
    { "from": "hall_1", "to": "bed_3", "connection": "door" },
    { "from": "hall_1", "to": "bath_1", "connection": "door" },
    { "from": "bed_1", "to": "bath_2", "connection": "door" }
  ]
}
```

Expected after fix:

- 10 link openings + 1 entrance = 11 doors,
- 7 windows,
- all 11 rooms reachable from `foyer_1`,
- footprint fill ratio ≥ 0.8,
- no structural warnings.
