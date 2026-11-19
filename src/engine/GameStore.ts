/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CameraViewMode, HudSnapshot } from '../types/game';

const DEFAULT_SNAPSHOT: HudSnapshot = {
  stepReady: 3,
  modeLabel: '2.5D Parkour Playground',
  worldMode: 'arena',
  fps: 60,
  frameTimeMs: 16.67,
  drawCalls: 0,
  cameraMode: 'side_25d',
  activeLightPulses: 0,
  zenMode: false,
  webglSupported: true,
  capabilities: {
    isSoftwareGl: false,
    rendererName: 'Initializing GPU...',
    maxAnisotropy: 1,
    hasParallelShaderCompile: false,
    hasMultiDraw: false,
    shaderWarmupMs: 0,
    contextLost: false,
  },
  parkourState: 'idle',
  stickmanSpeed: 0,
  integrityLives: 3,
  maxIntegrityLives: 3,
  stickmanHp: 100,
  maxStickmanHp: 100,
  overdriveCharge: 0,
  siteStatus: 'idle',
  siteError: null,
  siteUrl: '',
  siteTitle: 'Calibration Arena',
  fortressTier: null,
  meanCraftScore: 0,
  isDarkTheme: true,
  pageHeightM: 12,
  scrollProgress: 0,
  totalComponents: 0,
  spaRecovered: false,
  activeWeapon: 'martial',
  escalationPhase: 'CALM_EXPLORE',
  awakenedCount: 0,
};

/**
 * External store bridging the 60fps Three.js loop to React 19 via useSyncExternalStore.
 * Throttles continuous telemetry emissions (~12Hz) while flushing discrete UI transitions immediately.
 */
export class GameStore {
  private snapshot: HudSnapshot = { ...DEFAULT_SNAPSHOT };
  private listeners = new Set<() => void>();
  private lastEmitMs = 0;
  private readonly minEmitIntervalMs = 82; // ~12Hz

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): HudSnapshot => this.snapshot;

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  updateMetrics(partial: Partial<HudSnapshot>, nowMs: number, force = false): void {
    this.snapshot = { ...this.snapshot, ...partial };
    if (force || nowMs - this.lastEmitMs >= this.minEmitIntervalMs) {
      this.lastEmitMs = nowMs;
      this.notify();
    }
  }

  setCameraMode(cameraMode: CameraViewMode): void {
    if (this.snapshot.cameraMode === cameraMode) return;
    this.snapshot = { ...this.snapshot, cameraMode };
    this.notify();
  }

  setZenMode(zenMode: boolean): void {
    if (this.snapshot.zenMode === zenMode) return;
    this.snapshot = { ...this.snapshot, zenMode };
    this.notify();
  }

  reset(): void {
    this.snapshot = { ...DEFAULT_SNAPSHOT };
    this.lastEmitMs = 0;
    this.notify();
  }
}

export const gameStore = new GameStore();
