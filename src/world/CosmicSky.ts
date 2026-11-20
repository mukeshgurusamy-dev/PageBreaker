/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import * as THREE from 'three';
import { RENDER_ORDER } from '../types/game';
import { SeededPRNG } from '../math/prng';

const PULSE_VERTEX_SHADER = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const PULSE_FRAGMENT_SHADER = /* glsl */ `
precision highp float;
uniform float uProgress;
uniform float uOpacity;
varying vec2 vUv;

void main() {
  vec2 st = (vUv - 0.5) * 2.0;
  float r = length(st);
  if (r > 1.0) discard;

  float waveR = mix(0.05, 0.94, uProgress);
  float ring = smoothstep(0.055, 0.0, abs(r - waveR));
  vec3 col = mix(vec3(0.08, 0.78, 0.92), vec3(0.96, 0.62, 0.12), uProgress * 0.5) * ring;
  float alpha = clamp(ring * uOpacity, 0.0, 0.9);
  gl_FragColor = vec4(col, alpha);
}
`;

interface CosmicStarData {
  x: number;
  y: number;
  z: number;
  baseScale: number;
  phase: number;
  speed: number;
}

/**
 * Clean Dark Cosmic Space Environment (Milestone 3C):
 * Subtle exponential depth fog companion featuring sparse distant starlight motes
 * with gentle parallax drift and zero visual ring/glass clutter behind floating DOM islands.
 */
export class CosmicSky {
  public readonly root = new THREE.Group();

  private readonly starsMesh: THREE.InstancedMesh;
  private readonly starData: CosmicStarData[] = [];
  private readonly pulseMesh: THREE.Mesh;
  private readonly pulseMat: THREE.ShaderMaterial;

  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];

  private elapsedSec = 0;
  private pulseAge = -1;
  private readonly pulseDuration = 0.58;
  private readonly tmpObj = new THREE.Object3D();

  constructor(maxPageDepthM = 34) {
    this.root.name = 'CosmicSky';
    this.root.visible = false;

    const starGeo = new THREE.OctahedronGeometry(0.06, 0);
    const starMat = new THREE.MeshBasicMaterial({
      color: 0xe2e8f0,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
    });
    this.geometries.push(starGeo);
    this.materials.push(starMat);

    const starCount = 72;
    this.starsMesh = new THREE.InstancedMesh(starGeo, starMat, starCount);
    this.starsMesh.frustumCulled = false;
    this.starsMesh.renderOrder = RENDER_ORDER.OPAQUE_WORLD;

    const prng = new SeededPRNG('cosmic-space-void');
    const tint = new THREE.Color();
    for (let i = 0; i < starCount; i++) {
      const data: CosmicStarData = {
        x: prng.range(-26, 26),
        y: prng.range(-Math.max(24, maxPageDepthM + 8), 14),
        z: prng.range(-28, -8),
        baseScale: prng.range(0.55, 1.45),
        phase: prng.range(0, Math.PI * 2),
        speed: prng.range(0.35, 0.95),
      };
      this.starData.push(data);
      tint.setHSL(0.58 + prng.range(-0.08, 0.06), 0.25, prng.range(0.65, 0.92));
      this.starsMesh.setColorAt(i, tint);
    }
    if (this.starsMesh.instanceColor) {
      this.starsMesh.instanceColor.needsUpdate = true;
    }
    this.root.add(this.starsMesh);

    const pulseGeo = new THREE.PlaneGeometry(18, 18);
    this.geometries.push(pulseGeo);
    this.pulseMat = new THREE.ShaderMaterial({
      uniforms: {
        uProgress: { value: 0 },
        uOpacity: { value: 0 },
      },
      vertexShader: PULSE_VERTEX_SHADER,
      fragmentShader: PULSE_FRAGMENT_SHADER,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.materials.push(this.pulseMat);

    this.pulseMesh = new THREE.Mesh(pulseGeo, this.pulseMat);
    this.pulseMesh.visible = false;
    this.pulseMesh.renderOrder = RENDER_ORDER.ADDITIVE_VFX_LIGHTNING;
    this.root.add(this.pulseMesh);
  }

  setVisible(visible: boolean): void {
    this.root.visible = visible;
  }

  triggerBreakPulse(impactX: number, impactY: number): void {
    this.pulseAge = 0;
    this.pulseMesh.visible = true;
    this.pulseMesh.position.set(impactX, impactY, 0.08);
    this.pulseMat.uniforms.uProgress.value = 0;
    this.pulseMat.uniforms.uOpacity.value = 0.85;
  }

  update(dt: number, cameraFocusX: number, cameraFocusY: number): void {
    if (!this.root.visible) return;
    this.elapsedSec += dt;

    const parallaxX = cameraFocusX * 0.28;
    const parallaxY = cameraFocusY * 0.28;

    for (let i = 0; i < this.starData.length; i++) {
      const s = this.starData[i];
      const twinkle = 0.72 + 0.28 * Math.sin(this.elapsedSec * s.speed * 2.2 + s.phase);
      this.tmpObj.position.set(
        s.x + parallaxX + Math.sin(this.elapsedSec * 0.2 + s.phase) * 0.16,
        s.y + parallaxY + Math.cos(this.elapsedSec * 0.18 + s.phase) * 0.16,
        s.z,
      );
      this.tmpObj.rotation.set(0, 0, this.elapsedSec * 0.25 + s.phase);
      this.tmpObj.scale.setScalar(s.baseScale * twinkle);
      this.tmpObj.updateMatrix();
      this.starsMesh.setMatrixAt(i, this.tmpObj.matrix);
    }
    this.starsMesh.instanceMatrix.needsUpdate = true;

    if (this.pulseAge >= 0) {
      this.pulseAge += dt;
      const t = this.pulseAge / this.pulseDuration;
      if (t >= 1) {
        this.pulseAge = -1;
        this.pulseMesh.visible = false;
      } else {
        this.pulseMat.uniforms.uProgress.value = 1 - Math.pow(1 - t, 2.2);
        this.pulseMat.uniforms.uOpacity.value = Math.pow(1 - t, 1.4) * 0.85;
      }
    }
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
  }
}
