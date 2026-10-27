/**
 * Pre-rendered light sprites shared by the cinematic applets: soft glows and lit spheres.
 * Drawing a cached sprite is far cheaper than building a gradient per particle.
 */

const spriteCache = new Map<string, HTMLCanvasElement>();

/** Soft radial glow, pre-rendered once per colour (drawImage is far cheaper than gradients per particle). */
export function glowSprite(color: string, core = 0.35): HTMLCanvasElement {
  const key = `${color}|${core}`;
  let sprite = spriteCache.get(key);
  if (!sprite) {
    sprite = document.createElement("canvas");
    sprite.width = 64;
    sprite.height = 64;
    const g = sprite.getContext("2d") as CanvasRenderingContext2D;
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(core * 0.4, color);
    grad.addColorStop(core, withAlpha(color, 0.55));
    grad.addColorStop(1, withAlpha(color, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    spriteCache.set(key, sprite);
  }
  return sprite;
}

export function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export function drawGlow(ctx: CanvasRenderingContext2D, color: string, x: number, y: number, radius: number, alpha: number, core?: number): void {
  if (alpha <= 0.01) {
    return;
  }
  ctx.globalAlpha = Math.min(1, alpha);
  ctx.drawImage(glowSprite(color, core), x - radius, y - radius, radius * 2, radius * 2);
}

export function mix(hex: string, target: number, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(v + (target - v) * amount));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

const SPHERE_HALF = 48;
const SPHERE_BALL = 26;

/** A lit ball with a soft halo: highlight up-left, darker rim, so nucleons read as solid objects. */
export function sphereSprite(color: string): HTMLCanvasElement {
  const key = `sphere|${color}`;
  let sprite = spriteCache.get(key);
  if (!sprite) {
    sprite = document.createElement("canvas");
    sprite.width = SPHERE_HALF * 2;
    sprite.height = SPHERE_HALF * 2;
    const g = sprite.getContext("2d") as CanvasRenderingContext2D;
    const c = SPHERE_HALF;
    const halo = g.createRadialGradient(c, c, SPHERE_BALL * 0.8, c, c, SPHERE_HALF);
    halo.addColorStop(0, withAlpha(color, 0.35));
    halo.addColorStop(1, withAlpha(color, 0));
    g.fillStyle = halo;
    g.fillRect(0, 0, c * 2, c * 2);
    const ball = g.createRadialGradient(c - 9, c - 10, 1, c, c, SPHERE_BALL);
    ball.addColorStop(0, "#ffffff");
    ball.addColorStop(0.28, mix(color, 255, 0.35));
    ball.addColorStop(0.72, color);
    ball.addColorStop(1, mix(color, 0, 0.55));
    g.fillStyle = ball;
    g.beginPath();
    g.arc(c, c, SPHERE_BALL, 0, Math.PI * 2);
    g.fill();
    spriteCache.set(key, sprite);
  }
  return sprite;
}

/** Spheres are painted normally (they hide what is behind them), even on the additive light layer. */
export function drawSphere(ctx: CanvasRenderingContext2D, color: string, x: number, y: number, r: number, alpha: number): void {
  if (alpha <= 0.01) {
    return;
  }
  const size = (r / SPHERE_BALL) * SPHERE_HALF;
  const previous = ctx.globalCompositeOperation;
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = Math.min(1, alpha);
  ctx.drawImage(sphereSprite(color), x - size, y - size, size * 2, size * 2);
  ctx.globalCompositeOperation = previous;
}


export function ring(ctx: CanvasRenderingContext2D, color: string, x: number, y: number, r: number, alpha: number, width = 1.6): void {
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();
}
