/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/** Canonical 4-Band 2.5D spatial layout constants (meters, right-handed Y-up) */
export const SPATIAL_CONSTANTS = {
  /** 1280px logical CSS layout width equals 20.0 meters in Three.js world space */
  DOM_VIEWPORT_WIDTH_PX: 1280,
  WORLD_WIDTH_M: 20.0,
  WORLD_SCALE: 1 / 64,

  /** Band -2: Static full-page backdrop tiles + scorch decals */
  BAND_BACKDROP_Z: -2.0,

  /** Band -1: Bounded hollow Mimic Card interior chambers (stencil-free) */
  BAND_CHAMBER_BACK_Z: -1.65,
  BAND_CHAMBER_CENTER_Z: -1.05,
  BAND_CHAMBER_FRONT_Z: 0.05,

  /** Band 0: Primary locked 2.5D combat & parkour plane */
  BAND_PLAY_Z: 0.25,

  /** Band +1: Browser Overlords (Giant Rogue Cursor & Cookie Cages) */
  BAND_FOREGROUND_MIN_Z: 0.9,
  BAND_FOREGROUND_MAX_Z: 1.6,

  /** Fixed physics & visual loop budgets */
  FIXED_DT: 1 / 60,
  MAX_FRAME_DT: 0.25,
  POINT_LIGHT_POOL_SIZE: 4,
} as const;

/** Deterministic 6-stage renderOrder contract to avoid Z-fighting & sort artifacts */
export const RENDER_ORDER = {
  OPAQUE_WORLD: 0,
  CUTOUT_GLYPHS_SVG: 1,
  CHARACTER_AND_SHARDS: 2,
  SHADOW_AND_CRATERS: 3,
  TRANSLUCENT_FROST_DITHER: 4,
  ADDITIVE_VFX_LIGHTNING: 5,
} as const;

/** Rapier 16-bit collision bitmasks (upper 16 bits = membership, lower 16 = filter) */
export const COLLISION_GROUP = {
  PLAYER: 0x0001,
  TERRAIN: 0x0002,
  CARD_SHELL: 0x0004,
  CARD_INTERIOR: 0x0008,
  ENEMY: 0x0010,
  PROJECTILE: 0x0020,
  DEBRIS: 0x0040,
  GRAPPLE: 0x0080,
} as const;

export type StickmanParkourState =
  | 'idle'
  | 'run'
  | 'jump_rise'
  | 'apex_hang'
  | 'fast_fall'
  | 'wall_slide'
  | 'crouch_slide'
  | 'shoulder_roll'
  | 'ledge_swing'
  | 'ragdoll'
  | 'kip_up';

export interface PlatformBlock {
  id: string;
  x: number;
  y: number;
  z: number;
  halfW: number;
  halfH: number;
  halfD: number;
  grabbableCorners?: boolean;
}

export type WeaponId =
  | 'martial'
  | 'katana'
  | 'rifle'
  | 'freeze'
  | 'hydro'
  | 'bombs';

export type GadgetId = 'grapple' | 'clone' | 'grab' | 'overdrive';

export type ClanId =
  | 'typography'
  | 'card'
  | 'media'
  | 'button_nav'
  | 'form'
  | 'browser_overlord'
  | 'footer_core';

export type FortressTier =
  | 'tier_1_outpost'
  | 'tier_2_foundry'
  | 'tier_3_citadel'
  | 'tier_4_bastion';

export type EscalationPhase =
  | 'CALM_EXPLORE'
  | 'BUILD_UP'
  | 'SUSTAIN_PEAK'
  | 'RELAX';

export type CameraViewMode = 'side_25d' | 'angled_3d';

export interface RendererCapabilities {
  isSoftwareGl: boolean;
  rendererName: string;
  maxAnisotropy: number;
  hasParallelShaderCompile: boolean;
  hasMultiDraw: boolean;
  shaderWarmupMs: number;
  contextLost: boolean;
}

export type WorldMode = 'arena' | 'website';
export type SiteLoadStatus = 'idle' | 'fetching' | 'analyzing' | 'baking' | 'ready' | 'error';
export type ShowcaseEraId = '1998-retro' | '2016-portal' | '2026-bastion';

export interface CssCraftBreakdown {
  shadows: number;
  hasGlass: boolean;
  hasGradient: boolean;
  borderStrength: number;
  fontWeightNorm: number;
  descendantComplexity: number;
  modernSignals: number;
  cScore: number;
}

export interface ExtractedWordBox {
  id: string;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  fontCss: string;
}

export interface ExtractedDomComponent {
  id: string;
  tagName: string;
  clanId: ClanId;
  x: number;
  y: number;
  w: number;
  h: number;
  pxLeft: number;
  pxTop: number;
  pxWidth: number;
  pxHeight: number;
  craft: CssCraftBreakdown;
  tier: FortressTier;
  isHollowCard: boolean;
  isStickyNav: boolean;
  accentColor: string;
  labelText: string;
  words: ExtractedWordBox[];
  element: HTMLElement;
}

export interface HudSnapshot {
  stepReady: number;
  modeLabel: string;
  worldMode: WorldMode;
  fps: number;
  frameTimeMs: number;
  drawCalls: number;
  cameraMode: CameraViewMode;
  activeLightPulses: number;
  zenMode: boolean;
  webglSupported: boolean;
  capabilities: RendererCapabilities;

  /** Step 2 Stickman parkour & lives telemetry */
  parkourState: StickmanParkourState;
  stickmanSpeed: number;
  integrityLives: number;
  maxIntegrityLives: number;
  stickmanHp: number;
  maxStickmanHp: number;
  overdriveCharge: number;

  /** Step 3 Website Capture & 4-Decade Craft Telemetry */
  siteStatus: SiteLoadStatus;
  siteError: string | null;
  siteUrl: string;
  siteTitle: string;
  fortressTier: FortressTier | null;
  meanCraftScore: number;
  isDarkTheme: boolean;
  pageHeightM: number;
  scrollProgress: number;
  totalComponents: number;
  spaRecovered: boolean;

  /** Forward-compatible combat HUD state populated in Steps 4-6 */
  activeWeapon: WeaponId;
  escalationPhase: EscalationPhase;
  awakenedCount: number;
}

