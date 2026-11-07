import type {
  Furniture,
  FurnitureKind,
  FurnitureSource,
  Opening,
  SceneFile,
  Wall,
} from "../types/floorplan";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const finiteNumber = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

export function isTauriRuntime() {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>)
  );
}

export function buildSceneFile(
  walls: Wall[],
  openings: Opening[],
  name: string,
  furniture: Furniture[] = [],
): SceneFile {
  return {
    version: 1,
    name,
    walls: walls.map((wall) => ({ ...wall })),
    openings: openings.map((opening) => ({ ...opening })),
    furniture: furniture.map((item) => ({ ...item })),
  };
}

export function parseSceneFile(raw: string): SceneFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("The selected file is not valid JSON.");
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.walls)) {
    throw new Error("This file does not look like a FloorPlan Studio scene.");
  }

  const walls: Wall[] = [];
  const wallIds = new Set<string>();

  for (const [index, item] of parsed.walls.entries()) {
    if (!isRecord(item)) continue;
    const x1 = finiteNumber(item.x1, Number.NaN);
    const y1 = finiteNumber(item.y1, Number.NaN);
    const x2 = finiteNumber(item.x2, Number.NaN);
    const y2 = finiteNumber(item.y2, Number.NaN);
    if (![x1, y1, x2, y2].every(Number.isFinite)) continue;
    if (Math.hypot(x2 - x1, y2 - y1) < 0.05) continue;

    const id =
      typeof item.id === "string" && item.id.length > 0
        ? item.id
        : `wall-${index}-${Math.random().toString(36).slice(2)}`;
    if (wallIds.has(id)) continue;
    wallIds.add(id);

    walls.push({
      id,
      x1,
      y1,
      x2,
      y2,
      thickness: Math.max(0.05, finiteNumber(item.thickness, 0.5)),
      height: Math.max(1, finiteNumber(item.height, 8)),
    });
  }

  const openings: Opening[] = [];
  const openingIds = new Set<string>();

  if (Array.isArray(parsed.openings)) {
    for (const [index, item] of parsed.openings.entries()) {
      if (!isRecord(item)) continue;
      if (typeof item.wallId !== "string" || !wallIds.has(item.wallId)) continue;
      if (item.type !== "door" && item.type !== "window") continue;

      const id =
        typeof item.id === "string" && item.id.length > 0
          ? item.id
          : `opening-${index}-${Math.random().toString(36).slice(2)}`;
      if (openingIds.has(id)) continue;
      openingIds.add(id);

      openings.push({
        id,
        wallId: item.wallId,
        type: item.type,
        positionOnWall: Math.max(
          0.02,
          Math.min(0.98, finiteNumber(item.positionOnWall, 0.5)),
        ),
        width: Math.max(0.5, finiteNumber(item.width, 3)),
      });
    }
  }

  if (walls.length === 0) {
    throw new Error("The scene does not contain any valid walls.");
  }

      const furnitureKinds: FurnitureKind[] = [
    "bed",
    "nightstand",
    "wardrobe",
    "sofa",
    "coffee-table",
    "media-console",
    "desk",
    "desk-chair",
    "dining-table",
    "chair",
  ];
  const furniture: Furniture[] = [];
  const furnitureIds = new Set<string>();
  if (Array.isArray(parsed.furniture)) {
    for (const [index, item] of parsed.furniture.entries()) {
      if (!isRecord(item) || !furnitureKinds.includes(item.kind as FurnitureKind)) {
        continue;
      }
      const x = finiteNumber(item.x, Number.NaN);
      const y = finiteNumber(item.y, Number.NaN);
      const width = finiteNumber(item.width, Number.NaN);
      const depth = finiteNumber(item.depth, Number.NaN);
      const height = finiteNumber(item.height, Number.NaN);
      const rotation = finiteNumber(item.rotation, 0);
      const roomId = finiteNumber(item.roomId, Number.NaN);
      if (![x, y, width, depth, height, roomId].every(Number.isFinite)) continue;
      if (width <= 0 || depth <= 0 || height <= 0) continue;

      const id =
        typeof item.id === "string" && item.id.length > 0
          ? item.id
          : `furniture-${index}-${Math.random().toString(36).slice(2)}`;
      if (furnitureIds.has(id)) continue;
      furnitureIds.add(id);
      furniture.push({
        id,
        roomId: Math.max(0, Math.floor(roomId)),
        kind: item.kind as FurnitureKind,
        source:
          item.source === "local-llm"
            ? ("local-llm" as FurnitureSource)
            : ("geometry" as FurnitureSource),
        roomLabel:
          typeof item.roomLabel === "string" ? item.roomLabel : "Room",
        x,
        y,
        width,
        depth,
        height,
        rotation,
        confidence: Math.max(0, Math.min(1, finiteNumber(item.confidence, 0.5))),
      });
    }
  }

  return {
    version: 1,
    name: typeof parsed.name === "string" ? parsed.name : "Imported Floor Plan",
    walls,
    openings,
    furniture,
  };
}

function triggerBrowserDownload(filename: string, contents: string) {
  const blob = new Blob([contents], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function saveSceneFile(
  scene: SceneFile,
  suggestedName = "floorplan.json",
): Promise<string | null> {
  const contents = JSON.stringify(scene, null, 2);

  if (isTauriRuntime()) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({
      defaultPath: suggestedName,
      filters: [{ name: "FloorPlan Studio Scene", extensions: ["json"] }],
    });
    if (!path) return null;

    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    await writeTextFile(path, contents);
    return path;
  }

  triggerBrowserDownload(suggestedName, contents);
  return suggestedName;
}

export async function openSceneFile(): Promise<SceneFile | null> {
  if (isTauriRuntime()) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const path = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "FloorPlan Studio Scene", extensions: ["json"] }],
    });
    if (!path || Array.isArray(path)) return null;

    const { readTextFile } = await import("@tauri-apps/plugin-fs");
    const raw = await readTextFile(path);
    return parseSceneFile(raw);
  }

  return new Promise<SceneFile | null>((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      try {
        resolve(parseSceneFile(await file.text()));
      } catch (error) {
        reject(error);
      }
    };
    input.click();
  });
}
