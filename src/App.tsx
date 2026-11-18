import { useState } from "react";
import { AppShell } from "./components/layout/AppShell";
import { ProjectStartScreen } from "./components/layout/ProjectStartScreen";
import { StairLadderStudio } from "./components/stairs/StairLadderStudio";
import { useProjectStore } from "./engineering/projectStore";
import type { LocalProject } from "./engineering/projectLibrary";
import { useFloorPlanStore } from "./store/floorPlanStore";
import { openSceneFile } from "./utils/fileIO";

export default function App() {
  const [screen, setScreen] = useState<"home" | "floorplan" | "stairs">("home");
  const [stairsBackTo, setStairsBackTo] = useState<"home" | "floorplan">("home");

  const createFloorPlan = () => {
    useFloorPlanStore.getState().resetScene();
    setScreen("floorplan");
  };

  const createStairProject = () => {
    useProjectStore.getState().resetProject();
    setStairsBackTo("home");
    setScreen("stairs");
  };

  const openFloorPlan = async () => {
    const scene = await openSceneFile();
    if (!scene) return;
    useFloorPlanStore.getState().loadScene(scene);
    setScreen("floorplan");
  };

  const openStairProject = async (project: LocalProject) => {
    const result = useProjectStore.getState().loadProjectState(project.project);
    if (!result.applied) {
      throw new Error(result.error ?? "Could not open that stair project.");
    }
    setStairsBackTo("home");
    setScreen("stairs");
  };

  if (screen === "home") {
    return (
      <ProjectStartScreen
        onCreateFloorPlan={createFloorPlan}
        onCreateStairProject={createStairProject}
        onOpenFloorPlan={openFloorPlan}
        onOpenStairProject={openStairProject}
      />
    );
  }

  if (screen === "stairs") {
    return (
      <StairLadderStudio
        onBack={() => setScreen(stairsBackTo)}
        backLabel={stairsBackTo === "home" ? "Home" : "Floor plan"}
      />
    );
  }

  return (
    <AppShell
      onHome={() => setScreen("home")}
      onOpenStairs={() => {
        setStairsBackTo("floorplan");
        setScreen("stairs");
      }}
    />
  );
}
