import { describe, expect, it } from "vitest";
import {
  buildPlanFromSegments,
  classRole,
  dedupeParallelSegments,
  detectionSegments,
  parseDetections,
  segmentationPlan,
  type Detection,
  type ImageTransform,
  type PixelOpening,
  type PixelSegment,
} from "./visionModelService";

// These tests call the pure stages directly, so the heuristic vectorizer can
// never run. Each describe block mirrors one stage of the ONNX pipeline.

const log = (label: string, value: unknown) => {
  console.log(`\n[${label}]`);
  console.table(value);
};

function attributesFirst(
  attributes: number,
  count: number,
  rows: number[][],
): { data: Float32Array; dims: number[] } {
  const data = new Float32Array(attributes * count);
  rows.forEach((row, box) => {
    for (let attribute = 0; attribute < attributes; attribute += 1) {
      data[attribute * count + box] = row[attribute] ?? 0;
    }
  });
  return { data, dims: [1, attributes, count] };
}

function boxesFirst(
  attributes: number,
  count: number,
  rows: number[][],
): { data: Float32Array; dims: number[] } {
  const data = new Float32Array(attributes * count);
  rows.forEach((row, box) => {
    for (let attribute = 0; attribute < attributes; attribute += 1) {
      data[box * attributes + attribute] = row[attribute] ?? 0;
    }
  });
  return { data, dims: [1, count, attributes] };
}

const transform = (
  overrides: Partial<ImageTransform> = {},
): ImageTransform => ({
  imageWidth: 640,
  imageHeight: 640,
  scale: 1,
  padX: 0,
  padY: 0,
  ...overrides,
});

describe("stage 1 - parseDetections", () => {
  it("reads [1, attributes, boxes] layout with pixel coordinates", () => {
    const { data, dims } = attributesFirst(6, 8, [
      [10, 20, 110, 25, 0.9, 0],
      [200, 300, 205, 400, 0.8, 1],
      [0, 0, 0, 0, 0.1, 0],
    ]);

    const parsed = parseDetections(data, dims);
    log("attributes-first detections", parsed?.detections);

    expect(parsed).not.toBeNull();
    expect(parsed?.detections).toHaveLength(2);
    expect(parsed?.detections[0]).toMatchObject({
      x1: 10,
      y1: 20,
      x2: 110,
      y2: 25,
      classId: 0,
    });
    expect(parsed?.detections[0].score).toBeCloseTo(0.9);
    expect(parsed?.classCount).toBe(2);
  });

  it("reads [1, boxes, attributes] layout and scales normalized coordinates", () => {
    const { data, dims } = boxesFirst(6, 10, [
      [0.1, 0.2, 0.3, 0.25, 0.9, 0],
    ]);

    const parsed = parseDetections(data, dims);
    log("boxes-first normalized detections", parsed?.detections);

    expect(parsed?.detections).toHaveLength(1);
    expect(parsed?.detections[0].x1).toBeCloseTo(64);
    expect(parsed?.detections[0].y1).toBeCloseTo(128);
    expect(parsed?.detections[0].x2).toBeCloseTo(192);
    expect(parsed?.detections[0].y2).toBeCloseTo(160);
  });

  it("multiplies class score by objectness for >= 8 attribute YOLO output", () => {
    const row = new Array(84).fill(0);
    row[0] = 100;
    row[1] = 100;
    row[2] = 200;
    row[3] = 120;
    row[4] = 0.8;
    row[7] = 0.5;
    const { data, dims } = attributesFirst(84, 100, [row]);

    const parsed = parseDetections(data, dims);
    log("yolo with objectness", {
      box: parsed?.detections[0],
      classCount: parsed?.classCount,
    });

    expect(parsed?.detections).toHaveLength(1);
    expect(parsed?.detections[0].classId).toBe(2);
    expect(parsed?.detections[0].score).toBeCloseTo(0.4);
    expect(parsed?.classCount).toBe(79);
  });

  it("drops boxes below the 0.25 confidence cutoff", () => {
    const { data, dims } = attributesFirst(6, 8, [
      [10, 10, 50, 20, 0.2, 0],
      [10, 10, 50, 20, 0.24, 0],
      [10, 10, 50, 20, 0.26, 0],
    ]);

    const parsed = parseDetections(data, dims);
    log("confidence filter", parsed?.detections);

    expect(parsed?.detections).toHaveLength(1);
    expect(parsed?.detections[0].score).toBeCloseTo(0.26);
  });

  it("interprets center/width/height boxes when xyxy is not possible", () => {
    const { data, dims } = attributesFirst(6, 8, [
      [320, 320, 100, 20, 0.9, 0],
    ]);

    const parsed = parseDetections(data, dims);
    log("cxcywh box", parsed?.detections);

    expect(parsed?.detections[0]).toMatchObject({
      x1: 270,
      y1: 310,
      x2: 370,
      y2: 330,
    });
  });

  it("returns null for shapes it cannot interpret", () => {
    expect(parseDetections(new Float32Array(0), [1])).toBeNull();
    expect(parseDetections(new Float32Array(9), [1, 3, 3])).toBeNull();
    expect(parseDetections(new Float32Array(18), [2, 6, 3])).toBeNull();
    expect(parseDetections(new Float32Array(8), [1, 2, 4])).toBeNull();
  });
});

describe("stage 2 - classRole", () => {
  it("uses 0/1/2 as wall/door/window for small class counts", () => {
    expect(classRole(0, 3)).toBe("wall");
    expect(classRole(1, 3)).toBe("door");
    expect(classRole(2, 3)).toBe("window");
    expect(classRole(3, 3)).toBeNull();
  });

  it("uses 1/2/3 as wall/door/window for larger class counts", () => {
    expect(classRole(0, 79)).toBeNull();
    expect(classRole(1, 79)).toBe("wall");
    expect(classRole(2, 79)).toBe("door");
    expect(classRole(3, 79)).toBe("window");
  });
});

describe("stage 3 - detectionSegments", () => {
  it("turns a horizontal wall box into a line segment", () => {
    const detections: Detection[] = [
      { x1: 10, y1: 20, x2: 110, y2: 26, classId: 0, score: 0.9 },
    ];

    const result = detectionSegments(detections, 3, transform(), 0.1);
    log("horizontal wall", result);

    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]).toEqual({
      orientation: "h",
      start: 10,
      end: 110,
      center: 23,
      thickness: 6,
    });
    expect(result.openings).toHaveLength(0);
  });

  it("turns a vertical wall box into a line segment", () => {
    const detections: Detection[] = [
      { x1: 20, y1: 10, x2: 26, y2: 110, classId: 0, score: 0.9 },
    ];

    const result = detectionSegments(detections, 3, transform(), 0.1);
    log("vertical wall", result.segments);

    expect(result.segments[0]).toEqual({
      orientation: "v",
      start: 10,
      end: 110,
      center: 23,
      thickness: 6,
    });
  });

  it("maps model coordinates back through the letterbox transform", () => {
    const detections: Detection[] = [
      { x1: 70, y1: 50, x2: 170, y2: 60, classId: 0, score: 0.9 },
    ];

    const result = detectionSegments(
      detections,
      3,
      transform({ scale: 0.5, padX: 20, padY: 30 }),
      0.1,
    );
    log("letterbox unmapping", result.segments);

    expect(result.segments[0]).toEqual({
      orientation: "h",
      start: 100,
      end: 300,
      center: 50,
      thickness: 20,
    });
  });

  it("turns door and window boxes into openings", () => {
    const detections: Detection[] = [
      { x1: 100, y1: 200, x2: 140, y2: 210, classId: 1, score: 0.9 },
      { x1: 300, y1: 200, x2: 340, y2: 210, classId: 2, score: 0.7 },
    ];

    const result = detectionSegments(detections, 3, transform(), 0.1);
    log("openings", result.openings);

    expect(result.segments).toHaveLength(0);
    expect(result.openings.map((opening) => opening.type)).toEqual([
      "door",
      "window",
    ]);
    expect(result.openings[0]).toMatchObject({
      minX: 100,
      minY: 200,
      maxX: 140,
      maxY: 210,
      score: 0.9,
    });
  });

  it("skips tiny boxes and walls thinner than the scale filter", () => {
    const tiny: Detection[] = [
      { x1: 10, y1: 10, x2: 11, y2: 50, classId: 0, score: 0.9 },
    ];
    expect(detectionSegments(tiny, 3, transform(), 0.1).segments).toHaveLength(
      0,
    );

    const thin: Detection[] = [
      { x1: 10, y1: 10, x2: 200, y2: 16, classId: 0, score: 0.9 },
    ];
    // 0.01 ft/px makes a nominal wall ~35px thick, so a 6px wall is dropped.
    expect(detectionSegments(thin, 3, transform(), 0.01).segments).toHaveLength(
      0,
    );
  });
});

describe("stage 4 - buildPlanFromSegments", () => {
  it("converts a pixel segment into feet and sizes the world", () => {
    const segments: PixelSegment[] = [
      { orientation: "h", start: 0, end: 100, center: 10, thickness: 5 },
    ];

    const plan = buildPlanFromSegments(segments, [], 0.1);
    log("plan from one wall", plan);

    expect(plan.walls).toHaveLength(1);
    expect(plan.walls[0]).toMatchObject({
      x1: 0.5,
      y1: 0.75,
      x2: 10.5,
      y2: 0.75,
      thickness: 0.5,
    });
    expect(plan.worldWidth).toBeCloseTo(11);
    expect(plan.worldHeight).toBeCloseTo(1.5);
  });

  it("snaps an opening onto the nearest wall", () => {
    const segments: PixelSegment[] = [
      { orientation: "h", start: 0, end: 200, center: 50, thickness: 6 },
    ];
    const openings: PixelOpening[] = [
      {
        type: "door",
        minX: 90,
        minY: 47,
        maxX: 110,
        maxY: 53,
        score: 0.9,
      },
    ];

    const plan = buildPlanFromSegments(segments, openings, 0.1);
    log("plan with opening", plan);

    expect(plan.openings).toHaveLength(1);
    expect(plan.openings[0]).toMatchObject({
      wallId: plan.walls[0].id,
      type: "door",
      positionOnWall: 0.5,
      width: 2,
    });
  });

  it("splits crossing imported walls into connected junction endpoints", () => {
    const segments: PixelSegment[] = [
      { orientation: "h", start: 0, end: 100, center: 50, thickness: 6 },
      { orientation: "v", start: 0, end: 100, center: 50, thickness: 6 },
    ];

    const plan = buildPlanFromSegments(segments, [], 0.1);
    const crossing = { x: 5.5, y: 5.5 };
    const endpointsAtCrossing = plan.walls.flatMap((wall) => [
      { x: wall.x1, y: wall.y1 },
      { x: wall.x2, y: wall.y2 },
    ]).filter(
      (point) =>
        Math.abs(point.x - crossing.x) < 1e-6 &&
        Math.abs(point.y - crossing.y) < 1e-6,
    );

    expect(plan.walls).toHaveLength(4);
    expect(endpointsAtCrossing).toHaveLength(4);
  });

  it("snaps a near-miss imported T-junction together", () => {
    const segments: PixelSegment[] = [
      { orientation: "h", start: 0, end: 100, center: 50, thickness: 6 },
      { orientation: "v", start: 50.3, end: 100, center: 50.2, thickness: 6 },
    ];

    const plan = buildPlanFromSegments(segments, [], 0.1);
    const junction = { x: 5.52, y: 0.8 };
    const endpointsAtJunction = plan.walls.flatMap((wall) => [
      { x: wall.x1, y: wall.y1 },
      { x: wall.x2, y: wall.y2 },
    ]).filter(
      (point) =>
        Math.abs(point.x - junction.x) < 1e-6 &&
        Math.abs(point.y - junction.y) < 1e-6,
    );

    expect(plan.walls).toHaveLength(3);
    expect(endpointsAtJunction).toHaveLength(3);
  });

  it("leaves perpendicular walls separated beyond junction tolerance alone", () => {
    const segments: PixelSegment[] = [
      { orientation: "h", start: 0, end: 40, center: 50, thickness: 6 },
      { orientation: "v", start: 60, end: 100, center: 50, thickness: 6 },
    ];

    const plan = buildPlanFromSegments(segments, [], 0.1);

    expect(plan.walls).toHaveLength(2);
    expect(plan.walls[0].x2).toBeCloseTo(4.5);
    expect(plan.walls[1].y1).toBeCloseTo(1.8);
  });

  it("extends one-sided wall stubs through adjacent door masks", () => {
    const segments: PixelSegment[] = [
      { orientation: "h", start: 0, end: 40, center: 10, thickness: 6 },
      { orientation: "h", start: 100, end: 140, center: 10, thickness: 6 },
    ];
    const openings: PixelOpening[] = [
      {
        type: "door",
        minX: 40,
        minY: 7,
        maxX: 60,
        maxY: 13,
        score: 0.9,
      },
      {
        type: "door",
        minX: 80,
        minY: 7,
        maxX: 100,
        maxY: 13,
        score: 0.9,
      },
    ];

    const plan = buildPlanFromSegments(segments, openings, 0.1);

    expect(plan.walls).toHaveLength(1);
    expect(plan.walls[0].x2 - plan.walls[0].x1).toBeCloseTo(14);
    expect(plan.openings).toHaveLength(2);
    expect(plan.openings[0].positionOnWall).toBeCloseTo(50 / 140);
    expect(plan.openings[1].positionOnWall).toBeCloseTo(90 / 140);
  });

  it("rejects geometry that is too short or too thick in feet", () => {
    const short: PixelSegment[] = [
      { orientation: "h", start: 0, end: 5, center: 10, thickness: 3 },
    ];
    expect(() => buildPlanFromSegments(short, [], 0.1)).toThrow(
      /usable wall geometry/,
    );

    const thick: PixelSegment[] = [
      { orientation: "h", start: 0, end: 100, center: 10, thickness: 100 },
    ];
    expect(() => buildPlanFromSegments(thick, [], 0.1)).toThrow(
      /usable wall geometry/,
    );
  });

  it("rejects sliver walls below the minimum thickness", () => {
    const sliver: PixelSegment[] = [
      { orientation: "h", start: 0, end: 100, center: 10, thickness: 0.5 },
    ];
    expect(() => buildPlanFromSegments(sliver, [], 0.1)).toThrow(
      /usable wall geometry/,
    );
  });
});

describe("stage 5 - dedupeParallelSegments", () => {
  it("merges a hollow double-line wall into one wall", () => {
    const segments: PixelSegment[] = [
      { orientation: "h", start: 0, end: 100, center: 10, thickness: 2 },
      { orientation: "h", start: 0, end: 100, center: 20, thickness: 2 },
    ];

    const result = dedupeParallelSegments(segments, 0.1);
    log("merged hollow wall", result);

    expect(result).toHaveLength(1);
    expect(result[0].orientation).toBe("h");
    expect(result[0].start).toBe(0);
    expect(result[0].end).toBe(100);
    expect(result[0].center).toBeCloseTo(15);
    expect(result[0].thickness).toBeCloseTo(12);
  });

  it("keeps genuinely separate parallel walls", () => {
    const segments: PixelSegment[] = [
      { orientation: "h", start: 0, end: 100, center: 10, thickness: 2 },
      { orientation: "h", start: 0, end: 100, center: 60, thickness: 2 },
    ];

    const result = dedupeParallelSegments(segments, 0.1);
    log("separate parallel walls", result);

    expect(result).toHaveLength(2);
  });

  it("drops a thin edge sliver inside a thicker wall band", () => {
    const segments: PixelSegment[] = [
      { orientation: "h", start: 0, end: 100, center: 10, thickness: 2 },
      { orientation: "h", start: 0, end: 100, center: 10.5, thickness: 20 },
    ];

    const result = dedupeParallelSegments(segments, 0.1);
    log("edge sliver removed", result);

    expect(result).toHaveLength(1);
    expect(result[0].thickness).toBe(20);
  });
});

describe("segmentationPlan opening components", () => {
  it("keeps small but coherent door regions on scanned plans", () => {
    const width = 640;
    const height = 640;
    const plane = width * height;
    const masks = Array.from({ length: 4 }, () => new Uint8Array(plane));

    // The real plan02 model produces adjacent door components of 51 and 33
    // pixels. Both are architectural openings, but the previous 0.015% area
    // cutoff discarded them at 640x640.
    for (let y = 100; y < 103; y += 1) {
      for (let x = 100; x < 111; x += 1) masks[2][y * width + x] = 1;
    }
    for (let y = 200; y < 203; y += 1) {
      for (let x = 200; x < 217; x += 1) masks[2][y * width + x] = 1;
    }

    const result = segmentationPlan(
      masks,
      masks.length,
      width,
      height,
      transform({ imageWidth: width, imageHeight: height }),
    );

    expect(result.openings).toHaveLength(2);
    expect(result.openings.map(({ minX, maxX, minY, maxY }) => [
      minX,
      maxX,
      minY,
      maxY,
    ])).toEqual([
      [100, 111, 100, 103],
      [200, 217, 200, 203],
    ]);
  });
});
