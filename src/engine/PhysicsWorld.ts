/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import RAPIER from '@dimforge/rapier3d-compat';
import { COLLISION_GROUP, SPATIAL_CONSTANTS, type PlatformBlock } from '../types/game';

let rapierInitPromise: Promise<void> | null = null;

export interface LedgeCorner {
  id: string;
  x: number;
  y: number;
  z: number;
  side: -1 | 1; // -1 = left corner of platform, +1 = right corner of platform
}

export interface RayHit {
  distance: number;
  pointX: number;
  pointY: number;
  pointZ: number;
  normalX: number;
  normalY: number;
  normalZ: number;
  collider: RAPIER.Collider;
}

/**
 * Packs 16-bit membership and 16-bit interaction filter masks into Rapier's 32-bit bitfield.
 */
export function packInteractionGroups(membership: number, filter: number): number {
  return ((membership & 0xffff) << 16) | (filter & 0xffff);
}

/**
 * Rapier3D WASM physics wrapper enforcing 2.5D planar constraints, collision bitmasks,
 * KinematicCharacterController movement, ledge corner spatial queries, and explicit .free() cleanup.
 */
export class PhysicsWorld {
  public readonly world: RAPIER.World;
  private readonly staticBodies: RAPIER.RigidBody[] = [];
  private readonly staticColliders: RAPIER.Collider[] = [];
  private readonly controllers: RAPIER.KinematicCharacterController[] = [];
  private readonly grabbableCorners: LedgeCorner[] = [];
  private readonly platformMap = new Map<number, { block: PlatformBlock; isOneWay: boolean }>();
  private freed = false;

  private constructor() {
    this.world = new RAPIER.World({ x: 0, y: -26.0, z: 0 });
    this.world.timestep = SPATIAL_CONSTANTS.FIXED_DT;
    this.world.numSolverIterations = 6;
  }

  static async create(): Promise<PhysicsWorld> {
    if (!rapierInitPromise) {
      rapierInitPromise = RAPIER.init();
    }
    await rapierInitPromise;
    return new PhysicsWorld();
  }

  addStaticPlatform(
    block: PlatformBlock,
    membership: number = COLLISION_GROUP.TERRAIN,
    filter: number =
      COLLISION_GROUP.PLAYER |
      COLLISION_GROUP.ENEMY |
      COLLISION_GROUP.PROJECTILE |
      COLLISION_GROUP.DEBRIS,
  ): RAPIER.Collider {
    const bodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(block.x, block.y, block.z);
    const body = this.world.createRigidBody(bodyDesc);
    const colDesc = RAPIER.ColliderDesc.cuboid(block.halfW, block.halfH, block.halfD)
      .setFriction(0.65)
      .setRestitution(0.05)
      .setCollisionGroups(packInteractionGroups(membership, filter));
    const collider = this.world.createCollider(colDesc, body);

    this.staticBodies.push(body);
    this.staticColliders.push(collider);

    const isOneWay = membership === COLLISION_GROUP.CARD_SHELL;
    this.platformMap.set(collider.handle, { block, isOneWay });

    if (block.grabbableCorners !== false && Math.abs(block.z - SPATIAL_CONSTANTS.BAND_PLAY_Z) < 0.75) {
      this.grabbableCorners.push(
        {
          id: `${block.id}:left`,
          x: block.x - block.halfW,
          y: block.y + block.halfH,
          z: SPATIAL_CONSTANTS.BAND_PLAY_Z,
          side: -1,
        },
        {
          id: `${block.id}:right`,
          x: block.x + block.halfW,
          y: block.y + block.halfH,
          z: SPATIAL_CONSTANTS.BAND_PLAY_Z,
          side: 1,
        },
      );
    }

    return collider;
  }

  isOneWayPlatform(handle: number): boolean {
    return this.platformMap.get(handle)?.isOneWay ?? false;
  }

  getPlatformInfo(handle: number): { block: PlatformBlock; isOneWay: boolean } | undefined {
    return this.platformMap.get(handle);
  }

  clearStaticPlatforms(): void {
    for (const col of this.staticColliders) {
      if (col.isValid()) this.world.removeCollider(col, false);
    }
    for (const body of this.staticBodies) {
      if (body.isValid()) this.world.removeRigidBody(body);
    }
    this.staticColliders.length = 0;
    this.staticBodies.length = 0;
    this.grabbableCorners.length = 0;
    this.platformMap.clear();
  }

  createKinematicPlatform(
    x: number,
    y: number,
    z: number,
    halfW: number,
    halfH: number,
    halfD: number,
  ): { body: RAPIER.RigidBody; collider: RAPIER.Collider } {
    const bodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(x, y, z);
    const body = this.world.createRigidBody(bodyDesc);
    const colDesc = RAPIER.ColliderDesc.cuboid(halfW, halfH, halfD)
      .setFriction(0.8)
      .setCollisionGroups(
        packInteractionGroups(
          COLLISION_GROUP.TERRAIN,
          COLLISION_GROUP.PLAYER | COLLISION_GROUP.ENEMY | COLLISION_GROUP.DEBRIS,
        ),
      );
    const collider = this.world.createCollider(colDesc, body);
    return { body, collider };
  }

  removeDynamicOrKinematicBody(body: RAPIER.RigidBody, collider?: RAPIER.Collider): void {
    if (this.freed) return;
    if (collider && collider.isValid()) {
      this.world.removeCollider(collider, false);
    }
    if (body.isValid()) {
      this.world.removeRigidBody(body);
    }
  }

  createStickmanBody(
    x: number,
    y: number,
    z: number,
    capsuleHalfHeight = 0.44,
    capsuleRadius = 0.24,
  ): {
    body: RAPIER.RigidBody;
    collider: RAPIER.Collider;
    controller: RAPIER.KinematicCharacterController;
  } {
    const bodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased()
      .setTranslation(x, y, z)
      .setLinearDamping(0.35)
      .setAngularDamping(1.8)
      .setCcdEnabled(true);
    const body = this.world.createRigidBody(bodyDesc);
    body.setEnabledTranslations(true, true, false, true);
    body.setEnabledRotations(false, false, true, true);

    const colDesc = RAPIER.ColliderDesc.capsule(capsuleHalfHeight, capsuleRadius)
      .setDensity(1.4)
      .setFriction(0.55)
      .setRestitution(0.12)
      .setCollisionGroups(
        packInteractionGroups(
          COLLISION_GROUP.PLAYER,
          COLLISION_GROUP.TERRAIN |
            COLLISION_GROUP.CARD_SHELL |
            COLLISION_GROUP.CARD_INTERIOR |
            COLLISION_GROUP.ENEMY,
        ),
      );
    const collider = this.world.createCollider(colDesc, body);

    const controller = this.world.createCharacterController(0.025);
    controller.setUp({ x: 0, y: 1, z: 0 });
    controller.setMaxSlopeClimbAngle((50 * Math.PI) / 180);
    controller.setMinSlopeSlideAngle((58 * Math.PI) / 180);
    controller.enableAutostep(0.28, 0.2, true);
    controller.enableSnapToGround(0.22);
    controller.setApplyImpulsesToDynamicBodies(true);
    controller.setCharacterMass(65);
    this.controllers.push(controller);

    return { body, collider, controller };
  }

  /**
   * Raycast returning hit position and surface normal, avoiding GC heap leaks via reused Ray.
   */
  castRay(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    maxDistance: number,
    filterGroups = packInteractionGroups(
      COLLISION_GROUP.PLAYER,
      COLLISION_GROUP.TERRAIN | COLLISION_GROUP.CARD_SHELL | COLLISION_GROUP.CARD_INTERIOR,
    ),
    excludeCollider?: RAPIER.Collider,
  ): RayHit | null {
    const ray = new RAPIER.Ray({ x: ox, y: oy, z: oz }, { x: dx, y: dy, z: dz });
    const hit = this.world.castRayAndGetNormal(
      ray,
      maxDistance,
      true,
      undefined,
      filterGroups,
      excludeCollider,
    );
    if (!hit) return null;

    const pt = ray.pointAt(hit.timeOfImpact);
    return {
      distance: hit.timeOfImpact,
      pointX: pt.x,
      pointY: pt.y,
      pointZ: pt.z,
      normalX: hit.normal.x,
      normalY: hit.normal.y,
      normalZ: hit.normal.z,
      collider: hit.collider,
    };
  }

  /**
   * Finds the nearest grabbable ledge corner within reach for Fall-Grab Pendulum swings.
   */
  findNearestGrabbableCorner(
    x: number,
    y: number,
    maxRadius: number,
    preferSide = 0,
  ): LedgeCorner | null {
    let best: LedgeCorner | null = null;
    let bestScore = Infinity;
    const maxSq = maxRadius * maxRadius;

    for (let i = 0; i < this.grabbableCorners.length; i++) {
      const corner = this.grabbableCorners[i];
      const dx = corner.x - x;
      const dy = corner.y - y;
      const dSq = dx * dx + dy * dy;
      if (dSq > maxSq) continue;

      // Prefer corners slightly above chest height and in the player's facing/input direction
      const heightPenalty = dy < -0.25 ? 0.65 : 0;
      const dirBonus = preferSide !== 0 && Math.sign(dx) === Math.sign(preferSide) ? -0.18 : 0;
      const score = Math.sqrt(dSq) + heightPenalty + dirBonus;

      if (score < bestScore) {
        bestScore = score;
        best = corner;
      }
    }

    return best;
  }

  step(): void {
    if (this.freed) return;
    this.world.step();
  }

  free(): void {
    if (this.freed) return;
    this.freed = true;
    for (const c of this.controllers) {
      this.world.removeCharacterController(c);
    }
    this.controllers.length = 0;
    this.world.free();
  }
}
