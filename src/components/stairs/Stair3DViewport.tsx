import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Grid, OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import {
  Box,
  Camera,
  Download,
  Eye,
  Footprints,
  LoaderCircle,
  ScanLine,
  Upload,
} from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useProjectStore } from "../../engineering/projectStore";
import {
  buildLadder3DLayout,
  buildStair3DLayout,
  calculateHeadroomProfile,
  estimateStairBoundsFromSketch,
  spiralPlanPoint,
  type Beam3D,
  type Point3,
  type Stair3DLayout,
} from "../../engineering/stair3d";
import {
  calculateBalusterSpacing,
} from "../../engineering/railingCalculations";
import {
  feetToProjectUnits,
  formatLength,
  projectUnitsToFeet,
} from "../../engineering/units";
import {
  extractVectorsFromImage,
  type VisionSource,
} from "../../services/visionModelService";
import { logAiError, logAiOutput } from "../../services/aiLog";
import { exportViewportPng } from "../../engineering/viewportExport";
import type { ProjectState } from "../../engineering/types";
import { cn } from "../../utils/cn";

type ViewMode = "orbit" | "walkthrough";

function Beam({ beam }: { beam: Beam3D }) {
  const { position, quaternion, length } = useMemo(() => {
    const start = new THREE.Vector3(beam.start.x, beam.start.y, beam.start.z);
    const end = new THREE.Vector3(beam.end.x, beam.end.y, beam.end.z);
    const direction = end.clone().sub(start);
    const length = direction.length();
    const quaternion = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      direction.normalize(),
    );
    const center = start.add(end).multiplyScalar(0.5);
    return {
      position: [center.x, center.y, center.z] as [number, number, number],
      quaternion,
      length,
    };
  }, [beam]);
  if (length <= 0) return null;
  return (
    <mesh position={position} quaternion={quaternion} castShadow receiveShadow>
      <cylinderGeometry args={[beam.radius, beam.radius, length, 8]} />
      <meshStandardMaterial color={beam.color} roughness={0.7} />
    </mesh>
  );
}

function FlightModel({
  flight,
  project,
  showTreads,
  showStringers,
  showRailing,
}: {
  flight: Stair3DLayout["flights"][number];
  project: ProjectState;
  showTreads: boolean;
  showStringers: boolean;
  showRailing: boolean;
}) {
  const { stairParams } = project;
  const treadThickness = projectUnitsToFeet(stairParams.treadThickness, project.units);
  const balusterWidth = projectUnitsToFeet(stairParams.balusterThickness, project.units);
  const yaw = Math.atan2(-flight.direction.z, flight.direction.x);
  const stepRun = flight.run / Math.max(1, flight.treadCount);
  const stepRise = flight.rise / Math.max(1, flight.riserCount);
  const treads = Array.from({ length: flight.treadCount }, (_, index) => {
    const distance = (index + 0.5) * stepRun;
    return {
      x: flight.start.x + flight.direction.x * distance,
      y: flight.start.y + (index + 1) * stepRise - treadThickness / 2,
      z: flight.start.z + flight.direction.z * distance,
      key: index,
    };
  });
  const risers = Array.from({ length: flight.riserCount }, (_, index) => {
    const distance = Math.min(index, flight.treadCount) * stepRun;
    return {
      x: flight.start.x + flight.direction.x * distance,
      y: flight.start.y + (index + 0.5) * stepRise,
      z: flight.start.z + flight.direction.z * distance,
      key: index,
    };
  });
  const sideVector = { x: -flight.direction.z, z: flight.direction.x };
  const beamSets: Beam3D[] = [];
  const sideOffsets = [-flight.width / 2, flight.width / 2];
  for (const sideOffset of sideOffsets) {
    const start = {
      x: flight.start.x + sideVector.x * sideOffset,
      y: flight.start.y + 0.12,
      z: flight.start.z + sideVector.z * sideOffset,
    };
    const end = {
      x: flight.start.x + flight.direction.x * flight.run + sideVector.x * sideOffset,
      y: flight.start.y + flight.rise + 0.12,
      z: flight.start.z + flight.direction.z * flight.run + sideVector.z * sideOffset,
    };
    beamSets.push({ start, end, radius: 0.12, color: "#5b5144" });
  }

  const railHeight = 3;
  const railBeams: Beam3D[] = [];
  const balusterBeams: Beam3D[] = [];
  if (showRailing) {
    const railLength = Math.hypot(flight.run, flight.rise);
    const railLengthInProjectUnits = feetToProjectUnits(railLength, project.units);
    const spacing = calculateBalusterSpacing(
      Math.max(railLengthInProjectUnits, 0.0625),
      stairParams.balusterSpacingMax,
      stairParams.balusterThickness,
      project.units,
    );
    const gapFeet = projectUnitsToFeet(spacing.clearGapExact, project.units);
    const balusterWidthFeet = balusterWidth;
    for (const sideOffset of sideOffsets) {
      const railStart = {
        x: flight.start.x + sideVector.x * sideOffset,
        y: flight.start.y + railHeight,
        z: flight.start.z + sideVector.z * sideOffset,
      };
      const railEnd = {
        x: flight.start.x + flight.direction.x * flight.run + sideVector.x * sideOffset,
        y: flight.start.y + flight.rise + railHeight,
        z: flight.start.z + flight.direction.z * flight.run + sideVector.z * sideOffset,
      };
      railBeams.push({
        start: railStart,
        end: railEnd,
        radius: 0.075,
        color: "#7b4b2a",
      });
      const count = spacing.balusterCount;
      const spacingFeet = gapFeet + balusterWidthFeet;
      for (let index = 0; index < count; index += 1) {
        const distance =
          gapFeet + balusterWidthFeet / 2 + index * spacingFeet;
        const t = Math.max(0, Math.min(1, distance / Math.max(railLength, 0.001)));
        const step = Math.min(
          flight.riserCount,
          Math.floor(t * flight.treadCount) + 1,
        );
        const foot = {
          x: flight.start.x + flight.direction.x * t * flight.run + sideVector.x * sideOffset,
          y: flight.start.y + step * stepRise,
          z: flight.start.z + flight.direction.z * t * flight.run + sideVector.z * sideOffset,
        };
        const top = {
          x: railStart.x + (railEnd.x - railStart.x) * t,
          y: railStart.y + (railEnd.y - railStart.y) * t,
          z: railStart.z + (railEnd.z - railStart.z) * t,
        };
        if (top.y > foot.y) {
          balusterBeams.push({
            start: foot,
            end: top,
            radius: 0.025,
            color: "#0e7490",
          });
        }
      }
    }
  }

  return (
    <group>
      {showTreads
        ? (
          <group>
            {treads.map((tread) => (
              <mesh
                key={`${flight.id}-tread-${tread.key}`}
                position={[tread.x, tread.y, tread.z]}
                rotation={[0, yaw, 0]}
                castShadow
                receiveShadow
              >
                <boxGeometry
                  args={[
                    stepRun + projectUnitsToFeet(stairParams.nosing, project.units),
                    treadThickness,
                    flight.width,
                  ]}
                />
                <meshStandardMaterial color="#a4774b" roughness={0.84} />
              </mesh>
            ))}
            {risers.map((riser) => (
              <mesh
                key={`${flight.id}-riser-${riser.key}`}
                position={[riser.x, riser.y, riser.z]}
                rotation={[0, yaw, 0]}
                castShadow
              >
                <boxGeometry args={[0.06, stepRise, flight.width]} />
                <meshStandardMaterial color="#d1b28e" roughness={0.92} />
              </mesh>
            ))}
          </group>
        )
        : null}
      {showStringers ? beamSets.map((beam, index) => <Beam key={`${flight.id}-stringer-${index}`} beam={beam} />) : null}
      {railBeams.map((beam, index) => <Beam key={`${flight.id}-rail-${index}`} beam={beam} />)}
      {balusterBeams.map((beam, index) => <Beam key={`${flight.id}-baluster-${index}`} beam={beam} />)}
    </group>
  );
}

function SpiralTread({
  tread,
  thickness,
}: {
  tread: Stair3DLayout["spiralTreads"][number];
  thickness: number;
}) {
  const shape = useMemo(() => {
    const result = new THREE.Shape();
    const segments = 10;
    for (let index = 0; index <= segments; index += 1) {
      const angle =
        tread.startAngle +
        ((tread.endAngle - tread.startAngle) * index) / segments;
      const point = spiralPlanPoint(tread.outerRadius, angle);
      if (index === 0) result.moveTo(point.x, point.z);
      else result.lineTo(point.x, point.z);
    }
    for (let index = segments; index >= 0; index -= 1) {
      const angle =
        tread.startAngle +
        ((tread.endAngle - tread.startAngle) * index) / segments;
      const point = spiralPlanPoint(tread.innerRadius, angle);
      result.lineTo(point.x, point.z);
    }
    result.closePath();
    return result;
  }, [tread]);
  return (
    <mesh
      position={[0, tread.elevation, 0]}
      rotation={[Math.PI / 2, 0, 0]}
      castShadow
      receiveShadow
    >
      <extrudeGeometry args={[shape, { depth: thickness, bevelEnabled: false, steps: 1 }]} />
      <meshStandardMaterial
        color="#a4774b"
        roughness={0.84}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

function SpiralRiser({ tread }: { tread: Stair3DLayout["spiralTreads"][number] }) {
  const geometry = useMemo(() => {
    const innerStart = spiralPlanPoint(tread.innerRadius, tread.startAngle);
    const outerStart = spiralPlanPoint(tread.outerRadius, tread.startAngle);
    const vertices = [
      innerStart.x,
      tread.lowerElevation,
      innerStart.z,
      outerStart.x,
      tread.lowerElevation,
      outerStart.z,
      outerStart.x,
      tread.elevation,
      outerStart.z,
      innerStart.x,
      tread.elevation,
      innerStart.z,
    ];
    const result = new THREE.BufferGeometry();
    result.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(vertices, 3),
    );
    result.setIndex([0, 1, 2, 0, 2, 3]);
    result.computeVertexNormals();
    return result;
  }, [tread]);
  return (
    <mesh geometry={geometry} castShadow>
      <meshStandardMaterial
        color="#d1b28e"
        roughness={0.9}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

function CurveRail({
  points,
  color = "#7b4b2a",
  radius = 0.07,
}: {
  points: Point3[];
  color?: string;
  radius?: number;
}) {
  const geometry = useMemo(() => {
    const curve = new THREE.CatmullRomCurve3(
      points.map((point) => new THREE.Vector3(point.x, point.y, point.z)),
    );
    return new THREE.TubeGeometry(curve, Math.max(points.length * 3, 32), radius, 8, false);
  }, [points, radius]);
  return (
    <mesh geometry={geometry} castShadow>
      <meshStandardMaterial color={color} roughness={0.65} />
    </mesh>
  );
}

function SpiralStringers({ layout }: { layout: Stair3DLayout }) {
  const beams = useMemo(
    () =>
      [0, 1].flatMap((side) =>
        layout.spiralTreads.map((tread) => {
          const radius = side === 0 ? tread.innerRadius : tread.outerRadius;
          const start = spiralPlanPoint(radius, tread.startAngle);
          const end = spiralPlanPoint(radius, tread.endAngle);
          return {
            start: {
              x: start.x,
              y: tread.lowerElevation - 0.06,
              z: start.z,
            },
            end: {
              x: end.x,
              y: tread.elevation - 0.06,
              z: end.z,
            },
            radius: 0.1,
            color: "#5b5144",
          };
        }),
      ),
    [layout.spiralTreads],
  );
  return (
    <group>
      {beams.map((beam, index) => (
        <Beam key={`spiral-stringer-${index}`} beam={beam} />
      ))}
    </group>
  );
}

function SpiralRailing({
  layout,
  project,
}: {
  layout: Stair3DLayout;
  project: ProjectState;
}) {
  const halfWidth = layout.width / 2;
  const railHeight = 3;
  const railPaths = useMemo(
    () =>
      [-1, 1].map((side) =>
        layout.walkPath.map((point) => {
          const radial = Math.hypot(point.x, point.z) || 1;
          const scale = (radial + side * halfWidth) / radial;
          return {
            x: point.x * scale,
            y: point.y + railHeight,
            z: point.z * scale,
          };
        }),
      ),
    [halfWidth, layout.walkPath],
  );
  const balusters = useMemo(() => {
    const run = project.calculatedMetrics.balusterRailRun;
    const count = project.calculatedMetrics.balusterCount;
    if (count <= 0 || run <= 0) return [];
    const thickness = project.stairParams.balusterThickness;
    const gap = Math.max(
      0,
      (run - count * thickness) / (count + 1),
    );
    const drawCount = Math.min(count, 120);
    return [-1, 1].flatMap((side) =>
      Array.from({ length: drawCount }, (_, index) => {
        const actualIndex =
          count <= drawCount
            ? index
            : Math.round((index * (count - 1)) / Math.max(1, drawCount - 1));
        const distance =
          gap + thickness / 2 + actualIndex * (gap + thickness);
        const t = Math.max(0, Math.min(1, distance / run));
        const center = walkPointAt(layout.walkPath, t);
        const radial = Math.hypot(center.x, center.z) || 1;
        const scale = (radial + side * halfWidth) / radial;
        const foot = {
          x: center.x * scale,
          y: center.y,
          z: center.z * scale,
        };
        return {
          start: foot,
          end: { ...foot, y: foot.y + railHeight },
        };
      }),
    );
  }, [
    halfWidth,
    layout.walkPath,
    project.calculatedMetrics.balusterCount,
    project.calculatedMetrics.balusterRailRun,
    project.stairParams.balusterThickness,
  ]);
  return (
    <group>
      {railPaths.map((points, index) => (
        <CurveRail
          key={`spiral-rail-${index}`}
          points={points}
          color="#245b78"
        />
      ))}
      {balusters.map((beam, index) => (
        <Beam
          key={`spiral-baluster-${index}`}
          beam={{ ...beam, radius: 0.025, color: "#0e7490" }}
        />
      ))}
    </group>
  );
}

function StaircaseModel({
  project,
  layout,
  showTreads,
  showStringers,
  showRailing,
}: {
  project: ProjectState;
  layout: Stair3DLayout;
  showTreads: boolean;
  showStringers: boolean;
  showRailing: boolean;
}) {
  const landingThickness = projectUnitsToFeet(
    project.stairParams.treadThickness,
    project.units,
  );
  const centerX = (layout.bounds.minX + layout.bounds.maxX) / 2;
  const centerZ = (layout.bounds.minZ + layout.bounds.maxZ) / 2;
  return (
    <group>
      {layout.flights.map((flight) => (
        <FlightModel
          key={flight.id}
          flight={flight}
          project={project}
          showTreads={showTreads}
          showStringers={showStringers}
          showRailing={showRailing}
        />
      ))}
      {showTreads
        ? layout.landings.map((landing, index) => (
            <mesh
              key={`landing-${index}`}
              position={[
                landing.center.x,
                landing.center.y - landingThickness / 2,
                landing.center.z,
              ]}
              receiveShadow
              castShadow
            >
              <boxGeometry args={[landing.length, landingThickness, landing.width]} />
              <meshStandardMaterial color="#9b7149" roughness={0.86} />
            </mesh>
          ))
        : null}
      {showTreads
        ? layout.spiralTreads.map((tread, index) => (
            <group key={`spiral-step-${index}`}>
              <SpiralTread tread={tread} thickness={landingThickness} />
              <SpiralRiser tread={tread} />
            </group>
          ))
        : null}
      {showStringers && layout.style === "spiral" ? (
        <group>
          <mesh position={[0, layout.totalRise / 2, 0]} castShadow receiveShadow>
            <cylinderGeometry args={[0.16, 0.16, layout.totalRise + 0.25, 24]} />
            <meshStandardMaterial color="#8f7761" />
          </mesh>
          <SpiralStringers layout={layout} />
        </group>
      ) : null}
      {showRailing && layout.style === "spiral" ? (
        <SpiralRailing layout={layout} project={project} />
      ) : null}
      <mesh position={[centerX, -0.12, centerZ]} receiveShadow>
        <boxGeometry
          args={[
            Math.max(layout.bounds.maxX - layout.bounds.minX + 2, 3),
            0.24,
            Math.max(layout.bounds.maxZ - layout.bounds.minZ + 2, 3),
          ]}
        />
        <meshStandardMaterial color="#b6a38d" roughness={0.96} />
      </mesh>
    </group>
  );
}

function LadderModel({
  project,
  showRailing,
}: {
  project: ProjectState;
  showRailing: boolean;
}) {
  const layout = useMemo(() => buildLadder3DLayout(project), [project]);
  const wallHeight = layout.workingHeight + layout.roofExtension + 1;
  return (
    <group>
      <mesh position={[0.12, wallHeight / 2, 0]} receiveShadow>
        <boxGeometry args={[0.24, wallHeight, 3.4]} />
        <meshStandardMaterial
          color="#94a3b8"
          transparent
          opacity={0.24}
          roughness={0.95}
        />
      </mesh>
      {layout.rails.map((beam, index) => (
        <Beam key={`ladder-rail-${index}`} beam={beam} />
      ))}
      {showRailing
        ? layout.rungs.map((beam, index) => (
            <Beam key={`ladder-rung-${index}`} beam={beam} />
          ))
        : null}
      <mesh position={[0, -0.12, 0]} receiveShadow>
        <boxGeometry args={[layout.baseSetback + 4, 0.24, 4]} />
        <meshStandardMaterial color="#b6a38d" roughness={0.96} />
      </mesh>
    </group>
  );
}

function HeadroomOverlay({
  project,
  layout,
  visible,
}: {
  project: ProjectState;
  layout: Stair3DLayout;
  visible: boolean;
}) {
  const profile = useMemo(
    () => calculateHeadroomProfile(project, layout, 40),
    [project, layout],
  );
  if (!visible || project.projectType !== "staircase") return null;
  const planeY =
    profile.ceilingY ??
    projectUnitsToFeet(project.stairParams.headroomCeilingHeight, project.units);
  const width = Math.max(layout.bounds.maxX - layout.bounds.minX + 1.5, 3);
  const depth = Math.max(layout.bounds.maxZ - layout.bounds.minZ + 1.5, 3);
  const centerX = (layout.bounds.minX + layout.bounds.maxX) / 2;
  const centerZ = (layout.bounds.minZ + layout.bounds.maxZ) / 2;
  const dangerPoints = profile.samples
    .filter((sample) => sample.belowCode)
    .filter((_, index) => index % 2 === 0);
  return (
    <group>
      <mesh position={[centerX, planeY, centerZ]} receiveShadow>
        <boxGeometry args={[width, 0.1, depth]} />
        <meshStandardMaterial
          color="#67e8f9"
          transparent
          opacity={0.2}
          side={THREE.DoubleSide}
        />
      </mesh>
      {Array.from({ length: Math.max(2, Math.floor(width / 2)) }, (_, index) => {
        const x =
          centerX - width / 2 + (width * (index + 0.5)) / Math.max(2, Math.floor(width / 2));
        return (
          <mesh key={`joist-${index}`} position={[x, planeY - 0.1, centerZ]}>
            <boxGeometry args={[0.08, 0.15, depth]} />
            <meshStandardMaterial color="#64748b" />
          </mesh>
        );
      })}
      {dangerPoints.map((sample, index) => (
        <mesh
          key={`headroom-alert-${index}`}
          position={[sample.point.x, planeY - 0.18, sample.point.z]}
        >
          <boxGeometry args={[0.42, 0.2, Math.min(layout.width, 2.4)]} />
          <meshStandardMaterial color="#ef4444" emissive="#991b1b" emissiveIntensity={0.3} />
        </mesh>
      ))}
    </group>
  );
}

function walkPointAt(path: Point3[], progress: number) {
  if (path.length <= 1) return path[0] ?? { x: 0, y: 0, z: 0 };
  const lengths: number[] = [];
  let total = 0;
  for (let index = 0; index < path.length - 1; index += 1) {
    const start = path[index];
    const end = path[index + 1];
    const length = Math.hypot(end.x - start.x, end.y - start.y, end.z - start.z);
    lengths.push(length);
    total += length;
  }
  let remaining = Math.max(0, Math.min(1, progress)) * total;
  for (let index = 0; index < lengths.length; index += 1) {
    const length = lengths[index];
    if (remaining <= length || index === lengths.length - 1) {
      const t = length <= 0 ? 0 : remaining / length;
      const start = path[index];
      const end = path[index + 1];
      return {
        x: start.x + (end.x - start.x) * t,
        y: start.y + (end.y - start.y) * t,
        z: start.z + (end.z - start.z) * t,
      };
    }
    remaining -= length;
  }
  return path[path.length - 1];
}

function WalkthroughCamera({
  active,
  progress,
  path,
}: {
  active: boolean;
  progress: number;
  path: Point3[];
}) {
  const camera = useThree((state) => state.camera);
  useFrame(() => {
    if (!active || path.length < 2) return;
    const eyeHeight = 5.5;
    const current = walkPointAt(path, progress);
    const next = walkPointAt(path, Math.min(1, progress + 0.04));
    camera.position.set(current.x, current.y + eyeHeight, current.z);
    camera.lookAt(next.x, next.y + eyeHeight, next.z);
  });
  return null;
}

type ModelBounds = {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  maxY: number;
  centerX: number;
  centerZ: number;
};

function ViewCamera({ bounds }: { bounds: ModelBounds }) {
  const camera = useThree((state) => state.camera);
  const controls = useThree((state) => state.controls);
  useEffect(() => {
    const span = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ, 4);
    const centerX = bounds.centerX;
    const centerZ = bounds.centerZ;
    camera.position.set(centerX + span * 1.25, Math.max(bounds.maxY * 1.35, 8), centerZ + span * 1.55);
    camera.lookAt(centerX, bounds.maxY * 0.4, centerZ);
    const orbit = controls as unknown as {
      target: THREE.Vector3;
      update: () => void;
    } | null;
    if (orbit) {
      orbit.target.set(centerX, bounds.maxY * 0.4, centerZ);
      orbit.update();
    }
  }, [bounds, camera, controls]);
  return null;
}

function Scene({
  project,
  mode,
  progress,
  showTreads,
  showStringers,
  showRailing,
  showHeadroom,
}: {
  project: ProjectState;
  mode: ViewMode;
  progress: number;
  showTreads: boolean;
  showStringers: boolean;
  showRailing: boolean;
  showHeadroom: boolean;
}) {
  const stairLayout = useMemo(
    () => buildStair3DLayout(project),
    [project],
  );
  const ladderLayout = useMemo(
    () => buildLadder3DLayout(project),
    [project],
  );
  const walkPath =
    project.projectType === "staircase"
      ? stairLayout.walkPath
      : ladderLayout.walkPath;
  const bounds = useMemo<ModelBounds>(
    () =>
      project.projectType === "staircase"
        ? {
            ...stairLayout.bounds,
            maxY: stairLayout.totalRise + 8,
            centerX:
              (stairLayout.bounds.minX + stairLayout.bounds.maxX) / 2,
            centerZ:
              (stairLayout.bounds.minZ + stairLayout.bounds.maxZ) / 2,
          }
        : {
            ...ladderLayout.bounds,
            maxY: ladderLayout.workingHeight + ladderLayout.roofExtension,
            centerX:
              (ladderLayout.bounds.minX + ladderLayout.bounds.maxX) / 2,
            centerZ: 0,
          },
    [ladderLayout, project.projectType, stairLayout],
  );
  const span = Math.max(
    bounds.maxX - bounds.minX,
    bounds.maxZ - bounds.minZ,
    4,
  );

  return (
    <>
      <color attach="background" args={["#dbe7ef"]} />
      <fog attach="fog" args={["#dbe7ef", span * 2.5, span * 6]} />
      <ambientLight intensity={0.72} />
      <hemisphereLight args={["#eff8ff", "#78614a", 1.1]} />
      <directionalLight
        position={[bounds.centerX - span, bounds.maxY + span, bounds.centerZ + span]}
        intensity={2}
        castShadow
        shadow-mapSize-width={1024}
        shadow-mapSize-height={1024}
      />
      <mesh
        position={[bounds.centerX, -0.16, bounds.centerZ]}
        receiveShadow
      >
        <boxGeometry args={[span * 2 + 5, 0.3, span * 2 + 5]} />
        <meshStandardMaterial color="#b9a993" roughness={0.95} />
      </mesh>
      <Grid
        position={[bounds.centerX, 0.01, bounds.centerZ]}
        args={[span * 2 + 8, span * 2 + 8]}
        cellSize={1}
        cellThickness={0.25}
        cellColor="#9a9a90"
        sectionSize={5}
        sectionThickness={0.65}
        sectionColor="#74756f"
        fadeDistance={span * 2.4}
        fadeStrength={1.2}
        infiniteGrid
      />
      {project.projectType === "staircase" ? (
        <>
          <StaircaseModel
            project={project}
            layout={stairLayout}
            showTreads={showTreads}
            showStringers={showStringers}
            showRailing={showRailing}
          />
          <HeadroomOverlay
            project={project}
            layout={stairLayout}
            visible={showHeadroom}
          />
        </>
      ) : (
        <LadderModel project={project} showRailing={showRailing} />
      )}
      <ViewCamera bounds={bounds} />
      <WalkthroughCamera
        active={mode === "walkthrough"}
        progress={progress}
        path={walkPath}
      />
      <OrbitControls
        makeDefault
        enabled={mode === "orbit"}
        enableDamping
        dampingFactor={0.08}
        minDistance={2}
        maxDistance={Math.max(55, span * 5)}
        maxPolarAngle={Math.PI / 2 - 0.02}
        enablePan
      />
    </>
  );
}

type SketchProposal = {
  runFeet: number;
  widthFeet: number;
  walls: number;
  source: VisionSource;
  fallbackReason?: string;
};

export function Stair3DViewport() {
  const project = useProjectStore(
    useShallow((state) => ({
      projectType: state.projectType,
      units: state.units,
      stairParams: state.stairParams,
      ladderParams: state.ladderParams,
      calculatedMetrics: state.calculatedMetrics,
    })),
  );
  const updateDesignParameters = useProjectStore(
    (state) => state.updateDesignParameters,
  );
  const [mode, setMode] = useState<ViewMode>("orbit");
  const [progress, setProgress] = useState(0);
  const [showTreads, setShowTreads] = useState(true);
  const [showStringers, setShowStringers] = useState(true);
  const [showRailing, setShowRailing] = useState(true);
  const [showHeadroom, setShowHeadroom] = useState(false);
  const [sketchFile, setSketchFile] = useState<File | null>(null);
  const [scaleFeetPer100Pixels, setScaleFeetPer100Pixels] = useState(10);
  const [sketchBusy, setSketchBusy] = useState(false);
  const [sketchError, setSketchError] = useState<string | null>(null);
  const [sketchProposal, setSketchProposal] =
    useState<SketchProposal | null>(null);
  const [sketchApplied, setSketchApplied] = useState(false);
  const [exportingView, setExportingView] = useState(false);
  const [exportMessage, setExportMessage] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stairLayout = useMemo(() => buildStair3DLayout(project), [project]);
  const headroom = useMemo(
    () => calculateHeadroomProfile(project, stairLayout, 40),
    [project, stairLayout],
  );

  const analyzeSketch = async () => {
    if (!sketchFile || sketchBusy) return;
    setSketchBusy(true);
    setSketchError(null);
    setSketchProposal(null);
    setSketchApplied(false);
    try {
      const result = await extractVectorsFromImage(sketchFile, {
        threshold: 115,
        contrast: 100,
        invert: false,
        feetPer100Pixels: scaleFeetPer100Pixels,
        maxDimension: 1400,
        allowFallback: true,
      });
      const estimatedBounds = estimateStairBoundsFromSketch(result.walls);
      const candidate = {
        ...estimatedBounds,
        walls: result.walls.length,
        source: result.source,
        fallbackReason: result.fallbackReason,
      };
      setSketchProposal(candidate);
      await logAiOutput(
        "stair-sketch-to-3d",
        result.source === "onnx" ? "local-onnx-vision" : "local-heuristic",
        JSON.stringify(candidate),
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Could not parse the sketch.";
      setSketchError(message);
      await logAiError("stair-sketch-to-3d", "local-vision", error);
    } finally {
      setSketchBusy(false);
    }
  };

  const applySketch = () => {
    if (!sketchProposal) return;
    const result = updateDesignParameters({
      projectType: "staircase",
      stairParams: {
        style: "straight",
        totalRun: feetToProjectUnits(sketchProposal.runFeet, project.units),
        width: feetToProjectUnits(sketchProposal.widthFeet, project.units),
      },
    });
    if (!result.applied) {
      setSketchError(result.error ?? "Could not apply the sketch estimates.");
      return;
    }
    setSketchApplied(true);
  };

  const exportView = async () => {
    if (!canvasRef.current || exportingView) return;
    setExportingView(true);
    setExportMessage(null);
    try {
      const path = await exportViewportPng(canvasRef.current);
      if (path) setExportMessage(`3D view exported to ${path}.`);
    } catch (error) {
      setExportMessage(
        error instanceof Error ? error.message : "Could not export the 3D view.",
      );
    } finally {
      setExportingView(false);
    }
  };

  const headroomText =
    project.stairParams.headroomClearance === null
      ? "Not measured"
      : formatLength(project.stairParams.headroomClearance, project.units);
  const headroomState =
    project.stairParams.headroomClearance === null
      ? "unknown"
      : headroom.belowCode
        ? "low"
        : "clear";

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-4 lg:p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-slate-100">
            Parametric 3D model
          </h2>
          <p className="mt-1 text-[10px] text-slate-500">
            Live {project.projectType} geometry · orbit or walk the model
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void exportView()}
            disabled={exportingView}
            className="flex items-center gap-1.5 rounded-lg border border-line bg-panel px-2.5 py-1.5 text-[10px] text-slate-300 hover:border-accent/30 hover:text-accent disabled:opacity-40"
          >
            {exportingView ? (
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
            Export PNG
          </button>
          <div className="flex rounded-lg border border-line bg-black/20 p-0.5">
            {(
              [
                ["orbit", "Orbit"],
                ["walkthrough", "Walkthrough"],
              ] as const
            ).map(([nextMode, label]) => (
              <button
                key={nextMode}
                type="button"
                onClick={() => {
                  setMode(nextMode);
                  if (nextMode === "walkthrough") setShowHeadroom(true);
                }}
                aria-pressed={mode === nextMode}
                className={cn(
                  "flex items-center gap-1 rounded-md px-2.5 py-1.5 text-[10px] transition",
                  mode === nextMode
                    ? "bg-accent/15 text-accent"
                    : "text-slate-400 hover:text-slate-200",
                )}
              >
                {nextMode === "walkthrough" ? (
                  <Footprints className="h-3 w-3" />
                ) : (
                  <Camera className="h-3 w-3" />
                )}
                {label}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-1.5 rounded-lg border border-line bg-panel px-2 py-1.5 text-[9px] text-slate-400">
            <input
              type="checkbox"
              checked={showTreads}
              onChange={(event) => setShowTreads(event.currentTarget.checked)}
            />
            Treads
          </label>
          {project.projectType === "staircase" ? (
            <label className="flex items-center gap-1.5 rounded-lg border border-line bg-panel px-2 py-1.5 text-[9px] text-slate-400">
              <input
                type="checkbox"
                checked={showStringers}
                onChange={(event) =>
                  setShowStringers(event.currentTarget.checked)
                }
              />
              Stringers
            </label>
          ) : null}
          <label className="flex items-center gap-1.5 rounded-lg border border-line bg-panel px-2 py-1.5 text-[9px] text-slate-400">
            <input
              type="checkbox"
              checked={showRailing}
              onChange={(event) => setShowRailing(event.currentTarget.checked)}
            />
            Rails / rungs
          </label>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 gap-3 xl:grid-cols-[minmax(0,1fr)_310px]">
        <section className="relative min-h-[420px] overflow-hidden rounded-xl border border-line bg-[#dbe7ef]">
          <Canvas
            shadows
            dpr={[1, 1.75]}
            camera={{ position: [16, 12, 20], fov: 48, near: 0.1, far: 500 }}
            gl={{ antialias: true, alpha: false, preserveDrawingBuffer: true }}
            onCreated={({ gl }) => {
              canvasRef.current = gl.domElement;
            }}
          >
            <Suspense fallback={null}>
              <Scene
                project={project}
                mode={mode}
                progress={progress}
                showTreads={showTreads}
                showStringers={showStringers}
                showRailing={showRailing}
                showHeadroom={showHeadroom}
              />
            </Suspense>
          </Canvas>
          <div className="pointer-events-none absolute left-3 top-3 rounded-lg border border-white/50 bg-white/75 px-2.5 py-2 text-[9px] text-slate-600 shadow backdrop-blur">
            <div className="flex items-center gap-1.5 font-semibold text-slate-700">
              <Box className="h-3 w-3 text-accent" />
              {project.projectType === "staircase"
                ? `${project.stairParams.style} stair · ${project.calculatedMetrics.stepCount} risers`
                : `${project.ladderParams.ladderType} ladder · ${formatLength(project.ladderParams.workingHeight, project.units)}`}
            </div>
            <p className="mt-1">Drag to orbit · scroll to zoom · changes update live</p>
          </div>
          {exportMessage ? (
            <div className="absolute bottom-3 left-3 rounded-lg border border-white/50 bg-white/85 px-2.5 py-1.5 text-[9px] text-slate-700 shadow">
              {exportMessage}
            </div>
          ) : null}
        </section>

        <aside className="min-h-0 space-y-3 overflow-y-auto">
          {mode === "walkthrough" ? (
            <section className="rounded-xl border border-line bg-panel/70 p-3.5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Eye className="h-4 w-4 text-accent" />
                  <div>
                    <h3 className="text-[11px] font-semibold text-slate-100">
                      Headroom walkthrough
                    </h3>
                    <p className="text-[9px] text-slate-500">
                      Camera at eye height
                    </p>
                  </div>
                </div>
                <span
                  className={cn(
                    "rounded-full border px-2 py-1 text-[8px] uppercase",
                    headroomState === "clear"
                      ? "border-emerald-500/20 text-emerald-300"
                      : headroomState === "low"
                        ? "border-rose-500/20 text-rose-300"
                        : "border-amber-500/20 text-amber-300",
                  )}
                >
                  {headroomState === "clear"
                    ? "Clear"
                    : headroomState === "low"
                      ? "Low clearance"
                      : "Not measured"}
                </span>
              </div>
              <label className="mt-3 block">
                <span className="mb-1 flex justify-between text-[9px] text-slate-500">
                  <span>Walk position</span>
                  <span>{Math.round(progress * 100)}%</span>
                </span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={progress}
                  onChange={(event) =>
                    setProgress(event.currentTarget.valueAsNumber)
                  }
                  className="w-full"
                />
              </label>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <div className="rounded-lg border border-line/70 bg-black/20 p-2">
                  <p className="text-[8px] uppercase tracking-wider text-slate-500">
                    Measured minimum
                  </p>
                  <p className="mt-1 font-mono text-[11px] text-slate-100">
                    {headroomText}
                  </p>
                </div>
                <div className="rounded-lg border border-line/70 bg-black/20 p-2">
                  <p className="text-[8px] uppercase tracking-wider text-slate-500">
                    Code reference
                  </p>
                  <p className="mt-1 font-mono text-[11px] text-slate-100">
                    80 in · IRC R311.7.2
                  </p>
                </div>
              </div>
              <label className="mt-2 flex items-center gap-2 text-[9px] text-slate-400">
                <input
                  type="checkbox"
                  checked={showHeadroom}
                  onChange={(event) =>
                    setShowHeadroom(event.currentTarget.checked)
                  }
                />
                Show ceiling / clearance envelope
              </label>
              <p className="mt-2 text-[8px] leading-relaxed text-slate-600">
                The visualization treats the entered measured minimum as the
                upper-landing reference for a flat ceiling. Confirm actual
                ceiling location and headroom onsite.
              </p>
            </section>
          ) : null}

          <section className="rounded-xl border border-line bg-panel/70 p-3.5">
            <div className="flex items-center gap-2">
              <ScanLine className="h-4 w-4 text-violet-300" />
              <div>
                <h3 className="text-[11px] font-semibold text-slate-100">
                  Sketch-to-3D
                </h3>
                <p className="text-[9px] text-slate-500">
                  Local image parsing · review before applying
                </p>
              </div>
            </div>
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg"
              className="hidden"
              onChange={(event) =>
                setSketchFile(event.currentTarget.files?.[0] ?? null)
              }
            />
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-line bg-black/20 px-3 py-2 text-[10px] text-slate-300 hover:border-accent/35"
            >
              <Upload className="h-3.5 w-3.5" />
              {sketchFile ? sketchFile.name : "Choose sketch / floor plan"}
            </button>
            <label className="mt-2 block">
              <span className="mb-1 flex items-center justify-between text-[9px] text-slate-500">
                <span>Scale calibration</span>
                <span>feet per 100 px</span>
              </span>
              <input
                type="number"
                min={1}
                max={100}
                step={0.5}
                value={scaleFeetPer100Pixels}
                onChange={(event) => {
                  const value = event.currentTarget.valueAsNumber;
                  if (Number.isFinite(value) && value >= 1 && value <= 100) {
                    setScaleFeetPer100Pixels(value);
                  }
                }}
                className="w-full rounded-lg border border-line bg-black/25 px-2 py-1.5 font-mono text-[10px] text-slate-100 outline-none"
              />
            </label>
            <button
              type="button"
              onClick={() => void analyzeSketch()}
              disabled={!sketchFile || sketchBusy}
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-violet-400/25 bg-violet-500/10 px-3 py-2 text-[10px] font-medium text-violet-200 hover:bg-violet-500/15 disabled:opacity-40"
            >
              {sketchBusy ? (
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ScanLine className="h-3.5 w-3.5" />
              )}
              Analyze local sketch
            </button>
            {sketchProposal ? (
              <div className="mt-2 rounded-lg border border-accent/20 bg-accent/[0.05] p-2.5">
                <p className="text-[9px] font-semibold text-slate-200">
                  Estimated space bounds · {sketchProposal.source}
                </p>
                <p className="mt-1 text-[9px] text-slate-400">
                  Run {sketchProposal.runFeet.toFixed(2)} ft · width{" "}
                  {sketchProposal.widthFeet.toFixed(2)} ft ·{" "}
                  {sketchProposal.walls} wall segments
                </p>
                {sketchProposal.fallbackReason ? (
                  <p className="mt-1 text-[8px] text-amber-300">
                    {sketchProposal.fallbackReason}
                  </p>
                ) : null}
                <button
                  type="button"
                  onClick={applySketch}
                  className="mt-2 w-full rounded-md bg-accent/15 px-2 py-1.5 text-[9px] font-medium text-accent hover:bg-accent/20"
                >
                  Apply bounds to straight stair
                </button>
              </div>
            ) : null}
            {sketchApplied ? (
              <p className="mt-2 text-[9px] text-emerald-300">
                Bounds applied; 3D geometry updated. Verify measurements before use.
              </p>
            ) : null}
            {sketchError ? (
              <p className="mt-2 text-[9px] leading-relaxed text-rose-300">
                {sketchError}
              </p>
            ) : null}
            <p className="mt-2 text-[8px] leading-relaxed text-slate-600">
              Images stay on this device. Wall extents are scale-calibrated estimates, not OCR or construction dimensions.
            </p>
          </section>

          <section className="rounded-xl border border-line/70 bg-black/20 p-3 text-[9px] leading-relaxed text-slate-500">
            <div className="mb-1 flex items-center gap-1.5 font-semibold text-slate-400">
              <Box className="h-3 w-3" />
              Parametric model notes
            </div>
            {project.projectType === "staircase"
              ? `${project.stairParams.style} stair · ${project.calculatedMetrics.stepCount} risers · ${formatLength(project.stairParams.width, project.units)} wide`
              : `${project.ladderParams.ladderType} ladder · ${formatLength(project.ladderParams.workingHeight, project.units)} working height`}
            <br />
            Mesh dimensions update directly from ProjectState. Schematic model is not a structural design.
          </section>
          <section className="rounded-xl border border-line/70 bg-black/20 p-3">
            <h3 className="mb-2 text-[9px] font-semibold uppercase tracking-wider text-slate-400">
              Component colors
            </h3>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[9px] text-slate-500">
              {[
                ["#a4774b", "Treads"],
                ["#d1b28e", "Risers"],
                ["#514235", "Stringers"],
                ["#f59e0b", "Tread supports"],
                ["#245b78", "Handrails"],
                ["#0e7490", "Balusters"],
                ["#ef4444", "Low headroom zones"],
              ].map(([color, label]) => (
                <div key={label} className="flex items-center gap-1.5">
                  <span
                    className="h-2.5 w-2.5 rounded-sm"
                    style={{ backgroundColor: color }}
                  />
                  {label}
                </div>
              ))}
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
