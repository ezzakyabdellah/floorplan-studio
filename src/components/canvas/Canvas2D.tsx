import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Maximize, ZoomIn, ZoomOut } from "lucide-react";
import { useFloorPlanStore } from "../../store/floorPlanStore";
import {
  DEFAULTS,
  type Furniture,
  type FurnitureKind,
  type Opening,
  type Vec2,
  type Wall,
} from "../../types/floorplan";
import {
  distance,
  distanceToSegment,
  getSceneBounds,
  getSolidIntervals,
  getWallIntervals,
  pointAlongWall,
  pointAtDistance,
  projectPointOnWall,
  snapPoint,
  wallLength,
} from "../../utils/geometry";
import { cn } from "../../utils/cn";
import {
  formatFeetLength,
  formatFeetNumber,
  gridStepFor,
  unitsPerFoot,
} from "../../utils/floorPlanUnits";
import { FURNITURE_CATALOG, furnitureCatalogItem } from "../../data/furnitureCatalog";

type View = {
  scale: number;
  tx: number;
  ty: number;
};

type PanState = {
  pointerId: number;
  startX: number;
  startY: number;
  startView: View;
};

type FurnitureDragState = {
  id: string;
  pointerId: number;
  offsetX: number;
  offsetY: number;
};

const MIN_SCALE = 2;
const MAX_SCALE = 240;

const clampScale = (scale: number) =>
  Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale));

function isFurnitureKind(value: string): value is FurnitureKind {
  return FURNITURE_CATALOG.some((item) => item.kind === value);
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

export function Canvas2D() {
  const walls = useFloorPlanStore((state) => state.walls);
  const openings = useFloorPlanStore((state) => state.openings);
  const furniture = useFloorPlanStore((state) => state.furniture);
  const activeTool = useFloorPlanStore((state) => state.activeTool);
  const unit = useFloorPlanStore((state) => state.unit);
  const selectedWallId = useFloorPlanStore((state) => state.selectedWallId);
  const selectedOpeningId = useFloorPlanStore(
    (state) => state.selectedOpeningId,
  );
  const selectedFurnitureId = useFloorPlanStore((state) => state.selectedFurnitureId);
  const selectWall = useFloorPlanStore((state) => state.selectWall);
  const selectOpening = useFloorPlanStore((state) => state.selectOpening);
  const selectFurniture = useFloorPlanStore((state) => state.selectFurniture);
  const setActiveTool = useFloorPlanStore((state) => state.setActiveTool);
  const clearSelection = useFloorPlanStore((state) => state.clearSelection);
  const addWall = useFloorPlanStore((state) => state.addWall);
  const addOpening = useFloorPlanStore((state) => state.addOpening);
  const addFurniture = useFloorPlanStore((state) => state.addFurniture);
  const updateFurniture = useFloorPlanStore((state) => state.updateFurniture);
  const deleteWall = useFloorPlanStore((state) => state.deleteWall);
  const deleteOpening = useFloorPlanStore((state) => state.deleteOpening);
  const deleteFurniture = useFloorPlanStore((state) => state.deleteFurniture);
  const revision = useFloorPlanStore((state) => state.revision);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewRef = useRef<View | null>(null);
  const panRef = useRef<PanState | null>(null);
  const furnitureDragRef = useRef<FurnitureDragState | null>(null);
  const spaceRef = useRef(false);
  const fittedRef = useRef(false);
  const lastRevisionRef = useRef(revision);

  const [size, setSize] = useState({ width: 0, height: 0 });
  const [view, setView] = useState<View | null>(null);
  const [drawStart, setDrawStart] = useState<Vec2 | null>(null);
  const [cursor, setCursor] = useState<Vec2 | null>(null);
  const [spaceDown, setSpaceDown] = useState(false);
  const [hoveredWallId, setHoveredWallId] = useState<string | null>(null);
  const [hoveredOpeningId, setHoveredOpeningId] = useState<string | null>(null);
  const [hoveredFurnitureId, setHoveredFurnitureId] = useState<string | null>(null);

  const applyView = useCallback((next: View) => {
    viewRef.current = next;
    setView(next);
  }, []);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    });

    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const fitView = useCallback(() => {
    if (size.width <= 0 || size.height <= 0) return;
    const bounds = getSceneBounds(walls);
    const padding = 84;
    const rawScale = Math.min(
      (size.width - padding * 2) / bounds.width,
      (size.height - padding * 2) / bounds.height,
    );
    const scale = clampScale(rawScale);
    applyView({
      scale,
      tx: size.width / 2 - bounds.centerX * scale,
      ty: size.height / 2 - bounds.centerY * scale,
    });
  }, [walls, size.width, size.height, applyView]);

  useEffect(() => {
    if (fittedRef.current) return;
    if (size.width <= 0 || size.height <= 0) return;
    fittedRef.current = true;
    fitView();
  }, [size.width, size.height, fitView]);

  useEffect(() => {
    if (lastRevisionRef.current === revision) return;
    lastRevisionRef.current = revision;
    fitView();
  }, [revision, fitView]);

  const screenToWorld = useCallback(
    (clientX: number, clientY: number): Vec2 | null => {
      const canvas = canvasRef.current;
      const currentView = viewRef.current;
      if (!canvas || !currentView) return null;
      const rect = canvas.getBoundingClientRect();
      return {
        x: (clientX - rect.left - currentView.tx) / currentView.scale,
        y: (clientY - rect.top - currentView.ty) / currentView.scale,
      };
    },
    [],
  );

  const hitTestOpening = useCallback(
    (point: Vec2): Opening | null => {
      for (const opening of openings) {
        const wall = walls.find((item) => item.id === opening.wallId);
        if (!wall) continue;
        const length = wallLength(wall);
        if (length <= 0) continue;
        const projection = projectPointOnWall(point, wall);
        const alongDistance =
          Math.abs(projection.t - opening.positionOnWall) * length;
        if (
          alongDistance <= opening.width / 2 + 0.35 &&
          projection.distance <= wall.thickness / 2 + 0.35
        ) {
          return opening;
        }
      }
      return null;
    },
    [openings, walls],
  );

  const hitTestWall = useCallback(
    (point: Vec2): Wall | null => {
      const currentView = viewRef.current;
      if (!currentView) return null;
      let best: Wall | null = null;
      let bestDistance = Number.POSITIVE_INFINITY;

      for (const wall of walls) {
        const d = distanceToSegment(point, wall);
        const threshold = Math.max(
          wall.thickness / 2 + 0.35,
          7 / currentView.scale,
        );
        if (d <= threshold && d < bestDistance) {
          best = wall;
          bestDistance = d;
        }
      }

      return best;
    },
    [walls],
  );

  const hitTestFurniture = useCallback(
    (point: Vec2): Furniture | null => {
      for (let index = furniture.length - 1; index >= 0; index -= 1) {
        const item = furniture[index];
        const dx = point.x - item.x;
        const dy = point.y - item.y;
        const cos = Math.cos(item.rotation);
        const sin = Math.sin(item.rotation);
        const localX = dx * cos + dy * sin;
        const localY = -dx * sin + dy * cos;
        if (
          Math.abs(localX) <= item.width / 2 + 0.1 &&
          Math.abs(localY) <= item.depth / 2 + 0.1
        ) {
          return item;
        }
      }
      return null;
    },
    [furniture],
  );

  const nearestWall = useCallback(
    (point: Vec2): Wall | null => {
      let best: Wall | null = null;
      let bestDistance = Number.POSITIVE_INFINITY;

      for (const wall of walls) {
        const d = distanceToSegment(point, wall);
        const threshold = wall.thickness / 2 + 0.9;
        if (d <= threshold && d < bestDistance) {
          best = wall;
          bestDistance = d;
        }
      }

      return best;
    },
    [walls],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const currentView = viewRef.current;
      if (!currentView) return;

      const rect = canvas.getBoundingClientRect();
      const mouseX = event.clientX - rect.left;
      const mouseY = event.clientY - rect.top;
      const worldX = (mouseX - currentView.tx) / currentView.scale;
      const worldY = (mouseY - currentView.ty) / currentView.scale;
      const nextScale = clampScale(
        currentView.scale * Math.exp(-event.deltaY * 0.0015),
      );

      applyView({
        scale: nextScale,
        tx: mouseX - worldX * nextScale,
        ty: mouseY - worldY * nextScale,
      });
    };

    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [applyView]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);

      if (event.code === "Space" && !typing) {
        event.preventDefault();
        spaceRef.current = true;
        setSpaceDown(true);
      }

      if (typing) return;

      if (event.key === "Escape") {
        setDrawStart(null);
        setCursor(null);
      }

      if (event.key === "Delete" || event.key === "Backspace") {
        if (selectedOpeningId) {
          event.preventDefault();
          deleteOpening(selectedOpeningId);
        } else if (selectedWallId) {
          event.preventDefault();
          deleteWall(selectedWallId);
        } else if (selectedFurnitureId) {
          event.preventDefault();
          deleteFurniture(selectedFurnitureId);
        }
      }
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === "Space") {
        spaceRef.current = false;
        setSpaceDown(false);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [deleteFurniture, deleteOpening, deleteWall, selectedFurnitureId, selectedOpeningId, selectedWallId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !view || size.width <= 0 || size.height <= 0) return;

    const dpr = window.devicePixelRatio || 1;
    const pixelWidth = Math.round(size.width * dpr);
    const pixelHeight = Math.round(size.height * dpr);
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const { scale, tx, ty } = view;
    const sx = (x: number) => x * scale + tx;
    const sy = (y: number) => y * scale + ty;
    const toScreen = (point: Vec2) => ({ x: sx(point.x), y: sy(point.y) });

    const background = ctx.createRadialGradient(
      size.width * 0.45,
      size.height * 0.4,
      0,
      size.width * 0.5,
      size.height * 0.5,
      Math.max(size.width, size.height) * 0.8,
    );
    background.addColorStop(0, "#0d131b");
    background.addColorStop(1, "#070a0e");
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, size.width, size.height);

    const displayUnitsPerFoot = unitsPerFoot(unit);
    const gridStep = gridStepFor(unit, scale / displayUnitsPerFoot);
    const minorStep = gridStep / displayUnitsPerFoot;
    const majorEvery = 5;
    const left = (0 - tx) / scale;
    const right = (size.width - tx) / scale;
    const top = (0 - ty) / scale;
    const bottom = (size.height - ty) / scale;

    const startXIndex = Math.floor(left / minorStep);
    const startYIndex = Math.floor(top / minorStep);

    ctx.lineWidth = 1;
    for (let index = startXIndex; ; index += 1) {
      const x = index * minorStep;
      if (x > right) break;
      const isMajor = index % majorEvery === 0;
      const screenX = Math.round(sx(x)) + 0.5;
      ctx.strokeStyle = isMajor
        ? "rgba(45, 62, 82, 0.55)"
        : "rgba(24, 35, 48, 0.7)";
      ctx.beginPath();
      ctx.moveTo(screenX, 0);
      ctx.lineTo(screenX, size.height);
      ctx.stroke();

      if (isMajor && scale > 4 && screenX > 26 && screenX < size.width - 18) {
        ctx.fillStyle = "rgba(100, 116, 139, 0.55)";
        ctx.font = "9px ui-monospace, SFMono-Regular, monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillText(formatFeetNumber(x, unit), screenX, 6);
      }
    }

    for (let index = startYIndex; ; index += 1) {
      const y = index * minorStep;
      if (y > bottom) break;
      const isMajor = index % majorEvery === 0;
      const screenY = Math.round(sy(y)) + 0.5;
      ctx.strokeStyle = isMajor
        ? "rgba(45, 62, 82, 0.55)"
        : "rgba(24, 35, 48, 0.7)";
      ctx.beginPath();
      ctx.moveTo(0, screenY);
      ctx.lineTo(size.width, screenY);
      ctx.stroke();

      if (isMajor && scale > 4 && screenY > 20 && screenY < size.height - 14) {
        ctx.fillStyle = "rgba(100, 116, 139, 0.55)";
        ctx.font = "9px ui-monospace, SFMono-Regular, monospace";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(formatFeetNumber(y, unit), 6, screenY);
      }
    }

    if (sx(0) > 0 && sx(0) < size.width) {
      ctx.strokeStyle = "rgba(56, 189, 248, 0.14)";
      ctx.beginPath();
      ctx.moveTo(Math.round(sx(0)) + 0.5, 0);
      ctx.lineTo(Math.round(sx(0)) + 0.5, size.height);
      ctx.stroke();
    }
    if (sy(0) > 0 && sy(0) < size.height) {
      ctx.strokeStyle = "rgba(56, 189, 248, 0.14)";
      ctx.beginPath();
      ctx.moveTo(0, Math.round(sy(0)) + 0.5);
      ctx.lineTo(size.width, Math.round(sy(0)) + 0.5);
      ctx.stroke();
    }

    for (const item of furniture) {
      const center = toScreen({ x: item.x, y: item.y });
      const width = Math.max(3, item.width * scale);
      const depth = Math.max(3, item.depth * scale);
      const selected = item.id === selectedFurnitureId;
      const hovered = item.id === hoveredFurnitureId && !selected;
      const catalogItem = furnitureCatalogItem(item.kind);
      ctx.save();
      ctx.translate(center.x, center.y);
      ctx.rotate(item.rotation);
      roundedRect(ctx, -width / 2, -depth / 2, width, depth, Math.min(6, width / 5, depth / 5));
      ctx.fillStyle = selected
        ? "rgba(56, 189, 248, 0.30)"
        : hovered
          ? "rgba(226, 232, 240, 0.28)"
          : `${catalogItem.color}d9`;
      ctx.fill();
      ctx.strokeStyle = selected
        ? "#38bdf8"
        : hovered
          ? "#e2e8f0"
          : "rgba(15, 23, 32, 0.9)";
      ctx.lineWidth = selected ? 2 : 1.25;
      ctx.stroke();
      if (width > 38 && depth > 18) {
        ctx.fillStyle = "#101820";
        ctx.font = `600 ${Math.max(8, Math.min(11, depth * 0.3))}px ui-sans-serif, system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(catalogItem.label, 0, 0, width - 8);
      }
      if (selected) {
        ctx.fillStyle = "#38bdf8";
        for (const x of [-width / 2, width / 2]) {
          for (const y of [-depth / 2, depth / 2]) {
            ctx.beginPath();
            ctx.arc(x, y, 3.5, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
      ctx.restore();
    }

    const drawPill = (
      text: string,
      centerX: number,
      centerY: number,
      accent = false,
    ) => {
      ctx.font = "600 10px ui-monospace, SFMono-Regular, monospace";
      const paddingX = 7;
      const width = ctx.measureText(text).width + paddingX * 2;
      const height = 20;
      const x = centerX - width / 2;
      const y = centerY - height / 2;
      roundedRect(ctx, x, y, width, height, 6);
      ctx.fillStyle = "rgba(7, 11, 16, 0.92)";
      ctx.fill();
      ctx.strokeStyle = accent
        ? "rgba(56, 189, 248, 0.55)"
        : "rgba(51, 65, 85, 0.9)";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = accent ? "#7dd3fc" : "#cbd5e1";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text, centerX, centerY + 0.5);
    };

    const drawWall = (wall: Wall) => {
      const selected = wall.id === selectedWallId;
      const hovered = wall.id === hoveredWallId && !selected;
      const wallWidthPx = Math.max(2, wall.thickness * scale);
      const color = selected ? "#38bdf8" : hovered ? "#e2e8f0" : "#c3ced9";
      const solids = getSolidIntervals(wall, openings);

      for (const segment of solids) {
        const a = toScreen(pointAtDistance(wall, segment.start));
        const b = toScreen(pointAtDistance(wall, segment.end));
        ctx.lineCap = "butt";
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.strokeStyle = "rgba(3, 6, 9, 0.95)";
        ctx.lineWidth = wallWidthPx + 2.5;
        ctx.stroke();
        ctx.strokeStyle = color;
        ctx.lineWidth = wallWidthPx;
        ctx.stroke();
      }

      if (selected) {
        const start = toScreen({ x: wall.x1, y: wall.y1 });
        const end = toScreen({ x: wall.x2, y: wall.y2 });
        for (const point of [start, end]) {
          ctx.beginPath();
          ctx.arc(point.x, point.y, Math.max(3.5, wallWidthPx * 0.42), 0, Math.PI * 2);
          ctx.fillStyle = "#0b1220";
          ctx.fill();
          ctx.strokeStyle = "#38bdf8";
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }

        const midpoint = toScreen(pointAlongWall(wall, 0.5));
        const angle = Math.atan2(wall.y2 - wall.y1, wall.x2 - wall.x1);
        const offsetX = -Math.sin(angle) * 18;
        const offsetY = Math.cos(angle) * 18;
        drawPill(
          formatFeetLength(wallLength(wall), unit),
          midpoint.x + offsetX,
          midpoint.y + offsetY,
          true,
        );
      }
    };

    for (const wall of walls) {
      if (wall.id !== selectedWallId) drawWall(wall);
    }
    const selectedWall = walls.find((wall) => wall.id === selectedWallId);
    if (selectedWall) drawWall(selectedWall);

    for (const wall of walls) {
      const length = wallLength(wall);
      if (length <= 0) continue;
      const angle = Math.atan2(wall.y2 - wall.y1, wall.x2 - wall.x1);
      const normalX = -Math.sin(angle);
      const normalY = Math.cos(angle);
      const wallWidthPx = Math.max(2, wall.thickness * scale);

      for (const interval of getWallIntervals(wall, openings)) {
        const { opening } = interval;
        const selected = opening.id === selectedOpeningId;
        const hovered = opening.id === hoveredOpeningId && !selected;
        const color = selected
          ? "#38bdf8"
          : hovered
            ? "#bae6fd"
            : "rgba(148, 163, 184, 0.95)";
        const start = pointAtDistance(wall, interval.start);
        const end = pointAtDistance(wall, interval.end);
        const startScreen = toScreen(start);
        const endScreen = toScreen(end);
        const nx = normalX * wallWidthPx * 0.62;
        const ny = normalY * wallWidthPx * 0.62;

        ctx.strokeStyle = color;
        ctx.lineWidth = selected ? 2 : 1.5;
        ctx.lineCap = "butt";

        for (const point of [startScreen, endScreen]) {
          ctx.beginPath();
          ctx.moveTo(point.x + nx, point.y + ny);
          ctx.lineTo(point.x - nx, point.y - ny);
          ctx.stroke();
        }

        if (opening.type === "window") {
          const offsetX = normalX * wallWidthPx * 0.2;
          const offsetY = normalY * wallWidthPx * 0.2;
          ctx.strokeStyle = selected
            ? "#38bdf8"
            : "rgba(125, 211, 252, 0.8)";
          ctx.lineWidth = selected ? 2 : 1.25;
          ctx.beginPath();
          ctx.moveTo(startScreen.x + offsetX, startScreen.y + offsetY);
          ctx.lineTo(endScreen.x + offsetX, endScreen.y + offsetY);
          ctx.moveTo(startScreen.x - offsetX, startScreen.y - offsetY);
          ctx.lineTo(endScreen.x - offsetX, endScreen.y - offsetY);
          ctx.stroke();
        } else {
          const radius = opening.width * scale;
          const hinge = startScreen;
          const leafX = hinge.x + normalX * radius;
          const leafY = hinge.y + normalY * radius;
          const wallAngle = Math.atan2(
            endScreen.y - startScreen.y,
            endScreen.x - startScreen.x,
          );
          const normalAngle = Math.atan2(normalY, normalX);
          const delta = Math.atan2(
            Math.sin(normalAngle - wallAngle),
            Math.cos(normalAngle - wallAngle),
          );

          ctx.strokeStyle = selected
            ? "rgba(56, 189, 248, 0.35)"
            : "rgba(125, 211, 252, 0.25)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(
            hinge.x,
            hinge.y,
            radius,
            wallAngle,
            wallAngle + delta,
            delta < 0,
          );
          ctx.stroke();

          ctx.strokeStyle = selected ? "#38bdf8" : color;
          ctx.lineWidth = selected ? 2 : 1.4;
          ctx.beginPath();
          ctx.moveTo(hinge.x, hinge.y);
          ctx.lineTo(leafX, leafY);
          ctx.stroke();
        }
      }
    }

    if (activeTool === "wall" && cursor) {
      if (drawStart) {
        const start = toScreen(drawStart);
        const end = toScreen(cursor);
        ctx.save();
        ctx.setLineDash([6, 5]);
        ctx.strokeStyle = "rgba(56, 189, 248, 0.85)";
        ctx.lineWidth = Math.max(2, DEFAULTS.wallThickness * scale);
        ctx.lineCap = "butt";
        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        ctx.lineTo(end.x, end.y);
        ctx.stroke();
        ctx.restore();

        const angle = Math.atan2(
          cursor.y - drawStart.y,
          cursor.x - drawStart.x,
        );
        const offsetX = -Math.sin(angle) * 18;
        const offsetY = Math.cos(angle) * 18;
        drawPill(
          formatFeetLength(distance(drawStart, cursor), unit),
          (start.x + end.x) / 2 + offsetX,
          (start.y + end.y) / 2 + offsetY,
          true,
        );

        for (const point of [start, end]) {
          ctx.beginPath();
          ctx.arc(point.x, point.y, 4, 0, Math.PI * 2);
          ctx.fillStyle = "#0b1220";
          ctx.fill();
          ctx.strokeStyle = "#38bdf8";
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      } else {
        const point = toScreen(cursor);
        ctx.strokeStyle = "rgba(56, 189, 248, 0.8)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(point.x - 8, point.y);
        ctx.lineTo(point.x + 8, point.y);
        ctx.moveTo(point.x, point.y - 8);
        ctx.lineTo(point.x, point.y + 8);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(point.x, point.y, 5, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(56, 189, 248, 0.55)";
        ctx.stroke();
      }
    }

    if ((activeTool === "door" || activeTool === "window") && cursor) {
      const wall = walls.find((item) => item.id === hoveredWallId);
      if (wall) {
        const length = wallLength(wall);
        const projection = projectPointOnWall(cursor, wall);
        const width =
          activeTool === "door" ? DEFAULTS.doorWidth : DEFAULTS.windowWidth;
        const half = Math.min(0.45, width / length / 2);
        const center = Math.max(half, Math.min(1 - half, projection.t));
        const startDistance = center * length - width / 2;
        const endDistance = center * length + width / 2;
        const start = toScreen(pointAtDistance(wall, startDistance));
        const end = toScreen(pointAtDistance(wall, endDistance));
        const angle = Math.atan2(wall.y2 - wall.y1, wall.x2 - wall.x1);
        const normalX = -Math.sin(angle);
        const normalY = Math.cos(angle);
        const wallWidthPx = Math.max(2, wall.thickness * scale);

        ctx.save();
        ctx.globalAlpha = 0.85;
        ctx.strokeStyle = "#38bdf8";
        ctx.lineWidth = wallWidthPx + 3;
        ctx.lineCap = "butt";
        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        ctx.lineTo(end.x, end.y);
        ctx.stroke();
        ctx.restore();

        ctx.strokeStyle = "#bae6fd";
        ctx.lineWidth = 1.5;
        for (const point of [start, end]) {
          ctx.beginPath();
          ctx.moveTo(
            point.x + normalX * wallWidthPx * 0.75,
            point.y + normalY * wallWidthPx * 0.75,
          );
          ctx.lineTo(
            point.x - normalX * wallWidthPx * 0.75,
            point.y - normalY * wallWidthPx * 0.75,
          );
          ctx.stroke();
        }

        drawPill(
          `${activeTool} · ${formatFeetLength(width, unit)}`,
          (start.x + end.x) / 2 - normalX * 22,
          (start.y + end.y) / 2 - normalY * 22,
          true,
        );
      }
    }

    const hoveredWall = walls.find(
      (wall) => wall.id === hoveredWallId && activeTool === "select",
    );
    if (hoveredWall && hoveredWall.id !== selectedWallId && cursor) {
      const point = toScreen(cursor);
      ctx.beginPath();
      ctx.arc(point.x, point.y, 3, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(226, 232, 240, 0.75)";
      ctx.fill();
    }
  }, [
    activeTool,
    cursor,
    drawStart,
    furniture,
    hoveredFurnitureId,
    hoveredOpeningId,
    hoveredWallId,
    openings,
    selectedOpeningId,
    selectedFurnitureId,
    selectedWallId,
    size.height,
    size.width,
    unit,
    view,
    walls,
  ]);

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = event.currentTarget;
    const isPan =
      event.button === 1 ||
      (event.button === 0 && (spaceRef.current || event.altKey));

    if (isPan) {
      event.preventDefault();
      const currentView = viewRef.current;
      if (!currentView) return;
      panRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startView: currentView,
      };
      canvas.setPointerCapture(event.pointerId);
      return;
    }

    if (event.button !== 0) return;

    const point = screenToWorld(event.clientX, event.clientY);
    if (!point) return;

    if (activeTool === "wall") {
      const snapped = snapPoint(point, walls);
      if (!drawStart) {
        setDrawStart(snapped);
        setCursor(snapped);
      } else {
        if (distance(drawStart, snapped) >= 0.5) {
          addWall(drawStart.x, drawStart.y, snapped.x, snapped.y);
        }
        setDrawStart(null);
        setCursor(snapped);
      }
      return;
    }

    if (activeTool === "select") {
      const opening = hitTestOpening(point);
      if (opening) {
        selectOpening(opening.id);
        return;
      }
      const furnitureItem = hitTestFurniture(point);
      if (furnitureItem) {
        selectFurniture(furnitureItem.id);
        furnitureDragRef.current = {
          id: furnitureItem.id,
          pointerId: event.pointerId,
          offsetX: furnitureItem.x - point.x,
          offsetY: furnitureItem.y - point.y,
        };
        canvas.setPointerCapture(event.pointerId);
        return;
      }
      const wall = hitTestWall(point);
      if (wall) {
        selectWall(wall.id);
        return;
      }
      clearSelection();
      return;
    }

    if (activeTool === "door" || activeTool === "window") {
      const wall = nearestWall(point);
      if (!wall) return;
      const projection = projectPointOnWall(point, wall);
      addOpening(wall.id, activeTool, projection.t);
    }
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const pan = panRef.current;
    if (pan) {
      const startView = pan.startView;
      applyView({
        scale: startView.scale,
        tx: startView.tx + (event.clientX - pan.startX),
        ty: startView.ty + (event.clientY - pan.startY),
      });
      return;
    }

    const point = screenToWorld(event.clientX, event.clientY);
    if (!point) return;

    const furnitureDrag = furnitureDragRef.current;
    if (furnitureDrag?.pointerId === event.pointerId) {
      updateFurniture(furnitureDrag.id, {
        x: point.x + furnitureDrag.offsetX,
        y: point.y + furnitureDrag.offsetY,
      });
      setCursor(point);
      setHoveredFurnitureId(furnitureDrag.id);
      return;
    }

    if (activeTool === "wall") {
      setCursor(snapPoint(point, walls));
      return;
    }

    setCursor(point);

    if (activeTool === "select") {
      const furnitureItem = hitTestFurniture(point);
      setHoveredFurnitureId(furnitureItem?.id ?? null);
      if (furnitureItem) {
        setHoveredOpeningId(null);
        setHoveredWallId(null);
        return;
      }
    } else {
      setHoveredFurnitureId(null);
    }

    if (activeTool === "door" || activeTool === "window") {
      const wall = nearestWall(point);
      setHoveredWallId(wall?.id ?? null);
      setHoveredOpeningId(null);
      return;
    }

    const opening = hitTestOpening(point);
    if (opening) {
      setHoveredOpeningId(opening.id);
      setHoveredWallId(null);
      return;
    }

    setHoveredOpeningId(null);
    const wall = hitTestWall(point);
    setHoveredWallId(wall?.id ?? null);
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const pan = panRef.current;
    const furnitureDrag = furnitureDragRef.current;
    if (pan?.pointerId === event.pointerId) panRef.current = null;
    if (furnitureDrag?.pointerId === event.pointerId) {
      furnitureDragRef.current = null;
    }
    if (
      (pan?.pointerId === event.pointerId || furnitureDrag?.pointerId === event.pointerId) &&
      event.currentTarget.hasPointerCapture(event.pointerId)
    ) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const onPointerLeave = () => {
    if (panRef.current || furnitureDragRef.current) return;
    setCursor(null);
    setHoveredOpeningId(null);
    setHoveredWallId(null);
    setHoveredFurnitureId(null);
  };

  const onFurnitureDragOver = (event: ReactDragEvent<HTMLCanvasElement>) => {
    if (event.dataTransfer.types.includes("application/x-floorplan-furniture")) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    }
  };

  const onFurnitureDrop = (event: ReactDragEvent<HTMLCanvasElement>) => {
    const kind = event.dataTransfer.getData("application/x-floorplan-furniture");
    if (!isFurnitureKind(kind)) return;
    event.preventDefault();
    const point = screenToWorld(event.clientX, event.clientY);
    if (!point) return;
    addFurniture(kind, point.x, point.y);
    setActiveTool("select");
    setCursor(point);
  };

  const zoomBy = (factor: number) => {
    const currentView = viewRef.current;
    if (!currentView || size.width <= 0 || size.height <= 0) return;
    const centerX = size.width / 2;
    const centerY = size.height / 2;
    const nextScale = clampScale(currentView.scale * factor);
    const ratio = nextScale / currentView.scale;
    applyView({
      scale: nextScale,
      tx: centerX - (centerX - currentView.tx) * ratio,
      ty: centerY - (centerY - currentView.ty) * ratio,
    });
  };

  const hint =
    activeTool === "wall"
      ? drawStart
        ? "Click to place the wall endpoint · Esc to cancel"
        : `Click to start a wall · snap is ${formatFeetLength(0.5, unit)}`
      : activeTool === "door"
        ? `Click a wall to place a ${formatFeetLength(DEFAULTS.doorWidth, unit)} door`
        : activeTool === "window"
          ? `Click a wall to place a ${formatFeetLength(DEFAULTS.windowWidth, unit)} window`
          : "Click a wall, opening or furniture · drag furniture to move · Delete to remove";

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden">
      <canvas
        ref={canvasRef}
        className={cn(
          "block h-full w-full touch-none select-none",
          spaceDown
            ? "cursor-grab"
            : activeTool === "wall"
              ? "cursor-crosshair"
          : activeTool === "select" && hoveredFurnitureId
            ? "cursor-grab"
            : activeTool === "door" || activeTool === "window"
                ? "cursor-copy"
                : "cursor-default",
        )}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerLeave}
        onPointerCancel={onPointerUp}
        onDragOver={onFurnitureDragOver}
        onDrop={onFurnitureDrop}
        onContextMenu={(event) => {
          event.preventDefault();
          setDrawStart(null);
        }}
      />

      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-3 p-3">
        <div className="pointer-events-auto flex items-center gap-0.5 rounded-lg border border-line glass p-0.5 shadow-lg shadow-black/30">
          <button
            type="button"
            onClick={() => zoomBy(0.8)}
            className="rounded-md p-1.5 text-slate-400 transition hover:bg-white/5 hover:text-slate-100"
            aria-label="Zoom out"
          >
            <ZoomOut className="h-3.5 w-3.5" />
          </button>
          <span className="min-w-[64px] px-1 text-center font-mono text-[9px] text-slate-500">
            {view ? `${Math.round(view.scale / unitsPerFoot(unit))} px/${unit}` : "—"}
          </span>
          <button
            type="button"
            onClick={() => zoomBy(1.25)}
            className="rounded-md p-1.5 text-slate-400 transition hover:bg-white/5 hover:text-slate-100"
            aria-label="Zoom in"
          >
            <ZoomIn className="h-3.5 w-3.5" />
          </button>
          <div className="mx-0.5 h-4 w-px bg-line" />
          <button
            type="button"
            onClick={fitView}
            className="rounded-md p-1.5 text-slate-400 transition hover:bg-white/5 hover:text-slate-100"
            aria-label="Fit plan to view"
          >
            <Maximize className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="pointer-events-none rounded-lg border border-line glass px-2.5 py-1.5 text-[10px] text-slate-400 shadow-lg shadow-black/30">
          {hint}
        </div>
      </div>

      <div className="pointer-events-none absolute bottom-3 left-3 flex items-center gap-2 rounded-lg border border-line glass px-2.5 py-1.5 text-[9px] text-slate-500 shadow-lg shadow-black/30">
        <span className="font-mono text-slate-400">2D</span>
        <span className="h-3 w-px bg-line" />
        <span>Middle-drag or Space to pan</span>
        <span className="h-3 w-px bg-line" />
        <span>Scroll to zoom</span>
      </div>
    </div>
  );
}
