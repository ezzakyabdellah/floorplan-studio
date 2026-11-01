import { useEffect, useMemo } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { Grid, OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { Box, Move3D, Sun } from "lucide-react";
import { ExtrudedWall } from "./ExtrudedWall";
import { useFloorPlanStore } from "../../store/floorPlanStore";
import { getSceneBounds, type SceneBounds } from "../../utils/geometry";

type OrbitControlsLike = {
  target: THREE.Vector3;
  update: () => void;
};

function CameraRig() {
  const camera = useThree((state) => state.camera);
  const controls = useThree((state) => state.controls);
  const revision = useFloorPlanStore((state) => state.revision);

  useEffect(() => {
    const { walls } = useFloorPlanStore.getState();
    const bounds = getSceneBounds(walls);
    const span = Math.max(bounds.width, bounds.height);
    const distance = Math.max(span * 0.95, 16);
    const height = Math.max(span * 0.72, 12);

    camera.position.set(
      bounds.centerX + distance * 0.55,
      height,
      bounds.centerY + distance * 0.85,
    );
    camera.lookAt(bounds.centerX, 2.5, bounds.centerY);

    const orbit = controls as unknown as OrbitControlsLike | null;
    if (orbit) {
      orbit.target.set(bounds.centerX, 2.5, bounds.centerY);
      orbit.update();
    }
  }, [camera, controls, revision]);

  return null;
}

function Floor({ bounds }: { bounds: SceneBounds }) {
  return (
    <group>
      <mesh
        position={[bounds.centerX, -0.07, bounds.centerY]}
        receiveShadow
      >
        <boxGeometry args={[bounds.width + 3, 0.14, bounds.height + 3]} />
        <meshStandardMaterial color="#0d151f" roughness={0.94} metalness={0.04} />
      </mesh>
      <mesh
        position={[bounds.centerX, -0.005, bounds.centerY]}
        receiveShadow
      >
        <boxGeometry args={[bounds.width, 0.01, bounds.height]} />
        <meshStandardMaterial color="#111c27" roughness={0.9} metalness={0.03} />
      </mesh>
    </group>
  );
}

function Scene() {
  const walls = useFloorPlanStore((state) => state.walls);
  const openings = useFloorPlanStore((state) => state.openings);
  const selectedWallId = useFloorPlanStore((state) => state.selectedWallId);
  const bounds = useMemo(() => getSceneBounds(walls), [walls]);

  return (
    <>
      <color attach="background" args={["#070b10"]} />
      <fog attach="fog" args={["#070b10", 52, 140]} />

      <ambientLight intensity={0.55} />
      <hemisphereLight args={["#d7ecff", "#0b1220", 0.75]} />
      <directionalLight
        castShadow
        position={[20, 30, 14]}
        intensity={2.2}
        color="#f6faff"
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-near={1}
        shadow-camera-far={90}
        shadow-camera-left={-45}
        shadow-camera-right={45}
        shadow-camera-top={45}
        shadow-camera-bottom={-45}
        shadow-bias={-0.0004}
      />
      <directionalLight
        position={[-18, 14, -16]}
        intensity={0.45}
        color="#93c5fd"
      />

      <Floor bounds={bounds} />

      <Grid
        position={[bounds.centerX, 0.02, bounds.centerY]}
        args={[120, 120]}
        cellSize={1}
        cellThickness={0.55}
        cellColor="#1c2a39"
        sectionSize={5}
        sectionThickness={1.1}
        sectionColor="#2f465e"
        fadeDistance={75}
        fadeStrength={1.4}
        infiniteGrid
        followCamera={false}
      />

      {walls.map((wall) => (
        <ExtrudedWall
          key={wall.id}
          wall={wall}
          openings={openings}
          selected={wall.id === selectedWallId}
        />
      ))}

      <CameraRig />
      <OrbitControls
        makeDefault
        enableDamping
        dampingFactor={0.08}
        minDistance={7}
        maxDistance={95}
        maxPolarAngle={Math.PI / 2 - 0.02}
        enablePan
      />
    </>
  );
}

export function Canvas3D() {
  return (
    <div className="relative h-full w-full overflow-hidden">
      <Canvas
        shadows
        dpr={[1, 2]}
        camera={{ position: [20, 16, 26], fov: 45, near: 0.1, far: 400 }}
        gl={{ antialias: true, alpha: false }}
        style={{ width: "100%", height: "100%" }}
      >
        <Scene />
      </Canvas>

      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-3 p-3">
        <div className="flex items-center gap-2 rounded-lg border border-line glass px-2.5 py-1.5 text-[10px] text-slate-300 shadow-lg shadow-black/30">
          <Box className="h-3.5 w-3.5 text-accent" />
          <span className="font-medium">3D View</span>
          <span className="h-3 w-px bg-line" />
          <span className="text-slate-500">Auto-extruded walls</span>
        </div>
        <div className="flex items-center gap-2 rounded-lg border border-line glass px-2.5 py-1.5 text-[10px] text-slate-500 shadow-lg shadow-black/30">
          <Sun className="h-3.5 w-3.5 text-amber-300/80" />
          <span>Sunlight + soft shadows</span>
        </div>
      </div>

      <div className="pointer-events-none absolute bottom-3 left-3 flex items-center gap-2 rounded-lg border border-line glass px-2.5 py-1.5 text-[9px] text-slate-500 shadow-lg shadow-black/30">
        <Move3D className="h-3.5 w-3.5 text-slate-400" />
        <span>Left-drag orbit</span>
        <span className="h-3 w-px bg-line" />
        <span>Scroll zoom</span>
        <span className="h-3 w-px bg-line" />
        <span>Right-drag pan</span>
      </div>
    </div>
  );
}
