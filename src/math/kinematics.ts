/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import * as THREE from 'three';
import { SPATIAL_CONSTANTS } from '../types/game';

const _ikDir = new THREE.Vector3();
const _ikBend = new THREE.Vector3();
const _basisX = new THREE.Vector3();
const _basisY = new THREE.Vector3();
const _basisZ = new THREE.Vector3();

/**
 * Affine conversion from logical 1280px DOM coordinates (origin top-left, +Y down)
 * to upright 3D Three.js world space (centered around X=0, +Y up).
 */
export function domRectToWorld(
  xPx: number,
  yPx: number,
  widthPx: number,
  heightPx: number,
  bandZ: number,
  out = new THREE.Vector3(),
): THREE.Vector3 {
  const s = SPATIAL_CONSTANTS.WORLD_SCALE;
  const centerX = xPx + widthPx * 0.5 - SPATIAL_CONSTANTS.DOM_VIEWPORT_WIDTH_PX * 0.5;
  const centerY = -(yPx + heightPx * 0.5);
  return out.set(centerX * s, centerY * s, bandZ);
}

/**
 * Analytical 2-Bone Pole-Vector Inverse Kinematics solver (Law of Cosines).
 * Resolves exact shoulder-elbow-hand or hip-knee-ankle positions with orthogonal pole orientation,
 * completely preventing backward joint popping.
 */
export function solveTwoBoneIK(
  rootPos: THREE.Vector3,
  targetPos: THREE.Vector3,
  poleWorld: THREE.Vector3,
  lenA: number,
  lenB: number,
  outMidPos: THREE.Vector3,
  outEndPos: THREE.Vector3,
): void {
  _ikDir.subVectors(targetPos, rootPos);
  const rawDist = _ikDir.length();
  const minDist = Math.abs(lenA - lenB) + 0.002;
  const maxDist = Math.max(minDist + 0.001, lenA + lenB - 0.002);
  const clampedDist = THREE.MathUtils.clamp(rawDist, minDist, maxDist);

  if (rawDist > 1e-6) {
    _ikDir.multiplyScalar(1 / rawDist);
  } else {
    _ikDir.set(0, -1, 0);
  }

  outEndPos.copy(rootPos).addScaledVector(_ikDir, clampedDist);

  // Project pole hint orthogonal to root->target bone axis
  _ikBend.subVectors(poleWorld, rootPos);
  const proj = _ikBend.dot(_ikDir);
  _ikBend.addScaledVector(_ikDir, -proj);

  if (_ikBend.lengthSq() < 1e-6) {
    // Fallback perpendicular axis in +Z if collinear
    _ikBend.set(0, 0, 1);
    const p2 = _ikBend.dot(_ikDir);
    _ikBend.addScaledVector(_ikDir, -p2);
  }
  _ikBend.normalize();

  // Law of Cosines: distance along root->end axis and perpendicular offset
  const cosAngleA = THREE.MathUtils.clamp(
    (lenA * lenA + clampedDist * clampedDist - lenB * lenB) / (2 * lenA * clampedDist),
    -1,
    1,
  );
  const along = lenA * cosAngleA;
  const perp = Math.sqrt(Math.max(0, lenA * lenA - along * along));

  outMidPos
    .copy(rootPos)
    .addScaledVector(_ikDir, along)
    .addScaledVector(_ikBend, perp);
}

/**
 * Jakobsen Verlet chain solver for headband scarf ribbons and grapple tethers.
 */
export function solveVerletChain(
  positions: THREE.Vector3[],
  prevPositions: THREE.Vector3[],
  restLength: number,
  accel: THREE.Vector3,
  dt: number,
  damping = 0.96,
  iterations = 3,
  anchorPos?: THREE.Vector3,
  chestCenter?: THREE.Vector3,
  chestRadius = 0.22,
): void {
  const count = positions.length;
  if (count === 0) return;

  const dtSq = dt * dt;
  for (let i = 0; i < count; i++) {
    if (anchorPos && i === 0) {
      positions[0].copy(anchorPos);
      prevPositions[0].copy(anchorPos);
      continue;
    }
    const cur = positions[i];
    const prev = prevPositions[i];
    const vx = (cur.x - prev.x) * damping;
    const vy = (cur.y - prev.y) * damping;
    const vz = (cur.z - prev.z) * damping;

    prev.copy(cur);
    cur.x += vx + accel.x * dtSq;
    cur.y += vy + accel.y * dtSq;
    cur.z += vz + accel.z * dtSq;
  }

  const chestRadiusSq = chestRadius * chestRadius;

  for (let iter = 0; iter < iterations; iter++) {
    if (anchorPos) {
      positions[0].copy(anchorPos);
    }

    for (let i = 0; i < count - 1; i++) {
      const a = positions[i];
      const b = positions[i + 1];
      _ikDir.subVectors(b, a);
      const dist = _ikDir.length();
      if (dist < 1e-6) continue;
      const diff = (dist - restLength) / dist;

      if (anchorPos && i === 0) {
        b.addScaledVector(_ikDir, -diff);
      } else {
        a.addScaledVector(_ikDir, diff * 0.5);
        b.addScaledVector(_ikDir, -diff * 0.5);
      }
    }

    if (chestCenter) {
      for (let i = 1; i < count; i++) {
        const p = positions[i];
        _ikBend.subVectors(p, chestCenter);
        const dSq = _ikBend.lengthSq();
        if (dSq < chestRadiusSq && dSq > 1e-8) {
          _ikBend.normalize().multiplyScalar(chestRadius);
          p.copy(chestCenter).add(_ikBend);
        }
      }
    }
  }
}

/**
 * Computes Volume-Preserving Squash & Stretch (Sx = Sz = Sy^(-w/2)).
 */
export function computeVolumePreservingScale(
  scaleY: number,
  preserveWeight = 0.85,
  out = new THREE.Vector3(),
): THREE.Vector3 {
  const safeY = Math.max(0.45, Math.min(2.0, scaleY));
  const radial = Math.pow(safeY, -preserveWeight * 0.5);
  return out.set(radial, safeY, radial);
}

/**
 * Computes exact 3x3 Normal Matrix (M_{3x3}^{-1})^T for non-uniformly squashed/stretched meshes.
 */
export function computeNormalMatrix3(
  modelMatrix: THREE.Matrix4,
  out = new THREE.Matrix3(),
): THREE.Matrix3 {
  return out.getNormalMatrix(modelMatrix);
}

/**
 * Constructs an orthonormal basis Matrix4 at `position` aligned with `forward` and `upHint`.
 */
export function composeSocketBasis(
  forward: THREE.Vector3,
  upHint: THREE.Vector3,
  position: THREE.Vector3,
  out = new THREE.Matrix4(),
): THREE.Matrix4 {
  _basisZ.copy(forward).normalize();
  _basisX.crossVectors(upHint, _basisZ);
  if (_basisX.lengthSq() < 1e-6) {
    _basisX.set(1, 0, 0);
  } else {
    _basisX.normalize();
  }
  _basisY.crossVectors(_basisZ, _basisX).normalize();
  out.makeBasis(_basisX, _basisY, _basisZ);
  out.setPosition(position);
  return out;
}

/**
 * Quadratic + 4-step Newton-Raphson ballistic lead velocity solver.
 * Used by Typography, Media, and Form projectiles to intercept moving targets cleanly.
 */
export function solveBallisticVelocity(
  origin: THREE.Vector3,
  targetPos: THREE.Vector3,
  targetVel: THREE.Vector3,
  projectileSpeed: number,
  gravityY: number,
  outVel = new THREE.Vector3(),
): boolean {
  const speed = Math.max(1.0, projectileSpeed);
  const dx0 = targetPos.x - origin.x;
  const dy0 = targetPos.y - origin.y;
  const dz0 = targetPos.z - origin.z;
  const dist0 = Math.sqrt(dx0 * dx0 + dy0 * dy0 + dz0 * dz0);

  let t = dist0 / speed;
  // 4-step Newton-Raphson refinement accounting for target velocity and gravity arc
  for (let i = 0; i < 4; i++) {
    const px = dx0 + targetVel.x * t;
    const py = dy0 + targetVel.y * t - 0.5 * gravityY * t * t;
    const pz = dz0 + targetVel.z * t;

    const reqDist = Math.sqrt(px * px + py * py + pz * pz);
    const f = reqDist - speed * t;

    const vxTerm = targetVel.x;
    const vyTerm = targetVel.y - gravityY * t;
    const vzTerm = targetVel.z;
    const dReqDt =
      reqDist > 1e-4 ? (px * vxTerm + py * vyTerm + pz * vzTerm) / reqDist : 0;
    const df = dReqDt - speed;

    if (Math.abs(df) < 1e-4) break;
    t = Math.max(0.05, Math.min(4.0, t - f / df));
  }

  const invT = 1 / Math.max(0.05, t);
  outVel.set(
    (dx0 + targetVel.x * t) * invT,
    (dy0 + targetVel.y * t - 0.5 * gravityY * t * t) * invT,
    (dz0 + targetVel.z * t) * invT,
  );
  return Number.isFinite(outVel.x) && Number.isFinite(outVel.y) && Number.isFinite(outVel.z);
}
