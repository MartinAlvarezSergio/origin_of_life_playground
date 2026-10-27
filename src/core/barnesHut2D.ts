/**
 * 2D Barnes-Hut quadtree for softened gravity (Plummer-style softening in distance).
 * Multipole: monopole + primitive quadrupole Q_ij = sum m (3 x_i x_j - r^2 δ_ij) aggregated with parallel-axis theorem.
 *
 * Acceleration/potential walkers omit G; multiply by G_KPC_MSUN (or your G) at the call site.
 */

export const LEAF_CAPACITY = 8;
export const MIN_EXTENT = 1e-12;
/** Default opening angle: theta = 0.7 => theta^2 = 0.49 */
export const DEFAULT_THETA2 = 0.49;
/** Used for multipole potential (diagnostics). */
export const USE_QUADRUPOLE = true;
/** Quadrupole term in BH acceleration (disabled: use monopole-only for forces). */
export const USE_QUADRUPOLE_ACCEL = false;

export type Tree2D = {
  nNodes: number;
  /** Child subtree roots (-1 if empty quadrant). Internal nodes only. */
  ch0: Int32Array;
  ch1: Int32Array;
  ch2: Int32Array;
  ch3: Int32Array;
  count: Int32Array;
  M: Float64Array;
  comX: Float64Array;
  comY: Float64Array;
  size: Float64Array;
  Qxx: Float64Array;
  Qyy: Float64Array;
  Qxy: Float64Array;
  leafFirst: Int32Array;
  leafCount: Int32Array;
  perm: Int32Array;
};

type BuildBuffers = {
  perm: Int32Array;
  work: Int32Array;
  work2: Int32Array;
  ch0: Int32Array;
  ch1: Int32Array;
  ch2: Int32Array;
  ch3: Int32Array;
  count: Int32Array;
  M: Float64Array;
  comX: Float64Array;
  comY: Float64Array;
  size: Float64Array;
  Qxx: Float64Array;
  Qyy: Float64Array;
  Qxy: Float64Array;
  leafFirst: Int32Array;
  leafCount: Int32Array;
  nodeCap: number;
};

const buildPools: [BuildBuffers | null, BuildBuffers | null] = [null, null];

function ensureBuildBuffers(poolId: 0 | 1, minNodes: number, minPerm: number): BuildBuffers {
  let b = buildPools[poolId];
  const nodeCap = Math.max(64, minNodes);
  const permLen = Math.max(minPerm, 16);
  if (!b || b.nodeCap < nodeCap || b.perm.length < permLen) {
    b = {
      perm: new Int32Array(permLen),
      work: new Int32Array(permLen),
      work2: new Int32Array(permLen),
      ch0: new Int32Array(nodeCap),
      ch1: new Int32Array(nodeCap),
      ch2: new Int32Array(nodeCap),
      ch3: new Int32Array(nodeCap),
      count: new Int32Array(nodeCap),
      M: new Float64Array(nodeCap),
      comX: new Float64Array(nodeCap),
      comY: new Float64Array(nodeCap),
      size: new Float64Array(nodeCap),
      Qxx: new Float64Array(nodeCap),
      Qyy: new Float64Array(nodeCap),
      Qxy: new Float64Array(nodeCap),
      leafFirst: new Int32Array(nodeCap),
      leafCount: new Int32Array(nodeCap),
      nodeCap
    };
    buildPools[poolId] = b;
  }
  return b;
}

function growNodesIfNeeded(b: BuildBuffers, need: number): void {
  if (need <= b.nodeCap) return;
  let cap = b.nodeCap;
  while (cap < need) cap *= 2;
  const grow = <T extends Float64Array | Int32Array>(a: T, n: number): T => {
    const next = new (a.constructor as new (n: number) => T)(n);
    next.set(a.subarray(0, a.length));
    return next;
  };
  b.ch0 = grow(b.ch0, cap);
  b.ch1 = grow(b.ch1, cap);
  b.ch2 = grow(b.ch2, cap);
  b.ch3 = grow(b.ch3, cap);
  b.count = grow(b.count, cap);
  b.M = grow(b.M, cap);
  b.comX = grow(b.comX, cap);
  b.comY = grow(b.comY, cap);
  b.size = grow(b.size, cap);
  b.Qxx = grow(b.Qxx, cap);
  b.Qyy = grow(b.Qyy, cap);
  b.Qxy = grow(b.Qxy, cap);
  b.leafFirst = grow(b.leafFirst, cap);
  b.leafCount = grow(b.leafCount, cap);
  b.nodeCap = cap;
}

/** Q_ij = sum m (3 x_i x_j - r^2 δ_ij) about COM. */
function leafQuadrupoleAboutCom(
  x: Float64Array,
  y: Float64Array,
  m: Float64Array,
  perm: Int32Array,
  off: number,
  n: number,
  comx: number,
  comy: number,
  out: { qxx: number; qyy: number; qxy: number }
): void {
  let qxx = 0;
  let qyy = 0;
  let qxy = 0;
  for (let t = 0; t < n; t += 1) {
    const i = perm[off + t];
    const dx = x[i] - comx;
    const dy = y[i] - comy;
    const mi = m[i];
    const r2 = dx * dx + dy * dy;
    qxx += mi * (3 * dx * dx - r2);
    qyy += mi * (3 * dy * dy - r2);
    qxy += mi * 3 * dx * dy;
  }
  out.qxx = qxx;
  out.qyy = qyy;
  out.qxy = qxy;
}

function shiftQuadrupole(
  qxx: number,
  qyy: number,
  qxy: number,
  M: number,
  dx: number,
  dy: number
): { qxx: number; qyy: number; qxy: number } {
  const d2 = dx * dx + dy * dy;
  return {
    qxx: qxx + M * (3 * dx * dx - d2),
    qyy: qyy + M * (3 * dy * dy - d2),
    qxy: qxy + M * 3 * dx * dy
  };
}

type BuildCtx = {
  x: Float64Array;
  y: Float64Array;
  m: Float64Array;
  b: BuildBuffers;
  permBase: number;
  nextNode: number;
};

function quadrant(xi: number, yi: number, xMid: number, yMid: number): number {
  if (xi < xMid) {
    return yi < yMid ? 0 : 2;
  }
  return yi < yMid ? 1 : 3;
}

/** Reorder work[workOff..workOff+count) into SW, SE, NW, NE contiguous runs. Returns [n0,n1,n2,n3]. */
function partitionFour(
  x: Float64Array,
  y: Float64Array,
  work: Int32Array,
  work2: Int32Array,
  workOff: number,
  count: number,
  xMid: number,
  yMid: number
): [number, number, number, number] {
  const cnt = [0, 0, 0, 0];
  for (let t = 0; t < count; t += 1) {
    const i = work[workOff + t];
    const q = quadrant(x[i], y[i], xMid, yMid);
    cnt[q] += 1;
  }
  const off0 = workOff;
  const off1 = off0 + cnt[0];
  const off2 = off1 + cnt[1];
  const cur = [off0, off1, off2, off2 + cnt[2]];
  for (let t = 0; t < count; t += 1) {
    const i = work[workOff + t];
    const q = quadrant(x[i], y[i], xMid, yMid);
    const p = cur[q];
    cur[q] += 1;
    work2[p] = i;
  }
  for (let t = 0; t < count; t += 1) {
    work[workOff + t] = work2[off0 + t];
  }
  return [cnt[0], cnt[1], cnt[2], cnt[3]];
}

function buildRecursive(
  ctx: BuildCtx,
  workOff: number,
  count: number,
  xMin: number,
  xMax: number,
  yMin: number,
  yMax: number
): number {
  const { x, y, m, b } = ctx;
  if (count <= 0) {
    const id = ctx.nextNode;
    ctx.nextNode += 1;
    growNodesIfNeeded(b, ctx.nextNode);
    b.ch0[id] = -1;
    b.ch1[id] = -1;
    b.ch2[id] = -1;
    b.ch3[id] = -1;
    b.count[id] = 0;
    b.M[id] = 0;
    b.comX[id] = 0;
    b.comY[id] = 0;
    const sx = 0.5 * (xMax - xMin);
    const sy = 0.5 * (yMax - yMin);
    b.size[id] = Math.max(sx, sy, MIN_EXTENT);
    b.Qxx[id] = 0;
    b.Qyy[id] = 0;
    b.Qxy[id] = 0;
    b.leafFirst[id] = -1;
    b.leafCount[id] = 0;
    return id;
  }

  let mx = 0;
  let my = 0;
  let mm = 0;
  for (let t = 0; t < count; t += 1) {
    const i = b.work[workOff + t];
    const wi = m[i];
    mm += wi;
    mx += wi * x[i];
    my += wi * y[i];
  }
  const inv = mm > 0 ? 1 / mm : 0;
  const comx = mx * inv;
  const comy = my * inv;

  const extentX = Math.max(xMax - xMin, MIN_EXTENT);
  const extentY = Math.max(yMax - yMin, MIN_EXTENT);
  const half = 0.5 * Math.max(extentX, extentY);
  const cx = 0.5 * (xMin + xMax);
  const cy = 0.5 * (yMin + yMax);
  const boxMinX = cx - half;
  const boxMaxX = cx + half;
  const boxMinY = cy - half;
  const boxMaxY = cy + half;

  if (count <= LEAF_CAPACITY || half <= MIN_EXTENT * 2) {
    const id = ctx.nextNode;
    ctx.nextNode += 1;
    growNodesIfNeeded(b, ctx.nextNode);
    b.ch0[id] = -1;
    b.ch1[id] = -1;
    b.ch2[id] = -1;
    b.ch3[id] = -1;
    b.count[id] = count;
    b.M[id] = mm;
    b.comX[id] = comx;
    b.comY[id] = comy;
    b.size[id] = half;
    const lf = ctx.permBase;
    for (let t = 0; t < count; t += 1) {
      b.perm[lf + t] = b.work[workOff + t];
    }
    b.leafFirst[id] = lf;
    b.leafCount[id] = count;
    ctx.permBase += count;
    const q = { qxx: 0, qyy: 0, qxy: 0 };
    leafQuadrupoleAboutCom(x, y, m, b.perm, lf, count, comx, comy, q);
    b.Qxx[id] = q.qxx;
    b.Qyy[id] = q.qyy;
    b.Qxy[id] = q.qxy;
    return id;
  }

  const xMid = 0.5 * (boxMinX + boxMaxX);
  const yMid = 0.5 * (boxMinY + boxMaxY);
  const [n0, n1, n2, n3] = partitionFour(x, y, b.work, b.work2, workOff, count, xMid, yMid);
  const off0 = workOff;
  const off1 = off0 + n0;
  const off2 = off1 + n1;
  const off3 = off2 + n2;

  const id = ctx.nextNode;
  ctx.nextNode += 1;
  growNodesIfNeeded(b, ctx.nextNode + 2);
  b.leafFirst[id] = -1;
  b.leafCount[id] = 0;

  const c0 =
    n0 > 0 ? buildRecursive(ctx, off0, n0, boxMinX, xMid, boxMinY, yMid) : -1;
  const c1 =
    n1 > 0 ? buildRecursive(ctx, off1, n1, xMid, boxMaxX, boxMinY, yMid) : -1;
  const c2 =
    n2 > 0 ? buildRecursive(ctx, off2, n2, boxMinX, xMid, yMid, boxMaxY) : -1;
  const c3 =
    n3 > 0 ? buildRecursive(ctx, off3, n3, xMid, boxMaxX, yMid, boxMaxY) : -1;

  b.ch0[id] = c0;
  b.ch1[id] = c1;
  b.ch2[id] = c2;
  b.ch3[id] = c3;

  let Mtot = 0;
  let cxx = 0;
  let cyy = 0;
  const kids = [c0, c1, c2, c3];
  for (let k = 0; k < 4; k += 1) {
    const cid = kids[k];
    if (cid < 0) continue;
    Mtot += b.M[cid];
    cxx += b.M[cid] * b.comX[cid];
    cyy += b.M[cid] * b.comY[cid];
  }
  const invM = Mtot > 0 ? 1 / Mtot : 0;
  const pcx = cxx * invM;
  const pcy = cyy * invM;
  b.M[id] = Mtot;
  b.comX[id] = pcx;
  b.comY[id] = pcy;
  b.size[id] = half;
  b.count[id] = count;

  let Qxx = 0;
  let Qyy = 0;
  let Qxy = 0;
  for (let k = 0; k < 4; k += 1) {
    const cid = kids[k];
    if (cid < 0) continue;
    const Mc = b.M[cid];
    if (Mc <= 0) continue;
    const dx = b.comX[cid] - pcx;
    const dy = b.comY[cid] - pcy;
    const sh = shiftQuadrupole(b.Qxx[cid], b.Qyy[cid], b.Qxy[cid], Mc, dx, dy);
    Qxx += sh.qxx;
    Qyy += sh.qyy;
    Qxy += sh.qxy;
  }
  b.Qxx[id] = Qxx;
  b.Qyy[id] = Qyy;
  b.Qxy[id] = Qxy;

  return id;
}

function exportTree(b: BuildBuffers, nNodes: number, permLen: number): Tree2D {
  return {
    nNodes,
    ch0: b.ch0.subarray(0, nNodes),
    ch1: b.ch1.subarray(0, nNodes),
    ch2: b.ch2.subarray(0, nNodes),
    ch3: b.ch3.subarray(0, nNodes),
    count: b.count.subarray(0, nNodes),
    M: b.M.subarray(0, nNodes),
    comX: b.comX.subarray(0, nNodes),
    comY: b.comY.subarray(0, nNodes),
    size: b.size.subarray(0, nNodes),
    Qxx: b.Qxx.subarray(0, nNodes),
    Qyy: b.Qyy.subarray(0, nNodes),
    Qxy: b.Qxy.subarray(0, nNodes),
    leafFirst: b.leafFirst.subarray(0, nNodes),
    leafCount: b.leafCount.subarray(0, nNodes),
    perm: b.perm.subarray(0, permLen)
  };
}

/**
 * psi_quad = -(1/2) * T / R^5, T = 3 r_a Q_ab r_b with r = field - COM.
 * Acceleration (no G): monopole M*rel/R^3 plus -grad(psi_quad).
 */
function multipoleAccel(
  M: number,
  comX: number,
  comY: number,
  rx: number,
  ry: number,
  qxx: number,
  qyy: number,
  qxy: number,
  eps2: number
): { ax: number; ay: number } {
  const relx = comX - rx;
  const rely = comY - ry;
  const rxr = rx - comX;
  const ryr = ry - comY;
  const R2 = relx * relx + rely * rely + eps2;
  const R = Math.sqrt(R2);
  const invR = 1 / R;
  const invR2 = invR * invR;
  const invR3 = invR * invR2;

  let ax = M * relx * invR3;
  let ay = M * rely * invR3;

  if (!USE_QUADRUPOLE_ACCEL || M <= 0) {
    return { ax, ay };
  }

  const T = 3 * (rxr * rxr * qxx + 2 * rxr * ryr * qxy + ryr * ryr * qyy);
  const invR5 = invR2 * invR3;
  const invR7 = invR5 * invR2;

  const dTdrx = 6 * (rxr * qxx + ryr * qxy);
  const dTdry = 6 * (rxr * qxy + ryr * qyy);

  const dPsidr = -0.5 * (dTdrx * invR5 - 5 * T * rxr * invR7);
  const dPsidy = -0.5 * (dTdry * invR5 - 5 * T * ryr * invR7);

  ax -= dPsidr;
  ay -= dPsidy;

  return { ax, ay };
}

function multipolePotential(
  M: number,
  comX: number,
  comY: number,
  rx: number,
  ry: number,
  qxx: number,
  qyy: number,
  qxy: number,
  eps2: number
): number {
  const relx = comX - rx;
  const rely = comY - ry;
  const rxr = rx - comX;
  const ryr = ry - comY;
  const R2 = relx * relx + rely * rely + eps2;
  const R = Math.sqrt(R2);
  let phi = -M / R;
  if (!USE_QUADRUPOLE || M <= 0) {
    return phi;
  }
  const T = 3 * (rxr * rxr * qxx + 2 * rxr * ryr * qxy + ryr * ryr * qyy);
  phi -= 0.5 * T / (R2 * R2 * R);
  return phi;
}

const STACK_CAP = 16384;
const walkStack = new Int32Array(STACK_CAP);

function directLeafAccel(
  sx: Float64Array,
  sy: Float64Array,
  sm: Float64Array,
  perm: Int32Array,
  p0: number,
  pn: number,
  rx: number,
  ry: number,
  eps2: number,
  selfIdx: number,
  out: { ax: number; ay: number }
): void {
  for (let t = 0; t < pn; t += 1) {
    const j = perm[p0 + t];
    if (j === selfIdx) continue;
    const dx = sx[j] - rx;
    const dy = sy[j] - ry;
    const r2 = dx * dx + dy * dy + eps2;
    const invR = 1 / Math.sqrt(r2);
    const invR3 = invR * invR * invR;
    const mj = sm[j];
    out.ax += mj * dx * invR3;
    out.ay += mj * dy * invR3;
  }
}

function directLeafPotential(
  sx: Float64Array,
  sy: Float64Array,
  sm: Float64Array,
  perm: Int32Array,
  p0: number,
  pn: number,
  rx: number,
  ry: number,
  eps2: number,
  selfIdx: number
): number {
  let phi = 0;
  for (let t = 0; t < pn; t += 1) {
    const j = perm[p0 + t];
    if (j === selfIdx) continue;
    const dx = sx[j] - rx;
    const dy = sy[j] - ry;
    const r = Math.sqrt(dx * dx + dy * dy + eps2);
    phi -= sm[j] / r;
  }
  return phi;
}

function pushChildren(tree: Tree2D, node: number, sp: number): number {
  const c3 = tree.ch3[node];
  const c2 = tree.ch2[node];
  const c1 = tree.ch1[node];
  const c0 = tree.ch0[node];
  let s = sp;
  if (c3 >= 0) walkStack[s++] = c3;
  if (c2 >= 0) walkStack[s++] = c2;
  if (c1 >= 0) walkStack[s++] = c1;
  if (c0 >= 0) walkStack[s++] = c0;
  return s;
}

/**
 * @param poolId 0 or 1 — two pools so two trees (e.g. DM + stars) can coexist without clobbering buffers.
 */
export function buildTree2D(
  x: Float64Array,
  y: Float64Array,
  m: Float64Array,
  members: Int32Array,
  poolId: 0 | 1 = 0
): Tree2D {
  const nMembers = members.length;
  const estNodes = Math.max(16, 5 * nMembers + 64);
  const b = ensureBuildBuffers(poolId, estNodes, Math.max(nMembers * 2, 16));

  if (nMembers === 0) {
    b.ch0[0] = -1;
    b.ch1[0] = -1;
    b.ch2[0] = -1;
    b.ch3[0] = -1;
    b.count[0] = 0;
    b.M[0] = 0;
    b.comX[0] = 0;
    b.comY[0] = 0;
    b.size[0] = MIN_EXTENT;
    b.Qxx[0] = 0;
    b.Qyy[0] = 0;
    b.Qxy[0] = 0;
    b.leafFirst[0] = -1;
    b.leafCount[0] = 0;
    return exportTree(b, 1, 0);
  }

  let xMin = Number.POSITIVE_INFINITY;
  let xMax = Number.NEGATIVE_INFINITY;
  let yMin = Number.POSITIVE_INFINITY;
  let yMax = Number.NEGATIVE_INFINITY;
  for (let t = 0; t < nMembers; t += 1) {
    const i = members[t];
    const xi = x[i];
    const yi = y[i];
    if (xi < xMin) xMin = xi;
    if (xi > xMax) xMax = xi;
    if (yi < yMin) yMin = yi;
    if (yi > yMax) yMax = yi;
  }
  const pad = Math.max(1e-9 * Math.max(xMax - xMin, yMax - yMin, 1e-9), MIN_EXTENT);
  xMin -= pad;
  xMax += pad;
  yMin -= pad;
  yMax += pad;

  for (let t = 0; t < nMembers; t += 1) {
    b.work[t] = members[t];
  }

  const ctx: BuildCtx = {
    x,
    y,
    m,
    b,
    permBase: 0,
    nextNode: 0
  };
  buildRecursive(ctx, 0, nMembers, xMin, xMax, yMin, yMax);
  return exportTree(b, ctx.nextNode, ctx.permBase);
}

/**
 * Walks the tree and ACCUMULATES the contribution into out.ax/out.ay.
 * The caller is responsible for zeroing out before the first call;
 * subsequent calls (e.g. one per source tree for per-pair softening) sum on top.
 */
export function accumulateAccel2D(
  tree: Tree2D,
  sx: Float64Array,
  sy: Float64Array,
  sm: Float64Array,
  rx: number,
  ry: number,
  eps2: number,
  theta2: number,
  selfIdx: number,
  out: { ax: number; ay: number }
): void {
  if (tree.nNodes <= 0) return;

  let sp = 0;
  walkStack[sp++] = 0;

  while (sp > 0) {
    const node = walkStack[--sp];
    const M = tree.M[node];
    if (M <= 0 && tree.count[node] === 0) continue;

    const lf = tree.leafFirst[node];
    if (lf >= 0) {
      const ln = tree.leafCount[node];
      if (ln > 0) {
        directLeafAccel(sx, sy, sm, tree.perm, lf, ln, rx, ry, eps2, selfIdx, out);
      }
      continue;
    }

    const relx = tree.comX[node] - rx;
    const rely = tree.comY[node] - ry;
    const d2 = relx * relx + rely * rely + eps2;
    const s = 2 * tree.size[node];
    if (s * s < theta2 * d2) {
      const mq = multipoleAccel(
        M,
        tree.comX[node],
        tree.comY[node],
        rx,
        ry,
        tree.Qxx[node],
        tree.Qyy[node],
        tree.Qxy[node],
        eps2
      );
      out.ax += mq.ax;
      out.ay += mq.ay;
    } else {
      sp = pushChildren(tree, node, sp);
      if (sp > STACK_CAP) {
        throw new Error("barnesHut2D: walk stack overflow");
      }
    }
  }
}

export function accumulatePotential2D(
  tree: Tree2D,
  sx: Float64Array,
  sy: Float64Array,
  sm: Float64Array,
  rx: number,
  ry: number,
  eps2: number,
  theta2: number,
  selfIdx: number
): number {
  let phi = 0;
  if (tree.nNodes <= 0) return 0;

  let sp = 0;
  walkStack[sp++] = 0;

  while (sp > 0) {
    const node = walkStack[--sp];
    const M = tree.M[node];
    if (M <= 0 && tree.count[node] === 0) continue;

    const lf = tree.leafFirst[node];
    if (lf >= 0) {
      const ln = tree.leafCount[node];
      if (ln > 0) {
        phi += directLeafPotential(sx, sy, sm, tree.perm, lf, ln, rx, ry, eps2, selfIdx);
      }
      continue;
    }

    const relx = tree.comX[node] - rx;
    const rely = tree.comY[node] - ry;
    const d2 = relx * relx + rely * rely + eps2;
    const s = 2 * tree.size[node];
    if (s * s < theta2 * d2) {
      phi += multipolePotential(
        M,
        tree.comX[node],
        tree.comY[node],
        rx,
        ry,
        tree.Qxx[node],
        tree.Qyy[node],
        tree.Qxy[node],
        eps2
      );
    } else {
      sp = pushChildren(tree, node, sp);
      if (sp > STACK_CAP) {
        throw new Error("barnesHut2D: walk stack overflow");
      }
    }
  }
  return phi;
}

export function directAccel2D(
  sx: Float64Array,
  sy: Float64Array,
  sm: Float64Array,
  members: Int32Array,
  rx: number,
  ry: number,
  eps2: number,
  selfIdx: number,
  out: { ax: number; ay: number }
): void {
  out.ax = 0;
  out.ay = 0;
  for (let t = 0; t < members.length; t += 1) {
    const j = members[t];
    if (j === selfIdx) continue;
    const dx = sx[j] - rx;
    const dy = sy[j] - ry;
    const r2 = dx * dx + dy * dy + eps2;
    const invR = 1 / Math.sqrt(r2);
    const invR3 = invR * invR * invR;
    const mj = sm[j];
    out.ax += mj * dx * invR3;
    out.ay += mj * dy * invR3;
  }
}

export function directPotential2D(
  sx: Float64Array,
  sy: Float64Array,
  sm: Float64Array,
  members: Int32Array,
  rx: number,
  ry: number,
  eps2: number,
  selfIdx: number
): number {
  let phi = 0;
  for (let t = 0; t < members.length; t += 1) {
    const j = members[t];
    if (j === selfIdx) continue;
    const dx = sx[j] - rx;
    const dy = sy[j] - ry;
    const r = Math.sqrt(dx * dx + dy * dy + eps2);
    phi -= sm[j] / r;
  }
  return phi;
}
