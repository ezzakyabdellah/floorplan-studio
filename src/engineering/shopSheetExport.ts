import { isTauriRuntime } from "../utils/fileIO";

export type ShopSheetFormat = "svg" | "pdf";

function downloadInBrowser(
  filename: string,
  data: string | Uint8Array,
  format: ShopSheetFormat,
) {
  const mime = format === "svg" ? "image/svg+xml;charset=utf-8" : "application/pdf";
  const blob = new Blob([data as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function saveShopSheet(
  format: ShopSheetFormat,
  data: string | Uint8Array,
): Promise<string | null> {
  const filename = `stairs-ladders-shop-sheet.${format}`;
  if (!isTauriRuntime()) {
    downloadInBrowser(filename, data, format);
    return filename;
  }

  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({
    defaultPath: filename,
    filters: [
      {
        name: format === "svg" ? "Scalable Vector Graphics" : "Portable Document Format",
        extensions: [format],
      },
    ],
  });
  if (!path) return null;

  const { writeFile, writeTextFile } = await import("@tauri-apps/plugin-fs");
  if (format === "svg") {
    await writeTextFile(path, data as string);
  } else {
    await writeFile(path, data as Uint8Array);
  }
  return path;
}
