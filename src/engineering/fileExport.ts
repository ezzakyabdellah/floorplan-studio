import { isTauriRuntime } from "../utils/fileIO";

export type EngineeringFileData = string | Uint8Array;

const MIME: Record<string, string> = {
  csv: "text/csv;charset=utf-8",
  dxf: "application/dxf",
  stl: "model/stl",
  pdf: "application/pdf",
};

export async function saveEngineeringFile(
  filename: string,
  extension: keyof typeof MIME,
  data: EngineeringFileData,
): Promise<string | null> {
  if (!isTauriRuntime()) {
    const blob = new Blob([data as BlobPart], { type: MIME[extension] });
    const url = URL.createObjectURL(blob);
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
    filters: [{ name: `${extension.toUpperCase()} file`, extensions: [extension] }],
  });
  if (!path) return null;
  const { writeFile, writeTextFile } = await import("@tauri-apps/plugin-fs");
  if (typeof data === "string") await writeTextFile(path, data);
  else await writeFile(path, data);
  return path;
}
