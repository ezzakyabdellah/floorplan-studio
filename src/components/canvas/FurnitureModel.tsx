import { useEffect, useMemo, useRef } from "react";
import { Box3, Plane, Vector3 } from "three";
import { useGLTF } from "@react-three/drei";
import type { ThreeEvent } from "@react-three/fiber";
import type { Furniture } from "../../types/floorplan";
import { useFloorPlanStore } from "../../store/floorPlanStore";
import { furnitureCatalogItem } from "../../data/furnitureCatalog";

const groundPlane = new Plane(new Vector3(0, 1, 0), 0);

function Block({
  size,
  position,
  color,
  roughness = 0.78,
}: {
  size: [number, number, number];
  position: [number, number, number];
  color: string;
  roughness?: number;
}) {
  return (
    <mesh position={position} castShadow receiveShadow>
      <boxGeometry args={size} />
      <meshStandardMaterial color={color} roughness={roughness} />
    </mesh>
  );
}

function Bed({ width, depth }: { width: number; depth: number }) {
  const frame = "#9b7653";
  const linen = "#e9e0d1";
  return (
    <group>
      <Block
        size={[width, 0.42, depth]}
        position={[0, 0.24, 0]}
        color={frame}
      />
      <Block
        size={[Math.max(0.2, width - 0.16), 0.22, Math.max(0.2, depth - 0.2)]}
        position={[0, 0.56, 0.02]}
        color={linen}
        roughness={0.95}
      />
      <Block
        size={[Math.max(0.2, width - 0.2), 0.08, depth * 0.43]}
        position={[0, 0.71, depth * 0.17]}
        color="#b9c4c1"
        roughness={0.94}
      />
      <Block
        size={[width, 0.9, 0.14]}
        position={[0, 0.58, -depth / 2 + 0.05]}
        color="#795d45"
      />
      {[-1, 1].flatMap((xSign) =>
        [-1, 1].map((zSign) => (
          <Block
            key={`bed-foot-${xSign}-${zSign}`}
            size={[0.18, 0.22, 0.18]}
            position={[xSign * (width / 2 - 0.22), 0.06, zSign * (depth / 2 - 0.22)]}
            color="#76573d"
          />
        )),
      )}
      <Block
        size={[width * 0.34, 0.12, Math.min(0.55, depth * 0.13)]}
        position={[-width * 0.23, 0.75, -depth * 0.27]}
        color="#fbf8f1"
        roughness={0.98}
      />
      <Block
        size={[width * 0.34, 0.12, Math.min(0.55, depth * 0.13)]}
        position={[width * 0.23, 0.75, -depth * 0.27]}
        color="#fbf8f1"
        roughness={0.98}
      />
    </group>
  );
}

function Sofa({ width, depth }: { width: number; depth: number }) {
  const fabric = "#8b9c91";
  const cushion = "#b9c1b0";
  const armWidth = Math.min(0.42, width * 0.13);
  return (
    <group>
      <Block size={[width, 0.58, depth]} position={[0, 0.35, 0]} color={fabric} />
      <Block
        size={[width - armWidth * 1.6, 0.2, depth * 0.56]}
        position={[0, 0.72, depth * 0.12]}
        color={cushion}
      />
      <Block
        size={[width - armWidth * 1.5, 0.85, Math.min(0.38, depth * 0.2)]}
        position={[0, 0.85, -depth * 0.34]}
        color={fabric}
      />
      {[-1, 0, 1].map((seat) => (
        <Block
          key={`sofa-seat-${seat}`}
          size={[(width - armWidth * 2.25) / 3, 0.17, depth * 0.52]}
          position={[seat * (width - armWidth * 2.25) / 3, 0.77, depth * 0.12]}
          color={cushion}
          roughness={0.95}
        />
      ))}
      <Block
        size={[armWidth, 0.7, depth * 0.86]}
        position={[-width / 2 + armWidth / 2, 0.55, 0]}
        color={fabric}
      />
      <Block
        size={[armWidth, 0.7, depth * 0.86]}
        position={[width / 2 - armWidth / 2, 0.55, 0]}
        color={fabric}
      />
    </group>
  );
}

function Table({
  width,
  depth,
  height,
  color = "#a77b50",
}: {
  width: number;
  depth: number;
  height: number;
  color?: string;
}) {
  const leg = Math.max(0.08, Math.min(0.16, width * 0.035));
  const insetX = Math.max(leg, width * 0.08);
  const insetZ = Math.max(leg, depth * 0.1);
  const legHeight = Math.max(0.1, height - 0.12);
  return (
    <group>
      <Block size={[width, 0.12, depth]} position={[0, height - 0.06, 0]} color={color} />
      {[-1, 1].flatMap((xSign) =>
        [-1, 1].map((zSign) => (
          <Block
            key={`${xSign}-${zSign}`}
            size={[leg, legHeight, leg]}
            position={[xSign * (width / 2 - insetX), legHeight / 2, zSign * (depth / 2 - insetZ)]}
            color="#806143"
          />
        )),
      )}
    </group>
  );
}

function Chair({ width, depth, height }: { width: number; depth: number; height: number }) {
  const wood = "#9c7958";
  const seatHeight = Math.min(1.6, height * 0.48);
  const leg = Math.max(0.07, Math.min(0.13, width * 0.12));
  return (
    <group>
      <Block size={[width, 0.12, depth]} position={[0, seatHeight, 0]} color="#bdad94" />
      <Block
        size={[width, Math.max(0.3, height - seatHeight), 0.1]}
        position={[0, (height + seatHeight) / 2, -depth / 2 + 0.05]}
        color={wood}
      />
      {[-1, 1].flatMap((xSign) =>
        [-1, 1].map((zSign) => (
          <Block
            key={`${xSign}-${zSign}`}
            size={[leg, seatHeight, leg]}
            position={[xSign * (width / 2 - leg), seatHeight / 2, zSign * (depth / 2 - leg)]}
            color={wood}
          />
        )),
      )}
    </group>
  );
}

function ImportedFurnitureAsset({
  url,
  width,
  depth,
  height,
}: {
  url: string;
  width: number;
  depth: number;
  height: number;
}) {
  const { scene } = useGLTF(url);
  const normalized = useMemo(() => {
    const object = scene.clone(true);
    object.updateMatrixWorld(true);
    const bounds = new Box3().setFromObject(object);
    const size = bounds.getSize(new Vector3());
    const center = bounds.getCenter(new Vector3());
    const safeSize = {
      x: Math.max(size.x, 0.001),
      y: Math.max(size.y, 0.001),
      z: Math.max(size.z, 0.001),
    };
    const uniformScale = Math.min(
      width / safeSize.x,
      height / safeSize.y,
      depth / safeSize.z,
    );
    const scale: [number, number, number] = [uniformScale, uniformScale, uniformScale];
    const position: [number, number, number] = [
      -center.x * scale[0],
      -bounds.min.y * scale[1],
      -center.z * scale[2],
    ];

    object.traverse((child) => {
      if ((child as import("three").Mesh).isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
    return { object, position, scale };
  }, [depth, height, scene, width]);

  return (
    <primitive
      object={normalized.object}
      position={normalized.position}
      scale={normalized.scale}
    />
  );
}

export function FurnitureModel({
  furniture,
  selected = false,
  proceduralOnly = false,
}: {
  furniture: Furniture;
  selected?: boolean;
  proceduralOnly?: boolean;
}) {
  const { kind, x, y, width, depth, height, rotation } = furniture;
  const modelUrl = furnitureCatalogItem(kind).modelUrl;
  const dragOffset = useRef<{ x: number; z: number } | null>(null);
  const selectFurniture = useFloorPlanStore((state) => state.selectFurniture);
  const setFurnitureDragging = useFloorPlanStore((state) => state.setFurnitureDragging);
  const updateFurniture = useFloorPlanStore((state) => state.updateFurniture);

  useEffect(
    () => () => {
      if (dragOffset.current) setFurnitureDragging(false);
    },
    [setFurnitureDragging],
  );

  const getGroundPoint = (event: ThreeEvent<PointerEvent>) =>
    event.ray.intersectPlane(groundPlane, new Vector3());
  const onPointerDown = (event: ThreeEvent<PointerEvent>) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    selectFurniture(furniture.id);
    const point = getGroundPoint(event);
    if (!point) return;
    dragOffset.current = { x: x - point.x, z: y - point.z };
    setFurnitureDragging(true);
    const captureTarget = event.target as unknown as {
      setPointerCapture?: (pointerId: number) => void;
    };
    captureTarget.setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event: ThreeEvent<PointerEvent>) => {
    const offset = dragOffset.current;
    if (!offset || event.buttons === 0) return;
    event.stopPropagation();
    const point = getGroundPoint(event);
    if (!point) return;
    updateFurniture(furniture.id, { x: point.x + offset.x, y: point.z + offset.z });
  };
  const onPointerUp = (event: ThreeEvent<PointerEvent>) => {
    if (!dragOffset.current) return;
    event.stopPropagation();
    dragOffset.current = null;
    setFurnitureDragging(false);
    const captureTarget = event.target as unknown as {
      releasePointerCapture?: (pointerId: number) => void;
    };
    captureTarget.releasePointerCapture?.(event.pointerId);
  };

  return (
    <group
      position={[x, 0, y]}
      rotation={[0, -rotation, 0]}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerOver={(event) => {
        event.stopPropagation();
        document.body.style.cursor = "grab";
      }}
      onPointerOut={() => {
        document.body.style.cursor = "";
      }}
    >
      {selected ? (
        <mesh position={[0, Math.max(height, 1) / 2, 0]} raycast={() => null}>
          <boxGeometry args={[width + 0.18, Math.max(height, 1) + 0.18, depth + 0.18]} />
          <meshBasicMaterial color="#38bdf8" wireframe transparent opacity={0.82} depthTest={false} />
        </mesh>
      ) : null}
      {modelUrl && !proceduralOnly ? (
        <ImportedFurnitureAsset
          url={modelUrl}
          width={width}
          depth={depth}
          height={height}
        />
      ) : (
        <group>
          {kind === "bed" ? <Bed width={width} depth={depth} /> : null}
          {kind === "nightstand" ? (
            <group>
              <Block size={[width, height * 0.8, depth]} position={[0, height * 0.4, 0]} color="#a17b59" />
              <Block size={[width * 0.86, 0.12, depth * 0.86]} position={[0, height * 0.83, 0]} color="#c4a27b" />
              <Block size={[width * 0.68, 0.045, 0.035]} position={[0, height * 0.55, depth / 2 + 0.02]} color="#785b43" />
              <Block size={[0.12, 0.12, 0.08]} position={[0, height * 0.55, depth / 2 + 0.065]} color="#d7bd91" />
            </group>
          ) : null}
          {kind === "wardrobe" ? (
            <group>
              <Block size={[width, height, depth]} position={[0, height / 2, 0]} color="#c6b69c" />
              <Block size={[0.035, height * 0.84, 0.04]} position={[0, height / 2, depth / 2 + 0.025]} color="#a28d70" />
              <Block size={[0.055, height * 0.76, 0.045]} position={[-width * 0.22, height * 0.52, depth / 2 + 0.03]} color="#806143" />
              <Block size={[0.055, height * 0.76, 0.045]} position={[width * 0.22, height * 0.52, depth / 2 + 0.03]} color="#806143" />
            </group>
          ) : null}
          {kind === "sofa" ? <Sofa width={width} depth={depth} /> : null}
          {kind === "coffee-table" || kind === "dining-table" ? (
            <Table
              width={width}
              depth={depth}
              height={height}
              color={kind === "coffee-table" ? "#b68b60" : "#9f7651"}
            />
          ) : null}
          {kind === "media-console" ? (
            <group>
              <Block size={[width, height * 0.65, depth]} position={[0, height * 0.33, 0]} color="#977653" />
              <Block size={[width * 1.02, 0.1, depth * 1.05]} position={[0, height * 0.7, 0]} color="#c4a27b" />
              <Block size={[width * 0.62, height * 0.52, 0.08]} position={[0, height * 1.55, -depth * 0.28]} color="#293945" roughness={0.35} />
            </group>
          ) : null}
          {kind === "desk" ? (
            <group>
              <Table width={width} depth={depth} height={height} color="#bd9b72" />
              <Block size={[width * 0.42, 0.07, depth * 0.25]} position={[0, height + 0.05, 0]} color="#e3ddd2" />
            </group>
          ) : null}
          {kind === "desk-chair" || kind === "chair" ? (
            <Chair width={width} depth={depth} height={height} />
          ) : null}
        </group>
      )}
    </group>
  );
}
