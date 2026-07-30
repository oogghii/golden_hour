import * as THREE from 'three';
import type { EngineContext, System } from '../core/System';
import { PLAYER } from '../core/Settings';
import { clamp, damp, DEG } from '../util/math';
import { consumeLook, type InputState } from './input/InputState';

/**
 * Owns where the player is looking. The damping is what makes the view feel
 * weighty rather than twitchy, and the exposed rates let the floating camera
 * lean into turns in phase 7.
 */
export class FirstPersonCamera implements System {
  yaw = 0;
  pitch = 0;
  /** Screen roll, written by the player's head bob. */
  roll = 0;
  /** Radians per second, smoothed. Read by the floating camera. */
  yawRate = 0;
  pitchRate = 0;

  private targetYaw = 0;
  private targetPitch = 0;
  private camera: THREE.PerspectiveCamera | null = null;
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly look = { yaw: 0, pitch: 0 };
  private readonly pitchLimit = PLAYER.pitchLimitDeg * DEG;

  constructor(private readonly input: InputState) {}

  init(ctx: EngineContext): void {
    this.camera = ctx.camera;
  }

  update(dt: number): void {
    if (!this.camera || dt <= 0) return;

    consumeLook(this.input, this.look);
    this.targetYaw -= this.look.yaw;
    this.targetPitch = clamp(this.targetPitch - this.look.pitch, -this.pitchLimit, this.pitchLimit);

    const previousYaw = this.yaw;
    const previousPitch = this.pitch;
    this.yaw = damp(this.yaw, this.targetYaw, PLAYER.lookLambda, dt);
    this.pitch = damp(this.pitch, this.targetPitch, PLAYER.lookLambda, dt);

    // Smoothed so a single jittery mouse sample can't make the floating camera
    // flick sideways.
    this.yawRate = damp(this.yawRate, (this.yaw - previousYaw) / dt, 12, dt);
    this.pitchRate = damp(this.pitchRate, (this.pitch - previousPitch) / dt, 12, dt);

    // YXZ applies Z innermost, so roll lands in screen space where we want it.
    this.euler.set(this.pitch, this.yaw, this.roll);
    this.camera.quaternion.setFromEuler(this.euler);
  }
}
