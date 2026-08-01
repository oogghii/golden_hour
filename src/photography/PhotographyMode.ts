import { PHOTOGRAPHY } from '../core/Settings';
import type { System } from '../core/System';
import { CameraPose } from '../camera/CameraPose';
import type { InputState } from '../player/input/InputState';
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
  readonly state: PhotoState = createPhotoState(PHOTOGRAPHY.lens.minMm * 1.5);

  /** Set by CameraInteraction in phase B. Null means nothing is hovered. */
  onCapture: (() => void) | null = null;

  constructor(private readonly input: InputState) {}

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
    this.state.remainingShots = Math.max(0, this.state.remainingShots - 1);
    touch(this.state);
    this.onCapture?.();
  }

  focus(uv?: { x: number; y: number }): void {
    this.state.focusUv.x = uv?.x ?? 0.5;
    this.state.focusUv.y = uv?.y ?? 0.5;
    // The distance itself is filled in by the focus ray in phase B.
    this.state.focusConfirmed = false;
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
