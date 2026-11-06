import {
  VISION_MODEL_URL,
  checkVisionModelAvailability,
  extractVectorsFromImage,
  type VisionDebugEvent,
  type VisionExtractionOptions,
  type VisionExtractionResult,
} from "./visionModelService";

function printStage(event: VisionDebugEvent) {
  switch (event.stage) {
    case "availability":
      console.log("[vision:availability]", event.availability);
      break;
    case "input":
      console.log("[vision:input]", {
        inputName: event.inputName,
        dims: event.dims,
        transform: event.transform,
        stats: event.stats,
      });
      break;
    case "output":
      console.log("[vision:output]", {
        name: event.name,
        dims: event.dims,
        stats: event.stats,
      });
      break;
    case "detections":
      console.log("[vision:parseDetections]", {
        output: event.output,
        parsed: event.parsed,
        detectionCount: event.detectionCount,
        classCount: event.classCount,
      });
      break;
    case "detectionSegments":
      console.groupCollapsed(
        `[vision:detectionSegments] ${event.segmentCount} segments, ${event.openingCount} openings`,
      );
      console.table(event.segments);
      console.table(event.openings);
      console.groupEnd();
      break;
    case "segmentation":
      console.groupCollapsed(
        `[vision:segmentation] ${event.channels}ch ${event.width}x${event.height} -> ${event.segmentCount} segments, ${event.openingCount} openings`,
      );
      console.table(event.segments);
      console.table(event.openings);
      console.groupEnd();
      break;
    case "plan":
      console.groupCollapsed(
        `[vision:plan] ${event.wallCount} walls, ${event.openingCount} openings`,
      );
      console.log("world", {
        width: event.worldWidth,
        height: event.worldHeight,
      });
      console.table(event.walls);
      console.table(event.openings);
      console.groupEnd();
      break;
  }
}

/**
 * Runs the real ONNX pipeline and logs every stage. Unlike the normal import
 * flow, it never falls back to the heuristic vectorizer, so any failure is
 * surfaced directly.
 */
export async function debugVisionPipeline(
  file: File,
  options: VisionExtractionOptions,
): Promise<VisionExtractionResult> {
  const availability = await checkVisionModelAvailability(true);

  console.group(`[vision debug] ${file.name}`);
  console.log("model", VISION_MODEL_URL);
  console.log("availability", availability);

  if (!availability.available) {
    console.groupEnd();
    throw new Error(
      availability.reason ?? "Local ONNX vision model is not available.",
    );
  }

  try {
    const result = await extractVectorsFromImage(file, {
      ...options,
      preferHeuristic: false,
      allowFallback: false,
      debug: (event) => {
        printStage(event);
        options.debug?.(event);
      },
    });

    console.log("[vision:result]", {
      source: result.source,
      walls: result.walls.length,
      openings: result.openings.length,
      inferenceMs: result.inferenceMs,
    });

    return result;
  } finally {
    console.groupEnd();
  }
}
