import type { ActiveEvent, Conditions, PoolSettings, OceanSettings, SettingId, Settings, VentSettings } from "./types";

/**
 * Each setting turns its controls into the conditions the chemistry sees: how much water there
 * is, how warm it is, how much raw material and energy arrive, and what carries molecules away.
 * Numbers are relative and illustrative; only their ordering between settings is meant to hold.
 */

/** Seawater temperature around the vents and in the open ocean (°C). */
export const SEAWATER_C = 20;
/** Drought: the pool is down to this much water. */
const DROUGHT_WATER = 0.02;
/** The pool's catchment funnels raw material in: amount per cycle. */
export const BASE_SUPPLY = 0.15;
/** Pool depth used to compare the ocean's mixing volume with a pool (m). */
const POOL_DEPTH_M = 0.5;

export const POOL_DEFAULTS: PoolSettings = { drying: 0.8, uv: 1, temperature: 40, phosphate: true, clay: true };
export const OCEAN_DEFAULTS: OceanSettings = { depth: 1000, supply: 1 };
export const ALKALINE_DEFAULTS: VentSettings = { type: "alkaline", temperature: 70, gradient: 0.7, flow: 1, pores: 0.7, minerals: true };
export const SMOKER_TEMPERATURE = 350;
export const VENT_LIMITS = {
  alkaline: { min: 30, max: 120 },
  smoker: { min: 250, max: 400 }
} as const;

export const DEFAULT_SETTINGS: Settings = {
  pool: POOL_DEFAULTS,
  ocean: OCEAN_DEFAULTS,
  vent: ALKALINE_DEFAULTS,
  hazards: "rare"
};

function active(events: ActiveEvent[], kind: ActiveEvent["kind"], t: number): boolean {
  return events.some((e) => e.kind === kind && t < e.until);
}

function clamp(x: number, a: number, b: number): number {
  return Math.min(b, Math.max(a, x));
}

/** Deterministic pseudo-random numbers for weather cycle k (the same every run). */
function cycleRandom(k: number, i: number): number {
  const x = Math.sin(k * 127.1 + i * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

export type PoolWeather = {
  /** Water left, relative to a full pool. */
  water: number;
  /** d(water)/dt per cycle. */
  waterRate: number;
  /** Rain falling (0 = none, ~1 = a typical downpour). */
  rain: number;
  /** Cloud cover, 0–1: clouds gather before the rain and clear after it. */
  cloud: number;
};

/** Average share of a cycle before run-off starts refilling the pool. */
const MEAN_FILL_START = 0.7;

/**
 * Weather over the pool, one dry spell and one rainy spell per cycle. Each cycle differs: how long
 * the dry spell lasts, how fast the water evaporates, when the rain starts and how hard it falls.
 * The pool evaporates through the dry spell; rain first soaks the surrounding ground and only
 * refills the pool once run-off arrives; the pool is full again when the rain ends.
 */
export function poolWeather(p: PoolSettings, t: number): PoolWeather {
  const k = Math.floor(t);
  const phase = t - k;
  const rainy = 0.25 + 0.12 * cycleRandom(k, 1);
  const rainStart = 1 - rainy;
  const fillStart = rainStart + 0.05 + 0.04 * cycleRandom(k, 2);
  const low = 1 - 0.95 * p.drying;
  // Evaporation: on average the pool is down to `low` when run-off arrives; sunnier spells dry it further.
  const evaporation = (-Math.log(low) / MEAN_FILL_START) * (0.75 + 0.5 * cycleRandom(k, 3));
  const atFill = Math.exp(-evaporation * fillStart);
  // Fill fast enough to be full by the end of the rain.
  const fill = Math.max((6 + 4 * cycleRandom(k, 4)) * (1 - atFill), (1 - atFill) / (0.98 - fillStart));
  let water: number;
  let waterRate: number;
  if (phase < fillStart) {
    water = Math.exp(-evaporation * phase);
    waterRate = -evaporation * water;
  } else {
    water = Math.min(1, atFill + fill * (phase - fillStart));
    waterRate = water < 1 ? fill : 0;
  }
  const intensity = 0.6 + 0.6 * cycleRandom(k, 5);
  const rain = intensity * smooth(rainStart, rainStart + 0.03, phase) * (1 - smooth(0.985, 1, phase));
  const cloud = Math.max(smooth(rainStart - 0.12, rainStart - 0.01, phase), 1 - smooth(0, 0.08, phase));
  return { water, waterRate, rain, cloud };
}

function smooth(a: number, b: number, x: number): number {
  const f = clamp((x - a) / (b - a), 0, 1);
  return f * f * (3 - 2 * f);
}

/** Water activity: concentrated brine in a drying pool leaves little free water to break bonds. */
function activityFromWater(water: number): number {
  return clamp((water - 0.02) / 0.6, 0.03, 1);
}

function poolConditions(p: PoolSettings, t: number, events: ActiveEvent[]): Conditions {
  const drought = active(events, "drought", t);
  const weather = poolWeather(p, t);
  let water = weather.water;
  let waterRate = weather.waterRate;
  if (drought) {
    water = DROUGHT_WATER;
    waterRate = 0;
  }
  const aw = activityFromWater(water);
  // Shallow water shields less UV.
  const exposure = 1 / (0.3 + water);
  return {
    water,
    waterRate,
    waterActivity: aw,
    temperature: p.temperature,
    volume: 1,
    supply: BASE_SUPPLY,
    // Sunlight drives the chemistry that builds nucleotide-like building blocks; it needs phosphate.
    synthesis: 0.25 * p.uv * (p.phosphate ? 1 : 0.1),
    // Drying pulls water out of the bonds being made (condensation); clay surfaces line building blocks up.
    joinDrive: (1 + 300 * (1 - aw) ** 3) * (p.clay ? 3 : 1),
    uvDamage: 0.015 * p.uv * exposure,
    washout: 0.003,
    trap: 0,
    poreCompartments: 0,
    lipidShare: 0.3,
    disruption: drought ? 0.25 : 0
  };
}

function oceanConditions(o: OceanSettings): Conditions {
  return {
    water: 1,
    waterRate: 0,
    waterActivity: 1,
    temperature: 25,
    // What forms near the surface is mixed down through the whole mixed layer.
    volume: o.depth / POOL_DEPTH_M,
    supply: BASE_SUPPLY * o.supply,
    // Sunlight reaches only the top few metres.
    synthesis: 0.08,
    joinDrive: 1,
    uvDamage: 0.0005,
    washout: 0.01,
    trap: 0,
    poreCompartments: 0,
    lipidShare: 0.3,
    disruption: 0
  };
}

/** Temperature inside the chimney's pores: between the vent fluid and the seawater. */
export function poreTemperature(v: VentSettings): number {
  return SEAWATER_C + 0.35 * (v.temperature - SEAWATER_C);
}

function ventConditions(v: VentSettings, t: number, events: ActiveEvent[]): Conditions {
  const off = active(events, "shutdown", t);
  const gradient = off ? 0 : v.gradient;
  const flow = off ? 0 : v.flow;
  const dT = off ? 0 : v.temperature - SEAWATER_C;
  const minerals = v.minerals ? 1 : 0.25;
  return {
    water: 1,
    waterRate: 0,
    waterActivity: 1,
    temperature: off ? SEAWATER_C : poreTemperature(v),
    volume: 1,
    // H₂ and CO₂ react on iron–sulfur minerals, driven by the gradient.
    supply: 2 * BASE_SUPPLY * gradient * minerals * Math.sqrt(flow),
    synthesis: 0.25 * gradient * minerals,
    // Assumed: the gradient's energy is coupled into joining building blocks.
    joinDrive: 1 + 25 * gradient * minerals,
    uvDamage: 0,
    // With the vent off, seawater slowly seeps through the pores.
    washout: 0.15 * flow + (off ? 0.03 : 0),
    // Heat flowing across a pore drives molecules toward its cold end (thermophoresis).
    trap: (2.2 * v.pores * dT) / 50,
    poreCompartments: 0.6 * v.pores,
    lipidShare: 0.3,
    disruption: v.type === "smoker" ? 0.12 : 0
  };
}

export function conditionsAt(setting: SettingId, s: Settings, t: number, events: ActiveEvent[]): Conditions {
  if (setting === "pool") {
    return poolConditions(s.pool, t, events);
  }
  if (setting === "ocean") {
    return oceanConditions(s.ocean);
  }
  return ventConditions(s.vent, t, events);
}
