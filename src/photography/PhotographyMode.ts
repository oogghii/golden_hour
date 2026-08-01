import type * as THREE from 'three';
import { PHOTOGRAPHY } from '../core/Settings';
import type { System } from '../core/System';
import { CameraPose } from '../camera/CameraPose';
import type { InputState } from '../player/input/InputState';
import type { HeightField } from '../world/HeightField';
import { clamp, damp, lerp } from '../util/math';
import {
  APERTURES,
  applyModeCoupling,
  EXPOSURES,
  ISOS,
  SHUTTERS,
} from './ExposureModel';
import type { CameraActions } from './CameraActions';
import {
  createPhotoState,
  SHOOTING_MODES,
  touch,
  type PhotoState,
  type SettingId,
} from './PhotoState';

/**
 * Owns the mode and implements every semantic action. Registered BEFORE the
 * look system so it can scale the shared input state in place — which is how
 * movement is gated without touching Player.ts or FirstPersonCamera.ts.
 */
export class PhotographyMode implements System, CameraActions {
  readonly pose = new CameraPose();
  readonly state: PhotoState = createPhotoState(PHOTOGRAPHY.lens.startMm);

  /**
   * Set by PhotoCapture. Returns false when the press was refused — a capture
   * is already in flight — so the film counter is not spent on a press that
   * took no photograph.
   */
  onCapture: (() => boolean | void) | null = null;

  constructor(
    private readonly input: InputState,
    private readonly height: HeightField,
  ) {}

  update(dt: number): void {
    if (dt <= 0) return;

    const raise = clamp(this.pose.raise, 0, 1);
    const move = lerp(1, PHOTOGRAPHY.moveScale, raise);
    const look = lerp(1, PHOTOGRAPHY.lookScale, raise);

    this.input.moveForward *= move;
    this.input.moveRight *= move;
    this.input.lookDeltaYaw *= look;
    this.input.lookDeltaPitch *= look;

    const next = damp(
      this.state.focalMm,
      this.state.targetFocalMm,
      PHOTOGRAPHY.lens.lambda,
      dt,
    );
    if (Math.round(next) !== Math.round(this.state.focalMm)) touch(this.state);
    this.state.focalMm = next;
  }

  enterPhotographyMode(): void {
    if (this.pose.isRaised) return;
    this.pose.setRaised(true);
    touch(this.state);
  }

  exitPhotographyMode(): void {
    if (!this.pose.isRaised) return;
    this.pose.setRaised(false);
    this.state.selected = null;
    touch(this.state);
  }

  togglePhotographyMode(): void {
    if (this.pose.isRaised) this.exitPhotographyMode();
    else this.enterPhotographyMode();
  }

  shutter(phase: 'down' | 'up'): void {
    if (phase === 'down' || !this.pose.isRaised) return;
    if (this.state.remainingShots <= 0) return;
    // Fires before the counter moves: the hook returns false when a capture is
    // already running, and a press that takes no photograph must not cost a
    // frame of film either.
    if (this.onCapture && this.onCapture() === false) return;
    this.state.remainingShots -= 1;
    touch(this.state);
  }

  focus(uv?: { x: number; y: number }): void {
    this.state.focusUv.x = uv?.x ?? 0.5;
    this.state.focusUv.y = uv?.y ?? 0.5;
    // The distance itself arrives separately, via setFocusResult: it takes a
    // world-space ray, and PhotographyMode cannot compute that itself without
    // depending on Viewfinder (which already depends on PhotographyMode for
    // its pose). CameraInteraction casts the ray and calls back in.
    this.state.focusConfirmed = false;
    touch(this.state);
  }

  /**
   * A coarse march against the height field, refined by bisection. Cheap, and
   * it gives a real distance for the readout, the focus confirmation and —
   * when depth of field lands — the blur.
   *
   * Public because CameraInteraction calls it directly: it holds the floating
   * camera's live pose and therefore computes the ray itself, but the height
   * field the ray is marched against stays owned here.
   *
   * Runs once per focus event, not per frame, so the coarse-then-bisect
   * approach does not need to be fast — but the loop itself must not
   * allocate, hence scalars rather than Vector3s inside it.
   */
  measureFocusDistance(origin: THREE.Vector3, direction: THREE.Vector3): number {
    const { stepMetres, maxMetres, refineIterations } = PHOTOGRAPHY.focus;
    let previous = 0;
    // `t` is annotated: PHOTOGRAPHY is `as const`, so stepMetres' type is the
    // literal 1.5, not number — without this, `t` infers that literal type
    // and every later assignment of a computed number to it (or to `hi`,
    // copied from `t`) fails to typecheck.
    for (let t: number = stepMetres; t < maxMetres; t += stepMetres) {
      const x = origin.x + direction.x * t;
      const y = origin.y + direction.y * t;
      const z = origin.z + direction.z * t;
      if (y <= this.height.heightAt(x, z)) {
        // Bisect between the last clear sample and this one.
        let lo = previous;
        let hi = t;
        for (let i = 0; i < refineIterations; i++) {
          const mid = (lo + hi) / 2;
          const my = origin.y + direction.y * mid;
          if (my <= this.height.heightAt(origin.x + direction.x * mid, origin.z + direction.z * mid)) {
            hi = mid;
          } else {
            lo = mid;
          }
        }
        return (lo + hi) / 2;
      }
      previous = t;
    }
    // A ray that never meets the ground — a camera pointed at the sky. The
    // display reads this as the infinity mark, which is correct, not an error.
    return Infinity;
  }

  /**
   * Written by CameraInteraction once it has marched the focus ray. Split
   * from `focus()` for the same reason `measureFocusDistance` is public: the
   * ray itself is CameraInteraction's to compute.
   */
  setFocusResult(distanceMetres: number): void {
    this.state.focusDistance = distanceMetres;
    this.state.focusConfirmed = true;
    touch(this.state);
  }

  zoom(deltaLogMm: number): void {
    const { minMm, maxMm } = PHOTOGRAPHY.lens;
    const next = Math.exp(clamp(Math.log(this.state.targetFocalMm) + deltaLogMm,
      Math.log(minMm), Math.log(maxMm)));
    this.state.targetFocalMm = next;
  }

  selectSetting(id: SettingId | null): void {
    if (this.state.selected === id) return;
    this.state.selected = id;
    touch(this.state);
  }

  changeSetting(delta: number): void {
    const id = this.state.selected;
    if (id === null || delta === 0) return;
    const step = Math.trunc(delta);
    if (step === 0) return;
    const state = this.state;

    switch (id) {
      case 'focal':
        this.zoom(step * PHOTOGRAPHY.lens.wheelStep);
        return;
      case 'aperture':
        state.apertureIndex = clamp(state.apertureIndex + step, 0, APERTURES.length - 1);
        break;
      case 'shutterSpeed':
        state.shutterIndex = clamp(state.shutterIndex + step, 0, SHUTTERS.length - 1);
        break;
      case 'iso':
        state.isoIndex = clamp(state.isoIndex + step, 0, ISOS.length - 1);
        break;
      case 'exposure':
        state.exposureIndex = clamp(state.exposureIndex + step, 0, EXPOSURES.length - 1);
        break;
      case 'mode': {
        const index = SHOOTING_MODES.indexOf(state.mode);
        const count = SHOOTING_MODES.length;
        state.mode = SHOOTING_MODES[(index + step % count + count) % count]!;
        break;
      }
    }

    applyModeCoupling(state, id);
    touch(state);
  }
}
