import { useCallback, useEffect, useRef, useState } from "react";
import {
  Cpu,
  Check,
  Download,
  Eraser,
  Loader2,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles,
  Square,
  WifiOff,
  X,
} from "lucide-react";
import { useFloorPlanStore } from "../../store/floorPlanStore";
import {
  AI_TIMEOUT_RESPONSE_WINDOW_MS,
  DEFAULT_AI_MODELS,
  analyzeComplianceWithLLM,
  askPlanQuestion,
  checkOllamaStatus,
  type OllamaStatus,
} from "../../services/localAiService";
import { runComplianceChecks } from "../../utils/spatialRules";
import { cn } from "../../utils/cn";
import { exportAiLog, getAiLogLocation } from "../../services/aiLog";
import {
  generateFloorPlanFromPrompt,
  type GeneratedFloorPlan,
} from "../../services/floorPlanAiService";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  plan?: GeneratedFloorPlan;
  applied?: boolean;
};

type AssistantMode = "ask" | "generate";

const createMessageId = () =>
  `ai-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function offlineAuditText(
  walls: Parameters<typeof runComplianceChecks>[0],
  openings: Parameters<typeof runComplianceChecks>[1],
) {
  const report = runComplianceChecks(walls, openings);
  const lines = [
    "Offline deterministic audit. Ollama is not reachable, so the local rule engine produced this result.",
    "",
    ...report.checks.map(
      (check) =>
        `[${check.status.toUpperCase()}] ${check.title}: ${check.detail}`,
    ),
    "",
    report.allPassing
      ? "Result: all deterministic checks are passing."
      : `Result: ${report.failCount} failed and ${report.warningCount} warning${report.warningCount === 1 ? "" : "s"}.`,
  ];
  return lines.join("\n");
}

export function LocalAiAssistant() {
  const walls = useFloorPlanStore((state) => state.walls);
  const openings = useFloorPlanStore((state) => state.openings);
  const open = useFloorPlanStore((state) => state.aiOpen);
  const setAiOpen = useFloorPlanStore((state) => state.setAiOpen);
  const importPlan = useFloorPlanStore((state) => state.importPlan);
  const setActiveView = useFloorPlanStore((state) => state.setActiveView);

  const [status, setStatus] = useState<OllamaStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [model, setModel] = useState("llama3.2");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [mode, setMode] = useState<AssistantMode>("ask");
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [timeoutDeadline, setTimeoutDeadline] = useState<number | null>(null);
  const [timeoutSecondsLeft, setTimeoutSecondsLeft] = useState(0);
  const [aiLogLocation, setAiLogLocation] = useState("ai-log.jsonl");
  const [exportingLog, setExportingLog] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const timeoutDecisionRef = useRef<
    ((continueWaiting: boolean) => void) | null
  >(null);
  const timeoutExpiredRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const resolveTimeoutPrompt = (continueWaiting: boolean) => {
    const respond = timeoutDecisionRef.current;
    timeoutDecisionRef.current = null;
    setTimeoutDeadline(null);
    setTimeoutSecondsLeft(0);
    if (!continueWaiting) abortRef.current?.abort();
    respond?.(continueWaiting);
  };

  const refreshStatus = useCallback(async () => {
    setChecking(true);
    const next = await checkOllamaStatus();
    setStatus(next);
    setChecking(false);
    setError(null);
    if (next.models.length > 0) {
      setModel((current) =>
        next.models.includes(current) ? current : next.models[0],
      );
    }
  }, []);

  useEffect(() => {
    if (!open || status) return;
    void refreshStatus();
  }, [open, status, refreshStatus]);

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
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages, streaming]);

  useEffect(() => {
    if (timeoutDeadline === null) return;
    const updateCountdown = () => {
      setTimeoutSecondsLeft(
        Math.max(0, Math.ceil((timeoutDeadline - Date.now()) / 1000)),
      );
    };
    updateCountdown();
    const interval = globalThis.setInterval(updateCountdown, 250);
    return () => globalThis.clearInterval(interval);
  }, [timeoutDeadline]);

  useEffect(() => {
    return () => {
      timeoutDecisionRef.current?.(false);
      timeoutDecisionRef.current = null;
      abortRef.current?.abort();
    };
  }, []);

  const appendAssistantChunk = (id: string, chunk: string) => {
    setMessages((current) =>
      current.map((message) =>
        message.id === id
          ? { ...message, content: message.content + chunk }
          : message,
      ),
    );
  };

  const stopStreaming = () => {
    resolveTimeoutPrompt(false);
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
  };

  const runStream = async (
    userLabel: string,
    runner: (options: {
      model: string;
      signal: AbortSignal;
      onChunk: (chunk: string) => void;
    }) => Promise<string>,
  ) => {
    if (streaming) return;
    setError(null);

    const userMessage: ChatMessage = {
      id: createMessageId(),
      role: "user",
      content: userLabel,
    };
    const assistantId = createMessageId();
    const assistantMessage: ChatMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
    };

    setMessages((current) => [...current, userMessage, assistantMessage]);
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await runner({
        model,
        signal: controller.signal,
        onChunk: (chunk) => appendAssistantChunk(assistantId, chunk),
      });
      setMessages((current) =>
        current.map((message) =>
          message.id === assistantId && !message.content.trim()
            ? {
                ...message,
                content: "The local model returned an empty response.",
              }
            : message,
        ),
      );
    } catch (streamError) {
      const aborted = controller.signal.aborted;
      const detail =
        streamError instanceof Error
          ? streamError.message
          : "The local model request failed.";
      setMessages((current) =>
        current.map((message) =>
          message.id === assistantId
            ? {
                ...message,
                content: aborted
                  ? message.content || "Generation stopped."
                  : `Request failed: ${detail}`,
              }
            : message,
        ),
      );
      if (!aborted) setError(detail);
    } finally {
      abortRef.current = null;
      setStreaming(false);
    }
  };

  const handleAudit = () => {
    if (streaming) return;

    if (!status?.online) {
      setError(null);
      setMessages((current) => [
        ...current,
        {
          id: createMessageId(),
          role: "user",
          content: "Run a full spatial compliance audit.",
        },
        {
          id: createMessageId(),
          role: "assistant",
          content: offlineAuditText(walls, openings),
        },
      ]);
      return;
    }

    void runStream(
      "Run a full spatial compliance audit.",
      (options) => analyzeComplianceWithLLM(walls, openings, options),
    );
  };

  const handleSend = () => {
    const question = draft.trim();
    if (!question || streaming || !status?.online) return;
    setDraft("");
    void runStream(question, (options) =>
      askPlanQuestion(question, walls, openings, options),
    );
  };

  const handleGenerate = async () => {
    const request = draft.trim();
    if (!request || streaming || !status?.online) return;
    setDraft("");
    setError(null);

    const userMessage: ChatMessage = {
      id: createMessageId(),
      role: "user",
      content: `Generate a floor plan: ${request}`,
    };
    const assistantId = createMessageId();
    setMessages((current) => [
      ...current,
      userMessage,
      {
        id: assistantId,
        role: "assistant",
        content: "Designing a draft from your requirements…",
      },
    ]);
    setStreaming(true);

    timeoutExpiredRef.current = false;
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const plan = await generateFloorPlanFromPrompt(request, {
        model,
        signal: controller.signal,
        onTimeout: (respond) => {
          setAiOpen(true);
          timeoutDecisionRef.current = respond;
          setTimeoutDeadline(Date.now() + AI_TIMEOUT_RESPONSE_WINDOW_MS);
        },
        onTimeoutExpired: () => {
          timeoutExpiredRef.current = true;
          resolveTimeoutPrompt(false);
        },
      });
      setMessages((current) =>
        current.map((message) =>
          message.id === assistantId
            ? {
                ...message,
                content: `Draft ready: ${plan.name}. Review the geometry, then apply it to replace the current plan.`,
                plan,
              }
            : message,
        ),
      );
    } catch (generationError) {
      const aborted = controller.signal.aborted;
      const detail =
        generationError instanceof Error
          ? generationError.message
          : "Could not generate the floor plan.";
      setMessages((current) =>
        current.map((message) =>
          message.id === assistantId
            ? {
                ...message,
                content: aborted
                  ? timeoutExpiredRef.current
                    ? "Generation canceled because there was no response to the timeout prompt."
                    : "Generation stopped."
                  : `Could not generate the plan: ${detail}`,
              }
            : message,
        ),
      );
      if (!aborted) setError(detail);
    } finally {
      resolveTimeoutPrompt(true);
      timeoutExpiredRef.current = false;
      abortRef.current = null;
      setStreaming(false);
    }
  };

  const handleApplyPlan = (messageId: string, plan: GeneratedFloorPlan) => {
    importPlan(plan.walls, plan.openings, { replace: true, name: plan.name });
    setActiveView("2d");
    setMessages((current) =>
      current.map((message) =>
        message.id === messageId ? { ...message, applied: true } : message,
      ),
    );
  };

  const handleClear = () => {
    if (streaming) return;
    setMessages([]);
    setError(null);
  };

  const handleExportLog = async () => {
    setExportingLog(true);
    setError(null);
    try {
      const path = await exportAiLog();
      if (path) {
        setMessages((current) => [
          ...current,
          {
            id: createMessageId(),
            role: "assistant",
            content: `AI output/error log exported to ${path}.`,
          },
        ]);
      }
    } catch (exportError) {
      setError(
        exportError instanceof Error
          ? exportError.message
          : "Could not export the AI log.",
      );
    } finally {
      setExportingLog(false);
    }
  };

  const modelOptions =
    status?.models && status.models.length > 0
      ? status.models
      : DEFAULT_AI_MODELS;
  const visibleModels = modelOptions.includes(model)
    ? modelOptions
    : [model, ...modelOptions];
  const canChat = Boolean(status?.online) && !streaming;

  return (
    <aside
      className={cn(
        "absolute inset-y-0 right-0 z-20 flex w-[360px] max-w-[calc(100%-1rem)] flex-col border-l border-line bg-panel/95 shadow-2xl shadow-black/40 backdrop-blur-xl transition-transform duration-300 ease-out",
        open ? "translate-x-0" : "pointer-events-none translate-x-full",
      )}
      aria-hidden={!open}
    >
      <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-4">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-violet-400/25 bg-violet-500/10">
            <Sparkles className="h-4.5 w-4.5 text-violet-300" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-slate-100">
              AI Floor Plan Assistant
            </h2>
            <p className="mt-0.5 flex items-center gap-1.5 text-[10px] uppercase tracking-[0.14em] text-slate-500">
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  checking
                    ? "animate-pulse bg-amber-400"
                    : status?.online
                      ? "bg-emerald-400"
                      : "bg-rose-400",
                )}
              />
              {checking
                ? "Checking Ollama"
                : status?.online
                  ? "Local AI Connected: Ollama"
                  : "Offline Mode"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => void refreshStatus()}
            disabled={checking}
            className="rounded-lg p-1.5 text-slate-500 transition hover:bg-white/5 hover:text-slate-200 disabled:opacity-40"
            aria-label="Refresh Ollama status"
            title="Refresh Ollama status"
          >
            <RefreshCw
              className={cn("h-4 w-4", checking && "animate-spin")}
            />
          </button>
          <button
            type="button"
            onClick={() => void handleExportLog()}
            disabled={exportingLog}
            className="rounded-lg p-1.5 text-slate-500 transition hover:bg-white/5 hover:text-accent disabled:opacity-40"
            aria-label="Export AI log file"
            title={`Export AI output/error log · ${aiLogLocation}`}
          >
            {exportingLog ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
          </button>
          <button
            type="button"
            onClick={() => setAiOpen(false)}
            disabled={timeoutDeadline !== null}
            className="rounded-lg p-1.5 text-slate-500 transition hover:bg-white/5 hover:text-slate-200"
            aria-label="Close AI inspector"
            title={
              timeoutDeadline !== null
                ? "Choose whether to cancel or keep waiting first"
                : "Close AI inspector"
            }
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="space-y-3 border-b border-line px-4 py-3">
        <div className="grid grid-cols-2 rounded-lg border border-line bg-black/20 p-0.5">
          {([
            { id: "ask", label: "Ask about plan" },
            { id: "generate", label: "Generate plan" },
          ] as const).map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => setMode(option.id)}
              aria-pressed={mode === option.id}
              className={cn(
                "rounded-md px-2 py-1.5 text-[10px] font-medium transition",
                mode === option.id
                  ? "bg-violet-500/15 text-violet-200"
                  : "text-slate-500 hover:text-slate-200",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <label className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-line bg-black/25 px-2.5 py-1.5">
            <Cpu className="h-3.5 w-3.5 shrink-0 text-slate-500" />
            <select
              value={model}
              onChange={(event) => setModel(event.currentTarget.value)}
              disabled={!status?.online || checking}
              className="min-w-0 flex-1 bg-transparent text-[11px] text-slate-200 outline-none disabled:text-slate-500"
              aria-label="Ollama model"
            >
              {visibleModels.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={handleAudit}
            disabled={streaming}
            aria-label="Run AI Spatial Audit"
            title="Run AI Spatial Audit"
            className="flex items-center gap-1.5 rounded-lg border border-violet-400/25 bg-violet-500/10 px-2.5 py-1.5 text-[11px] font-medium text-violet-200 transition hover:bg-violet-500/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ShieldCheck className="h-3.5 w-3.5" />
            Audit
          </button>
        </div>

        {status && !status.online ? (
          <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.06] p-3 text-[11px] leading-relaxed text-amber-100/90">
            <div className="flex items-center gap-2 font-medium text-amber-200">
              <WifiOff className="h-3.5 w-3.5" />
              Local AI is offline
            </div>
            <p className="mt-1.5 text-amber-100/70">
              Start Ollama, pull a model, then refresh this panel. The offline
              Audit button still runs the deterministic rule engine; AI
              questions and generation need a local model.
            </p>
            <div className="mt-2 space-y-1 rounded-lg border border-amber-500/15 bg-black/25 p-2 font-mono text-[10px] text-amber-100/80">
              <p>ollama run llama3.2</p>
              <p>ollama serve</p>
              <p className="text-amber-100/50">set OLLAMA_ORIGINS=*</p>
            </div>
            {status.error ? (
              <p className="mt-2 break-all text-[10px] text-amber-100/50">
                {status.error}
              </p>
            ) : null}
          </div>
        ) : null}

        {error && status?.online ? (
          <div className="rounded-lg border border-rose-500/20 bg-rose-500/[0.07] px-2.5 py-2 text-[10px] leading-relaxed text-rose-200">
            {error}
          </div>
        ) : null}
        {timeoutDeadline !== null ? (
          <div
            className="rounded-lg border border-amber-400/25 bg-amber-500/[0.08] px-2.5 py-2.5 text-[10px] leading-relaxed text-amber-100"
            role="alertdialog"
            aria-label="Floor-plan generation timeout"
          >
            <p className="font-medium">
              Generation is taking longer than expected. Should we cancel?
            </p>
            <p className="mt-1 text-amber-100/70">
              It will be canceled in {timeoutSecondsLeft} seconds if you don’t
              respond.
            </p>
            <div className="mt-2 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => resolveTimeoutPrompt(false)}
                className="rounded-md border border-line px-2 py-1 text-slate-300 transition hover:bg-white/5"
              >
                Cancel request
              </button>
              <button
                type="button"
                onClick={() => resolveTimeoutPrompt(true)}
                className="rounded-md border border-amber-300/30 bg-amber-300/10 px-2 py-1 text-amber-100 transition hover:bg-amber-300/20"
              >
                Keep waiting
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4"
      >
        {messages.length === 0 ? (
          <div className="rounded-xl border border-line/70 bg-black/20 p-3.5 text-[11px] leading-relaxed text-slate-400">
            <p className="font-medium text-slate-300">
              {mode === "generate" ? "What space do you need?" : "Ask about this floor plan"}
            </p>
            <p className="mt-1">
              {mode === "generate"
                ? "Example: “2-bedroom, 30×24 ft, open kitchen and living room.”"
                : "Run a full audit or ask a focused question such as “Is the entry door wide enough?” or “Which walls look disconnected?”"}
            </p>
            <p className="mt-2 text-[10px] text-slate-500">
              {mode === "generate"
                ? "Review the editable draft before applying it."
                : "Requests go only to the Ollama server on this machine."}
            </p>
          </div>
        ) : null}

        {messages.map((message) => (
          <div
            key={message.id}
            className={cn(
              "rounded-xl border px-3 py-2.5 text-[11px] leading-relaxed",
              message.role === "user"
                ? "ml-6 border-accent/20 bg-accent/[0.08] text-slate-200"
                : "mr-2 border-line/70 bg-panel-raised/70 text-slate-300",
            )}
          >
            <p className="mb-1 text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-500">
              {message.role === "user" ? "You" : "Local AI"}
            </p>
            <p className="whitespace-pre-wrap break-words">
              {message.content ||
                (streaming ? "Thinking locally…" : "No response.")}
            </p>
            {message.plan ? (
              <div className="mt-2.5 rounded-lg border border-violet-400/20 bg-violet-500/[0.06] p-2.5">
                <div className="flex items-center justify-between gap-2 text-[10px]">
                  <span className="font-medium text-violet-200">
                    {message.plan.walls.length} walls · {message.plan.openings.length} openings
                  </span>
                  <span className="text-slate-500">Editable draft</span>
                </div>
                <p className="mt-1 text-[9px] leading-relaxed text-slate-500">
                  Applying replaces the current walls and openings.
                </p>
                <button
                  type="button"
                  onClick={() => handleApplyPlan(message.id, message.plan!)}
                  disabled={message.applied}
                  className={cn(
                    "mt-2 flex w-full items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-[10px] font-medium transition",
                    message.applied
                      ? "border-emerald-500/20 bg-emerald-500/[0.06] text-emerald-300"
                      : "border-violet-400/25 bg-violet-500/10 text-violet-100 hover:bg-violet-500/20",
                  )}
                >
                  {message.applied ? (
                    <>
                      <Check className="h-3 w-3" />
                      Applied to canvas
                    </>
                  ) : (
                    "Replace current plan"
                  )}
                </button>
              </div>
            ) : null}
          </div>
        ))}
      </div>

      <div className="border-t border-line px-4 py-3">
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                if (mode === "generate") void handleGenerate();
                else handleSend();
              }
            }}
            rows={2}
            placeholder={
              status?.online
                ? mode === "generate"
                  ? "e.g. 2-bedroom, 30×24 ft…"
                  : "Ask about circulation, egress, or layout…"
                : "Start Ollama to chat with the local model"
            }
            disabled={!status?.online || streaming}
            className="max-h-28 min-h-[42px] flex-1 resize-none rounded-lg border border-line bg-black/25 px-2.5 py-2 text-[11px] text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-accent/50 focus:ring-2 focus:ring-accent/10 disabled:opacity-50"
          />
          {streaming ? (
            <button
              type="button"
              onClick={stopStreaming}
              className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-lg border border-rose-500/25 bg-rose-500/10 text-rose-300 transition hover:bg-rose-500/20"
              aria-label="Stop generation"
              title="Stop generation"
            >
              <Square className="h-3.5 w-3.5" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() =>
                mode === "generate" ? void handleGenerate() : handleSend()
              }
              disabled={!canChat || !draft.trim()}
              className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-lg border border-accent/25 bg-accent/10 text-accent transition hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="Send question"
              title="Send question"
            >
              {checking ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                mode === "generate" ? (
                  <Sparkles className="h-3.5 w-3.5" />
                ) : (
                  <Send className="h-3.5 w-3.5" />
                )
              )}
            </button>
          )}
        </div>
        <div className="mt-2 flex items-center justify-between text-[10px] text-slate-500">
          <span>
            {status?.online
              ? `${model} · localhost:11434`
              : "Local-only · no cloud calls"}
          </span>
          <button
            type="button"
            onClick={handleClear}
            disabled={streaming || messages.length === 0}
            className="flex items-center gap-1 rounded px-1 py-0.5 transition hover:text-slate-300 disabled:opacity-30"
          >
            <Eraser className="h-3 w-3" />
            Clear
          </button>
        </div>
      </div>
    </aside>
  );
}
