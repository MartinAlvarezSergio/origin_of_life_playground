/**
 * Shared "film look" for cinematic applets: an off-screen light layer that feeds a bloom, plus a
 * vignette and fine grain. Drawing helpers take the logical frame size; layers follow the target
 * canvas's backing store (the live view and an export canvas each get their own).
 */

export type Layers = { glow: HTMLCanvasElement; bloomNear: HTMLCanvasElement; bloomFar: HTMLCanvasElement };
const layerCache = new WeakMap<HTMLCanvasElement, Layers>();

function sized(canvas: HTMLCanvasElement | undefined, w: number, h: number): HTMLCanvasElement {
  const c = canvas ?? document.createElement("canvas");
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  return c;
}

/** Off-screen layers matching the target canvas. */
export function layersFor(target: HTMLCanvasElement): Layers {
  const old = layerCache.get(target);
  const w = target.width;
  const h = target.height;
  const layers = {
    glow: sized(old?.glow, w, h),
    bloomNear: sized(old?.bloomNear, Math.max(1, Math.ceil(w / 4)), Math.max(1, Math.ceil(h / 4))),
    bloomFar: sized(old?.bloomFar, Math.max(1, Math.ceil(w / 10)), Math.max(1, Math.ceil(h / 10)))
  };
  layerCache.set(target, layers);
  return layers;
}

export const CAN_FILTER = typeof CanvasRenderingContext2D !== "undefined" && "filter" in CanvasRenderingContext2D.prototype;

/** Bloom: blurred, downsampled copies of the light layer added back on top. */
export function drawBloom(ctx: CanvasRenderingContext2D, layers: Layers, gentle: boolean, strength = 1): void {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const passes: [HTMLCanvasElement, number, number][] = [
    [layers.bloomNear, 3, 0.42],
    [layers.bloomFar, 3, 0.38]
  ];
  for (const [canvas, blur, alpha] of passes) {
    const b = canvas.getContext("2d") as CanvasRenderingContext2D;
    b.setTransform(1, 0, 0, 1, 0, 0);
    b.globalCompositeOperation = "source-over";
    b.clearRect(0, 0, canvas.width, canvas.height);
    if (CAN_FILTER) {
      b.filter = `blur(${blur}px)`;
    }
    b.imageSmoothingEnabled = true;
    b.drawImage(layers.glow, 0, 0, canvas.width, canvas.height);
    if (CAN_FILTER) {
      b.filter = "none";
    }
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = Math.min(1, alpha * strength * (gentle ? 0.7 : 1));
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(canvas, 0, 0, w, h);
  }
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
}

export function drawVignette(ctx: CanvasRenderingContext2D, width: number, height: number, strength = 0.55): void {
  const g = ctx.createRadialGradient(width / 2, height / 2, height * 0.42, width / 2, height / 2, width * 0.62);
  g.addColorStop(0, "rgba(0, 0, 0, 0)");
  g.addColorStop(1, `rgba(0, 0, 0, ${strength})`);
  ctx.globalAlpha = 1;
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, width, height);
}

const GRAIN_SIZE = 192;
let grainTile: HTMLCanvasElement | null = null;

/** Fine film grain, shifted every frame; a fixed pseudo-random tile keeps exports reproducible. */
export function drawGrain(ctx: CanvasRenderingContext2D, frame: number, width: number, height: number): void {
  if (!grainTile) {
    grainTile = document.createElement("canvas");
    grainTile.width = GRAIN_SIZE;
    grainTile.height = GRAIN_SIZE;
    const g = grainTile.getContext("2d") as CanvasRenderingContext2D;
    const img = g.createImageData(GRAIN_SIZE, GRAIN_SIZE);
    let seed = 12345;
    for (let i = 0; i < img.data.length; i += 4) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const v = seed >>> 24;
      img.data[i] = v;
      img.data[i + 1] = v;
      img.data[i + 2] = v;
      img.data[i + 3] = 16;
    }
    g.putImageData(img, 0, 0);
  }
  const pattern = ctx.createPattern(grainTile, "repeat");
  if (!pattern) {
    return;
  }
  const ox = (frame * 73) % GRAIN_SIZE;
  const oy = (frame * 151) % GRAIN_SIZE;
  ctx.save();
  ctx.translate(-ox, -oy);
  ctx.fillStyle = pattern;
  ctx.fillRect(ox, oy, width, height);
  ctx.restore();
}
