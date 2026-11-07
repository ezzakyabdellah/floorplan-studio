import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Armchair,
  Box,
  CheckCircle2,
  DoorOpen,
  Download,
  Frame,
  Grid3X3,
  ImagePlus,
  Info,
  Loader2,
  MousePointer2,
  PanelsTopLeft,
  PencilRuler,
  Plus,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";
import { Canvas2D } from "../canvas/Canvas2D";
import { Canvas3D } from "../canvas/Canvas3D";
import { CompliancePanel } from "../ui/CompliancePanel";
import { ImageImporter } from "../ui/ImageImporter";
import { LocalAiAssistant } from "../ui/LocalAiAssistant";
import { useFloorPlanStore } from "../../store/floorPlanStore";
import type { ActiveTool } from "../../types/floorplan";
import { buildSceneFile, openSceneFile, saveSceneFile } from "../../utils/fileIO";
import { wallLength } from "../../utils/geometry";
import { runComplianceChecks } from "../../utils/spatialRules";
import { generateFurnitureLayoutWithAI } from "../../services/furnitureAiService";
import { cn } from "../../utils/cn";

type ToastTone = "info" | "success" | "error";

type ToastState = {
  id: number;
  message: string;
  tone: ToastTone;
} | null;

type Notify = (message: string, tone?: ToastTone) => void;

function ToolButton({
  icon: Icon,
  label,
  shortcut,
  active,
  onClick,
  disabled,
  badge,
}: {
  icon: typeof MousePointer2;
  label: string;
  shortcut?: string;
  active?: boolean;
  onClick?: () => void;
  disabled?: boolean;
  badge?: string | number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      title={shortcut ? `${label} (${shortcut})` : label}
      className={cn(
        "group flex w-full items-center gap-2.5 rounded-lg border px-2 py-1.5 text-left transition",
        active
          ? "border-accent/30 bg-accent/10 text-slate-100 shadow-[inset_0_0_0_1px_rgba(56,189,248,0.08)]"
          : "border-transparent text-slate-400 hover:bg-white/[0.04] hover:text-slate-200",
        disabled && "cursor-not-allowed opacity-40 hover:bg-transparent",
      )}
    >
      <span
        className={cn(
          "flex h-7 w-7 shrink-0 items-center justify-center rounded-md border transition",
          active
            ? "border-accent/30 bg-accent/15 text-accent"
            : "border-line bg-black/20 text-slate-400 group-hover:text-slate-200",
        )}
      >
        <Icon className="h-3.5 w-3.5" />
      </span>
      <span className="min-w-0 flex-1 truncate text-[12px] font-medium">
        {label}
      </span>
      {badge !== undefined ? (
        <span
          className={cn(
            "rounded-full border px-1.5 py-0.5 text-[9px] font-semibold",
            typeof badge === "number" && badge > 0
              ? "border-rose-500/30 bg-rose-500/15 text-rose-300"
              : "border-line bg-black/20 text-slate-500",
          )}
        >
          {badge}
        </span>
      ) : shortcut ? (
        <kbd className="rounded border border-line bg-black/20 px-1 py-0.5 font-mono text-[9px] text-slate-500">
          {shortcut}
        </kbd>
      ) : null}
    </button>
  );
}

function NumberField({
  label,
  value,
  unit,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 flex items-center justify-between text-[10px] font-medium uppercase tracking-[0.12em] text-slate-500">
        <span>{label}</span>
        {unit ? <span className="normal-case tracking-normal">{unit}</span> : null}
      </span>
      <input
        type="number"
        value={Number.isFinite(value) ? Number(value.toFixed(3)) : 0}
        min={min}
        max={max}
        step={step ?? 0.1}
        onChange={(event) => {
          const next = event.currentTarget.valueAsNumber;
          if (Number.isFinite(next)) onChange(next);
        }}
        className="w-full rounded-lg border border-line bg-black/25 px-2.5 py-1.5 font-mono text-[12px] text-slate-100 outline-none transition focus:border-accent/50 focus:ring-2 focus:ring-accent/10"
      />
    </label>
  );
}

function Inspector() {
  const walls = useFloorPlanStore((state) => state.walls);
  const openings = useFloorPlanStore((state) => state.openings);
  const selectedWallId = useFloorPlanStore((state) => state.selectedWallId);
  const selectedOpeningId = useFloorPlanStore(
    (state) => state.selectedOpeningId,
  );
  const updateWall = useFloorPlanStore((state) => state.updateWall);
  const updateOpening = useFloorPlanStore((state) => state.updateOpening);
  const deleteWall = useFloorPlanStore((state) => state.deleteWall);
  const deleteOpening = useFloorPlanStore((state) => state.deleteOpening);

  const selectedWall = walls.find((wall) => wall.id === selectedWallId);
  const selectedOpening = openings.find(
    (opening) => opening.id === selectedOpeningId,
  );

  if (selectedOpening) {
    const wall = walls.find((item) => item.id === selectedOpening.wallId);
    const inches = selectedOpening.width * 12;
    const tooNarrow =
      selectedOpening.type === "door" && inches < 32;

    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
              Selection
            </p>
            <p className="mt-0.5 text-[13px] font-semibold text-slate-100">
              {selectedOpening.type === "door" ? "Doorway" : "Window"}
            </p>
          </div>
          <span className="rounded-full border border-accent/20 bg-accent/10 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-accent">
            {selectedOpening.type}
          </span>
        </div>

        <div className="rounded-lg border border-line/70 bg-black/20 px-2.5 py-2 font-mono text-[10px] text-slate-400">
          Host: {wall ? `Wall ${walls.indexOf(wall) + 1}` : "Unknown"}
        </div>

        <NumberField
          label="Clear width"
          value={selectedOpening.width}
          unit="ft"
          min={0.5}
          max={12}
          step={0.05}
          onChange={(width) => updateOpening(selectedOpening.id, { width })}
        />

        <div>
          <div className="mb-1 flex items-center justify-between text-[10px] font-medium uppercase tracking-[0.12em] text-slate-500">
            <span>Position</span>
            <span className="font-mono normal-case tracking-normal">
              {Math.round(selectedOpening.positionOnWall * 100)}%
            </span>
          </div>
          <input
            type="range"
            min={0.05}
            max={0.95}
            step={0.01}
            value={selectedOpening.positionOnWall}
            onChange={(event) =>
              updateOpening(selectedOpening.id, {
                positionOnWall: event.currentTarget.valueAsNumber,
              })
            }
            className="w-full"
          />
        </div>

        {tooNarrow ? (
          <div className="flex items-start gap-2 rounded-lg border border-rose-500/20 bg-rose-500/[0.07] p-2.5 text-[10px] leading-relaxed text-rose-200">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Door is {inches.toFixed(1)} in wide. Egress minimum is 32 in.
          </div>
        ) : (
          <div className="flex items-center gap-2 rounded-lg border border-line/70 bg-black/20 p-2.5 text-[10px] text-slate-400">
            <Info className="h-3.5 w-3.5 shrink-0 text-slate-500" />
            {inches.toFixed(1)} in wide
          </div>
        )}

        <button
          type="button"
          onClick={() => deleteOpening(selectedOpening.id)}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-rose-500/20 bg-rose-500/[0.06] px-2.5 py-2 text-[11px] font-medium text-rose-300 transition hover:bg-rose-500/[0.12]"
        >
          <Trash2 className="h-3.5 w-3.5" />
          Delete opening
        </button>
      </div>
    );
  }

  if (selectedWall) {
    const length = wallLength(selectedWall);
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
              Selection
            </p>
            <p className="mt-0.5 text-[13px] font-semibold text-slate-100">
              Wall {walls.indexOf(selectedWall) + 1}
            </p>
          </div>
          <span className="rounded-full border border-line bg-black/20 px-2 py-0.5 font-mono text-[9px] text-slate-400">
            {length.toFixed(2)} ft
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2 rounded-lg border border-line/70 bg-black/20 p-2.5 font-mono text-[10px] text-slate-400">
          <span>
            X1 {selectedWall.x1.toFixed(1)}
            <br />
            Y1 {selectedWall.y1.toFixed(1)}
          </span>
          <span>
            X2 {selectedWall.x2.toFixed(1)}
            <br />
            Y2 {selectedWall.y2.toFixed(1)}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <NumberField
            label="Thickness"
            value={selectedWall.thickness}
            unit="ft"
            min={0.1}
            max={2}
            step={0.05}
            onChange={(thickness) =>
              updateWall(selectedWall.id, { thickness })
            }
          />
          <NumberField
            label="Height"
            value={selectedWall.height}
            unit="ft"
            min={4}
            max={20}
            step={0.5}
            onChange={(height) => updateWall(selectedWall.id, { height })}
          />
        </div>

        <button
          type="button"
          onClick={() => deleteWall(selectedWall.id)}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-rose-500/20 bg-rose-500/[0.06] px-2.5 py-2 text-[11px] font-medium text-rose-300 transition hover:bg-rose-500/[0.12]"
        >
          <Trash2 className="h-3.5 w-3.5" />
          Delete wall
        </button>
      </div>
    );
  }

  const doorCount = openings.filter((opening) => opening.type === "door").length;
  const windowCount = openings.length - doorCount;

  return (
    <div className="space-y-3">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
          Selection
        </p>
        <p className="mt-0.5 text-[12px] text-slate-400">
          Select a wall or opening to inspect and edit it.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {[
          { label: "Walls", value: walls.length },
          { label: "Openings", value: openings.length },
          { label: "Doors", value: doorCount },
          { label: "Windows", value: windowCount },
        ].map((item) => (
          <div
            key={item.label}
            className="rounded-lg border border-line/70 bg-black/20 px-2.5 py-2"
          >
            <p className="font-mono text-[15px] font-semibold text-slate-200">
              {item.value}
            </p>
            <p className="text-[9px] uppercase tracking-[0.12em] text-slate-500">
              {item.label}
            </p>
          </div>
        ))}
      </div>

      <div className="rounded-lg border border-line/70 bg-black/20 p-2.5 text-[10px] leading-relaxed text-slate-500">
        <p className="font-medium text-slate-400">Quick tips</p>
        <p className="mt-1">
          Press <span className="font-mono text-slate-300">W</span> to draw a
          wall, then click twice. Use{" "}
          <span className="font-mono text-slate-300">D</span> or{" "}
          <span className="font-mono text-slate-300">N</span> and click a wall
          to add a door or window.
        </p>
      </div>
    </div>
  );
}

function Sidebar() {
  const activeTool = useFloorPlanStore((state) => state.activeTool);
  const setActiveTool = useFloorPlanStore((state) => state.setActiveTool);
  const complianceOpen = useFloorPlanStore((state) => state.complianceOpen);
  const toggleCompliance = useFloorPlanStore((state) => state.toggleCompliance);
  const aiOpen = useFloorPlanStore((state) => state.aiOpen);
  const toggleAi = useFloorPlanStore((state) => state.toggleAi);
  const walls = useFloorPlanStore((state) => state.walls);
  const openings = useFloorPlanStore((state) => state.openings);
  const furniture = useFloorPlanStore((state) => state.furniture);
  const setFurniture = useFloorPlanStore((state) => state.setFurniture);
  const setActiveView = useFloorPlanStore((state) => state.setActiveView);

  const report = useMemo(
    () => runComplianceChecks(walls, openings),
    [walls, openings],
  );
  const issueCount = report.failCount + report.warningCount;

  const tools: Array<{
    id: ActiveTool;
    label: string;
    icon: typeof MousePointer2;
    shortcut: string;
  }> = [
    { id: "select", label: "Select", icon: MousePointer2, shortcut: "V" },
    { id: "wall", label: "Draw Wall", icon: PencilRuler, shortcut: "W" },
    { id: "door", label: "Door", icon: DoorOpen, shortcut: "D" },
    { id: "window", label: "Window", icon: PanelsTopLeft, shortcut: "N" },
  ];

  return (
    <aside className="flex w-[228px] shrink-0 flex-col border-r border-line bg-panel/70">
      <div className="space-y-1 border-b border-line p-3">
        <p className="mb-2 px-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
          Tools
        </p>
        {tools.map((tool) => (
          <ToolButton
            key={tool.id}
            icon={tool.icon}
            label={tool.label}
            shortcut={tool.shortcut}
            active={activeTool === tool.id}
            onClick={() => setActiveTool(tool.id)}
          />
        ))}
        <ToolButton
          icon={Armchair}
          label="AI Furnish"
          active={furniture.length > 0}
          disabled={walls.length === 0}
          onClick={() => {
            void generateFurnitureLayoutWithAI(walls, openings).then((result) => {
              setFurniture(result.plan.furniture);
              setActiveView("3d");
            });
          }}
          badge="AI"
        />
      </div>

      <div className="space-y-2 border-b border-line p-3">
        <p className="px-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
          Analysis
        </p>
        <ToolButton
          icon={ShieldCheck}
          label="Rule Check"
          shortcut="R"
          active={complianceOpen}
          onClick={toggleCompliance}
          badge={issueCount > 0 ? issueCount : "OK"}
        />
        <ToolButton
          icon={Sparkles}
          label="AI Inspector"
          shortcut="A"
          active={aiOpen}
          onClick={toggleAi}
          badge="Local"
        />
        <div
          className={cn(
            "flex items-center gap-2 rounded-lg border px-2.5 py-2 text-[10px]",
            report.allPassing
              ? "border-emerald-500/15 bg-emerald-500/[0.05] text-emerald-300"
              : "border-amber-500/15 bg-amber-500/[0.05] text-amber-300",
          )}
        >
          {report.allPassing ? (
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          )}
          <span className="truncate">
            {report.allPassing
              ? "Plan is compliant"
              : `${issueCount} compliance issue${issueCount === 1 ? "" : "s"}`}
          </span>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <Inspector />
      </div>
    </aside>
  );
}

function ViewSwitcher() {
  const activeView = useFloorPlanStore((state) => state.activeView);
  const setActiveView = useFloorPlanStore((state) => state.setActiveView);

  return (
    <div className="flex items-center rounded-lg border border-line bg-black/25 p-0.5">
      {(
        [
          { id: "2d", label: "2D Draft", icon: Grid3X3 },
          { id: "3d", label: "3D View", icon: Box },
        ] as const
      ).map((view) => {
        const Icon = view.icon;
        const active = activeView === view.id;
        return (
          <button
            key={view.id}
            type="button"
            onClick={() => setActiveView(view.id)}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] font-medium transition",
              active
                ? "bg-accent/15 text-accent shadow-[inset_0_0_0_1px_rgba(56,189,248,0.18)]"
                : "text-slate-400 hover:text-slate-200",
            )}
            aria-pressed={active}
          >
            <Icon className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{view.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function TopBar({
  notify,
  onOpenBlueprint,
}: {
  notify: Notify;
  onOpenBlueprint: () => void;
}) {
  const walls = useFloorPlanStore((state) => state.walls);
  const openings = useFloorPlanStore((state) => state.openings);
  const furniture = useFloorPlanStore((state) => state.furniture);
  const sceneName = useFloorPlanStore((state) => state.sceneName);
  const loadScene = useFloorPlanStore((state) => state.loadScene);
  const resetScene = useFloorPlanStore((state) => state.resetScene);
  const [busy, setBusy] = useState<"import" | "export" | null>(null);

  const handleNew = () => {
    resetScene();
    notify("Started a fresh floor plan", "success");
  };

  const handleImport = async () => {
    setBusy("import");
    try {
      const scene = await openSceneFile();
      if (!scene) return;
      loadScene(scene);
      notify(`Imported ${scene.name ?? "floor plan"}`, "success");
    } catch (error) {
      notify(
        error instanceof Error ? error.message : "Could not import that file",
        "error",
      );
    } finally {
      setBusy(null);
    }
  };

  const handleExport = async () => {
    setBusy("export");
    try {
      const slug =
        sceneName
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "") || "floorplan";
      const path = await saveSceneFile(
        buildSceneFile(walls, openings, sceneName, furniture),
        `${slug}.json`,
      );
      if (path) notify(`Exported to ${path}`, "success");
    } catch (error) {
      notify(
        error instanceof Error ? error.message : "Could not export the scene",
        "error",
      );
    } finally {
      setBusy(null);
    }
  };

  const fileActions = [
    {
      id: "new",
      label: "New",
      icon: Plus,
      onClick: handleNew,
      busy: false,
    },
    {
      id: "import",
      label: "Import",
      icon: Upload,
      onClick: handleImport,
      busy: busy === "import",
    },
    {
      id: "export",
      label: "Export",
      icon: Download,
      onClick: handleExport,
      busy: busy === "export",
    },
  ];

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-panel/80 px-4">
      <div className="flex items-center gap-2.5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-accent/25 bg-gradient-to-br from-accent/25 to-cyan-500/5 shadow-[0_0_18px_rgba(56,189,248,0.12)]">
          <Frame className="h-4 w-4 text-accent" />
        </div>
        <div className="leading-tight">
          <h1 className="text-[13px] font-semibold tracking-tight text-slate-100">
            FloorPlan Studio
          </h1>
          <p className="max-w-[200px] truncate text-[10px] text-slate-500">
            {sceneName}
          </p>
        </div>
      </div>

      <div className="mx-1 hidden h-6 w-px bg-line sm:block" />

      <div className="flex items-center gap-1">
        {fileActions.map((action) => {
          const Icon = action.busy ? Loader2 : action.icon;
          return (
            <button
              key={action.id}
              type="button"
              onClick={action.onClick}
              disabled={busy !== null}
              className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[11px] font-medium text-slate-400 transition hover:bg-white/[0.05] hover:text-slate-200 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Icon
                className={cn("h-3.5 w-3.5", action.busy && "animate-spin")}
              />
              <span className="hidden md:inline">{action.label}</span>
            </button>
          );
        })}
        <button
          type="button"
          onClick={onOpenBlueprint}
          className="flex items-center gap-1.5 rounded-lg border border-line px-2 py-1.5 text-[11px] font-medium text-slate-300 transition hover:border-accent/30 hover:bg-accent/10 hover:text-accent"
          aria-label="Import Blueprint (PNG/JPG)"
          title="Import Blueprint (PNG/JPG)"
        >
          <ImagePlus className="h-3.5 w-3.5" />
          <span className="hidden md:inline">Import Blueprint</span>
        </button>
      </div>

      <div className="ml-auto flex items-center gap-3">
        <span className="hidden items-center gap-1.5 rounded-full border border-line bg-black/20 px-2.5 py-1 text-[10px] text-slate-500 lg:flex">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
          {walls.length} walls · {openings.length} openings
        </span>
        <ViewSwitcher />
      </div>
    </header>
  );
}

function Toast({ toast }: { toast: ToastState }) {
  if (!toast) return null;

  const toneStyles: Record<ToastTone, string> = {
    info: "border-accent/25 text-slate-200",
    success: "border-emerald-500/25 text-emerald-200",
    error: "border-rose-500/25 text-rose-200",
  };

  const Icon =
    toast.tone === "success"
      ? CheckCircle2
      : toast.tone === "error"
        ? AlertTriangle
        : Info;

  return (
    <div className="pointer-events-none absolute bottom-5 left-1/2 z-30 -translate-x-1/2">
      <div
        className={cn(
          "flex max-w-[min(560px,calc(100vw-2rem))] items-center gap-2.5 rounded-xl border bg-panel/95 px-3.5 py-2.5 text-[11px] shadow-2xl shadow-black/50 backdrop-blur-xl",
          toneStyles[toast.tone],
        )}
      >
        <Icon className="h-4 w-4 shrink-0" />
        <span className="break-all">{toast.message}</span>
      </div>
    </div>
  );
}

export function AppShell() {
  const activeView = useFloorPlanStore((state) => state.activeView);
  const setActiveTool = useFloorPlanStore((state) => state.setActiveTool);
  const setActiveView = useFloorPlanStore((state) => state.setActiveView);
  const toggleCompliance = useFloorPlanStore((state) => state.toggleCompliance);
  const toggleAi = useFloorPlanStore((state) => state.toggleAi);
  const [toast, setToast] = useState<ToastState>(null);
  const [importerOpen, setImporterOpen] = useState(false);

  const notify = useCallback<Notify>((message, tone = "info") => {
    setToast({ id: Date.now(), message, tone });
  }, []);

  const openImporter = useCallback(() => setImporterOpen(true), []);
  const closeImporter = useCallback(() => setImporterOpen(false), []);
  const handleImported = useCallback(
    (
      wallCount: number,
      openingCount: number,
      name: string,
      info?: { source: "onnx" | "heuristic"; fallbackReason?: string },
    ) => {
      const openingLabel =
        openingCount > 0
          ? ` and ${openingCount} opening${openingCount === 1 ? "" : "s"}`
          : "";
      const engineLabel =
        info?.source === "onnx" ? " with local ONNX vision" : "";
      const fallbackLabel =
        info?.source === "heuristic" && info.fallbackReason
          ? ` (${info.fallbackReason})`
          : "";
      notify(
        `Imported ${wallCount} walls${openingLabel} from ${name}${engineLabel}${fallbackLabel}`,
        info?.source === "heuristic" && info.fallbackReason
          ? "info"
          : "success",
      );
    },
    [notify],
  );

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 3400);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }

      switch (event.key.toLowerCase()) {
        case "v":
          setActiveTool("select");
          break;
        case "w":
          setActiveTool("wall");
          break;
        case "d":
          setActiveTool("door");
          break;
        case "n":
          setActiveTool("window");
          break;
        case "r":
          toggleCompliance();
          break;
        case "a":
          toggleAi();
          break;
        case "b":
          openImporter();
          break;
        case "1":
          setActiveView("2d");
          break;
        case "2":
          setActiveView("3d");
          break;
        default:
          break;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    setActiveTool,
    setActiveView,
    toggleCompliance,
    toggleAi,
    openImporter,
  ]);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-shell text-slate-200">
      <TopBar notify={notify} onOpenBlueprint={openImporter} />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="relative min-h-0 min-w-0 flex-1 bg-[#0a0d12]">
          {activeView === "2d" ? <Canvas2D /> : <Canvas3D />}
          <CompliancePanel />
          <LocalAiAssistant />
          <Toast toast={toast} />
        </main>
      </div>
      <ImageImporter
        open={importerOpen}
        onClose={closeImporter}
        onImported={handleImported}
      />
    </div>
  );
}
