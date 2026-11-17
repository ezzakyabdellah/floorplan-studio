import { useState } from "react";
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
