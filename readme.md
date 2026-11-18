SYSTEM INSTRUCTION / AGENT MISSION:
You are an expert full-stack desktop software engineer tasked with building an MVP for "FloorPlan Studio", a cross-platform desktop application built with Tauri 2.0, React 18+, TypeScript, Tailwind CSS, and Three.js (React Three Fiber). 

Execute this plan step-by-step. Use your agentic file editing, terminal execution, and context-reading tools to scaffold, code, run, and self-debug the project until the app builds and runs cleanly via `npm run tauri dev`.

---

### PHASE 1: PROJECT SCAFFOLDING & SETUP
1. Initialize a new Tauri v2 application in the current root directory with React and TypeScript templates.
2. Install the necessary UI and 3D rendering dependencies:
   - `@react-three/fiber` and `@react-three/drei` (Three.js wrappers)
   - `three` and `@types/three`
   - `lucide-react` (icons)
   - `clsx` and `tailwind-merge`
3. Configure Tailwind CSS with standard modern styling.
4. Set up a modern, dark-mode focused desktop layout structure (`src/components/layout/AppShell.tsx`) featuring:
   - Left Sidebar: Tooling (Select, Draw Wall, Door, Window, 3D Furniture, Rule Check).
   - Top Bar: App title, File actions (Import/Export), View Switcher (2D Drafting View vs. 3D View).
   - Main Area: Dual-view canvas (2D HTML5 Canvas / 3D Three.js WebGL viewport).

---

### PHASE 2: CORE STATE MANAGEMENT & GEOMETRY DATA MODEL
1. Create a lightweight state store (`src/store/floorPlanStore.ts`) using Zustand or React Context managing:
   - `walls`: Array of `Wall` objects `{ id, x1, y1, x2, y2, thickness, height }`.
   - `openings`: Array of `Opening` objects `{ id, wallId, type: 'door' | 'window', positionOnWall, width }`.
   - `activeView`: `'2d' | '3d'`.
   - `activeTool`: `'select' | 'wall' | 'door' | 'window'`.
2. Populate the store with a default template scene (a 4-wall rectangular room: 20ft x 15ft with 1 door opening) so the initial rendering works immediately on boot.

---

### PHASE 3: 2D DRAFTING CANVAS
1. Build `src/components/canvas/Canvas2D.tsx`:
   - Render gridlines representing feet/meters.
   - Draw existing walls as dark vector lines with thickness.
   - Implement click-and-drag drawing capability when `activeTool === 'wall'`:
     - Click 1: Lock starting coordinate `(x1, y1)`.
     - Mouse Move: Live preview line drawing with realtime distance label (e.g., "12.5 ft").
     - Click 2: Commit wall `(x2, y2)` to the store.
   - Implement basic wall selection and deletion.

---

### PHASE 4: AUTOMATED 3D EXTRUSION ENGINE
1. Build `src/components/canvas/Canvas3D.tsx` using React Three Fiber (`Canvas`, `OrbitControls`, `PerspectiveCamera`):
   - Add ambient lighting, directional sun lighting with soft shadows, and a ground plane grid.
   - Create an automated wall-extrusion mesh component `ExtrudedWall.tsx`:
     - Read wall vector coordinates `(x1, y1) -> (x2, y2)`.
     - Calculate length, angle, and midpoint.
     - Render a 3D BoxGeometry extruded upwards by `wall.height` (default 8ft / 2.4m).
     - Cut visual gaps for doors/windows based on `openings` registered to that wall ID.
   - Ensure camera controls allow full 360-degree rotation, zoom, and panning.

---

### PHASE 5: DETERMINISTIC SPATIAL COMPLIANCE CHECKER
1. Create a spatial rules module `src/utils/spatialRules.ts`:
   - Rule 1: Doorway Egress Check — Flag any door opening with a width less than 32 inches (0.81m).
   - Rule 2: Wall Connectivity Check — Detect isolated/unconnected walls.
2. Build a compliance notification drawer `src/components/ui/CompliancePanel.tsx` that displays pass/fail warnings to the user in real time based on the active scene.

---

### EXECUTION REQUIREMENTS & AGENT LOOP:
1. First, outline a brief execution plan before running commands.
2. Run terminal commands to install dependencies and scaffold code files.
3. If any Tauri or TypeScript compiler error occurs during execution, read the error output, inspect the relevant code, fix the issue, and rerun the build command until it succeeds.
4. Ensure all native Tauri file imports use valid Tauri v2 package routes (`@tauri-apps/api` / `@tauri-apps/plugin-fs`).

Begin now.


> **Note on Intel Integrated Graphics (iGPU):** By default, Ollama runs on the CPU for older Intel processors (such as 8th Gen Intel Core i7-U / UHD Graphics 620) because integrated graphics share system RAM and often perform slower than CPU inference. To force experimental GPU acceleration via Vulkan, set the following environment variables and restart Ollama:
>
> - **Windows (PowerShell):**
>   ```powershell
>   [Environment]::SetEnvironmentVariable("OLLAMA_VULKAN", "1", "User")
>   [Environment]::SetEnvironmentVariable("OLLAMA_IGPU_ENABLE", "1", "User")
>   ```
> - **Linux (`systemd`):** Add `Environment="OLLAMA_VULKAN=1"` and `Environment="OLLAMA_IGPU_ENABLE=1"` via `sudo systemctl edit ollama` and restart the service.
>
> Verify with `ollama ps` while a model is running. If token speed (`--verbose`) is slower than CPU, remove these variables to revert to CPU mode.