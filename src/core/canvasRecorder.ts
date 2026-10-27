/**
 * Sim-time-paced canvas recorder.
 *
 * Frames are captured when the simulation time crosses the next cadence boundary,
 * so a slow Barnes-Hut run still produces a smooth video at playback fps.
 *
 * Three output formats:
 *   - "mp4":      H.264 via WebCodecs + mp4-muxer (single .mp4 download)
 *   - "webp-zip": canvas.toBlob('image/webp') frames in a JSZip
 *   - "png-zip":  canvas.toBlob('image/png')  frames in a JSZip
 *
 * "auto" picks "mp4" when WebCodecs reports support for H.264 baseline,
 * otherwise falls back to "webp-zip".
 */

// Note: we intentionally use *static* imports for mp4-muxer and jszip rather
// than dynamic `await import(...)`. With dynamic imports we hit a recurring
// Vite-dev "stale optimized dep" failure: when Vite re-bundles a dep, the
// tab keeps the old chunk URL and the runtime fetch 404s, killing the
// recorder before it ever captures a frame. Static imports give us a stable
// module graph and add ~40 KB gzipped to the initial bundle, which is a
// trivial cost for the reliability win.
import { Muxer as Mp4Muxer, ArrayBufferTarget as Mp4ArrayBufferTarget } from "mp4-muxer";
import JSZip from "jszip";

export type RecorderFormat = "auto" | "mp4" | "webp-zip" | "png-zip";
export type ResolvedFormat = Exclude<RecorderFormat, "auto">;

export type RecorderStatus = {
  running: boolean;
  finalizing: boolean;
  frameCount: number;
  estimatedBytes: number;
  format: ResolvedFormat;
  errorMessage: string | null;
};

export type CanvasRecorder = {
  /** Call once per RAF, after the canvas has been drawn. Captures iff simTime crossed the next cadence boundary. */
  maybeCaptureFrame(simTime: number): void;
  status(): RecorderStatus;
  /** Stop capturing, finalize, and trigger browser download. */
  stopAndDownload(): Promise<void>;
  /** Discard buffered frames without downloading. */
  cancel(): void;
  /** Resolves once the encoder (or zip writer) is set up; frames offered before that are skipped. */
  ready(): Promise<void>;
  /** Frames handed over but not yet encoded; offline renderers wait while this is high. */
  backlog(): number;
};

export type CanvasRecorderOptions = {
  canvas: HTMLCanvasElement;
  format: RecorderFormat;
  cadenceSimUnits: number;
  startSimTime: number;
  fps?: number;
  maxFrames?: number;
  bitrateBps?: number;
  filenameStem?: string;
  onError?: (err: unknown) => void;
};

const DEFAULT_FPS = 30;
const DEFAULT_MAX_FRAMES = 2000;
const DEFAULT_BITRATE = 4_000_000;

type WebCodecsGlobals = {
  VideoEncoder?: typeof VideoEncoder;
  VideoFrame?: typeof VideoFrame;
};

function webCodecsGlobals(): WebCodecsGlobals {
  const g = globalThis as unknown as WebCodecsGlobals;
  return { VideoEncoder: g.VideoEncoder, VideoFrame: g.VideoFrame };
}

/**
 * Synchronous best-effort feature-detect. Returns true if the browser exposes
 * VideoEncoder + VideoFrame; the actual codec config is only verified async at start time.
 */
export function isMp4SupportedSync(): boolean {
  const { VideoEncoder, VideoFrame } = webCodecsGlobals();
  return typeof VideoEncoder === "function" && typeof VideoFrame === "function";
}

function nowStamp(): string {
  const d = new Date();
  const pad = (n: number): string => n.toString().padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function frameIndexFor(t: number, t0: number, cadence: number): number {
  if (cadence <= 0) return 0;
  return Math.floor((t - t0) / cadence + 1e-9);
}

type ZipMode = "webp-zip" | "png-zip";

function zipMimeFor(mode: ZipMode): { mime: string; ext: string; quality?: number } {
  return mode === "webp-zip"
    ? { mime: "image/webp", ext: "webp", quality: 0.92 }
    : { mime: "image/png", ext: "png" };
}

type Mp4State = {
  type: "mp4";
  encoder: VideoEncoder;
  muxer: Mp4Muxer<Mp4ArrayBufferTarget>;
  target: Mp4ArrayBufferTarget;
  width: number;
  height: number;
  fps: number;
};

type ZipState = {
  type: "zip";
  mode: ZipMode;
  zip: JSZipLike;
  pending: Promise<unknown>[];
};

type State = Mp4State | ZipState;

type JSZipLike = {
  file: (name: string, data: Blob) => void;
  generateAsync: (opts: { type: "blob" }) => Promise<Blob>;
};

// H.264 codec strings to probe, ordered by how widely they are accepted.
// Keeping this list short keeps probing cheap on the click-to-start path.
const H264_CODECS = [
  "avc1.42001F", // Baseline 3.1
  "avc1.42E01F", // Constrained Baseline 3.1
  "avc1.4D001F", // Main 3.1
  "avc1.64001F", // High 3.1
  // Level 3.1 tops out near 720p; level 4.0 covers 1920×1080.
  "avc1.640028", // High 4.0
  "avc1.4D0028", // Main 4.0
  "avc1.42E028" // Constrained Baseline 4.0
];

/**
 * End-to-end smoke test: actually encode one frame and await flush() on a
 * throwaway encoder. This catches the case where isConfigSupported says yes
 * but the real encoder errors asynchronously on the first frame — common
 * on some macOS / Chrome combinations.
 */
async function probeMp4Codec(
  canvas: HTMLCanvasElement,
  codec: string,
  width: number,
  height: number,
  fps: number,
  bitrateBps: number
): Promise<string | null> {
  const { VideoEncoder, VideoFrame } = webCodecsGlobals();
  if (!VideoEncoder || !VideoFrame) return null;
  let asyncError: unknown = null;
  let probeEncoder: VideoEncoder | null = null;
  try {
    probeEncoder = new VideoEncoder({
      output: () => {},
      error: (e) => {
        asyncError = e;
      }
    });
    probeEncoder.configure({
      codec,
      width,
      height,
      bitrate: bitrateBps,
      framerate: fps
    });
    const durUs = Math.round(1_000_000 / fps);
    // Canvas may be tainted or invalid for VideoFrame on this browser; if so,
    // the constructor throws synchronously and we fall through to the outer
    // catch that records the failure as a probe error.
    const vf: VideoFrame = new VideoFrame(canvas, { timestamp: 0, duration: durUs });
    try {
      probeEncoder.encode(vf, { keyFrame: true });
    } finally {
      vf.close();
    }
    await probeEncoder.flush();
    // Some browsers fire the async error callback shortly *after* flush resolves;
    // give the event loop a brief moment to surface it before we declare success.
    await new Promise<void>((r) => setTimeout(r, 25));
  } catch (err) {
    asyncError = err;
  } finally {
    try {
      probeEncoder?.close();
    } catch {
      // ignore
    }
  }
  if (asyncError) {
    return null;
  }
  return codec;
}

/** Return a configured Mp4 state, or null if no H.264 codec config can encode end-to-end. */
async function tryStartMp4(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  fps: number,
  bitrateBps: number,
  onError: (err: unknown) => void
): Promise<Mp4State | null> {
  const { VideoEncoder } = webCodecsGlobals();
  if (!VideoEncoder) {
    return null;
  }

  let chosenCodec: string | null = null;
  for (const codec of H264_CODECS) {
    try {
      const support = await VideoEncoder.isConfigSupported({
        codec,
        width,
        height,
        bitrate: bitrateBps,
        framerate: fps
      });
      if (!support.supported) {
        continue;
      }
    } catch {
      continue;
    }
    // Real end-to-end smoke test on a throwaway encoder.
    const verified = await probeMp4Codec(canvas, codec, width, height, fps, bitrateBps);
    if (verified) {
      chosenCodec = verified;
      break;
    }
  }
  if (!chosenCodec) {
    return null;
  }

  const target = new Mp4ArrayBufferTarget();
  const muxer = new Mp4Muxer({
    target,
    video: {
      codec: "avc",
      width,
      height,
      frameRate: fps
    },
    fastStart: "in-memory",
    firstTimestampBehavior: "offset"
  });

  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      try {
        muxer.addVideoChunk(chunk, meta);
      } catch (err) {
        onError(err);
      }
    },
    error: (err) => onError(err)
  });
  try {
    encoder.configure({
      codec: chosenCodec,
      width,
      height,
      bitrate: bitrateBps,
      framerate: fps
    });
  } catch (err) {
    try {
      encoder.close();
    } catch {
      // ignore
    }
    throw err;
  }

  return { type: "mp4", encoder, muxer, target, width, height, fps };
}

function startZip(mode: ZipMode): ZipState {
  const zip = new JSZip() as unknown as JSZipLike;
  return {
    type: "zip",
    mode,
    zip,
    pending: []
  };
}

export function startCanvasRecording(opts: CanvasRecorderOptions): CanvasRecorder {
  const fps = opts.fps ?? DEFAULT_FPS;
  const maxFrames = Math.max(1, Math.floor(opts.maxFrames ?? DEFAULT_MAX_FRAMES));
  const bitrate = Math.max(100_000, Math.floor(opts.bitrateBps ?? DEFAULT_BITRATE));
  const filenameStem = opts.filenameStem ?? "recording";
  const onError = opts.onError ?? (() => {});

  // Resolve a tentative format synchronously so the UI has something to show
  // immediately; "auto" may downgrade to webp-zip if MP4 init fails async.
  const requested: RecorderFormat = opts.format;
  let resolved: ResolvedFormat =
    requested === "auto"
      ? isMp4SupportedSync()
        ? "mp4"
        : "webp-zip"
      : requested;

  const width = opts.canvas.width;
  const height = opts.canvas.height;
  const cadence = Math.max(1e-9, opts.cadenceSimUnits);

  let state: State | null = null;
  let initError: string | null = null;
  let running = true;
  let finalizing = false;
  let frameCount = 0;
  let estimatedBytes = 0;
  let nextFrameIndex = 0;
  let zipInflight = 0;
  let zipWebpUnsupported = false;
  const ZIP_INFLIGHT_CAP = 4;

  const handleError = (err: unknown): void => {
    initError = err instanceof Error ? err.message : String(err);
    running = false;
    // Use console.error so it shows up clearly in DevTools.
    console.error("[canvasRecorder] error:", err);
    try {
      onError(err);
    } catch {
      // swallow
    }
  };

  const initFlow = async (): Promise<void> => {
    if (resolved === "mp4") {
      let mp4: Mp4State | null = null;
      try {
        mp4 = await tryStartMp4(opts.canvas, width, height, fps, bitrate, handleError);
      } catch (err) {
        if (requested !== "auto") {
          throw err;
        }
        console.warn("[canvasRecorder] MP4 init failed; falling back to WebP-zip:", err);
      }
      if (mp4) {
        if (running) {
          state = mp4;
        } else {
          try {
            mp4.encoder.close();
          } catch {
            // ignore
          }
        }
        return;
      }
      if (requested === "auto") {
        console.warn(
          "[canvasRecorder] MP4 unavailable or probe-failed on this browser; falling back to WebP-zip."
        );
        resolved = "webp-zip";
      } else {
        throw new Error("MP4 (H.264) not supported by this browser");
      }
    }
    const zip = startZip(resolved as ZipMode);
    if (running) {
      state = zip;
    }
  };
  const initPromise: Promise<void> = initFlow().catch(handleError);

  function captureMp4(canvas: HTMLCanvasElement, mp4: Mp4State, idx: number): boolean {
    const { VideoFrame } = webCodecsGlobals();
    if (!VideoFrame) {
      handleError(new Error("VideoFrame not available"));
      return false;
    }
    const tsUs = Math.round((idx * 1_000_000) / mp4.fps);
    const durUs = Math.round(1_000_000 / mp4.fps);
    let vf: VideoFrame;
    try {
      // VideoFrame from a canvas snapshots pixels synchronously: no GPU
      // round-trip via createImageBitmap, no race with the next paint.
      vf = new VideoFrame(canvas, { timestamp: tsUs, duration: durUs });
    } catch (err) {
      handleError(err);
      return false;
    }
    try {
      mp4.encoder.encode(vf, { keyFrame: idx % 60 === 0 });
    } catch (err) {
      handleError(err);
      return false;
    } finally {
      vf.close();
    }
    return true;
  }

  function captureZip(canvas: HTMLCanvasElement, zipState: ZipState, idx: number): boolean {
    if (zipInflight >= ZIP_INFLIGHT_CAP) {
      // Drop this opportunity to avoid unbounded memory while toBlob catches up.
      return false;
    }
    // If we previously discovered WebP isn't supported by this browser, treat
    // a webp-zip recording as a png-zip recording for the rest of the run.
    const effectiveMode = zipState.mode === "webp-zip" && zipWebpUnsupported ? "png-zip" : zipState.mode;
    const { mime, ext, quality } = zipMimeFor(effectiveMode);
    zipInflight += 1;
    const p = new Promise<void>((resolve, reject) => {
      const cb = (blob: Blob | null): void => {
        if (!blob) {
          // canvas.toBlob returns null for unsupported mime types on some browsers
          // (notably Safari for image/webp). On the very first frame, downgrade
          // silently to PNG so the recording still produces output. Otherwise,
          // surface as an error.
          if (effectiveMode === "webp-zip" && frameCount === 0) {
            zipWebpUnsupported = true;
            console.warn(
              "[canvasRecorder] image/webp not supported by canvas.toBlob; recording will use PNG."
            );
            try {
              canvas.toBlob((pngBlob) => {
                if (!pngBlob) {
                  reject(new Error("canvas.toBlob returned null for both webp and png"));
                  return;
                }
                try {
                  const name = `frame_${idx.toString().padStart(6, "0")}.png`;
                  zipState.zip.file(name, pngBlob);
                  estimatedBytes += pngBlob.size;
                  resolve();
                } catch (err) {
                  reject(err);
                }
              }, "image/png");
            } catch (err) {
              reject(err);
            }
            return;
          }
          reject(new Error("canvas.toBlob returned null (mime=" + mime + ")"));
          return;
        }
        try {
          const name = `frame_${idx.toString().padStart(6, "0")}.${ext}`;
          zipState.zip.file(name, blob);
          estimatedBytes += blob.size;
        } catch (err) {
          reject(err);
          return;
        }
        resolve();
      };
      try {
        if (quality !== undefined) {
          canvas.toBlob(cb, mime, quality);
        } else {
          canvas.toBlob(cb, mime);
        }
      } catch (err) {
        reject(err);
      }
    }).finally(() => {
      zipInflight -= 1;
    });
    zipState.pending.push(p);
    p.catch((err) => handleError(err));
    return true;
  }

  function maybeCaptureFrame(simTime: number): void {
    if (!running || finalizing || initError) return;
    if (frameCount >= maxFrames) return;
    if (!state) return;
    const targetIdx = frameIndexFor(simTime, opts.startSimTime, cadence);
    if (targetIdx < nextFrameIndex) return;
    const idx = nextFrameIndex;
    const ok =
      state.type === "mp4"
        ? captureMp4(opts.canvas, state, idx)
        : captureZip(opts.canvas, state, idx);
    if (!ok) return;
    nextFrameIndex += 1;
    frameCount += 1;
  }

  function backlog(): number {
    if (!state) return 0;
    return state.type === "mp4" ? state.encoder.encodeQueueSize : zipInflight;
  }

  function status(): RecorderStatus {
    return {
      running,
      finalizing,
      frameCount,
      estimatedBytes,
      format: resolved,
      errorMessage: initError
    };
  }

  function cancel(): void {
    running = false;
    if (state && state.type === "mp4") {
      try {
        state.encoder.close();
      } catch {
        // ignore
      }
    }
    state = null;
  }

  async function stopAndDownload(): Promise<void> {
    if (!running && !finalizing) return;
    running = false;
    finalizing = true;
    try {
      await initPromise;
      if (initError) {
        return;
      }
      if (!state) return;
      const stamp = nowStamp();

      if (state.type === "mp4") {
        const mp4 = state;
        await mp4.encoder.flush();
        mp4.muxer.finalize();
        const blob = new Blob([mp4.target.buffer], { type: "video/mp4" });
        triggerDownload(blob, `${filenameStem}_${stamp}.mp4`);
        try {
          mp4.encoder.close();
        } catch {
          // ignore
        }
      } else {
        const zipState = state;
        await Promise.allSettled(zipState.pending);
        const blob = await zipState.zip.generateAsync({ type: "blob" });
        const ext = zipState.mode === "webp-zip" ? "webp" : "png";
        triggerDownload(blob, `${filenameStem}_${stamp}_${ext}.zip`);
      }
    } catch (err) {
      handleError(err);
    } finally {
      finalizing = false;
      state = null;
    }
  }

  return { maybeCaptureFrame, status, stopAndDownload, cancel, ready: () => initPromise, backlog };
}
