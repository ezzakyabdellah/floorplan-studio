import { useCallback, useEffect, useState } from "react";
import { ExternalLink, RefreshCw, Server } from "lucide-react";
import {
  checkOllamaStatus,
  type OllamaStatus,
} from "../../services/localAiService";
import { isTauriRuntime } from "../../utils/fileIO";
import { cn } from "../../utils/cn";

const OLLAMA_DOWNLOAD_URL = "https://ollama.com/download";
const OLLAMA_DOCS_URL =
  "https://github.com/ezzakyabdellah/floorplan-studio/blob/main/docs/gemini-integration.md";

async function openExternal(url: string) {
  if (isTauriRuntime()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

export function RuntimeDependencyStatus() {
  const [status, setStatus] = useState<OllamaStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setChecking(true);
    setActionError(null);
    const next = await checkOllamaStatus();
    setStatus(next);
    setChecking(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleOpen = useCallback(async (url: string) => {
    try {
      await openExternal(url);
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "Could not open the link.",
      );
    }
  }, []);

  const online = status?.online === true;

  return (
    <section className="space-y-2 border-t border-line pt-3">
      <div className="flex items-center justify-between px-1">
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
          Local AI runtime
        </p>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={checking}
          aria-label="Recheck Ollama status"
          title="Recheck Ollama status"
          className="rounded-md p-1 text-slate-500 transition hover:bg-white/5 hover:text-slate-200 disabled:cursor-wait disabled:opacity-50"
        >
          <RefreshCw className={cn("h-3 w-3", checking && "animate-spin")} />
        </button>
      </div>

      <div className="rounded-lg border border-line/70 bg-black/20 p-2.5">
        <div className="flex items-center gap-2">
          <Server className="h-3.5 w-3.5 shrink-0 text-slate-500" />
          <span
            className={cn(
              "h-1.5 w-1.5 shrink-0 rounded-full",
              online ? "bg-emerald-400" : "bg-amber-400",
            )}
          />
          <span className="truncate text-[10px] text-slate-300">
            {checking && !status
              ? "Checking Ollama…"
              : online
                ? "Ollama is online"
                : "Ollama is not running"}
          </span>
        </div>

        {online && status.models.length > 0 ? (
          <p className="mt-1.5 truncate pl-[22px] font-mono text-[9px] text-slate-500">
            {status.models.length} model{status.models.length === 1 ? "" : "s"}{" "}
            available
          </p>
        ) : null}

        {status && !online ? (
          <>
            <p className="mt-1.5 pl-[22px] text-[9px] leading-relaxed text-slate-500">
              The ONNX vision model is bundled. For chat and generation, install
              Ollama or start it, then run{" "}
              <code className="font-mono text-slate-400">
                ollama pull llama3.2
              </code>
              .
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5 pl-[22px]">
              <button
                type="button"
                onClick={() => void handleOpen(OLLAMA_DOWNLOAD_URL)}
                className="flex items-center gap-1 rounded-md border border-accent/25 bg-accent/10 px-2 py-1 text-[9px] font-medium text-accent transition hover:bg-accent/20"
              >
                <ExternalLink className="h-3 w-3" />
                Install Ollama
              </button>
              <button
                type="button"
                onClick={() => void handleOpen(OLLAMA_DOCS_URL)}
                className="rounded-md border border-line px-2 py-1 text-[9px] text-slate-400 transition hover:bg-white/5 hover:text-slate-200"
              >
                Setup docs
              </button>
            </div>
          </>
        ) : null}

        {actionError ? (
          <p className="mt-1.5 pl-[22px] text-[9px] text-rose-300">
            {actionError}
          </p>
        ) : null}
      </div>
    </section>
  );
}
