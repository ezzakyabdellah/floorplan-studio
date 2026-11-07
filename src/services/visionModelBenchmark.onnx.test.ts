import fs from "node:fs";
import path from "node:path";
import { InferenceSession, Tensor } from "onnxruntime-node";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import type { Wall } from "../types/floorplan";
import {
  OVERLAY_DIM,
  OVERLAY_PALETTE,
  validatePlanOverlay,
} from "./planOverlayValidation";
import {
  VISION_MODEL_PRESETS,
  letterboxTransform,
  normalizeChw,
  stretchTransform,
  planarFloat32FromPixels,
  processVisionOutputs,
  type ImageTransform,
  type VisionClassRole,
  type VisionModelConfig,
  type VisionOutputMap,
} from "./visionModelService";

const ROOT = process.cwd();
const OUTPUT_DIR = path.resolve(ROOT, "debug", "benchmark");
const SAMPLES = ["plan01.jpeg", "plan02.jpeg"].map((name) =>
  path.resolve(ROOT, "src/samples", name),
);

type Candidate = {
  name: string;
  modelPath: string;
  config: VisionModelConfig;
};

const CANDIDATES: Candidate[] = [
  {
    name: "current",
    modelPath: path.resolve(ROOT, "public/models/floorplan-layout.onnx"),
    config: VISION_MODEL_PRESETS.current,
  },
  {
    name: "yytsi",
    modelPath: path.resolve(ROOT, "debug/models/yytsi-floorplan.onnx"),
    config: VISION_MODEL_PRESETS.yytsi,
  },
  {
    name: "openbim",
    modelPath: path.resolve(ROOT, "debug/models/openbim-floorplan.onnx"),
    config: VISION_MODEL_PRESETS.openbim,
  },
];

const sessions = new Map<string, InferenceSession>();

beforeAll(async () => {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  for (const candidate of CANDIDATES) {
    if (!fs.existsSync(candidate.modelPath)) {
      console.warn(`[benchmark] missing model ${candidate.modelPath}`);
      continue;
    }
    sessions.set(
      candidate.name,
      await InferenceSession.create(candidate.modelPath),
    );
  }
});

const ROLE_COLORS: Record<
  Exclude<VisionClassRole, null>,
  [number, number, number]
> = {
  wall: OVERLAY_PALETTE[1],
  door: OVERLAY_PALETTE[2],
  window: OVERLAY_PALETTE[3],
};

function buildOverlay(
  rgb: Uint8Array,
  logits: Float32Array | Uint8Array,
  channels: number,
  width: number,
  height: number,
  classRoles: Record<number, VisionClassRole>,
) {
  const plane = width * height;
  const overlay = new Uint8Array(plane * 3);

  for (let index = 0; index < plane; index += 1) {
    let bestChannel = 0;
    let bestValue = Number.NEGATIVE_INFINITY;
    for (let channel = 0; channel < channels; channel += 1) {
      const value = Number(logits[channel * plane + index]);
      if (value > bestValue) {
        bestValue = value;
        bestChannel = channel;
      }
    }

    const pixel = index * 3;
    const role = classRoles[bestChannel];
    const color = role ? ROLE_COLORS[role] : undefined;
    if (color) {
      overlay[pixel] = color[0];
      overlay[pixel + 1] = color[1];
      overlay[pixel + 2] = color[2];
      continue;
    }

    const gray = Math.round(
      (0.299 * rgb[pixel] +
        0.587 * rgb[pixel + 1] +
        0.114 * rgb[pixel + 2]) *
        OVERLAY_DIM,
    );
    overlay[pixel] = gray;
    overlay[pixel + 1] = gray;
    overlay[pixel + 2] = gray;
  }

  return overlay;
}

function classCounts(
  logits: Float32Array | Uint8Array,
  channels: number,
  width: number,
  height: number,
) {
  const plane = width * height;
  const counts = new Array<number>(channels).fill(0);
  for (let index = 0; index < plane; index += 1) {
    let bestChannel = 0;
    let bestValue = Number.NEGATIVE_INFINITY;
    for (let channel = 0; channel < channels; channel += 1) {
      const value = Number(logits[channel * plane + index]);
      if (value > bestValue) {
        bestValue = value;
        bestChannel = channel;
      }
    }
    counts[bestChannel] += 1;
  }
  return counts.map((pixels) => Number(((pixels / plane) * 100).toFixed(1)));
}

function countDuplicateWalls(walls: Wall[]) {
  let count = 0;
  for (let i = 0; i < walls.length; i += 1) {
    const a = walls[i];
    const aHorizontal = Math.abs(a.y1 - a.y2) <= 1e-6;
    for (let j = i + 1; j < walls.length; j += 1) {
      const b = walls[j];
      if ((Math.abs(b.y1 - b.y2) <= 1e-6) !== aHorizontal) continue;
      const [aStart, aEnd, aCenter, bStart, bEnd, bCenter] = aHorizontal
        ? [a.x1, a.x2, a.y1, b.x1, b.x2, b.y1]
        : [a.y1, a.y2, a.x1, b.y1, b.y2, b.x1];
      const overlap = Math.min(aEnd, bEnd) - Math.max(aStart, bStart);
      const shortest = Math.min(aEnd - aStart, bEnd - bStart);
      if (overlap < shortest * 0.4) continue;
      const gap =
        Math.max(aCenter - a.thickness / 2, bCenter - b.thickness / 2) -
        Math.min(aCenter + a.thickness / 2, bCenter + b.thickness / 2);
      if (gap <= 0.25) count += 1;
    }
  }
  return count;
}

function buildWallsSvg(plan: {
  walls: Wall[];
  worldWidth: number;
  worldHeight: number;
}) {
  const pad = 2;
  const lines = plan.walls
    .map(
      (wall) =>
        `<line x1="${wall.x1}" y1="${wall.y1}" x2="${wall.x2}" y2="${wall.y2}" stroke="#f8fafc" stroke-width="${Math.max(wall.thickness, 0.15)}" stroke-linecap="butt"/>`,
    )
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(plan.worldWidth * 8)}" height="${Math.round(plan.worldHeight * 8)}" viewBox="${-pad} ${-pad} ${plan.worldWidth + pad * 2} ${plan.worldHeight + pad * 2}"><rect x="${-pad}" y="${-pad}" width="${plan.worldWidth + pad * 2}" height="${plan.worldHeight + pad * 2}" fill="#0b1220"/>${lines}</svg>`;
}

async function runCandidate(
  candidate: Candidate,
  samplePath: string,
  session: InferenceSession,
) {
  const sampleName = path.basename(samplePath, path.extname(samplePath));
  const { inputSize, padding, normalization } = candidate.config;
  const metadata = await sharp(samplePath).metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error(`Could not read ${samplePath}`);
  }

  const transform: ImageTransform =
    candidate.config.resizeMode === "stretch"
      ? stretchTransform(metadata.width, metadata.height, inputSize)
      : letterboxTransform(metadata.width, metadata.height, inputSize);
  const { data } = await sharp(samplePath)
    .resize(inputSize, inputSize, {
      fit: candidate.config.resizeMode === "stretch" ? "fill" : "contain",
      background: { r: padding[0], g: padding[1], b: padding[2] },
    })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const values = normalizeChw(
    planarFloat32FromPixels(data, 3, inputSize),
    normalization,
  );
  const tensor = new Tensor("float32", values, [1, 3, inputSize, inputSize]);

  const startedAt = performance.now();
  const outputs = await session.run({
    [session.inputNames[0]]: tensor,
  });
  const inferenceMs = performance.now() - startedAt;

  const outputMap: VisionOutputMap = {};
  for (const [name, output] of Object.entries(outputs)) {
    const value = output as Tensor;
    outputMap[name] = {
      data: value.data as Float32Array | Uint8Array,
      dims: value.dims,
    };
  }

  const primary = outputMap[session.outputNames[0]];
  const [, channels, height, width] = primary.dims as number[];
  const result = processVisionOutputs(outputMap, transform, 0.1, {
    classRoles: candidate.config.classRoles,
  });

  const overlay = buildOverlay(
    data,
    primary.data,
    channels,
    width,
    height,
    candidate.config.classRoles,
  );
  const validation = validatePlanOverlay(
    overlay,
    width,
    height,
    result.plan,
    transform,
    result.plan.meta,
  );

  const prefix = `${candidate.name}-${sampleName}`;
  const overlayPath = path.resolve(OUTPUT_DIR, `${prefix}-overlay.png`);
  const validationPath = path.resolve(OUTPUT_DIR, `${prefix}-validation.png`);
  const wallsPath = path.resolve(OUTPUT_DIR, `${prefix}-walls.png`);
  await sharp(Buffer.from(overlay), {
    raw: { width, height, channels: 3 },
  })
    .png()
    .toFile(overlayPath);
  await sharp(Buffer.from(validation.validationImage), {
    raw: { width: validation.width, height: validation.height, channels: 3 },
  })
    .png()
    .toFile(validationPath);
  await sharp(Buffer.from(buildWallsSvg(result.plan)))
    .png()
    .toFile(wallsPath);

  const metrics = {
    model: candidate.name,
    sample: sampleName,
    inputSize,
    inferenceMs: Number(inferenceMs.toFixed(0)),
    classPct: classCounts(primary.data, channels, width, height),
    walls: result.plan.walls.length,
    openings: result.plan.openings.length,
    duplicateWallPairs: countDuplicateWalls(result.plan.walls),
    wallCoverage: Number((validation.wallCoverage * 100).toFixed(1)),
    wallPrecision: Number((validation.wallPrecision * 100).toFixed(1)),
    missingOpenings: validation.missingOpenings.length,
  };

  console.log(
    `\n[benchmark] ${candidate.name} / ${sampleName}`,
  );
  console.table(metrics);
  console.log("outputs ->", {
    overlay: path.relative(ROOT, overlayPath),
    validation: path.relative(ROOT, validationPath),
    walls: path.relative(ROOT, wallsPath),
  });

  return metrics;
}

describe("model benchmark", () => {
  it.each(SAMPLES)("compares candidates on %s", async (samplePath) => {
    for (const candidate of CANDIDATES) {
      const session = sessions.get(candidate.name);
      if (!session) continue;
      const metrics = await runCandidate(candidate, samplePath, session);
      expect(metrics.walls).toBeGreaterThan(0);
    }
  });
});
