import type { FurnitureKind } from "../types/floorplan";

export type FurnitureCatalogItem = {
  kind: FurnitureKind;
  label: string;
  category: "Bedroom" | "Living" | "Dining" | "Office";
  description: string;
  width: number;
  depth: number;
  height: number;
  color: string;
  modelUrl?: string;
};

export const FURNITURE_CATALOG: FurnitureCatalogItem[] = [
  {
    kind: "bed",
    label: "Bed",
    category: "Bedroom",
    description: "Low-profile bed with frame, duvet, headboard and pillows",
    width: 5.2,
    depth: 6.8,
    height: 2.4,
    color: "#c8b59c",
    modelUrl: "/models/furniture/kaykit/bed_double_A.gltf",
  },
  {
    kind: "nightstand",
    label: "Nightstand",
    category: "Bedroom",
    description: "Compact bedside table",
    width: 1.8,
    depth: 1.7,
    height: 2.1,
    color: "#c89a6b",
    modelUrl: "/models/furniture/kaykit/cabinet_small_decorated.gltf",
  },
  {
    kind: "wardrobe",
    label: "Wardrobe",
    category: "Bedroom",
    description: "Double-door wardrobe with handles",
    width: 4.2,
    depth: 2,
    height: 6.7,
    color: "#d1c2aa",
  },
  {
    kind: "sofa",
    label: "Sofa",
    category: "Living",
    description: "Three-seat sofa with cushions and wood feet",
    width: 7.2,
    depth: 3.2,
    height: 2.8,
    color: "#829b91",
    modelUrl: "/models/furniture/kaykit/couch_pillows.gltf",
  },
  {
    kind: "coffee-table",
    label: "Coffee table",
    category: "Living",
    description: "Low timber coffee table",
    width: 4.2,
    depth: 2.3,
    height: 1.4,
    color: "#bd9267",
    modelUrl: "/models/furniture/kaykit/table_low.gltf",
  },
  {
    kind: "media-console",
    label: "Media console",
    category: "Living",
    description: "TV console with raised screen",
    width: 5.4,
    depth: 1.6,
    height: 2.3,
    color: "#a47d56",
  },
  {
    kind: "dining-table",
    label: "Dining table",
    category: "Dining",
    description: "Four-leg dining table",
    width: 6.2,
    depth: 3.6,
    height: 2.6,
    color: "#aa8055",
    modelUrl: "/models/furniture/kaykit/table_medium_long.gltf",
  },
  {
    kind: "chair",
    label: "Dining chair",
    category: "Dining",
    description: "Timber chair with a cushioned seat",
    width: 1.8,
    depth: 1.8,
    height: 3.1,
    color: "#b7a58d",
    modelUrl: "/models/furniture/kaykit/chair_A_wood.gltf",
  },
  {
    kind: "desk",
    label: "Desk",
    category: "Office",
    description: "Work desk with tabletop and monitor",
    width: 5.2,
    depth: 2.6,
    height: 2.5,
    color: "#c2a078",
    modelUrl: "/models/furniture/kaykit/table_medium.gltf",
  },
  {
    kind: "desk-chair",
    label: "Desk chair",
    category: "Office",
    description: "Compact upholstered desk chair",
    width: 1.9,
    depth: 1.9,
    height: 2.9,
    color: "#9a8670",
    modelUrl: "/models/furniture/kaykit/chair_B_wood.gltf",
  },
];

export function furnitureCatalogItem(kind: FurnitureKind) {
  return FURNITURE_CATALOG.find((item) => item.kind === kind)!;
}
