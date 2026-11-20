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
export interface CameraWebsiteBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export class CameraRig {
  public readonly camera: THREE.PerspectiveCamera;
  public readonly trauma = new TraumaShake(1.75, 0.36, 0.028);

  private readonly anchor = new THREE.Vector3(0, 1.4, 0);
  private readonly currentPos = new THREE.Vector3(0, 2.2, 22.0);
  private readonly currentLook = new THREE.Vector3(0, 1.5, 0);
  private readonly goalPos = new THREE.Vector3();
  private readonly goalLook = new THREE.Vector3();

  private mode: CameraViewMode = 'side_25d';
  private websiteBounds: CameraWebsiteBounds | null = null;
  private expandedArena = false;
  private lookaheadX = 0;
  private lookaheadY = 0;
  private breachZoomWeight = 0;
  private targetBreachZoom = 0;
  private breachTargetZ = -1.05;

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

  setWebsiteBounds(bounds: CameraWebsiteBounds | null): void {
    this.websiteBounds = bounds;
  }

  setExpandedArena(expanded: boolean): void {
    this.expandedArena = expanded;
  }

  setBreachFocus(active: boolean, targetZ = -1.05): void {
    this.targetBreachZoom = active ? 1 : 0;
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
    const isWeb = this.websiteBounds !== null;
    const dist = isWeb
      ? this.expandedArena
        ? this.mode === 'side_25d'
          ? 21.8
          : 22.8
        : this.mode === 'side_25d'
          ? 18.8
          : 19.6
      : this.mode === 'side_25d'
        ? 21.8
        : 20.0;
    const sideOffset = this.mode === 'side_25d' ? 0 : isWeb ? (this.expandedArena ? 5.0 : 4.2) : 5.4;
    const elev = this.mode === 'side_25d' ? (isWeb ? 0.35 : 1.35) : isWeb ? 1.25 : 2.15;

    let snapFocusX = x;
    let snapFocusY = y + (isWeb ? 0.45 : 0.9);
    if (this.websiteBounds) {
      snapFocusX = THREE.MathUtils.clamp(snapFocusX, this.websiteBounds.minX, this.websiteBounds.maxX);
      snapFocusY = THREE.MathUtils.clamp(snapFocusY, this.websiteBounds.minY, this.websiteBounds.maxY);
    }

    this.currentPos.set(snapFocusX + sideOffset, snapFocusY + elev, z + dist);
    this.currentLook.set(snapFocusX, snapFocusY, z);
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
    this.breachZoomWeight = dampScalar(this.breachZoomWeight, this.targetBreachZoom, 6.5, dt);

    // 1. Itay Keren Deadzone Window
    const deadzoneX = THREE.MathUtils.lerp(1.05, 0.35, this.breachZoomWeight);
    const deadzoneY = this.breachZoomWeight > 0.3 ? 0.3 : grounded ? 0.65 : 1.15;

    const dx = playerPos.x - this.anchor.x;
    if (dx > deadzoneX) this.anchor.x = playerPos.x - deadzoneX;
    else if (dx < -deadzoneX) this.anchor.x = playerPos.x + deadzoneX;

    const dy = playerPos.y - this.anchor.y;
    if (dy > deadzoneY) this.anchor.y = playerPos.y - deadzoneY;
    else if (dy < -deadzoneY) this.anchor.y = playerPos.y + deadzoneY;

    if (grounded || this.breachZoomWeight > 0.3) {
      this.anchor.y = dampScalar(this.anchor.y, playerPos.y, 7.0, dt);
    }

    // Smooth depth follow into Band -1 Cyber-Vault chambers when shrunk inside
    const targetZ = this.targetBreachZoom > 0.5 ? this.breachTargetZ : playerPos.z;
    this.anchor.z = dampScalar(this.anchor.z, targetZ, 7.5, dt);

    // 2. Velocity + Cursor Lookahead (dampened inside tight vaults)
    const lookScale = 1 - this.breachZoomWeight * 0.7;
    const targetLookaheadX =
      (THREE.MathUtils.clamp(playerVel.x * 0.22, -1.8, 1.8) + pointerNdcX * 0.9) * lookScale;
    const targetLookaheadY =
      (THREE.MathUtils.clamp(playerVel.y * 0.1, -1.0, 0.85) + pointerNdcY * 0.55) * lookScale;

    this.lookaheadX = dampScalar(this.lookaheadX, targetLookaheadX, 5.2, dt);
    this.lookaheadY = dampScalar(this.lookaheadY, targetLookaheadY, 5.2, dt);

    // 3. View Framing (Side 2.5D vs Angled 3D + Floating Expansion + Micro Cyber-Vault Zoom)
    const isWeb = this.websiteBounds !== null;
    const isAngled = this.mode === 'angled_3d';
    const baseDist = isWeb
      ? this.expandedArena
        ? isAngled
          ? 22.8
          : 21.8
        : isAngled
          ? 19.6
          : 18.8
      : isAngled
        ? 19.6
        : 21.8;
    const zoomDist = THREE.MathUtils.lerp(baseDist, isAngled ? 8.8 : 7.6, this.breachZoomWeight);
    const yawOffsetX =
      THREE.MathUtils.lerp(
        isAngled ? (isWeb ? (this.expandedArena ? 5.0 : 4.2) : 5.2) : 0.0,
        isAngled ? 2.4 : 1.15,
        this.breachZoomWeight,
      );
    const elevOffsetY = THREE.MathUtils.lerp(
      isAngled ? (isWeb ? (this.expandedArena ? 1.45 : 1.1) : 2.15) : isWeb ? 0.35 : 1.35,
      0.38,
      this.breachZoomWeight,
    );

    let focusX = this.anchor.x + this.lookaheadX;
    let focusY = this.anchor.y + (isWeb ? 0.45 : 0.95) * (1 - this.breachZoomWeight * 0.6) + this.lookaheadY;
    if (this.websiteBounds && this.breachZoomWeight < 0.25) {
      focusX = THREE.MathUtils.clamp(focusX, this.websiteBounds.minX, this.websiteBounds.maxX);
      focusY = THREE.MathUtils.clamp(focusY, this.websiteBounds.minY, this.websiteBounds.maxY);
    }
    const focusZ = this.anchor.z;

    this.goalLook.set(focusX, focusY, focusZ);
    this.goalPos.set(focusX + yawOffsetX, focusY + elevOffsetY, focusZ + zoomDist);

    dampVec3(this.currentPos, this.goalPos, 7.6, dt);
    dampVec3(this.currentLook, this.goalLook, 9.2, dt);

    this.camera.position.copy(this.currentPos).add(this.trauma.offset);
    this.camera.lookAt(this.currentLook);
    if (Math.abs(this.trauma.rollRad) > 1e-5) {
      this.camera.rotateZ(this.trauma.rollRad);
    }
  }
}
