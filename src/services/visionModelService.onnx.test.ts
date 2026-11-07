import fs from "node:fs";
import path from "node:path";
import { InferenceSession, Tensor } from "onnxruntime-node";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import type { Opening, Wall } from "../types/floorplan";
import { pointAtDistance, wallLength } from "../utils/geometry";
import {
  OVERLAY_DIM,
  OVERLAY_PALETTE,
  validatePlanOverlay,
} from "./planOverlayValidation";
import { suggestFurnitureLayout } from "./furniturePlanner";
import {
  VISION_INPUT_SIZE,
  letterboxTransform,
  parseDetections,
  planarFloat32FromPixels,
  processVisionOutputs,
  segClassRole,
  segmentationOutputs,
  segmentationPlan,
  segmentationToMasks,
  type ImageTransform,
  type PlanMeta,
  type VisionOutputMap,
} from "./visionModelService";
import { suggestFurnitureWithLocalAI } from "./furnitureAiService";
import { checkOllamaStatus, DEFAULT_AI_MODELS } from "./localAiService";

const ROOT = process.cwd();
const MODEL_PATH = path.resolve(ROOT, "public/models/floorplan-layout.onnx");
const SAMPLES = ["plan01.jpeg", "plan02.jpeg"].map((name) =>
  path.resolve(ROOT, "src/samples", name),
);

let session: InferenceSession;

beforeAll(async () => {
  session = await InferenceSession.create(MODEL_PATH);
  console.log("[onnx] inputs", session.inputNames);
  console.log("[onnx] outputs", session.outputNames);
});

function countDuplicateWalls(walls: Wall[]): number {
  let count = 0;

  for (let i = 0; i < walls.length; i += 1) {
    const a = walls[i];
    const aHorizontal = Math.abs(a.y1 - a.y2) <= 1e-6;

    for (let j = i + 1; j < walls.length; j += 1) {
      const b = walls[j];
      const bHorizontal = Math.abs(b.y1 - b.y2) <= 1e-6;
      if (aHorizontal !== bHorizontal) continue;

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
}): string {
  const pad = 2;
  const width = plan.worldWidth;
  const height = plan.worldHeight;
  const lines = plan.walls
    .map(
      (wall) =>
        `<line x1="${wall.x1}" y1="${wall.y1}" x2="${wall.x2}" y2="${wall.y2}" stroke="#f8fafc" stroke-width="${Math.max(wall.thickness, 0.15)}" stroke-linecap="butt"/>`,
    )
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(width * 8)}" height="${Math.round(height * 8)}" viewBox="${-pad} ${-pad} ${width + pad * 2} ${height + pad * 2}"><rect x="${-pad}" y="${-pad}" width="${width + pad * 2}" height="${height + pad * 2}" fill="#0b1220"/>${lines}</svg>`;
}

function buildOverlayPixels(
  rgb: Uint8Array,
  logits: Float32Array | Uint8Array,
  channels: number,
  width: number,
  height: number,
): Buffer {
  const plane = width * height;
  const out = Buffer.alloc(plane * 3);

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

    const target = index * 3;
    const color = OVERLAY_PALETTE[bestChannel];
    if (color) {
      out[target] = color[0];
      out[target + 1] = color[1];
      out[target + 2] = color[2];
      continue;
    }

    const source = index * 3;
    const gray = Math.round(
      (0.299 * rgb[source] +
        0.587 * rgb[source + 1] +
        0.114 * rgb[source + 2]) *
        OVERLAY_DIM,
    );
    out[target] = gray;
    out[target + 1] = gray;
    out[target + 2] = gray;
  }

  return out;
}

function buildClassPixels(
  rgb: Uint8Array,
  mask: Uint8Array,
  color: [number, number, number],
): Buffer {
  const out = Buffer.alloc(mask.length * 3);

  for (let index = 0; index < mask.length; index += 1) {
    const pixel = index * 3;
    if (mask[index]) {
      out[pixel] = color[0];
      out[pixel + 1] = color[1];
      out[pixel + 2] = color[2];
      continue;
    }

    const gray = Math.round(
      (0.299 * rgb[pixel] + 0.587 * rgb[pixel + 1] + 0.114 * rgb[pixel + 2]) *
        OVERLAY_DIM,
    );
    out[pixel] = gray;
    out[pixel + 1] = gray;
    out[pixel + 2] = gray;
  }

  return out;
}

function buildOpeningAttachmentSvg(
  plan: { walls: Wall[]; openings: Opening[]; meta: PlanMeta },
  transform: ImageTransform,
) {
  const scaleX = transform.scaleX ?? transform.scale;
  const scaleY = transform.scaleY ?? transform.scale;
  const modelPoint = (x: number, y: number) => ({
    x:
      (((x - plan.meta.margin) / plan.meta.feetPerPixel + plan.meta.minX) *
        scaleX) +
      transform.padX,
    y:
      (((y - plan.meta.margin) / plan.meta.feetPerPixel + plan.meta.minY) *
        scaleY) +
      transform.padY,
  });
  const sourcePoint = (x: number, y: number) => ({
    x: (x - transform.padX) / scaleX,
    y: (y - transform.padY) / scaleY,
  });

  const summaries: Array<Record<string, string | number>> = [];
  const wallSummaries = plan.walls.map((wall) => {
    const modelA = modelPoint(wall.x1, wall.y1);
    const modelB = modelPoint(wall.x2, wall.y2);
    const a = sourcePoint(modelA.x, modelA.y);
    const b = sourcePoint(modelB.x, modelB.y);
    return {
      wallId: wall.id,
      orientation: Math.abs(wall.y1 - wall.y2) <= 1e-6 ? "horizontal" : "vertical",
      imageX1: Number(a.x.toFixed(1)),
      imageY1: Number(a.y.toFixed(1)),
      imageX2: Number(b.x.toFixed(1)),
      imageY2: Number(b.y.toFixed(1)),
    };
  });
  const marks = plan.openings.flatMap((opening, index) => {
    const wall = plan.walls.find((candidate) => candidate.id === opening.wallId);
    if (!wall) return [];
    const length = wallLength(wall);
    if (length <= 0) return [];

    const center = opening.positionOnWall * length;
    const start = pointAtDistance(wall, Math.max(0, center - opening.width / 2));
    const end = pointAtDistance(
      wall,
      Math.min(length, center + opening.width / 2),
    );
    const a = modelPoint(start.x, start.y);
    const b = modelPoint(end.x, end.y);
    const centerImage = sourcePoint((a.x + b.x) / 2, (a.y + b.y) / 2);
    const horizontal = Math.abs(wall.y1 - wall.y2) <= 1e-6;

    summaries.push({
      opening: index,
      type: opening.type,
      wallId: wall.id,
      wallOrientation: horizontal ? "horizontal" : "vertical",
      imageX: Number(centerImage.x.toFixed(1)),
      imageY: Number(centerImage.y.toFixed(1)),
      widthFeet: Number(opening.width.toFixed(2)),
    });

    const color = opening.type === "door" ? "#ff2d95" : "#00e5ff";
    return [
      `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${color}" stroke-width="4" stroke-linecap="round"/>`,
      `<circle cx="${(a.x + b.x) / 2}" cy="${(a.y + b.y) / 2}" r="3" fill="#ffffff" stroke="${color}" stroke-width="2"/>`,
    ];
  });

  return {
    summaries,
    wallSummaries,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${VISION_INPUT_SIZE}" height="${VISION_INPUT_SIZE}" viewBox="0 0 ${VISION_INPUT_SIZE} ${VISION_INPUT_SIZE}">${marks.join("")}</svg>`,
  };
}

function buildFurnitureLayoutSvg(
  walls: Wall[],
  furniture: ReturnType<typeof suggestFurnitureLayout>["furniture"],
) {
  const points = walls.flatMap((wall) => [
    { x: wall.x1, y: wall.y1 },
    { x: wall.x2, y: wall.y2 },
  ]);
  if (points.length === 0) return "<svg xmlns=\"http://www.w3.org/2000/svg\"/>";
  const pad = 2;
  const minX = Math.min(...points.map((point) => point.x)) - pad;
  const maxX = Math.max(...points.map((point) => point.x)) + pad;
  const minY = Math.min(...points.map((point) => point.y)) - pad;
  const maxY = Math.max(...points.map((point) => point.y)) + pad;
  const scale = 8;
  const colors: Record<string, string> = {
    bed: "#74a9d8",
    nightstand: "#d2b48c",
    wardrobe: "#a98764",
    sofa: "#7d927f",
    "coffee-table": "#c7955c",
    "media-console": "#667b83",
    desk: "#c39b6a",
    "desk-chair": "#79908c",
    "dining-table": "#c7955c",
    chair: "#839a8b",
  };
  const wallsSvg = walls
    .map(
      (wall) =>
        `<line x1="${wall.x1}" y1="${wall.y1}" x2="${wall.x2}" y2="${wall.y2}" stroke="#435363" stroke-width="${Math.max(wall.thickness, 0.12)}"/>`,
    )
    .join("");
  const furnitureSvg = furniture
    .map(
      (item) =>
        `<rect x="${item.x - item.width / 2}" y="${item.y - item.depth / 2}" width="${item.width}" height="${item.depth}" rx="0.2" fill="${colors[item.kind] ?? "#a8b9a9"}" stroke="#334155" stroke-width="0.12" transform="rotate(${(-item.rotation * 180) / Math.PI} ${item.x} ${item.y})"><title>${item.roomLabel}: ${item.kind}</title></rect>`,
    )
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round((maxX - minX) * scale)}" height="${Math.round((maxY - minY) * scale)}" viewBox="${minX} ${minY} ${maxX - minX} ${maxY - minY}"><rect x="${minX}" y="${minY}" width="${maxX - minX}" height="${maxY - minY}" fill="#f3eee4"/>${wallsSvg}${furnitureSvg}</svg>`;
}

function pixelStats(data: ArrayLike<number>) {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let sum = 0;
  for (let index = 0; index < data.length; index += 1) {
    const value = Number(data[index]);
    if (value < min) min = value;
    if (value > max) max = value;
    sum += value;
  }
  return {
    min: Number(min.toFixed(3)),
    max: Number(max.toFixed(3)),
    mean: Number((sum / Math.max(1, data.length)).toFixed(3)),
  };
}

function channelStats(
  data: ArrayLike<number>,
  channels: number,
  width: number,
  height: number,
) {
  const plane = width * height;
  return Array.from({ length: channels }, (_, channel) => {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let sum = 0;
    let aboveHalf = 0;
    for (let index = 0; index < plane; index += 1) {
      const value = Number(data[channel * plane + index]);
      if (value < min) min = value;
      if (value > max) max = value;
      sum += value;
      if (value > 0.5) aboveHalf += 1;
    }
    return {
      channel,
      role: segClassRole(channel, channels) ?? "ignored",
      min: Number(min.toFixed(3)),
      max: Number(max.toFixed(3)),
      mean: Number((sum / plane).toFixed(3)),
      aboveHalfPct: Number(((aboveHalf / plane) * 100).toFixed(1)),
    };
  });
}

function classHistogram(
  data: ArrayLike<number>,
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
      const value = Number(data[channel * plane + index]);
      if (value > bestValue) {
        bestValue = value;
        bestChannel = channel;
      }
    }
    counts[bestChannel] += 1;
  }
  return counts.map((pixels, channel) => ({
    class: channel,
    role: segClassRole(channel, channels) ?? "background/ignored",
    pixels,
    pct: Number(((pixels / plane) * 100).toFixed(1)),
  }));
}

function maskSummary(mask: Uint8Array, width: number, height: number) {
  let pixels = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) continue;
      pixels += 1;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return {
    pixels,
    bbox: pixels > 0 ? `${minX},${minY} -> ${maxX},${maxY}` : "empty",
  };
}

async function buildInput(samplePath: string) {
  const metadata = await sharp(samplePath).metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error(`Could not read dimensions for ${samplePath}`);
  }

  const transform = letterboxTransform(metadata.width, metadata.height);
  const { data, info } = await sharp(samplePath)
    .resize(VISION_INPUT_SIZE, VISION_INPUT_SIZE, {
      fit: "contain",
      background: { r: 114, g: 114, b: 114 },
    })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (info.channels !== 3) {
    throw new Error(`Expected 3 RGB channels, got ${info.channels}`);
  }

  return {
    transform,
    rgb: data,
    tensor: new Tensor(
      "float32",
      planarFloat32FromPixels(data, 3),
      [1, 3, VISION_INPUT_SIZE, VISION_INPUT_SIZE],
    ),
  };
}

describe.each(SAMPLES)("real ONNX model on %s", (samplePath) => {
  it("walks every pipeline stage with real model output", async () => {
    const sampleName = path.basename(samplePath, path.extname(samplePath));
    console.group(`\n=== ${sampleName} ===`);

    // ---------------------------------------------------------------- STEP 1
    console.group("STEP 1 - preprocess: image -> letterboxed [1,3,640,640]");
    const { transform, rgb, tensor } = await buildInput(samplePath);
    console.log("source image", {
      width: transform.imageWidth,
      height: transform.imageHeight,
    });
    console.log("letterbox", {
      scale: Number(transform.scale.toFixed(4)),
      padX: Number(transform.padX.toFixed(2)),
      padY: Number(transform.padY.toFixed(2)),
    });
    console.log("tensor", {
      dims: tensor.dims,
      stats: pixelStats(tensor.data as Float32Array),
    });
    console.groupEnd();

    // ---------------------------------------------------------------- STEP 2
    console.group("STEP 2 - inference: session.run(tensor)");
    const inputName = session.inputNames[0];
    const outputs = await session.run({ [inputName]: tensor });

    const outputMap: VisionOutputMap = {};
    for (const [name, output] of Object.entries(outputs)) {
      const value = output as Tensor;
      outputMap[name] = {
        data: value.data as Float32Array | Uint8Array,
        dims: value.dims,
      };
    }

    const primaryName = session.outputNames[0];
    const primary = outputMap[primaryName];
    const [, channels, height, width] = primary.dims as number[];
    console.log("output tensor", { name: primaryName, dims: primary.dims });
    console.table(channelStats(primary.data, channels, width, height));
    console.log("argmax class distribution");
    console.table(classHistogram(primary.data, channels, width, height));
    console.groupEnd();

    // ---------------------------------------------------------------- STEP 3
    console.group("STEP 3 - parseDetections (box path)");
    const detections = parseDetections(primary.data, primary.dims);
    console.log(
      "result",
      detections === null
        ? "null - 4D logits are a segmentation tensor, not boxes"
        : detections,
    );
    expect(detections).toBeNull();
    console.groupEnd();

    // ---------------------------------------------------------------- STEP 4
    console.group("STEP 4 - segmentationOutputs: recognise mask layout");
    const segmentation = segmentationOutputs(outputMap);
    expect(segmentation).not.toBeNull();
    if (!segmentation) throw new Error("No segmentation output found.");
    console.log("mask layout", {
      channels: segmentation.channels,
      width: segmentation.width,
      height: segmentation.height,
      layout: "[1, classes, height, width]",
    });
    console.groupEnd();

    // ---------------------------------------------------------------- STEP 5
    console.group("STEP 5 - segmentationToMasks: argmax -> binary masks");
    const masks = segmentationToMasks(
      segmentation.data,
      segmentation.channels,
      segmentation.width,
      segmentation.height,
    );
    console.table(
      masks.map((mask, channel) => ({
        channel,
        role: segClassRole(channel, segmentation.channels) ?? "ignored",
        ...maskSummary(mask, segmentation.width, segmentation.height),
      })),
    );
    console.groupEnd();

    // -------------------------------------------------------------- STEP 5b
    console.group("STEP 5b - write colored overlay image");
    const overlayPixels = buildOverlayPixels(
      rgb,
      primary.data,
      channels,
      width,
      height,
    );
    const base = path.basename(samplePath, path.extname(samplePath));
    const overlayPath = path.resolve(ROOT, "debug", `v_${base}_overlay.png`);
    fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
    await sharp(overlayPixels, {
      raw: { width, height, channels: 3 },
    })
      .png()
      .toFile(overlayPath);
    const overlayMeta = await sharp(overlayPath).metadata();
    console.log("overlay written ->", path.relative(ROOT, overlayPath));
    console.log("overlay size", {
      width: overlayMeta.width,
      height: overlayMeta.height,
    });
    expect(overlayMeta.width).toBe(width);
    expect(overlayMeta.height).toBe(height);

    const rawMasks = segmentationToMasks(
      primary.data,
      channels,
      width,
      height,
      0,
    );
    for (const { channel, name } of [
      { channel: 1, name: "wall" },
      { channel: 2, name: "door" },
      { channel: 3, name: "window" },
    ]) {
      const classPath = path.resolve(ROOT, "debug", `v_${base}_${name}.png`);
      await sharp(buildClassPixels(rgb, rawMasks[channel], OVERLAY_PALETTE[channel]), {
        raw: { width, height, channels: 3 },
      })
        .png()
        .toFile(classPath);
      console.log(`${name} class image ->`, path.relative(ROOT, classPath));
    }
    console.groupEnd();

    // ---------------------------------------------------------------- STEP 6
    console.group("STEP 6 - segmentationPlan: masks -> image-space vectors");
    const vectorized = segmentationPlan(
      masks,
      segmentation.channels,
      segmentation.width,
      segmentation.height,
      transform,
    );
    console.log(
      "segments by orientation",
      vectorized.segments.reduce<Record<string, number>>((acc, segment) => {
        acc[segment.orientation] = (acc[segment.orientation] ?? 0) + 1;
        return acc;
      }, {}),
    );
    console.log(
      "openings by type",
      vectorized.openings.reduce<Record<string, number>>((acc, opening) => {
        acc[opening.type] = (acc[opening.type] ?? 0) + 1;
        return acc;
      }, {}),
    );
    console.log("first segments (image pixels)");
    console.table(vectorized.segments.slice(0, 10));
    console.log("first openings (image pixels)");
    console.table(vectorized.openings.slice(0, 10));
    console.groupEnd();

    // ---------------------------------------------------------------- STEP 7
    console.group("STEP 7 - processVisionOutputs: production path");
    const result = processVisionOutputs(outputMap, transform, 0.1);
    if (sampleName === "plan01") {
      const furniturePlan = suggestFurnitureLayout(
        result.plan.walls,
        result.plan.openings,
      );
      console.log("AI room guesses");
      console.table(
        furniturePlan.rooms.map(({ label, kind, area, confidence, doorCount }) => ({
          label,
          kind,
          area: Number(area.toFixed(1)),
          confidence,
          doorCount,
        })),
      );
      console.log("AI room bounds");
      console.table(
        furniturePlan.rooms.map(({ label, minX, minY, maxX, maxY }) => ({
          label,
          minX: Number(minX.toFixed(1)),
          minY: Number(minY.toFixed(1)),
          maxX: Number(maxX.toFixed(1)),
          maxY: Number(maxY.toFixed(1)),
        })),
      );
      console.log("AI furniture placements");
      console.table(furniturePlan.furniture);
      expect(
        new Set(furniturePlan.rooms.map((room) => room.label)).size,
      ).toBe(furniturePlan.rooms.length);
      expect(furniturePlan.rooms.filter((room) => room.kind === "bedroom").length)
        .toBeGreaterThanOrEqual(2);
      expect(furniturePlan.rooms.some((room) => room.kind === "living")).toBe(true);
      const furniturePath = path.resolve(
        ROOT,
        "debug",
        `v_${base}_furniture-layout.png`,
      );
      await sharp(Buffer.from(buildFurnitureLayoutSvg(result.plan.walls, furniturePlan.furniture)))
        .png()
        .toFile(furniturePath);
      console.log("furniture layout image ->", path.relative(ROOT, furniturePath));
      expect(furniturePlan.furniture.length).toBeGreaterThan(0);
      expect(furniturePlan.furniture.some((item) => item.kind === "bed")).toBe(true);
      expect(furniturePlan.furniture.some((item) => item.kind === "sofa")).toBe(true);
      expect(furniturePlan.furniture.some((item) => item.kind === "nightstand")).toBe(true);

      if (process.env.RUN_LOCAL_AI_FURNITURE_TEST === "1") {
        const status = await checkOllamaStatus();
        if (!status.online || status.models.length === 0) {
          throw new Error("RUN_LOCAL_AI_FURNITURE_TEST requires a running Ollama model.");
        }
        const model =
          DEFAULT_AI_MODELS.map((preferred) =>
            status.models.find(
              (candidate) =>
                candidate === preferred || candidate.startsWith(`${preferred}:`),
            ),
          ).find((candidate) => Boolean(candidate)) ?? status.models[0];
        const aiFurniture = await suggestFurnitureWithLocalAI(
          result.plan.walls,
          result.plan.openings,
          { model },
        );
        console.log(`[local AI furniture] model=${aiFurniture.model}`);
        console.table(aiFurniture.furniture);
        expect(aiFurniture.furniture.length).toBeGreaterThan(0);
        expect(aiFurniture.furniture.some((item) => item.source === "local-llm")).toBe(true);

        const aiFurniturePath = path.resolve(
          ROOT,
          "debug",
          `v_${base}_ai-furniture-layout.png`,
        );
        await sharp(
          Buffer.from(
            buildFurnitureLayoutSvg(result.plan.walls, aiFurniture.furniture),
          ),
        )
          .png()
          .toFile(aiFurniturePath);
        console.log("local AI furniture layout ->", path.relative(ROOT, aiFurniturePath));
      }
    }
    console.log("usedSegmentation", result.usedSegmentation);
    console.log("walls (feet)");
    console.table(result.plan.walls.slice(0, 10));
    console.log("openings assigned to walls");
    console.table(result.plan.openings);
    const attachmentView = buildOpeningAttachmentSvg(result.plan, transform);
    console.log("opening attachment positions (source-image pixels)");
    console.table(attachmentView.summaries);
    console.log("wall centerlines (source-image pixels)");
    console.table(attachmentView.wallSummaries);
    const attachmentPath = path.resolve(
      ROOT,
      "debug",
      `v_${base}_attachments.png`,
    );
    await sharp(overlayPath)
      .composite([{ input: Buffer.from(attachmentView.svg) }])
      .png()
      .toFile(attachmentPath);
    console.log("opening attachment image ->", path.relative(ROOT, attachmentPath));
    console.log("world", {
      width: Number(result.plan.worldWidth.toFixed(2)),
      height: Number(result.plan.worldHeight.toFixed(2)),
    });
    console.log("final counts", {
      walls: result.plan.walls.length,
      openings: result.plan.openings.length,
      duplicateWallPairs: countDuplicateWalls(result.plan.walls),
    });
    const wallsPath = path.resolve(ROOT, "debug", `v_${base}_walls.png`);
    await sharp(Buffer.from(buildWallsSvg(result.plan)))
      .png()
      .toFile(wallsPath);
    console.log("walls image ->", path.relative(ROOT, wallsPath));
    console.groupEnd();

    // ---------------------------------------------------------- STEP 8
    console.group("STEP 8 - validate plan against the colored overlay");
    const overlayRaw = await sharp(overlayPath)
      .raw()
      .toBuffer({ resolveWithObject: true });
    const validation = validatePlanOverlay(
      overlayRaw.data,
      overlayRaw.info.width,
      overlayRaw.info.height,
      result.plan,
      transform,
      result.plan.meta,
    );
    const validationPath = path.resolve(
      ROOT,
      "debug",
      `v_${base}_validation.png`,
    );
    await sharp(Buffer.from(validation.validationImage), {
      raw: {
        width: validation.width,
        height: validation.height,
        channels: 3,
      },
    })
      .png()
      .toFile(validationPath);

    console.log("wall coverage", {
      percent: Number((validation.wallCoverage * 100).toFixed(1)),
      reference: validation.referenceWallPixels,
      covered: validation.coveredWallPixels,
      missing: validation.missingWallPixels,
    });
    console.log("wall precision", {
      percent: Number((validation.wallPrecision * 100).toFixed(1)),
      raster: validation.rasterWallPixels,
      phantom: validation.phantomWallPixels,
    });
    console.log("missing wall regions");
    console.table(validation.missingWallRegions);
    console.log("openings", {
      doors: {
        reference: validation.referenceDoorPixels,
        matched: validation.matchedDoorPixels,
      },
      windows: {
        reference: validation.referenceWindowPixels,
        matched: validation.matchedWindowPixels,
      },
      missing: validation.missingOpenings.length,
    });
    console.log("missing openings");
    console.table(validation.missingOpenings);
    console.log("validation image ->", path.relative(ROOT, validationPath));
    console.groupEnd();

    expect(validation.referenceWallPixels).toBeGreaterThan(0);
    expect(validation.wallCoverage).toBeGreaterThan(0.98);
    expect(validation.wallPrecision).toBeGreaterThan(0.98);
    expect(validation.missingOpenings).toHaveLength(0);

    console.groupEnd();

    expect(result.usedSegmentation).toBe(true);
    expect(result.plan.walls.length).toBeGreaterThan(0);

    for (const wall of result.plan.walls) {
      expect(Number.isFinite(wall.x1)).toBe(true);
      expect(Number.isFinite(wall.y1)).toBe(true);
      expect(Number.isFinite(wall.x2)).toBe(true);
      expect(Number.isFinite(wall.y2)).toBe(true);
      expect(wall.thickness).toBeGreaterThan(0);
    }
  });
});
