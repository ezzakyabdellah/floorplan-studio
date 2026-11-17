import { isTauriRuntime } from "../utils/fileIO";

export async function exportViewportPng(
  canvas: HTMLCanvasElement,
): Promise<string | null> {
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (image) =>
        image
          ? resolve(image)
          : reject(new Error("Could not capture the 3D viewport.")),
      "image/png",
    );
  });
  const filename = "stairs-ladders-3d-view.png";

  if (!isTauriRuntime()) {
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
    filters: [{ name: "PNG image", extensions: ["png"] }],
  });
  if (!path) return null;
  const { writeFile } = await import("@tauri-apps/plugin-fs");
  await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
  return path;
}
