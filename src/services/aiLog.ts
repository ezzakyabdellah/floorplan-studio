import { isTauriRuntime } from "../utils/fileIO";

const AI_LOG_FILENAME = "ai-log.jsonl";
const AI_LOG_DIRECTORY = "ai-logs";
const AI_LOG_STORAGE_KEY = "floorplan-studio:ai-log";
const BROWSER_LOG_MAX_LINES = 5000;

export type AiLogEntry = {
  timestamp: string;
  operation: string;
  model: string;
  outcome: "output" | "error";
  output?: string;
  error?: string;
};

type AiLogEvent = Omit<AiLogEntry, "timestamp">;

let bufferedLines: string[] = [];
let appendQueue: Promise<void> = Promise.resolve();

function encodeEntry(event: AiLogEvent): string {
  const entry: AiLogEntry = {
    ...event,
    timestamp: new Date().toISOString(),
  };
  return `${JSON.stringify(entry)}\n`;
}

function appendToBrowserLog(line: string) {
  if (typeof localStorage === "undefined") {
    bufferedLines = [...bufferedLines, line].slice(-BROWSER_LOG_MAX_LINES);
    return;
  }
  try {
    const current = localStorage.getItem(AI_LOG_STORAGE_KEY) ?? "";
    const lines = `${current}${line}`
      .split("\n")
      .filter(Boolean)
      .slice(-BROWSER_LOG_MAX_LINES);
    localStorage.setItem(AI_LOG_STORAGE_KEY, `${lines.join("\n")}\n`);
  } catch {
    bufferedLines = [...bufferedLines, line].slice(-BROWSER_LOG_MAX_LINES);
  }
}

async function appendLine(line: string) {
  if (!isTauriRuntime()) {
    appendToBrowserLog(line);
    return;
  }
  try {
    const { BaseDirectory, exists, mkdir, open } = await import("@tauri-apps/plugin-fs");
    if (!(await exists(AI_LOG_DIRECTORY, { baseDir: BaseDirectory.AppLocalData }))) {
      await mkdir(AI_LOG_DIRECTORY, {
        baseDir: BaseDirectory.AppLocalData,
        recursive: true,
      });
    }
    const file = await open(`${AI_LOG_DIRECTORY}/${AI_LOG_FILENAME}`, {
      append: true,
      create: true,
      baseDir: BaseDirectory.AppLocalData,
    });
    try {
      await file.write(new TextEncoder().encode(line));
    } finally {
      await file.close();
    }
  } catch {
    // Preserve records if the native log file cannot be reached (for example,
    // during development with a stale Tauri capability manifest).
    appendToBrowserLog(line);
  }
}

/** Append AI output/error records without allowing logging failures to break a request. */
export function logAiEvent(event: AiLogEvent): Promise<void> {
  const line = encodeEntry(event);
  const next = appendQueue.then(() => appendLine(line));
  appendQueue = next.catch(() => undefined);
  return next.catch(() => {
    appendToBrowserLog(line);
  });
}

export function logAiOutput(
  operation: string,
  model: string,
  output: string,
): Promise<void> {
  return logAiEvent({ operation, model, outcome: "output", output });
}

export function logAiError(
  operation: string,
  model: string,
  error: unknown,
): Promise<void> {
  return logAiEvent({
    operation,
    model,
    outcome: "error",
    error: error instanceof Error ? error.message : String(error),
  });
}

export async function readAiLog(): Promise<string> {
  await appendQueue;
  if (isTauriRuntime()) {
    try {
      const { BaseDirectory, readTextFile } = await import("@tauri-apps/plugin-fs");
      return await readTextFile(`${AI_LOG_DIRECTORY}/${AI_LOG_FILENAME}`, {
        baseDir: BaseDirectory.AppLocalData,
      });
    } catch {
      // Return browser-buffered entries if native storage is unavailable.
    }
  }
  if (typeof localStorage !== "undefined") {
    return localStorage.getItem(AI_LOG_STORAGE_KEY) ?? bufferedLines.join("");
  }
  return bufferedLines.join("");
}

export async function getAiLogLocation(): Promise<string> {
  if (!isTauriRuntime()) return "Browser storage · export to ai-log.jsonl";
  const { appLocalDataDir, join } = await import("@tauri-apps/api/path");
  return join(await appLocalDataDir(), AI_LOG_DIRECTORY, AI_LOG_FILENAME);
}

export async function exportAiLog(): Promise<string | null> {
  const contents = await readAiLog();
  const filename = AI_LOG_FILENAME;
  if (!isTauriRuntime()) {
    const url = URL.createObjectURL(
      new Blob([contents], { type: "application/x-ndjson;charset=utf-8" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
    return filename;
  }
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({
    defaultPath: filename,
    filters: [{ name: "AI activity log", extensions: ["jsonl"] }],
  });
  if (!path) return null;
  const { writeTextFile } = await import("@tauri-apps/plugin-fs");
  await writeTextFile(path, contents);
  return path;
}
