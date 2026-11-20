/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import * as THREE from 'three';
import { snapdom } from '@zumer/snapdom';
import type RAPIER from '@dimforge/rapier3d-compat';
import {
  COLLISION_GROUP,
  RENDER_ORDER,
  SPATIAL_CONSTANTS,
  type CyberVaultPortal,
  type ExtractedDomComponent,
  type FortressTier,
  type PlatformBlock,
  type WorldPhase,
} from '../types/game';
import type { AnalyzedWebsite } from './DomAnalyzer';
import type { PhysicsWorld } from '../engine/PhysicsWorld';
import { SeededPRNG } from '../math/prng';
import { dampScalar } from '../math/springs';

const BACKDROP_FRAGMENT_SHADER = /* glsl */ `
precision highp float;
precision highp sampler2DArray;

uniform sampler2DArray uTileArray;
uniform int uTileCount;
uniform float uLayerIndex;
uniform float uOpacity;

in vec2 vUv;
out vec4 fragColor;

void main() {
  if (uOpacity <= 0.01) discard;
  float layerIdx = clamp(floor(uLayerIndex + 0.5), 0.0, float(max(0, uTileCount - 1)));
  vec2 sampleUv = vec2(vUv.x, 1.0 - vUv.y);
  vec4 texel = texture(uTileArray, vec3(sampleUv, layerIdx));
  fragColor = vec4(texel.rgb, texel.a * uOpacity);
}
`;

const BACKDROP_VERTEX_SHADER = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

function createCyberCircuitTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#0c101b';
    ctx.fillRect(0, 0, 256, 256);

    // Inner ambient cyber vignette
    const grad = ctx.createRadialGradient(128, 128, 18, 128, 128, 170);
    grad.addColorStop(0, 'rgba(14, 116, 144, 0.28)');
    grad.addColorStop(0.6, 'rgba(15, 23, 42, 0.42)');
    grad.addColorStop(1, 'rgba(5, 7, 13, 0.95)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 256, 256);

    // Subtle PCB / cyber-vault grid lines
    ctx.strokeStyle = 'rgba(34, 211, 238, 0.16)';
    ctx.lineWidth = 1.5;
    for (let x = 32; x < 256; x += 32) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, 256);
      ctx.stroke();
    }
    for (let y = 32; y < 256; y += 32) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(256, y);
      ctx.stroke();
    }

    // Glowing data trace elbows & amber nodes
    ctx.strokeStyle = 'rgba(6, 182, 212, 0.5)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(16, 64);
    ctx.lineTo(96, 64);
    ctx.lineTo(128, 96);
    ctx.lineTo(240, 96);
    ctx.moveTo(24, 192);
    ctx.lineTo(112, 192);
    ctx.lineTo(144, 160);
    ctx.lineTo(224, 160);
    ctx.stroke();

    ctx.fillStyle = '#f59e0b';
    for (const [nx, ny] of [
      [96, 64],
      [128, 96],
      [112, 192],
      [144, 160],
    ]) {
      ctx.beginPath();
      ctx.arc(nx, ny, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createRoundedRectShape(width: number, height: number, radius: number): THREE.Shape {
  const shape = new THREE.Shape();
  const hw = width * 0.5;
  const hh = height * 0.5;
  const r = Math.min(radius, hw * 0.42, hh * 0.42);
  shape.moveTo(-hw + r, -hh);
  shape.lineTo(hw - r, -hh);
  shape.quadraticCurveTo(hw, -hh, hw, -hh + r);
  shape.lineTo(hw, hh - r);
  shape.quadraticCurveTo(hw, hh, hw - r, hh);
  shape.lineTo(-hw + r, hh);
  shape.quadraticCurveTo(-hw, hh, -hw, hh - r);
  shape.lineTo(-hw, -hh + r);
  shape.quadraticCurveTo(-hw, -hh, -hw + r, -hh);
  return shape;
}

function normalizeExtrudeCapUvs(geo: THREE.BufferGeometry, w: number, h: number): void {
  const pos = geo.getAttribute('position');
  const norm = geo.getAttribute('normal');
  const uv = geo.getAttribute('uv');
  if (!pos || !norm || !uv) return;

  const invW = 1 / Math.max(0.05, w);
  const invH = 1 / Math.max(0.05, h);
  for (let i = 0; i < pos.count; i++) {
    const nz = Math.abs(norm.getZ(i));
    if (nz > 0.65) {
      const u = THREE.MathUtils.clamp(pos.getX(i) * invW + 0.5, 0, 1);
      const v = THREE.MathUtils.clamp(pos.getY(i) * invH + 0.5, 0, 1);
      uv.setXY(i, u, v);
    }
  }
  uv.needsUpdate = true;
}

function tierToArmorColor(tier: FortressTier, isDarkTheme: boolean): number {
  switch (tier) {
    case 'tier_1_outpost':
      return isDarkTheme ? 0x27272a : 0xcbd5e1;
    case 'tier_2_foundry':
      return isDarkTheme ? 0x334155 : 0x94a3b8;
    case 'tier_3_citadel':
      return isDarkTheme ? 0x1e3a5f : 0x475569;
    case 'tier_4_bastion':
      return isDarkTheme ? 0x181822 : 0x334155;
  }
}

function tierToAccentColor(tier: FortressTier): number {
  switch (tier) {
    case 'tier_1_outpost':
      return 0x94a3b8;
    case 'tier_2_foundry':
      return 0x38bdf8;
    case 'tier_3_citadel':
      return 0xf59e0b;
    case 'tier_4_bastion':
      return 0x06b6d4;
  }
}

function easeOutBackClamped(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const c1 = 1.05;
  const c3 = c1 + 1;
  const u = t - 1;
  return 1 + c3 * u * u * u + c1 * u * u;
}

interface InteriorKinematicCollider {
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  localX: number;
  localY: number;
  localZ: number;
}

interface DataOrbPickup {
  mesh: THREE.Mesh;
  localX: number;
  localY: number;
  collected: boolean;
  phase: number;
}

interface CyberVaultData {
  title: string;
  vaultGroup: THREE.Group;
  frontDoorFrame: THREE.Mesh;
  exitBeaconMesh: THREE.Mesh;
  coreGroup: THREE.Group;
  coreGyroRing: THREE.Mesh;
  coreMesh: THREE.Mesh;
  orbs: DataOrbPickup[];
  interiorColliders: InteriorKinematicCollider[];
  chamberW: number;
  chamberH: number;
  portalHalfW: number;
  portalHalfH: number;
  exitLocalX: number;
  exitLocalY: number;
  isBreached: boolean;
  isCoreDestroyed: boolean;
}

interface LivingIslandEntry {
  id: string;
  group: THREE.Group;
  frontCoverMesh: THREE.Mesh;
  frontWingLeft: THREE.Mesh | null;
  frontWingRight: THREE.Mesh | null;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  block: PlatformBlock;
  intactX: number;
  intactY: number;
  intactZ: number;
  intactPhysY: number;
  curX: number;
  curY: number;
  curZ: number;
  brokenX: number;
  brokenY: number;
  brokenZ: number;
  brokenPhysY: number;
  brokenRotY: number;
  brokenRotZ: number;
  halfW: number;
  visualHalfH: number;
  hoverAmp: number;
  hoverFreq: number;
  hoverPhase: number;
  staggerDelay: number;
  vault: CyberVaultData | null;
}

export interface VaultInteractionResult {
  breachedVault: CyberVaultPortal | null;
  destroyedCoreVault: CyberVaultPortal | null;
  collectedOrbPos: THREE.Vector3 | null;
  impactX: number;
  impactY: number;
}

/**
 * Milestone 3C — Clean Component-Only Floating Website & Breakable Cyber-Vaults:
 * - Act I (`intact`): Pixel-accurate full-page Band -2 + exact DOM positions for 3.0s (or until first strike).
 * - Breakup (`fracturing` -> `broken_arena`): Cleanly dissolves Band -2 into dark cosmic space so ONLY
 *   the real DOM components float around as well-spaced playable islands.
 * - Break & Enter Cyber-Vaults: Strike any hollow/structural component to crack open a glowing doorway into
 *   its illuminated Band -1 Miniature Cyber-Vault interior (complete with micro-platforms, collectible
 *   Data Orbs, and a destructible Core Reactor) where the hero automatically shrinks to 0.38x!
 */
export class WebsiteWorld {
  public readonly root = new THREE.Group();
  public readonly pageHeightM: number;
  public readonly expandedPageHeightM: number;
  public readonly isDarkTheme: boolean;
  public readonly spawnPoint = new THREE.Vector3(-4.5, 1.0, SPATIAL_CONSTANTS.BAND_PLAY_Z);

  private worldPhase: WorldPhase = 'intact';
  private fractureCountdown = 3.0;
  private fractureElapsed = 0;

  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly textures: THREE.Texture[] = [];
  private readonly backdropMeshes: Array<{ mesh: THREE.Mesh; mat: THREE.ShaderMaterial; y: number }> = [];
  private readonly islands: LivingIslandEntry[] = [];
  private readonly prng: SeededPRNG;

  private outerFrameMesh: THREE.Mesh | null = null;
  private sideFrameMat: THREE.MeshBasicMaterial | null = null;
  private backdropOpacity = 1.0;

  // Dynamic Boundary Rails & Bottom Catch Deck
  private bottomDeckMesh: THREE.Mesh | null = null;
  private bottomDeckBody: RAPIER.RigidBody | null = null;
  private bottomDeckCollider: RAPIER.Collider | null = null;
  private readonly intactBottomY: number;
  private expandedBottomY: number;

  private leftRailBody: RAPIER.RigidBody | null = null;
  private leftRailCollider: RAPIER.Collider | null = null;
  private rightRailBody: RAPIER.RigidBody | null = null;
  private rightRailCollider: RAPIER.Collider | null = null;

  // Rideable Right-Edge Scrollbar Carriage & Rail
  private scrollbarRailMesh: THREE.Mesh | null = null;
  private scrollbarThumbMesh: THREE.Mesh | null = null;
  private scrollbarCollider: RAPIER.Collider | null = null;
  private scrollbarBody: RAPIER.RigidBody | null = null;
  private scrollbarX = 9.75;
  private scrollbarY = -1.2;
  private scrollbarDir = -1;

  // Cyber-Vault progression counters
  private activeVaultId: string | null = null;
  private totalVaultCount = 0;
  private vaultsClearedCount = 0;
  private dataOrbsCollectedCount = 0;
  private simTime = 0;

  private constructor(pageHeightM: number, isDarkTheme: boolean, url: string) {
    this.pageHeightM = pageHeightM;
    this.expandedPageHeightM = pageHeightM * 1.4;
    this.intactBottomY = -pageHeightM - 0.35;
    this.expandedBottomY = -this.expandedPageHeightM - 0.85;
    this.isDarkTheme = isDarkTheme;
    this.prng = new SeededPRNG(`cosmic-web-${url}`);
    this.root.name = 'WebsiteWorld';
  }

  getWorldPhase(): WorldPhase {
    return this.worldPhase;
  }

  getFractureCountdown(): number {
    return this.fractureCountdown;
  }

  getTotalVaults(): number {
    return this.totalVaultCount;
  }

  getVaultsCleared(): number {
    return this.vaultsClearedCount;
  }

  getDataOrbsCollected(): number {
    return this.dataOrbsCollectedCount;
  }

  setActiveVaultId(id: string | null): void {
    this.activeVaultId = id;
  }

  getActiveArenaHalfWidth(): number {
    if (this.worldPhase === 'intact') return 10.0;
    const p = THREE.MathUtils.clamp(this.fractureElapsed / 0.72, 0, 1);
    return THREE.MathUtils.lerp(10.0, 14.5, p);
  }

  getActivePageHeightM(): number {
    if (this.worldPhase === 'intact') return this.pageHeightM;
    const p = THREE.MathUtils.clamp(this.fractureElapsed / 0.72, 0, 1);
    return THREE.MathUtils.lerp(this.pageHeightM, this.expandedPageHeightM, p);
  }

  triggerFracture(impactX: number, impactY: number): boolean {
    if (this.worldPhase !== 'intact') return false;
    this.worldPhase = 'fracturing';
    this.fractureCountdown = 0;
    this.fractureElapsed = 0;

    for (let i = 0; i < this.islands.length; i++) {
      const isl = this.islands[i];
      const dist = Math.hypot(isl.intactX - impactX, isl.intactY - impactY);
      isl.staggerDelay = THREE.MathUtils.clamp(dist * 0.012, 0, 0.14);
    }

    return true;
  }

  private toVaultPortalInfo(isl: LivingIslandEntry): CyberVaultPortal | null {
    if (!isl.vault) return null;
    const v = isl.vault;
    return {
      id: isl.id,
      title: v.title,
      isBreached: v.isBreached,
      isCoreDestroyed: v.isCoreDestroyed,
      portalX: isl.curX,
      portalY: isl.curY,
      portalHalfW: v.portalHalfW,
      portalHalfH: v.portalHalfH,
      chamberCenterX: isl.curX,
      chamberCenterY: isl.curY,
      chamberCenterZ: SPATIAL_CONSTANTS.BAND_CHAMBER_CENTER_Z,
      chamberHalfW: v.chamberW * 0.5,
      chamberHalfH: v.chamberH * 0.5,
      exitX: isl.curX + v.exitLocalX,
      exitY: isl.curY + v.exitLocalY,
    };
  }

  getVaultById(id: string): CyberVaultPortal | null {
    const isl = this.islands.find((item) => item.id === id);
    return isl ? this.toVaultPortalInfo(isl) : null;
  }

  /**
   * Handles hero attacks (Left Click / J):
   * - If outside: breaches the nearest / aimed Cyber-Vault component, splitting its front cover open
   *   and illuminating its miniature interior chamber!
   * - If inside a Cyber-Vault: strikes and shatters the pulsing Vault Data Core Reactor!
   */
  handleStrikeAt(
    hitX: number,
    hitY: number,
    heroX: number,
    heroY: number,
    inVaultId: string | null,
  ): VaultInteractionResult {
    const res: VaultInteractionResult = {
      breachedVault: null,
      destroyedCoreVault: null,
      collectedOrbPos: null,
      impactX: hitX,
      impactY: hitY,
    };

    if (inVaultId) {
      const isl = this.islands.find((item) => item.id === inVaultId);
      if (isl && isl.vault && !isl.vault.isCoreDestroyed) {
        const distToCore = Math.hypot(heroX - isl.curX, heroY - isl.curY);
        const distAimToCore = Math.hypot(hitX - isl.curX, hitY - isl.curY);
        if (distToCore < 2.2 || distAimToCore < 1.8) {
          isl.vault.isCoreDestroyed = true;
          isl.vault.coreGroup.visible = false;
          this.vaultsClearedCount++;
          res.destroyedCoreVault = this.toVaultPortalInfo(isl);
          res.impactX = isl.curX;
          res.impactY = isl.curY;
        }
      }
      return res;
    }

    // Outside: find best vault component near click point OR near hero reach
    let bestIsl: LivingIslandEntry | null = null;
    let bestScore = Infinity;
    for (const isl of this.islands) {
      if (!isl.vault) continue;
      const dxClick = Math.abs(hitX - isl.curX);
      const dyClick = Math.abs(hitY - isl.curY);
      const insideClick = dxClick <= isl.halfW + 0.65 && dyClick <= isl.visualHalfH + 0.65;
      const distHero = Math.hypot(heroX - isl.curX, heroY - isl.curY);
      const nearHero = distHero <= Math.max(isl.halfW, isl.visualHalfH) + 2.4;

      if (insideClick || nearHero) {
        const score = insideClick
          ? Math.hypot(dxClick, dyClick) * 0.5
          : distHero + 1.0;
        if (score < bestScore) {
          bestScore = score;
          bestIsl = isl;
        }
      }
    }

    if (bestIsl && bestIsl.vault && !bestIsl.vault.isBreached) {
      bestIsl.vault.isBreached = true;
      bestIsl.vault.vaultGroup.visible = true;
      bestIsl.vault.frontDoorFrame.visible = true;
      // Split front cover cleanly into glowing left & right side armor wings around the open portal!
      bestIsl.frontCoverMesh.visible = false;
      if (bestIsl.frontWingLeft) bestIsl.frontWingLeft.visible = true;
      if (bestIsl.frontWingRight) bestIsl.frontWingRight.visible = true;

      res.breachedVault = this.toVaultPortalInfo(bestIsl);
      res.impactX = bestIsl.curX;
      res.impactY = bestIsl.curY;
    }

    return res;
  }

  findNearestBreachedPortal(heroX: number, heroY: number, maxRange = 3.2): CyberVaultPortal | null {
    let best: CyberVaultPortal | null = null;
    let bestDist = maxRange;
    for (const isl of this.islands) {
      if (!isl.vault || !isl.vault.isBreached) continue;
      const dist = Math.hypot(heroX - isl.curX, heroY - isl.curY);
      if (dist < bestDist) {
        bestDist = dist;
        best = this.toVaultPortalInfo(isl);
      }
    }
    return best;
  }

  /**
   * Checks if hero overlaps a breached portal (outside -> dive inside & shrink)
   * OR overlaps the vault's Exit Gate Beacon (inside -> pop back out & grow to 1.6x).
   */
  findPortalTransition(
    heroX: number,
    heroY: number,
    inVaultId: string | null,
  ): { action: 'enter' | 'exit'; vault: CyberVaultPortal } | null {
    if (inVaultId) {
      const isl = this.islands.find((item) => item.id === inVaultId);
      if (!isl || !isl.vault) return null;
      const exitWorldX = isl.curX + isl.vault.exitLocalX;
      const exitWorldY = isl.curY + isl.vault.exitLocalY;
      if (Math.hypot(heroX - exitWorldX, heroY - exitWorldY) < 0.78) {
        const portal = this.toVaultPortalInfo(isl);
        if (portal) return { action: 'exit', vault: portal };
      }
      return null;
    }

    for (const isl of this.islands) {
      if (!isl.vault || !isl.vault.isBreached) continue;
      const dx = Math.abs(heroX - isl.curX);
      const dy = Math.abs(heroY - isl.curY);
      if (dx <= isl.vault.portalHalfW + 0.55 && dy <= Math.max(isl.vault.portalHalfH + 0.55, isl.visualHalfH + 0.35)) {
        const portal = this.toVaultPortalInfo(isl);
        if (portal) return { action: 'enter', vault: portal };
      }
    }
    return null;
  }

  /**
   * Collects Data Orbs when shrunk inside an active Cyber-Vault.
   */
  collectNearbyOrbs(inVaultId: string, heroX: number, heroY: number): THREE.Vector3 | null {
    const isl = this.islands.find((item) => item.id === inVaultId);
    if (!isl || !isl.vault) return null;
    for (const orb of isl.vault.orbs) {
      if (orb.collected) continue;
      const ox = isl.curX + orb.localX;
      const oy = isl.curY + orb.localY;
      if (Math.hypot(heroX - ox, heroY - oy) < 0.56) {
        orb.collected = true;
        orb.mesh.visible = false;
        this.dataOrbsCollectedCount++;
        return new THREE.Vector3(ox, oy, SPATIAL_CONSTANTS.BAND_CHAMBER_CENTER_Z);
      }
    }
    return null;
  }

  static async build(
    analyzed: AnalyzedWebsite,
    physics: PhysicsWorld,
    isSoftwareGl: boolean,
    maxAnisotropy: number,
  ): Promise<WebsiteWorld> {
    const world = new WebsiteWorld(analyzed.pageHeightM, analyzed.isDarkTheme, analyzed.url);

    const circuitTex = createCyberCircuitTexture();
    world.textures.push(circuitTex);

    world.sideFrameMat = new THREE.MeshBasicMaterial({
      color: analyzed.isDarkTheme ? 0x09090b : 0x11131a,
      transparent: true,
      opacity: 1.0,
      toneMapped: false,
    });
    const chamberWallMat = new THREE.MeshStandardMaterial({
      map: circuitTex,
      roughness: 0.55,
      metalness: 0.25,
      emissive: 0x0e7490,
      emissiveIntensity: 0.68,
    });
    const innerShelfMat = new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      roughness: 0.28,
      metalness: 0.72,
      emissive: 0x22d3ee,
      emissiveIntensity: 0.55,
    });
    const portalFrameMat = new THREE.MeshBasicMaterial({
      color: 0x22d3ee,
      transparent: true,
      opacity: 0.9,
      toneMapped: false,
    });
    const exitBeaconMat = new THREE.MeshBasicMaterial({
      color: 0xf59e0b,
      transparent: true,
      opacity: 0.92,
      toneMapped: false,
    });
    const orbMat = new THREE.MeshStandardMaterial({
      color: 0xfef08a,
      emissive: 0xf59e0b,
      emissiveIntensity: 1.85,
      roughness: 0.15,
      metalness: 0.65,
    });
    const coreMat = new THREE.MeshStandardMaterial({
      color: 0x38bdf8,
      emissive: 0x06b6d4,
      emissiveIntensity: 2.1,
      roughness: 0.18,
      metalness: 0.85,
    });
    const coreRingMat = new THREE.MeshBasicMaterial({
      color: 0xf59e0b,
      transparent: true,
      opacity: 0.88,
      toneMapped: false,
    });
    world.materials.push(
      world.sideFrameMat,
      chamberWallMat,
      innerShelfMat,
      portalFrameMat,
      exitBeaconMat,
      orbMat,
      coreMat,
      coreRingMat,
    );

    // -----------------------------------------------------------------------
    // PASS 0: Band -2 Full-Page Tiles (100% Intact in Act I, dissolves cleanly
    // into pure Cosmic Space on Break so ONLY real DOM components float!)
    // -----------------------------------------------------------------------
    const tileLogicalH = 1024;
    const sliceCount = Math.max(
      1,
      Math.min(12, Math.ceil(analyzed.pageHeightPx / tileLogicalH)),
    );
    const texTileW = isSoftwareGl ? 512 : 1024;
    const texTileH = isSoftwareGl ? 512 : 1024;
    const snapScale = isSoftwareGl ? 0.8 : 1.0;

    const rgbaArray = new Uint8Array(texTileW * texTileH * 4 * sliceCount);
    const blitCanvas = document.createElement('canvas');
    blitCanvas.width = texTileW;
    blitCanvas.height = texTileH;
    const blitCtx = blitCanvas.getContext('2d', { willReadFrequently: true });

    for (let s = 0; s < sliceCount; s++) {
      const sliceTopPx = s * tileLogicalH;
      const sliceHeightPx = Math.min(tileLogicalH, analyzed.pageHeightPx - sliceTopPx);

      let capturedCanvas: HTMLCanvasElement | null = null;
      try {
        capturedCanvas = await snapdom.toCanvas(analyzed.doc.body, {
          scale: snapScale,
          clip: {
            x: 0,
            y: sliceTopPx,
            width: analyzed.pageWidthPx,
            height: Math.max(64, sliceHeightPx),
          },
          backgroundColor: analyzed.pageBgCss,
          embedFonts: false,
          cache: 'disabled',
          useProxy: '/api/proxy-asset?url=',
        });
      } catch {
        capturedCanvas = null;
      }

      if (blitCtx) {
        blitCtx.fillStyle = analyzed.pageBgCss;
        blitCtx.fillRect(0, 0, texTileW, texTileH);
        if (capturedCanvas && capturedCanvas.width > 0 && capturedCanvas.height > 0) {
          const destH = Math.round((sliceHeightPx / tileLogicalH) * texTileH);
          blitCtx.drawImage(capturedCanvas, 0, 0, texTileW, Math.max(1, destH));
        }
        const imgData = blitCtx.getImageData(0, 0, texTileW, texTileH);
        rgbaArray.set(imgData.data, s * texTileW * texTileH * 4);
      }
    }

    const tileArrayTex = new THREE.DataArrayTexture(rgbaArray, texTileW, texTileH, sliceCount);
    tileArrayTex.format = THREE.RGBAFormat;
    tileArrayTex.type = THREE.UnsignedByteType;
    tileArrayTex.colorSpace = THREE.SRGBColorSpace;
    tileArrayTex.minFilter = THREE.LinearFilter;
    tileArrayTex.magFilter = THREE.LinearFilter;
    tileArrayTex.generateMipmaps = false;
    tileArrayTex.flipY = false;
    tileArrayTex.needsUpdate = true;
    world.textures.push(tileArrayTex);

    const tileWorldH = tileLogicalH * SPATIAL_CONSTANTS.WORLD_SCALE;
    const planeGeo = new THREE.PlaneGeometry(SPATIAL_CONSTANTS.WORLD_WIDTH_M, tileWorldH);
    world.geometries.push(planeGeo);

    for (let s = 0; s < sliceCount; s++) {
      const sliceCenterY = -(s * tileWorldH + tileWorldH * 0.5);
      const mat = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: BACKDROP_VERTEX_SHADER,
        fragmentShader: BACKDROP_FRAGMENT_SHADER,
        uniforms: {
          uTileArray: { value: tileArrayTex },
          uTileCount: { value: sliceCount },
          uLayerIndex: { value: s },
          uOpacity: { value: 1.0 },
        },
        transparent: true,
        toneMapped: false,
      });
      world.materials.push(mat);

      const mesh = new THREE.Mesh(planeGeo, mat);
      mesh.position.set(0, sliceCenterY, SPATIAL_CONSTANTS.BAND_BACKDROP_Z);
      mesh.renderOrder = RENDER_ORDER.OPAQUE_WORLD;
      world.root.add(mesh);
      world.backdropMeshes.push({ mesh, mat, y: sliceCenterY });
    }

    const stageTotalH = Math.max(28, analyzed.pageHeightM + 20);
    const outerFrameGeo = new THREE.PlaneGeometry(56.0, stageTotalH);
    world.geometries.push(outerFrameGeo);
    world.outerFrameMesh = new THREE.Mesh(outerFrameGeo, world.sideFrameMat);
    world.outerFrameMesh.position.set(
      0,
      -analyzed.pageHeightM * 0.5,
      SPATIAL_CONSTANTS.BAND_BACKDROP_Z - 0.14,
    );
    world.outerFrameMesh.renderOrder = RENDER_ORDER.OPAQUE_WORLD;
    world.root.add(world.outerFrameMesh);

    // -----------------------------------------------------------------------
    // PASS 1 & 2: Floating DOM Components + Break-and-Enter Cyber-Vaults
    // -----------------------------------------------------------------------
    const tierMaterials = new Map<string, THREE.MeshStandardMaterial>();
    const getArmorMat = (comp: ExtractedDomComponent): THREE.MeshStandardMaterial => {
      const key = `${comp.tier}-${analyzed.isDarkTheme ? 'd' : 'l'}`;
      let mat = tierMaterials.get(key);
      if (!mat) {
        const isHighTier = comp.tier === 'tier_3_citadel' || comp.tier === 'tier_4_bastion';
        mat = new THREE.MeshStandardMaterial({
          color: tierToArmorColor(comp.tier, analyzed.isDarkTheme),
          roughness: isHighTier ? 0.28 : 0.72,
          metalness: isHighTier ? 0.78 : 0.18,
          emissive: tierToAccentColor(comp.tier),
          emissiveIntensity: isHighTier ? 0.14 : 0.05,
        });
        tierMaterials.set(key, mat);
        world.materials.push(mat);
      }
      return mat;
    };

    const rimMat = new THREE.MeshBasicMaterial({
      color: analyzed.isDarkTheme ? 0x38bdf8 : 0xf59e0b,
      side: THREE.BackSide,
      transparent: true,
      opacity: analyzed.isDarkTheme ? 0.34 : 0.22,
    });
    world.materials.push(rimMat);

    // Shared geometries for Cyber-Vault collectibles, core, and portal trims
    const orbGeo = new THREE.OctahedronGeometry(0.14, 0);
    const coreGeo = new THREE.IcosahedronGeometry(0.26, 0);
    const coreRingGeo = new THREE.TorusGeometry(0.36, 0.032, 8, 24);
    const exitRingGeo = new THREE.TorusGeometry(0.28, 0.035, 8, 20);
    world.geometries.push(orbGeo, coreGeo, coreRingGeo, exitRingGeo);

    const activeComps = analyzed.components.slice(0, 36);
    let vaultCount = 0;

    for (let i = 0; i < activeComps.length; i++) {
      const comp = activeComps[i];

      let resolvedBgCss = analyzed.pageBgCss;
      const docWin = analyzed.doc.defaultView;
      if (docWin) {
        let cur: Element | null = comp.element;
        while (cur) {
          const bg = docWin.getComputedStyle(cur).backgroundColor;
          if (bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)') {
            const alphaMatch = bg.match(/rgba\([^)]+,\s*([\d.]+)\s*\)/i);
            if (!alphaMatch || Number(alphaMatch[1]) > 0.2) {
              resolvedBgCss = bg;
              break;
            }
          }
          cur = cur.parentElement;
        }
      }

      let compTex: THREE.CanvasTexture | null = null;
      try {
        const snapCanvas = await snapdom.toCanvas(comp.element, {
          scale: isSoftwareGl ? 1 : 1.5,
          backgroundColor: null,
          embedFonts: false,
          cache: 'disabled',
          useProxy: '/api/proxy-asset?url=',
        });
        if (snapCanvas && snapCanvas.width > 0 && snapCanvas.height > 0) {
          const compCanvas = document.createElement('canvas');
          compCanvas.width = snapCanvas.width;
          compCanvas.height = snapCanvas.height;
          const cctx = compCanvas.getContext('2d');
          if (cctx) {
            cctx.fillStyle = resolvedBgCss;
            cctx.fillRect(0, 0, compCanvas.width, compCanvas.height);
            cctx.drawImage(snapCanvas, 0, 0);
          }
          compTex = new THREE.CanvasTexture(cctx ? compCanvas : snapCanvas);
          compTex.colorSpace = THREE.SRGBColorSpace;
          compTex.anisotropy = maxAnisotropy;
          compTex.minFilter = THREE.LinearFilter;
          compTex.magFilter = THREE.LinearFilter;
          compTex.needsUpdate = true;
          world.textures.push(compTex);
        }
      } catch {
        compTex = null;
      }

      const armorMat = getArmorMat(comp);
      const frontMat = compTex
        ? new THREE.MeshBasicMaterial({ map: compTex, toneMapped: false })
        : new THREE.MeshStandardMaterial({
            color: analyzed.isDarkTheme ? 0x181822 : 0xf1f5f9,
            roughness: 0.35,
            metalness: 0.45,
            transparent: true,
            opacity: 0.24,
          });
      world.materials.push(frontMat);

      const isInteractiveWidget =
        comp.tagName === 'button' ||
        comp.tagName === 'a' ||
        comp.tagName === 'input' ||
        comp.tagName === 'select';

      const depthM = isInteractiveWidget
        ? 0.11
        : THREE.MathUtils.clamp(0.18 + comp.craft.cScore * 0.03, 0.2, 0.3);
      const meshZ = isInteractiveWidget
        ? SPATIAL_CONSTANTS.BAND_PLAY_Z - 0.18
        : SPATIAL_CONSTANTS.BAND_PLAY_Z - 0.3;

      const shape = createRoundedRectShape(comp.w, comp.h, Math.min(0.12, comp.h * 0.22));
      const extGeo = new THREE.ExtrudeGeometry(shape, {
        depth: depthM,
        bevelEnabled: true,
        bevelThickness: 0.016,
        bevelSize: 0.014,
        bevelSegments: 2,
      });
      extGeo.translate(0, 0, -depthM * 0.5);
      extGeo.computeVertexNormals();
      normalizeExtrudeCapUvs(extGeo, comp.w, comp.h);
      world.geometries.push(extGeo);

      const islandGrp = new THREE.Group();
      islandGrp.position.set(comp.x, comp.y, meshZ);
      world.root.add(islandGrp);

      const compMesh = new THREE.Mesh(extGeo, [frontMat, armorMat]);
      compMesh.castShadow = !isSoftwareGl;
      compMesh.receiveShadow = true;
      compMesh.renderOrder = RENDER_ORDER.OPAQUE_WORLD;
      islandGrp.add(compMesh);

      const rimMesh = new THREE.Mesh(extGeo, rimMat);
      rimMesh.scale.set(1.006, 1.012, 1.02);
      islandGrp.add(rimMesh);

      // Register exterior walkable physics shelf (Band 0)
      const isShelf = comp.h > 0.32;
      const physY = isShelf ? comp.y + comp.h * 0.5 - 0.05 : comp.y;
      const physHalfH = isShelf ? 0.05 : Math.max(0.04, comp.h * 0.5);
      const halfW = Math.max(0.2, comp.w * 0.5 - 0.02);

      const block: PlatformBlock = {
        id: comp.id,
        x: comp.x,
        y: physY,
        z: SPATIAL_CONSTANTS.BAND_PLAY_Z,
        halfW,
        halfH: physHalfH,
        halfD: 0.55,
        grabbableCorners: true,
      };
      const kinShelf = physics.createKinematicPlatform(
        block.x,
        block.y,
        block.z,
        block.halfW,
        block.halfH,
        block.halfD,
        COLLISION_GROUP.CARD_SHELL,
        block,
      );

      // Build Break-and-Enter Miniature Cyber-Vault inside cards/sections/panels!
      const canHouseVault =
        (comp.isHollowCard || comp.w >= 2.2) && comp.h >= 0.95 && vaultCount < 12;

      let frontWingLeft: THREE.Mesh | null = null;
      let frontWingRight: THREE.Mesh | null = null;
      let vaultData: CyberVaultData | null = null;

      if (canHouseVault) {
        vaultCount++;
        const vw = THREE.MathUtils.clamp(comp.w * 0.9, 3.0, 7.6);
        const vh = THREE.MathUtils.clamp(Math.max(comp.h * 0.92, 2.25), 2.25, 4.2);
        const portalHalfW = Math.min(0.85, vw * 0.24);
        const portalHalfH = Math.min(0.72, vh * 0.32);

        // Split side armor wings revealed when the front shell is cracked open
        const wingW = Math.max(0.45, comp.w * 0.5 - portalHalfW - 0.05);
        const wingGeo = new THREE.BoxGeometry(wingW, comp.h * 0.92, depthM);
        world.geometries.push(wingGeo);
        frontWingLeft = new THREE.Mesh(wingGeo, armorMat);
        frontWingLeft.position.set(-portalHalfW - wingW * 0.5, 0, 0);
        frontWingLeft.visible = false;

        frontWingRight = new THREE.Mesh(wingGeo, armorMat);
        frontWingRight.position.set(portalHalfW + wingW * 0.5, 0, 0);
        frontWingRight.visible = false;
        islandGrp.add(frontWingLeft, frontWingRight);

        // Glowing doorway rim frame when breached
        const doorFrameGeo = new THREE.RingGeometry(
          Math.min(portalHalfW, portalHalfH) * 0.85,
          Math.min(portalHalfW, portalHalfH) * 1.05,
          24,
        );
        world.geometries.push(doorFrameGeo);
        const frontDoorFrame = new THREE.Mesh(doorFrameGeo, portalFrameMat);
        frontDoorFrame.position.set(0, 0, depthM * 0.5 + 0.05);
        frontDoorFrame.visible = false;
        frontDoorFrame.renderOrder = RENDER_ORDER.ADDITIVE_VFX_LIGHTNING;
        islandGrp.add(frontDoorFrame);

        // Illuminated Band -1 Cyber-Vault Chamber Group
        const localRoomZ = SPATIAL_CONSTANTS.BAND_CHAMBER_CENTER_Z - meshZ;
        const vaultGroup = new THREE.Group();
        vaultGroup.position.set(0, 0, localRoomZ);
        vaultGroup.visible = false; // Revealed cleanly when component shell breaks open!
        islandGrp.add(vaultGroup);

        const wallThick = 0.14;
        const roomDepth = 1.65;
        const backGeo = new THREE.BoxGeometry(vw, vh, 0.12);
        const sideGeo = new THREE.BoxGeometry(wallThick, vh, roomDepth);
        const tbGeo = new THREE.BoxGeometry(vw, wallThick, roomDepth);
        const pillarGeo = new THREE.BoxGeometry(0.18, vh - 0.3, 0.18);
        const microShelfGeo = new THREE.BoxGeometry(vw * 0.3, 0.1, 1.05);
        world.geometries.push(backGeo, sideGeo, tbGeo, pillarGeo, microShelfGeo);

        const backPlate = new THREE.Mesh(backGeo, chamberWallMat);
        backPlate.position.set(0, 0, -roomDepth * 0.5);

        const lWall = new THREE.Mesh(sideGeo, chamberWallMat);
        lWall.position.set(-vw * 0.5 + wallThick * 0.5, 0, 0);

        const rWall = new THREE.Mesh(sideGeo, chamberWallMat);
        rWall.position.set(vw * 0.5 - wallThick * 0.5, 0, 0);

        const floorSlab = new THREE.Mesh(tbGeo, chamberWallMat);
        floorSlab.position.set(0, -vh * 0.5 + wallThick * 0.5, 0);

        const ceilSlab = new THREE.Mesh(tbGeo, chamberWallMat);
        ceilSlab.position.set(0, vh * 0.5 - wallThick * 0.5, 0);

        const pillarL = new THREE.Mesh(pillarGeo, innerShelfMat);
        pillarL.position.set(-vw * 0.34, 0, -0.45);
        const pillarR = new THREE.Mesh(pillarGeo, innerShelfMat);
        pillarR.position.set(vw * 0.34, 0, -0.45);

        // 2 Micro-Platforms inside the Cyber-Vault
        const shelfLeftX = -vw * 0.26;
        const shelfLeftY = -vh * 0.12;
        const shelfRightX = vw * 0.26;
        const shelfRightY = vh * 0.08;

        const microShelfL = new THREE.Mesh(microShelfGeo, innerShelfMat);
        microShelfL.position.set(shelfLeftX, shelfLeftY, 0);
        const microShelfR = new THREE.Mesh(microShelfGeo, innerShelfMat);
        microShelfR.position.set(shelfRightX, shelfRightY, 0);

        // Exit Gate Beacon on lower-right floor of vault
        const exitLocalX = vw * 0.32;
        const exitLocalY = -vh * 0.5 + wallThick + 0.32;
        const exitBeaconMesh = new THREE.Mesh(exitRingGeo, exitBeaconMat);
        exitBeaconMesh.position.set(exitLocalX, exitLocalY, 0.22);
        exitBeaconMesh.renderOrder = RENDER_ORDER.ADDITIVE_VFX_LIGHTNING;

        // Central Vault Data Core Reactor
        const coreGroup = new THREE.Group();
        coreGroup.position.set(0, 0.05, -0.1);
        const coreMesh = new THREE.Mesh(coreGeo, coreMat);
        const coreGyroRing = new THREE.Mesh(coreRingGeo, coreRingMat);
        coreGroup.add(coreMesh, coreGyroRing);

        // 3 Collectible Data Orbs inside vault
        const orbOffsets: Array<[number, number]> = [
          [shelfLeftX, shelfLeftY + 0.35],
          [0, vh * 0.3],
          [shelfRightX, shelfRightY + 0.35],
        ];
        const orbs: DataOrbPickup[] = [];
        for (let k = 0; k < orbOffsets.length; k++) {
          const [ox, oy] = orbOffsets[k];
          const orbMesh = new THREE.Mesh(orbGeo, orbMat);
          orbMesh.position.set(ox, oy, 0);
          orbMesh.renderOrder = RENDER_ORDER.CHARACTER_AND_SHARDS;
          vaultGroup.add(orbMesh);
          orbs.push({
            mesh: orbMesh,
            localX: ox,
            localY: oy,
            collected: false,
            phase: k * 1.9,
          });
        }

        vaultGroup.add(
          backPlate,
          lWall,
          rWall,
          floorSlab,
          ceilSlab,
          pillarL,
          pillarR,
          microShelfL,
          microShelfR,
          exitBeaconMesh,
          coreGroup,
        );

        // Register Real Rapier Interior Colliders (CARD_INTERIOR, hidden from outside, active inside!)
        const interiorColliders: InteriorKinematicCollider[] = [];
        const addInteriorCol = (
          lx: number,
          ly: number,
          hw: number,
          hh: number,
          oneWay: boolean,
        ) => {
          const kin = physics.createKinematicPlatform(
            comp.x + lx,
            comp.y + ly,
            SPATIAL_CONSTANTS.BAND_CHAMBER_CENTER_Z,
            hw,
            hh,
            0.75,
            COLLISION_GROUP.CARD_INTERIOR,
            undefined,
            oneWay,
          );
          interiorColliders.push({
            body: kin.body,
            collider: kin.collider,
            localX: lx,
            localY: ly,
            localZ: 0,
          });
        };

        // Floor, ceiling, left wall, right wall (solid interior walls)
        addInteriorCol(0, -vh * 0.5 + wallThick * 0.5, vw * 0.5, wallThick * 0.5, false);
        addInteriorCol(0, vh * 0.5 - wallThick * 0.5, vw * 0.5, wallThick * 0.5, false);
        addInteriorCol(-vw * 0.5 + wallThick * 0.5, 0, wallThick * 0.5, vh * 0.5, false);
        addInteriorCol(vw * 0.5 - wallThick * 0.5, 0, wallThick * 0.5, vh * 0.5, false);
        // Two one-way micro stepping ledges inside vault
        addInteriorCol(shelfLeftX, shelfLeftY, vw * 0.15, 0.05, true);
        addInteriorCol(shelfRightX, shelfRightY, vw * 0.15, 0.05, true);

        const cleanTitle =
          comp.labelText.trim().slice(0, 26) || `Cyber-Vault ${vaultCount}`;
        vaultData = {
          title: cleanTitle,
          vaultGroup,
          frontDoorFrame,
          exitBeaconMesh,
          coreGroup,
          coreGyroRing,
          coreMesh,
          orbs,
          interiorColliders,
          chamberW: vw,
          chamberH: vh,
          portalHalfW,
          portalHalfH,
          exitLocalX,
          exitLocalY,
          isBreached: false,
          isCoreDestroyed: false,
        };
      }

      // Compute spaced floating target coordinates (width-weighted so wide banners stay framed!)
      const widthWeight = THREE.MathUtils.clamp(1 - halfW / 7.5, 0.12, 1.0);
      const centerJitter =
        (Math.abs(comp.x) < 1.35
          ? (i % 2 === 0 ? -1 : 1) * world.prng.range(1.6, 3.2)
          : comp.x * 0.45) * widthWeight;
      const maxCenter = Math.max(0.3, (halfW > 6.5 ? 12.4 : 13.7) - halfW);
      const initBrokenX = THREE.MathUtils.clamp(comp.x + centerJitter, -maxCenter, maxCenter);
      const rowVertStagger = isInteractiveWidget ? (i % 3) * 0.65 : 0;
      const initBrokenY = Math.min(-0.85, comp.y * 1.44 - 0.55 - rowVertStagger);

      world.islands.push({
        id: comp.id,
        group: islandGrp,
        frontCoverMesh: compMesh,
        frontWingLeft,
        frontWingRight,
        body: kinShelf.body,
        collider: kinShelf.collider,
        block,
        intactX: comp.x,
        intactY: comp.y,
        intactZ: meshZ,
        intactPhysY: physY,
        curX: comp.x,
        curY: comp.y,
        curZ: meshZ,
        brokenX: initBrokenX,
        brokenY: initBrokenY,
        brokenZ: meshZ - world.prng.range(0.06, 0.22),
        brokenPhysY: isShelf ? initBrokenY + comp.h * 0.5 - 0.05 : initBrokenY,
        brokenRotY: 0,
        brokenRotZ: world.prng.range(-0.035, 0.035) * Math.max(0.3, widthWeight),
        halfW,
        visualHalfH: comp.h * 0.5,
        hoverAmp: world.prng.range(0.06, 0.14),
        hoverFreq: world.prng.range(1.05, 1.65),
        hoverPhase: world.prng.range(0, Math.PI * 2),
        staggerDelay: 0,
        vault: vaultData,
      });
    }

    world.totalVaultCount = vaultCount;

    // -----------------------------------------------------------------------
    // 2D Box-Relaxation Solver (wide, clean air lanes between components)
    // -----------------------------------------------------------------------
    const padX = 1.15;
    const padY = 1.45;
    for (let iter = 0; iter < 8; iter++) {
      for (let i = 0; i < world.islands.length; i++) {
        for (let j = i + 1; j < world.islands.length; j++) {
          const a = world.islands[i];
          const b = world.islands[j];
          const dx = b.brokenX - a.brokenX;
          const dy = b.brokenY - a.brokenY;
          const overlapX = a.halfW + b.halfW + padX - Math.abs(dx);
          const overlapY = a.visualHalfH + b.visualHalfH + padY - Math.abs(dy);
          if (overlapX > 0 && overlapY > 0) {
            if (overlapX < overlapY * 1.15 && a.halfW + b.halfW < 18.0) {
              const pushDir = dx >= 0 ? 1 : -1;
              const shift = overlapX * 0.52;
              a.brokenX -= pushDir * shift;
              b.brokenX += pushDir * shift;
            } else {
              const pushDir = dy >= 0 ? 1 : -1;
              const shift = overlapY * 0.52;
              a.brokenY -= pushDir * shift;
              b.brokenY += pushDir * shift;
            }
            const limA = Math.max(0.3, (a.halfW > 6.5 ? 12.4 : 13.7) - a.halfW);
            const limB = Math.max(0.3, (b.halfW > 6.5 ? 12.4 : 13.7) - b.halfW);
            a.brokenX = THREE.MathUtils.clamp(a.brokenX, -limA, limA);
            b.brokenX = THREE.MathUtils.clamp(b.brokenX, -limB, limB);
            if (a.brokenY > -0.85) {
              const excess = a.brokenY - -0.85;
              a.brokenY = -0.85;
              b.brokenY -= excess;
            }
            if (b.brokenY > -0.85) {
              const excess = b.brokenY - -0.85;
              b.brokenY = -0.85;
              a.brokenY -= excess;
            }
          }
        }
      }
    }

    let lowestExpandedY = -analyzed.pageHeightM;
    for (const isl of world.islands) {
      const isShelf = isl.visualHalfH > 0.16;
      isl.brokenPhysY = isShelf ? isl.brokenY + isl.visualHalfH - 0.05 : isl.brokenY;
      lowestExpandedY = Math.min(lowestExpandedY, isl.brokenY - isl.visualHalfH);
    }
    world.expandedBottomY = Math.min(-analyzed.pageHeightM * 1.38 - 0.8, lowestExpandedY - 1.5);
    Object.assign(world, { expandedPageHeightM: Math.abs(world.expandedBottomY) });

    // -----------------------------------------------------------------------
    // Dynamic Side Rails & Page Bottom Catch Deck
    // -----------------------------------------------------------------------
    const bottomDeckGeo = new THREE.BoxGeometry(31.2, 0.6, 1.4);
    const bottomDeckMat = new THREE.MeshStandardMaterial({
      color: 0x18181f,
      roughness: 0.65,
      metalness: 0.35,
      emissive: 0x082f49,
      emissiveIntensity: 0.22,
    });
    world.geometries.push(bottomDeckGeo);
    world.materials.push(bottomDeckMat);

    const bottomMesh = new THREE.Mesh(bottomDeckGeo, bottomDeckMat);
    bottomMesh.position.set(0, world.intactBottomY, SPATIAL_CONSTANTS.BAND_PLAY_Z);
    bottomMesh.receiveShadow = true;
    world.root.add(bottomMesh);
    world.bottomDeckMesh = bottomMesh;

    const bottomKin = physics.createKinematicPlatform(
      0,
      world.intactBottomY,
      SPATIAL_CONSTANTS.BAND_PLAY_Z,
      15.6,
      0.3,
      0.75,
      COLLISION_GROUP.TERRAIN,
    );
    world.bottomDeckBody = bottomKin.body;
    world.bottomDeckCollider = bottomKin.collider;

    const sideWallH = world.expandedPageHeightM + 14.0;
    const sideWallCenterY = -world.expandedPageHeightM * 0.5 + 3.0;
    const leftKin = physics.createKinematicPlatform(
      -10.38,
      sideWallCenterY,
      SPATIAL_CONSTANTS.BAND_PLAY_Z,
      0.3,
      sideWallH * 0.5,
      0.85,
      COLLISION_GROUP.TERRAIN,
    );
    world.leftRailBody = leftKin.body;
    world.leftRailCollider = leftKin.collider;

    const rightKin = physics.createKinematicPlatform(
      10.38,
      sideWallCenterY,
      SPATIAL_CONSTANTS.BAND_PLAY_Z,
      0.3,
      sideWallH * 0.5,
      0.85,
      COLLISION_GROUP.TERRAIN,
    );
    world.rightRailBody = rightKin.body;
    world.rightRailCollider = rightKin.collider;

    // Headroom-aware Hero Spawn Selection (accounts for 1.6x Stickman height)
    const computeHeadroom = (target: LivingIslandEntry): number => {
      const targetTop = target.block.y + target.block.halfH;
      const tMinX = target.block.x - target.block.halfW * 0.5;
      const tMaxX = target.block.x + target.block.halfW * 0.5;
      let minOverhead = Infinity;
      for (const other of world.islands) {
        if (other === target) continue;
        const oTop = other.block.y + other.block.halfH;
        if (oTop <= targetTop + 0.08) continue;
        const oMinX = other.block.x - other.block.halfW;
        const oMaxX = other.block.x + other.block.halfW;
        if (oMaxX >= tMinX && oMinX <= tMaxX) {
          minOverhead = Math.min(minOverhead, oTop - targetTop);
        }
      }
      return minOverhead;
    };

    let bestSpawnIsland: LivingIslandEntry | null = null;
    for (const isl of world.islands) {
      if (isl.block.halfW < 0.75) continue;
      if (isl.block.y <= -1.2 && isl.block.y >= -6.4 && computeHeadroom(isl) >= 1.55) {
        if (!bestSpawnIsland || isl.block.y > bestSpawnIsland.block.y) {
          bestSpawnIsland = isl;
        }
      }
    }
    if (!bestSpawnIsland) {
      for (const isl of world.islands) {
        if (isl.block.halfW < 0.8) continue;
        if (computeHeadroom(isl) >= 1.55 && (!bestSpawnIsland || isl.block.y > bestSpawnIsland.block.y)) {
          bestSpawnIsland = isl;
        }
      }
    }
    if (!bestSpawnIsland) {
      for (const isl of world.islands) {
        if (isl.block.halfW >= 0.8 && (!bestSpawnIsland || isl.block.y > bestSpawnIsland.block.y)) {
          bestSpawnIsland = isl;
        }
      }
    }

    if (bestSpawnIsland) {
      world.spawnPoint.set(
        THREE.MathUtils.clamp(bestSpawnIsland.block.x, -4.5, 4.5),
        bestSpawnIsland.block.y + bestSpawnIsland.block.halfH + 0.75,
        SPATIAL_CONSTANTS.BAND_PLAY_Z,
      );
    } else {
      world.spawnPoint.set(0, world.intactBottomY + 1.2, SPATIAL_CONSTANTS.BAND_PLAY_Z);
    }

    // Rideable Right-Edge Scrollbar Rail & Elevator Carriage
    const railH = Math.max(8, world.expandedPageHeightM + 1.0);
    const railGeo = new THREE.BoxGeometry(0.22, railH, 0.32);
    const railMat = new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      roughness: 0.5,
      metalness: 0.6,
    });
    const thumbGeo = new THREE.BoxGeometry(0.92, 0.28, 1.1);
    const thumbMat = new THREE.MeshStandardMaterial({
      color: 0x06b6d4,
      emissive: 0x0891b2,
      emissiveIntensity: 0.65,
      roughness: 0.25,
      metalness: 0.75,
    });
    world.geometries.push(railGeo, thumbGeo);
    world.materials.push(railMat, thumbMat);

    const railMesh = new THREE.Mesh(railGeo, railMat);
    railMesh.position.set(
      world.scrollbarX + 0.42,
      -world.expandedPageHeightM * 0.5,
      SPATIAL_CONSTANTS.BAND_PLAY_Z,
    );
    world.root.add(railMesh);
    world.scrollbarRailMesh = railMesh;

    const thumbMesh = new THREE.Mesh(thumbGeo, thumbMat);
    world.scrollbarY = -1.2;
    thumbMesh.position.set(world.scrollbarX, world.scrollbarY, SPATIAL_CONSTANTS.BAND_PLAY_Z);
    thumbMesh.castShadow = !isSoftwareGl;
    world.root.add(thumbMesh);
    world.scrollbarThumbMesh = thumbMesh;

    const kinElevator = physics.createKinematicPlatform(
      world.scrollbarX,
      world.scrollbarY,
      SPATIAL_CONSTANTS.BAND_PLAY_Z,
      0.46,
      0.14,
      0.55,
      COLLISION_GROUP.TERRAIN,
    );
    world.scrollbarBody = kinElevator.body;
    world.scrollbarCollider = kinElevator.collider;

    return world;
  }

  update(
    cameraY: number,
    stickmanPos: THREE.Vector3,
    fixedDt: number,
    physics: PhysicsWorld,
  ): number {
    this.simTime += fixedDt;
    if (this.worldPhase === 'intact') {
      this.fractureCountdown = Math.max(0, this.fractureCountdown - fixedDt);
    } else {
      this.fractureElapsed += fixedDt;
      if (this.worldPhase === 'fracturing' && this.fractureElapsed >= 0.75) {
        this.worldPhase = 'broken_arena';
      }
    }

    // 1. Cleanly dissolve Band -2 Backdrop into pure Dark Cosmic Space on fracture
    if (this.worldPhase !== 'intact') {
      this.backdropOpacity = dampScalar(this.backdropOpacity, 0, 8.0, fixedDt);
    }
    for (let i = 0; i < this.backdropMeshes.length; i++) {
      const bm = this.backdropMeshes[i];
      bm.mat.uniforms.uOpacity.value = this.backdropOpacity;
      bm.mesh.visible = this.backdropOpacity > 0.015 && Math.abs(bm.y - cameraY) < 28.0;
    }
    if (this.outerFrameMesh && this.sideFrameMat && this.worldPhase !== 'intact') {
      this.sideFrameMat.opacity = dampScalar(this.sideFrameMat.opacity, 0, 9.0, fixedDt);
      if (this.sideFrameMat.opacity <= 0.015) {
        this.outerFrameMesh.visible = false;
      }
    }

    // 2. Animate Floating DOM Components & Sync Cyber-Vault Interior Colliders
    for (let i = 0; i < this.islands.length; i++) {
      const isl = this.islands[i];
      let curX = isl.intactX;
      let curY = isl.intactY;
      let curZ = isl.intactZ;
      let curPhysY = isl.intactPhysY;
      let curRotZ = 0;

      const occupied = this.activeVaultId === isl.id;
      if (this.worldPhase !== 'intact') {
        const localT = THREE.MathUtils.clamp(
          (this.fractureElapsed - isl.staggerDelay) / 0.68,
          0,
          1,
        );
        const springP = easeOutBackClamped(localT);
        const bobScale = occupied ? 0.12 : 1.0;
        const bobAmp = isl.hoverAmp * bobScale * THREE.MathUtils.smoothstep(localT, 0.35, 1.0);
        const bobY = Math.sin(this.fractureElapsed * isl.hoverFreq + isl.hoverPhase) * bobAmp;

        curX = THREE.MathUtils.lerp(isl.intactX, isl.brokenX, springP);
        curY = THREE.MathUtils.lerp(isl.intactY, isl.brokenY, springP) + bobY;
        curZ = THREE.MathUtils.lerp(isl.intactZ, isl.brokenZ, THREE.MathUtils.clamp(localT, 0, 1));
        curPhysY = THREE.MathUtils.lerp(isl.intactPhysY, isl.brokenPhysY, springP) + bobY;

        curRotZ = occupied
          ? 0
          : isl.brokenRotZ * THREE.MathUtils.clamp(localT, 0, 1);
      }

      isl.curX = curX;
      isl.curY = curY;
      isl.curZ = curZ;

      isl.group.position.set(curX, curY, curZ);
      isl.group.rotation.set(0, 0, curRotZ);
      isl.group.visible = Math.abs(curY - cameraY) < 26.0;

      physics.updateKinematicPlatform(
        isl.collider.handle,
        curX,
        curPhysY,
        SPATIAL_CONSTANTS.BAND_PLAY_Z,
      );

      // Sync attached Cyber-Vault animation, cutaway visibility, & Rapier interior colliders
      if (isl.vault) {
        const v = isl.vault;
        if (v.isBreached) {
          const showExteriorCutaway = !occupied;
          if (isl.frontWingLeft) isl.frontWingLeft.visible = showExteriorCutaway;
          if (isl.frontWingRight) isl.frontWingRight.visible = showExteriorCutaway;
          v.frontDoorFrame.visible = showExteriorCutaway;

          v.frontDoorFrame.rotation.z += fixedDt * 1.4;
          v.exitBeaconMesh.rotation.z -= fixedDt * 2.2;
          if (!v.isCoreDestroyed) {
            v.coreMesh.rotation.y += fixedDt * 1.8;
            v.coreMesh.rotation.x += fixedDt * 0.9;
            v.coreGyroRing.rotation.x += fixedDt * 2.4;
            v.coreGyroRing.rotation.y += fixedDt * 1.5;
          }
          for (const orb of v.orbs) {
            if (!orb.collected) {
              orb.mesh.rotation.y += fixedDt * 2.5;
              orb.mesh.position.y = orb.localY + Math.sin(this.simTime * 3.0 + orb.phase) * 0.06;
            }
          }
        }
        for (const ic of v.interiorColliders) {
          physics.updateKinematicPlatform(
            ic.collider.handle,
            curX + ic.localX,
            curY + ic.localY,
            SPATIAL_CONSTANTS.BAND_CHAMBER_CENTER_Z + ic.localZ,
          );
        }
      }
    }

    // 3. Smoothly Widen Arena Bounds & Scrollbar Elevator
    const arenaExpP =
      this.worldPhase === 'intact'
        ? 0
        : THREE.MathUtils.smoothstep(this.fractureElapsed, 0, 0.72);
    const railX = THREE.MathUtils.lerp(10.38, 14.8, arenaExpP);
    this.scrollbarX = THREE.MathUtils.lerp(9.75, 14.1, arenaExpP);
    const curBottomY = THREE.MathUtils.lerp(this.intactBottomY, this.expandedBottomY, arenaExpP);

    if (this.bottomDeckMesh && this.bottomDeckCollider) {
      this.bottomDeckMesh.position.y = curBottomY;
      physics.updateKinematicPlatform(
        this.bottomDeckCollider.handle,
        0,
        curBottomY,
        SPATIAL_CONSTANTS.BAND_PLAY_Z,
      );
    }
    const railCenterY = -this.expandedPageHeightM * 0.5 + 3.0;
    if (this.leftRailCollider) {
      physics.updateKinematicPlatform(
        this.leftRailCollider.handle,
        -railX,
        railCenterY,
        SPATIAL_CONSTANTS.BAND_PLAY_Z,
      );
    }
    if (this.rightRailCollider) {
      physics.updateKinematicPlatform(
        this.rightRailCollider.handle,
        railX,
        railCenterY,
        SPATIAL_CONSTANTS.BAND_PLAY_Z,
      );
    }

    const activeHeight = this.getActivePageHeightM();
    const minScrollY = -Math.max(4, activeHeight - 0.6);
    const maxScrollY = -0.8;
    const nearElevator =
      Math.abs(stickmanPos.x - this.scrollbarX) < 1.15 &&
      Math.abs(stickmanPos.y - 0.72 - this.scrollbarY) < 0.85;

    if (nearElevator) {
      this.scrollbarY += this.scrollbarDir * 2.6 * fixedDt;
      if (this.scrollbarY <= minScrollY) {
        this.scrollbarY = minScrollY;
        this.scrollbarDir = 1;
      } else if (this.scrollbarY >= maxScrollY) {
        this.scrollbarY = maxScrollY;
        this.scrollbarDir = -1;
      }
    } else {
      const targetThumbY = THREE.MathUtils.clamp(stickmanPos.y - 0.6, minScrollY, maxScrollY);
      this.scrollbarY = THREE.MathUtils.lerp(
        this.scrollbarY,
        targetThumbY,
        1 - Math.exp(-3.5 * fixedDt),
      );
    }

    if (this.scrollbarRailMesh) {
      this.scrollbarRailMesh.position.x = this.scrollbarX + 0.42;
    }
    if (this.scrollbarThumbMesh && this.scrollbarCollider) {
      this.scrollbarThumbMesh.position.set(
        this.scrollbarX,
        this.scrollbarY,
        SPATIAL_CONSTANTS.BAND_PLAY_Z,
      );
      physics.updateKinematicPlatform(
        this.scrollbarCollider.handle,
        this.scrollbarX,
        this.scrollbarY,
        SPATIAL_CONSTANTS.BAND_PLAY_Z,
      );
    }

    const span = Math.max(1, activeHeight);
    return THREE.MathUtils.clamp(-stickmanPos.y / span, 0, 1);
  }

  dispose(physics: PhysicsWorld | null): void {
    if (physics) {
      for (const isl of this.islands) {
        physics.removeDynamicOrKinematicBody(isl.body, isl.collider);
        if (isl.vault) {
          for (const ic of isl.vault.interiorColliders) {
            physics.removeDynamicOrKinematicBody(ic.body, ic.collider);
          }
        }
      }
      if (this.bottomDeckBody && this.bottomDeckCollider) {
        physics.removeDynamicOrKinematicBody(this.bottomDeckBody, this.bottomDeckCollider);
      }
      if (this.leftRailBody && this.leftRailCollider) {
        physics.removeDynamicOrKinematicBody(this.leftRailBody, this.leftRailCollider);
      }
      if (this.rightRailBody && this.rightRailCollider) {
        physics.removeDynamicOrKinematicBody(this.rightRailBody, this.rightRailCollider);
      }
      if (this.scrollbarBody && this.scrollbarCollider) {
        physics.removeDynamicOrKinematicBody(this.scrollbarBody, this.scrollbarCollider);
      }
    }
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    for (const t of this.textures) t.dispose();
  }
}
