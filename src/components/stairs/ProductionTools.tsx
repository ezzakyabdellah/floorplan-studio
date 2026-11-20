import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  Archive,
  ClipboardCheck,
  Copy,
  Download,
  FileDown,
  FolderOpen,
  Layers3,
  Plus,
  Save,
  ShieldAlert,
  Sparkles,
  Trash2,
} from "lucide-react";
import {
  buildMaterialManifest,
  materialManifestCsv,
  type MaterialLine,
} from "../../engineering/billOfMaterials";
import {
  cutOptimizationCsv,
  optimizeCutList,
} from "../../engineering/cutOptimizer";
import { buildDxf, buildStl } from "../../engineering/cadExports";
import {
  estimateIllustrativeMaterialCost,
  requestCostSourcingAdvice,
  requestStructuralAdvice,
  type AdvisorResult,
} from "../../engineering/designAdvisors";
import {
  addProjectRevision,
  duplicateLocalProject,
  makeLocalProject,
  readProjectLibrary,
  writeProjectLibrary,
  type LocalProject,
  type ProjectLibrary,
} from "../../engineering/projectLibrary";
import {
  buildInspectionReportPdf,
  createInspectionChecklist,
  makeInspectionRecord,
  type InspectionItem,
  type InspectionRecord,
} from "../../engineering/safetyInspection";
import { saveEngineeringFile } from "../../engineering/fileExport";
import { createDefaultProjectState, useProjectStore } from "../../engineering/projectStore";
import { formatLength } from "../../engineering/units";
import type { ProjectState } from "../../engineering/types";
import type { OllamaStatus } from "../../services/localAiService";
import { cn } from "../../utils/cn";

type Props = {
  status: OllamaStatus | null;
  model: string;
};
type ToolTab = "materials" | "advisors" | "inspection" | "projects";

const controlClass =
  "rounded-lg border border-line bg-black/25 px-2.5 py-2 text-[10px] text-slate-200 outline-none focus:border-accent/50";
const buttonClass =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-line bg-black/20 px-2.5 py-2 text-[10px] font-medium text-slate-300 transition hover:border-accent/30 hover:text-accent disabled:cursor-wait disabled:opacity-50";

function PanelTitle({
  icon: Icon,
  title,
  detail,
}: {
  icon: typeof Layers3;
  title: string;
  detail: string;
}) {
  return (
    <div className="mb-3 flex items-start gap-2.5">
      <span className="mt-0.5 rounded-lg border border-accent/20 bg-accent/10 p-2 text-accent">
        <Icon className="h-4 w-4" />
      </span>
      <div>
        <h2 className="text-[13px] font-semibold text-slate-100">{title}</h2>
        <p className="mt-0.5 text-[10px] leading-relaxed text-slate-500">{detail}</p>
      </div>
    </div>
  );
}

function MaterialTable({
  lines,
  units,
  displayUnit,
}: {
  lines: MaterialLine[];
  units: ProjectState["units"];
  displayUnit: ProjectState["displayUnit"];
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-line/70">
      <table className="w-full min-w-[680px] border-collapse text-left text-[10px]">
        <thead className="bg-black/25 text-[9px] uppercase tracking-wider text-slate-500">
          <tr>
            <th className="px-3 py-2">Item</th>
            <th className="px-3 py-2">Material</th>
            <th className="px-3 py-2 text-right">Qty</th>
            <th className="px-3 py-2">Cut reference</th>
            <th className="px-3 py-2">Stock</th>
            <th className="px-3 py-2">Notes</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr key={line.id} className="border-t border-line/60 align-top">
              <td className="px-3 py-2 font-medium text-slate-200">{line.item}</td>
              <td className="px-3 py-2 text-slate-400">{line.material}</td>
              <td className="px-3 py-2 text-right font-mono text-slate-200">
                {line.quantity} {line.unit}
              </td>
              <td className="px-3 py-2 font-mono text-slate-300">
                {line.cutLength === null ? "—" : formatLength(line.cutLength, units, displayUnit)}
              </td>
              <td className="px-3 py-2 text-slate-400">{line.stockProfile ?? "—"}</td>
              <td className="max-w-xs px-3 py-2 leading-relaxed text-slate-500">
                {line.detail}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CutPlan({ project, lines }: { project: ProjectState; lines: MaterialLine[] }) {
  const result = useMemo(() => optimizeCutList(project, lines), [project, lines]);
  return (
    <section className="rounded-xl border border-line/70 bg-black/15 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-[11px] font-semibold text-slate-200">Stock cutting plan</h3>
          <p className="mt-1 text-[9px] text-slate-500">
            Best-fit decreasing · kerf {formatLength(result.kerf, project.units, project.displayUnit)} per cut
          </p>
        </div>
        <div className="text-right">
          <p className="font-mono text-[11px] text-slate-200">
            {result.totalWastePercent.toFixed(1)}% waste
          </p>
          <p className="text-[9px] text-slate-500">
            {formatLength(result.totalStock, project.units, project.displayUnit)} stock ·{" "}
            {formatLength(result.totalCut, project.units, project.displayUnit)} cut
          </p>
        </div>
      </div>
      <div className="mt-3 space-y-3">
        {result.groups.map((group) => (
          <div key={group.id}>
            <p className="mb-1 text-[9px] font-semibold uppercase tracking-wider text-slate-500">
              {group.stockProfile} · {group.material}
            </p>
            <div className="space-y-1.5">
              {group.patterns.map((pattern, index) => (
                <div key={`${group.id}-${index}`} className="flex items-center gap-2">
                  <span className="w-12 shrink-0 text-[9px] text-slate-500">
                    Stock {index + 1}
                  </span>
                  <div
                    className="flex h-5 min-w-0 flex-1 overflow-hidden rounded border border-line/70 bg-black/30"
                    aria-label={`Cut pattern ${index + 1}`}
                  >
                    {pattern.cuts.map((cut, cutIndex) => (
                      <div
                        key={`${cut.label}-${cutIndex}`}
                        title={`${cut.label}: ${formatLength(cut.length, project.units, project.displayUnit)}`}
                        className={cn(
                          "flex min-w-0 items-center justify-center overflow-hidden border-r border-black/30 px-0.5 text-[8px] text-slate-950",
                          ["bg-cyan-300", "bg-emerald-300", "bg-amber-300", "bg-violet-300"][cutIndex % 4],
                        )}
                        style={{ width: `${(cut.length / pattern.stockLength) * 100}%` }}
                      >
                        <span className="truncate">{cut.label.replace(/ \d+$/, "")}</span>
                      </div>
                    ))}
                    <div
                      className="h-full min-w-0 flex-1 bg-slate-700/80"
                      title={`Offcut and kerf: ${formatLength(pattern.offcut + pattern.kerfWaste, project.units, project.displayUnit)}`}
                    />
                  </div>
                  <span className="w-20 shrink-0 text-right font-mono text-[8px] text-slate-500">
                    {formatLength(pattern.stockLength, project.units, project.displayUnit)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
        {result.groups.length === 0 ? (
          <p className="text-[10px] text-slate-500">No stock-length cuts in this manifest.</p>
        ) : null}
      </div>
      <div className="mt-3 space-y-1 border-t border-line/60 pt-2">
        {result.assumptions.map((assumption) => (
          <p key={assumption} className="text-[9px] leading-relaxed text-slate-600">
            • {assumption}
          </p>
        ))}
      </div>
    </section>
  );
}

function AdviceCard({
  title,
  result,
  estimate,
}: {
  title: string;
  result: AdvisorResult | null;
  estimate?: string;
}) {
  return (
    <section className="rounded-xl border border-line/70 bg-black/15 p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold text-slate-200">{title}</h3>
        {result ? (
          <span className="rounded-full border border-line px-2 py-0.5 text-[8px] uppercase tracking-wider text-slate-500">
            {result.source === "local-model" ? "Local AI" : "Offline fallback"}
          </span>
        ) : null}
      </div>
      {estimate ? <p className="mt-2 font-mono text-[12px] text-accent">{estimate}</p> : null}
      {result ? (
        <ul className="mt-2 space-y-2">
          {result.advice.map((item, index) => (
            <li key={`${index}-${item}`} className="flex gap-2 text-[10px] leading-relaxed text-slate-300">
              <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-accent" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-[10px] text-slate-500">
          Run the advisor to get locally generated suggestions or deterministic offline guidance.
        </p>
      )}
      {result ? (
        <p className="mt-3 border-t border-line/60 pt-2 text-[9px] leading-relaxed text-amber-200/70">
          {result.disclaimer}
        </p>
      ) : null}
    </section>
  );
}

const INSPECTION_STORAGE_KEY = "floorplan-studio-safety-inspections-v1";

function readInspectionHistory(): InspectionRecord[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(INSPECTION_STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.slice(0, 50) as InspectionRecord[] : [];
  } catch {
    return [];
  }
}

function InspectionPanel({
  project,
  projectName,
}: {
  project: ProjectState;
  projectName: string;
}) {
  const [inspector, setInspector] = useState("");
  const [items, setItems] = useState(() => createInspectionChecklist(project));
  const [history, setHistory] = useState<InspectionRecord[]>(readInspectionHistory);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setItems(createInspectionChecklist(project));
  }, [project.projectType]);

  const updateItem = (id: string, patch: Partial<InspectionItem>) => {
    setItems((current) =>
      current.map((item) => item.id === id ? { ...item, ...patch } : item),
    );
  };

  const saveReport = async () => {
    setBusy(true);
    setError(null);
    setMessage("");
    try {
      const record = makeInspectionRecord({
        projectName,
        project,
        inspector,
        items,
      });
      const next = [record, ...history].slice(0, 50);
      localStorage.setItem(INSPECTION_STORAGE_KEY, JSON.stringify(next));
      setHistory(next);
      const path = await saveEngineeringFile(
        `inspection-${record.inspectedAt.slice(0, 10)}.pdf`,
        "pdf",
        buildInspectionReportPdf(record),
      );
      if (path) setMessage(`Saved ${record.overall} inspection report: ${path}`);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save the inspection report.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3">
      <PanelTitle
        icon={ClipboardCheck}
        title="Pre-use safety inspection"
        detail="Timestamped local checklist with a printable PDF record. Checklist aid only; follow the applicable OSHA standard and site procedure."
      />
      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
        <label className="text-[9px] text-slate-500">
          Project
          <input readOnly value={projectName} className={`${controlClass} mt-1 w-full`} />
        </label>
        <label className="text-[9px] text-slate-500">
          Inspector
          <input value={inspector} onChange={(event) => setInspector(event.currentTarget.value)} placeholder="Name" className={`${controlClass} mt-1 w-full`} />
        </label>
        <button type="button" onClick={() => void saveReport()} disabled={busy} className={`${buttonClass} self-end border-accent/25 bg-accent/10 text-accent`}>
          <FileDown className="h-3.5 w-3.5" />
          {busy ? "Saving…" : "Save & export PDF"}
        </button>
      </div>
      <div className="space-y-2">
        {items.map((item) => (
          <div key={item.id} className="grid gap-2 rounded-lg border border-line/70 bg-black/15 p-2.5 sm:grid-cols-[minmax(0,1fr)_120px]">
            <div>
              <p className="text-[10px] leading-relaxed text-slate-200">{item.label}</p>
              <p className="mt-1 text-[8px] text-slate-600">{item.citation}</p>
              <input
                value={item.note}
                onChange={(event) => updateItem(item.id, { note: event.currentTarget.value })}
                placeholder="Inspector note (optional)"
                className="mt-1.5 w-full border-b border-line/70 bg-transparent px-1 py-1 text-[9px] text-slate-300 outline-none placeholder:text-slate-700 focus:border-accent/50"
              />
            </div>
            <select
              value={item.answer}
              onChange={(event) => updateItem(item.id, { answer: event.currentTarget.value as InspectionItem["answer"] })}
              aria-label={`Inspection result: ${item.label}`}
              className={controlClass}
            >
              <option value="unchecked">Not checked</option>
              <option value="pass">Pass</option>
              <option value="fail">Fail</option>
              <option value="na">Not applicable</option>
            </select>
          </div>
        ))}
      </div>
      {error ? <p className="text-[10px] text-rose-300">{error}</p> : null}
      {message ? <p className="text-[10px] text-emerald-300">{message}</p> : null}
      <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.04] p-2.5 text-[9px] leading-relaxed text-amber-100/70">
        A failed item is not a pass. Remove unsafe equipment from service or restrict access and refer defects to a qualified person. "Not applicable" should be used only when justified and documented.
      </div>
      <div className="rounded-xl border border-line/70 p-3">
        <h3 className="text-[10px] font-semibold text-slate-300">Recent local records</h3>
        {history.length ? (
          <ul className="mt-2 space-y-1.5">
            {history.slice(0, 5).map((record) => (
              <li key={record.id} className="flex flex-wrap justify-between gap-2 text-[9px]">
                <span className="text-slate-400">{record.projectName} · {new Date(record.inspectedAt).toLocaleString()}</span>
                <span className={record.overall === "pass" ? "text-emerald-300" : record.overall === "fail" ? "text-rose-300" : "text-amber-300"}>{record.overall}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-[9px] text-slate-600">No inspection reports saved on this device.</p>
        )}
      </div>
    </section>
  );
}

function ProjectLibraryPanel({
  project,
  onProjectName,
}: {
  project: ProjectState;
  onProjectName: (name: string) => void;
}) {
  const [library, setLibrary] = useState<ProjectLibrary>(readProjectLibrary);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [projectName, setProjectName] = useState("Untitled project");
  const [revisionLabel, setRevisionLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const loadProject = useProjectStore((state) => state.loadProjectState);
  const activeProject = library.projects.find((item) => item.id === activeId) ?? null;
  const dirty = activeProject
    ? JSON.stringify(activeProject.project) !== JSON.stringify(project)
    : false;

  const commit = (next: ProjectLibrary) => {
    try {
      writeProjectLibrary(next);
      setLibrary(next);
      setError(null);
      return true;
    } catch (writeError) {
      setError(writeError instanceof Error ? writeError.message : "Could not write local project library.");
      return false;
    }
  };

  const loadState = (state: ProjectState, name: string, id: string | null) => {
    const result = loadProject(state);
    if (!result.applied) {
      setError(result.error ?? "Could not load saved design.");
      return;
    }
    setActiveId(id);
    setProjectName(name);
    onProjectName(name);
    setMessage(`Loaded “${name}”.`);
    setError(null);
  };

  const saveAsNew = () => {
    const saved = makeLocalProject(projectName, project);
    if (commit({ version: 1, projects: [saved, ...library.projects] })) {
      setActiveId(saved.id);
      setProjectName(saved.name);
      onProjectName(saved.name);
      setMessage(`Saved “${saved.name}” to this device.`);
    }
  };

  const saveRevision = () => {
    if (!activeProject) return;
    const updated = addProjectRevision(activeProject, revisionLabel, project);
    const next = {
      version: 1 as const,
      projects: library.projects.map((item) => item.id === updated.id ? updated : item),
    };
    if (commit(next)) {
      setRevisionLabel("");
      setMessage(`Saved revision ${updated.revisions.length} for “${updated.name}”.`);
    }
  };

  const duplicate = (item: LocalProject) => {
    const copy = duplicateLocalProject(item);
    if (commit({ version: 1, projects: [copy, ...library.projects] })) {
      loadState(copy.project, copy.name, copy.id);
    }
  };

  const remove = (item: LocalProject) => {
    if (!globalThis.confirm(`Delete “${item.name}” and its local revisions?`)) return;
    const next = { version: 1 as const, projects: library.projects.filter((entry) => entry.id !== item.id) };
    if (commit(next)) {
      if (activeId === item.id) {
        setActiveId(null);
        setProjectName("Untitled project");
        onProjectName("Untitled project");
      }
      setMessage(`Deleted “${item.name}” from this device.`);
    }
  };

  const startNew = () => {
    loadProject(createDefaultProjectState(project.units, project.displayUnit));
    setActiveId(null);
    setProjectName("Untitled project");
    onProjectName("Untitled project");
    setMessage("Started a fresh default design. Save it to add it to the local library.");
  };

  return (
    <section className="space-y-3">
      <PanelTitle
        icon={Archive}
        title="Local project library"
        detail="Projects and revision snapshots remain in this app's local browser storage. Nothing is uploaded."
      />
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
        <input
          value={projectName}
          onChange={(event) => setProjectName(event.currentTarget.value)}
          aria-label="Project name"
          className={controlClass}
          placeholder="Project name"
        />
        <button type="button" onClick={saveAsNew} className={`${buttonClass} border-accent/25 bg-accent/10 text-accent`}>
          <Save className="h-3.5 w-3.5" />
          Save as new
        </button>
        <button type="button" onClick={startNew} className={buttonClass}>
          <Plus className="h-3.5 w-3.5" />
          New design
        </button>
      </div>
      {activeProject ? (
        <div className="rounded-xl border border-accent/20 bg-accent/[0.04] p-3">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[10px] font-semibold text-slate-200">
              Active saved project: {activeProject.name}
            </p>
            <span className={cn(
              "rounded-full border px-2 py-0.5 text-[8px] uppercase tracking-wider",
              dirty ? "border-amber-500/20 text-amber-300" : "border-emerald-500/20 text-emerald-300",
            )}>
              {dirty ? "Unsaved changes" : "Up to date"}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <input
              value={revisionLabel}
              onChange={(event) => setRevisionLabel(event.currentTarget.value)}
              placeholder={`Revision ${activeProject.revisions.length + 1} note`}
              className={`${controlClass} min-w-[180px] flex-1`}
            />
            <button type="button" onClick={saveRevision} className={buttonClass}>
              <Save className="h-3.5 w-3.5" />
              Save current revision
            </button>
          </div>
          {activeProject.revisions.length ? (
            <div className="mt-3 space-y-1 border-t border-line/70 pt-2">
              {activeProject.revisions.slice().reverse().map((revision) => (
                <div key={revision.id} className="flex flex-wrap items-center justify-between gap-2 text-[9px]">
                  <span className="text-slate-400">
                    {revision.label} · {new Date(revision.savedAt).toLocaleString()}
                  </span>
                  <button type="button" onClick={() => loadState(revision.project, activeProject.name, activeProject.id)} className="rounded px-2 py-1 text-accent hover:bg-accent/10">
                    Load
                  </button>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <p className="rounded-lg border border-line/70 bg-black/15 p-2.5 text-[9px] text-slate-500">
          Current design is not yet attached to a saved library project.
        </p>
      )}
      <div className="space-y-2">
        {library.projects.map((item) => (
          <div key={item.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-line/70 bg-black/15 p-2.5">
            <FolderOpen className="h-3.5 w-3.5 text-accent" />
            <div className="min-w-[120px] flex-1">
              <p className="text-[10px] font-medium text-slate-200">{item.name}</p>
              <p className="text-[8px] text-slate-600">
                {item.project.projectType} · Updated {new Date(item.updatedAt).toLocaleDateString()} · {item.revisions.length} revisions
              </p>
            </div>
            <button type="button" onClick={() => loadState(item.project, item.name, item.id)} className={buttonClass}>
              <FolderOpen className="h-3 w-3" />
              Load
            </button>
            <button type="button" onClick={() => duplicate(item)} className={buttonClass} aria-label={`Duplicate ${item.name}`}>
              <Copy className="h-3 w-3" />
            </button>
            <button type="button" onClick={() => remove(item)} className="rounded-lg border border-rose-500/15 p-2 text-rose-300/70 hover:bg-rose-500/10 hover:text-rose-300" aria-label={`Delete ${item.name}`}>
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        ))}
        {!library.projects.length ? (
          <p className="py-5 text-center text-[10px] text-slate-600">No saved local projects yet.</p>
        ) : null}
      </div>
      {error ? <p className="text-[10px] text-rose-300">{error}</p> : null}
      {message ? <p className="text-[10px] text-emerald-300">{message}</p> : null}
      <p className="flex items-start gap-1.5 text-[9px] leading-relaxed text-slate-600">
        <ShieldAlert className="mt-0.5 h-3 w-3 shrink-0" />
        Browser/app storage may be cleared by device maintenance. Keep separate backups for important projects.
      </p>
    </section>
  );
}

export function ProductionTools({ status, model }: Props) {
  const [tab, setTab] = useState<ToolTab>("materials");
  const [projectName, setProjectName] = useState("Current design");
  const [exportBusy, setExportBusy] = useState(false);
  const [advisorBusy, setAdvisorBusy] = useState<"structural" | "cost" | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [structural, setStructural] = useState<AdvisorResult | null>(null);
  const [costAdvice, setCostAdvice] = useState<AdvisorResult | null>(null);
  const selected = useProjectStore(useShallow((state) => ({
    projectType: state.projectType,
    units: state.units,
    displayUnit: state.displayUnit,
    stairParams: state.stairParams,
    ladderParams: state.ladderParams,
    calculatedMetrics: state.calculatedMetrics,
  })));
  const project = useMemo<ProjectState>(() => selected, [selected]);
  const materials = useMemo(() => buildMaterialManifest(project), [project]);
  const estimate = useMemo(() => estimateIllustrativeMaterialCost(materials), [materials]);

  const exportFile = async (
    filename: string,
    extension: "csv" | "dxf" | "stl",
    content: string,
  ) => {
    setExportBusy(true);
    setError(null);
    setMessage("");
    try {
      const path = await saveEngineeringFile(filename, extension, content);
      if (path) setMessage(`Exported ${path}`);
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : "Export failed.");
    } finally {
      setExportBusy(false);
    }
  };

  const runAdvisor = async (kind: "structural" | "cost") => {
    setAdvisorBusy(kind);
    setError(null);
    try {
      const localModel = status?.online ? model : undefined;
      if (kind === "structural") {
        setStructural(await requestStructuralAdvice(project, localModel));
      } else {
        setCostAdvice(await requestCostSourcingAdvice(project, materials, localModel));
      }
    } catch (advisorError) {
      setError(advisorError instanceof Error ? advisorError.message : "Advisor request failed.");
    } finally {
      setAdvisorBusy(null);
    }
  };

  const tabs: Array<[ToolTab, string]> = [
    ["materials", "Materials & CAD"],
    ["advisors", "AI advice"],
    ["inspection", "Inspection"],
    ["projects", "Projects"],
  ];

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4 lg:p-6">
      <div className="mx-auto max-w-6xl space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-100">Workshop & project tools</h2>
            <p className="mt-1 text-[10px] text-slate-500">
              Deterministic takeoffs and exports · local-only project storage · advisory AI
            </p>
          </div>
          <nav className="flex flex-wrap rounded-lg border border-line bg-black/20 p-0.5">
            {tabs.map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setTab(value)}
                aria-pressed={tab === value}
                className={cn(
                  "rounded-md px-2.5 py-1.5 text-[9px] font-medium transition",
                  tab === value ? "bg-accent/15 text-accent" : "text-slate-400 hover:text-slate-200",
                )}
              >
                {label}
              </button>
            ))}
          </nav>
        </div>

        {tab === "materials" ? (
          <div className="space-y-3">
            <PanelTitle
              icon={Layers3}
              title="Bill of materials & cut optimization"
              detail="Deterministic preliminary quantities with geometric cut references. Verify stock grade, finish dimensions, allowances, fasteners, and connections before procurement."
            />
            <div className="flex flex-wrap gap-2">
              <button type="button" disabled={exportBusy} onClick={() => void exportFile("stairs-ladders-bom.csv", "csv", materialManifestCsv(materials))} className={buttonClass}>
                <Download className="h-3.5 w-3.5" /> BOM CSV
              </button>
              <button type="button" disabled={exportBusy} onClick={() => void exportFile("stairs-ladders-cut-plan.csv", "csv", cutOptimizationCsv(optimizeCutList(project, materials), project))} className={buttonClass}>
                <Download className="h-3.5 w-3.5" /> Cut-plan CSV
              </button>
              <button type="button" disabled={exportBusy} onClick={() => void exportFile("stairs-ladders.dxf", "dxf", buildDxf(project))} className={buttonClass}>
                <FileDown className="h-3.5 w-3.5" /> DXF
              </button>
              <button type="button" disabled={exportBusy} onClick={() => void exportFile("stairs-ladders.stl", "stl", buildStl(project))} className={buttonClass}>
                <FileDown className="h-3.5 w-3.5" /> STL
              </button>
              {exportBusy ? <span className="self-center text-[9px] text-slate-500">Preparing export…</span> : null}
            </div>
            <MaterialTable lines={materials} units={project.units} displayUnit={project.displayUnit} />
            <CutPlan project={project} lines={materials} />
            <div className="rounded-lg border border-amber-500/15 bg-amber-500/[0.04] p-2.5 text-[9px] leading-relaxed text-amber-100/70">
              CAD output is schematic fabrication geometry, not a construction drawing or structural design. STL is a scale model in {project.units === "imperial" ? "inches" : "millimetres"} (units are not embedded in STL). DXF uses {project.units === "imperial" ? "inches" : "millimetres"}.
            </div>
          </div>
        ) : null}

        {tab === "advisors" ? (
          <div className="space-y-3">
            <PanelTitle
              icon={Sparkles}
              title="Advisory-only structural & sourcing guidance"
              detail={status?.online ? `Local model: ${model}` : "Offline mode: deterministic guidance is available; no AI model connection detected."}
            />
            <div className="flex flex-wrap gap-2">
              <button type="button" disabled={advisorBusy !== null} onClick={() => void runAdvisor("structural")} className={buttonClass}>
                <Sparkles className="h-3.5 w-3.5" /> {advisorBusy === "structural" ? "Reviewing…" : "Structural / load review"}
              </button>
              <button type="button" disabled={advisorBusy !== null} onClick={() => void runAdvisor("cost")} className={buttonClass}>
                <Sparkles className="h-3.5 w-3.5" /> {advisorBusy === "cost" ? "Reviewing…" : "Cost & sourcing review"}
              </button>
            </div>
            <AdviceCard
              title="Structural / load advisor"
              result={structural}
            />
            <AdviceCard
              title="Material cost & sourcing advisor"
              result={costAdvice}
              estimate={`Illustrative material-only range: $${estimate.low}–$${estimate.high} USD`}
            />
            <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.04] p-2.5 text-[9px] leading-relaxed text-amber-100/70">
              No load capacity, deflection, member sizing, live supplier pricing, or code approval is computed by AI. Offline fallback is deterministic and explicitly approximate. Obtain engineering review and current local quotes.
            </div>
          </div>
        ) : null}

        {tab === "inspection" ? (
          <InspectionPanel project={project} projectName={projectName} />
        ) : null}
        {tab === "projects" ? (
          <ProjectLibraryPanel project={project} onProjectName={setProjectName} />
        ) : null}

        {error ? <p role="alert" className="rounded-lg border border-rose-500/20 bg-rose-500/[0.05] p-2 text-[10px] text-rose-300">{error}</p> : null}
        {message ? <p role="status" className="rounded-lg border border-emerald-500/20 bg-emerald-500/[0.04] p-2 text-[10px] text-emerald-300">{message}</p> : null}
      </div>
    </div>
  );
}
