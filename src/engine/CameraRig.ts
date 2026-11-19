/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import * as THREE from 'three';
import type { CameraViewMode } from '../types/game';
import { TraumaShake, dampScalar, dampVec3 } from '../math/springs';

/**
 * Itay Keren "Scroll Back" 4-Mode 2.5D Camera Rig:
 * - Deadzone window preventing micro-step jitter
 * - Velocity + cursor lookahead
 * - Vertical platform elevation snapping (smoothly follows drops when falling)
 * - Side 2.5D (telephoto FOV 36 deg) vs. Angled 3D depth inspection toggle (V)
 * - Card Breach zoom hook (for Step 4 Band -1 chambers) + Eiserloh trauma^2 shake
 */
export class CameraRig {
  public readonly camera: THREE.PerspectiveCamera;
  public readonly trauma = new TraumaShake(1.75, 0.36, 0.028);

  private readonly anchor = new THREE.Vector3(0, 1.4, 0);
  private readonly currentPos = new THREE.Vector3(0, 2.2, 22.0);
  private readonly currentLook = new THREE.Vector3(0, 1.5, 0);
  private readonly goalPos = new THREE.Vector3();
  private readonly goalLook = new THREE.Vector3();

  private mode: CameraViewMode = 'side_25d';
  private lookaheadX = 0;
  private lookaheadY = 0;
  private breachZoomWeight = 0;
  private breachTargetZ = 0;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(36, Math.max(0.1, aspect), 0.5, 160);
    this.camera.position.copy(this.currentPos);
    this.camera.lookAt(this.currentLook);
  }

  setAspect(aspect: number): void {
    this.camera.aspect = Math.max(0.1, aspect);
    this.camera.updateProjectionMatrix();
  }

  setMode(mode: CameraViewMode): void {
    this.mode = mode;
  }

  getMode(): CameraViewMode {
    return this.mode;
  }

  setBreachFocus(active: boolean, targetZ = -1.05): void {
    this.breachZoomWeight = active ? 1 : 0;
    this.breachTargetZ = targetZ;
  }

  addTrauma(amount: number): void {
    this.trauma.add(amount);
  }

  getFocusTarget(out = new THREE.Vector3()): THREE.Vector3 {
    return out.copy(this.currentLook);
  }

  snapToTarget(x: number, y: number, z: number): void {
    this.anchor.set(x, y, z);
    this.lookaheadX = 0;
    this.lookaheadY = 0;
    const dist = this.mode === 'side_25d' ? 14.8 : 16.5;
    const sideOffset = this.mode === 'side_25d' ? 0 : 4.5;
    const snapFocusY = Math.min(-3.2, y + 0.4);
    this.currentPos.set(x + sideOffset, snapFocusY + 0.5, z + dist);
    this.currentLook.set(x, snapFocusY, z);
    this.camera.position.copy(this.currentPos);
    this.camera.lookAt(this.currentLook);
  }

  update(
    dt: number,
    playerPos: THREE.Vector3,
    playerVel: THREE.Vector3,
    grounded: boolean,
    pointerNdcX: number,
    pointerNdcY: number,
  ): void {
    this.trauma.update(dt);

    // 1. Itay Keren Deadzone Window
    const deadzoneX = 1.05;
    const deadzoneY = grounded ? 0.65 : 1.15;

    const dx = playerPos.x - this.anchor.x;
    if (dx > deadzoneX) this.anchor.x = playerPos.x - deadzoneX;
    else if (dx < -deadzoneX) this.anchor.x = playerPos.x + deadzoneX;

    const dy = playerPos.y - this.anchor.y;
    if (dy > deadzoneY) this.anchor.y = playerPos.y - deadzoneY;
    else if (dy < -deadzoneY) this.anchor.y = playerPos.y + deadzoneY;

    if (grounded) {
      // Soft platform-level snap when standing cleanly
      this.anchor.y = dampScalar(this.anchor.y, playerPos.y, 6.2, dt);
    }

    // Smooth depth follow into Band -1 chambers when breached
    const targetZ = this.breachZoomWeight > 0.5 ? this.breachTargetZ : playerPos.z;
    this.anchor.z = dampScalar(this.anchor.z, targetZ, 7.0, dt);

    // 2. Velocity + Cursor Lookahead
    const targetLookaheadX =
      THREE.MathUtils.clamp(playerVel.x * 0.24, -2.2, 2.2) + pointerNdcX * 1.15;
    const targetLookaheadY =
      THREE.MathUtils.clamp(playerVel.y * 0.1, -1.2, 0.9) + pointerNdcY * 0.65;

    this.lookaheadX = dampScalar(this.lookaheadX, targetLookaheadX, 5.2, dt);
    this.lookaheadY = dampScalar(this.lookaheadY, targetLookaheadY, 5.2, dt);

    // 3. 4-Mode View Framing (Side 2.5D vs Angled 3D + Card Breach Tilt)
    // baseDist at 14.8m frames 1280px (20m) website snugly across the viewport
    const isAngled = this.mode === 'angled_3d';
    const baseDist = isAngled ? 16.5 : 14.8;
    const zoomDist = baseDist - this.breachZoomWeight * 3.5;
    const yawOffsetX = (isAngled ? 4.5 : 0.0) + this.breachZoomWeight * 2.5;
    const elevOffsetY = isAngled ? 1.4 : 0.5;

    const focusX = this.anchor.x + this.lookaheadX;
    // Clamp top focus Y so the camera does not show empty void above header
    const rawFocusY = this.anchor.y + 0.45 + this.lookaheadY;
    const focusY = Math.min(-3.2, rawFocusY);
    const focusZ = this.anchor.z;

    this.goalLook.set(focusX, focusY, focusZ);
    this.goalPos.set(focusX + yawOffsetX, focusY + elevOffsetY, focusZ + zoomDist);

    dampVec3(this.currentPos, this.goalPos, 7.2, dt);
    dampVec3(this.currentLook, this.goalLook, 8.8, dt);

    this.camera.position.copy(this.currentPos).add(this.trauma.offset);
    this.camera.lookAt(this.currentLook);
    if (Math.abs(this.trauma.rollRad) > 1e-5) {
      this.camera.rotateZ(this.trauma.rollRad);
    }
  }
}
