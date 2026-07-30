import * as THREE from 'three';
import type { EngineContext, System } from '../core/System';
import { PLAYER, WORLD } from '../core/Settings';
import { damp, saturate, smoothstep } from '../util/math';
import type { HeightField } from '../world/HeightField';
import type { FirstPersonCamera } from './FirstPersonCamera';
import type { InputState } from './input/InputState';

/**
 * Where the player is and how they got there. Movement eases in and out, the
 * ground is followed smoothly, and the edges of the world discourage rather
 * than block.
 */
export class Player implements System {
  /** Ground position. The camera sits `eyeHeight` above this, plus bob. */
  readonly position = new THREE.Vector3(PLAYER.start.x, 0, PLAYER.start.z);
  /** Horizontal speed in m/s. Read by the floating camera and the head bob. */
  speed = 0;

  private readonly velocity = new THREE.Vector2();
  private readonly moveDirection = new THREE.Vector2();
  private camera: THREE.PerspectiveCamera | null = null;
  private bobPhase = 0;
  /** Respecting prefers-reduced-motion, per the brief's accessibility default. */
  private readonly motionScale = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ? 0.2
    : 1;

  constructor(
    private readonly height: HeightField,
    private readonly look: FirstPersonCamera,
    private readonly input: InputState,
  ) {}

  init(ctx: EngineContext): void {
    this.camera = ctx.camera;
    this.position.y = this.height.heightAt(this.position.x, this.position.z);
    this.applyToCamera(0);
  }

  update(dt: number, elapsed: number): void {
    if (!this.camera || dt <= 0) return;

    this.integrateVelocity(dt);
    this.step(dt);
    this.applyToCamera(elapsed);
  }

  private integrateVelocity(dt: number): void {
    // Forward for a yaw rotation about +Y, given the camera looks down -Z.
    const sin = Math.sin(this.look.yaw);
    const cos = Math.cos(this.look.yaw);

    this.moveDirection.set(
      -sin * this.input.moveForward + cos * this.input.moveRight,
      -cos * this.input.moveForward - sin * this.input.moveRight,
    );

    // Diagonals must not be faster than straight lines.
    const intent = this.moveDirection.length();
    if (intent > 1) this.moveDirection.divideScalar(intent);

    const targetSpeed = this.input.boost ? PLAYER.strollSpeed : PLAYER.walkSpeed;
    const targetX = this.moveDirection.x * targetSpeed;
    const targetY = this.moveDirection.y * targetSpeed;

    const lambda = intent > 0.01 ? PLAYER.accelLambda : PLAYER.decelLambda;
    this.velocity.x = damp(this.velocity.x, targetX, lambda, dt);
    this.velocity.y = damp(this.velocity.y, targetY, lambda, dt);

    this.applySoftBoundary();
    this.speed = this.velocity.length();
  }

  /**
   * Past the soft boundary the outward component of velocity is progressively
   * removed. No wall, no message: you simply find yourself drifting back.
   */
  private applySoftBoundary(): void {
    const distance = Math.hypot(this.position.x, this.position.z);
    if (distance < WORLD.softBoundary) return;

    const strength = smoothstep(WORLD.softBoundary, WORLD.hardBoundary, distance);
    const nx = this.position.x / distance;
    const nz = this.position.z / distance;
    const outward = this.velocity.x * nx + this.velocity.y * nz;
    if (outward <= 0) return;

    this.velocity.x -= nx * outward * strength;
    this.velocity.y -= nz * outward * strength;
  }

  /** Moves if the ground ahead is dry, otherwise stops short of the water. */
  private step(dt: number): void {
    const nextX = this.position.x + this.velocity.x * dt;
    const nextZ = this.position.z + this.velocity.y * dt;

    // Probe a little ahead of the feet so the stop happens at the shoreline
    // rather than after the first wet step.
    const speed = this.speed;
    const probeX = speed > 0 ? nextX + (this.velocity.x / speed) * PLAYER.shoreMargin : nextX;
    const probeZ = speed > 0 ? nextZ + (this.velocity.y / speed) * PLAYER.shoreMargin : nextZ;

    if (this.height.isSubmerged(probeX, probeZ)) {
      this.velocity.set(0, 0);
      this.speed = 0;
      return;
    }

    this.position.x = nextX;
    this.position.z = nextZ;
    this.position.y = this.height.heightAt(nextX, nextZ);
  }

  private applyToCamera(elapsed: number): void {
    if (!this.camera) return;

    const speedRatio = saturate(this.speed / PLAYER.walkSpeed);
    const bob = PLAYER.bob;

    this.bobPhase += this.speed * bob.frequency * 0.1;
    // Vertical runs at twice the roll frequency, which is what a real gait does.
    const bobY = Math.sin(this.bobPhase * 2) * bob.amplitude * speedRatio * this.motionScale;
    const breathe =
      Math.sin(elapsed * PLAYER.breathe.rate) *
      PLAYER.breathe.amplitude *
      (1 - speedRatio) *
      this.motionScale;

    this.camera.position.set(
      this.position.x,
      this.position.y + PLAYER.eyeHeight + bobY + breathe,
      this.position.z,
    );

    // Handed to the look system, which folds it in as screen roll next frame.
    this.look.roll = Math.sin(this.bobPhase) * bob.roll * speedRatio * this.motionScale;
  }
}
