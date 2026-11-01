import { useMemo } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CircleAlert,
  Info,
  ShieldCheck,
  X,
} from "lucide-react";
import { useFloorPlanStore } from "../../store/floorPlanStore";
import {
  runComplianceChecks,
  type ComplianceCheck,
  type ComplianceStatus,
} from "../../utils/spatialRules";
import { cn } from "../../utils/cn";

const statusStyles: Record<
  ComplianceStatus,
  { icon: typeof CheckCircle2; iconClass: string; badge: string }
> = {
  pass: {
    icon: CheckCircle2,
    iconClass: "text-emerald-400",
    badge: "bg-emerald-500/10 text-emerald-300 border-emerald-500/20",
  },
  warning: {
    icon: Info,
    iconClass: "text-amber-400",
    badge: "bg-amber-500/10 text-amber-300 border-amber-500/20",
  },
  fail: {
    icon: AlertTriangle,
    iconClass: "text-rose-400",
    badge: "bg-rose-500/10 text-rose-300 border-rose-500/20",
  },
};

function CheckRow({ check }: { check: ComplianceCheck }) {
  const styles = statusStyles[check.status];
  const Icon = styles.icon;
  const selectWall = useFloorPlanStore((state) => state.selectWall);
  const selectOpening = useFloorPlanStore((state) => state.selectOpening);

  const handleFocus = () => {
    if (!check.relatedId) return;
    if (check.rule === "egress") {
      selectOpening(check.relatedId);
    } else {
      selectWall(check.relatedId);
    }
  };

  return (
    <button
      type="button"
      onClick={handleFocus}
      className={cn(
        "group w-full rounded-xl border border-line/70 bg-panel-raised/60 p-3 text-left transition",
        check.relatedId && "hover:border-accent/40 hover:bg-panel-raised",
        !check.relatedId && "cursor-default",
      )}
    >
      <div className="flex items-start gap-2.5">
        <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", styles.iconClass)} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[12px] font-semibold tracking-wide text-slate-100">
              {check.title}
            </p>
            <span
              className={cn(
                "rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider",
                styles.badge,
              )}
            >
              {check.status}
            </span>
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
            {check.detail}
          </p>
        </div>
      </div>
    </button>
  );
}

export function CompliancePanel() {
  const walls = useFloorPlanStore((state) => state.walls);
  const openings = useFloorPlanStore((state) => state.openings);
  const open = useFloorPlanStore((state) => state.complianceOpen);
  const setComplianceOpen = useFloorPlanStore(
    (state) => state.setComplianceOpen,
  );

  const report = useMemo(
    () => runComplianceChecks(walls, openings),
    [walls, openings],
  );

  const issues = report.failCount + report.warningCount;
  const SummaryIcon = report.allPassing
    ? CheckCircle2
    : report.failCount > 0
      ? AlertTriangle
      : CircleAlert;

  return (
    <aside
      className={cn(
        "absolute inset-y-0 right-0 z-20 flex w-[336px] max-w-[calc(100%-1rem)] flex-col border-l border-line bg-panel/95 shadow-2xl shadow-black/40 backdrop-blur-xl transition-transform duration-300 ease-out",
        open ? "translate-x-0" : "pointer-events-none translate-x-full",
      )}
    >
      <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-4">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-accent/20 bg-accent/10">
            <ShieldCheck className="h-4.5 w-4.5 text-accent" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-slate-100">
              Spatial Compliance
            </h2>
            <p className="mt-0.5 flex items-center gap-1.5 text-[10px] uppercase tracking-[0.14em] text-slate-500">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
              </span>
              Live rule checking
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setComplianceOpen(false)}
          className="rounded-lg p-1.5 text-slate-500 transition hover:bg-white/5 hover:text-slate-200"
          aria-label="Close compliance panel"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        <div
          className={cn(
            "rounded-xl border p-3.5",
            report.allPassing
              ? "border-emerald-500/20 bg-emerald-500/[0.06]"
              : report.failCount > 0
                ? "border-rose-500/20 bg-rose-500/[0.06]"
                : "border-amber-500/20 bg-amber-500/[0.06]",
          )}
        >
          <div className="flex items-center gap-3">
            <SummaryIcon
              className={cn(
                "h-6 w-6",
                report.allPassing
                  ? "text-emerald-400"
                  : report.failCount > 0
                    ? "text-rose-400"
                    : "text-amber-400",
              )}
            />
            <div>
              <p className="text-sm font-semibold text-slate-100">
                {report.allPassing
                  ? "All checks passing"
                  : `${issues} issue${issues === 1 ? "" : "s"} found`}
              </p>
              <p className="text-[11px] text-slate-400">
                {report.passCount} passed · {report.failCount} failed ·{" "}
                {report.warningCount} warning
                {report.warningCount === 1 ? "" : "s"}
              </p>
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
            Checks
          </p>
          {report.checks.map((check) => (
            <CheckRow key={check.id} check={check} />
          ))}
        </div>

        <div className="rounded-xl border border-line/70 bg-black/20 p-3">
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
            Active rules
          </p>
          <ul className="mt-2 space-y-2 text-[11px] leading-relaxed text-slate-400">
            <li className="flex gap-2">
              <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-accent" />
              Doorways must be at least 32 in (0.81 m) clear width for egress.
            </li>
            <li className="flex gap-2">
              <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-accent" />
              Every wall must connect to another wall at one of its endpoints.
            </li>
          </ul>
        </div>
      </div>

      <div className="border-t border-line px-4 py-3 text-[10px] text-slate-500">
        Select an issue to focus the related wall or opening in the plan.
      </div>
    </aside>
  );
}
