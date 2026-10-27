import { createRng, gaussian, nextRandom, type Rng } from "../../core/seededRng";
import { concentrations, COPIER_LEN, N_MAX, RUNGS, vesicleShare } from "./sim";
import type { ChemState } from "./types";

/**
 * The zoomed-in window: representative molecules whose numbers follow the simulated
 * concentrations. Positions are in units of the window's half-height (y in −1…1, x in
 * −aspect…aspect); the renderer scales them. Each molecule lives a few seconds, so the counts
 * track the chemistry without popping. When a kind is so scarce that the window would hold less
 * than a few, its molecules instead drift through: each enters at an edge, crosses and leaves.
 *
 * Once the chemistry counts as alive, each vesicle holding a self-copying chain is a cell: it grows
 * while its chain builds a copy, the finished copy peels off as a second chain, and the cell pinches
 * in two, one chain in each daughter.
 */

export type MoleculeKind = "block" | "chain" | "copier" | "lipid";

export type LensMolecule = {
  kind: MoleculeKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  spin: number;
  len: number;
  /** Building-block types along the chain (0–3). */
  seq: number[];
  /** Fixed turn between neighbouring links (rad), giving each chain its own shape. */
  bends: number[];
  age: number;
  life: number;
  /** Copiers: how far the copy being made has got (0–1). */
  copy: number;
  /** Index into vesicles when enclosed, else −1. */
  home: number;
  /** Passing through the window (a scarce molecule) rather than lingering in it. */
  crossing: boolean;
  /** While its cell divides: which half it goes to (−1 or +1), else 0. */
  side: number;
};

export type LensVesicle = {
  x: number;
  y: number;
  r: number;
  /** Grown-up radius it settles to (a cell swells beyond it before dividing). */
  base: number;
  /** Division progress 0–1, or −1 when not dividing. */
  split: number;
  /** Direction the two halves move apart (rad). */
  axis: number;
  /** On its way out (making room, or no longer alive): it fades and is not revived as a cell. */
  fading: boolean;
  vx: number;
  vy: number;
  age: number;
  life: number;
};

export type Lens = {
  molecules: LensMolecule[];
  vesicles: LensVesicle[];
  rng: Rng;
  /**
   * 0–1: how sparse the building blocks are (1 = the window would hold about one or none, though
   * some exist), smoothed over a couple of seconds. The renderer uses it for the faint ones far off.
   */
  sparse: number;
};

/** Window shape: width ÷ height, and how many molecules it holds relative to the main view. */
export type LensShape = { aspect: number; capacity: number };

const LIFETIME = 5;
/** Counts in the full-size window; they saturate so a crowded pool stays readable. */
const MAX: Record<MoleculeKind, number> = { block: 110, chain: 34, copier: 10, lipid: 40 };
const MAX_VESICLES = 7;
const MARGIN = 0.08;
/** Below this many expected in the window, a kind's molecules pass through instead of lingering. */
const CROSS_BELOW = 3;
/** Speed of a passing molecule (window half-heights per second): it crosses in ~10 s. */
const CROSS_SPEED = 0.34;
/** While any building blocks exist, one passes at least this often (seconds), so the window isn't always empty. */
const CROSS_EVERY = 12;
/** Cell cycle at normal speed (seconds): copying the chain, then pinching in two. */
const CELL_COPY_TIME = 3.5;
const DIVIDE_TIME = 1.6;
/** A cell swells this much (in radius) while it copies its chain. */
const CELL_GROWTH = 0.22;
/** Each daughter's radius, as a share of the parent's (about half the area each). */
const DAUGHTER = 0.74;

/** The two halves of a dividing vesicle: each half's radius, and how far each centre is from the middle. */
export function vesicleHalves(v: LensVesicle): { r: number; d: number } {
  if (v.split < 0) {
    return { r: v.r, d: 0 };
  }
  const r = v.r * (1 - (1 - DAUGHTER) * v.split);
  return { r, d: v.split * r * 1.02 };
}

export function createLens(seed = 7): Lens {
  return { molecules: [], vesicles: [], rng: createRng(seed), sparse: 0 };
}

export function clearLens(lens: Lens): void {
  lens.molecules = [];
  lens.vesicles = [];
  lens.sparse = 0;
}

function smoothstep(a: number, b: number, x: number): number {
  const f = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return f * f * (3 - 2 * f);
}

function saturate(x: number, max: number, half: number): number {
  return (max * x) / (x + half);
}

/** Chain length drawn by mass, so the long chains that hold the material are seen. */
function sampleLength(rng: Rng, chains: Float64Array): number {
  let total = 0;
  for (let n = 2; n <= N_MAX; n += 1) {
    total += n * chains[n];
  }
  if (total <= 0) {
    return 2;
  }
  let u = nextRandom(rng) * total;
  for (let n = 2; n <= N_MAX; n += 1) {
    u -= n * chains[n];
    if (u <= 0) {
      return n;
    }
  }
  return N_MAX;
}

function spawn(lens: Lens, shape: LensShape, kind: MoleculeKind, len: number, enclosedShare: number): void {
  const { rng } = lens;
  let home = -1;
  let x = (2 * nextRandom(rng) - 1) * (shape.aspect - MARGIN);
  let y = (2 * nextRandom(rng) - 1) * (1 - MARGIN);
  const inside = kind === "copier" ? enclosedShare : kind === "chain" ? 0.3 * enclosedShare : 0;
  if (lens.vesicles.length > 0 && nextRandom(rng) < inside) {
    // One coiled chain per vesicle keeps them readable.
    const taken = new Set(lens.molecules.map((m) => m.home));
    const free = lens.vesicles.map((_, i) => i).filter((i) => !taken.has(i));
    if (free.length > 0) {
      home = free[Math.floor(nextRandom(rng) * free.length)];
      x = lens.vesicles[home].x;
      y = lens.vesicles[home].y;
    }
  }
  // A smooth random walk of turns: chains curve gently, not as rods.
  const bends: number[] = [];
  let b = 0;
  for (let k = 0; k < len; k += 1) {
    b = 0.75 * b + 0.18 * gaussian(rng);
    bends.push(b);
  }
  lens.molecules.push({
    kind,
    x,
    y,
    vx: 0,
    vy: 0,
    angle: nextRandom(rng) * Math.PI * 2,
    spin: (nextRandom(rng) - 0.5) * 0.5,
    len,
    seq: Array.from({ length: len }, () => Math.floor(nextRandom(rng) * 4)),
    bends,
    age: 0,
    life: LIFETIME * (0.6 + 0.8 * nextRandom(rng)) * (kind === "copier" ? 2 : 1),
    copy: nextRandom(rng),
    home,
    crossing: false,
    side: 0
  });
}

/** A scarce molecule enters just outside one edge and heads across, leaving by the far side. */
function spawnCrossing(lens: Lens, shape: LensShape, kind: MoleculeKind, len: number): void {
  spawn(lens, shape, kind, len, 0);
  const { rng } = lens;
  const m = lens.molecules[lens.molecules.length - 1];
  const fromSide = nextRandom(rng) < 0.75;
  const sign = nextRandom(rng) < 0.5 ? -1 : 1;
  // Mostly across the width (the long way), now and then top to bottom.
  const heading = (fromSide ? (sign < 0 ? 0 : Math.PI) : sign < 0 ? Math.PI / 2 : -Math.PI / 2) + 0.5 * (nextRandom(rng) - 0.5);
  if (fromSide) {
    m.x = sign * (shape.aspect + 0.12);
    m.y = (2 * nextRandom(rng) - 1) * 0.7;
  } else {
    m.x = (2 * nextRandom(rng) - 1) * (shape.aspect - 0.3);
    m.y = sign * 1.12;
  }
  m.vx = CROSS_SPEED * Math.cos(heading);
  m.vy = CROSS_SPEED * Math.sin(heading);
  m.life = Infinity;
  m.crossing = true;
}

function keepInside(p: { x: number; y: number; vx: number; vy: number }, aspect: number, pad: number): void {
  const xm = aspect - pad;
  const ym = 1 - pad;
  if (Math.abs(p.x) > xm) {
    p.x = Math.sign(p.x) * xm;
    p.vx *= -0.5;
  }
  if (Math.abs(p.y) > ym) {
    p.y = Math.sign(p.y) * ym;
    p.vy *= -0.5;
  }
}

/** Advance by `dt` seconds of wall time; `rate` is cycles per second (pace of the copy animation). */
export function updateLens(lens: Lens, s: ChemState, dt: number, rate: number, shape: LensShape): void {
  const { rng } = lens;
  const c = concentrations(s);
  let chainNumber = 0;
  for (let n = 2; n <= N_MAX; n += 1) {
    chainNumber += c.chains[n];
  }
  const vesicles = vesicleShare(c.lipids);
  const k = shape.capacity;
  const want: Record<MoleculeKind, number> = {
    block: saturate(c.blocks, MAX.block * k, 0.5),
    chain: saturate(chainNumber, MAX.chain * k, 0.1),
    copier: saturate(c.copiers, MAX.copier * k, 0.02),
    // Free lipids; once concentrated enough most of them sit in vesicle walls instead.
    lipid: saturate(c.lipids, MAX.lipid * k, 0.3) * (1 - 0.8 * vesicles)
  };
  const vesicleWant = Math.round(MAX_VESICLES * k * vesicles);
  const alive = s.level === RUNGS.length - 1;
  // The cell cycle runs at a watchable pace: a little slower at 1×, a little faster at 25×.
  const cellPace = Math.min(1.5, Math.max(0.5, rate / 2));
  const sparseNow = c.blocks > 0 ? 1 - smoothstep(1, CROSS_BELOW + 1, want.block) : 0;
  lens.sparse += (sparseNow - lens.sparse) * Math.min(1, dt / 2);

  // Spawn so that, with each molecule living ~LIFETIME, the average count matches the target.
  const have: Record<MoleculeKind, number> = { block: 0, chain: 0, copier: 0, lipid: 0 };
  const passing: Record<MoleculeKind, number> = { block: 0, chain: 0, copier: 0, lipid: 0 };
  lens.molecules.forEach((m) => {
    have[m.kind] += 1;
    passing[m.kind] += m.crossing ? 1 : 0;
  });
  (Object.keys(want) as MoleculeKind[]).forEach((kind) => {
    if (kind !== "copier" && want[kind] < CROSS_BELOW) {
      // Scarce: one drifts through now and then, at a rate that keeps the same average count.
      const crossTime = (2 * shape.aspect) / CROSS_SPEED;
      let rate = want[kind] / crossTime;
      if (kind === "block" && c.blocks > 0) {
        rate = Math.max(rate, 1 / CROSS_EVERY);
      }
      if (passing[kind] < Math.max(1, Math.round(want[kind])) && nextRandom(rng) < rate * dt) {
        spawnCrossing(lens, shape, kind, kind === "chain" ? sampleLength(rng, c.chains) : 1);
      }
      return;
    }
    const life = LIFETIME * (kind === "copier" ? 2 : 1);
    let expected = (want[kind] / life) * dt * (have[kind] < want[kind] ? 2 : 0.5);
    if (have[kind] === 0 && want[kind] >= 1) {
      expected = Math.max(expected, 0.3);
    }
    while (expected > 0) {
      if (nextRandom(rng) < Math.min(1, expected)) {
        const len = kind === "block" || kind === "lipid" ? 1 : kind === "copier" ? COPIER_LEN : sampleLength(rng, c.chains);
        spawn(lens, shape, kind, len, s.enclosed);
      }
      expected -= 1;
    }
  });
  const settled = (v: LensVesicle): boolean => !v.fading && (v.life === Infinity || v.age < v.life - 1);
  if (lens.vesicles.filter(settled).length < vesicleWant && nextRandom(rng) < dt * 1.5) {
    const r = 0.2 + 0.08 * nextRandom(rng);
    lens.vesicles.push({
      x: (2 * nextRandom(rng) - 1) * (shape.aspect - r - MARGIN),
      y: (2 * nextRandom(rng) - 1) * (1 - r - MARGIN),
      r,
      base: r,
      split: -1,
      axis: 0,
      fading: false,
      vx: 0,
      vy: 0,
      age: 0,
      life: 14 + 10 * nextRandom(rng)
    });
  }

  // Cells: vesicles with a self-copying chain inside, while the chemistry is alive.
  const cellCopier = new Map<number, LensMolecule>();
  lens.molecules.forEach((m) => {
    if (m.kind === "copier" && m.home >= 0 && m.side >= 0 && !cellCopier.has(m.home)) {
      cellCopier.set(m.home, m);
    }
  });
  lens.vesicles.forEach((v, i) => {
    const cell = alive && cellCopier.has(i) && !v.fading;
    if (cell) {
      v.life = Infinity;
    } else if (v.life === Infinity) {
      // No longer alive (or the chain is gone): back to an ordinary vesicle's lifespan.
      v.life = v.age + 4 + 4 * nextRandom(rng);
      v.split = -1;
    }
  });
  const fadeOne = (avoid: number): void => {
    // Make room: an empty vesicle goes first, oldest first; failing that, the oldest other cell.
    const candidates = lens.vesicles
      .map((v, i) => ({ v, i }))
      .filter(({ v, i }) => i !== avoid && v.split < 0 && settled(v))
      .sort((a, b) => Number(cellCopier.has(a.i)) - Number(cellCopier.has(b.i)) || b.v.age - a.v.age);
    if (candidates.length > 0) {
      const { v, i } = candidates[0];
      v.fading = true;
      v.split = -1;
      v.life = v.age + 1.2;
      lens.molecules.forEach((m) => {
        if (m.home === i) {
          m.life = Math.min(m.life, m.age + 1.2);
        }
      });
    }
  };
  // Too many vesicles for the lipids around: the extras fade, empty and old ones first.
  let extra = lens.vesicles.filter(settled).length - Math.max(vesicleWant, alive ? 1 : 0);
  while (extra > 0) {
    fadeOne(-1);
    extra -= 1;
  }

  // Excess molecules fade out early (e.g. after a flood).
  const counts: Record<MoleculeKind, number> = { block: 0, chain: 0, copier: 0, lipid: 0 };
  lens.molecules.forEach((m) => {
    counts[m.kind] += 1;
    // A passing molecule finishes its crossing; a cell's own chain lives as long as the cell.
    const inCell = alive && m.kind === "copier" && m.home >= 0;
    if (!m.crossing && !inCell && counts[m.kind] > want[m.kind] + 1.5 && m.age < m.life - 0.6) {
      m.life = m.age + 0.6;
    }
  });
  const finished: number[] = [];
  lens.vesicles.forEach((v, i) => {
    v.age += dt;
    if (v.split >= 0) {
      v.split = Math.min(1, v.split + (dt * cellPace) / DIVIDE_TIME);
      if (v.split >= 1) {
        finished.push(i);
      }
    } else if (alive && cellCopier.has(i) && !v.fading) {
      // A cell swells as its chain copies itself (taking in lipids from around it).
      const target = v.base * (1 + CELL_GROWTH * Math.max(0, cellCopier.get(i)?.copy ?? 0));
      v.r += (target - v.r) * Math.min(1, dt * 1.5);
    } else {
      v.r += (v.base - v.r) * Math.min(1, dt);
    }
    v.vx = v.vx * 0.96 + gaussian(rng) * 0.05 * dt;
    v.vy = v.vy * 0.96 + gaussian(rng) * 0.05 * dt;
    v.x += v.vx * dt;
    v.y += v.vy * dt;
    keepInside(v, shape.aspect, v.r + MARGIN * 0.5);
  });
  // Division done: the vesicle becomes one daughter and a new one the other, each with one chain.
  finished.forEach((i) => {
    const v = lens.vesicles[i];
    const { r, d } = vesicleHalves(v);
    const ax = Math.cos(v.axis);
    const ay = Math.sin(v.axis);
    const j = lens.vesicles.length;
    lens.vesicles.push({
      x: v.x + ax * d,
      y: v.y + ay * d,
      r,
      base: v.base * (0.92 + 0.16 * nextRandom(rng)),
      split: -1,
      axis: 0,
      fading: false,
      vx: v.vx + ax * 0.06,
      vy: v.vy + ay * 0.06,
      age: 0,
      life: Infinity
    });
    v.x -= ax * d;
    v.y -= ay * d;
    v.vx -= ax * 0.06;
    v.vy -= ay * 0.06;
    v.r = r;
    v.split = -1;
    lens.molecules.forEach((m) => {
      if (m.home === i && m.side > 0) {
        m.home = j;
      }
      if (m.home === i || m.home === j) {
        m.side = 0;
      }
    });
  });
  // Vesicles push each other apart instead of overlapping (a dividing one takes up both halves).
  const reach = (v: LensVesicle): number => {
    const h = vesicleHalves(v);
    return h.d + h.r;
  };
  lens.vesicles.forEach((a, i) => {
    lens.vesicles.slice(i + 1).forEach((b) => {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 1e-6;
      const overlap = 1.08 * (reach(a) + reach(b)) - d;
      if (overlap > 0) {
        const push = Math.min(overlap, 0.6 * dt) / 2;
        a.x -= (dx / d) * push;
        a.y -= (dy / d) * push;
        b.x += (dx / d) * push;
        b.y += (dy / d) * push;
      }
    });
  });

  // The copy is complete: it peels off as a second chain, and the cell starts to pinch in two.
  const newborn: LensMolecule[] = [];
  const divide = (m: LensMolecule, home: number): void => {
    const v = lens.vesicles[home];
    const room = lens.vesicles.filter(settled).length;
    if (room >= Math.max(vesicleWant, 2)) {
      fadeOne(home);
    }
    v.split = 0;
    v.axis = nextRandom(rng) * Math.PI;
    m.side = -1;
    // Start the daughters slightly out of step, so the cells don't all divide together.
    m.copy = -0.25 * nextRandom(rng);
    newborn.push({
      ...m,
      // The copy is the complementary strand (each letter pairs with its partner).
      seq: m.seq.map((b) => 3 - b),
      bends: m.bends.map((b) => -b),
      angle: m.angle + Math.PI,
      age: 0.6,
      side: 1,
      copy: -0.25 * nextRandom(rng)
    });
  };
  lens.molecules.forEach((m) => {
    m.age += dt;
    if (m.crossing) {
      // Steady drift with a slight wander; it leaves once past the far edge.
      m.vx += gaussian(rng) * 0.02 * dt;
      m.vy += gaussian(rng) * 0.02 * dt;
      m.x += m.vx * dt;
      m.y += m.vy * dt;
      m.angle += m.spin * dt;
      if (Math.abs(m.x) > shape.aspect + 0.3 || Math.abs(m.y) > 1.3) {
        m.life = 0;
      }
      return;
    }
    const home = m.home >= 0 ? lens.vesicles[m.home] : undefined;
    if (m.home >= 0 && !home) {
      m.home = -1;
    }
    const jiggle = m.kind === "block" || m.kind === "lipid" ? 0.3 : m.kind === "chain" ? 0.14 : 0.08;
    m.vx = m.vx * 0.94 + gaussian(rng) * jiggle * dt * 4;
    m.vy = m.vy * 0.94 + gaussian(rng) * jiggle * dt * 4;
    m.x += m.vx * dt;
    m.y += m.vy * dt;
    m.angle += m.spin * dt;
    if (home) {
      // Stay inside the vesicle (or its half, while it divides), drifting with it.
      const half = vesicleHalves(home);
      const cx = home.x + m.side * half.d * Math.cos(home.axis);
      const cy = home.y + m.side * half.d * Math.sin(home.axis);
      const dx = m.x - cx;
      const dy = m.y - cy;
      const d = Math.hypot(dx, dy);
      const room = half.r * 0.08;
      if (d > room) {
        m.x = cx + (dx / d) * room;
        m.y = cy + (dy / d) * room;
      }
    } else {
      keepInside(m, shape.aspect, MARGIN);
    }
    if (m.kind === "copier" && alive && home && !home.fading) {
      m.life = Infinity;
      if (home.split < 0) {
        m.copy += (dt * cellPace) / CELL_COPY_TIME;
      }
      if (m.copy >= 1 && home.split < 0) {
        divide(m, m.home);
      }
    } else if (m.kind === "copier") {
      if (m.life === Infinity) {
        m.life = m.age + LIFETIME;
      }
      m.copy += dt * rate * 0.5;
      if (m.copy >= 1) {
        m.copy = 0;
        m.seq = m.seq.map(() => Math.floor(nextRandom(rng) * 4));
      }
    }
  });
  lens.molecules.push(...newborn.splice(0));

  lens.molecules = lens.molecules.filter((m) => m.age < m.life);
  const keep = lens.vesicles.map((v) => v.age < v.life);
  if (keep.some((kept) => !kept)) {
    const remap = new Map<number, number>();
    let j = 0;
    keep.forEach((kept, i) => {
      if (kept) {
        remap.set(i, j);
        j += 1;
      }
    });
    lens.vesicles = lens.vesicles.filter((_, i) => keep[i]);
    lens.molecules.forEach((m) => {
      m.home = m.home >= 0 ? remap.get(m.home) ?? -1 : -1;
    });
  }
}

/** 0 → 1 → 0 over a molecule's life. */
export function fade(age: number, life: number): number {
  return Math.min(1, age / 0.6, (life - age) / 0.6);
}
