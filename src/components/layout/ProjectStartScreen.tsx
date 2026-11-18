import { useState } from "react";
import {
  ArrowLeft,
  ChevronRight,
  FileText,
  FolderOpen,
  Frame,
  Loader2,
  PanelsTopLeft,
  Plus,
  Ruler,
} from "lucide-react";
import {
  readProjectLibrary,
  type LocalProject,
} from "../../engineering/projectLibrary";
import { cn } from "../../utils/cn";

type StartScreenProps = {
  onCreateFloorPlan: () => void;
  onCreateStairProject: () => void;
  onOpenFloorPlan: () => Promise<void>;
  onOpenStairProject: (project: LocalProject) => Promise<void>;
};

type StartChoice = "home" | "create" | "open";

function ChoiceCard({
  icon: Icon,
  title,
  detail,
  onClick,
  disabled,
}: {
  icon: typeof PanelsTopLeft;
  title: string;
  detail: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="group flex min-h-36 w-full items-start gap-4 rounded-2xl border border-line bg-panel/75 p-5 text-left transition hover:border-accent/35 hover:bg-panel-raised/90 disabled:cursor-wait disabled:opacity-60"
    >
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-accent/20 bg-accent/[0.08] text-accent transition group-hover:border-accent/40 group-hover:bg-accent/15">
        <Icon className="h-5 w-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-slate-100">{title}</span>
        <span className="mt-1.5 block text-[11px] leading-relaxed text-slate-500">
          {detail}
        </span>
      </span>
      <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-slate-600 transition group-hover:translate-x-0.5 group-hover:text-accent" />
    </button>
  );
}

export function ProjectStartScreen({
  onCreateFloorPlan,
  onCreateStairProject,
  onOpenFloorPlan,
  onOpenStairProject,
}: StartScreenProps) {
  const [choice, setChoice] = useState<StartChoice>("home");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stairProjects] = useState(() => readProjectLibrary().projects);

  const run = async (action: () => void | Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (actionError) {
      setError(
        actionError instanceof Error
          ? actionError.message
          : "Could not open that project.",
      );
    } finally {
      setBusy(false);
    }
  };

  const goBack = () => {
    setChoice("home");
    setError(null);
  };

  return (
    <main className="relative flex h-screen w-screen items-center justify-center overflow-auto bg-shell px-5 py-10 text-slate-200">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_50%_0%,rgba(56,189,248,0.11),transparent_48%)]" />
      <section className="relative w-full max-w-3xl">
        <header className="mb-10 flex items-center justify-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-accent/25 bg-accent/10 shadow-[0_0_28px_rgba(56,189,248,0.1)]">
            <Frame className="h-5 w-5 text-accent" />
          </div>
          <div>
            <h1 className="text-base font-semibold tracking-tight text-slate-100">
              FloorPlan Studio
            </h1>
            <p className="mt-0.5 text-[10px] uppercase tracking-[0.16em] text-slate-500">
              Design workspace
            </p>
          </div>
        </header>

        <div className="rounded-3xl border border-line bg-panel/60 p-6 shadow-2xl shadow-black/20 backdrop-blur-xl sm:p-9">
          {choice !== "home" ? (
            <button
              type="button"
              onClick={goBack}
              disabled={busy}
              className="mb-6 flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[11px] text-slate-500 transition hover:bg-white/[0.04] hover:text-slate-200 disabled:opacity-40"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Back
            </button>
          ) : null}

          <div className="mb-7 text-center">
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-accent/80">
              {choice === "home" ? "Welcome" : choice === "create" ? "New project" : "Open project"}
            </p>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-100 sm:text-3xl">
              {choice === "home"
                ? "What would you like to work on?"
                : choice === "create"
                  ? "Choose a project type"
                  : "What kind of project are you opening?"}
            </h2>
            <p className="mx-auto mt-2 max-w-lg text-xs leading-relaxed text-slate-500">
              {choice === "home"
                ? "Create a new design or continue with a project you already saved."
                : choice === "create"
                  ? "Start with a floor plan or an engineering project for stairs and ladders."
                  : "Floor plans open from a scene file. Stair projects are saved in your local project library."}
            </p>
          </div>

          {choice === "home" ? (
            <div className="mx-auto grid max-w-xl gap-3 sm:grid-cols-2">
              <ChoiceCard
                icon={Plus}
                title="Create new project"
                detail="Choose between a floor plan and a stair project."
                onClick={() => setChoice("create")}
              />
              <ChoiceCard
                icon={FolderOpen}
                title="Open project"
                detail="Open a floor plan file or continue a saved stair project."
                onClick={() => setChoice("open")}
              />
            </div>
          ) : choice === "create" ? (
            <div className="mx-auto grid max-w-xl gap-3 sm:grid-cols-2">
              <ChoiceCard
                icon={PanelsTopLeft}
                title="Floor plan"
                detail="Draw walls, place doors and windows, arrange furniture, and view the design in 2D or 3D."
                onClick={onCreateFloorPlan}
                disabled={busy}
              />
              <ChoiceCard
                icon={Ruler}
                title="Stair project"
                detail="Design and check a staircase or ladder with parametric tools and workshop drawings."
                onClick={onCreateStairProject}
                disabled={busy}
              />
            </div>
          ) : (
            <div className="mx-auto max-w-xl space-y-3">
              <ChoiceCard
                icon={FileText}
                title="Open a floor plan"
                detail="Choose a FloorPlan Studio scene file (.json) from your device."
                onClick={() => void run(onOpenFloorPlan)}
                disabled={busy}
              />
              <div className="rounded-2xl border border-line bg-black/15 p-4">
                <div className="flex items-start gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-accent/20 bg-accent/[0.08] text-accent">
                    <Ruler className="h-4.5 w-4.5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <h3 className="text-sm font-semibold text-slate-100">
                      Open a stair project
                    </h3>
                    <p className="mt-1 text-[10px] leading-relaxed text-slate-500">
                      Saved locally on this device.
                    </p>
                  </div>
                </div>
                {stairProjects.length ? (
                  <div className="mt-3 space-y-2">
                    {stairProjects.map((project) => (
                      <button
                        key={project.id}
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void run(() => onOpenStairProject(project))
                        }
                        className={cn(
                          "flex w-full items-center gap-3 rounded-xl border border-line/70 bg-panel/60 px-3 py-2.5 text-left transition hover:border-accent/30 hover:bg-panel-raised disabled:cursor-wait disabled:opacity-50",
                        )}
                      >
                        <FolderOpen className="h-4 w-4 shrink-0 text-accent/80" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[11px] font-medium text-slate-200">
                            {project.name}
                          </span>
                          <span className="mt-0.5 block text-[9px] capitalize text-slate-600">
                            {project.project.projectType} · Updated{" "}
                            {new Date(project.updatedAt).toLocaleDateString()}
                          </span>
                        </span>
                        {busy ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-500" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5 text-slate-600" />
                        )}
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="mt-3 rounded-lg border border-dashed border-line px-3 py-4 text-center text-[10px] text-slate-600">
                    No saved stair projects yet. Create a stair project and save it from the Workshop tab.
                  </p>
                )}
              </div>
            </div>
          )}

          {busy ? (
            <div className="mt-5 flex items-center justify-center gap-2 text-[10px] text-slate-500">
              <Loader2 className="h-3 w-3 animate-spin" />
              Opening project…
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="mx-auto mt-4 max-w-xl rounded-lg border border-rose-500/20 bg-rose-500/[0.07] px-3 py-2 text-[10px] text-rose-200">
              {error}
            </p>
          ) : null}
        </div>

        <p className="mt-5 text-center text-[9px] text-slate-700">
          Your projects stay on this device unless you export them.
        </p>
      </section>
    </main>
  );
}
