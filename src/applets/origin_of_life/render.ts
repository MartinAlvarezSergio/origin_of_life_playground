import { drawGlow, drawSphere } from "../../core/glowSprites";
import { createRng, nextRandom } from "../../core/seededRng";
import { poolWeather } from "./environment";
import { fade, vesicleHalves, type Lens, type LensMolecule, type LensShape, type LensVesicle } from "./lens";
import { concentrations, COPIER_LEN, N_MAX, RUNGS } from "./sim";
import type { ChemState, EventKind, SettingId, Settings } from "./types";

export const SCENE_W = 1280;
export const SCENE_H = 720;
export const HIST_W = 300;
export const HIST_H = 140;

export type Rect = { x: number; y: number; w: number; h: number };
type Point = { x: number; y: number };
/** Vertical band (below the molecule window) where the setting itself is drawn. */
type Band = { top: number; bottom: number };

export type SceneView = {
  state: ChemState;
  settings: Settings;
  lens: Lens;
  /** Wall-clock seconds, for animation only. */
  clock: number;
  /** Seconds since the last event, Infinity if none. */
  eventAge: number;
  compact: boolean;
};

export const SETTING_NAMES: Record<SettingId, string> = {
  pool: "Shallow pool",
  ocean: "Open ocean",
  vent: "Hydrothermal vent"
};

const WINDOW_LABEL: Record<SettingId, string> = {
  pool: "Molecules in the pool, zoomed in",
  ocean: "Molecules in the open ocean, zoomed in",
  vent: "Molecules in the chimney's pores, zoomed in"
};

export const RUNG_LABELS = [
  "Building blocks form",
  "They concentrate",
  "Short chains",
  "Long chains",
  "A chain copies itself",
  "Copiers enclosed",
  "Life: it keeps going"
];

export const EVENT_TEXT: Record<EventKind, string> = {
  flood: "Flood: most of what had built up washes away.",
  drought: "Drought: the pool dries out and bakes in the UV.",
  impact: "Impact: a meteorite strike sterilises the site.",
  shutdown: "Vent shutdown: no flow, warmth or energy for a while."
};

/** Building-block colours (four kinds, like the four letters of RNA). */
const BEAD = ["#5ec8f2", "#ffb85c", "#7fd38a", "#f27ca4"];
const COPIER_GLOW = "#ffd36b";
const LIPID_HEAD = "#ffe3a8";
const LIPID_TAIL = "rgba(214, 192, 140, 0.8)";

// ─── Layout ──────────────────────────────────────────────────────────────────

/** Molecule window (top) and setting band (bottom), in the scene's (or one column's) coordinates. */
function layoutFor(w: number, h: number, compact: boolean): { win: Rect; band: Band } {
  if (compact) {
    return { win: { x: 14, y: 78, w: w - 28, h: 280 }, band: { top: 358, bottom: 0.78 * h } };
  }
  // Centred between the controls (left) and the readouts (right).
  return { win: { x: 320, y: 76, w: 630, h: 380 }, band: { top: 456, bottom: h } };
}

/** Shape of the molecule window, for the lens simulation. */
export function lensShape(compact: boolean): LensShape {
  const { win } = layoutFor(SCENE_W / 3, SCENE_H, compact);
  const full = layoutFor(SCENE_W, SCENE_H, false).win;
  return { aspect: (compact ? win.w : full.w) / (compact ? win.h : full.h), capacity: compact ? 0.5 : 1 };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function smoothstep(a: number, b: number, x: number): number {
  const f = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return f * f * (3 - 2 * f);
}

/** Fixed pseudo-random scatter, so scenery doesn't shimmer between frames. */
function scatter(seed: number, n: number): number[][] {
  const rng = createRng(seed);
  return Array.from({ length: n }, () => [nextRandom(rng), nextRandom(rng), nextRandom(rng)]);
}
const PEBBLES = scatter(11, 120);
const SNOW = scatter(12, 90);
const OCEAN_DOTS = scatter(13, 80);
const PORES = scatter(14, 260);
const DROPS = scatter(15, 220);
const RIPPLES = scatter(16, 14);
/** Building blocks far off in the water, out of focus behind the window's own few. */
const FAR_BLOCKS = scatter(17, 16);

function eventActive(s: ChemState, kind: EventKind): boolean {
  return s.events.some((e) => e.kind === kind && s.t < e.until);
}

function recent(view: SceneView, kind: EventKind, seconds: number): number {
  const e = view.state.lastEvent;
  if (!e || e.kind !== kind || view.eventAge > seconds) {
    return 0;
  }
  return 1 - view.eventAge / seconds;
}

function mixRgb(a: [number, number, number], b: [number, number, number], f: number): string {
  return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * f)).join(", ")})`;
}

// ─── Pool: a cutaway of a rock pool on volcanic ground ───────────────────────

function drawPool(ctx: CanvasRenderingContext2D, view: SceneView, w: number, h: number, band: Band): Point {
  const s = view.state;
  const p = view.settings.pool;
  const H = band.bottom - band.top;
  const drought = eventActive(s, "drought");
  const flood = recent(view, "flood", 3);
  const weather = poolWeather(p, s.t);
  const cloud = drought ? 0 : Math.max(weather.cloud, flood);
  const rain = drought ? 0 : Math.max(weather.rain, 1.3 * flood);
  const water = s.conditions.water;

  const horizon = band.top + (view.compact ? 6 : 10);
  const ground = band.top + 0.32 * H;

  // Sky: dusky early-Earth haze, greyer under cloud.
  const sky = ctx.createLinearGradient(0, 0, 0, horizon);
  sky.addColorStop(0, mixRgb([15, 27, 46], [28, 32, 40], cloud));
  sky.addColorStop(0.65, mixRgb([59, 51, 70], [58, 60, 68], cloud));
  sky.addColorStop(1, mixRgb([134, 96, 74], [92, 90, 92], cloud));
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, horizon + 2);

  // Low sun near the horizon; its glow follows the UV setting and dims under cloud.
  const sun = { x: 0.86 * w, y: horizon - 0.07 * H };
  const sunny = 1 - 0.8 * cloud;
  ctx.globalCompositeOperation = "lighter";
  drawGlow(ctx, "#ffcf8a", sun.x, sun.y, 0.5 * H, (0.2 + 0.25 * p.uv) * sunny);
  drawGlow(ctx, "#b28cff", sun.x, sun.y, 0.8 * H, 0.12 * p.uv * sunny);
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 0.4 + 0.6 * sunny;
  ctx.fillStyle = "#fff3d6";
  ctx.beginPath();
  ctx.arc(sun.x, sun.y, 0.06 * H, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  // Rain clouds gather before the rain and clear after it.
  if (cloud > 0.02) {
    for (let k = 0; k < 9; k += 1) {
      const x = ((k / 9 + view.clock * 0.01) % 1) * w * 1.2 - 0.1 * w;
      const y = horizon - (0.25 + 0.12 * Math.sin(k * 2.1)) * H;
      ctx.globalAlpha = 0.55 * cloud;
      ctx.fillStyle = "#4a4c56";
      ctx.beginPath();
      ctx.ellipse(x, y, 0.12 * w, 0.12 * H, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // Distant volcanoes, one smoking.
  ctx.fillStyle = "#2a2230";
  const peaks = view.compact ? [[0.2, 0.18], [0.7, 0.24]] : [[0.08, 0.16], [0.7, 0.24], [0.95, 0.14]];
  peaks.forEach(([px, ph]) => {
    ctx.beginPath();
    ctx.moveTo(px * w - 0.14 * w, horizon + 2);
    ctx.lineTo(px * w - 0.012 * w, horizon - ph * H);
    ctx.lineTo(px * w + 0.012 * w, horizon - ph * H);
    ctx.lineTo(px * w + 0.14 * w, horizon + 2);
    ctx.fill();
  });

  // Far plain, then the ground surface with a low rim around the pool.
  const cx = 0.5 * w;
  const half = view.compact ? 0.4 * w : 0.22 * w;
  const depth = 0.42 * H;
  const plain = ctx.createLinearGradient(0, horizon, 0, ground);
  plain.addColorStop(0, "#4a3a34");
  plain.addColorStop(1, "#3a2d29");
  ctx.fillStyle = plain;
  ctx.fillRect(0, horizon, w, ground - horizon + 2);
  const surfaceY = (x: number): number => {
    const u = (x - cx) / half;
    const rimBump = 5 * Math.exp(-((Math.abs(u) - 1.1) ** 2) / 0.04);
    return ground - rimBump + 2.5 * Math.sin(x * 0.03) + 1.5 * Math.sin(x * 0.11);
  };

  // Rock in cutaway: layered strata below the surface.
  ctx.beginPath();
  ctx.moveTo(0, h);
  for (let x = 0; x <= w; x += 8) {
    ctx.lineTo(x, surfaceY(x));
  }
  ctx.lineTo(w, h);
  ctx.closePath();
  const rock = ctx.createLinearGradient(0, ground, 0, h);
  rock.addColorStop(0, "#4a3832");
  rock.addColorStop(1, "#1c1513");
  ctx.fillStyle = rock;
  ctx.fill();
  ctx.save();
  ctx.clip();
  for (let k = 0; k < 5; k += 1) {
    const y0 = ground + (0.15 + 0.2 * k) * (h - ground);
    ctx.strokeStyle = k % 2 ? "rgba(90, 70, 60, 0.35)" : "rgba(20, 14, 12, 0.35)";
    ctx.lineWidth = 3 + 2 * (k % 3);
    ctx.beginPath();
    for (let x = 0; x <= w; x += 10) {
      const y = y0 + 4 * Math.sin(x * 0.012 + k * 1.7) + 2 * Math.sin(x * 0.05 + k);
      if (x === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
  }
  PEBBLES.forEach(([a, b, q]) => {
    ctx.fillStyle = `rgba(12, 9, 8, ${0.3 + 0.3 * q})`;
    ctx.beginPath();
    ctx.ellipse(a * w, ground + 8 + b * (h - ground), 2 + 4 * q, 1.5 + 2.5 * q, q * 3, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.restore();

  // The basin, an irregular hollow cut into the rock.
  const floorY = (x: number): number => {
    const u = Math.min(1, Math.abs((x - cx) / half));
    return ground + depth * (1 - u * u) ** 0.7 * (1 + 0.07 * Math.sin(5 * ((x - cx) / half) + 1));
  };
  const basin = new Path2D();
  basin.moveTo(cx - half, surfaceY(cx - half));
  for (let x = cx - half; x <= cx + half; x += 4) {
    basin.lineTo(x, Math.max(surfaceY(x), floorY(x)));
  }
  basin.lineTo(cx + half, surfaceY(cx + half));
  basin.closePath();
  const hollow = ctx.createLinearGradient(0, ground - 8, 0, ground + depth);
  hollow.addColorStop(0, "#33262a");
  hollow.addColorStop(1, "#1a1213");
  ctx.fillStyle = hollow;
  ctx.fill(basin);

  // Water level: a bowl holds less near the top, so depth fills faster than volume.
  const level = flood > 0 ? 1 : water;
  const waterY = ground - (flood > 0 ? 5 * flood : 0) + depth * (1 - level ** 0.6);
  ctx.save();
  ctx.clip(basin);
  // Salt crust left on the walls where the water used to reach (a bathtub ring).
  ctx.strokeStyle = `rgba(236, 228, 210, ${0.55 * (1 - level)})`;
  ctx.lineWidth = 4;
  ctx.beginPath();
  for (let x = cx - half; x <= cx + half; x += 4) {
    const y = floorY(x);
    if (y < waterY) {
      ctx.moveTo(x, y);
      ctx.lineTo(x + 4, floorY(x + 4));
    }
  }
  ctx.stroke();
  // Water.
  const sea = ctx.createLinearGradient(0, waterY, 0, ground + depth);
  sea.addColorStop(0, "rgba(72, 180, 174, 0.88)");
  sea.addColorStop(1, "rgba(14, 64, 76, 0.95)");
  ctx.fillStyle = sea;
  ctx.fillRect(cx - half - 4, waterY, 2 * half + 8, ground + depth - waterY + 4);
  // Sediment on the floor: clay is reddish-brown and finely layered.
  ctx.fillStyle = p.clay ? "#8a5d3b" : "#5a524b";
  ctx.beginPath();
  ctx.moveTo(cx - half, ground + depth);
  for (let x = cx - half; x <= cx + half; x += 4) {
    ctx.lineTo(x, floorY(x) - 0.12 * depth * (1 - ((x - cx) / half) ** 2));
  }
  ctx.lineTo(cx + half, ground + depth * 1.2);
  ctx.lineTo(cx - half, ground + depth * 1.2);
  ctx.fill();
  // Mud cracks once the floor is exposed.
  if (level < 0.1) {
    ctx.strokeStyle = "rgba(20, 12, 8, 0.75)";
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    for (let k = 0; k < 16; k += 1) {
      const x0 = cx + (k / 15 - 0.5) * half * 1.3;
      const y0 = floorY(x0) - 0.1 * depth;
      ctx.moveTo(x0, y0);
      ctx.lineTo(x0 + 9 * Math.sin(k * 3.1), y0 + 7);
      ctx.lineTo(x0 + 14 * Math.cos(k * 1.7), y0 + 12);
    }
    ctx.stroke();
  }
  ctx.restore();

  // Water surface, with ripples where raindrops land.
  const chord = (() => {
    let x0 = cx;
    while (x0 > cx - half && floorY(x0) > waterY) {
      x0 -= 2;
    }
    return cx - x0;
  })();
  if (level > 0.03) {
    ctx.strokeStyle = "rgba(205, 245, 240, 0.6)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx - chord, waterY);
    ctx.lineTo(cx + chord, waterY);
    ctx.stroke();
    if (rain > 0.05) {
      RIPPLES.forEach(([a, b], i) => {
        const age = (view.clock * (1.5 + b) + a) % 1;
        if (i / RIPPLES.length > rain) {
          return;
        }
        ctx.strokeStyle = `rgba(220, 245, 250, ${0.5 * (1 - age)})`;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.ellipse(cx + (2 * a - 1) * chord * 0.9, waterY, 2 + 12 * age, 1 + 3 * age, 0, 0, Math.PI * 2);
        ctx.stroke();
      });
    }
  }
  if (flood > 0) {
    ctx.fillStyle = `rgba(72, 180, 174, ${0.7 * flood})`;
    ctx.fillRect(cx - half * 1.5, ground - 6, half * 3, 8);
  }

  // Boulders on the rim, and mineral staining around a hot spring.
  const hot = smoothstep(45, 90, p.temperature);
  [-1.18, -1.05, 1.08, 1.22].forEach((u, i) => {
    const x = cx + u * half;
    const y = surfaceY(x);
    if (hot > 0) {
      ctx.fillStyle = `rgba(214, 150, 60, ${0.35 * hot})`;
      ctx.beginPath();
      ctx.ellipse(x, y + 2, 26, 5, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = i % 2 ? "#3d302c" : "#2e2421";
    ctx.beginPath();
    ctx.ellipse(x, y - 4, 9 + 5 * (i % 3), 7 + 3 * (i % 2), 0, Math.PI, Math.PI * 2);
    ctx.fill();
  });

  // Rain, slanting in the wind; it stops at the ground.
  if (rain > 0.02) {
    ctx.strokeStyle = `rgba(200, 222, 240, ${Math.min(0.75, 0.6 * rain)})`;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    const n = Math.floor(DROPS.length * Math.min(1, rain / 1.2));
    for (let k = 0; k < n; k += 1) {
      const [a, b, q] = DROPS[k];
      const fall = ((b + view.clock * (1.4 + 0.6 * q)) % 1) * (ground + 30) - 30;
      const x = (a * w * 1.1 + fall * 0.15) % w;
      if (fall + 14 > surfaceY(x) + (Math.abs(x - cx) < chord ? waterY - ground : 0)) {
        continue;
      }
      ctx.moveTo(x, fall);
      ctx.lineTo(x + 2.4, fall + 14);
    }
    ctx.stroke();
  }

  // Overcast: the land dims under the clouds.
  if (cloud > 0.02) {
    ctx.fillStyle = `rgba(20, 26, 38, ${0.3 * cloud})`;
    ctx.fillRect(0, band.top, w, h - band.top);
  }

  // Steam above a hot pool in the sun.
  if (hot > 0 && level > 0.05) {
    for (let k = 0; k < 8; k += 1) {
      const age = (view.clock * 0.25 + k / 8) % 1;
      ctx.globalAlpha = 0.14 * hot * Math.sin(Math.PI * age) * (1 - 0.6 * rain);
      ctx.fillStyle = "#e8eef2";
      ctx.beginPath();
      ctx.arc(cx + (k / 7 - 0.5) * chord * 1.6 + 10 * Math.sin(age * 5 + k), waterY - age * 0.4 * H, 8 + 20 * age, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  drawImpact(ctx, view, { x: cx, y: ground }, w, h);
  const bottom = floorY(cx) - 0.12 * depth;
  return { x: cx + 0.08 * half, y: level > 0.05 ? waterY + (bottom - waterY) * 0.45 : bottom - 4 };
}

// ─── Ocean ───────────────────────────────────────────────────────────────────

function drawOcean(ctx: CanvasRenderingContext2D, view: SceneView, w: number, h: number, band: Band): Point {
  const top = 0.06 * h;
  const sky = ctx.createLinearGradient(0, 0, 0, top);
  sky.addColorStop(0, "#16243a");
  sky.addColorStop(1, "#56647a");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, top + 2);
  const sea = ctx.createLinearGradient(0, top, 0, h);
  sea.addColorStop(0, "#14678c");
  sea.addColorStop(0.45, "#0a3753");
  sea.addColorStop(1, "#02080e");
  ctx.fillStyle = sea;
  ctx.beginPath();
  ctx.moveTo(0, h);
  for (let k = 0; k <= 64; k += 1) {
    ctx.lineTo((w * k) / 64, top + 3 * Math.sin(k * 0.8 + view.clock * 1.4));
  }
  ctx.lineTo(w, h);
  ctx.fill();

  // Light shafts fading with depth.
  ctx.globalCompositeOperation = "lighter";
  for (let k = 0; k < 6; k += 1) {
    const x = ((k + 0.5) / 6) * w + 30 * Math.sin(view.clock * 0.2 + k);
    const g = ctx.createLinearGradient(0, top, 0, 0.75 * h);
    g.addColorStop(0, "rgba(160, 220, 255, 0.07)");
    g.addColorStop(1, "rgba(160, 220, 255, 0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(x - 20, top);
    ctx.lineTo(x + 20, top);
    ctx.lineTo(x + 110, 0.75 * h);
    ctx.lineTo(x + 10, 0.75 * h);
    ctx.fill();
  }
  ctx.globalCompositeOperation = "source-over";

  // The same molecules as in a pool, spread through a vast volume.
  OCEAN_DOTS.forEach(([a, b, k]) => {
    const x = (a * w + view.clock * (4 + 6 * k)) % w;
    const y = top + 20 + b * (h - top - 40) + 6 * Math.sin(view.clock * 0.5 + k * 9);
    ctx.fillStyle = `rgba(190, 230, 255, ${0.15 + 0.25 * k})`;
    ctx.fillRect(x, y, 1.6, 1.6);
  });

  ctx.fillStyle = "rgba(40, 46, 52, 0.6)";
  ctx.fillRect(0, band.bottom - 0.04 * (band.bottom - band.top), w, h);
  drawImpact(ctx, view, { x: 0.5 * w, y: top }, w, h);
  return { x: 0.47 * w, y: band.top + 0.45 * (band.bottom - band.top) };
}

// ─── Vent ────────────────────────────────────────────────────────────────────

type Tower = { dx: number; width: number; height: number };

function towerPath(cx: number, floor: number, t: Tower, seed: number): Path2D {
  const path = new Path2D();
  const steps = 18;
  for (let k = 0; k <= steps; k += 1) {
    const f = k / steps;
    const halfW = (t.width / 2) * (1 - 0.45 * f) * (1 + 0.12 * Math.sin(seed + k * 1.7));
    const x = cx + t.dx - halfW;
    const y = floor - f * t.height;
    if (k === 0) {
      path.moveTo(x, y);
    } else {
      path.lineTo(x, y);
    }
  }
  for (let k = steps; k >= 0; k -= 1) {
    const f = k / steps;
    const halfW = (t.width / 2) * (1 - 0.45 * f) * (1 + 0.12 * Math.cos(seed * 2 + k * 1.3));
    path.lineTo(cx + t.dx + halfW, floor - f * t.height);
  }
  path.closePath();
  return path;
}

function drawVent(ctx: CanvasRenderingContext2D, view: SceneView, w: number, h: number, band: Band): Point {
  const s = view.state;
  const v = view.settings.vent;
  const smoker = v.type === "smoker";
  const off = eventActive(s, "shutdown");
  const H = band.bottom - band.top;

  const sea = ctx.createLinearGradient(0, 0, 0, h);
  sea.addColorStop(0, "#07202b");
  sea.addColorStop(1, "#020609");
  ctx.fillStyle = sea;
  ctx.fillRect(0, 0, w, h);
  SNOW.forEach(([a, b, k]) => {
    const y = (b * h + view.clock * (6 + 8 * k)) % h;
    ctx.fillStyle = `rgba(200, 220, 230, ${0.08 + 0.18 * k})`;
    ctx.fillRect(a * w, y, 1.4, 1.4);
  });

  const floor = band.bottom - 0.1 * H;
  ctx.fillStyle = "#14181a";
  ctx.beginPath();
  ctx.moveTo(0, h);
  for (let k = 0; k <= 32; k += 1) {
    ctx.lineTo((w * k) / 32, floor + 6 * Math.sin(k * 1.3) + 4 * Math.cos(k * 2.9));
  }
  ctx.lineTo(w, h);
  ctx.fill();

  const cx = 0.5 * w;
  const k = view.compact ? 1.9 : 1;
  const heat = smoothstep(20, smoker ? 400 : 140, v.temperature) * (off ? 0 : 1);

  if (smoker) {
    const t: Tower = { dx: 0, width: 0.07 * w * k, height: 0.9 * H };
    const body = ctx.createLinearGradient(cx - t.width / 2, 0, cx + t.width / 2, 0);
    body.addColorStop(0, "#3b322c");
    body.addColorStop(1, "#110d0b");
    ctx.fillStyle = body;
    ctx.fill(towerPath(cx, floor, t, 3));
    const mouth = { x: cx, y: floor - t.height };
    // Black smoke: metal sulfides precipitating as the 350 °C fluid meets cold seawater.
    if (!off) {
      for (let j = 0; j < 22; j += 1) {
        const age = (view.clock * 0.3 * v.flow + j / 22) % 1;
        ctx.globalAlpha = 0.5 * (1 - age);
        ctx.fillStyle = age < 0.15 ? "#7a4a32" : "#4a423d";
        ctx.beginPath();
        ctx.arc(mouth.x + Math.sin(j * 2.3 + age * 3) * age * 50, mouth.y - age * 1.2 * H, 6 + age * 0.3 * H, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    ctx.globalCompositeOperation = "lighter";
    drawGlow(ctx, "#ff6a2a", mouth.x, mouth.y + 4, 40, 0.7 * heat);
    drawGlow(ctx, "#ff8a3a", cx, floor - 0.2 * H, 60, 0.25 * heat);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    drawImpact(ctx, view, { x: cx, y: floor }, w, h);
    return { x: cx + t.width * 0.2, y: floor - 0.5 * t.height };
  }

  // Alkaline vent: porous carbonate towers (Lost City-like).
  const towers: Tower[] = [
    { dx: -0.085 * w * k, width: 0.06 * w * k, height: 0.5 * H },
    { dx: 0.08 * w * k, width: 0.07 * w * k, height: 0.62 * H },
    { dx: 0, width: 0.12 * w * k, height: 0.85 * H }
  ];
  if (!off) {
    ctx.strokeStyle = `rgba(210, 232, 255, ${0.05 + 0.1 * heat})`;
    ctx.lineWidth = 3;
    towers.forEach((t, i) => {
      for (let j = 0; j < 3; j += 1) {
        ctx.beginPath();
        for (let q = 0; q <= 16; q += 1) {
          const y = floor - t.height - q * 8;
          const x = cx + t.dx + (j - 1) * 6 + 6 * Math.sin(q * 0.6 - view.clock * 3 * v.flow + i + j);
          if (q === 0) {
            ctx.moveTo(x, y);
          } else {
            ctx.lineTo(x, y);
          }
        }
        ctx.stroke();
      }
    });
  }
  towers.forEach((t, i) => {
    const body = ctx.createLinearGradient(cx + t.dx - t.width / 2, 0, cx + t.dx + t.width / 2, 0);
    body.addColorStop(0, "#e7e0cf");
    body.addColorStop(1, "#8f8776");
    ctx.fillStyle = body;
    ctx.fill(towerPath(cx, floor, t, i + 1));
  });
  // Pores: the chimney is a sponge of mineral cells.
  ctx.save();
  const chimney = new Path2D();
  towers.forEach((t, i) => chimney.addPath(towerPath(cx, floor, t, i + 1)));
  ctx.clip(chimney);
  const poreSize = 2.5 + 4 * v.pores;
  const tallest = 0.85 * H;
  PORES.forEach(([a, b, q], j) => {
    if (j > 60 + 200 * v.pores) {
      return;
    }
    ctx.fillStyle = "rgba(70, 64, 54, 0.55)";
    ctx.beginPath();
    ctx.ellipse(cx + (a - 0.5) * 0.22 * w * k, floor - b * tallest, poreSize * (0.6 + q), poreSize * (0.4 + 0.5 * q), q * 3, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.globalCompositeOperation = "lighter";
  PORES.forEach(([a, b, q], j) => {
    if (j % 9 !== 0) {
      return;
    }
    drawGlow(ctx, "#ffb46b", cx + (a - 0.5) * 0.22 * w * k, floor - b * tallest, 5 + 5 * q, 0.35 * heat * (0.6 + 0.4 * Math.sin(view.clock * 2 + j)));
  });
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  ctx.restore();
  drawImpact(ctx, view, { x: cx, y: floor }, w, h);
  return { x: cx + 0.02 * w * k, y: floor - 0.4 * tallest };
}

// ─── Shared pieces ───────────────────────────────────────────────────────────

function drawImpact(ctx: CanvasRenderingContext2D, view: SceneView, at: Point, w: number, h: number): void {
  const f = recent(view, "impact", 4);
  if (f <= 0) {
    return;
  }
  const age = 4 * (1 - f);
  ctx.globalCompositeOperation = "lighter";
  drawGlow(ctx, "#ffb060", at.x, at.y, 0.5 * h * (0.4 + age), 0.9 * f);
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = Math.max(0, 0.8 - age * 1.6);
  ctx.fillStyle = "#fff4e0";
  ctx.fillRect(0, 0, w, h);
  ctx.globalAlpha = 1;
}

const WINDOW_BG: Record<SettingId, [string, string]> = {
  pool: ["#155a63", "#09303a"],
  ocean: ["#0d3a58", "#04172a"],
  vent: ["#2a3238", "#11171b"]
};

/** Zoom lines from the spot in the setting to the two outermost corners of the window. */
function drawConnector(ctx: CanvasRenderingContext2D, from: Point, win: Rect): void {
  const corners = [
    { x: win.x, y: win.y },
    { x: win.x + win.w, y: win.y },
    { x: win.x + win.w, y: win.y + win.h },
    { x: win.x, y: win.y + win.h }
  ];
  const mid = Math.atan2(win.y + win.h / 2 - from.y, win.x + win.w / 2 - from.x);
  const rel = corners.map((c) => {
    let d = Math.atan2(c.y - from.y, c.x - from.x) - mid;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    return { c, d };
  });
  rel.sort((a, b) => a.d - b.d);
  const [lo, hi] = [rel[0].c, rel[rel.length - 1].c];
  ctx.fillStyle = "rgba(255, 255, 255, 0.04)";
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(lo.x, lo.y);
  ctx.lineTo(hi.x, hi.y);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.3)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(lo.x, lo.y);
  ctx.lineTo(from.x, from.y);
  ctx.lineTo(hi.x, hi.y);
  ctx.stroke();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.8)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(from.x, from.y, 7, 0, Math.PI * 2);
  ctx.stroke();
}

type Frame = { cx: number; cy: number; scale: number; rb: number; clock: number };

function toPx(f: Frame, x: number, y: number): Point {
  return { x: f.cx + x * f.scale, y: f.cy + y * f.scale };
}

/** Points along a chain: a gentle random curve when free, a spiral coil when inside a vesicle. */
function chainPoints(m: LensMolecule, f: Frame, home: LensVesicle | undefined): Point[] {
  const spacing = 2.1 * f.rb;
  if (home) {
    const c = toPx(f, m.x, m.y);
    const pitch = 2.3 * f.rb;
    let r = 0.62 * (vesicleHalves(home).r * f.scale - 2.6 * f.rb);
    let theta = m.angle;
    const pts: Point[] = [];
    for (let k = 0; k < m.len; k += 1) {
      const wobble = 0.08 * f.rb * Math.sin(f.clock * 1.3 + k * 0.9);
      pts.push({ x: c.x + (r + wobble) * Math.cos(theta), y: c.y + (r + wobble) * Math.sin(theta) });
      const step = spacing / r;
      theta += step;
      r = Math.max(pitch, r - (pitch * step) / (2 * Math.PI));
    }
    return pts;
  }
  const pts: Point[] = [];
  let x = 0;
  let y = 0;
  let theta = m.angle;
  for (let k = 0; k < m.len; k += 1) {
    pts.push({ x, y });
    theta += m.bends[k] + 0.06 * Math.sin(f.clock * 1.3 + k * 0.7 + m.x * 5);
    x += spacing * Math.cos(theta);
    y += spacing * Math.sin(theta);
  }
  const mx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
  const my = pts.reduce((a, p) => a + p.y, 0) / pts.length;
  const c = toPx(f, m.x, m.y);
  return pts.map((p) => ({ x: c.x + p.x - mx, y: c.y + p.y - my }));
}

/**
 * A vesicle's lipid bilayer: heads facing the water on both sides, tails meeting in the middle.
 * A dividing one is drawn as two overlapping circles pulling apart, each membrane layer drawn only
 * where it is outside the other half, so the outline pinches in at the waist until they separate.
 */
function drawVesicle(ctx: CanvasRenderingContext2D, v: LensVesicle, f: Frame): void {
  const a = fade(v.age, v.life);
  const half = vesicleHalves(v);
  const ax = Math.cos(v.axis);
  const ay = Math.sin(v.axis);
  const centres = (v.split < 0 ? [0] : [-1, 1]).map((side) => toPx(f, v.x + side * half.d * ax, v.y + side * half.d * ay));
  const R = half.r * f.scale;
  const t = 2.6 * f.rb;
  ctx.globalAlpha = a;
  centres.forEach((c, i) => {
    const other = centres.length > 1 ? centres[1 - i] : null;
    ctx.fillStyle = "rgba(150, 215, 225, 0.08)";
    ctx.beginPath();
    ctx.arc(c.x, c.y, R, 0, Math.PI * 2);
    ctx.fill();
    [R, R - t].forEach((r, layer) => {
      const n = Math.max(12, Math.floor((2 * Math.PI * r) / (1.9 * f.rb)));
      const inward = layer === 0 ? -1 : 1;
      const points: { x: number; y: number; ux: number; uy: number }[] = [];
      for (let k = 0; k < n; k += 1) {
        const th = (k / n) * Math.PI * 2 + layer * 0.1;
        const ux = Math.cos(th);
        const uy = Math.sin(th);
        const x = c.x + r * ux;
        const y = c.y + r * uy;
        if (other && Math.hypot(x - other.x, y - other.y) < r) {
          continue;
        }
        points.push({ x, y, ux, uy });
      }
      ctx.strokeStyle = LIPID_TAIL;
      ctx.lineWidth = 1;
      ctx.beginPath();
      points.forEach((p) => {
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x + inward * 0.45 * t * p.ux, p.y + inward * 0.45 * t * p.uy);
      });
      ctx.stroke();
      ctx.fillStyle = LIPID_HEAD;
      points.forEach((p) => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 0.55 * f.rb, 0, Math.PI * 2);
        ctx.fill();
      });
    });
  });
  ctx.globalAlpha = 1;
}

/**
 * When building blocks are scarce: a few faint, out-of-focus ones far off in the water, drifting
 * slowly behind the window's own (which only pass through now and then).
 */
function drawFarBlocks(ctx: CanvasRenderingContext2D, view: SceneView, win: Rect, f: Frame): void {
  const sparse = view.lens.sparse;
  if (sparse <= 0.01) {
    return;
  }
  FAR_BLOCKS.forEach(([a, b, q], i) => {
    if (view.compact && i % 2 === 1) {
      return;
    }
    const drift = (q < 0.5 ? 1 : -1) * (0.004 + 0.01 * q);
    const x = win.x + ((((a + view.clock * drift) % 1) + 1) % 1) * win.w;
    const y = win.y + (0.1 + 0.8 * b) * win.h + 8 * Math.sin(view.clock * (0.2 + 0.2 * q) + i);
    const r = (1.1 + 1.2 * q) * f.rb;
    const color = BEAD[i % BEAD.length];
    const n = parseInt(color.slice(1), 16);
    const rgb = `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
    const alpha = sparse * (0.16 + 0.16 * q);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${rgb}, ${alpha})`);
    g.addColorStop(0.55, `rgba(${rgb}, ${0.7 * alpha})`);
    g.addColorStop(1, `rgba(${rgb}, 0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  });
}

function drawMolecule(ctx: CanvasRenderingContext2D, m: LensMolecule, f: Frame, lens: Lens): void {
  const a = fade(m.age, m.life);
  if (m.kind === "block") {
    const p = toPx(f, m.x, m.y);
    drawSphere(ctx, BEAD[m.seq[0]], p.x, p.y, 1.05 * f.rb, a);
    return;
  }
  if (m.kind === "lipid") {
    // A free lipid: a water-loving head and two oily tails.
    const p = toPx(f, m.x, m.y);
    const dx = Math.cos(m.angle);
    const dy = Math.sin(m.angle);
    ctx.globalAlpha = a;
    ctx.strokeStyle = LIPID_TAIL;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    [-0.35, 0.35].forEach((o) => {
      ctx.moveTo(p.x - dy * o * f.rb, p.y + dx * o * f.rb);
      ctx.lineTo(p.x + dx * 2.4 * f.rb - dy * o * f.rb, p.y + dy * 2.4 * f.rb + dx * o * f.rb);
    });
    ctx.stroke();
    ctx.fillStyle = LIPID_HEAD;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 0.7 * f.rb, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    return;
  }
  const home = m.home >= 0 ? lens.vesicles[m.home] : undefined;
  const pts = chainPoints(m, f, home);
  if (m.kind === "copier") {
    const mid = pts[Math.floor(pts.length / 2)];
    ctx.globalCompositeOperation = "lighter";
    drawGlow(ctx, COPIER_GLOW, mid.x, mid.y, 7 * f.rb, 0.22 * a);
    ctx.globalCompositeOperation = "source-over";
    // The copy being built alongside, letter by letter.
    const done = Math.floor(m.copy * m.len);
    for (let k = 0; k < done; k += 1) {
      const prev = pts[Math.max(0, k - 1)];
      const next = pts[Math.min(pts.length - 1, k + 1)];
      const tx = next.x - prev.x;
      const ty = next.y - prev.y;
      const tl = Math.hypot(tx, ty) || 1;
      const q = { x: pts[k].x - (ty / tl) * 2.4 * f.rb, y: pts[k].y + (tx / tl) * 2.4 * f.rb };
      ctx.globalAlpha = 0.6 * a;
      ctx.strokeStyle = COPIER_GLOW;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(pts[k].x, pts[k].y);
      ctx.lineTo(q.x, q.y);
      ctx.stroke();
      drawSphere(ctx, BEAD[3 - m.seq[k]], q.x, q.y, 0.85 * f.rb, 0.85 * a);
    }
  }
  ctx.globalAlpha = 0.55 * a;
  ctx.strokeStyle = m.kind === "copier" ? COPIER_GLOW : "#cfe6ea";
  ctx.lineWidth = m.kind === "copier" ? 2 : 1.3;
  ctx.beginPath();
  pts.forEach((p, k) => (k === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.stroke();
  pts.forEach((p, k) => drawSphere(ctx, BEAD[m.seq[k]], p.x, p.y, f.rb, a));
  ctx.globalAlpha = 1;
}

function drawWindow(ctx: CanvasRenderingContext2D, view: SceneView, win: Rect, anchor: Point): void {
  const setting = view.state.setting;
  drawConnector(ctx, anchor, win);
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(win.x, win.y, win.w, win.h, 16);
  ctx.clip();
  const [inner, outer] =
    setting === "vent" && view.settings.vent.type === "smoker" ? ["#2c201b", "#120c0a"] : WINDOW_BG[setting];
  const bg = ctx.createRadialGradient(win.x + win.w / 2, win.y + win.h / 2, 0, win.x + win.w / 2, win.y + win.h / 2, win.w * 0.6);
  bg.addColorStop(0, inner);
  bg.addColorStop(1, outer);
  ctx.fillStyle = bg;
  ctx.fillRect(win.x, win.y, win.w, win.h);
  const frame: Frame = {
    cx: win.x + win.w / 2,
    cy: win.y + win.h / 2,
    scale: win.h / 2,
    // Bead radius: small, so the window has room to show what the molecules do.
    rb: view.compact ? 3.2 : 3.8,
    clock: view.clock
  };
  drawFarBlocks(ctx, view, win, frame);
  view.lens.vesicles.forEach((v) => drawVesicle(ctx, v, frame));
  // Free molecules first, then those inside vesicles on top.
  view.lens.molecules.filter((m) => m.home < 0).forEach((m) => drawMolecule(ctx, m, frame, view.lens));
  view.lens.molecules.filter((m) => m.home >= 0).forEach((m) => drawMolecule(ctx, m, frame, view.lens));
  ctx.restore();

  ctx.strokeStyle = "rgba(230, 240, 250, 0.7)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(win.x, win.y, win.w, win.h, 16);
  ctx.stroke();
  ctx.fillStyle = "rgba(235, 240, 245, 0.72)";
  ctx.font = view.compact ? "13px system-ui, sans-serif" : "15px system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(view.compact ? "zoomed in" : WINDOW_LABEL[setting], win.x + 14, win.y + 24);
}

function drawCaption(ctx: CanvasRenderingContext2D, view: SceneView, w: number, h: number): void {
  const e = view.state.lastEvent;
  if (!e || view.eventAge > 6) {
    return;
  }
  const a = Math.min(1, view.eventAge / 0.3, (6 - view.eventAge) / 0.8);
  const text = EVENT_TEXT[e.kind];
  ctx.font = "600 19px system-ui, sans-serif";
  const tw = ctx.measureText(text).width;
  const y = 0.95 * h;
  ctx.globalAlpha = a;
  ctx.fillStyle = "rgba(8, 10, 16, 0.65)";
  ctx.beginPath();
  ctx.roundRect(w / 2 - tw / 2 - 16, y - 24, tw + 32, 36, 18);
  ctx.fill();
  ctx.fillStyle = "#fff4e6";
  ctx.textAlign = "center";
  ctx.fillText(text, w / 2, y);
  ctx.globalAlpha = 1;
}

export function drawScene(ctx: CanvasRenderingContext2D, view: SceneView, rect: Rect): void {
  ctx.save();
  ctx.translate(rect.x, rect.y);
  ctx.beginPath();
  ctx.rect(0, 0, rect.w, rect.h);
  ctx.clip();
  const { win, band } = layoutFor(rect.w, rect.h, view.compact);
  const setting = view.state.setting;
  const anchor =
    setting === "pool"
      ? drawPool(ctx, view, rect.w, rect.h, band)
      : setting === "ocean"
        ? drawOcean(ctx, view, rect.w, rect.h, band)
        : drawVent(ctx, view, rect.w, rect.h, band);
  drawWindow(ctx, view, win, anchor);
  if (view.compact) {
    drawColumnLabel(ctx, view, rect.w, rect.h);
  } else {
    drawCaption(ctx, view, rect.w, rect.h);
  }
  ctx.restore();
}

/** Compare view: the setting's name, a row of ladder dots, and how far it has got. */
function drawColumnLabel(ctx: CanvasRenderingContext2D, view: SceneView, w: number, h: number): void {
  const s = view.state;
  const y = 0.83 * h;
  ctx.fillStyle = "rgba(6, 9, 14, 0.62)";
  ctx.fillRect(0, y - 34, w, h - y + 34);
  ctx.textAlign = "center";
  ctx.fillStyle = "#ffffff";
  ctx.font = "700 22px system-ui, sans-serif";
  ctx.fillText(SETTING_NAMES[s.setting], w / 2, y);
  const gap = 34;
  RUNGS.forEach((_, i) => {
    const x = w / 2 + (i - 3) * gap;
    ctx.beginPath();
    ctx.arc(x, y + 26, 9, 0, Math.PI * 2);
    if (i <= s.level) {
      ctx.fillStyle = i === RUNGS.length - 1 ? COPIER_GLOW : "#7fd3c4";
      ctx.fill();
    } else {
      ctx.strokeStyle = i <= s.best ? "rgba(127, 211, 196, 0.8)" : "rgba(255, 255, 255, 0.25)";
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  });
  ctx.font = "17px system-ui, sans-serif";
  ctx.fillStyle = "rgba(235, 240, 245, 0.85)";
  const status = s.lifeLost && s.level < RUNGS.length - 1 ? "Life lost" : s.level >= 0 ? RUNG_LABELS[s.level] : "Nothing yet";
  ctx.fillText(status, w / 2, y + 62);
}

// ─── Chain-length histogram ──────────────────────────────────────────────────

const LOG_MIN = -6;
const LOG_MAX = 1;

export function drawHistogram(ctx: CanvasRenderingContext2D, s: ChemState): void {
  const w = HIST_W;
  const h = HIST_H;
  ctx.clearRect(0, 0, w, h);
  const c = concentrations(s);
  const left = 34;
  const right = w - 58;
  const top = 22;
  const bottom = h - 22;
  const barW = (right - left) / N_MAX;
  const yOf = (x: number): number => {
    const f = (Math.log10(Math.max(x, 10 ** LOG_MIN)) - LOG_MIN) / (LOG_MAX - LOG_MIN);
    return bottom - Math.min(1, Math.max(0, f)) * (bottom - top);
  };

  ctx.font = "600 12px system-ui, sans-serif";
  ctx.fillStyle = "rgba(235, 232, 226, 0.85)";
  ctx.textAlign = "left";
  ctx.fillText("Chain lengths", 4, 13);
  ctx.font = "11px system-ui, sans-serif";
  ctx.fillStyle = "rgba(235, 232, 226, 0.55)";
  ctx.textAlign = "right";
  ctx.fillText("amount, log scale", w - 4, 13);

  // Long-chain zone.
  const xLong = left + (COPIER_LEN - 1) * barW;
  ctx.fillStyle = "rgba(255, 255, 255, 0.05)";
  ctx.fillRect(xLong, top, right - xLong, bottom - top);
  for (let n = 1; n <= N_MAX; n += 1) {
    const y = yOf(c.chains[n]);
    ctx.fillStyle = n === 1 ? "#5ec8f2" : n < COPIER_LEN ? "#8fb8c8" : "#cfe6ea";
    ctx.fillRect(left + (n - 1) * barW + 0.5, y, barW - 1, bottom - y);
  }
  const yc = yOf(c.copiers);
  ctx.fillStyle = COPIER_GLOW;
  ctx.fillRect(right + 22, yc, 22, bottom - yc);

  ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(left, bottom + 0.5);
  ctx.lineTo(right + 44, bottom + 0.5);
  ctx.stroke();
  ctx.fillStyle = "rgba(235, 232, 226, 0.6)";
  ctx.font = "11px system-ui, sans-serif";
  ctx.textAlign = "center";
  [1, 10, 20, 30].forEach((n) => ctx.fillText(String(n), left + (n - 0.5) * barW, bottom + 14));
  ctx.textAlign = "right";
  ctx.fillText("copiers", w - 2, bottom + 14);
  ctx.textAlign = "left";
  ctx.fillText("long", xLong + 3, top + 11);
  ctx.textAlign = "right";
  ctx.fillText("1", left - 5, yOf(1) + 4);
  ctx.fillText("10⁻⁶", left - 5, bottom);
  ctx.globalAlpha = 1;
}
