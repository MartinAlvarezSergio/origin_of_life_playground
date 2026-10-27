import { RecorderFormat, startCanvasRecording } from "./canvasRecorder";

export type OfflineExportOptions = {
  width: number;
  height: number;
  fps: number;
  totalFrames: number;
  /** Draw frame `index` into `ctx` (a fresh off-screen canvas of width × height). */
  renderFrame: (ctx: CanvasRenderingContext2D, index: number) => void;
  filenameStem: string;
  format?: RecorderFormat;
  bitrateBps?: number;
  onProgress: (done: number, total: number, preview: HTMLCanvasElement) => void;
  isCancelled: () => boolean;
};

export type OfflineExportResult = { status: "done" | "cancelled" | "error"; format?: string; message?: string };

const yieldToBrowser = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Render a video frame by frame into an off-screen canvas and encode it (MP4 where the browser
 * can, otherwise a zip of frames), so the result is smooth however slow this computer is.
 */
export async function exportOfflineVideo(opts: OfflineExportOptions): Promise<OfflineExportResult> {
  const canvas = document.createElement("canvas");
  canvas.width = opts.width;
  canvas.height = opts.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return { status: "error", message: "Could not create a drawing surface." };
  }
  const total = Math.max(1, Math.round(opts.totalFrames));
  // Draw the first frame before the recorder probes the encoder with it.
  opts.renderFrame(ctx, 0);

  let errorMessage: string | null = null;
  const recorder = startCanvasRecording({
    canvas,
    format: opts.format ?? "auto",
    cadenceSimUnits: 1 / opts.fps,
    startSimTime: 0,
    fps: opts.fps,
    maxFrames: total + 2,
    bitrateBps: opts.bitrateBps ?? (opts.height >= 1000 ? 12_000_000 : 6_000_000),
    filenameStem: opts.filenameStem,
    onError: (err) => {
      errorMessage = err instanceof Error ? err.message : String(err);
    }
  });
  await recorder.ready();
  if (errorMessage || recorder.status().errorMessage) {
    recorder.cancel();
    return { status: "error", message: errorMessage ?? recorder.status().errorMessage ?? "Recorder failed." };
  }

  for (let i = 0; i < total; i += 1) {
    if (opts.isCancelled()) {
      recorder.cancel();
      return { status: "cancelled" };
    }
    opts.renderFrame(ctx, i);
    // Retry until the frame is taken: the zip writer skips frames while it is busy.
    const before = recorder.status().frameCount;
    for (let tries = 0; tries < 200 && recorder.status().frameCount === before; tries += 1) {
      recorder.maybeCaptureFrame(i / opts.fps);
      if (recorder.status().frameCount === before) {
        await yieldToBrowser(5);
      }
      if (!recorder.status().running) {
        break;
      }
    }
    while (recorder.backlog() > 6) {
      await yieldToBrowser(4);
    }
    if (recorder.status().errorMessage) {
      recorder.cancel();
      return { status: "error", message: recorder.status().errorMessage ?? "Recorder failed." };
    }
    if (i % 4 === 0) {
      opts.onProgress(i, total, canvas);
      await yieldToBrowser();
    }
  }
  opts.onProgress(total, total, canvas);
  const format = recorder.status().format;
  await recorder.stopAndDownload();
  const message = recorder.status().errorMessage;
  return message ? { status: "error", message } : { status: "done", format };
}
