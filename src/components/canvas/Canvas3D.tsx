import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { ContactShadows, Grid, OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { Box, Loader2, Move3D, Sparkles, Sun, Trash2 } from "lucide-react";
import { ExtrudedWall } from "./ExtrudedWall";
import { FurnitureModel } from "./FurnitureModel";
import { useFloorPlanStore } from "../../store/floorPlanStore";
import { getSceneBounds, type SceneBounds } from "../../utils/geometry";
import { generateFurnitureLayoutWithAI } from "../../services/furnitureAiService";

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
        position={[bounds.centerX, -0.08, bounds.centerY]}
        receiveShadow
      >
        <boxGeometry args={[bounds.width + 3, 0.16, bounds.height + 3]} />
        <meshStandardMaterial color="#c9beac" roughness={0.96} />
      </mesh>
      <mesh
        position={[bounds.centerX, -0.005, bounds.centerY]}
        receiveShadow
      >
        <boxGeometry args={[bounds.width, 0.01, bounds.height]} />
        <meshStandardMaterial color="#e5ddcf" roughness={0.94} />
      </mesh>
    </group>
  );
}

function SunRig({ bounds }: { bounds: SceneBounds }) {
  const light = useRef<THREE.DirectionalLight>(null);
  const span = Math.max(bounds.width, bounds.height, 10);

  useEffect(() => {
    const directional = light.current;
    if (!directional) return;
    directional.target.position.set(bounds.centerX, 0, bounds.centerY);
    directional.target.updateMatrixWorld();
  }, [bounds.centerX, bounds.centerY]);

  return (
    <>
      <hemisphereLight args={["#f5faff", "#a38b6d", 1.15]} />
      <ambientLight intensity={0.42} color="#fff6e8" />
      <directionalLight
        ref={light}
        castShadow
        position={[bounds.centerX - span * 0.8, span * 1.5, bounds.centerY - span * 0.55]}
        intensity={2.8}
        color="#fff0cf"
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-near={1}
        shadow-camera-far={span * 3}
        shadow-camera-left={-span * 0.8}
        shadow-camera-right={span * 0.8}
        shadow-camera-top={span * 0.8}
        shadow-camera-bottom={-span * 0.8}
        shadow-bias={-0.00035}
      />
      <directionalLight
        position={[bounds.centerX + span * 0.55, span * 0.8, bounds.centerY + span * 0.7]}
        intensity={0.58}
        color="#c3dcff"
      />
    </>
  );
}

function Scene() {
  const walls = useFloorPlanStore((state) => state.walls);
  const openings = useFloorPlanStore((state) => state.openings);
  const furniture = useFloorPlanStore((state) => state.furniture);
  const selectedWallId = useFloorPlanStore((state) => state.selectedWallId);
  const bounds = useMemo(() => getSceneBounds(walls), [walls]);
  const span = Math.max(bounds.width, bounds.height);

  return (
    <>
      <color attach="background" args={["#dce8ef"]} />
      <fog attach="fog" args={["#dce8ef", span * 1.7, span * 3.8]} />
      <SunRig bounds={bounds} />

      <Floor bounds={bounds} />
      <ContactShadows
        position={[bounds.centerX, 0.012, bounds.centerY]}
        scale={[bounds.width, bounds.height]}
        opacity={0.24}
        blur={2.4}
        far={Math.max(8, span * 0.18)}
        resolution={512}
        color="#665748"
      />

      <Grid
        position={[bounds.centerX, 0.02, bounds.centerY]}
        args={[Math.max(120, bounds.width + 20), Math.max(120, bounds.height + 20)]}
        cellSize={1}
        cellThickness={0.22}
        cellColor="#a99f90"
        sectionSize={5}
        sectionThickness={0.5}
        sectionColor="#8c806e"
        fadeDistance={span * 1.6}
        fadeStrength={1.2}
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
      {furniture.map((item) => (
        <FurnitureModel key={item.id} furniture={item} />
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
  const walls = useFloorPlanStore((state) => state.walls);
  const openings = useFloorPlanStore((state) => state.openings);
  const furniture = useFloorPlanStore((state) => state.furniture);
  const setFurniture = useFloorPlanStore((state) => state.setFurniture);
  const [furnishing, setFurnishing] = useState(false);
  const [furnishNote, setFurnishNote] = useState("");
  const furnish = useCallback(async () => {
    if (furnishing || walls.length === 0) return;
    setFurnishing(true);
    setFurnishNote("");

    try {
      const result = await generateFurnitureLayoutWithAI(walls, openings);
      setFurniture(result.plan.furniture);
      setFurnishNote(result.note);
    } catch (error) {
      setFurnishNote(
        error instanceof Error ? error.message : "Could not create a furniture layout.",
      );
    } finally {
      setFurnishing(false);
    }
  }, [furnishing, openings, setFurniture, walls]);
  const roomCount = new Set(furniture.map((item) => item.roomLabel)).size;

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
        <div className="pointer-events-auto flex items-center gap-1.5 rounded-lg border border-line glass p-1 shadow-lg shadow-black/30">
          {furniture.length > 0 ? (
            <span className="px-1.5 text-[10px] text-slate-500">
              {furniture.length} pieces · {roomCount} rooms · {furniture[0].source === "local-llm" ? "Local AI" : "Geometry guess"}
            </span>
          ) : (
            <span className="px-1.5 text-[10px] text-slate-500">
              Ask local AI to furnish the rooms
            </span>
          )}
          <button
            type="button"
            onClick={() => void furnish()}
            disabled={furnishing || walls.length === 0}
            className="flex items-center gap-1.5 rounded-md border border-amber-300/25 bg-amber-200/10 px-2 py-1 text-[10px] font-medium text-amber-100 transition hover:bg-amber-200/20 disabled:opacity-40"
            title="Send complete wall, opening, and room dimensions to your local Ollama model; validate the proposed placements in the app"
          >
            {furnishing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            {furnishing ? "Asking AI" : furniture.length > 0 ? "Regenerate" : "AI furnish"}
          </button>
          {furniture.length > 0 ? (
            <button
              type="button"
              onClick={() => setFurniture([])}
              className="rounded-md p-1 text-slate-400 transition hover:bg-white/10 hover:text-slate-100"
              aria-label="Remove suggested furniture"
              title="Remove suggested furniture"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          ) : null}
          <span className="mx-0.5 h-4 w-px bg-line" />
          <span className="flex items-center gap-1 px-1.5 text-[10px] text-slate-500">
            <Sun className="h-3.5 w-3.5 text-amber-300" />
            Daylight
          </span>
        </div>
      </div>

      {furnishNote ? (
        <div className="pointer-events-none absolute right-3 top-14 max-w-[360px] rounded-lg border border-line bg-white/80 px-2.5 py-1.5 text-[10px] text-slate-600 shadow-md backdrop-blur">
          {furnishNote}
        </div>
      ) : null}

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
