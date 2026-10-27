import type { Rng } from "../../core/seededRng";

export type SettingId = "pool" | "ocean" | "vent";
export type ViewId = SettingId | "compare";
export type VentType = "alkaline" | "smoker";
export type HazardLevel = "off" | "rare" | "often";
export type EventKind = "flood" | "drought" | "impact" | "shutdown";

export type PoolSettings = {
  /** 0 = the pool never shrinks, 1 = it nearly dries out every cycle. */
  drying: number;
  /** Sunlight (UV) relative to a typical early-Earth day. */
  uv: number;
  /** °C */
  temperature: number;
  phosphate: boolean;
  clay: boolean;
};

export type OceanSettings = {
  /** Depth (m) through which the ocean mixes what forms near its surface. */
  depth: number;
  /** Raw-material supply relative to the pool's. */
  supply: number;
};

export type VentSettings = {
  type: VentType;
  /** Temperature of the fluid coming out of the vent (°C). */
  temperature: number;
  /** pH and chemical (H₂) gradient between vent fluid and seawater, 0–1. */
  gradient: number;
  /** Vent-fluid flow relative to typical. */
  flow: number;
  /** How porous the chimney is, 0–1. */
  pores: number;
  minerals: boolean;
};

export type Settings = {
  pool: PoolSettings;
  ocean: OceanSettings;
  vent: VentSettings;
  hazards: HazardLevel;
};

/** What the setting provides at one moment; the chemistry only sees this. */
export type Conditions = {
  /** Water left, relative to a full pool (1 elsewhere). Concentrations scale as 1 / water. */
  water: number;
  /** d(water)/dt per cycle: re-wetting folds lipids into vesicles around what is there. */
  waterRate: number;
  /** How much liquid water surrounds the molecules, 0–1: low when drying. */
  waterActivity: number;
  /** Temperature where the chemistry happens (°C). */
  temperature: number;
  /** Volume the products spread through, relative to a pool. */
  volume: number;
  /** Raw material arriving (amount per cycle). */
  supply: number;
  /** Raw material → building blocks (per cycle). */
  synthesis: number;
  /** Energy pushing building blocks to join (multiplies the joining rate). */
  joinDrive: number;
  /** UV damage per building-block unit per cycle. */
  uvDamage: number;
  /** Fraction of the contents carried away per cycle (before trapping). */
  washout: number;
  /** Thermophoretic trapping in pores: larger molecules are held more strongly. */
  trap: number;
  /** Mineral pores act as ready-made compartments, 0–1. */
  poreCompartments: number;
  /** Lipids made alongside the building blocks (share of the synthesis). */
  lipidShare: number;
  /** Instability added per cycle (a black smoker keeps shifting and clogging). */
  disruption: number;
};

export type ActiveEvent = { kind: EventKind; until: number };

export type Rung = "blocks" | "concentrated" | "short" | "long" | "copying" | "enclosed" | "life";

export type Gauges = {
  /** 0–1 bars, smoothed over about a cycle. */
  ingredients: number;
  energy: number;
  stability: number;
};

export type Diagnostics = {
  /** Concentrations (relative units, smoothed over about a cycle). */
  blocks: number;
  /** All building material, free or in chains (in building-block units). */
  material: number;
  shortChains: number;
  longChains: number;
  copiers: number;
  /** Joining vs breaking: how many units a chain tends to add before a bond breaks. */
  growth: number;
  breakRate: number;
  enclosed: number;
  vesicles: number;
  temperature: number;
};

export type ChemState = {
  setting: SettingId;
  /** Time in cycles (one wet–dry cycle of the pool). */
  t: number;
  feed: number;
  /** Amount of chains of each length; index 1 = single building blocks. */
  chains: Float64Array;
  copiers: number;
  lipids: number;
  /** Fraction of the self-copying chains inside a compartment. */
  enclosed: number;
  /** Instability memory: jumps with each event and fades over ~10 cycles. */
  disruption: number;
  /** Cycles that enclosed self-copying has lasted. */
  held: number;
  /** Highest rung reached (−1 = none), and whether life has been lost since. */
  best: number;
  lifeLost: boolean;
  /** Rung index reached now (−1 = none). */
  level: number;
  /** Cycle at which each rung was first reached (NaN = not yet). */
  reachedAt: number[];
  events: ActiveEvent[];
  /** Recent events, for the picture and the event caption. */
  lastEvent: { kind: EventKind; t: number } | null;
  nextHazardCheck: number;
  rng: Rng;
  conditions: Conditions;
  gauges: Gauges;
  diag: Diagnostics;
};
