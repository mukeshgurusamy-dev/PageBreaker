/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Deterministic 128-bit seed derivation from any URL or arbitrary label
 * using four salted FNV-1a passes.
 */
export function hashUrlSeed(input: string): [number, number, number, number] {
  const seeds: [number, number, number, number] = [
    0x811c9dc5,
    0x9e3779b9,
    0x85ebca6b,
    0xc2b2ae35,
  ];
  for (let pass = 0; pass < 4; pass++) {
    let h = seeds[pass] >>> 0;
    const salt = pass * 31 + 17;
    for (let i = 0; i < input.length; i++) {
      h ^= (input.charCodeAt(i) + salt) & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= h >>> 16;
    h = Math.imul(h, 0x7feb352d) >>> 0;
    h ^= h >>> 15;
    seeds[pass] = h >>> 0;
  }
  return seeds;
}

/**
 * SFC32 (Simple Fast Counter) 128-bit seeded PRNG.
 * Fast, period >= 2^128, zero Math.random() drift.
 */
export class SeededPRNG {
  private a: number;
  private b: number;
  private c: number;
  private d: number;
  private spareGaussian: number | null = null;

  constructor(seedSource: string | [number, number, number, number] = 'pagebreaker-default') {
    const [s0, s1, s2, s3] =
      typeof seedSource === 'string' ? hashUrlSeed(seedSource) : seedSource;
    this.a = s0 >>> 0;
    this.b = s1 >>> 0;
    this.c = s2 >>> 0;
    this.d = s3 >>> 0;
    // Warm up mixing state
    for (let i = 0; i < 12; i++) {
      this.next();
    }
  }

  /** Uniform float in [0, 1) */
  next(): number {
    this.a >>>= 0;
    this.b >>>= 0;
    this.c >>>= 0;
    this.d >>>= 0;
    let t = (this.a + this.b) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.d = (this.d + 1) | 0;
    t = (t + this.d) | 0;
    this.c = (this.c + t) | 0;
    return (t >>> 0) / 4294967296;
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  int(minInclusive: number, maxInclusive: number): number {
    return Math.floor(this.range(minInclusive, maxInclusive + 1));
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }

  /**
   * Box-Muller Gaussian distribution (zero-allocation cached spare value).
   */
  gaussian(mean = 0, stdDev = 1): number {
    if (this.spareGaussian !== null) {
      const val = this.spareGaussian;
      this.spareGaussian = null;
      return mean + stdDev * val;
    }
    let u = 0;
    let v = 0;
    while (u <= 1e-7) u = this.next();
    v = this.next();
    const mag = Math.sqrt(-2.0 * Math.log(u));
    const z0 = mag * Math.cos(2.0 * Math.PI * v);
    const z1 = mag * Math.sin(2.0 * Math.PI * v);
    this.spareGaussian = z1;
    return mean + stdDev * z0;
  }
}

const prdConstantCache = new Map<number, number>();

function expectedProbabilityForC(c: number): number {
  let pFailAccum = 1;
  let expectedTrials = 0;
  const maxN = Math.ceil(1 / c) + 1;
  for (let n = 1; n <= maxN; n++) {
    const pCur = Math.min(1, c * n);
    const pHitOnN = pFailAccum * pCur;
    expectedTrials += n * pHitOnN;
    pFailAccum *= 1 - pCur;
    if (pCur >= 1) break;
  }
  return 1 / expectedTrials;
}

/**
 * Solves Dota-style Pseudo-Random Distribution constant C for exact target mean probability p.
 */
export function solvePRDConstant(targetProbability: number): number {
  const clamped = Math.max(0.01, Math.min(0.99, targetProbability));
  const cacheKey = Math.round(clamped * 1000);
  const cached = prdConstantCache.get(cacheKey);
  if (cached !== undefined) return cached;

  let low = 0;
  let high = clamped;
  for (let i = 0; i < 32; i++) {
    const mid = (low + high) * 0.5;
    if (expectedProbabilityForC(mid) < clamped) {
      low = mid;
    } else {
      high = mid;
    }
  }
  const c = (low + high) * 0.5;
  prdConstantCache.set(cacheKey, c);
  return c;
}

/**
 * Dota Pseudo-Random Distribution tracker: P(N) = C * N.
 * Prevents frustrating dry spells and unfair back-to-back crit/grab streaks.
 */
export class PseudoRandomDistribution {
  private readonly c: number;
  private streak = 1;

  constructor(targetProbability: number) {
    this.c = solvePRDConstant(targetProbability);
  }

  roll(prng: SeededPRNG): boolean {
    const p = Math.min(1, this.c * this.streak);
    if (prng.next() < p) {
      this.streak = 1;
      return true;
    }
    this.streak += 1;
    return false;
  }

  reset(): void {
    this.streak = 1;
  }
}

/**
 * Samples the next discrete state from a Markov transition row (weights auto-normalized).
 */
export function sampleMarkovRow(row: readonly number[], prng: SeededPRNG): number {
  let sum = 0;
  for (let i = 0; i < row.length; i++) sum += Math.max(0, row[i]);
  if (sum <= 0) return 0;

  let threshold = prng.next() * sum;
  for (let i = 0; i < row.length; i++) {
    const w = Math.max(0, row[i]);
    threshold -= w;
    if (threshold <= 0) return i;
  }
  return row.length - 1;
}

export interface Point2D {
  x: number;
  y: number;
}

/**
 * O(N) Bridson Poisson-Disc sampling for evenly spaced Voronoi fracture seeds & decals.
 */
export function sampleBridsonPoisson2D(
  width: number,
  height: number,
  minDist: number,
  prng: SeededPRNG,
  maxSamples = 16,
  candidatesPerPoint = 24,
): Point2D[] {
  const safeDist = Math.max(1e-3, minDist);
  const cellSize = safeDist / Math.SQRT2;
  const cols = Math.max(1, Math.ceil(width / cellSize));
  const rows = Math.max(1, Math.ceil(height / cellSize));
  const grid = new Int32Array(cols * rows).fill(-1);

  const points: Point2D[] = [];
  const active: number[] = [];

  const first: Point2D = {
    x: prng.range(0, width),
    y: prng.range(0, height),
  };
  points.push(first);
  active.push(0);
  grid[Math.floor(first.y / cellSize) * cols + Math.floor(first.x / cellSize)] = 0;

  const minDistSq = safeDist * safeDist;

  while (active.length > 0 && points.length < maxSamples) {
    const activeIndex = prng.int(0, active.length - 1);
    const origin = points[active[activeIndex]];
    let placed = false;

    for (let k = 0; k < candidatesPerPoint; k++) {
      const angle = prng.range(0, Math.PI * 2);
      const radius = prng.range(safeDist, safeDist * 2);
      const cx = origin.x + Math.cos(angle) * radius;
      const cy = origin.y + Math.sin(angle) * radius;
      if (cx < 0 || cx >= width || cy < 0 || cy >= height) continue;

      const gx = Math.floor(cx / cellSize);
      const gy = Math.floor(cy / cellSize);
      let tooClose = false;

      const minNx = Math.max(0, gx - 2);
      const maxNx = Math.min(cols - 1, gx + 2);
      const minNy = Math.max(0, gy - 2);
      const maxNy = Math.min(rows - 1, gy + 2);

      for (let ny = minNy; ny <= maxNy && !tooClose; ny++) {
        for (let nx = minNx; nx <= maxNx; nx++) {
          const neighborIdx = grid[ny * cols + nx];
          if (neighborIdx !== -1) {
            const p = points[neighborIdx];
            const dx = p.x - cx;
            const dy = p.y - cy;
            if (dx * dx + dy * dy < minDistSq) {
              tooClose = true;
              break;
            }
          }
        }
      }

      if (!tooClose) {
        const idx = points.length;
        points.push({ x: cx, y: cy });
        active.push(idx);
        grid[gy * cols + gx] = idx;
        placed = true;
        break;
      }
    }

    if (!placed) {
      active[activeIndex] = active[active.length - 1];
      active.pop();
    }
  }

  return points;
}
