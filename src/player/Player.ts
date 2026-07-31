import * as THREE from 'three';
import type { EngineContext, System } from '../core/System';
import { PLAYER, VIEW, WORLD } from '../core/Settings';
import { clamp, damp, saturate, smoothstep } from '../util/math';
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
  private baseFov = 62;
  private currentFovBonus = 0;
  private continuousMoveTime = 0;
  private gaitPhase = 0;
  private gaitWeight = 0;
  private springPos = { vertical: 0, side: 0, pitch: 0, roll: 0, z: 0 };
  private springVel = { vertical: 0, side: 0, pitch: 0, roll: 0, z: 0 };
  private previousSpeed = 0;
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
    this.baseFov = ctx.quality.isTouch ? VIEW.fovMobile : VIEW.fovDesktop;
    this.position.y = this.height.heightAt(this.position.x, this.position.z);
    this.applyToCamera(0, 0);
  }

  update(dt: number, elapsed: number): void {
    if (!this.camera || dt <= 0) return;

    this.integrateVelocity(dt);
    this.step(dt);
    this.applyToCamera(elapsed, dt);
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

    if (intent > 0.01) {
      this.continuousMoveTime += dt;
    } else {
      this.continuousMoveTime = 0;
    }

    // Automatically transition to stroll speed after walking for 2 seconds
    const autoBoost = smoothstep(2.0, 4.0, this.continuousMoveTime);
    const targetSpeed = PLAYER.walkSpeed + autoBoost * (PLAYER.strollSpeed - PLAYER.walkSpeed);

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

  private applyToCamera(elapsed: number, dt: number): void {
    if (!this.camera) return;

    const speedRatio = saturate(this.speed / PLAYER.walkSpeed);
    const bob = PLAYER.bob;
    const phys = PLAYER.physics;

    let targetFovBonus = 0;
    if (this.speed > 0.1) {
      if (this.speed <= PLAYER.walkSpeed) {
        targetFovBonus = (this.speed / PLAYER.walkSpeed) * VIEW.dynamicFov.walkBonus;
      } else {
        const over = saturate((this.speed - PLAYER.walkSpeed) / (PLAYER.strollSpeed - PLAYER.walkSpeed));
        targetFovBonus = VIEW.dynamicFov.walkBonus + over * (VIEW.dynamicFov.strollBonus - VIEW.dynamicFov.walkBonus);
      }
    }
    this.currentFovBonus = damp(this.currentFovBonus, targetFovBonus, VIEW.dynamicFov.lambda, dt);

    if (Math.abs(this.camera.fov - (this.baseFov + this.currentFovBonus)) > 0.01) {
      this.camera.fov = this.baseFov + this.currentFovBonus;
      this.camera.updateProjectionMatrix();
    }

    const accel = dt > 0 ? (this.speed - this.previousSpeed) / dt : 0;
    this.previousSpeed = this.speed;

    this.gaitPhase += this.speed * bob.cyclesPerMetre * Math.PI * 2 * dt;
    this.gaitWeight = damp(this.gaitWeight, speedRatio, phys.gaitWeightLambda, dt);

    const phase = this.gaitPhase;
    const asymmetry = 1.0 + 0.15 * Math.sin(phase * 0.5);
    const verticalGait = -Math.abs(Math.sin(phase)) * asymmetry + Math.sin(phase * 2.13 + 0.8) * 0.1;
    const sideGait = Math.sin(phase) * 0.8 + Math.sin(phase * 2.07 + 2.1) * 0.2;
    const pitchGait = -Math.abs(Math.sin(phase + 0.15)) * asymmetry + Math.sin(phase * 2.0 + 0.5) * 0.15;

    const targetVertical = verticalGait * bob.verticalAmplitude * this.gaitWeight * this.motionScale;
    const targetSide = sideGait * bob.swayAmplitude * this.gaitWeight * this.motionScale;

    // Lean into the movement direction
    const inputPitch = -this.input.moveForward * (phys.movementLeanPitch || 0);
    const inputRoll = -this.input.moveRight * (phys.movementLeanRoll || 0);

    const targetPitch = (pitchGait * bob.pitchAmplitude * this.gaitWeight + accel * phys.accelPitchMultiplier + inputPitch) * this.motionScale;
    const targetZ = accel * phys.accelZMultiplier * this.motionScale;

    const lookRoll = clamp(-this.look.yawRate * phys.turnRollMultiplier, -phys.turnRollMax, phys.turnRollMax);
    const gaitRoll = sideGait * bob.swayAmplitude * 0.4 * this.gaitWeight;
    const targetRoll = (lookRoll + gaitRoll + inputRoll) * this.motionScale;

    const stiffness = phys.springStiffness;
    const damping = phys.springDamping;
    const updateSpring = (pos: number, vel: number, target: number) => {
        const force = (target - pos) * stiffness - vel * damping;
        const newVel = vel + force * dt;
        const newPos = pos + newVel * dt;
        return [newPos, newVel];
    };

    [this.springPos.vertical, this.springVel.vertical] = updateSpring(this.springPos.vertical, this.springVel.vertical, targetVertical);
    [this.springPos.side, this.springVel.side] = updateSpring(this.springPos.side, this.springVel.side, targetSide);
    [this.springPos.pitch, this.springVel.pitch] = updateSpring(this.springPos.pitch, this.springVel.pitch, targetPitch);
    [this.springPos.roll, this.springVel.roll] = updateSpring(this.springPos.roll, this.springVel.roll, targetRoll);
    [this.springPos.z, this.springVel.z] = updateSpring(this.springPos.z, this.springVel.z, targetZ);

    const breatheTime = elapsed * PLAYER.breathe.rate;
    const breathe =
      (Math.sin(breatheTime) + Math.sin(breatheTime * 2.1) * 0.25) *
      PLAYER.breathe.amplitude *
      (1 - speedRatio) *
      this.motionScale;

    const rightX = Math.cos(this.look.yaw);
    const rightZ = -Math.sin(this.look.yaw);
    const forwardX = Math.sin(this.look.yaw);
    const forwardZ = Math.cos(this.look.yaw);

    this.camera.position.set(
      this.position.x + rightX * this.springPos.side + forwardX * this.springPos.z,
      this.position.y + PLAYER.eyeHeight + this.springPos.vertical + breathe,
      this.position.z + rightZ * this.springPos.side + forwardZ * this.springPos.z,
    );

    this.look.roll = this.springPos.roll;
    this.look.pitchOffset = this.springPos.pitch;
  }
}
