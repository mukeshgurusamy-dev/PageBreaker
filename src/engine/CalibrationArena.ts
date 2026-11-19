/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import * as THREE from 'three';
import { RENDER_ORDER, SPATIAL_CONSTANTS, type PlatformBlock } from '../types/game';
import { solveTwoBoneIK } from '../math/kinematics';
import { SeededPRNG } from '../math/prng';

function createBlueprintBackdropTexture(maxAnisotropy: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 1024;
  const ctx = canvas.getContext('2d');

  if (ctx) {
    ctx.fillStyle = '#0d0f16';
    ctx.fillRect(0, 0, 1024, 1024);

    // Subtle 32px architectural grid across entire stage
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.07)';
    ctx.lineWidth = 1;
    for (let x = 0; x <= 1024; x += 32) {
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, 1024);
      ctx.stroke();
    }
    for (let y = 0; y <= 1024; y += 32) {
      ctx.beginPath();
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(1024, y + 0.5);
      ctx.stroke();
    }

    // Major 128px framing grid
    ctx.strokeStyle = 'rgba(226, 232, 240, 0.14)';
    ctx.lineWidth = 1.5;
    for (let x = 0; x <= 1024; x += 128) {
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, 1024);
      ctx.stroke();
    }
    for (let y = 0; y <= 1024; y += 128) {
      ctx.beginPath();
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(1024, y + 0.5);
      ctx.stroke();
    }

    // Highlighted 20.0m (1280px logical webpage width) outer rails inside 36m backdrop sheet
    const railLeft = 228;
    const railRight = 1024 - 228;
    ctx.strokeStyle = 'rgba(245, 158, 11, 0.28)';
    ctx.lineWidth = 2;
    ctx.strokeRect(railLeft, 96, railRight - railLeft, 832);

    // Center axis guideline
    ctx.strokeStyle = 'rgba(245, 158, 11, 0.22)';
    ctx.beginPath();
    ctx.moveTo(512, 96);
    ctx.lineTo(512, 928);
    ctx.stroke();

    // Clean lower-header typography placed cleanly inside world framing away from HUD top bar
    ctx.fillStyle = '#cbd5e1';
    ctx.font = '600 18px "Plus Jakarta Sans", sans-serif';
    ctx.fillText('BAND -2 // 20.0m LOGICAL PAGE STAGE (1280px @ 1/64)', railLeft + 24, 156);

    ctx.fillStyle = '#64748b';
    ctx.font = '500 13px "JetBrains Mono", monospace';
    ctx.fillText('SRGBColorSpace · Neutral Tone · Wall-Kick Chimney · Pendulum Ledges · Low Slide', railLeft + 24, 182);

    const swatches = ['#ffffff', '#ef4444', '#f59e0b', '#06b6d4', '#22c55e'];
    swatches.forEach((hex, idx) => {
      ctx.fillStyle = hex;
      ctx.fillRect(railLeft + 24 + idx * 36, 198, 24, 8);
    });
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAnisotropy;
  tex.needsUpdate = true;
  return tex;
}

function createRoundedRectShape(width: number, height: number, radius: number): THREE.Shape {
  const shape = new THREE.Shape();
  const hw = width * 0.5;
  const hh = height * 0.5;
  const r = Math.min(radius, hw * 0.45, hh * 0.45);

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

/**
 * Step 2 4-Band 2.5D Parkour Playground:
 * Full-bleed Band -2 backdrop with highlighted 20m logical page rails,
 * Band -1 recessed hollow card chamber (housing the IK calibration arm cleanly),
 * and Band 0 walkable/wall-kickable/slidable/grabbable obstacles.
 */
export class CalibrationArena {
  public readonly root = new THREE.Group();

  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly textures: THREE.Texture[] = [];
  private readonly platformBlocks: PlatformBlock[] = [];

  private readonly ikGroup = new THREE.Group();
  private readonly upperArmMesh: THREE.Mesh;
  private readonly foreArmMesh: THREE.Mesh;
  private readonly handOrbMesh: THREE.Mesh;
  private readonly aimReticle: THREE.Mesh;
  private readonly motesMesh: THREE.InstancedMesh;
  private readonly motePhases: Float32Array;
  private readonly moteOrigins: Float32Array;
  private readonly moteCount = 36;

  private readonly ikRoot = new THREE.Vector3(-0.7, -0.85, 0);
  private readonly ikTarget = new THREE.Vector3();
  private readonly ikPole = new THREE.Vector3(0.1, 0.25, 0.55);
  private readonly ikElbow = new THREE.Vector3();
  private readonly ikHand = new THREE.Vector3();
  private readonly tmpVecA = new THREE.Vector3();
  private readonly tmpVecB = new THREE.Vector3();
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly tmpMat4 = new THREE.Matrix4();
  private readonly tmpScale = new THREE.Vector3(1, 1, 1);
  private readonly upAxis = new THREE.Vector3(0, 1, 0);

  private simTime = 0;

  constructor(maxAnisotropy: number) {
    this.root.name = 'CalibrationArena';

    const matteCarbonMat = new THREE.MeshStandardMaterial({
      color: 0x18181f,
      roughness: 0.78,
      metalness: 0.14,
    });
    const brushedTitaniumMat = new THREE.MeshStandardMaterial({
      color: 0xcbd5e1,
      roughness: 0.24,
      metalness: 0.88,
    });
    const chamberWallMat = new THREE.MeshStandardMaterial({
      color: 0x14161e,
      roughness: 0.84,
      metalness: 0.08,
    });
    const amberAccentMat = new THREE.MeshStandardMaterial({
      color: 0xf59e0b,
      emissive: 0x92400e,
      emissiveIntensity: 0.55,
      roughness: 0.26,
      metalness: 0.65,
    });
    const crimsonAccentMat = new THREE.MeshStandardMaterial({
      color: 0xef4444,
      emissive: 0x7f1d1d,
      emissiveIntensity: 0.45,
      roughness: 0.35,
      metalness: 0.35,
    });
    const cyanGrabMat = new THREE.MeshStandardMaterial({
      color: 0x06b6d4,
      emissive: 0x0891b2,
      emissiveIntensity: 0.45,
      roughness: 0.25,
      metalness: 0.72,
    });

    this.materials.push(
      matteCarbonMat,
      brushedTitaniumMat,
      chamberWallMat,
      amberAccentMat,
      crimsonAccentMat,
      cyanGrabMat,
    );

    // -------------------------------------------------------------------------
    // BAND -2 (Z = -2.0m): Seamless 36m x 24m Backdrop with 20m Page Bounds
    // -------------------------------------------------------------------------
    const backdropTex = createBlueprintBackdropTexture(maxAnisotropy);
    this.textures.push(backdropTex);
    const backdropGeo = new THREE.PlaneGeometry(36.0, 24.0);
    const backdropMat = new THREE.MeshBasicMaterial({
      map: backdropTex,
      toneMapped: false,
    });
    this.geometries.push(backdropGeo);
    this.materials.push(backdropMat);

    const backdropMesh = new THREE.Mesh(backdropGeo, backdropMat);
    backdropMesh.position.set(0, 2.5, SPATIAL_CONSTANTS.BAND_BACKDROP_Z);
    backdropMesh.renderOrder = RENDER_ORDER.OPAQUE_WORLD;
    this.root.add(backdropMesh);

    // -------------------------------------------------------------------------
    // BAND -1 (Z in [-1.65m, +0.05m]): Recessed Hollow Mimic Card Alcove
    // Houses the Step 1 IK Rig inside the recessed depth chamber!
    // -------------------------------------------------------------------------
    const chamberGroup = new THREE.Group();
    chamberGroup.position.set(5.4, 2.75, 0);
    this.root.add(chamberGroup);

    const backPlateGeo = new THREE.BoxGeometry(4.6, 3.0, 0.14);
    const sideWallGeo = new THREE.BoxGeometry(0.18, 3.0, 1.7);
    const topBotWallGeo = new THREE.BoxGeometry(4.6, 0.18, 1.7);
    this.geometries.push(backPlateGeo, sideWallGeo, topBotWallGeo);

    const backPlate = new THREE.Mesh(backPlateGeo, chamberWallMat);
    backPlate.position.set(0, 0, SPATIAL_CONSTANTS.BAND_CHAMBER_BACK_Z);
    backPlate.receiveShadow = true;

    const leftWall = new THREE.Mesh(sideWallGeo, matteCarbonMat);
    leftWall.position.set(-2.21, 0, -0.8);
    leftWall.castShadow = true;
    leftWall.receiveShadow = true;

    const rightWall = new THREE.Mesh(sideWallGeo, matteCarbonMat);
    rightWall.position.set(2.21, 0, -0.8);
    rightWall.castShadow = true;
    rightWall.receiveShadow = true;

    const floorWall = new THREE.Mesh(topBotWallGeo, matteCarbonMat);
    floorWall.position.set(0, -1.41, -0.8);
    floorWall.receiveShadow = true;

    const ceilingWall = new THREE.Mesh(topBotWallGeo, matteCarbonMat);
    ceilingWall.position.set(0, 1.41, -0.8);
    ceilingWall.castShadow = true;

    const innerCrateGeo = new THREE.BoxGeometry(0.92, 0.72, 0.72);
    this.geometries.push(innerCrateGeo);
    const innerCrate = new THREE.Mesh(innerCrateGeo, brushedTitaniumMat);
    innerCrate.position.set(0.85, -1.41 + 0.09 + 0.36, SPATIAL_CONSTANTS.BAND_CHAMBER_CENTER_Z);
    innerCrate.castShadow = true;
    innerCrate.receiveShadow = true;

    chamberGroup.add(backPlate, leftWall, rightWall, floorWall, ceilingWall, innerCrate);

    // Place IK Rig cleanly on the Band -1 chamber floor
    this.ikGroup.position.set(0, -0.45, SPATIAL_CONSTANTS.BAND_CHAMBER_CENTER_Z);
    chamberGroup.add(this.ikGroup);

    const baseGeo = new THREE.CylinderGeometry(0.28, 0.34, 0.12, 16);
    const boneGeo = new THREE.CylinderGeometry(0.055, 0.055, 1.0, 12);
    const orbGeo = new THREE.SphereGeometry(0.12, 16, 12);
    this.geometries.push(baseGeo, boneGeo, orbGeo);

    const plinthBase = new THREE.Mesh(baseGeo, brushedTitaniumMat);
    plinthBase.position.set(-0.7, -0.9, 0);
    this.ikGroup.add(plinthBase);

    this.upperArmMesh = new THREE.Mesh(boneGeo, matteCarbonMat);
    this.foreArmMesh = new THREE.Mesh(boneGeo, brushedTitaniumMat);
    this.handOrbMesh = new THREE.Mesh(orbGeo, amberAccentMat);
    this.ikGroup.add(this.upperArmMesh, this.foreArmMesh, this.handOrbMesh);

    // -------------------------------------------------------------------------
    // BAND 0 (Z = +0.25m): Walkable/Wall-Kickable/Slidable/Grabbable Course
    // -------------------------------------------------------------------------
    const addCourseBlock = (
      id: string,
      x: number,
      y: number,
      w: number,
      h: number,
      depth: number,
      grabbableCorners: boolean,
      trimMat: THREE.Material,
    ) => {
      const shape = createRoundedRectShape(w, h, 0.08);
      const geo = new THREE.ExtrudeGeometry(shape, {
        depth,
        bevelEnabled: true,
        bevelThickness: 0.035,
        bevelSize: 0.03,
        bevelSegments: 2,
      });
      geo.translate(0, 0, -depth * 0.5);
      geo.computeVertexNormals();
      this.geometries.push(geo);

      const mesh = new THREE.Mesh(geo, matteCarbonMat);
      mesh.position.set(x, y, SPATIAL_CONSTANTS.BAND_PLAY_Z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;

      const capGeo = new THREE.BoxGeometry(Math.max(0.2, w - 0.14), 0.055, depth + 0.05);
      this.geometries.push(capGeo);
      const cap = new THREE.Mesh(capGeo, trimMat);
      cap.position.set(0, h * 0.5 + 0.032, 0);
      cap.receiveShadow = true;
      mesh.add(cap);

      if (grabbableCorners) {
        const cornerGeo = new THREE.BoxGeometry(0.11, 0.11, depth + 0.12);
        this.geometries.push(cornerGeo);
        const lKnob = new THREE.Mesh(cornerGeo, cyanGrabMat);
        lKnob.position.set(-w * 0.5, h * 0.5, 0);
        const rKnob = new THREE.Mesh(cornerGeo, cyanGrabMat);
        rKnob.position.set(w * 0.5, h * 0.5, 0);
        mesh.add(lKnob, rKnob);
      }

      this.root.add(mesh);

      this.platformBlocks.push({
        id,
        x,
        y,
        z: SPATIAL_CONSTANTS.BAND_PLAY_Z,
        halfW: w * 0.5 + 0.03,
        halfH: h * 0.5 + 0.035,
        halfD: depth * 0.5 + 0.25,
        grabbableCorners,
      });
    };

    // Split Main Decks creating an Abyss Pit Gap at x in [0.9, 2.3]
    addCourseBlock('deck-left', -4.2, -1.2, 10.2, 0.72, 1.4, true, brushedTitaniumMat);
    addCourseBlock('deck-right', 5.8, -1.2, 7.0, 0.72, 1.4, true, brushedTitaniumMat);

    // Wall-Kick Chimney (left side) leading cleanly to High Drop Tower
    addCourseBlock('chimney-outer', -9.2, 2.4, 0.65, 6.4, 1.2, false, brushedTitaniumMat);
    addCourseBlock('chimney-inner', -6.85, 2.35, 0.58, 3.8, 1.2, true, cyanGrabMat);
    addCourseBlock('drop-tower-top', -5.45, 4.15, 2.2, 0.42, 1.2, true, amberAccentMat);

    // Mid-Air Parkour Ledges & Fall-Grab Pendulum Bars (spaced cleanly above spawn runway)
    addCourseBlock('ledge-step-1', -1.8, 0.85, 2.5, 0.42, 1.05, true, cyanGrabMat);
    addCourseBlock('ledge-step-2', 0.95, 2.1, 2.3, 0.42, 1.05, true, cyanGrabMat);
    addCourseBlock('ledge-step-3', 3.45, 3.15, 2.1, 0.42, 1.05, true, cyanGrabMat);

    // Low Crouch-Slide Tunnel Bar on Right Deck (0.94m clearance under bar)
    addCourseBlock('low-slide-bar', 5.65, 0.52, 2.8, 0.82, 1.25, true, crimsonAccentMat);

    // -------------------------------------------------------------------------
    // World-Space Pointer Aim Reticle on Band 0
    // -------------------------------------------------------------------------
    const reticleGeo = new THREE.RingGeometry(0.14, 0.19, 20);
    const reticleMat = new THREE.MeshBasicMaterial({
      color: 0xf59e0b,
      transparent: true,
      opacity: 0.78,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.geometries.push(reticleGeo);
    this.materials.push(reticleMat);
    this.aimReticle = new THREE.Mesh(reticleGeo, reticleMat);
    this.aimReticle.position.set(-2.5, 0.5, SPATIAL_CONSTANTS.BAND_PLAY_Z + 0.03);
    this.aimReticle.renderOrder = RENDER_ORDER.ADDITIVE_VFX_LIGHTNING;
    this.root.add(this.aimReticle);

    // -------------------------------------------------------------------------
    // Instanced Atmospheric Dust Motes
    // -------------------------------------------------------------------------
    const moteGeo = new THREE.OctahedronGeometry(0.045, 0);
    const moteMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
    });
    this.geometries.push(moteGeo);
    this.materials.push(moteMat);

    this.motesMesh = new THREE.InstancedMesh(moteGeo, moteMat, this.moteCount);
    this.motesMesh.renderOrder = RENDER_ORDER.TRANSLUCENT_FROST_DITHER;
    this.motePhases = new Float32Array(this.moteCount);
    this.moteOrigins = new Float32Array(this.moteCount * 3);

    const prng = new SeededPRNG('pagebreaker-step2-playground');
    const tint = new THREE.Color();
    for (let i = 0; i < this.moteCount; i++) {
      this.moteOrigins[i * 3] = prng.range(-9.5, 9.5);
      this.moteOrigins[i * 3 + 1] = prng.range(-0.6, 5.8);
      this.moteOrigins[i * 3 + 2] = prng.range(-1.4, 1.3);
      this.motePhases[i] = prng.range(0, Math.PI * 2);

      const scale = prng.range(0.7, 1.35);
      this.tmpVecA.set(
        this.moteOrigins[i * 3],
        this.moteOrigins[i * 3 + 1],
        this.moteOrigins[i * 3 + 2],
      );
      this.tmpScale.setScalar(scale);
      this.tmpQuat.identity();
      this.tmpMat4.compose(this.tmpVecA, this.tmpQuat, this.tmpScale);
      this.motesMesh.setMatrixAt(i, this.tmpMat4);

      tint.setHSL(0.58 + prng.range(-0.08, 0.08), 0.35, prng.range(0.65, 0.9));
      this.motesMesh.setColorAt(i, tint);
    }
    this.motesMesh.instanceMatrix.needsUpdate = true;
    if (this.motesMesh.instanceColor) this.motesMesh.instanceColor.needsUpdate = true;
    this.motesMesh.computeBoundingSphere();
    this.root.add(this.motesMesh);
  }

  getPlatformBlocks(): readonly PlatformBlock[] {
    return this.platformBlocks;
  }

  setAimReticle(x: number, y: number): void {
    this.aimReticle.position.set(x, y, SPATIAL_CONSTANTS.BAND_PLAY_Z + 0.03);
  }

  private orientSegment(
    mesh: THREE.Mesh,
    start: THREE.Vector3,
    end: THREE.Vector3,
    radiusScale = 1,
  ): void {
    this.tmpVecA.addVectors(start, end).multiplyScalar(0.5);
    this.tmpVecB.subVectors(end, start);
    const len = this.tmpVecB.length();
    mesh.position.copy(this.tmpVecA);
    if (len > 1e-5) {
      this.tmpVecB.divideScalar(len);
      this.tmpQuat.setFromUnitVectors(this.upAxis, this.tmpVecB);
      mesh.quaternion.copy(this.tmpQuat);
    }
    mesh.scale.set(radiusScale, Math.max(0.01, len), radiusScale);
  }

  update(fixedDt: number): void {
    this.simTime += fixedDt;

    this.ikTarget.set(
      0.05 + Math.cos(this.simTime * 1.9) * 0.48,
      -0.35 + Math.sin(this.simTime * 3.8) * 0.28,
      Math.sin(this.simTime * 1.1) * 0.2,
    );
    solveTwoBoneIK(
      this.ikRoot,
      this.ikTarget,
      this.ikPole,
      0.58,
      0.54,
      this.ikElbow,
      this.ikHand,
    );
    this.orientSegment(this.upperArmMesh, this.ikRoot, this.ikElbow);
    this.orientSegment(this.foreArmMesh, this.ikElbow, this.ikHand);
    this.handOrbMesh.position.copy(this.ikHand);

    for (let i = 0; i < this.moteCount; i++) {
      const p = this.motePhases[i] + this.simTime * 0.8;
      this.tmpVecA.set(
        this.moteOrigins[i * 3] + Math.sin(p * 0.7) * 0.18,
        this.moteOrigins[i * 3 + 1] + Math.cos(p) * 0.22,
        this.moteOrigins[i * 3 + 2],
      );
      this.tmpQuat.setFromAxisAngle(this.upAxis, p * 0.5);
      this.tmpScale.setScalar(1.0);
      this.tmpMat4.compose(this.tmpVecA, this.tmpQuat, this.tmpScale);
      this.motesMesh.setMatrixAt(i, this.tmpMat4);
    }
    this.motesMesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    for (const t of this.textures) t.dispose();
  }
}
