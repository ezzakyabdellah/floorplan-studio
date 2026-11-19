### Requirements

1. **LLM Output Schema (Strict JSON):**
   Update the LLM prompt and structured output schema (`response_format` / JSON schema) to generate only:
   ```json
   {
     "grid_unit_m": 0.5,
     "entrance_room": "living",
     "rooms": [
       {
         "id": "living",
         "type": "living_room",
         "area_m2": 28,
         "zone": "front",
         "windows": 2
       }
     ],
     "links": [
       { "from": "living", "to": "kitchen", "connection": "open" },
       { "from": "living", "to": "bed_1", "connection": "door" }
     ]
   }

```

* Allowed `zone` values: `"front"`, `"core"`, `"private"`, `"service"`
* Allowed `connection` values: `"door"`, `"open"`, `"arch"`
* `windows`: integer count of exterior windows desired for that room (default `0` for interior-only rooms like windowless bathrooms/closets).
* `entrance_room`: room `id` where the main exterior entry door is located.
* Set LLM temperature to `0.1` for deterministic structure.

2. **Deterministic 2D Layout Solver & Opening Placement (Geometry Engine):**
Build a clean, modular solver that converts the semantic graph into 2D room rectangles snapped to `grid_unit_m`, then places doors and windows deterministically:
* Group and place rooms by `zone` (`"front"` near entrance, `"private"` grouped together, `"core"` for circulation, `"service"` for wet/utility areas).
* Size each room proportionally to `area_m2` with realistic aspect ratios (between 1:1 and 1:2) so rooms don't become unusable slivers.
* Ensure linked rooms share a boundary wall where possible; place interior `"door"` / `"open"` / `"arch"` openings centered along the shared wall segment with standard widths (e.g., `0.9m` door, `1.5m+` opening/arch).
* Place the main entrance door on an exterior wall segment of `entrance_room`.
* For each room's `windows` count, place windows along available exterior-facing wall segments (preferring outer perimeter walls not already used by the entrance door, and spacing multiple windows evenly). If a room ends up completely enclosed with no exterior wall, clamp/warn gracefully rather than failing.
* Guarantee zero overlapping rooms and zero disconnected islands.


3. **Output Adapter:**
Convert the solved rectangles, walls, doors, and windows back into our existing internal floor plan/wall data structure so the 2D/3D renderer continues working without breaking changes.
4. **Validation & Fallback:**
Add schema validation (e.g., Pydantic or Zod) to verify `entrance_room` and all `links` room IDs exist, `windows` is non-negative, and areas are positive before running the solver.

Start by inspecting our current floor plan data model, opening representation (door/window types, widths, wall offsets), and LLM call, then propose the file changes before editing.