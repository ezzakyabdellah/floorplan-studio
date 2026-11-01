SYSTEM INSTRUCTION / AGENT MISSION:
You are an expert desktop software developer. We are updating the "FloorPlan Studio" Tauri v2 + React + Three.js application. 

Your goal is to implement two major features:
1. "Local Free AI Engine Integration" (Connecting to Ollama / local LLM for AI compliance chat).
2. "2D Image Blueprint to 3D Mesh Generator" (Uploading a 2D floor plan image, extracting wall vectors, and rendering the 3D room).

Follow this step-by-step implementation plan using your agentic file editing, terminal execution, and testing capabilities.

---

### FEATURE 1: LOCAL FREE AI INTEGRATION (Ollama / Local LLM)

1. Create a local AI service module (`src/services/localAiService.ts`):
   - Implement an API client targeting `http://localhost:11434/api/generate` (Ollama endpoint).
   - Add a health-check function `checkOllamaStatus()` to verify if Ollama is running locally.
   - Add a method `analyzeComplianceWithLLM(walls, openings)` that formats the current 2D floor plan JSON into a prompt and streams back a architectural code inspection summary using models like `llama3.2`, `qwen2.5`, or `mistral`.

2. Build the AI Assistant UI Panel (`src/components/ui/LocalAiAssistant.tsx`):
   - Add a slide-out panel with a status indicator ("Local AI Connected: Ollama" vs "Offline Mode").
   - Add a button: "Run AI Spatial Audit".
   - Include a chat interface allowing users to ask natural language questions about their plan (e.g., "Is this room wide enough for an ADA-compliant doorway?").
   - Provide fallback logic: If Ollama is not detected, gracefully display instructions on how to start Ollama (`ollama run llama3.2`) without breaking the app.

---

### FEATURE 2: 2D IMAGE BLUEPRINT TO 3D CONVERTOR ENGINE

1. Create an Image Processing & Wall Vectorizer Pipeline (`src/utils/imageToVector.ts`):
   - Build a Canvas-based image processing utility that reads an uploaded floor plan image (PNG/JPG).
   - Implement contrast/thresholding preprocessing on an offscreen HTML5 canvas to highlight dark wall lines.
   - Implement a lightweight line-detection / bounding-box algorithm (or skeletonization pass) that converts thick dark pixels into vector wall segments `[{ x1, y1, x2, y2 }]`.
   - Scale the extracted pixels to world-space grid units (feet/meters) based on a configurable scale factor (e.g., 100 pixels = 10 feet).

2. Create the Blueprint Upload Component (`src/components/ui/ImageImporter.tsx`):
   - Add a Drag-and-Drop file picker supporting `.png`, `.jpg`, and `.jpeg`.
   - Show a live preview modal with threshold/contrast adjustment sliders so the user can clean up noisy scanned blueprints.
   - Add a "Process Blueprint into 3D" button.

3. Connect Image Extraction to the 3D Engine Store:
   - When "Process Blueprint into 3D" is clicked:
     - Clear or append the extracted vector walls into `floorPlanStore`.
     - Automatically switch `activeView` to `'3d'`.
     - Re-trigger `Canvas3D.tsx` to instantly extrude the newly detected walls into 3D WebGL geometries.

---

### UI & TOOLBAR INTEGRATION:
1. Update `src/components/layout/AppShell.tsx`:
   - Add an "Import Blueprint (PNG/JPG)" button to the top navigation toolbar.
   - Add an "AI Inspector" toggle button to the right sidebar.

---

### EXECUTION REQUIREMENTS & AGENT LOOP:
1. Inspect the existing repository structure (`src/store`, `src/components`, `src/canvas`) before writing new files.
2. Install any necessary helper packages (e.g., `lucide-react` icons or UI utility libs) if missing.
3. Verify that all canvas processing runs asynchronously to prevent blocking the UI frame rate.
4. Run `npm run tauri dev` or test compilation steps to ensure no TypeScript or React build errors exist.

Begin execution now.