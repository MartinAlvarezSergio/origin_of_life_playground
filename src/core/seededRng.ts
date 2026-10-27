/**
 * Seeded RNG with its state in a plain object, so a whole simulation state can be
 * cloned for checkpoints and replayed exactly (scrubbing and video export need that).
 */
export type Rng = { s: number };

export function createRng(seed: number): Rng {
  return { s: seed >>> 0 };
}

/** mulberry32, uniform in [0, 1). */
export function nextRandom(r: Rng): number {
  r.s = (r.s + 0x6d2b79f5) >>> 0;
  let t = r.s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function gaussian(r: Rng): number {
  const u1 = 1 - nextRandom(r);
  const u2 = nextRandom(r);
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Poisson-distributed count with the given mean (Knuth; the means here are small). */
export function poisson(r: Rng, mean: number): number {
  if (mean <= 0) {
    return 0;
  }
  if (mean > 30) {
    return Math.max(0, Math.round(mean + Math.sqrt(mean) * gaussian(r)));
  }
  const limit = Math.exp(-mean);
  let k = 0;
  let p = nextRandom(r);
  while (p > limit) {
    k += 1;
    p *= nextRandom(r);
  }
  return k;
}
