import { create } from "zustand";
import {
  DEFAULTS,
  type ActiveTool,
  type ActiveView,
  type Furniture,
  type Opening,
  type OpeningType,
  type SceneFile,
  type Wall,
} from "../types/floorplan";

const createId = () => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `id-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
};

export function createDefaultScene(): SceneFile {
  const walls: Wall[] = [
    {
      id: "wall-north",
      x1: 0,
      y1: 0,
      x2: 20,
      y2: 0,
      thickness: DEFAULTS.wallThickness,
      height: DEFAULTS.wallHeight,
    },
    {
      id: "wall-east",
      x1: 20,
      y1: 0,
      x2: 20,
      y2: 15,
      thickness: DEFAULTS.wallThickness,
      height: DEFAULTS.wallHeight,
    },
    {
      id: "wall-south",
      x1: 20,
      y1: 15,
      x2: 0,
      y2: 15,
      thickness: DEFAULTS.wallThickness,
      height: DEFAULTS.wallHeight,
    },
    {
      id: "wall-west",
      x1: 0,
      y1: 15,
      x2: 0,
      y2: 0,
      thickness: DEFAULTS.wallThickness,
      height: DEFAULTS.wallHeight,
    },
  ];

  const openings: Opening[] = [
    {
      id: "opening-front-door",
      wallId: "wall-south",
      type: "door",
      positionOnWall: 0.32,
      width: DEFAULTS.doorWidth,
    },
  ];

  return {
    version: 1,
    name: "Untitled Floor Plan",
    walls,
    openings,
  };
}

type FloorPlanState = {
  walls: Wall[];
  openings: Opening[];
  furniture: Furniture[];
  activeView: ActiveView;
  activeTool: ActiveTool;
  selectedWallId: string | null;
  selectedOpeningId: string | null;
  complianceOpen: boolean;
  aiOpen: boolean;
  sceneName: string;
  revision: number;
  setActiveView: (view: ActiveView) => void;
  setActiveTool: (tool: ActiveTool) => void;
  toggleCompliance: () => void;
  setComplianceOpen: (open: boolean) => void;
  toggleAi: () => void;
  setAiOpen: (open: boolean) => void;
  selectWall: (id: string | null) => void;
  selectOpening: (id: string | null) => void;
  clearSelection: () => void;
  addWall: (
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    overrides?: Partial<Pick<Wall, "thickness" | "height">>,
  ) => string;
  updateWall: (id: string, patch: Partial<Omit<Wall, "id">>) => void;
  deleteWall: (id: string) => void;
  addOpening: (
    wallId: string,
    type: OpeningType,
    positionOnWall: number,
    width?: number,
  ) => string | null;
  updateOpening: (id: string, patch: Partial<Omit<Opening, "id">>) => void;
  deleteOpening: (id: string) => void;
  setFurniture: (furniture: Furniture[]) => void;
  importPlan: (
    walls: Wall[],
    openings: Opening[],
    options?: { replace?: boolean; name?: string },
  ) => { wallCount: number; openingCount: number };
  loadScene: (scene: SceneFile) => void;
  resetScene: () => void;
};

const initialScene = createDefaultScene();

export const useFloorPlanStore = create<FloorPlanState>((set, get) => ({
  walls: initialScene.walls,
  openings: initialScene.openings,
  furniture: [],
  activeView: "2d",
  activeTool: "select",
  selectedWallId: null,
  selectedOpeningId: null,
  complianceOpen: true,
  aiOpen: false,
  sceneName: initialScene.name ?? "Untitled Floor Plan",
  revision: 0,

  setActiveView: (activeView) => set({ activeView }),
  setActiveTool: (activeTool) => set({ activeTool }),
  toggleCompliance: () =>
    set((state) => {
      const complianceOpen = !state.complianceOpen;
      return {
        complianceOpen,
        aiOpen: complianceOpen ? false : state.aiOpen,
      };
    }),
  setComplianceOpen: (complianceOpen) =>
    set((state) => ({
      complianceOpen,
      aiOpen: complianceOpen ? false : state.aiOpen,
    })),
  toggleAi: () =>
    set((state) => {
      const aiOpen = !state.aiOpen;
      return {
        aiOpen,
        complianceOpen: aiOpen ? false : state.complianceOpen,
      };
    }),
  setAiOpen: (aiOpen) =>
    set((state) => ({
      aiOpen,
      complianceOpen: aiOpen ? false : state.complianceOpen,
    })),

  selectWall: (id) =>
    set({ selectedWallId: id, selectedOpeningId: null }),
  selectOpening: (id) =>
    set({ selectedOpeningId: id, selectedWallId: null }),
  clearSelection: () =>
    set({ selectedWallId: null, selectedOpeningId: null }),

  addWall: (x1, y1, x2, y2, overrides) => {
    const id = createId();
    const wall: Wall = {
      id,
      x1,
      y1,
      x2,
      y2,
      thickness: overrides?.thickness ?? DEFAULTS.wallThickness,
      height: overrides?.height ?? DEFAULTS.wallHeight,
    };
    set((state) => ({
      walls: [...state.walls, wall],
      selectedWallId: id,
      selectedOpeningId: null,
    }));
    return id;
  },

  updateWall: (id, patch) =>
    set((state) => ({
      walls: state.walls.map((wall) =>
        wall.id === id ? { ...wall, ...patch } : wall,
      ),
    })),

  deleteWall: (id) =>
    set((state) => ({
      walls: state.walls.filter((wall) => wall.id !== id),
      openings: state.openings.filter((opening) => opening.wallId !== id),
      selectedWallId: state.selectedWallId === id ? null : state.selectedWallId,
      selectedOpeningId:
        state.selectedOpeningId &&
        state.openings.some(
          (opening) =>
            opening.id === state.selectedOpeningId && opening.wallId !== id,
        )
          ? state.selectedOpeningId
          : null,
    })),

  addOpening: (wallId, type, positionOnWall, width) => {
    const wall = get().walls.find((item) => item.id === wallId);
    if (!wall) return null;

    const length = Math.hypot(wall.x2 - wall.x1, wall.y2 - wall.y1);
    if (length <= 0) return null;

    const openingWidth =
      width ?? (type === "door" ? DEFAULTS.doorWidth : DEFAULTS.windowWidth);
    const halfNormalized = Math.min(0.45, openingWidth / length / 2);
    const clampedPosition = Math.max(
      halfNormalized,
      Math.min(1 - halfNormalized, positionOnWall),
    );

    const overlapping = get()
      .openings.filter((opening) => opening.wallId === wallId)
      .some((opening) => {
        const distanceInFeet =
          Math.abs(opening.positionOnWall - clampedPosition) * length;
        return distanceInFeet < (opening.width + openingWidth) / 2 + 0.25;
      });

    if (overlapping) return null;

    const id = createId();
    const opening: Opening = {
      id,
      wallId,
      type,
      positionOnWall: clampedPosition,
      width: openingWidth,
    };

    set((state) => ({
      openings: [...state.openings, opening],
      selectedOpeningId: id,
      selectedWallId: null,
    }));
    return id;
  },

  updateOpening: (id, patch) =>
    set((state) => ({
      openings: state.openings.map((opening) =>
        opening.id === id ? { ...opening, ...patch } : opening,
      ),
    })),

  deleteOpening: (id) =>
    set((state) => ({
      openings: state.openings.filter((opening) => opening.id !== id),
      selectedOpeningId:
        state.selectedOpeningId === id ? null : state.selectedOpeningId,
    })),

  setFurniture: (furniture) => set({ furniture }),

  importPlan: (walls, openings, options) => {
    const replace = options?.replace ?? true;
    const wallIds = new Map<string, string>();
    const remappedWalls = walls.map((wall) => {
      const id = createId();
      wallIds.set(wall.id, id);
      return { ...wall, id };
    });
    const remappedOpenings: Opening[] = [];

    for (const opening of openings) {
      const wallId = wallIds.get(opening.wallId);
      if (!wallId) continue;
      remappedOpenings.push({ ...opening, id: createId(), wallId });
    }

    set((state) => ({
      walls: replace ? remappedWalls : [...state.walls, ...remappedWalls],
      openings: replace
        ? remappedOpenings
        : [...state.openings, ...remappedOpenings],
      furniture: replace ? [] : state.furniture,
      sceneName: options?.name ?? state.sceneName,
      activeView: "3d",
      activeTool: "select",
      selectedWallId: null,
      selectedOpeningId: null,
      revision: state.revision + 1,
    }));

    return {
      wallCount: remappedWalls.length,
      openingCount: remappedOpenings.length,
    };
  },

  loadScene: (scene) =>
    set((state) => ({
      walls: scene.walls,
      openings: scene.openings,
      furniture: scene.furniture ?? [],
      sceneName: scene.name ?? "Imported Floor Plan",
      selectedWallId: null,
      selectedOpeningId: null,
      revision: state.revision + 1,
    })),

  resetScene: () => {
    const scene = createDefaultScene();
    set((state) => ({
      walls: scene.walls,
      openings: scene.openings,
      furniture: [],
      sceneName: scene.name ?? "Untitled Floor Plan",
      selectedWallId: null,
      selectedOpeningId: null,
      activeTool: "select",
      revision: state.revision + 1,
    }));
  },
}));
