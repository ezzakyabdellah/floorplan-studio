# Blueprint Extraction Pipeline

What happens after the ML model detects walls and reads the plan.

## 1. Detection → vector segments

- [onnxExtraction](../src/services/visionModelService.ts#L1211) — `visionModelService.ts:1211` runs the ONNX session.
- YOLO-style boxes: [parseDetections](../src/services/visionModelService.ts#L290) — `visionModelService.ts:290` and [detectionSegments](../src/services/visionModelService.ts#L404) — `visionModelService.ts:404`.
- Segmentation fallback: [segmentationToMasks](../src/services/visionModelService.ts#L850) — `visionModelService.ts:850` and [segmentationPlan](../src/services/visionModelService.ts#L913) — `visionModelService.ts:913`.
- Walls become `PixelSegment`s; doors/windows become `PixelOpening`s.

## 2. Segments → architectural plan

Entry point: [buildPlanFromSegments](../src/services/visionModelService.ts#L1111) — `visionModelService.ts:1111`.

- [mergePixelSegments](../src/services/visionModelService.ts#L696) — `visionModelService.ts:696` merges collinear runs.
- [bridgeOpenings](../src/services/visionModelService.ts#L1048) — `visionModelService.ts:1048` re-joins wall stubs split by a detected door/window.
- Filters segments shorter than 0.75 ft or thicker than 8 ft.
- Converts pixels to feet via `feetPerPixel = feetPer100Pixels / 100`, computes the bounding box plus a 0.5 ft margin, and builds `Wall` objects (thickness clamped to 0.25–0.75 ft, default height).
- [assignOpenings](../src/services/visionModelService.ts#L970) — `visionModelService.ts:970` snaps each opening to the nearest wall, clamps width/position, and drops overlaps.
- Returns `walls`, `openings`, `worldWidth/Height`, plus `source`, `modelUrl`, `inferenceMs`.

## 3. Import into app state

- [handleConfirm](../src/components/ui/ImageImporter.tsx#L210) — `ImageImporter.tsx:210` calls `extractVectorsFromImage`, then `importPlan`.
- [importPlan](../src/store/floorPlanStore.ts#L270) — `floorPlanStore.ts:270` assigns new wall UUIDs, remaps openings to new wall IDs, applies Replace/Append, sets scene name, clears selection, bumps `revision`, and switches the view to 3D.
- [handleImported](../src/components/layout/AppShell.tsx#L687) — `AppShell.tsx:687` shows a toast with wall/opening counts and engine source.

## 4. Live rendering

- [Canvas3D](../src/components/canvas/Canvas3D.tsx) — `Canvas3D.tsx` recomputes bounds/camera via [CameraRig](../src/components/canvas/Canvas3D.tsx#L15) — `Canvas3D.tsx:15`.
- [ExtrudedWall](../src/components/canvas/ExtrudedWall.tsx) — `ExtrudedWall.tsx` cuts walls into solid pieces, door headers, window sills/headers, and adds door slabs and glass panes.
- Opening intervals come from [getWallIntervals](../src/utils/geometry.ts#L72) — `geometry.ts:72`.

## 5. Post-import analysis

- [runComplianceChecks](../src/utils/spatialRules.ts#L149) — `spatialRules.ts:149` checks door egress (≥32 in) and wall connectivity, shown in [CompliancePanel](../src/components/ui/CompliancePanel.tsx) — `CompliancePanel.tsx` and the sidebar badge.
- The AI Inspector ([localAiService](../src/services/localAiService.ts) — `localAiService.ts`) builds a prompt from walls/openings plus rule results and streams analysis from local Ollama.
- Plans can be edited in 2D and exported to JSON via [fileIO](../src/utils/fileIO.ts) — `fileIO.ts`.
