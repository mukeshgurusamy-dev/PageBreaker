/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  COLLISION_GROUP,
  RENDER_ORDER,
  SPATIAL_CONSTANTS,
  type StickmanParkourState,
} from '../types/game';
import {
  computeVolumePreservingScale,
  solveTwoBoneIK,
  solveVerletChain,
} from '../math/kinematics';
import { SecondOrderSpring, dampScalar } from '../math/springs';
import { PhysicsWorld, packInteractionGroups } from './PhysicsWorld';

export interface StickmanInputState {
  left: boolean;
  right: boolean;
  jumpHeld: boolean;
  jumpPressedThisFrame: boolean;
  crouchHeld: boolean;
  grabHeld: boolean;
  aimWorldX: number;
  aimWorldY: number;
}

export interface StickmanStepResult {
  state: StickmanParkourState;
  grounded: boolean;
  speed: number;
  isFlying: boolean;
  isShrunk: boolean;
  scale: number;
  integrityLives: number;
  impactStrength: number;
  lostLifeToVoid: boolean;
}

function createBlobShadowTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const grad = ctx.createRadialGradient(64, 64, 4, 64, 64, 60);
    grad.addColorStop(0, 'rgba(0, 0, 0, 0.72)');
    grad.addColorStop(0.55, 'rgba(0, 0, 0, 0.34)');
    grad.addColorStop(1, 'rgba(0, 0, 0, 0.0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 128, 128);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createHeroAuraTexture(mode: 'glow' | 'contrast'): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const grad = ctx.createRadialGradient(64, 64, 4, 64, 64, 62);
    if (mode === 'glow') {
      grad.addColorStop(0.0, 'rgba(245, 158, 11, 0.85)');
      grad.addColorStop(0.38, 'rgba(6, 182, 212, 0.58)');
      grad.addColorStop(0.72, 'rgba(56, 189, 248, 0.16)');
      grad.addColorStop(1.0, 'rgba(6, 182, 212, 0.0)');
    } else {
      grad.addColorStop(0.0, 'rgba(6, 8, 14, 0.62)');
      grad.addColorStop(0.55, 'rgba(6, 8, 14, 0.28)');
      grad.addColorStop(1.0, 'rgba(6, 8, 14, 0.0)');
    }
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 128, 128);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function applyFresnelRimShader(
  mat: THREE.MeshStandardMaterial,
  rimColorHex: number,
  rimStrength: number,
  rimPower: number,
): void {
  const rimColor = new THREE.Color(rimColorHex);
  mat.customProgramCacheKey = () => 'stickman-fresnel-rim-v1';
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uRimColor = { value: rimColor };
    shader.uniforms.uRimStrength = { value: rimStrength };
    shader.uniforms.uRimPower = { value: rimPower };

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform vec3 uRimColor;
uniform float uRimStrength;
uniform float uRimPower;`,
      )
      .replace(
        '#include <opaque_fragment>',
        `vec3 pbViewDir = normalize( vViewPosition );
float pbFresnel = pow( 1.0 - clamp( abs( dot( normalize( normal ), pbViewDir ) ), 0.0, 1.0 ), uRimPower );
outgoingLight += uRimColor * ( pbFresnel * uRimStrength );
#include <opaque_fragment>`,
      );
  };
}

/**
 * 16-Part Procedural 3D Stickman Hero Rig (Milestone 3C):
 * - ~1.6x heroic base proportions (~1.48m tall) with smooth auto-shrinking (0.38x)
 *   when diving inside breached Cyber-Vault component chambers.
 * - Double-tap or hold Jump free 360° flight + unlimited air jumps + auto void safety lift.
 * - Multi-ray foot-span edge support for rock-solid kinematic floating platform riding.
 * - Adaptive Fresnel rim-glow + dual contrast/cyan-amber aura for universal visibility.
 */
export class StickmanRig {
  public readonly rootGroup = new THREE.Group();
  public readonly body: RAPIER.RigidBody;
  public readonly collider: RAPIER.Collider;
  public readonly controller: RAPIER.KinematicCharacterController;

  // Exposed sockets for Step 4 weapons & gadgets
  public readonly rightHandSocket = new THREE.Group();
  public readonly leftHandSocket = new THREE.Group();
  public readonly backHolsterSocket = new THREE.Group();

  // Articulated rig hierarchy (16+ distinct meshes)
  private readonly visualCore = new THREE.Group();
  private readonly pelvisGroup = new THREE.Group();
  private readonly torsoLowerGroup = new THREE.Group();
  private readonly chestGroup = new THREE.Group();
  private readonly headGroup = new THREE.Group();
  private readonly scarfAnchor = new THREE.Group();
  private readonly eyeLeftMesh: THREE.Mesh;
  private readonly eyeRightMesh: THREE.Mesh;

  // Left & Right arm/leg capsule + joint sphere pools
  private readonly leftUpperArm: THREE.Mesh;
  private readonly leftForearm: THREE.Mesh;
  private readonly leftShoulderJoint: THREE.Mesh;
  private readonly leftElbowJoint: THREE.Mesh;

  private readonly rightUpperArm: THREE.Mesh;
  private readonly rightForearm: THREE.Mesh;
  private readonly rightShoulderJoint: THREE.Mesh;
  private readonly rightElbowJoint: THREE.Mesh;

  private readonly leftThigh: THREE.Mesh;
  private readonly leftShin: THREE.Mesh;
  private readonly leftFoot: THREE.Mesh;
  private readonly leftHipJoint: THREE.Mesh;
  private readonly leftKneeJoint: THREE.Mesh;

  private readonly rightThigh: THREE.Mesh;
  private readonly rightShin: THREE.Mesh;
  private readonly rightFoot: THREE.Mesh;
  private readonly rightHipJoint: THREE.Mesh;
  private readonly rightKneeJoint: THREE.Mesh;

  // Verlet headband scarf, radial blob shadow, additive smear, void rescue tether & aura
  private readonly scarfMesh: THREE.Mesh;
  private readonly scarfPositions: THREE.Vector3[] = [];
  private readonly scarfPrevPositions: THREE.Vector3[] = [];
  private readonly scarfSegmentCount = 8;
  private readonly blobShadowMesh: THREE.Mesh;
  private readonly auraGlowMesh: THREE.Mesh;
  private readonly auraContrastMesh: THREE.Mesh;
  private readonly smearArcMesh: THREE.Mesh;
  private readonly tetherLine: THREE.Line;
  private readonly eyeMat: THREE.MeshStandardMaterial;
  private readonly auraGlowMat: THREE.MeshBasicMaterial;
  private readonly smearMat: THREE.MeshBasicMaterial;
  private readonly shadowMat: THREE.MeshBasicMaterial;
  private readonly tetherMat: THREE.LineBasicMaterial;

  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly textures: THREE.Texture[] = [];

  // Physics, Parkour, Flight & Micro-Vault Scale State
  private readonly physics: PhysicsWorld;
  private readonly spawnPos = new THREE.Vector3(-4.5, 1.45, SPATIAL_CONSTANTS.BAND_PLAY_Z);
  private readonly lastSafePos = new THREE.Vector3(-4.5, 1.45, SPATIAL_CONSTANTS.BAND_PLAY_Z);
  private readonly currentPos = new THREE.Vector3(-4.5, 1.45, SPATIAL_CONSTANTS.BAND_PLAY_Z);
  private readonly currentVel = new THREE.Vector3();

  private state: StickmanParkourState = 'idle';
  private grounded = false;
  private groundedColliderHandle: number | null = null;
  private readonly platformDeltaScratch = { dx: 0, dy: 0 };
  private coyoteTimer = 0;
  private jumpBufferTimer = 0;
  private wallTouchDir = 0;
  private facing = 1;
  private facingYaw = -0.22;

  // Free Flight & Double-Tap / Hold Jump State
  private isFlying = false;
  private airDoubleTapTimer = 0;
  private airJumpHoldTimer = 0;

  // Quantum Micro-Scale & Vault Z-Depth Transition
  private inVault = false;
  private currentScale = 1.0;
  private targetScale = 1.0;
  private targetPlaneZ: number = SPATIAL_CONSTANTS.BAND_PLAY_Z;

  private stridePhase = 0;
  private anticipationTimer = 0;
  private pendingJumpImpulse = false;
  private rollTimer = 0;
  private rollDir = 1;
  private smearTimer = 0;
  private smearAngle = 0;

  // Ledge Pendulum State
  private ledgeAnchorX = 0;
  private ledgeAnchorY = 0;
  private ledgeRopeLen = 1.05;
  private ledgeTheta = 0;
  private ledgeOmega = 0;
  private ledgeCooldown = 0;

  // Landfall PD Active-Ragdoll State
  private ragdollTimer = 0;
  private kipUpTimer = 0;
  private readonly ragdollQuat = new THREE.Quaternion();

  // Void-Fall & Lives
  private integrityLives = 3;
  private readonly maxIntegrityLives = 3;
  private voidFloorY = -7.5;
  private tetherFlashTimer = 0;
  private readonly tetherOrigin = new THREE.Vector3();

  // One-Way Drop-Through Platform state
  private dropThroughTimer = 0;
  private crouchHoldTimer = 0;
  private dropIgnoreAboveY = Infinity;

  // Animation Springs
  private readonly squashSpring = new SecondOrderSpring(5.5, 0.58, 0.4, 1.0);
  private aimPitchRad = 0;
  private colliderCrouched = false;

  // Scratch vectors (zero-GC in 60Hz loop)
  private readonly tmpV0 = new THREE.Vector3();
  private readonly tmpV1 = new THREE.Vector3();
  private readonly tmpV2 = new THREE.Vector3();
  private readonly tmpV3 = new THREE.Vector3();
  private readonly tmpV4 = new THREE.Vector3();
  private readonly tmpV5 = new THREE.Vector3();
  private readonly tmpQ0 = new THREE.Quaternion();
  private readonly upVec = new THREE.Vector3(0, 1, 0);

  // 1.6x Heroic Base Dimensions (1.48m total height at 1.0x scale -> 0.56m at 0.38x micro-scale)
  private readonly baseCapsuleHalfHeight = 0.44;
  private readonly baseCapsuleRadius = 0.24;
  private readonly baseFootBottom = 0.68; // halfHeight + radius

  // Proportional 1.6x Limb Lengths
  private readonly thighLen = 0.34;
  private readonly shinLen = 0.34;
  private readonly upperArmLen = 0.28;
  private readonly forearmLen = 0.26;

  constructor(physics: PhysicsWorld, scene: THREE.Scene, startX = -4.5, startY = 1.45) {
    this.physics = physics;
    this.spawnPos.set(startX, startY, SPATIAL_CONSTANTS.BAND_PLAY_Z);
    this.lastSafePos.copy(this.spawnPos);
    this.currentPos.copy(this.spawnPos);

    const phys = physics.createStickmanBody(
      startX,
      startY,
      SPATIAL_CONSTANTS.BAND_PLAY_Z,
      this.baseCapsuleHalfHeight,
      this.baseCapsuleRadius,
    );
    this.body = phys.body;
    this.collider = phys.collider;
    this.controller = phys.controller;

    // Tactile PBR Materials + Adaptive View-Space Fresnel Rim Glow
    const carbonMat = new THREE.MeshStandardMaterial({
      color: 0x17181f,
      roughness: 0.72,
      metalness: 0.18,
    });
    applyFresnelRimShader(carbonMat, 0x06b6d4, 1.75, 2.0);

    const jointMat = new THREE.MeshStandardMaterial({
      color: 0xcbd5e1,
      roughness: 0.2,
      metalness: 0.86,
    });
    applyFresnelRimShader(jointMat, 0xf59e0b, 1.35, 2.3);

    const bandMat = new THREE.MeshStandardMaterial({
      color: 0xdc2626,
      roughness: 0.54,
      metalness: 0.14,
      side: THREE.DoubleSide,
    });
    applyFresnelRimShader(bandMat, 0xfb923c, 1.45, 2.1);

    const visorBackMat = new THREE.MeshStandardMaterial({
      color: 0x09090b,
      roughness: 0.22,
      metalness: 0.6,
    });
    this.eyeMat = new THREE.MeshStandardMaterial({
      color: 0xfef08a,
      emissive: 0xf59e0b,
      emissiveIntensity: 2.35,
      roughness: 0.15,
    });
    this.materials.push(carbonMat, jointMat, bandMat, visorBackMat, this.eyeMat);

    // Geometries scaled cleanly to 1.6x hero (~1.48m standing ninja)
    const pelvisGeo = new THREE.SphereGeometry(0.115, 14, 10);
    const abdomenGeo = new THREE.CapsuleGeometry(0.085, 0.125, 6, 12);
    const chestGeo = new THREE.CapsuleGeometry(0.115, 0.17, 6, 14);
    const collarGeo = new THREE.TorusGeometry(0.105, 0.022, 8, 18);
    const headGeo = new THREE.SphereGeometry(0.132, 18, 14);
    const headbandGeo = new THREE.CylinderGeometry(0.136, 0.136, 0.046, 18, 1, true);
    const visorGeo = new THREE.BoxGeometry(0.085, 0.058, 0.145);
    const eyeGeo = new THREE.BoxGeometry(0.034, 0.025, 0.036);
    const limbGeo = new THREE.CylinderGeometry(0.042, 0.042, 1.0, 10);
    const thighGeo = new THREE.CylinderGeometry(0.054, 0.045, 1.0, 10);
    const jointGeo = new THREE.SphereGeometry(0.056, 12, 10);
    const footGeo = new THREE.BoxGeometry(0.17, 0.058, 0.10);

    this.geometries.push(
      pelvisGeo,
      abdomenGeo,
      chestGeo,
      collarGeo,
      headGeo,
      headbandGeo,
      visorGeo,
      eyeGeo,
      limbGeo,
      thighGeo,
      jointGeo,
      footGeo,
    );

    // Build Hierarchy
    this.rootGroup.name = 'StickmanHero';
    this.rootGroup.position.copy(this.currentPos);
    this.rootGroup.add(this.visualCore);

    this.pelvisGroup.position.set(0, 0.0, 0);
    const pelvisMesh = new THREE.Mesh(pelvisGeo, jointMat);
    pelvisMesh.castShadow = true;
    this.pelvisGroup.add(pelvisMesh);
    this.visualCore.add(this.pelvisGroup);

    // Spine Lower (30% aim share)
    this.torsoLowerGroup.position.set(0, 0.115, 0);
    const abdomenMesh = new THREE.Mesh(abdomenGeo, carbonMat);
    abdomenMesh.position.set(0, 0.06, 0);
    abdomenMesh.castShadow = true;
    this.torsoLowerGroup.add(abdomenMesh);
    this.pelvisGroup.add(this.torsoLowerGroup);

    // Chest (50% aim share)
    this.chestGroup.position.set(0, 0.175, 0);
    const chestMesh = new THREE.Mesh(chestGeo, carbonMat);
    chestMesh.position.set(0, 0.085, 0);
    chestMesh.castShadow = true;
    const collarMesh = new THREE.Mesh(collarGeo, jointMat);
    collarMesh.rotation.x = Math.PI * 0.5;
    collarMesh.position.set(0, 0.175, 0);
    this.chestGroup.add(chestMesh, collarMesh, this.backHolsterSocket);
    this.backHolsterSocket.position.set(-0.15, 0.09, 0);
    this.torsoLowerGroup.add(this.chestGroup);

    // Head (20% aim share) + Crimson Headband + Dual Visor Eyes
    this.headGroup.position.set(0, 0.26, 0);
    const headMesh = new THREE.Mesh(headGeo, carbonMat);
    headMesh.position.set(0, 0.115, 0);
    headMesh.castShadow = true;

    const headbandMesh = new THREE.Mesh(headbandGeo, bandMat);
    headbandMesh.position.set(0, 0.16, 0);

    const visorMesh = new THREE.Mesh(visorGeo, visorBackMat);
    visorMesh.position.set(0.09, 0.12, 0);

    this.eyeLeftMesh = new THREE.Mesh(eyeGeo, this.eyeMat);
    this.eyeLeftMesh.position.set(0.122, 0.124, 0.038);
    this.eyeRightMesh = new THREE.Mesh(eyeGeo, this.eyeMat);
    this.eyeRightMesh.position.set(0.122, 0.124, -0.038);

    this.scarfAnchor.position.set(-0.115, 0.16, 0);
    this.headGroup.add(
      headMesh,
      headbandMesh,
      visorMesh,
      this.eyeLeftMesh,
      this.eyeRightMesh,
      this.scarfAnchor,
    );
    this.chestGroup.add(this.headGroup);

    // Limb Meshes
    const makeLimb = (geo: THREE.BufferGeometry, mat: THREE.Material) => {
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = true;
      m.renderOrder = RENDER_ORDER.CHARACTER_AND_SHARDS;
      this.visualCore.add(m);
      return m;
    };

    this.leftShoulderJoint = makeLimb(jointGeo, jointMat);
    this.leftElbowJoint = makeLimb(jointGeo, jointMat);
    this.leftUpperArm = makeLimb(limbGeo, carbonMat);
    this.leftForearm = makeLimb(limbGeo, carbonMat);
    this.leftForearm.add(this.leftHandSocket);
    this.leftHandSocket.position.set(0, -0.5, 0);

    this.rightShoulderJoint = makeLimb(jointGeo, jointMat);
    this.rightElbowJoint = makeLimb(jointGeo, jointMat);
    this.rightUpperArm = makeLimb(limbGeo, carbonMat);
    this.rightForearm = makeLimb(limbGeo, carbonMat);
    this.rightForearm.add(this.rightHandSocket);
    this.rightHandSocket.position.set(0, -0.5, 0);

    this.leftHipJoint = makeLimb(jointGeo, jointMat);
    this.leftKneeJoint = makeLimb(jointGeo, jointMat);
    this.leftThigh = makeLimb(thighGeo, carbonMat);
    this.leftShin = makeLimb(limbGeo, carbonMat);
    this.leftFoot = makeLimb(footGeo, jointMat);

    this.rightHipJoint = makeLimb(jointGeo, jointMat);
    this.rightKneeJoint = makeLimb(jointGeo, jointMat);
    this.rightThigh = makeLimb(thighGeo, carbonMat);
    this.rightShin = makeLimb(limbGeo, carbonMat);
    this.rightFoot = makeLimb(footGeo, jointMat);

    // 8-Segment Verlet Headband Scarf
    const scarfGeo = new THREE.BufferGeometry();
    const vertCount = this.scarfSegmentCount * 2;
    const scarfVerts = new Float32Array(vertCount * 3);
    const scarfIndices: number[] = [];
    for (let i = 0; i < this.scarfSegmentCount - 1; i++) {
      const a = i * 2;
      const b = a + 1;
      const c = a + 2;
      const d = a + 3;
      scarfIndices.push(a, b, c, b, d, c);
    }
    scarfGeo.setAttribute('position', new THREE.BufferAttribute(scarfVerts, 3));
    scarfGeo.setIndex(scarfIndices);
    this.geometries.push(scarfGeo);

    this.scarfMesh = new THREE.Mesh(scarfGeo, bandMat);
    this.scarfMesh.frustumCulled = false;
    this.scarfMesh.castShadow = true;
    this.scarfMesh.renderOrder = RENDER_ORDER.CHARACTER_AND_SHARDS;
    scene.add(this.scarfMesh);

    for (let i = 0; i < this.scarfSegmentCount; i++) {
      const p = new THREE.Vector3(startX - i * 0.125, startY + 0.78, SPATIAL_CONSTANTS.BAND_PLAY_Z);
      this.scarfPositions.push(p.clone());
      this.scarfPrevPositions.push(p.clone());
    }

    // Contact Blob Shadow
    const shadowTex = createBlobShadowTexture();
    this.textures.push(shadowTex);
    const shadowGeo = new THREE.PlaneGeometry(1.45, 0.85);
    shadowGeo.rotateX(-Math.PI * 0.5);
    this.geometries.push(shadowGeo);
    this.shadowMat = new THREE.MeshBasicMaterial({
      map: shadowTex,
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    this.materials.push(this.shadowMat);
    this.blobShadowMesh = new THREE.Mesh(shadowGeo, this.shadowMat);
    this.blobShadowMesh.renderOrder = RENDER_ORDER.SHADOW_AND_CRATERS;
    scene.add(this.blobShadowMesh);

    // Additive Smear & Scale-Shift Ring
    const smearGeo = new THREE.RingGeometry(0.42, 0.92, 18, 1, -0.9, 1.8);
    this.geometries.push(smearGeo);
    this.smearMat = new THREE.MeshBasicMaterial({
      color: 0xf59e0b,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.materials.push(this.smearMat);
    this.smearArcMesh = new THREE.Mesh(smearGeo, this.smearMat);
    this.smearArcMesh.visible = false;
    this.smearArcMesh.renderOrder = RENDER_ORDER.ADDITIVE_VFX_LIGHTNING;
    scene.add(this.smearArcMesh);

    // Emergency Void-Fall Rescue Tether Line
    const tetherGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(),
      new THREE.Vector3(),
    ]);
    this.geometries.push(tetherGeo);
    this.tetherMat = new THREE.LineBasicMaterial({
      color: 0x06b6d4,
      transparent: true,
      opacity: 0,
    });
    this.materials.push(this.tetherMat);
    this.tetherLine = new THREE.Line(tetherGeo, this.tetherMat);
    this.tetherLine.frustumCulled = false;
    this.tetherLine.visible = false;
    this.tetherLine.renderOrder = RENDER_ORDER.ADDITIVE_VFX_LIGHTNING;
    scene.add(this.tetherLine);

    // Dual Contrast Halo + Bright Cyan-Amber Energy Aura
    const auraContrastTex = createHeroAuraTexture('contrast');
    const auraGlowTex = createHeroAuraTexture('glow');
    this.textures.push(auraContrastTex, auraGlowTex);

    const auraContrastGeo = new THREE.PlaneGeometry(1.75, 2.08);
    const auraGlowGeo = new THREE.PlaneGeometry(2.35, 2.68);
    this.geometries.push(auraContrastGeo, auraGlowGeo);

    const auraContrastMat = new THREE.MeshBasicMaterial({
      map: auraContrastTex,
      transparent: true,
      opacity: 0.34,
      depthWrite: false,
    });
    this.auraGlowMat = new THREE.MeshBasicMaterial({
      map: auraGlowTex,
      transparent: true,
      opacity: 0.44,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    this.materials.push(auraContrastMat, this.auraGlowMat);

    this.auraContrastMesh = new THREE.Mesh(auraContrastGeo, auraContrastMat);
    this.auraContrastMesh.renderOrder = RENDER_ORDER.CHARACTER_AND_SHARDS - 1;
    scene.add(this.auraContrastMesh);

    this.auraGlowMesh = new THREE.Mesh(auraGlowGeo, this.auraGlowMat);
    this.auraGlowMesh.renderOrder = RENDER_ORDER.ADDITIVE_VFX_LIGHTNING;
    scene.add(this.auraGlowMesh);

    scene.add(this.rootGroup);
  }

  getState(): StickmanParkourState {
    return this.state;
  }

  getPosition(out = new THREE.Vector3()): THREE.Vector3 {
    return out.copy(this.currentPos);
  }

  getVelocity(out = new THREE.Vector3()): THREE.Vector3 {
    return out.copy(this.currentVel);
  }

  isGrounded(): boolean {
    return this.grounded;
  }

  isInFlight(): boolean {
    return this.isFlying;
  }

  isInsideVault(): boolean {
    return this.inVault;
  }

  getScale(): number {
    return this.currentScale;
  }

  getIntegrityLives(): number {
    return this.integrityLives;
  }

  setVaultTarget(inVault: boolean, targetZ: number, centerX?: number, centerY?: number): void {
    const changed = this.inVault !== inVault;
    this.inVault = inVault;
    this.targetScale = inVault ? 0.38 : 1.0;
    this.targetPlaneZ = targetZ;
    if (changed) {
      this.squashSpring.impulse(inVault ? -7.5 : 8.2);
      this.triggerSmear(0.2, 0);
      this.groundedColliderHandle = null;
      this.isFlying = false;
      if (inVault) {
        if (centerX !== undefined && centerY !== undefined) {
          this.currentPos.x = THREE.MathUtils.lerp(this.currentPos.x, centerX, 0.72);
          this.currentPos.y = THREE.MathUtils.lerp(this.currentPos.y, centerY, 0.85);
          this.body.setTranslation(
            { x: this.currentPos.x, y: this.currentPos.y, z: this.currentPos.z },
            true,
          );
        }
        this.currentVel.set(this.currentVel.x * 0.35, -1.2, 0);
      } else {
        this.currentVel.y = Math.max(this.currentVel.y, 2.8);
      }
    }
  }

  triggerRagdoll(impulseX = 0, impulseY = 5.5, spinZ = 7.5): void {
    if (this.state === 'ragdoll') return;
    if (this.colliderCrouched) {
      this.colliderCrouched = false;
      this.collider.setHalfHeight(this.baseCapsuleHalfHeight * this.currentScale);
      this.collider.setTranslationWrtParent({ x: 0, y: 0, z: 0 });
    }
    this.isFlying = false;
    this.state = 'ragdoll';
    this.groundedColliderHandle = null;
    this.ragdollTimer = 0;
    this.grounded = false;

    this.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    this.body.setEnabledTranslations(true, true, false, true);
    this.body.setEnabledRotations(false, false, true, true);
    this.body.setLinvel(
      {
        x: this.currentVel.x * 0.7 + impulseX,
        y: Math.max(this.currentVel.y, impulseY),
        z: 0,
      },
      true,
    );
    this.body.setAngvel({ x: 0, y: 0, z: spinZ * -this.facing }, true);
    this.triggerSmear(0.14, 0);
  }

  setVoidThresholdY(minY: number): void {
    this.voidFloorY = minY;
  }

  setSpawnPoint(x: number, y: number): void {
    this.spawnPos.set(x, y, SPATIAL_CONSTANTS.BAND_PLAY_Z);
    this.lastSafePos.copy(this.spawnPos);
  }

  resetToSpawn(restoreLives = true): void {
    if (restoreLives) {
      this.integrityLives = this.maxIntegrityLives;
    }
    this.inVault = false;
    this.currentScale = 1.0;
    this.targetScale = 1.0;
    this.targetPlaneZ = SPATIAL_CONSTANTS.BAND_PLAY_Z;
    this.isFlying = false;
    this.airDoubleTapTimer = 0;
    this.airJumpHoldTimer = 0;

    if (this.colliderCrouched) {
      this.colliderCrouched = false;
      this.collider.setTranslationWrtParent({ x: 0, y: 0, z: 0 });
    }
    this.collider.setHalfHeight(this.baseCapsuleHalfHeight);
    this.collider.setRadius(this.baseCapsuleRadius);

    this.state = 'idle';
    this.grounded = false;
    this.groundedColliderHandle = null;
    this.coyoteTimer = 0;
    this.jumpBufferTimer = 0;
    this.pendingJumpImpulse = false;
    this.rollTimer = 0;
    this.kipUpTimer = 0;
    this.dropThroughTimer = 0;
    this.crouchHoldTimer = 0;
    this.dropIgnoreAboveY = Infinity;
    this.currentPos.copy(this.spawnPos);
    this.lastSafePos.copy(this.spawnPos);
    this.currentVel.set(0, 0, 0);
    this.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
    this.body.setTranslation(
      { x: this.spawnPos.x, y: this.spawnPos.y, z: this.spawnPos.z },
      true,
    );
    this.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.ragdollQuat.identity();
    this.squashSpring.reset(1.0);
    for (let i = 0; i < this.scarfSegmentCount; i++) {
      this.scarfPositions[i].set(
        this.spawnPos.x - i * 0.125,
        this.spawnPos.y + 0.78,
        this.spawnPos.z,
      );
      this.scarfPrevPositions[i].copy(this.scarfPositions[i]);
    }
  }

  private triggerSmear(duration: number, angleRad: number): void {
    this.smearTimer = duration;
    this.smearAngle = angleRad;
  }

  private getCollisionMask(): number {
    const insideDepth = this.inVault || this.currentPos.z < -0.25;
    return insideDepth
      ? packInteractionGroups(
          COLLISION_GROUP.PLAYER,
          COLLISION_GROUP.TERRAIN | COLLISION_GROUP.CARD_INTERIOR,
        )
      : packInteractionGroups(
          COLLISION_GROUP.PLAYER,
          COLLISION_GROUP.TERRAIN | COLLISION_GROUP.CARD_SHELL,
        );
  }

  step(fixedDt: number, input: StickmanInputState): StickmanStepResult {
    let impactStrength = 0;
    let lostLifeToVoid = false;

    if (this.ledgeCooldown > 0) this.ledgeCooldown = Math.max(0, this.ledgeCooldown - fixedDt);
    if (this.airDoubleTapTimer > 0) {
      this.airDoubleTapTimer = Math.max(0, this.airDoubleTapTimer - fixedDt);
    }

    // Smoothly damp Hero Size (1.0x Hero <-> 0.38x Micro inside vaults) & Z-plane
    const prevScale = this.currentScale;
    this.currentScale = dampScalar(this.currentScale, this.targetScale, 8.8, fixedDt);
    const scaleDelta = this.currentScale - prevScale;
    if (Math.abs(scaleDelta) > 1e-5) {
      const halfH = (this.colliderCrouched ? 0.19 : this.baseCapsuleHalfHeight) * this.currentScale;
      const rad = this.baseCapsuleRadius * this.currentScale;
      this.collider.setHalfHeight(halfH);
      this.collider.setRadius(rad);
      if (this.colliderCrouched) {
        this.collider.setTranslationWrtParent({ x: 0, y: -0.25 * this.currentScale, z: 0 });
      }
      // Keep feet out of floor when expanding back to 1.0x
      if (scaleDelta > 0 && this.grounded) {
        this.currentPos.y += scaleDelta * this.baseFootBottom * 1.08;
      }
    }
    const effectiveFootBottom = this.baseFootBottom * this.currentScale;
    const speedScale = THREE.MathUtils.lerp(0.62, 1.0, (this.currentScale - 0.38) / 0.62);

    // Smoothly approach Z-plane (BAND_PLAY_Z outside, BAND_CHAMBER_CENTER_Z inside vaults)
    if (this.state !== 'ragdoll') {
      this.currentPos.z = dampScalar(this.currentPos.z, this.targetPlaneZ, 10.5, fixedDt);
    }

    // Cursor Aim + +/-12px Hysteresis Flip Guard
    const dxAim = input.aimWorldX - this.currentPos.x;
    const dyAim = input.aimWorldY - (this.currentPos.y + 0.45 * this.currentScale);
    const deadbandM = 0.18;
    if (Math.abs(dxAim) > deadbandM) {
      this.facing = dxAim >= 0 ? 1 : -1;
    } else if (input.left !== input.right) {
      this.facing = input.right ? 1 : -1;
    }

    const absDxAim = Math.max(0.15, Math.abs(dxAim));
    this.aimPitchRad = THREE.MathUtils.clamp(Math.atan2(dyAim, absDxAim), -1.25, 1.25);

    const activeInteractionGroups = this.getCollisionMask();

    // -------------------------------------------------------------------------
    // Branch 1: Landfall Quaternion PD Active-Ragdoll & Kip-Up
    // -------------------------------------------------------------------------
    if (this.state === 'ragdoll') {
      const tr = this.body.translation();
      const rot = this.body.rotation();
      const lv = this.body.linvel();
      const av = this.body.angvel();

      this.currentPos.set(tr.x, tr.y, this.targetPlaneZ);
      this.currentVel.set(lv.x, lv.y, 0);
      this.ragdollQuat.set(rot.x, rot.y, rot.z, rot.w);

      this.ragdollTimer += fixedDt;

      const angleZ = 2 * Math.atan2(rot.z, rot.w);
      const normalizedErr = Math.atan2(Math.sin(-angleZ), Math.cos(-angleZ));

      const recoverAlpha = THREE.MathUtils.clamp((this.ragdollTimer - 0.42) / 0.52, 0, 1);
      const kp = THREE.MathUtils.lerp(4.0, 105.0, recoverAlpha * recoverAlpha);
      const kd = THREE.MathUtils.lerp(1.4, 11.0, recoverAlpha);
      const torqueImpulseZ = (kp * normalizedErr - kd * av.z) * fixedDt;
      this.body.applyTorqueImpulse({ x: 0, y: 0, z: torqueImpulseZ }, true);

      const floorHit = this.physics.castRay(
        this.currentPos.x,
        this.currentPos.y,
        this.currentPos.z,
        0,
        -1,
        0,
        effectiveFootBottom + 0.35,
        activeInteractionGroups,
        this.collider,
      );

      if (
        this.ragdollTimer > 0.95 &&
        (floorHit !== null || Math.abs(lv.y) < 1.5) &&
        (Math.abs(normalizedErr) < 0.55 || this.ragdollTimer > 1.75)
      ) {
        this.state = 'kip_up';
        this.kipUpTimer = 0.28;
        this.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
        this.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
        this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
        this.ragdollQuat.identity();
        this.currentVel.set(lv.x * 0.4, 4.2, 0);
        this.squashSpring.reset(0.76);
        this.squashSpring.impulse(8.5);
        this.triggerSmear(0.12, Math.PI * 0.5);
      }
    } else if (this.state === 'ledge_swing') {
      // -----------------------------------------------------------------------
      // Branch 2: Intentional Fall-Grab Pendulum Swing
      // -----------------------------------------------------------------------
      const moveAxis = (input.right ? 1 : 0) - (input.left ? 1 : 0);
      const gravityG = 22.0;
      const pumpAccel = moveAxis * 16.5;
      const angularAccel =
        -(gravityG / this.ledgeRopeLen) * Math.sin(this.ledgeTheta) + pumpAccel;
      this.ledgeOmega = (this.ledgeOmega + angularAccel * fixedDt) * 0.992;
      this.ledgeTheta = THREE.MathUtils.clamp(
        this.ledgeTheta + this.ledgeOmega * fixedDt,
        -1.38,
        1.38,
      );

      const handToCenterDist = this.ledgeRopeLen;
      const targetX = this.ledgeAnchorX + Math.sin(this.ledgeTheta) * handToCenterDist;
      const targetY = this.ledgeAnchorY - Math.cos(this.ledgeTheta) * handToCenterDist - 0.35;
      this.currentPos.set(targetX, targetY, this.targetPlaneZ);
      this.body.setNextKinematicTranslation({
        x: this.currentPos.x,
        y: this.currentPos.y,
        z: this.currentPos.z,
      });

      const tanX = Math.cos(this.ledgeTheta);
      const tanY = Math.sin(this.ledgeTheta);
      const tangentialSpeed = handToCenterDist * this.ledgeOmega;
      this.currentVel.set(tanX * tangentialSpeed, tanY * tangentialSpeed, 0);

      if (input.jumpPressedThisFrame) {
        this.currentVel.x = tanX * tangentialSpeed * 1.25 + moveAxis * 3.8;
        this.currentVel.y = Math.max(8.8, tanY * tangentialSpeed + 7.6);
        this.state = 'jump_rise';
        this.ledgeCooldown = 0.34;
        this.airDoubleTapTimer = 0.3;
        this.squashSpring.impulse(5.8);
        this.triggerSmear(0.11, Math.atan2(this.currentVel.y, this.currentVel.x));
      } else if (input.crouchHeld) {
        this.state = 'fast_fall';
        this.ledgeCooldown = 0.35;
        this.currentVel.y = -2.5;
      }
    } else {
      // -----------------------------------------------------------------------
      // Branch 3: Parkour + Double-Tap / Hold Jump Free Flight + Unlimited Jumps
      // -----------------------------------------------------------------------
      const moveAxis = (input.right ? 1 : 0) - (input.left ? 1 : 0);

      if (this.grounded) {
        this.coyoteTimer = 0.11;
        this.airJumpHoldTimer = 0;
        if (!input.jumpHeld && this.isFlying) {
          this.isFlying = false;
        }
      } else {
        this.coyoteTimer = Math.max(0, this.coyoteTimer - fixedDt);
      }

      if (input.jumpPressedThisFrame) {
        this.jumpBufferTimer = 0.12;
      } else {
        this.jumpBufferTimer = Math.max(0, this.jumpBufferTimer - fixedDt);
      }

      if (this.kipUpTimer > 0) this.kipUpTimer = Math.max(0, this.kipUpTimer - fixedDt);
      if (this.rollTimer > 0) this.rollTimer = Math.max(0, this.rollTimer - fixedDt);
      if (this.dropThroughTimer > 0) {
        this.dropThroughTimer = Math.max(0, this.dropThroughTimer - fixedDt);
      }

      // Drop-Through trigger (only outside Cyber-Vaults when standing on exterior shelves)
      if (input.crouchHeld && !this.isFlying) {
        this.crouchHoldTimer += fixedDt;
        const standingOnOneWay = this.grounded || this.coyoteTimer > 0;
        if (
          (input.jumpPressedThisFrame && standingOnOneWay) ||
          (this.grounded && this.crouchHoldTimer > 0.18 && Math.abs(this.currentVel.x) < 0.8)
        ) {
          this.dropThroughTimer = 0.28;
          this.dropIgnoreAboveY = this.currentPos.y - effectiveFootBottom - 0.26;
          this.crouchHoldTimer = 0;
          this.jumpBufferTimer = 0;
          this.coyoteTimer = 0;
          this.pendingJumpImpulse = false;
          this.grounded = false;
          this.currentVel.y = -4.2;
          this.squashSpring.impulse(-4.5);
        }
      } else {
        this.crouchHoldTimer = 0;
      }

      // Headroom clearance check for crouch-slide
      let headBlocked = false;
      if (this.colliderCrouched && !input.crouchHeld) {
        const ceilHit = this.physics.castRay(
          this.currentPos.x,
          this.currentPos.y - 0.1 * this.currentScale,
          this.currentPos.z,
          0,
          1,
          0,
          0.78 * this.currentScale,
          activeInteractionGroups,
          this.collider,
        );
        headBlocked = ceilHit !== null;
      }

      const wasCrouched = this.colliderCrouched;
      const effectivelyCrouched = (!this.isFlying && input.crouchHeld && this.grounded) || headBlocked;
      if (effectivelyCrouched && !this.colliderCrouched) {
        this.colliderCrouched = true;
        this.collider.setHalfHeight(0.19 * this.currentScale);
        this.collider.setTranslationWrtParent({ x: 0, y: -0.25 * this.currentScale, z: 0 });
      } else if (!effectivelyCrouched && this.colliderCrouched) {
        this.colliderCrouched = false;
        this.collider.setHalfHeight(this.baseCapsuleHalfHeight * this.currentScale);
        this.collider.setTranslationWrtParent({ x: 0, y: 0, z: 0 });
      }

      // Double-tap or Hold Jump in air ignites Free 360° Flight!
      if (!this.grounded && this.dropThroughTimer <= 0) {
        if (input.jumpHeld) {
          this.airJumpHoldTimer += fixedDt;
          if (!this.isFlying && this.airJumpHoldTimer >= 0.24) {
            this.isFlying = true;
            this.pendingJumpImpulse = false;
            this.currentVel.y = Math.max(this.currentVel.y, 4.8 * speedScale);
            this.triggerSmear(0.14, Math.PI * 0.5);
          }
        } else {
          this.airJumpHoldTimer = 0;
        }
      } else {
        this.airJumpHoldTimer = 0;
      }

      const wantsSlide =
        !this.isFlying &&
        effectivelyCrouched &&
        this.grounded &&
        Math.abs(this.currentVel.x) > 1.2;

      if (this.isFlying) {
        // ---------------------------------------------------------------------
        // Smooth 360° Omni-Directional Flight
        // ---------------------------------------------------------------------
        const flySpeedX = 11.4 * speedScale;
        const flySpeedY = 9.6 * speedScale;
        const targetVx = moveAxis * flySpeedX;
        let targetVy = 0;
        if (input.jumpHeld) {
          targetVy = flySpeedY;
        } else if (input.crouchHeld) {
          targetVy = -flySpeedY;
        }

        this.currentVel.x = dampScalar(this.currentVel.x, targetVx, 9.2, fixedDt);
        this.currentVel.y = dampScalar(this.currentVel.y, targetVy, 8.6, fixedDt);

        if (input.jumpPressedThisFrame && this.currentVel.y < 3.0) {
          this.currentVel.y = 7.4 * speedScale;
          this.triggerSmear(0.1, Math.PI * 0.5);
        }
      } else {
        // ---------------------------------------------------------------------
        // Grounded Parkour & Unlimited Air Jumps
        // ---------------------------------------------------------------------
        if (wantsSlide && !wasCrouched && Math.abs(this.currentVel.x) > 2.0) {
          this.currentVel.x = Math.sign(this.currentVel.x) * 11.4 * speedScale;
          this.triggerSmear(0.11, 0);
        }
        const targetMaxSpeed = (wantsSlide
          ? 11.4
          : effectivelyCrouched && this.grounded
            ? 4.2
            : 9.0) * speedScale;
        const accelRate = (this.grounded ? (wantsSlide ? 12.0 : 58.0) : 36.0) * speedScale;

        if (this.rollTimer > 0) {
          this.currentVel.x = this.rollDir * Math.max(6.8 * speedScale, Math.abs(this.currentVel.x));
        } else if (wantsSlide) {
          const slideDir = Math.sign(this.currentVel.x);
          this.currentVel.x = dampScalar(this.currentVel.x, slideDir * targetMaxSpeed, 4.5, fixedDt);
        } else {
          const targetVx = moveAxis * targetMaxSpeed;
          const deltaVx = targetVx - this.currentVel.x;
          const maxStep = accelRate * fixedDt;
          if (Math.abs(deltaVx) <= maxStep) {
            this.currentVel.x = targetVx;
          } else {
            this.currentVel.x += Math.sign(deltaVx) * maxStep;
          }
        }

        // Jump Trigger: Grounded Coyote, Wall-Kick, Double-Tap Fly, OR Unlimited Air Jump
        if (this.jumpBufferTimer > 0 && this.dropThroughTimer <= 0) {
          if (
            this.coyoteTimer > 0 &&
            !input.crouchHeld &&
            !this.pendingJumpImpulse &&
            this.rollTimer <= 0
          ) {
            this.pendingJumpImpulse = true;
            this.anticipationTimer = 0.04;
            this.jumpBufferTimer = 0;
            this.coyoteTimer = 0;
            this.airDoubleTapTimer = 0.3;
            this.squashSpring.impulse(-8.5);
          } else if (this.wallTouchDir !== 0 && !this.grounded) {
            this.currentVel.x = -this.wallTouchDir * 9.4 * speedScale;
            this.currentVel.y = 11.0 * speedScale;
            this.facing = -this.wallTouchDir;
            this.jumpBufferTimer = 0;
            this.airDoubleTapTimer = 0.3;
            this.squashSpring.impulse(7.2);
            this.triggerSmear(0.11, Math.atan2(this.currentVel.y, this.currentVel.x));
            impactStrength = 0.22;
          } else if (!this.grounded && !this.pendingJumpImpulse) {
            this.jumpBufferTimer = 0;
            if (this.airDoubleTapTimer > 0) {
              // Second tap in mid-air -> instant Free Flight!
              this.isFlying = true;
              this.airDoubleTapTimer = 0;
              this.currentVel.y = Math.max(this.currentVel.y, 7.2 * speedScale);
              this.squashSpring.impulse(7.5);
              this.triggerSmear(0.14, Math.PI * 0.5);
            } else {
              // Unlimited Air Jump!
              this.airDoubleTapTimer = 0.3;
              this.currentVel.y = 10.6 * speedScale;
              this.squashSpring.impulse(6.8);
              this.triggerSmear(0.12, Math.PI * 0.5);
              impactStrength = 0.16;
            }
          }
        }

        if (this.pendingJumpImpulse) {
          this.anticipationTimer -= fixedDt;
          if (this.anticipationTimer <= 0) {
            this.pendingJumpImpulse = false;
            this.currentVel.y = 11.2 * speedScale;
            this.grounded = false;
            this.squashSpring.impulse(8.0);
            this.triggerSmear(0.1, Math.PI * 0.5);
          }
        }

        // Celeste 3-Phase Asymmetric Jump Gravity
        let gravityScale = 1.0;
        if (!this.grounded) {
          if (this.currentVel.y > 0 && !input.jumpHeld) {
            gravityScale = 2.15;
          } else if (Math.abs(this.currentVel.y) < 2.2) {
            gravityScale = 0.48;
          } else if (this.currentVel.y < 0) {
            gravityScale = 1.85;
          }
        }

        this.currentVel.y = Math.max(
          -20.0 * speedScale,
          this.currentVel.y - 24.5 * speedScale * gravityScale * fixedDt,
        );

        if (
          !this.grounded &&
          this.wallTouchDir !== 0 &&
          this.currentVel.y < -3.2 &&
          moveAxis === this.wallTouchDir
        ) {
          this.currentVel.y = -3.2;
        }
      }

      // Snap-to-ground bug fix: disable snap during flight, jump rise, or drop-through!
      const allowSnap =
        this.grounded && !this.isFlying && this.dropThroughTimer <= 0 && this.currentVel.y <= 0.1;
      this.controller.enableSnapToGround(allowSnap ? 0.24 * this.currentScale : 0);

      // Compute Rapier KCC movement with Kinematic Island Delta Inheritance
      const prevGrounded = this.grounded;
      const preImpactVy = this.currentVel.y;

      this.platformDeltaScratch.dx = 0;
      this.platformDeltaScratch.dy = 0;
      if (this.grounded && this.groundedColliderHandle !== null && this.dropThroughTimer <= 0 && !this.isFlying) {
        this.physics.getPlatformDelta(this.groundedColliderHandle, this.platformDeltaScratch);
      }

      const desiredDx = this.currentVel.x * fixedDt + this.platformDeltaScratch.dx;
      const desiredDy = this.currentVel.y * fixedDt + this.platformDeltaScratch.dy;

      const footY = this.currentPos.y - effectiveFootBottom;
      const isDropping = this.dropThroughTimer > 0;
      const vy = this.currentVel.y;
      const ridingHandle = this.groundedColliderHandle;

      const filterPredicate = (c: RAPIER.Collider): boolean => {
        if (!this.physics.isOneWayPlatform(c.handle)) {
          return true;
        }
        if (vy > 0.08) {
          return false;
        }
        const info = this.physics.getPlatformInfo(c.handle);
        if (info) {
          const ledgeTop = info.block.y + info.block.halfH;
          if (isDropping && ledgeTop >= this.dropIgnoreAboveY) {
            return false;
          }
          const margin = (c.handle === ridingHandle ? 0.28 : 0.1) * this.currentScale;
          if (footY < ledgeTop - margin) {
            return false;
          }
        }
        return true;
      };

      this.controller.computeColliderMovement(
        this.collider,
        { x: desiredDx, y: desiredDy, z: 0 },
        undefined,
        activeInteractionGroups,
        filterPredicate,
      );

      const resolved = this.controller.computedMovement();
      this.currentPos.x += resolved.x;
      this.currentPos.y += resolved.y;
      this.body.setNextKinematicTranslation({
        x: this.currentPos.x,
        y: this.currentPos.y,
        z: this.currentPos.z,
      });

      this.grounded = this.controller.computedGrounded();
      this.groundedColliderHandle = null;

      this.wallTouchDir = 0;
      const numCol = this.controller.numComputedCollisions();
      for (let i = 0; i < numCol; i++) {
        const col = this.controller.computedCollision(i);
        if (!col) continue;
        if (col.normal1.y > 0.55 && col.collider) {
          this.groundedColliderHandle = col.collider.handle;
        }
        if (Math.abs(col.normal1.x) > 0.72) {
          this.wallTouchDir = col.normal1.x < 0 ? 1 : -1;
          if (Math.sign(this.currentVel.x) === this.wallTouchDir) {
            this.currentVel.x = 0;
          }
        }
        if (col.normal1.y < -0.75 && this.currentVel.y > 0) {
          this.currentVel.y = 0;
        }
      }

      // Multi-Point Edge Support Raycast Fix: keeps moving-platform delta stable on ledge corners!
      if (this.grounded && this.groundedColliderHandle === null) {
        const edgeOffset = this.baseCapsuleRadius * this.currentScale * 0.78;
        const rayXOffsets = [0, -edgeOffset, edgeOffset];
        for (const ox of rayXOffsets) {
          const supportRay = this.physics.castRay(
            this.currentPos.x + ox,
            this.currentPos.y,
            this.currentPos.z,
            0,
            -1,
            0,
            effectiveFootBottom + 0.24 * this.currentScale,
            activeInteractionGroups,
            this.collider,
          );
          if (supportRay) {
            this.groundedColliderHandle = supportRay.collider.handle;
            break;
          }
        }
      }

      if (this.grounded) {
        if (!this.inVault) {
          this.lastSafePos.copy(this.currentPos);
        }
        if (this.isFlying && !input.jumpHeld && this.currentVel.y <= 0.1) {
          this.isFlying = false;
        }
        if (!prevGrounded && preImpactVy < -2.5) {
          const squashForce = THREE.MathUtils.clamp(Math.abs(preImpactVy) * 0.52, 1.5, 9.5);
          this.squashSpring.impulse(-squashForce);
          impactStrength = THREE.MathUtils.clamp(Math.abs(preImpactVy) / 18.0, 0.08, 0.75);

          if (
            preImpactVy < -10.5 &&
            (Math.abs(this.currentVel.x) > 2.0 || input.crouchHeld)
          ) {
            this.rollTimer = 0.34;
            this.rollDir = moveAxis !== 0 ? moveAxis : this.facing;
            this.triggerSmear(0.14, 0);
          }
        }
        if (this.currentVel.y < 0) this.currentVel.y = 0;
      }

      // Intentional Ledge-Grab Fix: only on explicit F hold or genuine downward fall (vy < -2.2)
      if (
        !this.grounded &&
        !this.isFlying &&
        !this.inVault &&
        this.ledgeCooldown <= 0 &&
        (input.grabHeld || this.currentVel.y < -2.2)
      ) {
        const corner = this.physics.findNearestGrabbableCorner(
          this.currentPos.x,
          this.currentPos.y + 0.72 * this.currentScale,
          1.1 * this.currentScale,
          moveAxis,
        );
        if (corner && (input.grabHeld || moveAxis !== 0)) {
          this.state = 'ledge_swing';
          this.ledgeAnchorX = corner.x;
          this.ledgeAnchorY = corner.y;
          this.ledgeRopeLen = 0.92 * this.currentScale;
          const dxCorner = this.currentPos.x - corner.x;
          this.ledgeTheta = THREE.MathUtils.clamp(Math.atan2(dxCorner, 0.92), -1.1, 1.1);
          this.ledgeOmega = THREE.MathUtils.clamp(this.currentVel.x * 0.6, -4.5, 4.5);
          this.squashSpring.impulse(3.5);
        }
      }

      if (this.state !== 'ledge_swing') {
        if (this.kipUpTimer > 0) {
          this.state = 'kip_up';
        } else if (this.isFlying) {
          this.state = 'flight';
        } else if (this.rollTimer > 0) {
          this.state = 'shoulder_roll';
        } else if (wantsSlide) {
          this.state = 'crouch_slide';
        } else if (!this.grounded) {
          if (this.wallTouchDir !== 0 && this.currentVel.y < 0 && moveAxis === this.wallTouchDir) {
            this.state = 'wall_slide';
          } else if (this.currentVel.y > 2.2) {
            this.state = 'jump_rise';
          } else if (Math.abs(this.currentVel.y) <= 2.2) {
            this.state = 'apex_hang';
          } else {
            this.state = 'fast_fall';
          }
        } else if (Math.abs(this.currentVel.x) > 0.35) {
          this.state = 'run';
        } else {
          this.state = 'idle';
        }
      }
    }

    // -------------------------------------------------------------------------
    // Branch 4: Anti-Fall Thruster Recovery (Never Punishes Falling!)
    // -------------------------------------------------------------------------
    if (this.currentPos.y < this.voidFloorY) {
      lostLifeToVoid = false;
      this.tetherOrigin.copy(this.currentPos);
      this.tetherFlashTimer = 0.42;

      this.currentPos.y = this.voidFloorY + 1.25;
      this.currentVel.y = 14.5;
      this.isFlying = true;
      this.state = 'flight';
      this.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
      this.body.setTranslation(
        { x: this.currentPos.x, y: this.currentPos.y, z: this.currentPos.z },
        true,
      );
      this.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
      this.ragdollQuat.identity();
      this.squashSpring.impulse(7.5);
      this.triggerSmear(0.16, Math.PI * 0.5);
      impactStrength = 0.42;
    }

    this.updateProceduralPose(fixedDt);

    return {
      state: this.state,
      grounded: this.grounded,
      speed: Math.hypot(this.currentVel.x, this.currentVel.y),
      isFlying: this.isFlying,
      isShrunk: this.currentScale < 0.72,
      scale: this.currentScale,
      integrityLives: this.integrityLives,
      impactStrength,
      lostLifeToVoid,
    };
  }

  private orientLimb(mesh: THREE.Mesh, start: THREE.Vector3, end: THREE.Vector3, len: number): void {
    this.tmpV4.addVectors(start, end).multiplyScalar(0.5);
    this.tmpV5.subVectors(end, start);
    const actualLen = this.tmpV5.length();
    mesh.position.copy(this.tmpV4);
    if (actualLen > 1e-5) {
      this.tmpV5.divideScalar(actualLen);
      this.tmpQ0.setFromUnitVectors(this.upVec, this.tmpV5);
      mesh.quaternion.copy(this.tmpQ0);
    }
    mesh.scale.set(1, Math.max(0.05, Math.min(len, actualLen)), 1);
  }

  private updateProceduralPose(dt: number): void {
    const targetYaw = this.facing > 0 ? -0.22 : -(Math.PI - 0.22);
    this.facingYaw = dampScalar(this.facingYaw, targetYaw, 15.0, dt);

    this.rootGroup.position.copy(this.currentPos);
    if (this.state === 'ragdoll') {
      this.rootGroup.quaternion.copy(this.ragdollQuat);
    } else {
      this.rootGroup.rotation.set(0, 0, 0);
    }

    const targetSquashY =
      this.state === 'crouch_slide'
        ? 0.72
        : this.state === 'flight'
          ? 1.07
          : this.state === 'jump_rise'
            ? 1.12
            : this.state === 'fast_fall'
              ? 1.08
              : 1.0;
    const squashY = this.squashSpring.update(dt, targetSquashY);
    computeVolumePreservingScale(squashY, 0.85, this.tmpV0);
    this.tmpV0.multiplyScalar(this.currentScale);
    this.visualCore.scale.copy(this.tmpV0);
    this.visualCore.rotation.set(0, this.facingYaw, 0);

    if (this.state === 'shoulder_roll') {
      const p = 1 - this.rollTimer / 0.34;
      this.visualCore.rotation.z = -this.rollDir * p * Math.PI * 2;
      this.visualCore.position.y = -0.24 * Math.sin(p * Math.PI) * this.currentScale;
    } else if (this.state === 'crouch_slide') {
      this.visualCore.position.y = -0.34 * this.currentScale;
    } else {
      this.visualCore.position.y = 0;
    }

    // Line-of-action spine pitch + flight lean
    const speedRatio = THREE.MathUtils.clamp(Math.abs(this.currentVel.x) / 9.0, 0, 1);
    const runLean =
      this.state === 'flight'
        ? -THREE.MathUtils.clamp(Math.abs(this.currentVel.x) * 0.042, 0.08, 0.45)
        : this.grounded
          ? -speedRatio * 0.22
          : -THREE.MathUtils.clamp(this.currentVel.x * 0.025, -0.25, 0.25);
    const crouchLean = this.state === 'crouch_slide' ? -0.58 : 0;
    const baseTorsoLean = runLean + crouchLean;

    this.torsoLowerGroup.rotation.z = baseTorsoLean * 0.4 + this.aimPitchRad * 0.3;
    this.chestGroup.rotation.z = baseTorsoLean * 0.6 + this.aimPitchRad * 0.5;
    this.headGroup.rotation.z = -baseTorsoLean * 0.35 + this.aimPitchRad * 0.2;

    if (this.state === 'ragdoll') {
      this.eyeMat.emissive.setHex(0xef4444);
      this.eyeMat.emissiveIntensity = 3.0;
    } else if (this.state === 'flight' || this.inVault) {
      this.eyeMat.emissive.setHex(0x22d3ee);
      this.eyeMat.emissiveIntensity = 2.8;
    } else if (this.state === 'ledge_swing' || this.state === 'wall_slide') {
      this.eyeMat.emissive.setHex(0x06b6d4);
      this.eyeMat.emissiveIntensity = 2.4;
    } else {
      this.eyeMat.emissive.setHex(0xf59e0b);
      this.eyeMat.emissiveIntensity = 2.2;
    }

    if (this.grounded && Math.abs(this.currentVel.x) > 0.25 && this.state === 'run') {
      this.stridePhase =
        (this.stridePhase + Math.abs(this.currentVel.x) * dt * 1.55) % (Math.PI * 2);
      this.pelvisGroup.position.y = Math.abs(Math.sin(this.stridePhase)) * 0.09;
    } else {
      this.pelvisGroup.position.y = dampScalar(this.pelvisGroup.position.y, 0, 14, dt);
    }

    this.visualCore.updateMatrixWorld(true);

    const pelvisY = this.pelvisGroup.position.y;
    const shoulderWorldY = pelvisY + 0.49;

    const lHip = new THREE.Vector3(0, pelvisY, -0.075);
    const rHip = new THREE.Vector3(0, pelvisY, 0.075);
    const lShoulder = new THREE.Vector3(0.022, shoulderWorldY, -0.12);
    const rShoulder = new THREE.Vector3(0.022, shoulderWorldY, 0.12);

    this.leftHipJoint.position.copy(lHip);
    this.rightHipJoint.position.copy(rHip);
    this.leftShoulderJoint.position.copy(lShoulder);
    this.rightShoulderJoint.position.copy(rShoulder);

    const lFootTarget = new THREE.Vector3(-0.08, -this.baseFootBottom + 0.03, -0.085);
    const rFootTarget = new THREE.Vector3(0.08, -this.baseFootBottom + 0.03, 0.085);

    if (this.state === 'run') {
      const sL = Math.sin(this.stridePhase);
      const sR = Math.sin(this.stridePhase + Math.PI);
      const cL = Math.max(0, Math.cos(this.stridePhase));
      const cR = Math.max(0, Math.cos(this.stridePhase + Math.PI));

      lFootTarget.set(sL * 0.34, -this.baseFootBottom + 0.03 + cL * 0.21, -0.085);
      rFootTarget.set(sR * 0.34, -this.baseFootBottom + 0.03 + cR * 0.21, 0.085);
    } else if (this.state === 'crouch_slide') {
      lFootTarget.set(0.34, -this.baseFootBottom + 0.12, -0.09);
      rFootTarget.set(-0.24, -this.baseFootBottom + 0.08, 0.09);
    } else if (this.state === 'flight') {
      // Heroic aero-ninja hover / flight trail pose
      const hoverSway = Math.sin(performance.now() * 0.008) * 0.05;
      lFootTarget.set(-0.18, -this.baseFootBottom + 0.16 + hoverSway, -0.085);
      rFootTarget.set(0.08, -this.baseFootBottom + 0.28 - hoverSway, 0.085);
    } else if (!this.grounded && this.state !== 'ragdoll') {
      if (this.state === 'ledge_swing') {
        lFootTarget.set(-0.06 - this.ledgeOmega * 0.06, -this.baseFootBottom + 0.08, -0.085);
        rFootTarget.set(0.08 - this.ledgeOmega * 0.06, -this.baseFootBottom + 0.12, 0.085);
      } else {
        lFootTarget.set(-0.14, -this.baseFootBottom + 0.28, -0.085);
        rFootTarget.set(0.18, -this.baseFootBottom + 0.19, 0.085);
      }
    } else if (this.state === 'ragdoll') {
      const flail = Math.sin(this.ragdollTimer * 14);
      lFootTarget.set(flail * 0.22, -this.baseFootBottom + 0.22, -0.09);
      rFootTarget.set(-flail * 0.22, -this.baseFootBottom + 0.18, 0.09);
    }

    const activeGroups = this.getCollisionMask();
    if (this.grounded && this.state !== 'crouch_slide') {
      const rayOriginY = this.currentPos.y + 0.08 * this.currentScale;
      const footRayL = this.physics.castRay(
        this.currentPos.x + this.facing * lFootTarget.x * this.currentScale,
        rayOriginY,
        this.currentPos.z,
        0,
        -1,
        0,
        1.15 * this.currentScale,
        activeGroups,
        this.collider,
      );
      if (footRayL) {
        const hitLocalY = (footRayL.pointY - this.currentPos.y) / Math.max(0.2, this.currentScale) + 0.03;
        lFootTarget.y = Math.max(lFootTarget.y, THREE.MathUtils.clamp(hitLocalY, -0.82, -0.45));
      }
      const footRayR = this.physics.castRay(
        this.currentPos.x + this.facing * rFootTarget.x * this.currentScale,
        rayOriginY,
        this.currentPos.z,
        0,
        -1,
        0,
        1.15 * this.currentScale,
        activeGroups,
        this.collider,
      );
      if (footRayR) {
        const hitLocalY = (footRayR.pointY - this.currentPos.y) / Math.max(0.2, this.currentScale) + 0.03;
        rFootTarget.y = Math.max(rFootTarget.y, THREE.MathUtils.clamp(hitLocalY, -0.82, -0.45));
      }
    }

    const kneePoleL = new THREE.Vector3(0.45, -0.22, -0.105);
    const kneePoleR = new THREE.Vector3(0.45, -0.22, 0.105);

    solveTwoBoneIK(lHip, lFootTarget, kneePoleL, this.thighLen, this.shinLen, this.tmpV0, this.tmpV1);
    this.leftKneeJoint.position.copy(this.tmpV0);
    this.orientLimb(this.leftThigh, lHip, this.tmpV0, this.thighLen);
    this.orientLimb(this.leftShin, this.tmpV0, this.tmpV1, this.shinLen);
    this.leftFoot.position.set(this.tmpV1.x + 0.03, this.tmpV1.y - 0.015, this.tmpV1.z);

    solveTwoBoneIK(rHip, rFootTarget, kneePoleR, this.thighLen, this.shinLen, this.tmpV0, this.tmpV1);
    this.rightKneeJoint.position.copy(this.tmpV0);
    this.orientLimb(this.rightThigh, rHip, this.tmpV0, this.thighLen);
    this.orientLimb(this.rightShin, this.tmpV0, this.tmpV1, this.shinLen);
    this.rightFoot.position.set(this.tmpV1.x + 0.03, this.tmpV1.y - 0.015, this.tmpV1.z);

    const lHandTarget = new THREE.Vector3();
    const rHandTarget = new THREE.Vector3();

    if (this.state === 'ledge_swing') {
      lHandTarget.set(0.09, shoulderWorldY + 0.42, -0.105);
      rHandTarget.set(0.09, shoulderWorldY + 0.42, 0.105);
    } else if (this.state === 'wall_slide') {
      lHandTarget.set(0.28, shoulderWorldY + 0.18, -0.105);
      rHandTarget.set(0.28, shoulderWorldY + 0.12, 0.105);
    } else if (this.state === 'flight') {
      lHandTarget.set(-0.24, shoulderWorldY - 0.16, -0.16);
      rHandTarget.set(
        Math.cos(this.aimPitchRad) * 0.42,
        shoulderWorldY + Math.sin(this.aimPitchRad) * 0.42,
        0.14,
      );
    } else if (this.state === 'run') {
      const armSwing = Math.sin(this.stridePhase + Math.PI) * 0.28;
      lHandTarget.set(armSwing, shoulderWorldY - 0.28, -0.15);
      rHandTarget.set(
        Math.cos(this.aimPitchRad) * 0.42,
        shoulderWorldY + Math.sin(this.aimPitchRad) * 0.42,
        0.14,
      );
    } else {
      const breathe = Math.sin(performance.now() * 0.004) * 0.022;
      lHandTarget.set(0.14, shoulderWorldY - 0.34 + breathe, -0.15);
      rHandTarget.set(
        Math.cos(this.aimPitchRad) * 0.4,
        shoulderWorldY + Math.sin(this.aimPitchRad) * 0.4 + breathe,
        0.14,
      );
    }

    const elbowPoleL = new THREE.Vector3(-0.36, shoulderWorldY - 0.09, -0.16);
    const elbowPoleR = new THREE.Vector3(-0.36, shoulderWorldY - 0.09, 0.16);

    solveTwoBoneIK(lShoulder, lHandTarget, elbowPoleL, this.upperArmLen, this.forearmLen, this.tmpV0, this.tmpV1);
    this.leftElbowJoint.position.copy(this.tmpV0);
    this.orientLimb(this.leftUpperArm, lShoulder, this.tmpV0, this.upperArmLen);
    this.orientLimb(this.leftForearm, this.tmpV0, this.tmpV1, this.forearmLen);

    solveTwoBoneIK(rShoulder, rHandTarget, elbowPoleR, this.upperArmLen, this.forearmLen, this.tmpV0, this.tmpV1);
    this.rightElbowJoint.position.copy(this.tmpV0);
    this.orientLimb(this.rightUpperArm, rShoulder, this.tmpV0, this.upperArmLen);
    this.orientLimb(this.rightForearm, this.tmpV0, this.tmpV1, this.forearmLen);

    // 8-Segment Verlet Headband Scarf scaled proportionally with hero size
    this.scarfAnchor.getWorldPosition(this.tmpV0);
    this.chestGroup.getWorldPosition(this.tmpV1);
    const windTurbulence = this.isFlying ? 1.85 : 1.0;
    this.tmpV2.set(
      (-this.facing * 5.6 - this.currentVel.x * 0.72) * windTurbulence,
      (this.isFlying ? -4.2 : -8.0),
      Math.sin(performance.now() * 0.006) * 1.6,
    );

    solveVerletChain(
      this.scarfPositions,
      this.scarfPrevPositions,
      0.125 * this.currentScale,
      this.tmpV2,
      dt,
      0.95,
      3,
      this.tmpV0,
      this.tmpV1,
      0.32 * this.currentScale,
    );

    const scarfAttr = this.scarfMesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const arr = scarfAttr.array as Float32Array;
    for (let i = 0; i < this.scarfSegmentCount; i++) {
      const p = this.scarfPositions[i];
      const halfWidth = 0.048 * this.currentScale * (1 - i / (this.scarfSegmentCount * 1.35));
      const idx = i * 6;
      arr[idx] = p.x;
      arr[idx + 1] = p.y + halfWidth;
      arr[idx + 2] = p.z;
      arr[idx + 3] = p.x;
      arr[idx + 4] = p.y - halfWidth;
      arr[idx + 5] = p.z;
    }
    scarfAttr.needsUpdate = true;

    // Contact Blob Shadow
    const shadowRay = this.physics.castRay(
      this.currentPos.x,
      this.currentPos.y - 0.12 * this.currentScale,
      this.currentPos.z,
      0,
      -1,
      0,
      8.5,
      activeGroups,
      this.collider,
    );
    if (shadowRay) {
      this.blobShadowMesh.visible = true;
      this.blobShadowMesh.position.set(
        this.currentPos.x,
        shadowRay.pointY + 0.022,
        this.currentPos.z,
      );
      const heightAbove = Math.max(0, shadowRay.distance - 0.85 * this.currentScale);
      const shrink = THREE.MathUtils.clamp(1 - heightAbove * 0.14, 0.32, 1.0) * this.currentScale;
      this.blobShadowMesh.scale.set(shrink, 1, shrink);
      this.shadowMat.opacity = 0.72 * THREE.MathUtils.clamp(1 - heightAbove * 0.14, 0.3, 1.0);
    } else {
      this.blobShadowMesh.visible = false;
    }

    // Aura Halo, Flight Booster Glow & Smear Arc
    const auraY =
      this.currentPos.y +
      (this.state === 'crouch_slide' ? -0.06 : 0.22) * this.currentScale;
    const pulse =
      (1 +
        Math.sin(performance.now() * 0.006) * 0.05 +
        Math.min(0.22, Math.abs(this.currentVel.x) * 0.015) +
        (this.isFlying ? 0.16 : 0)) *
      this.currentScale;

    this.auraContrastMesh.position.set(this.currentPos.x, auraY, this.currentPos.z - 0.16);
    this.auraContrastMesh.scale.set(pulse, pulse, 1);

    this.auraGlowMesh.position.set(this.currentPos.x, auraY, this.currentPos.z - 0.13);
    this.auraGlowMesh.scale.set(pulse * 1.08, pulse * 1.08, 1);
    this.auraGlowMat.opacity =
      (this.isFlying ? 0.68 : 0.44) + Math.min(0.2, this.currentVel.length() * 0.018);

    if (this.smearTimer > 0) {
      this.smearTimer = Math.max(0, this.smearTimer - dt);
      this.smearArcMesh.visible = true;
      this.smearArcMesh.position.copy(this.currentPos);
      this.smearArcMesh.scale.setScalar(this.currentScale);
      this.smearArcMesh.rotation.set(0, 0, this.smearAngle);
      this.smearMat.opacity = THREE.MathUtils.clamp(this.smearTimer * 7.5, 0, 0.85);
    } else {
      this.smearArcMesh.visible = false;
    }

    if (this.tetherFlashTimer > 0) {
      this.tetherFlashTimer = Math.max(0, this.tetherFlashTimer - dt);
      this.tetherLine.visible = true;
      const tPos = this.tetherLine.geometry.getAttribute('position') as THREE.BufferAttribute;
      tPos.setXYZ(0, this.tetherOrigin.x, this.tetherOrigin.y, this.tetherOrigin.z);
      tPos.setXYZ(1, this.currentPos.x, this.currentPos.y + 0.4 * this.currentScale, this.currentPos.z);
      tPos.needsUpdate = true;
      this.tetherMat.opacity = THREE.MathUtils.clamp(this.tetherFlashTimer * 2.4, 0, 1);
    } else {
      this.tetherLine.visible = false;
    }
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    for (const t of this.textures) t.dispose();
  }
}
