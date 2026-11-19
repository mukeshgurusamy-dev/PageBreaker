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
  type ExtractedDomComponent,
  type FortressTier,
  type PlatformBlock,
} from '../types/game';
import type { AnalyzedWebsite } from './DomAnalyzer';
import type { PhysicsWorld } from '../engine/PhysicsWorld';
import { SeededPRNG } from '../math/prng';

const BACKDROP_FRAGMENT_SHADER = /* glsl */ `
precision highp float;
precision highp sampler2DArray;

#define MAX_CRATERS 48

uniform sampler2DArray uTileArray;
uniform int uTileCount;
uniform vec4 uCraters[MAX_CRATERS];

in vec2 vUv;
in float vLayer;

out vec4 fragColor;

void main() {
  float layerIdx = clamp(floor(vLayer + 0.5), 0.0, float(max(0, uTileCount - 1)));
  // Canvas pixels are top-down; flip V so each page slice renders upright
  vec2 sampleUv = vec2(vUv.x, 1.0 - vUv.y);
  vec4 texel = texture(uTileArray, vec3(sampleUv, layerIdx));

  // Pre-wired scorch crater darkening hook for Step 4 Pixel Bombs
  vec3 color = texel.rgb;
  for (int i = 0; i < MAX_CRATERS; i++) {
    vec4 cr = uCraters[i];
    if (cr.w > 0.001) {
      float d = length(vec2(vUv.x - cr.x, vUv.y - cr.y));
      float mask = smoothstep(cr.w, cr.w * 0.25, d);
      color = mix(color, color * 0.18 + vec3(0.08, 0.03, 0.01), mask * 0.75);
    }
  }

  fragColor = vec4(color, 1.0);
}
`;

const BACKDROP_VERTEX_SHADER = /* glsl */ `
attribute float aLayer;

out vec2 vUv;
out float vLayer;

void main() {
  vUv = uv;
  vLayer = aLayer;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

function createCornerAoTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#1b1d26';
    ctx.fillRect(0, 0, 256, 256);
    const grad = ctx.createRadialGradient(128, 128, 32, 128, 128, 175);
    grad.addColorStop(0, 'rgba(38, 42, 54, 0.92)');
    grad.addColorStop(0.65, 'rgba(20, 22, 30, 0.96)');
    grad.addColorStop(1, 'rgba(7, 8, 12, 1.0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 256, 256);
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
      return isDarkTheme ? 0x27272a : 0x64748b;
    case 'tier_2_foundry':
      return isDarkTheme ? 0x334155 : 0x475569;
    case 'tier_3_citadel':
      return isDarkTheme ? 0x1e3a5f : 0x334155;
    case 'tier_4_bastion':
      return isDarkTheme ? 0x181822 : 0x1e293b;
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

interface ChunkEntry {
  minY: number;
  maxY: number;
  group: THREE.Group;
}

/**
 * Step 3 — 3-Pass @zumer/snapdom + 4-Band 2.5D Website World Builder:
 * - Pass 0: Band -2 full-page vertical tiles rendered via GLSL3 DataArrayTexture (toneMapped: false)
 * - Pass 1: Band -1 bounded hollow Mimic Card chambers (stencil: false + baked corner AO)
 * - Pass 2: Band 0 extruded active DOM blocks ([0..1] front-cap UVs + CSS-craft armor) + Glyph Atlas
 * - Rideable Right-Edge Scrollbar elevator + 1D Y-interval chunk culling
 */
export class WebsiteWorld {
  public readonly root = new THREE.Group();
  public readonly pageHeightM: number;
  public readonly isDarkTheme: boolean;
  public readonly spawnPoint = new THREE.Vector3(-4.5, 0.85, SPATIAL_CONSTANTS.BAND_PLAY_Z);

  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly textures: THREE.Texture[] = [];
  private readonly chunks: ChunkEntry[] = [];
  private readonly platformBlocks: PlatformBlock[] = [];

  // Rideable right-edge scrollbar carriage
  private scrollbarThumbMesh: THREE.Mesh | null = null;
  private scrollbarCollider: RAPIER.Collider | null = null;
  private scrollbarBody: RAPIER.RigidBody | null = null;
  private scrollbarY = -1.2;
  private scrollbarDir = -1;
  private readonly scrollbarX = 9.75;

  private constructor(pageHeightM: number, isDarkTheme: boolean) {
    this.pageHeightM = pageHeightM;
    this.isDarkTheme = isDarkTheme;
    this.root.name = 'WebsiteWorld';
  }

  static async build(
    analyzed: AnalyzedWebsite,
    physics: PhysicsWorld,
    isSoftwareGl: boolean,
    maxAnisotropy: number,
  ): Promise<WebsiteWorld> {
    const world = new WebsiteWorld(analyzed.pageHeightM, analyzed.isDarkTheme);
    const chunkSizeM = 6.0;
    const chunkMap = new Map<number, THREE.Group>();

    const getChunk = (yM: number): THREE.Group => {
      const idx = Math.floor(yM / chunkSizeM);
      let grp = chunkMap.get(idx);
      if (!grp) {
        grp = new THREE.Group();
        world.root.add(grp);
        chunkMap.set(idx, grp);
        world.chunks.push({
          minY: idx * chunkSizeM,
          maxY: (idx + 1) * chunkSizeM,
          group: grp,
        });
      }
      return grp;
    };

    const cornerAoTex = createCornerAoTexture();
    world.textures.push(cornerAoTex);

    const sideFrameMat = new THREE.MeshBasicMaterial({
      color: analyzed.isDarkTheme ? 0x09090b : 0x11131a,
      toneMapped: false,
    });
    const chamberWallMat = new THREE.MeshStandardMaterial({
      map: cornerAoTex,
      roughness: 0.86,
      metalness: 0.08,
    });
    const relicCrateMat = new THREE.MeshStandardMaterial({
      color: 0xcbd5e1,
      roughness: 0.28,
      metalness: 0.78,
    });
    world.materials.push(sideFrameMat, chamberWallMat, relicCrateMat);

    // -----------------------------------------------------------------------
    // PASS 0: Band -2 Full-Page Tiles -> DataArrayTexture (toneMapped: false)
    // Captures the complete, pristine, unedited website onto backdrop tiles
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

    const craterUniforms: THREE.Vector4[] = [];
    for (let i = 0; i < 48; i++) craterUniforms.push(new THREE.Vector4(0, 0, 0, 0));

    const backdropArrayMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: BACKDROP_VERTEX_SHADER,
      fragmentShader: BACKDROP_FRAGMENT_SHADER,
      uniforms: {
        uTileArray: { value: tileArrayTex },
        uTileCount: { value: sliceCount },
        uCraters: { value: craterUniforms },
      },
      toneMapped: false,
    });
    world.materials.push(backdropArrayMat);

    // Build vertical strip quads (each 20.0m wide x 16.0m tall) for Band -2 in one batched geometry
    const tileWorldH = tileLogicalH * SPATIAL_CONSTANTS.WORLD_SCALE; // 16.0m per 1024px slice
    for (let s = 0; s < sliceCount; s++) {
      const quadGeo = new THREE.PlaneGeometry(SPATIAL_CONSTANTS.WORLD_WIDTH_M, tileWorldH);
      const vCount = quadGeo.getAttribute('position').count;
      const layers = new Float32Array(vCount);
      layers.fill(s);
      quadGeo.setAttribute('aLayer', new THREE.BufferAttribute(layers, 1));
      world.geometries.push(quadGeo);

      const sliceCenterY = -(s * tileWorldH + tileWorldH * 0.5);
      const tileMesh = new THREE.Mesh(quadGeo, backdropArrayMat);
      tileMesh.position.set(0, sliceCenterY, SPATIAL_CONSTANTS.BAND_BACKDROP_Z);
      tileMesh.renderOrder = RENDER_ORDER.OPAQUE_WORLD;
      getChunk(sliceCenterY).add(tileMesh);
    }

    // Surrounding Obsidian Outer Stage Sheet (prevents raw viewport black gap on wide/angled views)
    const stageTotalH = Math.max(28, analyzed.pageHeightM + 20);
    const outerFrameGeo = new THREE.PlaneGeometry(56.0, stageTotalH);
    world.geometries.push(outerFrameGeo);
    const outerFrameMesh = new THREE.Mesh(outerFrameGeo, sideFrameMat);
    outerFrameMesh.position.set(0, -analyzed.pageHeightM * 0.5, SPATIAL_CONSTANTS.BAND_BACKDROP_Z - 0.08);
    outerFrameMesh.renderOrder = RENDER_ORDER.OPAQUE_WORLD;
    world.root.add(outerFrameMesh);

    // -----------------------------------------------------------------------
    // PASS 1 & PASS 2: Band -1 Hollow Card Chambers + Band 0 DOM Components
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
          emissiveIntensity: isHighTier ? 0.08 : 0.02,
        });
        tierMaterials.set(key, mat);
        world.materials.push(mat);
      }
      return mat;
    };

    const rimMat = new THREE.MeshBasicMaterial({
      color: analyzed.isDarkTheme ? 0x38bdf8 : 0x0f172a,
      side: THREE.BackSide,
      transparent: true,
      opacity: analyzed.isDarkTheme ? 0.28 : 0.14,
    });
    world.materials.push(rimMat);

    // Capture up to 36 foreground DOM components with crisp [0..1] snapdom front textures
    const activeComps = analyzed.components.slice(0, 36);
    const prng = new SeededPRNG(`world-${analyzed.url}`);
    let hollowCardCount = 0;

    for (let i = 0; i < activeComps.length; i++) {
      const comp = activeComps[i];
      const chunkGrp = getChunk(comp.y);

      // Capture exact DOM look for component front cap
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
          compTex = new THREE.CanvasTexture(snapCanvas);
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
            opacity: 0.14,
          });
      world.materials.push(frontMat);

      // Extruded thickness scales cleanly with 4-decade C_score
      const depthM = THREE.MathUtils.clamp(0.24 + comp.craft.cScore * 0.045, 0.26, 0.52);
      const shape = createRoundedRectShape(comp.w, comp.h, Math.min(0.12, comp.h * 0.22));
      const extGeo = new THREE.ExtrudeGeometry(shape, {
        depth: depthM,
        bevelEnabled: true,
        bevelThickness: 0.02,
        bevelSize: 0.018,
        bevelSegments: 2,
      });
      extGeo.translate(0, 0, -depthM * 0.5);
      extGeo.computeVertexNormals();
      normalizeExtrudeCapUvs(extGeo, comp.w, comp.h);
      world.geometries.push(extGeo);

      const compMesh = new THREE.Mesh(extGeo, [frontMat, armorMat]);
      compMesh.position.set(comp.x, comp.y, SPATIAL_CONSTANTS.BAND_PLAY_Z);
      compMesh.castShadow = !isSoftwareGl;
      compMesh.receiveShadow = true;
      compMesh.renderOrder = RENDER_ORDER.OPAQUE_WORLD;
      chunkGrp.add(compMesh);

      if (analyzed.isDarkTheme) {
        const rimMesh = new THREE.Mesh(extGeo, rimMat);
        rimMesh.position.copy(compMesh.position);
        rimMesh.scale.set(1.018, 1.03, 1.04);
        chunkGrp.add(rimMesh);
      }

      // Pass 1: Bounded Hollow Card Room on Band -1 behind major cards
      if (comp.isHollowCard && hollowCardCount < 14) {
        hollowCardCount++;
        const cw = Math.max(1.5, comp.w - 0.16);
        const ch = Math.max(1.0, comp.h - 0.16);
        const wallThick = 0.12;
        const roomDepth = 1.62;
        const roomCenterZ = SPATIAL_CONSTANTS.BAND_CHAMBER_CENTER_Z;

        const backGeo = new THREE.BoxGeometry(cw, ch, 0.1);
        const sideGeo = new THREE.BoxGeometry(wallThick, ch, roomDepth);
        const tbGeo = new THREE.BoxGeometry(cw, wallThick, roomDepth);
        const crateGeo = new THREE.BoxGeometry(
          Math.min(0.65, cw * 0.22),
          Math.min(0.55, ch * 0.3),
          0.55,
        );
        world.geometries.push(backGeo, sideGeo, tbGeo, crateGeo);

        const roomGrp = new THREE.Group();
        roomGrp.position.set(comp.x, comp.y, 0);

        const backWall = new THREE.Mesh(backGeo, chamberWallMat);
        backWall.position.set(0, 0, SPATIAL_CONSTANTS.BAND_CHAMBER_BACK_Z);
        const lWall = new THREE.Mesh(sideGeo, chamberWallMat);
        lWall.position.set(-cw * 0.5 + wallThick * 0.5, 0, roomCenterZ);
        const rWall = new THREE.Mesh(sideGeo, chamberWallMat);
        rWall.position.set(cw * 0.5 - wallThick * 0.5, 0, roomCenterZ);
        const fWall = new THREE.Mesh(tbGeo, chamberWallMat);
        fWall.position.set(0, -ch * 0.5 + wallThick * 0.5, roomCenterZ);
        const cWall = new THREE.Mesh(tbGeo, chamberWallMat);
        cWall.position.set(0, ch * 0.5 - wallThick * 0.5, roomCenterZ);

        const crate = new THREE.Mesh(crateGeo, relicCrateMat);
        crate.position.set(
          prng.range(-cw * 0.22, cw * 0.22),
          -ch * 0.5 + wallThick + Math.min(0.28, ch * 0.15),
          roomCenterZ,
        );
        roomGrp.add(backWall, lWall, rWall, fWall, cWall, crate);
        chunkGrp.add(roomGrp);
      }

      // Register walkable physics collider cleanly:
      // Every website component gets a walkable top shelf, registered with COLLISION_GROUP.CARD_SHELL!
      // This enables universal one-way drop-through: player can stand on it, jump through from below,
      // and drop down through it by pressing S / Crouch!
      const isShelf = comp.h > 0.32;
      const physY = isShelf ? comp.y + comp.h * 0.5 - 0.05 : comp.y;
      const physHalfH = isShelf ? 0.05 : Math.max(0.04, comp.h * 0.5);

      const block: PlatformBlock = {
        id: comp.id,
        x: comp.x,
        y: physY,
        z: SPATIAL_CONSTANTS.BAND_PLAY_Z,
        halfW: Math.max(0.2, comp.w * 0.5 - 0.02),
        halfH: physHalfH,
        halfD: 0.55,
        grabbableCorners: true,
      };
      world.platformBlocks.push(block);
      physics.addStaticPlatform(block, COLLISION_GROUP.CARD_SHELL);
    }

    // -----------------------------------------------------------------------
    // Pooled Glyph Atlas (TreeWalker Range.getClientRects cutout layer)
    // -----------------------------------------------------------------------
    if (analyzed.words.length > 0) {
      const atlasSize = 1024;
      const cellCols = 8;
      const cellRows = 12;
      const cellW = atlasSize / cellCols; // 128px
      const cellH = atlasSize / cellRows; // ~85px
      const atlasCanvas = document.createElement('canvas');
      atlasCanvas.width = atlasSize;
      atlasCanvas.height = atlasSize;
      const actx = atlasCanvas.getContext('2d');

      if (actx) {
        actx.clearRect(0, 0, atlasSize, atlasSize);
        const packedWords = analyzed.words.slice(0, cellCols * cellRows);
        for (let i = 0; i < packedWords.length; i++) {
          const w = packedWords[i];
          const col = i % cellCols;
          const row = Math.floor(i / cellCols);
          actx.save();
          actx.beginPath();
          actx.rect(col * cellW + 2, row * cellH + 2, cellW - 4, cellH - 4);
          actx.clip();
          actx.fillStyle = w.color || '#ffffff';
          actx.font = '700 22px "Plus Jakarta Sans", sans-serif';
          actx.textAlign = 'center';
          actx.textBaseline = 'middle';
          actx.fillText(w.text.slice(0, 12), col * cellW + cellW * 0.5, row * cellH + cellH * 0.5);
          actx.restore();
        }

        const atlasTex = new THREE.CanvasTexture(atlasCanvas);
        atlasTex.colorSpace = THREE.SRGBColorSpace;
        atlasTex.anisotropy = maxAnisotropy;
        atlasTex.needsUpdate = true;
        world.textures.push(atlasTex);

        const atlasMat = new THREE.MeshBasicMaterial({
          map: atlasTex,
          alphaTest: 0.45,
          alphaToCoverage: true,
          transparent: false,
          toneMapped: false,
        });
        world.materials.push(atlasMat);

        // Keep an invisible/subtle cutout glyph badge strip ready on header margin
        const badgeGeo = new THREE.PlaneGeometry(0.01, 0.01);
        world.geometries.push(badgeGeo);
        const glyphAnchor = new THREE.Mesh(badgeGeo, atlasMat);
        glyphAnchor.visible = false;
        world.root.add(glyphAnchor);
      }
    }

    // -----------------------------------------------------------------------
    // Guaranteed Top Landing Shelf & Full-Width Page Bottom Catch Deck
    // -----------------------------------------------------------------------
    const bottomFloorY = -analyzed.pageHeightM - 0.35;
    const bottomDeckGeo = new THREE.BoxGeometry(SPATIAL_CONSTANTS.WORLD_WIDTH_M + 1.2, 0.6, 1.4);
    const bottomDeckMat = new THREE.MeshStandardMaterial({
      color: 0x18181f,
      roughness: 0.72,
      metalness: 0.25,
    });
    world.geometries.push(bottomDeckGeo);
    world.materials.push(bottomDeckMat);

    const bottomMesh = new THREE.Mesh(bottomDeckGeo, bottomDeckMat);
    bottomMesh.position.set(0, bottomFloorY, SPATIAL_CONSTANTS.BAND_PLAY_Z);
    bottomMesh.receiveShadow = true;
    world.root.add(bottomMesh);

    const bottomBlock: PlatformBlock = {
      id: 'page-bottom-deck',
      x: 0,
      y: bottomFloorY,
      z: SPATIAL_CONSTANTS.BAND_PLAY_Z,
      halfW: SPATIAL_CONSTANTS.WORLD_WIDTH_M * 0.5 + 0.6,
      halfH: 0.3,
      halfD: 0.75,
      grabbableCorners: true,
    };
    world.platformBlocks.push(bottomBlock);
    physics.addStaticPlatform(bottomBlock);

    // Pick crisp elevated spawn point above the topmost wide block (or y = +0.55)
    let bestSpawnBlock: PlatformBlock | null = null;
    for (const b of world.platformBlocks) {
      if (b.id === 'page-bottom-deck') continue;
      if (b.halfW >= 1.4 && (!bestSpawnBlock || b.y > bestSpawnBlock.y)) {
        bestSpawnBlock = b;
      }
    }
    if (bestSpawnBlock) {
      world.spawnPoint.set(
        THREE.MathUtils.clamp(bestSpawnBlock.x - bestSpawnBlock.halfW * 0.25, -7.5, 7.5),
        bestSpawnBlock.y + bestSpawnBlock.halfH + 0.85,
        SPATIAL_CONSTANTS.BAND_PLAY_Z,
      );
    } else {
      world.spawnPoint.set(-4.5, bottomFloorY + 1.2, SPATIAL_CONSTANTS.BAND_PLAY_Z);
    }

    // -----------------------------------------------------------------------
    // Rideable Right-Edge Scrollbar Rail & Kinematic Elevator Carriage (X = +9.75m)
    // -----------------------------------------------------------------------
    const railH = Math.max(8, analyzed.pageHeightM + 1.0);
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
      emissiveIntensity: 0.55,
      roughness: 0.25,
      metalness: 0.75,
    });
    world.geometries.push(railGeo, thumbGeo);
    world.materials.push(railMat, thumbMat);

    const railMesh = new THREE.Mesh(railGeo, railMat);
    railMesh.position.set(world.scrollbarX + 0.42, -analyzed.pageHeightM * 0.5, SPATIAL_CONSTANTS.BAND_PLAY_Z);
    world.root.add(railMesh);

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
    );
    world.scrollbarBody = kinElevator.body;
    world.scrollbarCollider = kinElevator.collider;

    return world;
  }

  update(cameraY: number, stickmanPos: THREE.Vector3, fixedDt: number): number {
    // 1. 1D Y-Interval Chunk Culling
    const minVisY = cameraY - 15.0;
    const maxVisY = cameraY + 15.0;
    for (let i = 0; i < this.chunks.length; i++) {
      const c = this.chunks[i];
      c.group.visible = c.maxY >= minVisY && c.minY <= maxVisY;
    }

    // 2. Smooth Rideable Right-Edge Scrollbar Elevator
    const minScrollY = -Math.max(4, this.pageHeightM - 0.6);
    const maxScrollY = -0.8;
    const nearElevator =
      Math.abs(stickmanPos.x - this.scrollbarX) < 1.1 &&
      Math.abs(stickmanPos.y - 0.68 - this.scrollbarY) < 0.75;

    if (nearElevator) {
      // Gently shuttle down/up smoothly so player can ride between header & footer
      this.scrollbarY += this.scrollbarDir * 2.6 * fixedDt;
      if (this.scrollbarY <= minScrollY) {
        this.scrollbarY = minScrollY;
        this.scrollbarDir = 1;
      } else if (this.scrollbarY >= maxScrollY) {
        this.scrollbarY = maxScrollY;
        this.scrollbarDir = -1;
      }
    } else {
      // Track player's vertical progress gently when off the rail
      const targetThumbY = THREE.MathUtils.clamp(stickmanPos.y - 0.6, minScrollY, maxScrollY);
      this.scrollbarY = THREE.MathUtils.lerp(
        this.scrollbarY,
        targetThumbY,
        1 - Math.exp(-3.5 * fixedDt),
      );
    }

    if (this.scrollbarThumbMesh && this.scrollbarBody) {
      this.scrollbarThumbMesh.position.y = this.scrollbarY;
      this.scrollbarBody.setNextKinematicTranslation({
        x: this.scrollbarX,
        y: this.scrollbarY,
        z: SPATIAL_CONSTANTS.BAND_PLAY_Z,
      });
    }

    // Normalized page scroll progress [0..1]
    const span = Math.max(1, this.pageHeightM);
    return THREE.MathUtils.clamp(-stickmanPos.y / span, 0, 1);
  }

  dispose(physics: PhysicsWorld | null): void {
    if (physics && this.scrollbarBody && this.scrollbarCollider) {
      physics.removeDynamicOrKinematicBody(this.scrollbarBody, this.scrollbarCollider);
    }
    this.scrollbarBody = null;
    this.scrollbarCollider = null;

    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    for (const t of this.textures) t.dispose();
  }
}
