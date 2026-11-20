import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, FolderSearch, RefreshCw, X } from "lucide-react";
import { loadAppEnv } from "../../services/appEnv";
import { reloadAiProvider } from "../../services/aiProvider";
import { isTauriRuntime } from "../../utils/fileIO";

type EnvWarningState = {
  path: string;
  missingKeys: string[];
  error?: string;
};

export function EnvConfigWarning() {
  const [state, setState] = useState<EnvWarningState | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void loadAppEnv().then((env) => {
      if (alive) {
        setState({
          path: env.path,
          missingKeys: env.missingKeys,
          error: env.error,
        });
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  const reload = useCallback(async () => {
    setReloading(true);
    setActionError(null);
    try {
      const status = await reloadAiProvider();
      setState((current) => ({
        path: status.configPath ?? current?.path ?? "",
        missingKeys: status.missingKeys ?? [],
        error: status.error,
      }));
      if ((status.missingKeys ?? []).length === 0) setDismissed(false);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Could not reload the configuration file.";
      setActionError(message);
      console.error("[config]", message);
    } finally {
      setReloading(false);
    }
  }, []);

  const revealFile = useCallback(async () => {
    if (!state || !isTauriRuntime()) return;
    try {
      const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
      await revealItemInDir(state.path);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Could not open the configuration folder.";
      setActionError(message);
      console.error("[config]", message);
    }
  }, [state]);

  if (!state || state.missingKeys.length === 0 || dismissed) return null;

  const canReveal = isTauriRuntime() && !state.path.startsWith("(");

  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-[80] flex justify-center px-4">
      <div
        role="alert"
        className="pointer-events-auto flex w-full max-w-2xl items-start gap-3 rounded-xl border border-amber-400/30 bg-panel/95 px-4 py-3 shadow-2xl shadow-black/50 backdrop-blur-xl"
      >
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-amber-400/25 bg-amber-500/10 text-amber-300">
          <AlertTriangle className="h-4 w-4" />
        </span>

        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-semibold text-amber-100">
            Missing required key: {state.missingKeys.join(", ")}
          </p>
          <p className="mt-1 text-[10px] leading-relaxed text-amber-100/70">
            Gemini API access is disabled until you add the key. Open the file
            below, fill <code className="font-mono">GEMINI_API_KEY</code>, save
            it, then choose Reload.
          </p>
          <code className="mt-1.5 block break-all rounded-md border border-amber-400/15 bg-black/30 px-2 py-1 font-mono text-[10px] text-amber-100/80">
            {state.path}
          </code>
          {state.error ? (
            <p className="mt-1 break-words text-[9px] text-amber-100/50">
              {state.error}
            </p>
          ) : null}
          {actionError ? (
            <p className="mt-1 break-words text-[9px] text-rose-300">
              {actionError}
            </p>
          ) : null}

          <div className="mt-2 flex flex-wrap items-center gap-2">
            {canReveal ? (
              <button
                type="button"
                onClick={() => void revealFile()}
                className="flex items-center gap-1.5 rounded-md border border-amber-400/25 bg-amber-500/10 px-2 py-1 text-[10px] font-medium text-amber-100 transition hover:bg-amber-500/20"
              >
                <FolderSearch className="h-3 w-3" />
                Reveal file
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => void reload()}
              disabled={reloading}
              className="flex items-center gap-1.5 rounded-md border border-amber-400/25 bg-amber-500/10 px-2 py-1 text-[10px] font-medium text-amber-100 transition hover:bg-amber-500/20 disabled:cursor-wait disabled:opacity-50"
            >
              <RefreshCw
                className={`h-3 w-3 ${reloading ? "animate-spin" : ""}`}
              />
              {reloading ? "Reloading…" : "Reload"}
            </button>
            <button
              type="button"
              onClick={() => setDismissed(true)}
              className="rounded-md px-2 py-1 text-[10px] text-amber-100/60 transition hover:bg-white/5 hover:text-amber-100"
            >
              Dismiss
            </button>
          </div>
        </div>

        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss configuration warning"
          className="rounded-md p-1 text-amber-100/50 transition hover:bg-white/5 hover:text-amber-100"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
