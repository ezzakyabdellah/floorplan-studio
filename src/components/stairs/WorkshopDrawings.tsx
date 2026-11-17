import { useMemo, useState } from "react";
import { Download, FileText, LoaderCircle, RefreshCw, Sparkles } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import {
  buildShopSheetPdf,
  createShopSheetDocument,
  defaultWorkshopNotes,
  renderShopSheetSvg,
  type WorkshopNotes,
} from "../../engineering/shopSheet";
import { saveShopSheet } from "../../engineering/shopSheetExport";
import { generateWorkshopNotes } from "../../engineering/workshopNotes";
import { useProjectStore } from "../../engineering/projectStore";
import {
  calculateBalusterSpacing,
  calculateRailingRun,
} from "../../engineering/railingCalculations";
import { formatLength } from "../../engineering/units";
import type { OllamaStatus } from "../../services/localAiService";
import type { ProjectState } from "../../engineering/types";
import { cn } from "../../utils/cn";

type Props = {
  status: OllamaStatus | null;
  model: string;
};

type SavedNotes = {
  signature: string;
  notes: WorkshopNotes;
  source: "local-model" | "deterministic";
};

function currentProject(): ProjectState {
  const {
    projectType,
    units,
    stairParams,
    ladderParams,
    calculatedMetrics,
  } = useProjectStore.getState();
  return {
    projectType,
    units,
    stairParams,
    ladderParams,
    calculatedMetrics,
  };
}

function projectSignature(project: ProjectState) {
  return JSON.stringify(project);
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : "The shop sheet export failed.";
}

function BalusterSpacingCalculator({ project }: { project: ProjectState }) {
  const updateDesignParameters = useProjectStore(
    (state) => state.updateDesignParameters,
  );
  const units = project.units;
  const unitLabel = units === "imperial" ? "in" : "mm";
  const calculatedRun = calculateRailingRun(project.stairParams, units);
  const railRun = project.stairParams.railingRunOverride ?? calculatedRun;
  const calculation = useMemo(() => {
    try {
      return {
        layout: calculateBalusterSpacing(
          railRun,
          project.stairParams.balusterSpacingMax,
          project.stairParams.balusterThickness,
          units,
        ),
        error: null,
      };
    } catch (error) {
      return {
        layout: null,
        error: formatError(error),
      };
    }
  }, [
    railRun,
    project.stairParams.balusterSpacingMax,
    project.stairParams.balusterThickness,
    units,
  ]);
  const layout = calculation.layout;
  const diagramWidth = 352;
  const startX = 24;
  const pixelsPerUnit = diagramWidth / railRun;
  const balusterWidthPx = Math.max(
    1,
    project.stairParams.balusterThickness * pixelsPerUnit,
  );
  const gapPx = layout ? layout.clearGapExact * pixelsPerUnit : 0;
  const visibleCount = Math.min(layout?.balusterCount ?? 0, 72);
  const balusters = Array.from({ length: visibleCount }, (_, index) => {
    const actualIndex =
      visibleCount <= 1
        ? 0
        : Math.round((index * (layout!.balusterCount - 1)) / (visibleCount - 1));
    return {
      index,
      x: startX + gapPx + actualIndex * (gapPx + balusterWidthPx),
    };
  });
  const endX = startX + diagramWidth;

  const updateLength = (value: number | null) => {
    updateDesignParameters({
      stairParams: { railingRunOverride: value },
    });
  };
  const updateGap = (value: number) => {
    updateDesignParameters({
      stairParams: { balusterSpacingMax: value },
    });
  };
  const updateBalusterWidth = (value: number) => {
    updateDesignParameters({
      stairParams: { balusterThickness: value },
    });
  };

  return (
    <section className="rounded-xl border border-line bg-panel/70 p-3.5">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-[11px] font-semibold text-slate-100">
            Baluster &amp; Railing Spacing Calculator
          </h3>
          <p className="mt-0.5 text-[9px] text-slate-500">
            Live calculator and spacing illustration
          </p>
        </div>
        {project.stairParams.railingRunOverride !== null ? (
          <button
            type="button"
            onClick={() => updateLength(null)}
            className="text-[9px] text-accent hover:underline"
          >
            Use flight length
          </button>
        ) : null}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <label className="block">
          <span className="mb-1 flex items-center justify-between text-[9px] uppercase tracking-[0.1em] text-slate-500">
            Rail run <span className="normal-case tracking-normal">{unitLabel}</span>
          </span>
          <input
            type="number"
            min={units === "imperial" ? 0.0625 : 1}
            max={units === "imperial" ? 100_000 : 2_540_000}
            step={units === "imperial" ? 0.0625 : 1}
            value={railRun}
            onChange={(event) => {
              const value = event.currentTarget.valueAsNumber;
              if (Number.isFinite(value) && value > 0) updateLength(value);
            }}
            aria-label="Railing run length"
            className="w-full rounded-lg border border-line bg-black/25 px-2 py-1.5 font-mono text-[10px] text-slate-100 outline-none focus:border-accent/50"
          />
        </label>
        <label className="block">
          <span className="mb-1 flex items-center justify-between text-[9px] uppercase tracking-[0.1em] text-slate-500">
            Max clear gap <span className="normal-case tracking-normal">{unitLabel}</span>
          </span>
          <input
            type="number"
            min={units === "imperial" ? 0.0625 : 1}
            step={units === "imperial" ? 0.0625 : 1}
            value={project.stairParams.balusterSpacingMax}
            onChange={(event) => {
              const value = event.currentTarget.valueAsNumber;
              if (Number.isFinite(value) && value > 0) updateGap(value);
            }}
            aria-label="Maximum baluster clear gap"
            className="w-full rounded-lg border border-line bg-black/25 px-2 py-1.5 font-mono text-[10px] text-slate-100 outline-none focus:border-accent/50"
          />
        </label>
        <label className="block">
          <span className="mb-1 flex items-center justify-between text-[9px] uppercase tracking-[0.1em] text-slate-500">
            Baluster width <span className="normal-case tracking-normal">{unitLabel}</span>
          </span>
          <input
            type="number"
            min={units === "imperial" ? 0.0625 : 1}
            step={units === "imperial" ? 0.0625 : 1}
            value={project.stairParams.balusterThickness}
            onChange={(event) => {
              const value = event.currentTarget.valueAsNumber;
              if (Number.isFinite(value) && value > 0) updateBalusterWidth(value);
            }}
            aria-label="Baluster width"
            className="w-full rounded-lg border border-line bg-black/25 px-2 py-1.5 font-mono text-[10px] text-slate-100 outline-none focus:border-accent/50"
          />
        </label>
        <div className="flex items-end justify-between rounded-lg border border-line/70 bg-black/20 px-2 py-1.5">
          <span className="text-[9px] uppercase tracking-[0.1em] text-slate-500">
            Balusters
          </span>
          <span className="font-mono text-sm font-semibold text-slate-100">
            {layout?.balusterCount ?? "—"}
          </span>
        </div>
      </div>

      {layout ? (
        <>
          <div className="mt-2 rounded-lg border border-line/70 bg-[#f8fafc] p-2">
            <svg
              viewBox="0 0 400 104"
              className="block h-auto w-full"
              role="img"
              aria-label={`${layout.balusterCount} evenly distributed balusters; ${formatLength(layout.clearGap, units)} clear gaps`}
            >
              <line x1={startX} y1="28" x2={endX} y2="28" stroke="#17212b" strokeWidth="4" />
              <line x1={startX} y1="68" x2={endX} y2="68" stroke="#17212b" strokeWidth="3" />
              <rect x={startX - 3} y="24" width="6" height="48" fill="#17212b" />
              <rect x={endX - 3} y="24" width="6" height="48" fill="#17212b" />
              {balusters.map((baluster) => (
                <rect
                  key={baluster.index}
                  x={baluster.x}
                  y="30"
                  width={balusterWidthPx}
                  height="36"
                  fill="#0e7490"
                />
              ))}
              <line x1={startX} y1="87" x2={endX} y2="87" stroke="#0e7490" strokeWidth="1" />
              <line x1={startX} y1="83" x2={startX} y2="91" stroke="#0e7490" strokeWidth="1" />
              <line x1={endX} y1="83" x2={endX} y2="91" stroke="#0e7490" strokeWidth="1" />
              <text x="200" y="101" fill="#0e7490" fontSize="9" textAnchor="middle">
                {formatLength(railRun, units)} rail · {formatLength(layout.clearGap, units)} equal clear gaps
              </text>
            </svg>
          </div>
          <p className="mt-2 text-[9px] leading-relaxed text-slate-500">
            Calculated clear gap: {formatLength(layout.clearGap, units)} · effective maximum: {formatLength(layout.maxAllowedGap, units)}
            {project.stairParams.balusterSpacingMax > layout.maxAllowedGap
              ? " (safety cap applied)"
              : ""}
          </p>
        </>
      ) : (
        <p className="mt-2 text-[9px] text-rose-300">{calculation.error}</p>
      )}
      <p className="mt-1 text-[8px] leading-relaxed text-slate-600">
        IRC R312.1.3 guard-opening sphere rule; confirm the adopted edition and stair-side exception locally.
      </p>
    </section>
  );
}

export function WorkshopDrawings({ status, model }: Props) {
  const project = useProjectStore(
    useShallow((state) => ({
      projectType: state.projectType,
      units: state.units,
      stairParams: state.stairParams,
      ladderParams: state.ladderParams,
      calculatedMetrics: state.calculatedMetrics,
    })),
  );
  const signature = projectSignature(project);
  const [savedNotes, setSavedNotes] = useState<SavedNotes | null>(null);
  const [working, setWorking] = useState<"notes" | "svg" | "pdf" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const notes =
    savedNotes?.signature === signature
      ? savedNotes.notes
      : defaultWorkshopNotes(project);
  const notesSource =
    savedNotes?.signature === signature
      ? savedNotes.source === "local-model"
        ? `AI notes · ${model}`
        : "Deterministic offline notes"
      : "Parameters changed · refreshed offline notes";

  const generateNotes = async () => {
    const snapshot = currentProject();
    const snapshotSignature = projectSignature(snapshot);
    setWorking("notes");
    setError(null);
    setMessage(null);
    try {
      if (!status?.online) {
        setSavedNotes({
          signature: snapshotSignature,
          notes: defaultWorkshopNotes(snapshot),
          source: "deterministic",
        });
        setMessage(
          "Ollama is offline; deterministic project-specific assembly and cutting notes are ready.",
        );
        return;
      }
      try {
        const notes = await generateWorkshopNotes(snapshot, { model });
        if (
          projectSignature(currentProject()) !== snapshotSignature
        ) {
          setError("Design changed while notes were being generated. Generate them again for the current dimensions.");
          return;
        }
        setSavedNotes({ signature: snapshotSignature, notes, source: "local-model" });
        setMessage("Local AI generated notes from the verified project parameters and metrics.");
      } catch (modelError) {
        setSavedNotes({
          signature: snapshotSignature,
          notes: defaultWorkshopNotes(snapshot),
          source: "deterministic",
        });
        setMessage(
          `Local AI notes were unavailable; deterministic notes were used instead. ${formatError(modelError)}`,
        );
      }
    } finally {
      setWorking(null);
    }
  };

  const exportSheet = async (format: "svg" | "pdf") => {
    setWorking(format);
    setError(null);
    setMessage(null);
    try {
      const snapshot = currentProject();
      const drawing = createShopSheetDocument(snapshot, notes);
      const data =
        format === "svg"
          ? renderShopSheetSvg(drawing)
          : buildShopSheetPdf(drawing);
      const path = await saveShopSheet(format, data);
      if (path) setMessage(`Shop sheet exported to ${path}.`);
    } catch (exportError) {
      setError(formatError(exportError));
    } finally {
      setWorking(null);
    }
  };

  const drawing = createShopSheetDocument(project, notes);
  const svg = renderShopSheetSvg(drawing);
  const busy = working !== null;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4 lg:p-6">
      <div className="mx-auto max-w-[1480px] space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-100">
              2D shop sheet
            </h2>
            <p className="mt-1 text-[11px] text-slate-500">
              Live orthographic projections from the unified project state.
              Drawing scale is schematic; labeled dimensions are calculated.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void generateNotes()}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-lg border border-violet-400/25 bg-violet-500/10 px-2.5 py-2 text-[10px] font-medium text-violet-200 transition hover:bg-violet-500/20 disabled:opacity-40"
            >
              {working === "notes" ? (
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles className="h-3.5 w-3.5" />
              )}
              Generate notes
            </button>
            <button
              type="button"
              onClick={() => void exportSheet("svg")}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-lg border border-line bg-panel px-2.5 py-2 text-[10px] text-slate-300 transition hover:border-accent/30 hover:text-accent disabled:opacity-40"
            >
              {working === "svg" ? (
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              Export SVG
            </button>
            <button
              type="button"
              onClick={() => void exportSheet("pdf")}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-lg border border-line bg-panel px-2.5 py-2 text-[10px] text-slate-300 transition hover:border-accent/30 hover:text-accent disabled:opacity-40"
            >
              {working === "pdf" ? (
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <FileText className="h-3.5 w-3.5" />
              )}
              Export PDF
            </button>
          </div>
        </div>

        <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_300px]">
          <div className="min-w-0 overflow-auto rounded-xl border border-line bg-[#e2e8f0] p-2">
            <div
              className={cn(
                "mx-auto min-w-[920px] max-w-[1400px] overflow-hidden bg-white shadow-xl",
                "[&_svg]:block [&_svg]:h-auto [&_svg]:w-full",
              )}
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          </div>

          <aside className="space-y-3">
            <BalusterSpacingCalculator project={project} />
            <section className="rounded-xl border border-line bg-panel/70 p-3.5">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h3 className="text-[11px] font-semibold text-slate-100">
                    Assembly notes
                  </h3>
                  <p className="mt-0.5 text-[9px] text-slate-500">
                    {notesSource}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void generateNotes()}
                  disabled={busy}
                  aria-label="Refresh assembly notes"
                  title="Refresh notes for current dimensions"
                  className="rounded-lg border border-line p-1.5 text-slate-400 hover:text-accent disabled:opacity-40"
                >
                  <RefreshCw className={cn("h-3.5 w-3.5", working === "notes" && "animate-spin")} />
                </button>
              </div>
              <ol className="mt-3 list-decimal space-y-2 pl-4 text-[10px] leading-relaxed text-slate-300">
                {notes.assemblyNotes.map((note, index) => (
                  <li key={`assembly-${index}`}>{note}</li>
                ))}
              </ol>
            </section>

            <section className="rounded-xl border border-line bg-panel/70 p-3.5">
              <h3 className="text-[11px] font-semibold text-slate-100">
                Cutting sequence
              </h3>
              <ol className="mt-3 list-decimal space-y-2 pl-4 text-[10px] leading-relaxed text-slate-300">
                {notes.cuttingInstructions.map((note, index) => (
                  <li key={`cut-${index}`}>{note}</li>
                ))}
              </ol>
            </section>

            <p className="rounded-xl border border-amber-500/15 bg-amber-500/[0.04] p-3 text-[9px] leading-relaxed text-amber-100/70">
              Notes and drawings are workshop aids, not stamped construction
              documents. Verify all field measurements, structural design,
              adopted codes, and manufacturer requirements before building.
            </p>
            {message ? (
              <p className="rounded-lg border border-emerald-500/20 bg-emerald-500/[0.05] p-2.5 text-[10px] leading-relaxed text-emerald-200">
                {message}
              </p>
            ) : null}
            {error ? (
              <p className="rounded-lg border border-rose-500/20 bg-rose-500/[0.05] p-2.5 text-[10px] leading-relaxed text-rose-200">
                {error}
              </p>
            ) : null}
          </aside>
        </div>
      </div>
    </div>
  );
}
