export type Vec2 = {
  x: number;
  y: number;
};

export type Wall = {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  thickness: number;
  height: number;
};

export type OpeningType = "door" | "window";

export type Opening = {
  id: string;
  wallId: string;
  type: OpeningType;
  positionOnWall: number;
  width: number;
};

export type FurnitureKind =
  | "bed"
  | "nightstand"
  | "wardrobe"
  | "sofa"
  | "coffee-table"
  | "media-console"
  | "desk"
  | "desk-chair"
  | "dining-table"
  | "chair";

export type FurnitureSource = "local-llm" | "geometry";

export type Furniture = {
  id: string;
  roomId: number;
  kind: FurnitureKind;
  source: FurnitureSource;
  roomLabel: string;
  x: number;
  y: number;
  width: number;
  depth: number;
  height: number;
  rotation: number;
  confidence: number;
};

export type ActiveView = "2d" | "3d";

export type ActiveTool = "select" | "wall" | "door" | "window";

export type SceneFile = {
  version: 1;
  name?: string;
  walls: Wall[];
  openings: Opening[];
  furniture?: Furniture[];
};

export const DEFAULTS = {
  wallThickness: 0.5,
  wallHeight: 8,
  doorWidth: 3,
  windowWidth: 4,
  doorHeight: 6.8,
  windowSill: 3,
  windowHeight: 3.8,
  minDoorWidthInches: 32,
} as const;

export const FEET_PER_INCH = 1 / 12;
