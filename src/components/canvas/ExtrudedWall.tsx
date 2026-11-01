import { useMemo } from "react";
import { Edges } from "@react-three/drei";
import { DEFAULTS, type Opening, type Wall } from "../../types/floorplan";
import { getWallIntervals, wallAngle, wallLength } from "../../utils/geometry";

type Piece = {
  key: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
};

export function ExtrudedWall({
  wall,
  openings,
  selected = false,
}: {
  wall: Wall;
  openings: Opening[];
  selected?: boolean;
}) {
  const length = wallLength(wall);
  const angle = wallAngle(wall);
  const height = Math.max(1, wall.height);
  const thickness = Math.max(0.08, wall.thickness);
  const midX = (wall.x1 + wall.x2) / 2;
  const midZ = (wall.y1 + wall.y2) / 2;

  const intervals = useMemo(
    () => getWallIntervals(wall, openings),
    [wall, openings],
  );

  const pieces = useMemo(() => {
    if (length <= 0.05) return [];
    const list: Piece[] = [];
    let cursor = 0;

    const push = (
      start: number,
      end: number,
      y: number,
      pieceHeight: number,
      color: string,
      key: string,
    ) => {
      const width = end - start;
      if (width <= 0.02 || pieceHeight <= 0.02) return;
      list.push({
        key,
        x: (start + end) / 2 - length / 2,
        y,
        width,
        height: pieceHeight,
        color,
      });
    };

    intervals.forEach((interval, index) => {
      if (interval.start > cursor + 0.01) {
        push(
          cursor,
          interval.start,
          height / 2,
          height,
          selected ? "#8fd8f5" : "#c9d5e2",
          `solid-${index}-a`,
        );
      }

      const gapLength = interval.end - interval.start;
      if (interval.opening.type === "door") {
        const doorHeight = Math.min(DEFAULTS.doorHeight, height);
        if (height - doorHeight > 0.05) {
          push(
            interval.start,
            interval.end,
            doorHeight + (height - doorHeight) / 2,
            height - doorHeight,
            selected ? "#8fd8f5" : "#c9d5e2",
            `door-header-${index}`,
          );
        }
      } else {
        const sill = Math.min(DEFAULTS.windowSill, height);
        const top = Math.min(sill + DEFAULTS.windowHeight, height);
        if (sill > 0.05) {
          push(
            interval.start,
            interval.end,
            sill / 2,
            sill,
            selected ? "#8fd8f5" : "#c9d5e2",
            `window-sill-${index}`,
          );
        }
        if (height - top > 0.05) {
          push(
            interval.start,
            interval.end,
            top + (height - top) / 2,
            height - top,
            selected ? "#8fd8f5" : "#c9d5e2",
            `window-header-${index}`,
          );
        }
      }

      if (gapLength <= 0.02) return;
      cursor = Math.max(cursor, interval.end);
    });

    if (cursor < length - 0.01) {
      push(
        cursor,
        length,
        height / 2,
        height,
        selected ? "#8fd8f5" : "#c9d5e2",
        "solid-end",
      );
    }

    return list;
  }, [height, intervals, length, selected]);

  if (length <= 0.05) return null;

  return (
    <group position={[midX, 0, midZ]} rotation={[0, -angle, 0]}>
      {pieces.map((piece) => (
        <mesh
          key={piece.key}
          position={[piece.x, piece.y, 0]}
          castShadow
          receiveShadow
        >
          <boxGeometry
            args={[piece.width, piece.height, thickness]}
          />
          <meshStandardMaterial
            color={piece.color}
            roughness={0.82}
            metalness={0.04}
          />
          <Edges threshold={20} color={selected ? "#38bdf8" : "#5b6b7e"} />
        </mesh>
      ))}

      {intervals.map((interval) => {
        const gapLength = interval.end - interval.start;
        if (gapLength <= 0.02) return null;
        const localX =
          (interval.start + interval.end) / 2 - length / 2;

        if (interval.opening.type === "door") {
          const doorHeight = Math.min(DEFAULTS.doorHeight, height);
          return (
            <mesh
              key={`door-slab-${interval.opening.id}`}
              position={[localX, doorHeight / 2, 0]}
              castShadow
              receiveShadow
            >
              <boxGeometry
                args={[Math.max(0.1, gapLength - 0.14), doorHeight - 0.1, 0.14]}
              />
              <meshStandardMaterial
                color="#6b4f3a"
                roughness={0.68}
                metalness={0.06}
              />
            </mesh>
          );
        }

        const sill = Math.min(DEFAULTS.windowSill, height);
        const top = Math.min(sill + DEFAULTS.windowHeight, height);
        return (
          <mesh
            key={`window-glass-${interval.opening.id}`}
            position={[localX, (sill + top) / 2, 0]}
          >
            <boxGeometry
              args={[Math.max(0.1, gapLength - 0.14), Math.max(0.1, top - sill), 0.08]}
            />
            <meshStandardMaterial
              color="#7dd3fc"
              transparent
              opacity={0.32}
              roughness={0.08}
              metalness={0.15}
              depthWrite={false}
            />
          </mesh>
        );
      })}
    </group>
  );
}
