import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Download,
  LoaderCircle,
  Ruler,
  Send,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import {
  DEFAULT_AI_MODELS,
  checkOllamaStatus,
  type OllamaStatus,
} from "../../services/localAiService";
import {
  formatDesignPatchSummary,
  requestDesignToolCall,
  runOfflineDesignRequest,
  type CopilotResult,
} from "../../engineering/designCopilot";
import { runBuildingCodeAudit } from "../../engineering/buildingCodeAudit";
import {
  rampSlopeFromDegrees,
  rampSlopeFromGrade,
  rampSlopeFromRatio,
} from "../../engineering/rampCalculations";
import { formatLength } from "../../engineering/units";
import { useProjectStore } from "../../engineering/projectStore";
import type {
  AuditFinding,
  EngineeringUnits,
  ProjectParametersPatch,
} from "../../engineering/types";
import { cn } from "../../utils/cn";
import { WorkshopDrawings } from "./WorkshopDrawings";
import {
  exportAiLog,
  getAiLogLocation,
  logAiError,
} from "../../services/aiLog";

type Props = { onBack: () => void };

function Metric({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div className="rounded-xl border border-line/70 bg-black/20 p-3">
      <p className="text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-500">
        {label}
      </p>
      <p className="mt-1 font-mono text-lg font-semibold text-slate-100">{value}</p>
      {note ? <p className="mt-0.5 text-[10px] text-slate-500">{note}</p> : null}
    </div>
  );
}

function NumberInput({
  label,
  value,
  unit,
  min = 0.01,
  step,
  onChange,
}: {
  label: string;
  value: number;
  unit: string;
  min?: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 flex items-center justify-between text-[10px] font-medium uppercase tracking-[0.12em] text-slate-500">
        <span>{label}</span>
        <span className="normal-case tracking-normal">{unit}</span>
      </span>
      <input
        type="number"
        value={value}
        min={min}
        step={step ?? (unit === "in" ? 0.0625 : 1)}
        onChange={(event) => {
          const next = event.currentTarget.valueAsNumber;
          if (Number.isFinite(next)) onChange(next);
        }}
        className="w-full rounded-lg border border-line bg-black/25 px-2.5 py-2 font-mono text-[12px] text-slate-100 outline-none transition focus:border-accent/50 focus:ring-2 focus:ring-accent/10"
      />
    </label>
  );
}

function Finding({ item }: { item: AuditFinding }) {
  const Icon =
    item.status === "pass"
      ? CheckCircle2
      : item.status === "fail"
        ? AlertTriangle
        : AlertTriangle;
  return (
    <div className="rounded-lg border border-line/70 bg-black/20 p-2.5">
      <div className="flex items-start gap-2">
        <Icon
          className={cn(
            "mt-0.5 h-3.5 w-3.5 shrink-0",
            item.status === "pass"
              ? "text-emerald-400"
              : item.status === "fail"
                ? "text-rose-400"
                : "text-amber-400",
          )}
        />
        <div className="min-w-0">
          <p className="text-[11px] font-semibold text-slate-200">{item.title}</p>
          <p className="mt-0.5 text-[10px] leading-relaxed text-slate-400">
            {item.detail}
          </p>
          <p className="mt-1 text-[9px] leading-relaxed text-slate-600">
            {item.citation}
          </p>
        </div>
      </div>
    </div>
  );
}

function RampConverter({ units }: { units: EngineeringUnits }) {
  const [mode, setMode] = useState<"degrees" | "grade" | "ratio">("degrees");
  const [value, setValue] = useState("4.76");
  const result = useMemo(() => {
    try {
      const number = Number(value);
      if (mode === "degrees") return rampSlopeFromDegrees(number);
      if (mode === "grade") return rampSlopeFromGrade(number);
      return rampSlopeFromRatio(number, 12);
    } catch {
      return null;
    }
  }, [mode, value]);

  return (
    <section className="rounded-xl border border-line/70 bg-panel-raised/50 p-3">
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] font-semibold text-slate-200">Ramp pitch</h3>
        <span className="text-[9px] text-slate-500">ADA check</span>
      </div>
      <div className="mt-2 grid grid-cols-[1fr_1fr] gap-2">
        <select
          value={mode}
          onChange={(event) =>
            setMode(event.currentTarget.value as "degrees" | "grade" | "ratio")
          }
          className="rounded-lg border border-line bg-black/25 px-2 py-1.5 text-[10px] text-slate-200 outline-none"
          aria-label="Ramp input format"
        >
          <option value="degrees">Degrees</option>
          <option value="grade">Grade %</option>
          <option value="ratio">Rise per 12</option>
        </select>
        <input
          type="number"
          step="0.01"
          value={value}
          onChange={(event) => setValue(event.currentTarget.value)}
          aria-label="Ramp input value"
          className="min-w-0 rounded-lg border border-line bg-black/25 px-2 py-1.5 font-mono text-[11px] text-slate-100 outline-none focus:border-accent/50"
        />
      </div>
      {result ? (
        <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[10px] text-slate-400">
          <span>Angle</span>
          <span className="text-right font-mono text-slate-200">{result.degrees}°</span>
          <span>Pitch</span>
          <span className="text-right font-mono text-slate-200">
            1:{(12 / Math.max(result.risePer12Run, 0.0001)).toFixed(2)}
          </span>
          <span>Grade</span>
          <span className="text-right font-mono text-slate-200">{result.gradePercent}%</span>
          <span>2010 ADA 1:12</span>
          <span
            className={cn(
              "text-right font-semibold",
              result.adaCompliant ? "text-emerald-300" : "text-rose-300",
            )}
          >
            {result.adaCompliant ? "Within limit" : "Exceeds limit"}
          </span>
        </div>
      ) : (
        <p className="mt-2 text-[10px] text-rose-300">Enter a valid slope.</p>
      )}
      <p className="mt-2 text-[9px] leading-relaxed text-slate-600">
        {result?.citation}. Confirm applicable exceptions and adopted standards.
        Display units: {units === "imperial" ? "inches" : "millimetres"}.
      </p>
    </section>
  );
}

export function StairLadderStudio({ onBack }: Props) {
  const [activeTab, setActiveTab] = useState<"calculator" | "drawings">(
    "calculator",
  );
  const projectType = useProjectStore((state) => state.projectType);
  const units = useProjectStore((state) => state.units);
  const stairParams = useProjectStore((state) => state.stairParams);
  const ladderParams = useProjectStore((state) => state.ladderParams);
  const metrics = useProjectStore((state) => state.calculatedMetrics);
  const updateDesignParameters = useProjectStore(
    (state) => state.updateDesignParameters,
  );
  const audit = useProjectStore((state) => state.auditBuildingCode);
  const [report, setReport] = useState(() => audit());
  const [status, setStatus] = useState<OllamaStatus | null>(null);
  const [model, setModel] = useState(DEFAULT_AI_MODELS[0]);
  const [draft, setDraft] = useState("");
  const [copilotMessage, setCopilotMessage] = useState(
    "I only extract requested parameters. Geometry and code checks are always calculated by the deterministic rule engine.",
  );
  const [busy, setBusy] = useState(false);
  const [logBusy, setLogBusy] = useState(false);
  const [aiLogLocation, setAiLogLocation] = useState("ai-log.jsonl");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void checkOllamaStatus().then((next) => {
      if (!alive) return;
      setStatus(next);
      if (next.models.length > 0) setModel(next.models[0]);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    void getAiLogLocation().then((location) => {
      if (alive) setAiLogLocation(location);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    setReport(audit());
  }, [audit, metrics, projectType, units, stairParams, ladderParams]);

  const unitLabel = units === "imperial" ? "in" : "mm";

  const applyPatch = (patch: ProjectParametersPatch) => {
    const result = updateDesignParameters(patch);
    if (!result.applied) throw new Error(result.error ?? "Could not apply update.");
    setReport(runBuildingCodeAudit(useProjectStore.getState()));
  };

  const submitCopilot = async () => {
    const request = draft.trim();
    if (!request || busy) return;
    setDraft("");
    setBusy(true);
    setError(null);
    try {
      let result: CopilotResult;
      if (status?.online) {
        try {
          const response = await requestDesignToolCall(
            request,
            useProjectStore.getState(),
            { model },
          );
          if (response.toolCall.tool === "auditBuildingCode") {
            const deterministicAudit = runBuildingCodeAudit(
              useProjectStore.getState(),
            );
            result = {
              response: `Deterministic audit complete: ${deterministicAudit.passCount} passed, ${deterministicAudit.failCount} failed, ${deterministicAudit.warningCount} warnings.`,
              audit: deterministicAudit,
              source: "local-model",
            };
          } else {
            result = {
              response:
                "I extracted the requested parameter update. Geometry and compliance were recalculated by the deterministic engine.",
              patch: response.toolCall.arguments,
              source: "local-model",
            };
          }
        } catch {
          result = await runOfflineDesignRequest(
            request,
            useProjectStore.getState(),
          );
          result.response = `Local model unavailable for this request; used the offline parameter parser. ${result.response}`;
        }
      } else {
        result = await runOfflineDesignRequest(
          request,
          useProjectStore.getState(),
        );
      }
      if (result.patch) applyPatch(result.patch);
      if (result.audit) setReport(result.audit);
      const responseUnits = useProjectStore.getState().units;
      setCopilotMessage(
        `${result.response}\n\n${formatDesignPatchSummary(result.patch, responseUnits)}\n\nSource: ${result.source === "local-model" ? `${model} via local Ollama` : "offline command parser"}.`,
      );
    } catch (submitError) {
      if (status?.online) {
        await logAiError("stairs-design-copilot-apply", model, submitError);
      }
      setError(
        submitError instanceof Error
          ? submitError.message
          : "Copilot request failed.",
      );
    } finally {
      setBusy(false);
    }
  };

  const runAudit = () => {
    const next = audit();
    setReport(next);
    setCopilotMessage(
      `Deterministic audit: ${next.passCount} passed, ${next.failCount} failed, ${next.warningCount} warning${next.warningCount === 1 ? "" : "s"}. Project dimensions are in ${unitLabel}. AI does not calculate these results.`,
    );
  };

  const handleExportAiLog = async () => {
    setLogBusy(true);
    setError(null);
    try {
      const path = await exportAiLog();
      if (path) setCopilotMessage(`AI log exported to ${path}.`);
    } catch (logError) {
      setError(
        logError instanceof Error
          ? logError.message
          : "Could not export the AI log.",
      );
    } finally {
      setLogBusy(false);
    }
  };

  const setProjectType = (value: "staircase" | "ladder") => {
    updateDesignParameters({ projectType: value });
  };

  const format = (value: number | null) =>
    value === null ? "Not measured" : formatLength(value, units);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-shell text-slate-200">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-panel/80 px-4">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-[11px] text-slate-300 transition hover:border-accent/30 hover:text-accent"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Floor plan
        </button>
        <div className="h-6 w-px bg-line" />
        <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-accent/25 bg-accent/10">
          <Ruler className="h-4 w-4 text-accent" />
        </div>
        <div>
          <h1 className="text-[13px] font-semibold text-slate-100">
            Stairs &amp; Ladders
          </h1>
          <p className="text-[10px] text-slate-500">
            Deterministic engineering · Phase 2
          </p>
        </div>
        <nav className="ml-5 flex items-center rounded-lg border border-line bg-black/20 p-0.5">
          {(
            [
              ["calculator", "Calculator"],
              ["drawings", "Shop drawings"],
            ] as const
          ).map(([tab, label]) => (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              aria-pressed={activeTab === tab}
              className={cn(
                "rounded-md px-3 py-1.5 text-[10px] font-medium transition",
                activeTab === tab
                  ? "bg-accent/15 text-accent"
                  : "text-slate-400 hover:text-slate-200",
              )}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <span
            className={cn(
              "rounded-full border px-2 py-1 text-[9px] uppercase tracking-wider",
              status?.online
                ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-300"
                : "border-amber-500/20 bg-amber-500/10 text-amber-300",
            )}
          >
            {status?.online ? "Local AI connected" : "Offline-ready"}
          </span>
          <select
            value={units}
            onChange={(event) =>
              useProjectStore
                .getState()
                .setUnits(event.currentTarget.value as EngineeringUnits)
            }
            aria-label="Project units"
            className="rounded-lg border border-line bg-black/25 px-2 py-1.5 text-[10px] text-slate-200 outline-none"
          >
            <option value="imperial">Imperial · in</option>
            <option value="metric">Metric · mm</option>
          </select>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {activeTab === "drawings" ? (
            <WorkshopDrawings status={status} model={model} />
          ) : (
          <div className="min-h-0 flex-1 overflow-y-auto p-4 lg:p-6">
          <div className="mx-auto max-w-5xl space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-slate-100">
                  Parametric calculator
                </h2>
                <p className="mt-1 text-[11px] text-slate-500">
                  Changes recalculate geometry and safety findings immediately.
                </p>
              </div>
              <div className="flex rounded-lg border border-line bg-black/20 p-0.5">
                {(["staircase", "ladder"] as const).map((type) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => setProjectType(type)}
                    aria-pressed={projectType === type}
                    className={cn(
                      "rounded-md px-3 py-1.5 text-[11px] font-medium capitalize transition",
                      projectType === type
                        ? "bg-accent/15 text-accent"
                        : "text-slate-400 hover:text-slate-200",
                    )}
                  >
                    {type}
                  </button>
                ))}
              </div>
            </div>

            <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(300px,0.8fr)]">
              <div className="space-y-4">
                {projectType === "staircase" ? (
                  <div className="rounded-xl border border-line bg-panel/70 p-4">
                    <div className="mb-3 flex items-center justify-between">
                      <h3 className="text-[12px] font-semibold text-slate-100">
                        Stair parameters
                      </h3>
                      <select
                        value={stairParams.style}
                        onChange={(event) =>
                          updateDesignParameters({
                            stairParams: {
                              style: event.currentTarget.value as typeof stairParams.style,
                            },
                          })
                        }
                        className="rounded-lg border border-line bg-black/25 px-2 py-1.5 text-[10px] text-slate-200 outline-none"
                        aria-label="Stair style"
                      >
                        <option value="straight">Straight</option>
                        <option value="l-shaped">L-shaped</option>
                        <option value="u-shaped">U-shaped</option>
                        <option value="spiral">Spiral</option>
                      </select>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                      <NumberInput label="Total rise" value={stairParams.totalRise} unit={unitLabel} onChange={(totalRise) => updateDesignParameters({ stairParams: { totalRise } })} />
                      {stairParams.style !== "spiral" ? (
                        <NumberInput label="Total run (treads)" value={stairParams.totalRun} unit={unitLabel} onChange={(totalRun) => updateDesignParameters({ stairParams: { totalRun } })} />
                      ) : (
                        <>
                          <NumberInput label="Spiral radius" value={stairParams.spiralRadius} unit={unitLabel} onChange={(spiralRadius) => updateDesignParameters({ stairParams: { spiralRadius } })} />
                          <NumberInput label="Spiral turns" value={stairParams.spiralTurns} unit="turns" min={0.25} step={0.25} onChange={(spiralTurns) => updateDesignParameters({ stairParams: { spiralTurns } })} />
                        </>
                      )}
                      <NumberInput label="Stair width" value={stairParams.width} unit={unitLabel} onChange={(width) => updateDesignParameters({ stairParams: { width } })} />
                      {stairParams.style === "l-shaped" || stairParams.style === "u-shaped" ? (
                        <NumberInput label="Landing length" value={stairParams.landingLength} unit={unitLabel} onChange={(landingLength) => updateDesignParameters({ stairParams: { landingLength } })} />
                      ) : null}
                      <NumberInput label="Tread thickness" value={stairParams.treadThickness} unit={unitLabel} onChange={(treadThickness) => updateDesignParameters({ stairParams: { treadThickness } })} />
                      <NumberInput label="Riser thickness" value={stairParams.riserThickness} unit={unitLabel} onChange={(riserThickness) => updateDesignParameters({ stairParams: { riserThickness } })} />
                      <NumberInput label="Nosing" value={stairParams.nosing} unit={unitLabel} onChange={(nosing) => updateDesignParameters({ stairParams: { nosing } })} />
                      <NumberInput label="Ceiling height" value={stairParams.headroomCeilingHeight} unit={unitLabel} onChange={(headroomCeilingHeight) => updateDesignParameters({ stairParams: { headroomCeilingHeight } })} />
                      <NumberInput
                        label="Measured headroom"
                        value={stairParams.headroomClearance ?? 80}
                        unit={unitLabel}
                        onChange={(headroomClearance) => updateDesignParameters({ stairParams: { headroomClearance } })}
                      />
                      <NumberInput label="Max baluster gap" value={stairParams.balusterSpacingMax} unit={unitLabel} onChange={(balusterSpacingMax) => updateDesignParameters({ stairParams: { balusterSpacingMax } })} />
                    </div>
                    <p className="mt-3 rounded-lg border border-amber-500/15 bg-amber-500/[0.04] p-2.5 text-[10px] leading-relaxed text-amber-100/70">
                      Headroom is checked from the measured clearance above. Ceiling height alone cannot establish stair headroom without ceiling-location geometry.
                      {stairParams.style === "l-shaped" || stairParams.style === "u-shaped"
                        ? " The shop sheet splits the aggregate rise/run into two flights and uses the editable landing length."
                        : stairParams.style === "spiral"
                          ? " The plan view uses radial treads from the centerline radius and turn count; the elevation is a developed walkline profile."
                          : ""}
                    </p>
                  </div>
                ) : (
                  <div className="rounded-xl border border-line bg-panel/70 p-4">
                    <div className="mb-3 flex items-center justify-between">
                      <h3 className="text-[12px] font-semibold text-slate-100">
                        Ladder parameters
                      </h3>
                      <select
                        value={ladderParams.ladderType}
                        onChange={(event) =>
                          updateDesignParameters({
                            ladderParams: {
                              ladderType: event.currentTarget.value as typeof ladderParams.ladderType,
                            },
                          })
                        }
                        className="rounded-lg border border-line bg-black/25 px-2 py-1.5 text-[10px] text-slate-200 outline-none"
                        aria-label="Ladder type"
                      >
                        <option value="extension">Extension</option>
                        <option value="single">Single</option>
                        <option value="step">Step ladder</option>
                      </select>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <NumberInput
                        label="Working height"
                        value={ladderParams.workingHeight}
                        unit={unitLabel}
                        onChange={(workingHeight) =>
                          updateDesignParameters({ ladderParams: { workingHeight } })
                        }
                      />
                      <label className="block">
                        <span className="mb-1 block text-[10px] font-medium uppercase tracking-[0.12em] text-slate-500">
                          Setup surface
                        </span>
                        <select
                          value={ladderParams.surfaceType}
                          onChange={(event) =>
                            updateDesignParameters({
                              ladderParams: {
                                surfaceType: event.currentTarget.value as typeof ladderParams.surfaceType,
                              },
                            })
                          }
                          className="w-full rounded-lg border border-line bg-black/25 px-2.5 py-2 text-[11px] text-slate-200 outline-none"
                        >
                          <option value="concrete">Concrete</option>
                          <option value="wood">Wood</option>
                          <option value="soil">Soil / ground</option>
                          <option value="other">Other</option>
                        </select>
                      </label>
                    </div>
                    <p className="mt-3 rounded-lg border border-amber-500/15 bg-amber-500/[0.04] p-2.5 text-[10px] leading-relaxed text-amber-100/70">
                      Setback follows the 1:4 rule; extension allowance is included in required length. Use the ladder label/manufacturer instructions to select sections and confirm overlap.
                    </p>
                  </div>
                )}

                <div>
                  <div className="mb-2 flex items-center gap-2">
                    <Ruler className="h-3.5 w-3.5 text-accent" />
                    <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">
                      Calculated metrics
                    </h3>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                    {projectType === "staircase" ? (
                      <>
                        <Metric label="Risers / treads" value={`${metrics.stepCount} / ${metrics.treadCount}`} />
                        <Metric label="Unit rise" value={format(metrics.unitRise)} />
                        <Metric label="Unit run" value={format(metrics.unitRun)} />
                        <Metric label="Stringer length" value={format(metrics.stringerLength)} />
                        <Metric label="Pitch angle" value={`${metrics.pitchAngleDegrees}°`} />
                        {stairParams.style === "spiral" ? (
                          <Metric label="Walking-line development" value={format(metrics.totalWalkingRun)} note={`${stairParams.spiralTurns} turn${stairParams.spiralTurns === 1 ? "" : "s"} at centerline radius`} />
                        ) : null}
                        <Metric label="Plumb / level cuts" value={`${metrics.plumbCutAngleDegrees}° / ${metrics.levelCutAngleDegrees}°`} />
                        <Metric label="Balusters" value={`${metrics.balusterCount}`} note={`${format(metrics.balusterClearGap)} max clear gap along ${format(metrics.balusterRailRun)} railing`} />
                        <Metric label="Measured headroom" value={format(metrics.headroomClearance)} />
                      </>
                    ) : (
                      <>
                        <Metric label="Base setback" value={format(metrics.ladderBaseSetback)} note="1 unit out per 4 units up" />
                        <Metric label="Setup angle" value={`${metrics.ladderAngleDegrees}°`} note="Approx. 75.5° target" />
                        <Metric label="Required ladder length" value={format(metrics.ladderRequiredLength)} note="Includes 3 ft landing extension" />
                        <Metric label="Minimum overlap" value={metrics.ladderOverlap === null ? "Manufacturer guide" : format(metrics.ladderOverlap)} />
                        <Metric label="Extension sections" value={`${metrics.ladderSectionCount} section${metrics.ladderSectionCount === 1 ? "" : "s"}`} />
                        <Metric label="Roof extension" value={format(metrics.ladderRoofExtension)} note={ladderParams.ladderType === "extension" ? "At least 3 ft for access" : "Not applicable to this type"} />
                      </>
                    )}
                  </div>
                </div>

                <RampConverter units={units} />
              </div>

              <aside className="flex min-h-[420px] flex-col rounded-xl border border-line bg-panel/70">
                <div className="flex items-center justify-between border-b border-line px-3.5 py-3">
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="h-4 w-4 text-accent" />
                    <div>
                      <h3 className="text-[11px] font-semibold text-slate-100">
                        Deterministic code audit
                      </h3>
                      <p className="text-[9px] text-slate-500">
                        {report.passCount} pass · {report.failCount} fail · {report.warningCount} warning
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={runAudit}
                    className="rounded-lg border border-accent/20 bg-accent/10 px-2 py-1 text-[10px] text-accent hover:bg-accent/15"
                  >
                    Audit
                  </button>
                </div>
                <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
                  <div
                    className={cn(
                      "rounded-lg border p-2.5 text-[10px]",
                      report.failCount > 0
                        ? "border-rose-500/20 bg-rose-500/[0.06] text-rose-200"
                        : report.warningCount > 0
                          ? "border-amber-500/20 bg-amber-500/[0.06] text-amber-100"
                          : "border-emerald-500/20 bg-emerald-500/[0.06] text-emerald-200",
                    )}
                  >
                    {report.failCount > 0
                      ? "One or more checks failed."
                      : report.warningCount > 0
                        ? "Review the warnings and confirm site conditions."
                        : "All implemented checks pass."}
                  </div>
                  {report.findings.map((item) => (
                    <Finding key={item.id} item={item} />
                  ))}
                  <p className="rounded-lg border border-line/70 bg-black/20 p-2.5 text-[9px] leading-relaxed text-slate-500">
                    {report.disclaimer}
                  </p>
                </div>
                <div className="border-t border-line p-3">
                  <div className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold text-slate-300">
                    <Sparkles className="h-3 w-3 text-violet-300" />
                    Design Copilot
                    <span className="ml-auto font-normal text-slate-600">
                      {status?.online ? model : "offline parser"}
                    </span>
                    <button
                      type="button"
                      onClick={() => void handleExportAiLog()}
                      disabled={logBusy}
                      aria-label="Export AI log file"
                      title={`AI output/error log: ${aiLogLocation}`}
                      className="rounded-md p-1 text-slate-500 transition hover:bg-white/5 hover:text-accent disabled:opacity-40"
                    >
                      {logBusy ? (
                        <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Download className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </div>
                  {status?.online ? (
                    <select
                      value={model}
                      onChange={(event) => setModel(event.currentTarget.value)}
                      aria-label="Local AI model"
                      className="mb-2 w-full rounded-lg border border-line bg-black/25 px-2 py-1.5 text-[10px] text-slate-300 outline-none"
                    >
                      {(status.models.length ? status.models : DEFAULT_AI_MODELS).map((option) => (
                        <option key={option} value={option}>{option}</option>
                      ))}
                    </select>
                  ) : null}
                  <p className="mb-2 max-h-24 overflow-y-auto whitespace-pre-wrap rounded-lg border border-line/70 bg-black/20 p-2.5 text-[10px] leading-relaxed text-slate-400">
                    {copilotMessage}
                  </p>
                  {error ? (
                    <p className="mb-2 text-[10px] text-rose-300">{error}</p>
                  ) : null}
                  <div className="flex items-end gap-2">
                    <textarea
                      value={draft}
                      onChange={(event) => setDraft(event.currentTarget.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.shiftKey) {
                          event.preventDefault();
                          void submitCopilot();
                        }
                      }}
                      rows={2}
                      placeholder='“Set rise to 108 inches, run to 120 inches, L-shaped”'
                      className="min-h-[42px] flex-1 resize-y rounded-lg border border-line bg-black/25 px-2.5 py-2 text-[10px] text-slate-100 outline-none placeholder:text-slate-600 focus:border-accent/50"
                    />
                    <button
                      type="button"
                      onClick={() => void submitCopilot()}
                      disabled={busy || !draft.trim()}
                      aria-label="Send Copilot request"
                      className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-lg border border-accent/25 bg-accent/10 text-accent transition hover:bg-accent/20 disabled:opacity-40"
                    >
                      {busy ? (
                        <LoaderCircle className="h-4 w-4 animate-spin" />
                      ) : (
                        <Send className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </div>
                  <p className="mt-1.5 text-[9px] text-slate-600">
                    Local-only · No cloud calls · Math is never delegated to AI
                  </p>
                  <p className="mt-1 text-[8px] leading-relaxed text-slate-600">
                    AI outputs/errors append to {aiLogLocation}. Prompts are not
                    logged; use the download icon to export the JSONL log.
                  </p>
                </div>
              </aside>
            </section>
          </div>
          </div>
          )}
        </main>
      </div>
    </div>
  );
}
