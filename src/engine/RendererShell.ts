/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import {
  RENDER_ORDER,
  SPATIAL_CONSTANTS,
  type CameraViewMode,
  type RendererCapabilities,
  type ShowcaseEraId,
  type WorldMode,
} from '../types/game';
import { gameStore } from './GameStore';
import { CalibrationArena } from './CalibrationArena';
import { PhysicsWorld } from './PhysicsWorld';
import { StickmanRig, type StickmanInputState } from './StickmanRig';
import { CameraRig } from './CameraRig';
import { SHOWCASE_SITES } from '../data/showcaseSites';
import { analyzeWebsiteHtml } from '../world/DomAnalyzer';
import { WebsiteWorld } from '../world/WebsiteWorld';

interface PooledPointLight {
  light: THREE.PointLight;
  age: number;
  duration: number;
  peakIntensity: number;
  active: boolean;
}

function probeGpuCapabilities(): {
  supported: boolean;
  isSoftwareGl: boolean;
  rendererName: string;
  hasMultiDraw: boolean;
} {
  const probeCanvas = document.createElement('canvas');
  const gl = probeCanvas.getContext('webgl2');
  if (!gl) {
    return {
      supported: false,
      isSoftwareGl: true,
      rendererName: 'WebGL2 Unavailable',
      hasMultiDraw: false,
    };
  }
  const debugExt = gl.getExtension('WEBGL_debug_renderer_info');
  const rendererName = String(
    debugExt ? gl.getParameter(debugExt.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
  );
  const isSoftwareGl = /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(rendererName);
  const hasMultiDraw = Boolean(gl.getExtension('WEBGL_multi_draw'));
  gl.getExtension('WEBGL_lose_context')?.loseContext();

  return {
    supported: true,
    isSoftwareGl,
    rendererName,
    hasMultiDraw,
  };
}

/**
 * Hardware-accelerated Three.js WebGL2 Engine Shell (Step 2):
 * Combines NeutralToneMapping, RoomEnvironment IBL, Texel-Snapped directional shadows,
 * 4-slot PointLight pool, Rapier3D physics, 16-part StickmanRig, Itay Keren CameraRig,
 * and iframe-resilient keyboard/mouse controls.
 */
export class RendererShell {
  private readonly container: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly cameraRig: CameraRig;
  private readonly keyLight: THREE.DirectionalLight;
  private readonly rimLight: THREE.DirectionalLight;
  private readonly hemiLight: THREE.HemisphereLight;
  private readonly pointLightPool: PooledPointLight[] = [];
  private readonly arena: CalibrationArena;
  private readonly websiteReticle: THREE.Mesh;

  private physics: PhysicsWorld | null = null;
  private stickman: StickmanRig | null = null;
  private websiteWorld: WebsiteWorld | null = null;
  private worldMode: WorldMode = 'arena';
  private siteLoadGeneration = 0;
  private scrollProgress = 0;

  private readonly shadowFocus = new THREE.Vector3(0, 1.0, 0);
  private readonly shadowBoundsHalf = 15.0;
  private readonly shadowResolution = 2048;

  // Iframe-resilient Input State
  private readonly keysDown = new Set<string>();
  private jumpQueuedThisTick = false;
  private pointerNdcX = 0;
  private pointerNdcY = 0;
  private readonly aimRaycaster = new THREE.Raycaster();
  private readonly aimPlane = new THREE.Plane(
    new THREE.Vector3(0, 0, 1),
    -SPATIAL_CONSTANTS.BAND_PLAY_Z,
  );
  private readonly aimWorldPoint = new THREE.Vector3(0, 1.0, SPATIAL_CONSTANTS.BAND_PLAY_Z);
  private readonly pointerNdcVec = new THREE.Vector2();

  private readonly stickPosScratch = new THREE.Vector3();
  private readonly stickVelScratch = new THREE.Vector3();
  private readonly stickInputScratch: StickmanInputState = {
    left: false,
    right: false,
    jumpHeld: false,
    jumpPressedThisFrame: false,
    crouchHeld: false,
    grabHeld: false,
    aimWorldX: 0,
    aimWorldY: 1,
  };

  private cameraMode: CameraViewMode = 'side_25d';
  private zenMode = false;
  private capabilities: RendererCapabilities;

  private envTarget: THREE.WebGLRenderTarget | null = null;
  private rafId = 0;
  private softwareTimerId = 0;
  private disposed = false;
  private paused = false;

  private accumulator = 0;
  private lastTimeMs = performance.now();
  private fpsSamples = 0;
  private fpsAccumSec = 0;
  private currentFps = 60;
  private smoothedFrameMs = 16.67;

  constructor(container: HTMLElement) {
    this.container = container;
    const probe = probeGpuCapabilities();
    if (!probe.supported) {
      throw new Error('WebGL2 is unavailable in this browser context.');
    }

    this.renderer = new THREE.WebGLRenderer({
      antialias: !probe.isSoftwareGl,
      powerPreference: 'high-performance',
    });

    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(
      probe.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 2),
    );
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = !probe.isSoftwareGl;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.renderer.domElement.style.outline = 'none';
    this.renderer.domElement.tabIndex = 0;

    container.appendChild(this.renderer.domElement);

    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    const hasParallel = Boolean(gl.getExtension('KHR_parallel_shader_compile'));
    const maxAnisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());

    this.capabilities = {
      isSoftwareGl: probe.isSoftwareGl,
      rendererName: probe.rendererName,
      maxAnisotropy,
      hasParallelShaderCompile: hasParallel,
      hasMultiDraw: probe.hasMultiDraw,
      shaderWarmupMs: 0,
      contextLost: false,
    };

    this.scene.background = new THREE.Color(0x09090b);
    this.scene.fog = new THREE.FogExp2(0x09090b, 0.012);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const roomEnv = new RoomEnvironment();
    this.envTarget = pmrem.fromScene(roomEnv, 0.04);
    this.scene.environment = this.envTarget.texture;
    roomEnv.dispose();
    pmrem.dispose();

    this.cameraRig = new CameraRig(width / height);

    this.hemiLight = new THREE.HemisphereLight(0xa5c4ff, 0x16161d, 0.65);
    this.scene.add(this.hemiLight);

    this.keyLight = new THREE.DirectionalLight(0xfff1dc, 2.25);
    this.keyLight.position.set(8.5, 14.0, 12.0);
    this.keyLight.castShadow = !probe.isSoftwareGl;
    this.keyLight.shadow.mapSize.set(this.shadowResolution, this.shadowResolution);
    this.keyLight.shadow.camera.near = 1.0;
    this.keyLight.shadow.camera.far = 52.0;
    this.keyLight.shadow.camera.left = -this.shadowBoundsHalf;
    this.keyLight.shadow.camera.right = this.shadowBoundsHalf;
    this.keyLight.shadow.camera.top = this.shadowBoundsHalf;
    this.keyLight.shadow.camera.bottom = -this.shadowBoundsHalf;
    this.keyLight.shadow.bias = -0.0004;
    this.keyLight.shadow.normalBias = 0.02;
    this.scene.add(this.keyLight);
    this.scene.add(this.keyLight.target);

    this.rimLight = new THREE.DirectionalLight(0x7dd3fc, 0.85);
    this.rimLight.position.set(-10.0, 8.0, -9.0);
    this.scene.add(this.rimLight);

    for (let i = 0; i < SPATIAL_CONSTANTS.POINT_LIGHT_POOL_SIZE; i++) {
      const light = new THREE.PointLight(0xf59e0b, 0, 9.0, 2.0);
      light.position.set(-6 + i * 4, 2.0, SPATIAL_CONSTANTS.BAND_PLAY_Z + 0.6);
      this.scene.add(light);
      this.pointLightPool.push({
        light,
        age: 0,
        duration: 0.5,
        peakIntensity: 0,
        active: false,
      });
    }

    this.arena = new CalibrationArena(maxAnisotropy);
    this.scene.add(this.arena.root);

    const wReticleGeo = new THREE.RingGeometry(0.14, 0.19, 20);
    const wReticleMat = new THREE.MeshBasicMaterial({
      color: 0xf59e0b,
      transparent: true,
      opacity: 0.78,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.websiteReticle = new THREE.Mesh(wReticleGeo, wReticleMat);
    this.websiteReticle.position.set(-2.5, 0.5, SPATIAL_CONSTANTS.BAND_PLAY_Z + 0.04);
    this.websiteReticle.renderOrder = RENDER_ORDER.ADDITIVE_VFX_LIGHTNING;
    this.websiteReticle.visible = false;
    this.scene.add(this.websiteReticle);

    this.updateTexelSnappedShadow(this.shadowFocus);

    window.addEventListener('resize', this.handleResize);
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('blur', this.handleWindowBlur);
    document.addEventListener('visibilitychange', this.handleVisibilityChange);
    this.renderer.domElement.addEventListener('pointerdown', this.handlePointerDown);
    this.renderer.domElement.addEventListener('pointermove', this.handlePointerMove);
    this.renderer.domElement.addEventListener('webglcontextlost', this.handleContextLost);
    this.renderer.domElement.addEventListener('webglcontextrestored', this.handleContextRestored);

    gameStore.updateMetrics(
      {
        webglSupported: true,
        capabilities: { ...this.capabilities },
      },
      performance.now(),
      true,
    );

    void this.initPhysicsAndStart();
  }

  private async initPhysicsAndStart(): Promise<void> {
    const startMs = performance.now();

    const physics = await PhysicsWorld.create();
    if (this.disposed) {
      physics.free();
      return;
    }
    this.physics = physics;

    for (const block of this.arena.getPlatformBlocks()) {
      physics.addStaticPlatform(block);
    }

    this.stickman = new StickmanRig(physics, this.scene, -4.5, -0.12);
    this.cameraRig.snapToTarget(-4.5, -0.12, SPATIAL_CONSTANTS.BAND_PLAY_Z);

    if (
      !this.capabilities.isSoftwareGl &&
      typeof this.renderer.compileAsync === 'function'
    ) {
      try {
        await this.renderer.compileAsync(this.scene, this.cameraRig.camera);
      } catch {
        this.renderer.compile(this.scene, this.cameraRig.camera);
      }
    } else if (!this.capabilities.isSoftwareGl) {
      this.renderer.compile(this.scene, this.cameraRig.camera);
    }

    if (this.disposed) return;

    this.capabilities = {
      ...this.capabilities,
      shaderWarmupMs: Math.round((performance.now() - startMs) * 10) / 10,
    };

    gameStore.updateMetrics(
      { capabilities: { ...this.capabilities } },
      performance.now(),
      true,
    );

    // Draw initial frame immediately so first paint is never blank black
    this.stepFixed(SPATIAL_CONSTANTS.FIXED_DT);
    this.stickman.getPosition(this.stickPosScratch);
    this.stickman.getVelocity(this.stickVelScratch);
    this.cameraRig.update(
      SPATIAL_CONSTANTS.FIXED_DT,
      this.stickPosScratch,
      this.stickVelScratch,
      this.stickman.isGrounded(),
      0,
      0,
    );
    this.cameraRig.getFocusTarget(this.shadowFocus);
    this.updateTexelSnappedShadow(this.shadowFocus);
    this.renderer.render(this.scene, this.cameraRig.camera);

    this.lastTimeMs = performance.now();
    this.scheduleNextTick();
  }

  private updateTexelSnappedShadow(focus: THREE.Vector3): void {
    const worldUnitsPerTexel = (this.shadowBoundsHalf * 2) / this.shadowResolution;
    const snappedX = Math.round(focus.x / worldUnitsPerTexel) * worldUnitsPerTexel;
    const snappedY = Math.round(focus.y / worldUnitsPerTexel) * worldUnitsPerTexel;
    const snappedZ = Math.round(focus.z / worldUnitsPerTexel) * worldUnitsPerTexel;

    this.keyLight.target.position.set(snappedX, snappedY, snappedZ);
    this.keyLight.position.set(snappedX + 8.5, snappedY + 14.0, snappedZ + 12.0);
    this.keyLight.target.updateMatrixWorld();
  }

  private spawnImpactLight(x: number, y: number, colorHex: number, intensity = 8.0): void {
    // Reuse oldest or inactive slot cleanly
    let chosen = this.pointLightPool[0];
    for (let i = 0; i < this.pointLightPool.length; i++) {
      if (!this.pointLightPool[i].active) {
        chosen = this.pointLightPool[i];
        break;
      }
      if (this.pointLightPool[i].age > chosen.age) {
        chosen = this.pointLightPool[i];
      }
    }
    chosen.light.color.setHex(colorHex);
    chosen.light.position.set(x, y, SPATIAL_CONSTANTS.BAND_PLAY_Z + 0.6);
    chosen.peakIntensity = intensity;
    chosen.duration = 0.42;
    chosen.age = 0;
    chosen.active = true;
    chosen.light.intensity = intensity;
  }

  toggleCameraMode(): void {
    this.cameraMode = this.cameraMode === 'side_25d' ? 'angled_3d' : 'side_25d';
    this.cameraRig.setMode(this.cameraMode);
    gameStore.setCameraMode(this.cameraMode);
  }

  toggleZenMode(): void {
    this.zenMode = !this.zenMode;
    gameStore.setZenMode(this.zenMode);
  }

  triggerPointLightPulseWave(): void {
    const colors = [0xef4444, 0xf59e0b, 0x06b6d4, 0x22c55e];
    const positions = [
      new THREE.Vector3(-5.6, 1.35, 0.7),
      new THREE.Vector3(-2.2, 2.25, 0.7),
      new THREE.Vector3(0.9, 0.85, 0.7),
      new THREE.Vector3(5.4, 2.45, -0.8),
    ];
    for (let i = 0; i < this.pointLightPool.length; i++) {
      const slot = this.pointLightPool[i];
      slot.light.color.setHex(colors[i % colors.length]);
      slot.light.position.copy(positions[i % positions.length]);
      slot.peakIntensity = 12.0;
      slot.duration = 0.85 + i * 0.12;
      slot.age = 0;
      slot.active = true;
      slot.light.intensity = slot.peakIntensity;
    }
  }

  triggerRagdollTest(): void {
    this.stickman?.triggerRagdoll(3.5, 8.0, 9.5);
    this.cameraRig.addTrauma(0.35);
  }

  resetStickman(): void {
    this.stickman?.resetToSpawn(true);
    const focus = this.websiteWorld ? this.websiteWorld.spawnPoint : new THREE.Vector3(-4.5, -0.15, SPATIAL_CONSTANTS.BAND_PLAY_Z);
    this.cameraRig.snapToTarget(focus.x, focus.y, SPATIAL_CONSTANTS.BAND_PLAY_Z);
  }

  returnToArena(): void {
    if (!this.physics || !this.stickman) return;
    this.siteLoadGeneration++;
    if (this.websiteWorld) {
      this.scene.remove(this.websiteWorld.root);
      this.websiteWorld.dispose(this.physics);
      this.websiteWorld = null;
    }

    this.physics.clearStaticPlatforms();
    for (const block of this.arena.getPlatformBlocks()) {
      this.physics.addStaticPlatform(block);
    }

    this.worldMode = 'arena';
    this.arena.root.visible = true;
    this.websiteReticle.visible = false;
    this.scrollProgress = 0;

    this.stickman.setVoidThresholdY(-7.5);
    this.stickman.setSpawnPoint(-4.5, -0.12);
    this.stickman.resetToSpawn(true);
    this.cameraRig.snapToTarget(-4.5, -0.12, SPATIAL_CONSTANTS.BAND_PLAY_Z);

    gameStore.updateMetrics(
      {
        worldMode: 'arena',
        modeLabel: '2.5D Parkour Playground',
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
      },
      performance.now(),
      true,
    );
  }

  async loadShowcaseEra(eraId: ShowcaseEraId): Promise<void> {
    const preset = SHOWCASE_SITES[eraId];
    if (!preset) return;
    await this.buildWebsiteFromSanitizedHtml(preset.html, preset.title, preset.url, false);
  }

  async loadPublicUrl(rawUrl: string): Promise<void> {
    const trimmed = rawUrl.trim();
    if (!trimmed) return;
    const gen = ++this.siteLoadGeneration;

    gameStore.updateMetrics(
      {
        siteStatus: 'fetching',
        siteError: null,
        siteUrl: trimmed,
      },
      performance.now(),
      true,
    );

    try {
      const resp = await fetch(`/api/capture-site?url=${encodeURIComponent(trimmed)}`);
      const data = (await resp.json()) as {
        ok?: boolean;
        error?: string;
        finalUrl?: string;
        title?: string;
        html?: string;
        spaRecovered?: boolean;
      };

      if (this.disposed || gen !== this.siteLoadGeneration) return;
      if (!resp.ok || !data.ok || !data.html) {
        throw new Error(data.error || `Capture failed with HTTP ${resp.status}`);
      }

      await this.buildWebsiteFromSanitizedHtml(
        data.html,
        data.title || trimmed,
        data.finalUrl || trimmed,
        Boolean(data.spaRecovered),
        gen,
      );
    } catch (err) {
      if (this.disposed || gen !== this.siteLoadGeneration) return;
      gameStore.updateMetrics(
        {
          siteStatus: 'error',
          siteError: err instanceof Error ? err.message : 'Unable to capture URL.',
        },
        performance.now(),
        true,
      );
    }
  }

  async loadPastedHtml(rawHtml: string, baseUrl = 'https://pasted.local/'): Promise<void> {
    if (!rawHtml.trim()) return;
    const gen = ++this.siteLoadGeneration;

    gameStore.updateMetrics(
      {
        siteStatus: 'fetching',
        siteError: null,
        siteUrl: 'pasted://rendered-dom',
      },
      performance.now(),
      true,
    );

    try {
      const resp = await fetch('/api/sanitize-html', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ html: rawHtml, baseUrl }),
      });
      const data = (await resp.json()) as {
        ok?: boolean;
        error?: string;
        title?: string;
        html?: string;
      };
      if (this.disposed || gen !== this.siteLoadGeneration) return;
      if (!resp.ok || !data.ok || !data.html) {
        throw new Error(data.error || 'Failed to sanitize pasted HTML.');
      }
      await this.buildWebsiteFromSanitizedHtml(
        data.html,
        data.title || 'Pasted Rendered DOM',
        'pasted://rendered-dom',
        false,
        gen,
      );
    } catch (err) {
      if (this.disposed || gen !== this.siteLoadGeneration) return;
      gameStore.updateMetrics(
        {
          siteStatus: 'error',
          siteError: err instanceof Error ? err.message : 'Failed to parse pasted HTML.',
        },
        performance.now(),
        true,
      );
    }
  }

  private async buildWebsiteFromSanitizedHtml(
    html: string,
    title: string,
    url: string,
    spaRecovered: boolean,
    existingGen?: number,
  ): Promise<void> {
    const gen = existingGen ?? ++this.siteLoadGeneration;
    if (!this.physics || !this.stickman) return;

    gameStore.updateMetrics(
      {
        siteStatus: 'analyzing',
        siteError: null,
        siteUrl: url,
      },
      performance.now(),
      true,
    );

    let analyzed: Awaited<ReturnType<typeof analyzeWebsiteHtml>> | null = null;
    try {
      analyzed = await analyzeWebsiteHtml(html, title, url);
      if (this.disposed || gen !== this.siteLoadGeneration) {
        analyzed.dispose();
        return;
      }

      gameStore.updateMetrics({ siteStatus: 'baking' }, performance.now(), true);

      // Teardown previous world & static platforms cleanly before baking new world
      if (this.websiteWorld) {
        this.scene.remove(this.websiteWorld.root);
        this.websiteWorld.dispose(this.physics);
        this.websiteWorld = null;
      }
      this.physics.clearStaticPlatforms();

      const resolvedTitle = analyzed.title || title;
      const resolvedTier = analyzed.fortressTier;
      const resolvedScore = analyzed.meanCraftScore;
      const resolvedDark = analyzed.isDarkTheme;
      const resolvedCompCount = analyzed.components.length;

      const world = await WebsiteWorld.build(
        analyzed,
        this.physics,
        this.capabilities.isSoftwareGl,
        this.capabilities.maxAnisotropy,
      );

      analyzed.dispose();
      analyzed = null;

      if (this.disposed || gen !== this.siteLoadGeneration) {
        world.dispose(this.physics);
        return;
      }

      this.websiteWorld = world;
      this.worldMode = 'website';
      this.arena.root.visible = false;
      this.websiteReticle.visible = true;
      this.scene.add(world.root);

      this.stickman.setVoidThresholdY(-world.pageHeightM - 6.0);
      this.stickman.setSpawnPoint(world.spawnPoint.x, world.spawnPoint.y);
      this.stickman.resetToSpawn(true);
      this.cameraRig.snapToTarget(
        world.spawnPoint.x,
        world.spawnPoint.y,
        SPATIAL_CONSTANTS.BAND_PLAY_Z,
      );

      if (!this.capabilities.isSoftwareGl && typeof this.renderer.compileAsync === 'function') {
        try {
          await this.renderer.compileAsync(this.scene, this.cameraRig.camera);
        } catch {
          // ignore
        }
      }

      gameStore.updateMetrics(
        {
          worldMode: 'website',
          modeLabel: '2.5D Living Website',
          siteStatus: 'ready',
          siteError: null,
          siteUrl: url,
          siteTitle: resolvedTitle,
          fortressTier: resolvedTier,
          meanCraftScore: resolvedScore,
          isDarkTheme: resolvedDark,
          pageHeightM: Math.round(world.pageHeightM * 10) / 10,
          scrollProgress: 0,
          totalComponents: resolvedCompCount,
          spaRecovered,
        },
        performance.now(),
        true,
      );
    } catch (err) {
      analyzed?.dispose();
      if (this.disposed || gen !== this.siteLoadGeneration) return;
      gameStore.updateMetrics(
        {
          siteStatus: 'error',
          siteError: err instanceof Error ? err.message : 'Failed to build 2.5D website world.',
        },
        performance.now(),
        true,
      );
    }
  }

  private handleResize = (): void => {
    if (this.disposed) return;
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.cameraRig.setAspect(width / height);
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(
      this.capabilities.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 2),
    );
  };

  private updateAimFromPointer(clientX: number, clientY: number): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    this.pointerNdcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointerNdcY = -(((clientY - rect.top) / rect.height) * 2 - 1);

    this.pointerNdcVec.set(this.pointerNdcX, this.pointerNdcY);
    this.aimRaycaster.setFromCamera(this.pointerNdcVec, this.cameraRig.camera);
    if (this.aimRaycaster.ray.intersectPlane(this.aimPlane, this.aimWorldPoint)) {
      this.arena.setAimReticle(this.aimWorldPoint.x, this.aimWorldPoint.y);
      this.websiteReticle.position.set(
        this.aimWorldPoint.x,
        this.aimWorldPoint.y,
        SPATIAL_CONSTANTS.BAND_PLAY_Z + 0.04,
      );
    }
  }

  private handlePointerDown = (e: PointerEvent): void => {
    this.renderer.domElement.focus();
    try {
      this.renderer.domElement.setPointerCapture(e.pointerId);
    } catch {
      // Ignore synthetic events
    }
    this.updateAimFromPointer(e.clientX, e.clientY);
  };

  private handlePointerMove = (e: PointerEvent): void => {
    this.updateAimFromPointer(e.clientX, e.clientY);
  };

  private handleKeyDown = (e: KeyboardEvent): void => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
      return;
    }

    if (
      e.code === 'Space' ||
      e.code === 'ArrowUp' ||
      e.code === 'ArrowDown' ||
      e.code === 'ArrowLeft' ||
      e.code === 'ArrowRight'
    ) {
      e.preventDefault();
    }

    const isNewPress = !this.keysDown.has(e.code);
    this.keysDown.add(e.code);

    if (
      isNewPress &&
      (e.code === 'Space' || e.code === 'KeyW' || e.code === 'ArrowUp')
    ) {
      this.jumpQueuedThisTick = true;
    }

    if (!isNewPress) return;

    if (e.code === 'KeyV') {
      this.toggleCameraMode();
    } else if (e.code === 'KeyH') {
      this.toggleZenMode();
    } else if (e.code === 'KeyX') {
      this.triggerRagdollTest();
    } else if (e.code === 'KeyR') {
      this.resetStickman();
    }
  };

  private handleKeyUp = (e: KeyboardEvent): void => {
    this.keysDown.delete(e.code);
  };

  private handleWindowBlur = (): void => {
    // Prevent stuck movement keys inside iframes when focus leaves window
    this.keysDown.clear();
    this.jumpQueuedThisTick = false;
  };

  private handleVisibilityChange = (): void => {
    if (document.hidden) {
      this.paused = true;
      this.keysDown.clear();
      this.jumpQueuedThisTick = false;
    } else {
      this.paused = false;
      this.lastTimeMs = performance.now();
      this.accumulator = 0;
    }
  };

  private handleContextLost = (e: Event): void => {
    e.preventDefault();
    this.capabilities = { ...this.capabilities, contextLost: true };
    gameStore.updateMetrics(
      { capabilities: { ...this.capabilities } },
      performance.now(),
      true,
    );
  };

  private handleContextRestored = (): void => {
    this.capabilities = { ...this.capabilities, contextLost: false };
    gameStore.updateMetrics(
      { capabilities: { ...this.capabilities } },
      performance.now(),
      true,
    );
  };

  private stepFixed(fixedDt: number): void {
    if (this.worldMode === 'arena') {
      this.arena.update(fixedDt);
    } else if (this.websiteWorld && this.stickman) {
      this.stickman.getPosition(this.stickPosScratch);
      this.cameraRig.getFocusTarget(this.shadowFocus);
      this.scrollProgress = this.websiteWorld.update(
        this.shadowFocus.y,
        this.stickPosScratch,
        fixedDt,
      );
    }

    if (this.stickman && this.physics) {
      this.stickInputScratch.left =
        this.keysDown.has('KeyA') || this.keysDown.has('ArrowLeft');
      this.stickInputScratch.right =
        this.keysDown.has('KeyD') || this.keysDown.has('ArrowRight');
      this.stickInputScratch.jumpHeld =
        this.keysDown.has('Space') ||
        this.keysDown.has('KeyW') ||
        this.keysDown.has('ArrowUp');
      this.stickInputScratch.jumpPressedThisFrame = this.jumpQueuedThisTick;
      this.jumpQueuedThisTick = false;
      this.stickInputScratch.crouchHeld =
        this.keysDown.has('KeyS') ||
        this.keysDown.has('ArrowDown') ||
        this.keysDown.has('ShiftLeft');
      this.stickInputScratch.grabHeld = this.keysDown.has('KeyF');
      this.stickInputScratch.aimWorldX = this.aimWorldPoint.x;
      this.stickInputScratch.aimWorldY = this.aimWorldPoint.y;

      const stepRes = this.stickman.step(fixedDt, this.stickInputScratch);
      this.physics.step();

      if (stepRes.impactStrength > 0.15) {
        this.cameraRig.addTrauma(stepRes.impactStrength * 0.45);
        this.stickman.getPosition(this.stickPosScratch);
        this.spawnImpactLight(
          this.stickPosScratch.x,
          this.stickPosScratch.y,
          stepRes.lostLifeToVoid ? 0x06b6d4 : 0xf59e0b,
          7.5 * stepRes.impactStrength + 3.0,
        );
      }
    }

    for (let i = 0; i < this.pointLightPool.length; i++) {
      const slot = this.pointLightPool[i];
      if (!slot.active) continue;
      slot.age += fixedDt;
      const t = slot.age / slot.duration;
      if (t >= 1) {
        slot.active = false;
        slot.light.intensity = 0;
      } else {
        const envelope = Math.sin(Math.PI * (1 - t)) * (1 - t);
        slot.light.intensity = slot.peakIntensity * Math.max(0, envelope);
      }
    }
  }

  private afterDraw(cb: () => void): void {
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    const poll = () => {
      if (this.disposed) {
        if (sync) gl.deleteSync(sync);
        return;
      }
      const state = sync ? gl.getSyncParameter(sync, gl.SYNC_STATUS) : gl.SIGNALED;
      if (state === gl.UNSIGNALED) {
        this.softwareTimerId = window.setTimeout(poll, 5);
      } else {
        if (sync) gl.deleteSync(sync);
        this.softwareTimerId = window.setTimeout(cb, 80);
      }
    };
    this.softwareTimerId = window.setTimeout(poll, 5);
  }

  private scheduleNextTick(): void {
    if (this.disposed) return;
    if (this.capabilities.isSoftwareGl) {
      this.afterDraw(this.tick);
    } else {
      this.rafId = requestAnimationFrame(this.tick);
    }
  }

  private tick = (): void => {
    if (this.disposed) return;
    const nowMs = performance.now();
    const rawDt = Math.max(0, (nowMs - this.lastTimeMs) / 1000);
    this.lastTimeMs = nowMs;

    if (!this.paused && !this.capabilities.contextLost) {
      const clampedDt = Math.min(rawDt, SPATIAL_CONSTANTS.MAX_FRAME_DT);
      this.accumulator += clampedDt;

      let steps = 0;
      while (this.accumulator >= SPATIAL_CONSTANTS.FIXED_DT && steps < 16) {
        this.stepFixed(SPATIAL_CONSTANTS.FIXED_DT);
        this.accumulator -= SPATIAL_CONSTANTS.FIXED_DT;
        steps++;
      }

      if (this.stickman) {
        this.stickman.getPosition(this.stickPosScratch);
        this.stickman.getVelocity(this.stickVelScratch);
        this.cameraRig.update(
          clampedDt,
          this.stickPosScratch,
          this.stickVelScratch,
          this.stickman.isGrounded(),
          this.pointerNdcX,
          this.pointerNdcY,
        );
      }

      this.cameraRig.getFocusTarget(this.shadowFocus);
      this.updateTexelSnappedShadow(this.shadowFocus);

      this.renderer.render(this.scene, this.cameraRig.camera);

      this.fpsSamples++;
      this.fpsAccumSec += rawDt;
      this.smoothedFrameMs =
        this.smoothedFrameMs * 0.9 + Math.min(100, rawDt * 1000) * 0.1;

      if (this.fpsAccumSec >= 0.35) {
        this.currentFps = Math.round(this.fpsSamples / this.fpsAccumSec);
        this.fpsSamples = 0;
        this.fpsAccumSec = 0;
      }

      let activeLightPulses = 0;
      for (let i = 0; i < this.pointLightPool.length; i++) {
        if (this.pointLightPool[i].active) activeLightPulses++;
      }

      gameStore.updateMetrics(
        {
          fps: this.currentFps,
          frameTimeMs: Math.round(this.smoothedFrameMs * 10) / 10,
          drawCalls: this.renderer.info.render.calls,
          activeLightPulses,
          parkourState: this.stickman ? this.stickman.getState() : 'idle',
          stickmanSpeed: this.stickman
            ? Math.round(this.stickVelScratch.length() * 10) / 10
            : 0,
          integrityLives: this.stickman ? this.stickman.getIntegrityLives() : 3,
          scrollProgress: this.scrollProgress,
        },
        nowMs,
      );
    }

    if (this.capabilities.isSoftwareGl) {
      this.afterDraw(this.tick);
    } else {
      this.rafId = requestAnimationFrame(this.tick);
    }
  };

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.rafId);
    window.clearTimeout(this.softwareTimerId);

    window.removeEventListener('resize', this.handleResize);
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('blur', this.handleWindowBlur);
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    this.renderer.domElement.removeEventListener('pointerdown', this.handlePointerDown);
    this.renderer.domElement.removeEventListener('pointermove', this.handlePointerMove);
    this.renderer.domElement.removeEventListener('webglcontextlost', this.handleContextLost);
    this.renderer.domElement.removeEventListener('webglcontextrestored', this.handleContextRestored);

    this.stickman?.dispose();
    this.websiteWorld?.dispose(this.physics);
    this.physics?.free();
    this.arena.dispose();
    this.websiteReticle.geometry.dispose();
    (this.websiteReticle.material as THREE.Material).dispose();
    this.envTarget?.dispose();
    this.renderer.dispose();
    if (this.renderer.domElement.parentNode === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }
}
