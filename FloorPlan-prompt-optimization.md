Refactor our floor plan generation pipeline into an iterative, multi-pass workflow optimized for small local LLMs (Llama 3.2 / Gemma 3), using a lightweight semantic room-graph instead of raw polygon coordinates (x1, y1, x2, y2...).

### Architecture Overview

Replace the single monolithic LLM call with **3 lightweight passes + a deterministic 2D solver with a bounded repair loop**:

1. **Pass 1 — Room Program & Zones (LLM Call 1):**
   Generate only the room list, target areas, zones, and main entrance room:
   ```json
   {
     "grid_unit_m": 0.5,
     "entrance_room": "living",
     "rooms": [
       { "id": "living", "type": "living_room", "area_m2": 28, "zone": "front" }
     ]
   }

```

* Allowed `zone` values: `"front"`, `"core"`, `"private"`, `"service"`.
* Validate schema (unique room IDs, positive `area_m2`, `entrance_room` exists in `rooms`) before proceeding.

2. **Pass 2 — Circulation & Links (LLM Call 2):**
Feed the locked `rooms` array from Pass 1 into a short prompt to generate only room-to-room connections:
```json
{
  "links": [
    { "from": "living", "to": "kitchen", "connection": "open" },
    { "from": "living", "to": "bed_1", "connection": "door" }
  ]
}

```


* Allowed `connection` values: `"door"`, `"open"`, `"arch"`.
* Validate that all `from` and `to` IDs exist in `rooms`, there are no self-links, and the graph is connected.


3. **Pass 3 — Exterior Windows (LLM Call 3 or Rule Hybrid):**
Given the room list and links, assign exterior window counts per room:
```json
{
  "windows": [
    { "room_id": "living", "count": 2 },
    { "room_id": "bath_1", "count": 0 }
  ]
}

```


* Validate non-negative integer counts and valid `room_id`s.


4. **Deterministic 2D Layout Solver & Opening Placement:**
Convert the validated semantic graph into grid-snapped 2D room rectangles (`grid_unit_m`), doors, and windows:
* Place rooms grouped by `zone` (`"front"` near entrance, `"private"` grouped together, `"core"` for circulation, `"service"` for wet/utility areas) with aspect ratios between 1:1 and 1:2, zero overlaps, and zero disconnected islands.
* Place interior `"door"` / `"open"` / `"arch"` openings along shared wall segments between linked rooms.
* Place the main entrance door on an exterior wall of `entrance_room`.
* Place exterior windows along outer perimeter walls of each room according to `windows` count, avoiding overlap with doors.


5. **Programmatic Critique & Bounded Repair Loop (Max 2 Iterations):**
After running the 2D solver, run geometry checks (e.g., habitable rooms with `windows > 0` trapped with zero exterior walls, missing shared walls for required links, or total area drift).
* If any check fails, send only the specific failing room/link error back to the LLM to output a minimal JSON patch (`zone` change, `area_m2` tweak, or `link` update), re-validate, and re-run the solver (cap at 2 retries).


6. **LLM Settings & Output Adapter:**
* Use strict JSON schema / structured output (`response_format`) and `temperature: 0.1` across all LLM passes.
* Map the final solved rectangles, walls, doors, and windows into our existing internal floor plan data model so the 2D/3D renderer requires no breaking changes.



Start by inspecting our existing floor plan schema, opening definitions, and LLM client setup, then propose the file structure and changes before editing.

