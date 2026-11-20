import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Bug,
  CheckCircle2,
  FileImage,
  ImagePlus,
  Loader2,
  Replace,
  ScanLine,
  SlidersHorizontal,
  Sparkles,
  Upload,
  Wand2,
  X,
} from "lucide-react";
import { useFloorPlanStore } from "../../store/floorPlanStore";
import {
  displayLengthToFeet,
  feetToDisplayLength,
  floorPlanInputStep,
  formatFeetNumber,
} from "../../utils/floorPlanUnits";
import {
  loadImageFromFile,
  renderBlueprintPreview,
  type ImageVectorOptions,
  type PreviewStats,
} from "../../utils/imageToVector";
import {
  VISION_MODEL_URL,
  checkVisionModelAvailability,
  extractVectorsFromImage,
  type VisionModelAvailability,
  type VisionSource,
} from "../../services/visionModelService";
import { debugVisionPipeline } from "../../services/visionDebug";
import { cn } from "../../utils/cn";

type VectorEngine = "vision" | "heuristic";

type ImportInfo = {
  source: VisionSource;
  fallbackReason?: string;
};

type ImageImporterProps = {
  open: boolean;
  onClose: () => void;
  onImported: (
    wallCount: number,
    openingCount: number,
    name: string,
    info?: ImportInfo,
  ) => void;
};

const ACCEPTED_TYPES = ["image/png", "image/jpeg"];

function baseName(file: File) {
  return file.name.replace(/\.[^.]+$/, "").trim() || "Blueprint Import";
}

export function ImageImporter({
  open,
  onClose,
  onImported,
}: ImageImporterProps) {
  const importPlan = useFloorPlanStore((state) => state.importPlan);
  const unit = useFloorPlanStore((state) => state.unit);

  const [file, setFile] = useState<File | null>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [threshold, setThreshold] = useState(115);
  const [contrast, setContrast] = useState(100);
  const [invert, setInvert] = useState(false);
  const [feetPer100Pixels, setFeetPer100Pixels] = useState(10);
  const [replace, setReplace] = useState(true);
  const [engine, setEngine] = useState<VectorEngine>("vision");
  const [modelStatus, setModelStatus] =
    useState<VisionModelAvailability | null>(null);
  const [checkingModel, setCheckingModel] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewStats | null>(null);
  const [loadingImage, setLoadingImage] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [vectorizing, setVectorizing] = useState(false);
  const [debugging, setDebugging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragDepth = useRef(0);
  const previewToken = useRef(0);
  const busy = loadingImage || rendering || vectorizing || debugging;

  const options = useMemo<ImageVectorOptions>(
    () => ({
      threshold,
      contrast,
      invert,
      feetPer100Pixels,
      maxDimension: 1400,
    }),
    [threshold, contrast, invert, feetPer100Pixels],
  );

  const reset = useCallback(() => {
    setFile(null);
    setImage(null);
    setPreview(null);
    setError(null);
    setDragging(false);
    setLoadingImage(false);
    setRendering(false);
    setVectorizing(false);
    setStage(null);
    dragDepth.current = 0;
    previewToken.current += 1;
  }, []);

  useEffect(() => {
    if (!open) reset();
  }, [open, reset]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setCheckingModel(true);
    checkVisionModelAvailability(true)
      .then((status) => {
        if (!cancelled) setModelStatus(status);
      })
      .finally(() => {
        if (!cancelled) setCheckingModel(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !vectorizing) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose, vectorizing]);

  useEffect(() => {
    if (!image || !open) return;
    const token = previewToken.current + 1;
    previewToken.current = token;
    setRendering(true);
    const timer = window.setTimeout(() => {
      const canvas = canvasRef.current;
      if (!canvas) {
        setRendering(false);
        return;
      }
      renderBlueprintPreview(image, options, canvas, 760)
        .then((stats) => {
          if (previewToken.current !== token) return;
          setPreview(stats);
          setError(null);
        })
        .catch((previewError) => {
          if (previewToken.current !== token) return;
          setPreview(null);
          setError(
            previewError instanceof Error
              ? previewError.message
              : "Could not build the preview.",
          );
        })
        .finally(() => {
          if (previewToken.current === token) setRendering(false);
        });
    }, 140);

    return () => window.clearTimeout(timer);
  }, [image, open, options]);

  const handleFile = useCallback(async (nextFile: File | null) => {
    if (!nextFile) return;
    if (!ACCEPTED_TYPES.includes(nextFile.type)) {
      setError("Choose a PNG or JPG image.");
      return;
    }
    setError(null);
    setPreview(null);
    setLoadingImage(true);
    try {
      const loaded = await loadImageFromFile(nextFile);
      setFile(nextFile);
      setImage(loaded);
    } catch (loadError) {
      setFile(null);
      setImage(null);
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Could not read that image.",
      );
    } finally {
      setLoadingImage(false);
    }
  }, []);

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    const dropped = event.dataTransfer.files?.[0] ?? null;
    void handleFile(dropped);
  };

  const handleConfirm = async () => {
    if (!file || vectorizing) return;
    if (engine === "heuristic" && !preview) return;
    setVectorizing(true);
    setError(null);
    setStage(
      engine === "vision" && modelStatus?.available
        ? "Running Local ONNX Vision Model..."
        : "Vectorizing blueprint...",
    );
    try {
      const plan = await extractVectorsFromImage(file, {
        ...options,
        preferHeuristic: engine === "heuristic",
      });
      const name = baseName(file);
      const result = importPlan(plan.walls, plan.openings, {
        replace,
        name: replace ? name : undefined,
      });
      onImported(result.wallCount, result.openingCount, name, {
        source: plan.source,
        fallbackReason: plan.fallbackReason,
      });
      onClose();
    } catch (importError) {
      setError(
        importError instanceof Error
          ? importError.message
          : "Could not convert that blueprint.",
      );
    } finally {
      setVectorizing(false);
      setStage(null);
    }
  };

  const handleDebugOnnx = async () => {
    if (!file || debugging) return;
    setDebugging(true);
    setError(null);
    try {
      await debugVisionPipeline(file, options);
    } catch (debugError) {
      setError(
        debugError instanceof Error
          ? debugError.message
          : "ONNX debug run failed.",
      );
    } finally {
      setDebugging(false);
    }
  };

  if (!open) return null;

  const coverage =
    preview && preview.width * preview.height > 0
      ? (preview.wallPixels / (preview.width * preview.height)) * 100
      : 0;
  const canImport =
    Boolean(file) &&
    !busy &&
    (engine === "vision" || Boolean(preview && preview.wallPixels > 0));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !vectorizing) onClose();
      }}
    >
      <div className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-2xl shadow-black/60">
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-accent/25 bg-accent/10">
              <ImagePlus className="h-5 w-5 text-accent" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-slate-100">
                Import Blueprint
              </h2>
              <p className="mt-0.5 text-[11px] text-slate-500">
                Convert a PNG or JPG floor plan into editable 3D walls.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={vectorizing}
            className="rounded-lg p-1.5 text-slate-500 transition hover:bg-white/5 hover:text-slate-200 disabled:opacity-40"
            aria-label="Close blueprint importer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="grid gap-4 md:grid-cols-[1.35fr_1fr]">
            <div className="space-y-3">
              <div
                onDragEnter={(event) => {
                  event.preventDefault();
                  dragDepth.current += 1;
                  setDragging(true);
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={(event) => {
                  event.preventDefault();
                  dragDepth.current = Math.max(0, dragDepth.current - 1);
                  if (dragDepth.current === 0) setDragging(false);
                }}
                onDrop={handleDrop}
                className={cn(
                  "relative flex min-h-[236px] flex-col overflow-hidden rounded-xl border border-dashed transition",
                  dragging
                    ? "border-accent/60 bg-accent/[0.08]"
                    : "border-line bg-black/25",
                )}
              >
                {image ? (
                  <div className="flex h-[236px] items-center justify-center p-2">
                    <canvas
                      ref={canvasRef}
                      className="max-h-full max-w-full rounded-lg border border-line/60"
                    />
                    {rendering ? (
                      <div className="absolute inset-0 flex items-center justify-center bg-black/45">
                        <span className="flex items-center gap-2 rounded-lg border border-line bg-panel/90 px-3 py-2 text-[11px] text-slate-300">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          Rebuilding preview
                        </span>
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
                    <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-line bg-panel-raised">
                      {loadingImage ? (
                        <Loader2 className="h-5 w-5 animate-spin text-accent" />
                      ) : (
                        <FileImage className="h-5 w-5 text-slate-500" />
                      )}
                    </div>
                    <div>
                      <p className="text-[12px] font-medium text-slate-300">
                        Drop a blueprint here
                      </p>
                      <p className="mt-1 text-[10px] text-slate-500">
                        PNG or JPG · processed locally on this machine
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => inputRef.current?.click()}
                      className="flex items-center gap-1.5 rounded-lg border border-accent/25 bg-accent/10 px-3 py-1.5 text-[11px] font-medium text-accent transition hover:bg-accent/20"
                    >
                      <Upload className="h-3.5 w-3.5" />
                      Choose image
                    </button>
                  </div>
                )}

                {dragging ? (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-xl border-2 border-accent/60 bg-accent/10">
                    <span className="flex items-center gap-2 rounded-lg border border-accent/30 bg-panel/95 px-3 py-2 text-[11px] text-accent">
                      <Upload className="h-4 w-4" />
                      Drop to preview
                    </span>
                  </div>
                ) : null}
              </div>

              <input
                ref={inputRef}
                type="file"
                accept="image/png,image/jpeg"
                className="hidden"
                onChange={(event) => {
                  void handleFile(event.currentTarget.files?.[0] ?? null);
                  event.currentTarget.value = "";
                }}
              />

              {file ? (
                <div className="flex items-center justify-between gap-3 rounded-lg border border-line/70 bg-black/20 px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-[11px] font-medium text-slate-300">
                      {file.name}
                    </p>
                    <p className="text-[10px] text-slate-500">
                      {preview
                        ? `${preview.width} × ${preview.height} px · ${coverage.toFixed(1)}% wall coverage`
                        : "Preparing preview…"}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => inputRef.current?.click()}
                    disabled={busy}
                    className="shrink-0 rounded-lg border border-line px-2 py-1 text-[10px] text-slate-400 transition hover:bg-white/5 hover:text-slate-200 disabled:opacity-40"
                  >
                    Change
                  </button>
                </div>
              ) : null}
            </div>

            <div className="space-y-4">
              <div className="rounded-xl border border-line/70 bg-black/20 p-3">
                <p className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                  <ScanLine className="h-3.5 w-3.5" />
                  Vector engine
                </p>

                <div className="grid grid-cols-2 gap-1 rounded-lg border border-line bg-black/25 p-0.5">
                  <button
                    type="button"
                    onClick={() => setEngine("vision")}
                    className={cn(
                      "flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] font-medium transition",
                      engine === "vision"
                        ? "bg-accent/15 text-accent"
                        : "text-slate-400 hover:text-slate-200",
                    )}
                    aria-pressed={engine === "vision"}
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    AI Vision
                  </button>
                  <button
                    type="button"
                    onClick={() => setEngine("heuristic")}
                    className={cn(
                      "flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] font-medium transition",
                      engine === "heuristic"
                        ? "bg-accent/15 text-accent"
                        : "text-slate-400 hover:text-slate-200",
                    )}
                    aria-pressed={engine === "heuristic"}
                  >
                    <Wand2 className="h-3.5 w-3.5" />
                    Heuristic
                  </button>
                </div>

                <div
                  className={cn(
                    "mt-2 flex items-start gap-1.5 rounded-lg border px-2 py-1.5 text-[10px] leading-relaxed",
                    checkingModel
                      ? "border-line bg-panel/60 text-slate-400"
                      : modelStatus?.available
                        ? "border-emerald-500/20 bg-emerald-500/[0.06] text-emerald-200"
                        : "border-amber-500/20 bg-amber-500/[0.06] text-amber-200",
                  )}
                >
                  {checkingModel ? (
                    <Loader2 className="mt-0.5 h-3 w-3 shrink-0 animate-spin" />
                  ) : modelStatus?.available ? (
                    <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0" />
                  ) : (
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                  )}
                  <span>
                    {checkingModel
                      ? "Checking for a local ONNX model..."
                      : modelStatus?.available
                        ? "ONNX model ready - inference runs offline."
                        : "No ONNX model found - the heuristic fallback will be used."}
                  </span>
                </div>

                {!checkingModel && !modelStatus?.available ? (
                  <p className="mt-2 break-all font-mono text-[9px] leading-relaxed text-slate-500">
                    Add weights at {VISION_MODEL_URL}
                  </p>
                ) : null}
              </div>

              <div className="rounded-xl border border-line/70 bg-black/20 p-3">
                <p className="mb-3 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                  <SlidersHorizontal className="h-3.5 w-3.5" />
                  Detection
                </p>

                <label className="block">
                  <span className="mb-1 flex items-center justify-between text-[10px] font-medium uppercase tracking-[0.12em] text-slate-500">
                    <span>Threshold</span>
                    <span className="font-mono normal-case tracking-normal text-slate-400">
                      {threshold}
                    </span>
                  </span>
                  <input
                    type="range"
                    min={40}
                    max={220}
                    step={1}
                    value={threshold}
                    onChange={(event) =>
                      setThreshold(event.currentTarget.valueAsNumber)
                    }
                    className="w-full"
                  />
                </label>

                <label className="mt-3 block">
                  <span className="mb-1 flex items-center justify-between text-[10px] font-medium uppercase tracking-[0.12em] text-slate-500">
                    <span>Contrast</span>
                    <span className="font-mono normal-case tracking-normal text-slate-400">
                      {contrast}%
                    </span>
                  </span>
                  <input
                    type="range"
                    min={50}
                    max={220}
                    step={1}
                    value={contrast}
                    onChange={(event) =>
                      setContrast(event.currentTarget.valueAsNumber)
                    }
                    className="w-full"
                  />
                </label>

                <label className="mt-3 flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-line/70 bg-panel/60 px-2.5 py-2">
                  <span className="text-[11px] text-slate-300">
                    Light lines on dark
                  </span>
                  <input
                    type="checkbox"
                    checked={invert}
                    onChange={(event) => setInvert(event.currentTarget.checked)}
                    className="h-3.5 w-3.5 accent-sky-400"
                  />
                </label>

                <label className="mt-3 block">
                  <span className="mb-1 flex items-center justify-between text-[10px] font-medium uppercase tracking-[0.12em] text-slate-500">
                    <span>Scale</span>
                    <span className="font-mono normal-case tracking-normal text-slate-400">
                      {formatFeetNumber(feetPer100Pixels, unit)} {unit} / 100 px
                    </span>
                  </span>
                  <input
                    type="number"
                    min={feetToDisplayLength(1, unit)}
                    max={feetToDisplayLength(100, unit)}
                    step={floorPlanInputStep(unit)}
                    value={Number(
                      feetToDisplayLength(feetPer100Pixels, unit).toFixed(3),
                    )}
                    onChange={(event) => {
                      const next = event.currentTarget.valueAsNumber;
                      if (Number.isFinite(next)) {
                        setFeetPer100Pixels(
                          Math.max(
                            1,
                            Math.min(100, displayLengthToFeet(next, unit)),
                          ),
                        );
                      }
                    }}
                    className="w-full rounded-lg border border-line bg-black/25 px-2.5 py-1.5 font-mono text-[12px] text-slate-100 outline-none transition focus:border-accent/50 focus:ring-2 focus:ring-accent/10"
                  />
                </label>
              </div>

              <div className="rounded-xl border border-line/70 bg-black/20 p-3">
                <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                  Import mode
                </p>
                <div className="grid grid-cols-2 gap-1 rounded-lg border border-line bg-black/25 p-0.5">
                  <button
                    type="button"
                    onClick={() => setReplace(true)}
                    className={cn(
                      "flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] font-medium transition",
                      replace
                        ? "bg-accent/15 text-accent"
                        : "text-slate-400 hover:text-slate-200",
                    )}
                    aria-pressed={replace}
                  >
                    <Replace className="h-3.5 w-3.5" />
                    Replace
                  </button>
                  <button
                    type="button"
                    onClick={() => setReplace(false)}
                    className={cn(
                      "flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] font-medium transition",
                      !replace
                        ? "bg-accent/15 text-accent"
                        : "text-slate-400 hover:text-slate-200",
                    )}
                    aria-pressed={!replace}
                  >
                    <Wand2 className="h-3.5 w-3.5" />
                    Append
                  </button>
                </div>
                <p className="mt-2 text-[10px] leading-relaxed text-slate-500">
                  {replace
                    ? "Replace clears the current walls and openings before importing."
                    : "Append keeps the current scene and adds the detected walls and openings."}
                </p>
              </div>

              {error ? (
                <div className="flex items-start gap-2 rounded-lg border border-rose-500/20 bg-rose-500/[0.07] px-2.5 py-2 text-[10px] leading-relaxed text-rose-200">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {error}
                </div>
              ) : null}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-3">
          <p className="text-[10px] text-slate-500">
            {engine === "vision" && !modelStatus?.available
              ? "ONNX weights missing. The heuristic vectorizer will run instead."
              : "Wall gaps and symbols are detected as doors or windows."}
          </p>
          <div className="flex items-center gap-2">
            {import.meta.env.DEV ? (
              <button
                type="button"
                onClick={() => void handleDebugOnnx()}
                disabled={!file || busy}
                title="Run the real ONNX model and log every stage (no heuristic fallback)"
                className="flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[11px] font-medium text-slate-400 transition hover:bg-white/5 hover:text-slate-200 disabled:opacity-40"
              >
                {debugging ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Bug className="h-3.5 w-3.5" />
                )}
                Debug ONNX
              </button>
            ) : null}
            <button
              type="button"
              onClick={onClose}
              disabled={vectorizing}
              className="rounded-lg border border-line px-3 py-1.5 text-[11px] font-medium text-slate-400 transition hover:bg-white/5 hover:text-slate-200 disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleConfirm()}
              disabled={!canImport}
              className="flex items-center gap-1.5 rounded-lg border border-accent/30 bg-accent/15 px-3 py-1.5 text-[11px] font-semibold text-accent transition hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {vectorizing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : engine === "vision" ? (
                <Sparkles className="h-3.5 w-3.5" />
              ) : (
                <Wand2 className="h-3.5 w-3.5" />
              )}
              {vectorizing
                ? (stage ?? "Processing plan...")
                : engine === "vision"
                  ? "Extract Vectors with AI"
                  : "Process Blueprint into 3D"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
