SYSTEM INSTRUCTION / AGENT MISSION:
You are an expert computer vision and desktop software engineer. We are adding an offline, local computer vision pipeline to our Tauri v2 + React 3D Floor Plan application. 

Your task is to integrate an **ONNX Runtime (onnxruntime-node or web assembly/client-side ONNX)** to execute a lightweight floor plan segmentation model (compatible with YOLO / CubiCasa5K ONNX weights) that processes an uploaded 2D blueprint image and extracts structural 2D wall and door vectors.

Follow this step-by-step implementation plan using your file editing, terminal execution, and testing tools.

---

### STEP 1: INSTALL DEPENDENCIES
1. Install the ONNX runtime package suitable for your Node/Web context in Tauri:
   - Run `npm install onnxruntime-node` (or `onnxruntime-web` if running entirely in the frontend webview).
   - Install any needed image processing helpers (e.g., `sharp` for backend image resizing/normalization, or standard HTML5 Canvas API if handled client-side).

---

### STEP 2: CREATE THE LOCAL ONNX MODEL LOADER SERVICE
1. Create a service file `src/services/visionModelService.ts`:
   - Initialize an ONNX inference session (`ort.InferenceSession.create()`).
   - Define a fallback mock/heuristic extractor if the `.onnx` model file is not found in the assets folder (to ensure the app still compiles and runs out-of-the-box before the user downloads heavy weights).
   - Implement the core processing function: `async function extractVectorsFromImage(imagePathOrDataUrl: string): Promise<{ walls: Wall[], openings: Opening[] }>`.

---

### STEP 3: BUILD THE IMAGE-TO-VECTOR PROCESSING PIPELINE
1. Inside `src/services/visionModelService.ts` (or a dedicated `src/utils/vectorizer.ts`):
   - **Image Preprocessing:** Resize the uploaded floor plan image to the model's expected input dimensions (e.g., 640x640 pixels), normalize pixel values to `[0, 1]`, and convert to an ONNX tensor (`ort.Tensor`).
   - **Model Inference:** Run session execution (`session.run({ images: inputTensor })`).
   - **Post-Processing (Mask to Vectors):** 
     - Extract bounding boxes or segmentation masks for walls and doors from the model output tensors.
     - Apply a lightweight skeletonization or line-fitting algorithm (like Hough Transform logic in TypeScript or vector clustering) to convert pixel masks into clean line segments: `walls = [{ id, x1, y1, x2, y2 }]`.
     - Scale normalized model coordinates back to real-world architectural units (e.g., feet or meters based on standard blueprint ratios).

---

### STEP 4: INTEGRATE WITH STATE & UI
1. Update the UI workflow in `src/components/ui/ImageImporter.tsx`:
   - When the user drops a blueprint image and clicks "Extract Vectors with AI", display a loading state: *"Running Local ONNX Vision Model..."*.
   - Pass the image file through `extractVectorsFromImage()`.
   - Take the returned `walls` and `openings`, inject them directly into your Zustand store (`floorPlanStore.ts`), and trigger the 3D Three.js extrusion view.

---

### EXECUTION REQUIREMENTS & AGENT LOOP:
1. First, outline your plan briefly.
2. Install dependencies via terminal.
3. Write clean, well-commented TypeScript code. Handle edge cases (e.g., missing ONNX model file gracefully logging a warning and falling back to manual drawing or mock coordinates).
4. Run tests or build checks to ensure no compilation errors occur.

Begin execution now.