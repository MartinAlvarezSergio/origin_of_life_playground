import { createRng, nextRandom } from "../../core/seededRng";
import { conditionsAt } from "./environment";
import type { ChemState, Conditions, EventKind, Rung, SettingId, Settings } from "./types";

/**
 * A well-mixed box of prebiotic chemistry, driven by its setting (see environment.ts):
 *
 *   raw material → building blocks (monomers) → chains, by adding one block at a time
 *   water breaks chains at random bonds (hydrolysis), faster when hot
 *   a rare long chain can copy itself, using up building blocks
 *   lipids made alongside form vesicles once concentrated enough; re-wetting or mineral pores
 *   enclose the copiers
 *
 * Everything is in relative units; one time unit is one wet–dry cycle of the pool. The rates are
 * illustrative, chosen so that the competition between joining and breaking (which depends on
 * concentration) is what decides how far each setting gets.
 */

/** Longest chain tracked; longer chains stay in the last bin. */
export const N_MAX = 30;
/** Length of a self-copying chain. */
export const COPIER_LEN = 20;
/** "Short" chains start at this length. */
export const SHORT_LEN = 5;

/** Bond breaking per bond per cycle in water at 25 °C. */
const K_BREAK = 0.005;
/** Joining per unit concentration per cycle, in water with no extra energy, at 25 °C. */
const K_JOIN = 0.002;
/** Building blocks falling apart per cycle at 25 °C. */
const K_DECAY = 0.001;
/** Copying per cycle with plentiful building blocks and no extra energy. */
const K_COPY = 0.07;
/** Raw material that is not turned into building blocks breaks down (per cycle). */
const FEED_DECAY = 0.05;
/** Building-block concentration at which copying runs at half speed. */
const COPY_HALF = 1;
/** Chance that a new long chain has a sequence that can copy itself. */
const COPIER_CHANCE = 0.01;
/** A folded copier breaks this much more slowly than a loose chain. */
const COPIER_PROTECT = 0.2;
/** Lipid concentration above which vesicles form (critical vesicle concentration). */
const LIPID_CVC = 0.3;
/** Breaking and decay speed up this much per 10 °C; joining by the smaller factor. */
const HEAT_FACTOR = 2.5;
const JOIN_HEAT_FACTOR = 1.6;
/** Enclosed self-copying must last this many cycles to count as life. */
export const LIFE_HOLD = 30;
const SUBSTEP = 0.02;

export const RUNGS: Rung[] = ["blocks", "concentrated", "short", "long", "copying", "enclosed", "life"];

/** Thresholds (relative concentrations, smoothed over about a cycle). */
export const THRESHOLD = {
  blocks: 1e-5,
  concentrated: 0.3,
  short: 0.01,
  long: 1e-3,
  copying: 3e-3,
  enclosed: 0.5
} as const;

const HAZARD_RATE = { off: 0, rare: 1 / 200, often: 1 / 50 } as const;

export const EVENTS_FOR: Record<SettingId, EventKind[]> = {
  pool: ["flood", "drought", "impact"],
  ocean: ["impact"],
  vent: ["shutdown", "impact"]
};

/** Relative chance of each random event in a setting. */
const EVENT_WEIGHTS: Record<SettingId, Partial<Record<EventKind, number>>> = {
  pool: { flood: 0.55, drought: 0.35, impact: 0.1 },
  ocean: { impact: 0.3 },
  vent: { shutdown: 0.85, impact: 0.15 }
};

function emptyConditions(): Conditions {
  return {
    water: 1,
    waterRate: 0,
    waterActivity: 1,
    temperature: 25,
    volume: 1,
    supply: 0,
    synthesis: 0,
    joinDrive: 1,
    uvDamage: 0,
    washout: 0,
    trap: 0,
    poreCompartments: 0,
    lipidShare: 0,
    disruption: 0
  };
}

export function createChem(setting: SettingId, seed = 1): ChemState {
  return {
    setting,
    t: 0,
    feed: 0,
    chains: new Float64Array(N_MAX + 1),
    copiers: 0,
    lipids: 0,
    enclosed: 0,
    disruption: 0,
    held: 0,
    best: -1,
    lifeLost: false,
    level: -1,
    reachedAt: RUNGS.map(() => NaN),
    events: [],
    lastEvent: null,
    nextHazardCheck: 1,
    rng: createRng(seed),
    conditions: emptyConditions(),
    gauges: { ingredients: 0, energy: 0, stability: 1 },
    diag: { blocks: 0, material: 0, shortChains: 0, longChains: 0, copiers: 0, growth: 0, breakRate: 0, enclosed: 0, vesicles: 0, temperature: 25 }
  };
}

function heat(temperature: number, factor: number): number {
  return factor ** Math.min(40, (temperature - 25) / 10);
}

export type Rates = {
  /** Per bond per cycle. */
  breakRate: number;
  /** Per unit concentration per cycle. */
  joinRate: number;
  decay: number;
};

export function ratesFor(c: Conditions): Rates {
  return {
    breakRate: K_BREAK * heat(c.temperature, HEAT_FACTOR) * c.waterActivity ** 2,
    joinRate: K_JOIN * c.joinDrive * heat(c.temperature, JOIN_HEAT_FACTOR),
    decay: K_DECAY * heat(c.temperature, HEAT_FACTOR)
  };
}

function smoothstep(a: number, b: number, x: number): number {
  const f = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return f * f * (3 - 2 * f);
}

/** Share of lipids in vesicles at this lipid concentration. */
export function vesicleShare(lipidConcentration: number): number {
  return smoothstep(0.5 * LIPID_CVC, 2 * LIPID_CVC, lipidConcentration);
}

/** Current volume the molecules are dissolved in. */
export function liquidVolume(s: ChemState): number {
  return s.conditions.volume * s.conditions.water;
}

const gains = new Float64Array(N_MAX + 2);

/** One semi-implicit step: gains explicit, losses implicit, so amounts stay positive. */
export function reactOnce(s: ChemState, c: Conditions, dt: number): void {
  const vol = c.volume * c.water;
  const { breakRate: kb, joinRate: kj, decay: kd } = ratesFor(c);
  const out = (n: number): number => c.washout * Math.exp(-c.trap * Math.sqrt(n));
  const A = s.chains;
  const x1 = A[1] / vol;

  gains.fill(0);
  // Joining: a block adds to a chain of length n (two blocks make a pair).
  const join = (n: number): number => (n === 1 ? kj * x1 * x1 * vol : kj * x1 * A[n]);
  for (let n = 2; n <= N_MAX; n += 1) {
    gains[n] += join(n - 1);
  }
  // New long chains: a few have a sequence that can copy itself.
  const newCopiers = COPIER_CHANCE * join(COPIER_LEN - 1);
  gains[COPIER_LEN] -= newCopiers;

  // Breaking at a random bond: a chain of length m gives two pieces; each length below m gains 2 per break.
  let longer = 0;
  for (let n = N_MAX; n >= 1; n -= 1) {
    gains[n] += 2 * kb * longer;
    longer += A[n];
  }
  const kbCopier = kb * COPIER_PROTECT;
  for (let n = 1; n < COPIER_LEN; n += 1) {
    gains[n] += 2 * kbCopier * s.copiers;
  }

  // Raw material → building blocks.
  gains[1] += c.synthesis * s.feed;

  // Copying: templated joining uses up COPIER_LEN blocks per copy.
  // Copying is templated joining, so the same energy speeds it up (more gently).
  const copyRate = K_COPY * Math.sqrt(kj / K_JOIN) * (x1 / (x1 + COPY_HALF)) * (1 + 0.5 * s.enclosed);
  const copies = copyRate * s.copiers;

  // Losses per unit amount.
  let chainSum = 0;
  for (let n = 2; n < N_MAX; n += 1) {
    chainSum += A[n];
  }
  const blockUse = kj * (2 * x1 + chainSum / vol) + (A[1] > 1e-30 ? (copies * COPIER_LEN) / A[1] : 0);
  const blockLoss = blockUse + kd + c.uvDamage + out(1);

  const nextBlocks = (A[1] + gains[1] * dt) / (1 + blockLoss * dt);
  for (let n = 2; n <= N_MAX; n += 1) {
    const loss = (n < N_MAX ? kj * x1 : 0) + kb * (n - 1) + (kd + c.uvDamage) * n + out(n);
    A[n] = Math.max(0, (A[n] + gains[n] * dt) / (1 + loss * dt));
  }
  A[1] = nextBlocks;

  const copierLoss =
    kbCopier * (COPIER_LEN - 1) + (kd + c.uvDamage) * COPIER_LEN * COPIER_PROTECT + out(COPIER_LEN) * (1 - 0.9 * s.enclosed);
  s.copiers = (s.copiers + (newCopiers + copies) * dt) / (1 + copierLoss * dt);

  s.feed = (s.feed + c.supply * dt) / (1 + (c.synthesis + FEED_DECAY + 0.5 * kd + out(1)) * dt);
  s.lipids = (s.lipids + c.lipidShare * c.synthesis * s.feed * dt) / (1 + (kd + c.uvDamage + out(8)) * dt);

  // Compartments: re-wetting folds lipid films into vesicles around what is there; pores are ready-made.
  const vesicles = vesicleShare(s.lipids / vol);
  const encloseRate = vesicles * (0.02 + 0.5 * Math.max(0, c.waterRate)) + 0.06 * c.poreCompartments;
  const openRate = 0.01 + 0.2 * c.washout * (1 - c.poreCompartments);
  s.enclosed = (s.enclosed + encloseRate * dt) / (1 + (encloseRate + openRate) * dt);

  s.disruption += (c.disruption - s.disruption / 10) * dt;
}

/** Instantaneous concentrations, for the picture. */
export function concentrations(s: ChemState): { blocks: number; chains: Float64Array; copiers: number; lipids: number } {
  const vol = liquidVolume(s);
  const chains = new Float64Array(N_MAX + 1);
  for (let n = 1; n <= N_MAX; n += 1) {
    chains[n] = s.chains[n] / vol;
  }
  return { blocks: chains[1], chains, copiers: s.copiers / vol, lipids: s.lipids / vol };
}

function updateDiagnostics(s: ChemState, dt: number): void {
  const c = s.conditions;
  const vol = liquidVolume(s);
  const r = ratesFor(c);
  let short = 0;
  let long = 0;
  let units = COPIER_LEN * s.copiers;
  for (let n = 1; n <= N_MAX; n += 1) {
    units += n * s.chains[n];
  }
  for (let n = SHORT_LEN; n <= N_MAX; n += 1) {
    short += s.chains[n];
    if (n >= COPIER_LEN) {
      long += s.chains[n];
    }
  }
  const now = {
    blocks: s.chains[1] / vol,
    material: units / vol,
    shortChains: (short + s.copiers) / vol,
    longChains: (long + s.copiers) / vol,
    copiers: s.copiers / vol,
    growth: r.breakRate > 0 ? (r.joinRate * s.chains[1]) / vol / r.breakRate : Infinity,
    breakRate: r.breakRate,
    enclosed: s.enclosed,
    vesicles: vesicleShare(s.lipids / vol),
    temperature: c.temperature
  };
  // Smooth over about one cycle so the pool's wet–dry swings don't flicker the ladder.
  const a = 1 - Math.exp(-dt / 1);
  const d = s.diag;
  (Object.keys(now) as (keyof typeof now)[]).forEach((k) => {
    const v = Number.isFinite(now[k]) ? now[k] : 1e6;
    d[k] = d[k] + (v - d[k]) * a;
  });

  const energyRatio = r.breakRate > 0 ? r.joinRate / r.breakRate : 1e3;
  const g = s.gauges;
  g.ingredients += (Math.min(1, Math.max(0, (Math.log10(Math.max(1e-9, d.material)) + 5) / 6)) - g.ingredients) * a;
  g.energy += (Math.min(1, Math.max(0, (Math.log10(Math.max(1e-9, energyRatio)) + 2) / 4)) - g.energy) * a;
  g.stability = Math.exp(-s.disruption / 1.2);
}

function updateLadder(s: ChemState, dt: number): void {
  const d = s.diag;
  const copying = d.copiers >= THRESHOLD.copying;
  const enclosed = copying && d.enclosed >= THRESHOLD.enclosed;
  s.held = enclosed ? s.held + dt : Math.max(0, s.held - 2 * dt);
  const met = [
    d.blocks >= THRESHOLD.blocks,
    d.material >= THRESHOLD.concentrated,
    d.shortChains >= THRESHOLD.short,
    d.longChains >= THRESHOLD.long,
    copying,
    enclosed,
    enclosed && s.held >= LIFE_HOLD
  ];
  let level = -1;
  while (level + 1 < met.length && met[level + 1]) {
    level += 1;
  }
  // Once alive, it stays alive as long as enclosed copiers remain.
  if (s.best === RUNGS.length - 1 && !s.lifeLost && d.copiers >= THRESHOLD.copying * 0.3 && d.enclosed >= 0.3) {
    level = RUNGS.length - 1;
  }
  s.level = level;
  for (let i = 0; i <= level; i += 1) {
    if (Number.isNaN(s.reachedAt[i])) {
      s.reachedAt[i] = s.t;
    }
  }
  if (s.best === RUNGS.length - 1 && level < RUNGS.indexOf("copying")) {
    s.lifeLost = true;
  }
  s.best = Math.max(s.best, level);
}

export function triggerEvent(s: ChemState, settings: Settings, kind: EventKind): void {
  if (!EVENTS_FOR[s.setting].includes(kind)) {
    return;
  }
  const scale = (f: number): void => {
    for (let n = 1; n <= N_MAX; n += 1) {
      s.chains[n] *= f;
    }
    s.copiers *= f;
    s.feed *= f;
    s.lipids *= f;
  };
  if (kind === "flood") {
    // The pool overflows: most of what had built up is washed away.
    scale(0.15);
    s.enclosed *= 0.5;
    s.disruption += 1.5;
  } else if (kind === "drought") {
    s.events.push({ kind, until: s.t + 5 });
    s.disruption += 0.8;
  } else if (kind === "impact") {
    // A large impact boils and sterilises the site.
    scale(0.01);
    s.enclosed = 0;
    s.disruption += 4;
  } else {
    const smoker = settings.vent.type === "smoker";
    s.events.push({ kind, until: s.t + (smoker ? 15 : 40) });
    s.disruption += 1.5;
  }
  s.lastEvent = { kind, t: s.t };
}

function rollHazards(s: ChemState, settings: Settings): void {
  while (s.t >= s.nextHazardCheck) {
    s.nextHazardCheck += 1;
    const weights = EVENT_WEIGHTS[s.setting];
    const rate = HAZARD_RATE[settings.hazards];
    for (const kind of EVENTS_FOR[s.setting]) {
      if (nextRandom(s.rng) < rate * (weights[kind] ?? 0)) {
        triggerEvent(s, settings, kind);
      }
    }
    // Black smokers clog, crumble and shift on their own.
    if (s.setting === "vent" && settings.vent.type === "smoker" && nextRandom(s.rng) < 1 / 40) {
      triggerEvent(s, settings, "shutdown");
    }
  }
}

/** Advance by `dt` cycles. */
export function stepChem(s: ChemState, settings: Settings, dt: number): void {
  let left = Math.max(0, dt);
  while (left > 1e-9) {
    const h = Math.min(SUBSTEP, left);
    rollHazards(s, settings);
    s.events = s.events.filter((e) => s.t < e.until);
    s.conditions = conditionsAt(s.setting, settings, s.t, s.events);
    reactOnce(s, s.conditions, h);
    s.t += h;
    left -= h;
    updateDiagnostics(s, h);
    updateLadder(s, h);
  }
}

/** Run a fresh setting for `cycles` and return the final state (used by tests). */
export function runFor(setting: SettingId, settings: Settings, cycles: number, seed = 1): ChemState {
  const s = createChem(setting, seed);
  stepChem(s, settings, cycles);
  return s;
}
