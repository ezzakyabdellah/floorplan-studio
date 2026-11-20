import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "../utils/fileIO";

export type AppEnv = {
  path: string;
  exists: boolean;
  values: Record<string, string>;
  missingKeys: string[];
  error?: string;
};

export const REQUIRED_ENV_KEYS = ["GEMINI_API_KEY"] as const;

const BROWSER_PATH =
  "Browser mode — run the app with Tauri to use the per-user config file";

let cached: Promise<AppEnv> | null = null;
let lastWarning = "";

function warnAboutMissing(env: AppEnv): void {
  if (env.missingKeys.length === 0) return;
  if (import.meta.env.MODE === "test") return;
  const message = `[config] Missing required key(s): ${env.missingKeys.join(
    ", ",
  )}. Add them to ${env.path} and reload the app.`;
  if (message === lastWarning) return;
  lastWarning = message;
  console.warn(message);
}

async function readAppEnv(): Promise<AppEnv> {
  if (!isTauriRuntime()) {
    const devKey = import.meta.env.VITE_GEMINI_API_KEY?.trim() ?? "";
    const values: Record<string, string> = devKey
      ? { GEMINI_API_KEY: devKey }
      : {};
    const env: AppEnv = {
      path: BROWSER_PATH,
      exists: false,
      values,
      missingKeys: devKey ? [] : ["GEMINI_API_KEY"],
      error: devKey
        ? "Using VITE_GEMINI_API_KEY for browser development only."
        : undefined,
    };
    warnAboutMissing(env);
    return env;
  }

  try {
    const env = await invoke<AppEnv>("get_app_env");
    warnAboutMissing(env);
    return env;
  } catch (error) {
    console.error("[config] Could not read the Tauri environment file.", error);
    const env: AppEnv = {
      path: "(Tauri config unavailable)",
      exists: false,
      values: {},
      missingKeys: ["GEMINI_API_KEY"],
      error:
        error instanceof Error
          ? error.message
          : "Could not read the Tauri environment file.",
    };
    warnAboutMissing(env);
    return env;
  }
}

/**
 * Load the Tauri-managed `.env` once per session. Use `reloadAppEnv()` after
 * the user edits the file.
 */
export function loadAppEnv(options: { force?: boolean } = {}): Promise<AppEnv> {
  if (!options.force && cached) return cached;
  cached = readAppEnv();
  return cached;
}

export function reloadAppEnv(): Promise<AppEnv> {
  lastWarning = "";
  return loadAppEnv({ force: true });
}
