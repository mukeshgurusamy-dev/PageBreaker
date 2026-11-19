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

/**
 * 16-Part Procedural 3D Stickman Hero Rig + Parkour & Active-Ragdoll Controller:
 * - Zero .glb dependencies, bottom-center grounded alignment, matte carbon vs glossy titanium PBR contrast
 * - 8-segment Verlet headband scarf with chest radial clamping
 * - Alan Becker anticipation coil, volume-preserving squash & stretch, additive smear arcs
 * - David Rosen 4-keypose stride + Rune Johansen raycast footbase placement
 * - 30% / 50% / 20% spine aim offset + +/-12px cursor-flip hysteresis + 2-Bone Pole-Vector IK
 * - Celeste 3-phase jump gravity, 100ms Coyote Time, 110ms Jump Buffer, Wall-Slide/Kick, Crouch-Slide,
 *   360-deg Shoulder-Roll, Nearest-Component Fall-Grab Pendulum Swing, Landfall PD Active-Ragdoll,
 *   and 3 Integrity Lives + Void-Fall Tether Rescue.
 */
export class StickmanRig {
  public readonly rootGroup = new THREE.Group();
  public readonly body: RAPIER.RigidBody;
  public readonly collider: RAPIER.Collider;
  public readonly controller: RAPIER.KinematicCharacterController;

  // Exposed sockets for Steps 4-5 weapons & gadgets
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

  // Verlet headband scarf & radial blob shadow & additive smear & void rescue tether
  private readonly scarfMesh: THREE.Mesh;
  private readonly scarfPositions: THREE.Vector3[] = [];
  private readonly scarfPrevPositions: THREE.Vector3[] = [];
  private readonly scarfSegmentCount = 8;
  private readonly blobShadowMesh: THREE.Mesh;
  private readonly smearArcMesh: THREE.Mesh;
  private readonly tetherLine: THREE.Line;
  private readonly eyeMat: THREE.MeshStandardMaterial;
  private readonly smearMat: THREE.MeshBasicMaterial;
  private readonly shadowMat: THREE.MeshBasicMaterial;
  private readonly tetherMat: THREE.LineBasicMaterial;

  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly textures: THREE.Texture[] = [];

  // Physics & Parkour State
  private readonly physics: PhysicsWorld;
  private readonly spawnPos = new THREE.Vector3(-4.5, 1.45, SPATIAL_CONSTANTS.BAND_PLAY_Z);
  private readonly lastSafePos = new THREE.Vector3(-4.5, 1.45, SPATIAL_CONSTANTS.BAND_PLAY_Z);
  private readonly currentPos = new THREE.Vector3(-4.5, 1.45, SPATIAL_CONSTANTS.BAND_PLAY_Z);
  private readonly currentVel = new THREE.Vector3();

  private state: StickmanParkourState = 'idle';
  private grounded = false;
  private coyoteTimer = 0;
  private jumpBufferTimer = 0;
  private airJumpsRemaining = 1;
  private wallTouchDir = 0; // -1 wall on left, +1 wall on right, 0 none
  private facing = 1; // +1 right, -1 left
  private facingYaw = -0.22;

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
  private ledgeRopeLen = 0.85;
  private ledgeTheta = 0; // Angle below straight down (0 = hanging vertically)
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

  private readonly capsuleHalfHeight = 0.28;
  private readonly capsuleRadius = 0.16;
  private readonly footBottomOffset = 0.44; // halfHeight + radius

  // Limb dimensions
  private readonly thighLen = 0.22;
  private readonly shinLen = 0.22;
  private readonly upperArmLen = 0.18;
  private readonly forearmLen = 0.17;

  constructor(physics: PhysicsWorld, scene: THREE.Scene, startX = -4.5, startY = 1.45) {
    this.physics = physics;
    this.spawnPos.set(startX, startY, SPATIAL_CONSTANTS.BAND_PLAY_Z);
    this.lastSafePos.copy(this.spawnPos);
    this.currentPos.copy(this.spawnPos);

    const phys = physics.createStickmanBody(
      startX,
      startY,
      SPATIAL_CONSTANTS.BAND_PLAY_Z,
      this.capsuleHalfHeight,
      this.capsuleRadius,
    );
    this.body = phys.body;
    this.collider = phys.collider;
    this.controller = phys.controller;

    // Tactile PBR Materials: Matte Obsidian Carbon vs Glossy Titanium vs Crimson Headband
    const carbonMat = new THREE.MeshStandardMaterial({
      color: 0x17181f,
      roughness: 0.74,
      metalness: 0.16,
    });
    const jointMat = new THREE.MeshStandardMaterial({
      color: 0xcbd5e1,
      roughness: 0.2,
      metalness: 0.86,
    });
    const bandMat = new THREE.MeshStandardMaterial({
      color: 0xdc2626,
      roughness: 0.56,
      metalness: 0.12,
      side: THREE.DoubleSide,
    });
    const visorBackMat = new THREE.MeshStandardMaterial({
      color: 0x09090b,
      roughness: 0.22,
      metalness: 0.6,
    });
    this.eyeMat = new THREE.MeshStandardMaterial({
      color: 0xfef08a,
      emissive: 0xf59e0b,
      emissiveIntensity: 2.2,
      roughness: 0.15,
    });
    this.materials.push(carbonMat, jointMat, bandMat, visorBackMat, this.eyeMat);

    // Geometries scaled cleanly to match 0.9m agile stickman ninja
    const pelvisGeo = new THREE.SphereGeometry(0.075, 14, 10);
    const abdomenGeo = new THREE.CapsuleGeometry(0.055, 0.08, 6, 12);
    const chestGeo = new THREE.CapsuleGeometry(0.075, 0.11, 6, 14);
    const collarGeo = new THREE.TorusGeometry(0.07, 0.015, 8, 18);
    const headGeo = new THREE.SphereGeometry(0.085, 18, 14);
    const headbandGeo = new THREE.CylinderGeometry(0.088, 0.088, 0.03, 18, 1, true);
    const visorGeo = new THREE.BoxGeometry(0.055, 0.038, 0.095);
    const eyeGeo = new THREE.BoxGeometry(0.022, 0.016, 0.024);
    const limbGeo = new THREE.CylinderGeometry(0.028, 0.028, 1.0, 10);
    const thighGeo = new THREE.CylinderGeometry(0.035, 0.03, 1.0, 10);
    const jointGeo = new THREE.SphereGeometry(0.038, 12, 10);
    const footGeo = new THREE.BoxGeometry(0.11, 0.038, 0.065);

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
    this.torsoLowerGroup.position.set(0, 0.075, 0);
    const abdomenMesh = new THREE.Mesh(abdomenGeo, carbonMat);
    abdomenMesh.position.set(0, 0.04, 0);
    abdomenMesh.castShadow = true;
    this.torsoLowerGroup.add(abdomenMesh);
    this.pelvisGroup.add(this.torsoLowerGroup);

    // Chest (50% aim share)
    this.chestGroup.position.set(0, 0.115, 0);
    const chestMesh = new THREE.Mesh(chestGeo, carbonMat);
    chestMesh.position.set(0, 0.055, 0);
    chestMesh.castShadow = true;
    const collarMesh = new THREE.Mesh(collarGeo, jointMat);
    collarMesh.rotation.x = Math.PI * 0.5;
    collarMesh.position.set(0, 0.115, 0);
    this.chestGroup.add(chestMesh, collarMesh, this.backHolsterSocket);
    this.backHolsterSocket.position.set(-0.1, 0.06, 0);
    this.torsoLowerGroup.add(this.chestGroup);

    // Head (20% aim share) + Crimson Headband + Dual Visor Eyes
    this.headGroup.position.set(0, 0.17, 0);
    const headMesh = new THREE.Mesh(headGeo, carbonMat);
    headMesh.position.set(0, 0.075, 0);
    headMesh.castShadow = true;

    const headbandMesh = new THREE.Mesh(headbandGeo, bandMat);
    headbandMesh.position.set(0, 0.105, 0);

    const visorMesh = new THREE.Mesh(visorGeo, visorBackMat);
    visorMesh.position.set(0.06, 0.078, 0);

    this.eyeLeftMesh = new THREE.Mesh(eyeGeo, this.eyeMat);
    this.eyeLeftMesh.position.set(0.08, 0.08, 0.025);
    this.eyeRightMesh = new THREE.Mesh(eyeGeo, this.eyeMat);
    this.eyeRightMesh.position.set(0.08, 0.08, -0.025);

    this.scarfAnchor.position.set(-0.075, 0.105, 0);
    this.headGroup.add(
      headMesh,
      headbandMesh,
      visorMesh,
      this.eyeLeftMesh,
      this.eyeRightMesh,
      this.scarfAnchor,
    );
    this.chestGroup.add(this.headGroup);

    // Limb Meshes (rendered inside visualCore space driven by exact world->local IK targets)
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

    // 8-Segment Verlet Headband Scarf (World-space triangle strip)
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
      const p = new THREE.Vector3(startX - i * 0.08, startY + 0.52, SPATIAL_CONSTANTS.BAND_PLAY_Z);
      this.scarfPositions.push(p.clone());
      this.scarfPrevPositions.push(p.clone());
    }

    // Contact Blob Shadow (raycasted cleanly onto terrain beneath stickman)
    const shadowTex = createBlobShadowTexture();
    this.textures.push(shadowTex);
    const shadowGeo = new THREE.PlaneGeometry(0.95, 0.55);
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

    // 1-2 Frame Additive Smear Arc (burst jumps, wall-kicks, shoulder-rolls)
    const smearGeo = new THREE.RingGeometry(0.28, 0.62, 16, 1, -0.8, 1.6);
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

  getIntegrityLives(): number {
    return this.integrityLives;
  }

  triggerRagdoll(impulseX = 0, impulseY = 5.5, spinZ = 7.5): void {
    if (this.state === 'ragdoll') return;
    if (this.colliderCrouched) {
      this.colliderCrouched = false;
      this.collider.setHalfHeight(this.capsuleHalfHeight);
      this.collider.setTranslationWrtParent({ x: 0, y: 0, z: 0 });
    }
    this.state = 'ragdoll';
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
    if (this.colliderCrouched) {
      this.colliderCrouched = false;
      this.collider.setHalfHeight(this.capsuleHalfHeight);
      this.collider.setTranslationWrtParent({ x: 0, y: 0, z: 0 });
    }
    this.state = 'idle';
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
        this.spawnPos.x - i * 0.08,
        this.spawnPos.y + 0.52,
        this.spawnPos.z,
      );
      this.scarfPrevPositions[i].copy(this.scarfPositions[i]);
    }
  }

  private triggerSmear(duration: number, angleRad: number): void {
    this.smearTimer = duration;
    this.smearAngle = angleRad;
  }

  step(fixedDt: number, input: StickmanInputState): StickmanStepResult {
    let impactStrength = 0;
    let lostLifeToVoid = false;

    if (this.ledgeCooldown > 0) this.ledgeCooldown = Math.max(0, this.ledgeCooldown - fixedDt);

    // -------------------------------------------------------------------------
    // Cursor Aim + +/-12px (0.18m) Hysteresis Flip Guard
    // -------------------------------------------------------------------------
    const dxAim = input.aimWorldX - this.currentPos.x;
    const dyAim = input.aimWorldY - (this.currentPos.y + 0.34);
    const deadbandM = 0.18; // ~11.5px at 64px/m
    if (Math.abs(dxAim) > deadbandM) {
      this.facing = dxAim >= 0 ? 1 : -1;
    } else if (input.left !== input.right) {
      this.facing = input.right ? 1 : -1;
    }

    const absDxAim = Math.max(0.15, Math.abs(dxAim));
    this.aimPitchRad = THREE.MathUtils.clamp(Math.atan2(dyAim, absDxAim), -1.25, 1.25);

    // -------------------------------------------------------------------------
    // Branch 1: Landfall Quaternion PD Active-Ragdoll & Kip-Up
    // -------------------------------------------------------------------------
    if (this.state === 'ragdoll') {
      const tr = this.body.translation();
      const rot = this.body.rotation();
      const lv = this.body.linvel();
      const av = this.body.angvel();

      this.currentPos.set(tr.x, tr.y, SPATIAL_CONSTANTS.BAND_PLAY_Z);
      this.currentVel.set(lv.x, lv.y, 0);
      this.ragdollQuat.set(rot.x, rot.y, rot.z, rot.w);

      this.ragdollTimer += fixedDt;

      // Signed shortest angle error around Z back toward upright (rotZ = 0)
      const angleZ = 2 * Math.atan2(rot.z, rot.w);
      const normalizedErr = Math.atan2(Math.sin(-angleZ), Math.cos(-angleZ));

      // First 0.42s: loose human flail; then ramp PD Kp -> 100% upright recovery
      const recoverAlpha = THREE.MathUtils.clamp((this.ragdollTimer - 0.42) / 0.52, 0, 1);
      const kp = THREE.MathUtils.lerp(4.0, 105.0, recoverAlpha * recoverAlpha);
      const kd = THREE.MathUtils.lerp(1.4, 11.0, recoverAlpha);
      const torqueImpulseZ = (kp * normalizedErr - kd * av.z) * fixedDt;
      this.body.applyTorqueImpulse({ x: 0, y: 0, z: torqueImpulseZ }, true);

      // Check ground ray during recovery
      const floorHit = this.physics.castRay(
        this.currentPos.x,
        this.currentPos.y,
        this.currentPos.z,
        0,
        -1,
        0,
        this.footBottomOffset + 0.3,
        undefined,
        this.collider,
      );

      if (
        this.ragdollTimer > 0.95 &&
        (floorHit !== null || Math.abs(lv.y) < 1.5) &&
        (Math.abs(normalizedErr) < 0.55 || this.ragdollTimer > 1.75)
      ) {
        // Transition into acrobatic Kip-Up recovery
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
      // Branch 2: Nearest-Component Fall-Grab Pendulum Swing
      // -----------------------------------------------------------------------
      const moveAxis = (input.right ? 1 : 0) - (input.left ? 1 : 0);
      const gravityG = 22.0;
      const pumpAccel = moveAxis * 16.5;
      const angularAccel = -(gravityG / this.ledgeRopeLen) * Math.sin(this.ledgeTheta) + pumpAccel;
      this.ledgeOmega = (this.ledgeOmega + angularAccel * fixedDt) * 0.992;
      this.ledgeTheta = THREE.MathUtils.clamp(
        this.ledgeTheta + this.ledgeOmega * fixedDt,
        -1.38,
        1.38,
      );

      // Keep body suspended cleanly below corner anchor
      const handToCenterDist = this.ledgeRopeLen;
      const targetX = this.ledgeAnchorX + Math.sin(this.ledgeTheta) * handToCenterDist;
      const targetY = this.ledgeAnchorY - Math.cos(this.ledgeTheta) * handToCenterDist - 0.35;
      this.currentPos.set(targetX, targetY, SPATIAL_CONSTANTS.BAND_PLAY_Z);
      this.body.setNextKinematicTranslation({
        x: this.currentPos.x,
        y: this.currentPos.y,
        z: this.currentPos.z,
      });

      // Tangential velocity vector v = r * omega * tangent
      const tanX = Math.cos(this.ledgeTheta);
      const tanY = Math.sin(this.ledgeTheta);
      const tangentialSpeed = handToCenterDist * this.ledgeOmega;
      this.currentVel.set(tanX * tangentialSpeed, tanY * tangentialSpeed, 0);

      if (input.jumpPressedThisFrame) {
        // Release pendulum with true tangential momentum + upward vault assist
        this.currentVel.x = tanX * tangentialSpeed * 1.25 + moveAxis * 3.8;
        this.currentVel.y = Math.max(8.2, tanY * tangentialSpeed + 7.2);
        this.state = 'jump_rise';
        this.ledgeCooldown = 0.34;
        this.airJumpsRemaining = 1;
        this.squashSpring.impulse(5.8);
        this.triggerSmear(0.11, Math.atan2(this.currentVel.y, this.currentVel.x));
      } else if (input.crouchHeld) {
        this.state = 'fast_fall';
        this.ledgeCooldown = 0.35;
        this.currentVel.y = -2.5;
      }
    } else {
      // -----------------------------------------------------------------------
      // Branch 3: KinematicCharacterController Celeste / N++ Parkour Loop
      // -----------------------------------------------------------------------
      const moveAxis = (input.right ? 1 : 0) - (input.left ? 1 : 0);

      // Update timers
      if (this.grounded) {
        this.coyoteTimer = 0.1; // 100ms Coyote Time
        this.airJumpsRemaining = 1;
      } else {
        this.coyoteTimer = Math.max(0, this.coyoteTimer - fixedDt);
      }

      if (input.jumpPressedThisFrame) {
        this.jumpBufferTimer = 0.11; // 110ms Input Buffer
      } else {
        this.jumpBufferTimer = Math.max(0, this.jumpBufferTimer - fixedDt);
      }

      if (this.kipUpTimer > 0) this.kipUpTimer = Math.max(0, this.kipUpTimer - fixedDt);
      if (this.rollTimer > 0) this.rollTimer = Math.max(0, this.rollTimer - fixedDt);
      if (this.dropThroughTimer > 0) {
        this.dropThroughTimer = Math.max(0, this.dropThroughTimer - fixedDt);
      }

      // Drop-Through trigger: S + Space, or holding S on a one-way ledge
      if (input.crouchHeld) {
        this.crouchHoldTimer += fixedDt;
        if (
          input.jumpPressedThisFrame ||
          (this.grounded && this.crouchHoldTimer > 0.16 && Math.abs(this.currentVel.x) < 0.6)
        ) {
          this.dropThroughTimer = 0.28;
          this.crouchHoldTimer = 0;
          this.grounded = false;
          this.currentVel.y = -3.5;
          this.squashSpring.impulse(-4.5);
        }
      } else {
        this.crouchHoldTimer = 0;
      }

      // Headroom clearance check so stickman stays crouched while sliding under low tunnel bars
      let headBlocked = false;
      if (this.colliderCrouched && !input.crouchHeld) {
        const ceilHit = this.physics.castRay(
          this.currentPos.x,
          this.currentPos.y - 0.1,
          this.currentPos.z,
          0,
          1,
          0,
          0.55,
          undefined,
          this.collider,
        );
        headBlocked = ceilHit !== null;
      }

      const wasCrouched = this.colliderCrouched;
      const effectivelyCrouched = (input.crouchHeld && this.grounded) || headBlocked;
      if (effectivelyCrouched && !this.colliderCrouched) {
        this.colliderCrouched = true;
        this.collider.setHalfHeight(0.12);
        this.collider.setTranslationWrtParent({ x: 0, y: -0.16, z: 0 });
      } else if (!effectivelyCrouched && this.colliderCrouched) {
        this.colliderCrouched = false;
        this.collider.setHalfHeight(this.capsuleHalfHeight);
        this.collider.setTranslationWrtParent({ x: 0, y: 0, z: 0 });
      }

      // Horizontal acceleration & Crouch-Slide
      const wantsSlide =
        effectivelyCrouched && this.grounded && Math.abs(this.currentVel.x) > 1.2;
      if (wantsSlide && !wasCrouched && Math.abs(this.currentVel.x) > 2.0) {
        this.currentVel.x = Math.sign(this.currentVel.x) * 11.2;
        this.triggerSmear(0.11, 0);
      }
      const targetMaxSpeed = wantsSlide
        ? 11.2
        : effectivelyCrouched && this.grounded
          ? 4.0
          : 8.6;
      const accelRate = this.grounded ? (wantsSlide ? 12.0 : 58.0) : 34.0;

      if (this.rollTimer > 0) {
        this.currentVel.x = this.rollDir * Math.max(6.8, Math.abs(this.currentVel.x));
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

      // Anticipation Jump Queue (65ms micro-coil for weighty grounded leaps)
      if (this.jumpBufferTimer > 0 && (this.coyoteTimer > 0 || this.wallTouchDir !== 0 || this.airJumpsRemaining > 0)) {
        if (this.coyoteTimer > 0 && !this.pendingJumpImpulse && this.rollTimer <= 0) {
          this.pendingJumpImpulse = true;
          this.anticipationTimer = 0.045;
          this.jumpBufferTimer = 0;
          this.coyoteTimer = 0;
          this.squashSpring.impulse(-8.5);
        } else if (this.wallTouchDir !== 0 && !this.grounded) {
          // Wall-Kick diagonally away from wall face
          this.currentVel.x = -this.wallTouchDir * 9.8;
          this.currentVel.y = 11.6;
          this.facing = -this.wallTouchDir;
          this.jumpBufferTimer = 0;
          this.squashSpring.impulse(7.2);
          this.triggerSmear(0.11, Math.atan2(this.currentVel.y, this.currentVel.x));
          impactStrength = 0.25;
        } else if (this.airJumpsRemaining > 0 && !this.grounded && !this.pendingJumpImpulse) {
          this.airJumpsRemaining--;
          this.currentVel.y = 11.2;
          this.jumpBufferTimer = 0;
          this.squashSpring.impulse(6.8);
          this.triggerSmear(0.12, Math.PI * 0.5);
          impactStrength = 0.2;
        }
      }

      if (this.pendingJumpImpulse) {
        this.anticipationTimer -= fixedDt;
        if (this.anticipationTimer <= 0) {
          this.pendingJumpImpulse = false;
          this.currentVel.y = 12.2;
          this.grounded = false;
          this.squashSpring.impulse(8.0);
          this.triggerSmear(0.1, Math.PI * 0.5);
        }
      }

      // Celeste 3-Phase Asymmetric Jump Gravity + Short-Hop Cut
      let gravityScale = 1.0;
      if (!this.grounded) {
        if (this.currentVel.y > 0 && !input.jumpHeld) {
          // Early release cuts jump cleanly for responsive platforming
          gravityScale = 2.35;
        } else if (Math.abs(this.currentVel.y) < 2.2) {
          // Apex Hang float window
          gravityScale = 0.5;
        } else if (this.currentVel.y < 0) {
          // Snappy Fast Fall
          gravityScale = 2.1;
        }
      }

      this.currentVel.y = Math.max(-22.0, this.currentVel.y - 26.0 * gravityScale * fixedDt);

      // Wall-Slide friction cap
      if (!this.grounded && this.wallTouchDir !== 0 && this.currentVel.y < -3.2 && moveAxis === this.wallTouchDir) {
        this.currentVel.y = -3.2;
      }

      // Compute Rapier KCC movement with One-Way Drop-Through Platform Filter
      const prevGrounded = this.grounded;
      const preImpactVy = this.currentVel.y;

      const desiredDx = this.currentVel.x * fixedDt;
      const desiredDy = this.currentVel.y * fixedDt;

      const footY = this.currentPos.y - this.footBottomOffset;
      const isDropping = this.dropThroughTimer > 0;
      const vy = this.currentVel.y;

      const filterPredicate = (c: RAPIER.Collider): boolean => {
        if (!this.physics.isOneWayPlatform(c.handle)) {
          return true; // base floor and arena walls always solid
        }
        if (isDropping) {
          return false; // active drop through ledge
        }
        if (vy > 0.08) {
          return false; // upward jump passes right through
        }
        const info = this.physics.getPlatformInfo(c.handle);
        if (info) {
          const ledgeTop = info.block.y + info.block.halfH;
          if (footY < ledgeTop - 0.08) {
            return false; // feet below top of platform; do not block from bottom or sides
          }
        }
        return true;
      };

      this.controller.computeColliderMovement(
        this.collider,
        { x: desiredDx, y: desiredDy, z: 0 },
        undefined,
        packInteractionGroups(
          COLLISION_GROUP.PLAYER,
          COLLISION_GROUP.TERRAIN | COLLISION_GROUP.CARD_SHELL | COLLISION_GROUP.CARD_INTERIOR,
        ),
        filterPredicate,
      );

      const resolved = this.controller.computedMovement();
      this.currentPos.x += resolved.x;
      this.currentPos.y += resolved.y;
      this.currentPos.z = SPATIAL_CONSTANTS.BAND_PLAY_Z;
      this.body.setNextKinematicTranslation({
        x: this.currentPos.x,
        y: this.currentPos.y,
        z: this.currentPos.z,
      });

      this.grounded = this.controller.computedGrounded();

      // Wall & Ceiling collision inspection
      this.wallTouchDir = 0;
      const numCol = this.controller.numComputedCollisions();
      for (let i = 0; i < numCol; i++) {
        const col = this.controller.computedCollision(i);
        if (!col) continue;
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

      // Landing Response: 360-deg Shoulder-Roll or Volume-Preserving Compression
      if (this.grounded) {
        this.lastSafePos.copy(this.currentPos);
        if (!prevGrounded && preImpactVy < -2.5) {
          const squashForce = THREE.MathUtils.clamp(Math.abs(preImpactVy) * 0.55, 1.5, 9.5);
          this.squashSpring.impulse(-squashForce);
          impactStrength = THREE.MathUtils.clamp(Math.abs(preImpactVy) / 18.0, 0.08, 0.75);

          if (preImpactVy < -10.2 && (Math.abs(this.currentVel.x) > 2.0 || input.crouchHeld)) {
            // 360-deg Parkour Shoulder-Roll preserves forward momentum!
            this.rollTimer = 0.34;
            this.rollDir = moveAxis !== 0 ? moveAxis : this.facing;
            this.triggerSmear(0.14, 0);
          }
        }
        if (this.currentVel.y < 0) this.currentVel.y = 0;
      }

      // Nearest-Component Fall-Grab Check (when airborne near edge & falling or holding F)
      if (!this.grounded && this.ledgeCooldown <= 0 && (this.currentVel.y < 1.5 || input.grabHeld)) {
        const corner = this.physics.findNearestGrabbableCorner(
          this.currentPos.x,
          this.currentPos.y + 0.52,
          0.95,
          moveAxis,
        );
        if (corner && (input.grabHeld || moveAxis !== 0)) {
          this.state = 'ledge_swing';
          this.ledgeAnchorX = corner.x;
          this.ledgeAnchorY = corner.y;
          this.ledgeRopeLen = 0.72;
          const dxCorner = this.currentPos.x - corner.x;
          this.ledgeTheta = THREE.MathUtils.clamp(Math.atan2(dxCorner, 0.72), -1.1, 1.1);
          this.ledgeOmega = THREE.MathUtils.clamp(this.currentVel.x * 0.6, -4.5, 4.5);
          this.airJumpsRemaining = 1;
          this.squashSpring.impulse(3.5);
        }
      }

      // Determine high-level parkour state label cleanly
      if (this.state !== 'ledge_swing') {
        if (this.kipUpTimer > 0) {
          this.state = 'kip_up';
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
    // Branch 4: Emergency Void-Fall Tether Rescue & 3 Integrity Lives
    // -------------------------------------------------------------------------
    if (this.currentPos.y < this.voidFloorY) {
      lostLifeToVoid = true;
      this.integrityLives = Math.max(0, this.integrityLives - 1);
      this.tetherOrigin.copy(this.currentPos);
      this.tetherFlashTimer = 0.42;

      const rescueTarget = this.integrityLives > 0 ? this.lastSafePos : this.spawnPos;
      if (this.integrityLives === 0) {
        // Playground auto-restore after depleting 3 lives so user can keep testing seamlessly
        this.integrityLives = this.maxIntegrityLives;
      }

      this.currentPos.set(rescueTarget.x, rescueTarget.y + 0.85, SPATIAL_CONSTANTS.BAND_PLAY_Z);
      this.currentVel.set(0, 3.2, 0);
      this.state = 'jump_rise';
      this.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
      this.body.setTranslation(
        { x: this.currentPos.x, y: this.currentPos.y, z: this.currentPos.z },
        true,
      );
      this.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
      this.ragdollQuat.identity();
      this.squashSpring.impulse(7.5);
      impactStrength = 0.55;
    }

    // Update procedural visuals, IK limbs, Verlet scarf, and contact shadow
    this.updateProceduralPose(fixedDt);

    return {
      state: this.state,
      grounded: this.grounded,
      speed: Math.hypot(this.currentVel.x, this.currentVel.y),
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
    // Smooth 3/4 facing yaw passing cleanly in front (+Z) of camera
    const targetYaw = this.facing > 0 ? -0.22 : -(Math.PI - 0.22);
    this.facingYaw = dampScalar(this.facingYaw, targetYaw, 15.0, dt);

    this.rootGroup.position.copy(this.currentPos);
    if (this.state === 'ragdoll') {
      this.rootGroup.quaternion.copy(this.ragdollQuat);
    } else {
      this.rootGroup.rotation.set(0, 0, 0);
    }

    // Volume-preserving squash & stretch + Shoulder-roll spin
    const targetSquashY =
      this.state === 'crouch_slide'
        ? 0.72
        : this.state === 'jump_rise'
          ? 1.12
          : this.state === 'fast_fall'
            ? 1.08
            : 1.0;
    const squashY = this.squashSpring.update(dt, targetSquashY);
    computeVolumePreservingScale(squashY, 0.85, this.tmpV0);
    this.visualCore.scale.copy(this.tmpV0);
    this.visualCore.rotation.set(0, this.facingYaw, 0);

    if (this.state === 'shoulder_roll') {
      const p = 1 - this.rollTimer / 0.34;
      this.visualCore.rotation.z = -this.rollDir * p * Math.PI * 2;
      this.visualCore.position.y = -0.18 * Math.sin(p * Math.PI);
    } else if (this.state === 'crouch_slide') {
      this.visualCore.position.y = -0.24;
    } else {
      this.visualCore.position.y = 0;
    }

    // Line-of-action spine pitch + 30% / 50% / 20% Aim Distribution
    const speedRatio = THREE.MathUtils.clamp(Math.abs(this.currentVel.x) / 8.6, 0, 1);
    const runLean = this.grounded ? -speedRatio * 0.22 : -THREE.MathUtils.clamp(this.currentVel.x * 0.025, -0.25, 0.25);
    const crouchLean = this.state === 'crouch_slide' ? -0.58 : 0;
    const baseTorsoLean = runLean + crouchLean;

    this.torsoLowerGroup.rotation.z = baseTorsoLean * 0.4 + this.aimPitchRad * 0.3;
    this.chestGroup.rotation.z = baseTorsoLean * 0.6 + this.aimPitchRad * 0.5;
    this.headGroup.rotation.z = -baseTorsoLean * 0.35 + this.aimPitchRad * 0.2;

    // Expressive glowing eye color shifts subtly by kinetic state
    if (this.state === 'ragdoll') {
      this.eyeMat.emissive.setHex(0xef4444);
      this.eyeMat.emissiveIntensity = 3.0;
    } else if (this.state === 'ledge_swing' || this.state === 'wall_slide') {
      this.eyeMat.emissive.setHex(0x06b6d4);
      this.eyeMat.emissiveIntensity = 2.4;
    } else {
      this.eyeMat.emissive.setHex(0xf59e0b);
      this.eyeMat.emissiveIntensity = 2.2;
    }

    // Advance David Rosen 4-Keypose Stride Wheel
    if (this.grounded && Math.abs(this.currentVel.x) > 0.25 && this.state === 'run') {
      this.stridePhase = (this.stridePhase + Math.abs(this.currentVel.x) * dt * 2.15) % (Math.PI * 2);
      this.pelvisGroup.position.y = Math.abs(Math.sin(this.stridePhase)) * 0.065;
    } else {
      this.pelvisGroup.position.y = dampScalar(this.pelvisGroup.position.y, 0, 14, dt);
    }

    // Force matrix sync for exact world-to-visualCore socket transforms
    this.visualCore.updateMatrixWorld(true);

    // Compute Shoulder & Hip positions in visualCore local space (+X forward, +Y up, +Z right side)
    const pelvisY = this.pelvisGroup.position.y;
    const shoulderWorldY = pelvisY + 0.32;

    const lHip = new THREE.Vector3(0, pelvisY, -0.05);
    const rHip = new THREE.Vector3(0, pelvisY, 0.05);
    const lShoulder = new THREE.Vector3(0.015, shoulderWorldY, -0.08);
    const rShoulder = new THREE.Vector3(0.015, shoulderWorldY, 0.08);

    this.leftHipJoint.position.copy(lHip);
    this.rightHipJoint.position.copy(rHip);
    this.leftShoulderJoint.position.copy(lShoulder);
    this.rightShoulderJoint.position.copy(rShoulder);

    // Compute Foot Targets (Rosen stride + Johansen raycast footbase clamping)
    const lFootTarget = new THREE.Vector3(-0.05, -this.footBottomOffset + 0.02, -0.055);
    const rFootTarget = new THREE.Vector3(0.05, -this.footBottomOffset + 0.02, 0.055);

    if (this.state === 'run') {
      const sL = Math.sin(this.stridePhase);
      const sR = Math.sin(this.stridePhase + Math.PI);
      const cL = Math.max(0, Math.cos(this.stridePhase));
      const cR = Math.max(0, Math.cos(this.stridePhase + Math.PI));

      lFootTarget.set(sL * 0.22, -this.footBottomOffset + 0.02 + cL * 0.14, -0.055);
      rFootTarget.set(sR * 0.22, -this.footBottomOffset + 0.02 + cR * 0.14, 0.055);
    } else if (this.state === 'crouch_slide') {
      lFootTarget.set(0.22, -this.footBottomOffset + 0.08, -0.06);
      rFootTarget.set(-0.16, -this.footBottomOffset + 0.05, 0.06);
    } else if (!this.grounded && this.state !== 'ragdoll') {
      if (this.state === 'ledge_swing') {
        lFootTarget.set(-0.04 - this.ledgeOmega * 0.04, -this.footBottomOffset + 0.05, -0.055);
        rFootTarget.set(0.05 - this.ledgeOmega * 0.04, -this.footBottomOffset + 0.08, 0.055);
      } else {
        // Dynamic parkour air tuck
        lFootTarget.set(-0.09, -this.footBottomOffset + 0.18, -0.055);
        rFootTarget.set(0.12, -this.footBottomOffset + 0.12, 0.055);
      }
    } else if (this.state === 'ragdoll') {
      const flail = Math.sin(this.ragdollTimer * 14);
      lFootTarget.set(flail * 0.15, -this.footBottomOffset + 0.15, -0.06);
      rFootTarget.set(-flail * 0.15, -this.footBottomOffset + 0.12, 0.06);
    }

    // Rune Johansen Raycast Footbase Adjustment when grounded on uneven steps
    if (this.grounded && this.state !== 'crouch_slide') {
      const rayOriginY = this.currentPos.y + 0.05;
      const footRayL = this.physics.castRay(
        this.currentPos.x + this.facing * lFootTarget.x,
        rayOriginY,
        this.currentPos.z,
        0,
        -1,
        0,
        0.8,
        undefined,
        this.collider,
      );
      if (footRayL) {
        const hitLocalY = footRayL.pointY - this.currentPos.y + 0.02;
        lFootTarget.y = Math.max(lFootTarget.y, THREE.MathUtils.clamp(hitLocalY, -0.55, -0.32));
      }
      const footRayR = this.physics.castRay(
        this.currentPos.x + this.facing * rFootTarget.x,
        rayOriginY,
        this.currentPos.z,
        0,
        -1,
        0,
        0.8,
        undefined,
        this.collider,
      );
      if (footRayR) {
        const hitLocalY = footRayR.pointY - this.currentPos.y + 0.02;
        rFootTarget.y = Math.max(rFootTarget.y, THREE.MathUtils.clamp(hitLocalY, -0.55, -0.32));
      }
    }

    // Solve 2-Bone Pole IK for Both Legs (Knee pole points +X forward)
    const kneePoleL = new THREE.Vector3(0.3, -0.15, -0.07);
    const kneePoleR = new THREE.Vector3(0.3, -0.15, 0.07);

    solveTwoBoneIK(lHip, lFootTarget, kneePoleL, this.thighLen, this.shinLen, this.tmpV0, this.tmpV1);
    this.leftKneeJoint.position.copy(this.tmpV0);
    this.orientLimb(this.leftThigh, lHip, this.tmpV0, this.thighLen);
    this.orientLimb(this.leftShin, this.tmpV0, this.tmpV1, this.shinLen);
    this.leftFoot.position.set(this.tmpV1.x + 0.02, this.tmpV1.y - 0.01, this.tmpV1.z);

    solveTwoBoneIK(rHip, rFootTarget, kneePoleR, this.thighLen, this.shinLen, this.tmpV0, this.tmpV1);
    this.rightKneeJoint.position.copy(this.tmpV0);
    this.orientLimb(this.rightThigh, rHip, this.tmpV0, this.thighLen);
    this.orientLimb(this.rightShin, this.tmpV0, this.tmpV1, this.shinLen);
    this.rightFoot.position.set(this.tmpV1.x + 0.02, this.tmpV1.y - 0.01, this.tmpV1.z);

    // Solve 2-Bone Pole IK for Both Arms (Elbow pole points -X backward)
    const lHandTarget = new THREE.Vector3();
    const rHandTarget = new THREE.Vector3();

    if (this.state === 'ledge_swing') {
      // Lock both hands upward toward overhead ledge anchor!
      lHandTarget.set(0.06, shoulderWorldY + 0.28, -0.07);
      rHandTarget.set(0.06, shoulderWorldY + 0.28, 0.07);
    } else if (this.state === 'wall_slide') {
      lHandTarget.set(0.18, shoulderWorldY + 0.12, -0.07);
      rHandTarget.set(0.18, shoulderWorldY + 0.08, 0.07);
    } else if (this.state === 'run') {
      const armSwing = Math.sin(this.stridePhase + Math.PI) * 0.18;
      lHandTarget.set(armSwing, shoulderWorldY - 0.18, -0.1);
      // Dominant right arm tracks cursor aim smoothly
      rHandTarget.set(
        Math.cos(this.aimPitchRad) * 0.28,
        shoulderWorldY + Math.sin(this.aimPitchRad) * 0.28,
        0.09,
      );
    } else {
      const breathe = Math.sin(performance.now() * 0.004) * 0.015;
      lHandTarget.set(0.09, shoulderWorldY - 0.22 + breathe, -0.1);
      rHandTarget.set(
        Math.cos(this.aimPitchRad) * 0.26,
        shoulderWorldY + Math.sin(this.aimPitchRad) * 0.26 + breathe,
        0.09,
      );
    }

    const elbowPoleL = new THREE.Vector3(-0.24, shoulderWorldY - 0.06, -0.11);
    const elbowPoleR = new THREE.Vector3(-0.24, shoulderWorldY - 0.06, 0.11);

    solveTwoBoneIK(lShoulder, lHandTarget, elbowPoleL, this.upperArmLen, this.forearmLen, this.tmpV0, this.tmpV1);
    this.leftElbowJoint.position.copy(this.tmpV0);
    this.orientLimb(this.leftUpperArm, lShoulder, this.tmpV0, this.upperArmLen);
    this.orientLimb(this.leftForearm, this.tmpV0, this.tmpV1, this.forearmLen);

    solveTwoBoneIK(rShoulder, rHandTarget, elbowPoleR, this.upperArmLen, this.forearmLen, this.tmpV0, this.tmpV1);
    this.rightElbowJoint.position.copy(this.tmpV0);
    this.orientLimb(this.rightUpperArm, rShoulder, this.tmpV0, this.upperArmLen);
    this.orientLimb(this.rightForearm, this.tmpV0, this.tmpV1, this.forearmLen);

    // -------------------------------------------------------------------------
    // Update World-Space 8-Segment Verlet Headband Scarf with Radial Chest Clamp
    // -------------------------------------------------------------------------
    this.scarfAnchor.getWorldPosition(this.tmpV0); // anchor pos
    this.chestGroup.getWorldPosition(this.tmpV1); // chest collision sphere center
    // Ambient breeze pushing slightly behind facing direction
    this.tmpV2.set(-this.facing * 4.8 - this.currentVel.x * 0.65, -7.2, Math.sin(performance.now() * 0.005) * 1.4);

    solveVerletChain(
      this.scarfPositions,
      this.scarfPrevPositions,
      0.085,
      this.tmpV2,
      dt,
      0.95,
      3,
      this.tmpV0,
      this.tmpV1,
      0.21,
    );

    const scarfAttr = this.scarfMesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const arr = scarfAttr.array as Float32Array;
    for (let i = 0; i < this.scarfSegmentCount; i++) {
      const p = this.scarfPositions[i];
      const halfWidth = 0.032 * (1 - i / (this.scarfSegmentCount * 1.35));
      const idx = i * 6;
      arr[idx] = p.x;
      arr[idx + 1] = p.y + halfWidth;
      arr[idx + 2] = p.z;
      arr[idx + 3] = p.x;
      arr[idx + 4] = p.y - halfWidth;
      arr[idx + 5] = p.z;
    }
    scarfAttr.needsUpdate = true;

    // -------------------------------------------------------------------------
    // Raycasted Contact Blob Shadow directly beneath Stickman
    // -------------------------------------------------------------------------
    const shadowRay = this.physics.castRay(
      this.currentPos.x,
      this.currentPos.y - 0.1,
      this.currentPos.z,
      0,
      -1,
      0,
      7.5,
      undefined,
      this.collider,
    );
    if (shadowRay) {
      this.blobShadowMesh.visible = true;
      this.blobShadowMesh.position.set(
        this.currentPos.x,
        shadowRay.pointY + 0.022,
        this.currentPos.z,
      );
      const heightAbove = Math.max(0, shadowRay.distance - 0.58);
      const shrink = THREE.MathUtils.clamp(1 - heightAbove * 0.14, 0.35, 1.0);
      this.blobShadowMesh.scale.set(shrink, 1, shrink);
      this.shadowMat.opacity = 0.72 * shrink;
    } else {
      this.blobShadowMesh.visible = false;
    }

    // -------------------------------------------------------------------------
    // 1-2 Frame Additive Smear Arc + Emergency Void Rescue Tether
    // -------------------------------------------------------------------------
    if (this.smearTimer > 0) {
      this.smearTimer = Math.max(0, this.smearTimer - dt);
      this.smearArcMesh.visible = true;
      this.smearArcMesh.position.copy(this.currentPos);
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
      tPos.setXYZ(1, this.currentPos.x, this.currentPos.y + 0.3, this.currentPos.z);
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
