import { useState } from "react";
import { AppShell } from "./components/layout/AppShell";
import { StairLadderStudio } from "./components/stairs/StairLadderStudio";

export default function App() {
  const [showStairStudio, setShowStairStudio] = useState(false);
  return showStairStudio ? (
    <StairLadderStudio onBack={() => setShowStairStudio(false)} />
  ) : (
    <AppShell onOpenStairs={() => setShowStairStudio(true)} />
  );
}
