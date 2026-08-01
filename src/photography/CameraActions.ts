import type { SettingId } from './PhotoState';

/**
 * The whole semantic surface of the camera. Mouse, raycasts and future touch
 * gestures all invoke exactly these — nothing else may reach into PhotoState.
 * This is what keeps a desktop-only assumption from leaking into the design.
 */
export interface CameraActions {
  enterPhotographyMode(): void;
  exitPhotographyMode(): void;
  /** Split so the cap can depress on `down` and only fire on a matching `up`. */
  shutter(phase: 'down' | 'up'): void;
  /** `uv` omitted focuses the centre of the frame. */
  focus(uv?: { x: number; y: number }): void;
  /** Additive in log-mm, so a step feels the same at 24mm and at 120mm. */
  zoom(deltaLogMm: number): void;
  selectSetting(id: SettingId | null): void;
  /** Steps the selected setting. `delta` is in ladder indices. */
  changeSetting(delta: number): void;
}
