/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import * as THREE from 'three';

/**
 * t3ssel8r Second-Order Spring Dynamics (scalar).
 * Parameterized by intuitive physical constants:
 * - f: natural frequency in Hz
 * - z: damping ratio (z < 1 underdamped bounce, z = 1 critical, z > 1 overdamped)
 * - r: initial velocity response (r > 1 anticipates, r = 0 smooth, r < 0 undershoots)
 */
export class SecondOrderSpring {
  private xp = 0;
  private y = 0;
  private yd = 0;

  private k1 = 0;
  private k2 = 0;
  private k3 = 0;

  constructor(f = 3.0, z = 0.75, r = 0.5, initialValue = 0) {
    this.tune(f, z, r);
    this.reset(initialValue);
  }

  tune(f: number, z: number, r: number): void {
    const safeF = Math.max(0.05, f);
    const piF = Math.PI * safeF;
    this.k1 = z / piF;
    this.k2 = 1 / (4 * piF * piF);
    this.k3 = (r * z) / (2 * piF);
  }

  reset(value: number): void {
    this.xp = value;
    this.y = value;
    this.yd = 0;
  }

  get value(): number {
    return this.y;
  }

  get velocity(): number {
    return this.yd;
  }

  impulse(velDelta: number): void {
    this.yd += velDelta;
  }

  update(dt: number, target: number, targetVel?: number): number {
    const safeDt = Math.max(1e-5, dt);
    const xd = targetVel !== undefined ? targetVel : (target - this.xp) / safeDt;
    this.xp = target;

    // Stability-clamped k2 prevents high-frequency blowup
    const k2Stable = Math.max(
      this.k2,
      (safeDt * safeDt) * 0.5 + safeDt * this.k1 * 0.5,
      safeDt * this.k1,
    );

    this.y = this.y + safeDt * this.yd;
    this.yd =
      this.yd +
      (safeDt * (target + this.k3 * xd - this.y - this.k1 * this.yd)) / k2Stable;
    return this.y;
  }
}

/**
 * Zero-allocation 3D vector variant of t3ssel8r Second-Order Spring Dynamics.
 */
export class SecondOrderSpring3 {
  public readonly value = new THREE.Vector3();
  public readonly velocity = new THREE.Vector3();
  private readonly xp = new THREE.Vector3();
  private readonly xd = new THREE.Vector3();

  private k1 = 0;
  private k2 = 0;
  private k3 = 0;

  constructor(f = 3.5, z = 0.8, r = 0.3, initial?: THREE.Vector3) {
    this.tune(f, z, r);
    if (initial) {
      this.reset(initial);
    }
  }

  tune(f: number, z: number, r: number): void {
    const safeF = Math.max(0.05, f);
    const piF = Math.PI * safeF;
    this.k1 = z / piF;
    this.k2 = 1 / (4 * piF * piF);
    this.k3 = (r * z) / (2 * piF);
  }

  reset(v: THREE.Vector3): void {
    this.xp.copy(v);
    this.value.copy(v);
    this.velocity.set(0, 0, 0);
  }

  update(dt: number, target: THREE.Vector3): THREE.Vector3 {
    const safeDt = Math.max(1e-5, dt);
    this.xd.subVectors(target, this.xp).divideScalar(safeDt);
    this.xp.copy(target);

    const k2Stable = Math.max(
      this.k2,
      (safeDt * safeDt) * 0.5 + safeDt * this.k1 * 0.5,
      safeDt * this.k1,
    );

    this.value.addScaledVector(this.velocity, safeDt);

    const invK2 = safeDt / k2Stable;
    this.velocity.x +=
      (target.x + this.k3 * this.xd.x - this.value.x - this.k1 * this.velocity.x) * invK2;
    this.velocity.y +=
      (target.y + this.k3 * this.xd.y - this.value.y - this.k1 * this.velocity.y) * invK2;
    this.velocity.z +=
      (target.z + this.k3 * this.xd.z - this.value.z - this.k1 * this.velocity.z) * invK2;

    return this.value;
  }
}

/** Freya Holmér framerate-independent exponential scalar damping */
export function dampScalar(current: number, target: number, lambda: number, dt: number): number {
  return THREE.MathUtils.lerp(current, target, 1 - Math.exp(-lambda * dt));
}

/** Freya Holmér framerate-independent exponential Vector3 damping */
export function dampVec3(
  current: THREE.Vector3,
  target: THREE.Vector3,
  lambda: number,
  dt: number,
): THREE.Vector3 {
  const factor = 1 - Math.exp(-lambda * dt);
  return current.lerp(target, factor);
}

/** Freya Holmér framerate-independent exponential Quaternion slerp */
export function dampQuat(
  current: THREE.Quaternion,
  target: THREE.Quaternion,
  lambda: number,
  dt: number,
): THREE.Quaternion {
  const factor = 1 - Math.exp(-lambda * dt);
  return current.slerp(target, factor);
}

/**
 * Squirrel Eiserloh Trauma-squared camera shake accumulator.
 */
export class TraumaShake {
  private trauma = 0;
  private time = 0;
  public readonly offset = new THREE.Vector3();
  public rollRad = 0;

  constructor(
    private readonly decayRate = 1.65,
    private readonly maxOffset = 0.42,
    private readonly maxRollRad = 0.035,
  ) {}

  add(amount: number): void {
    this.trauma = Math.min(1, Math.max(0, this.trauma + amount));
  }

  get level(): number {
    return this.trauma;
  }

  update(dt: number): void {
    this.time += dt * 38.0;
    this.trauma = Math.max(0, this.trauma - this.decayRate * dt);
    const shake = this.trauma * this.trauma;
    if (shake <= 1e-4) {
      this.offset.set(0, 0, 0);
      this.rollRad = 0;
      return;
    }
    const sx = Math.sin(this.time * 1.13) * Math.cos(this.time * 0.67);
    const sy = Math.cos(this.time * 1.41) * Math.sin(this.time * 0.89);
    const sz = Math.sin(this.time * 0.97 + 1.4);
    const sr = Math.sin(this.time * 1.73 + 0.5);

    this.offset.set(
      sx * this.maxOffset * shake,
      sy * this.maxOffset * shake,
      sz * this.maxOffset * 0.35 * shake,
    );
    this.rollRad = sr * this.maxRollRad * shake;
  }
}

/**
 * Pre-allocated math scratch pool to eliminate per-frame heap allocations in the 60Hz loop.
 */
export const VectorPool = {
  v0: new THREE.Vector3(),
  v1: new THREE.Vector3(),
  v2: new THREE.Vector3(),
  v3: new THREE.Vector3(),
  v4: new THREE.Vector3(),
  q0: new THREE.Quaternion(),
  q1: new THREE.Quaternion(),
  m0: new THREE.Matrix4(),
  m1: new THREE.Matrix4(),
  n0: new THREE.Matrix3(),
  c0: new THREE.Color(),
} as const;
