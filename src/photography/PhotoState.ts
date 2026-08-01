/**
 * Everything the rear display shows and the interaction layer edits. Plain data
 * with a revision counter, so the chrome texture can redraw only when something
 * it draws has actually changed.
 */

export type SettingId = 'focal' | 'aperture' | 'shutterSpeed' | 'iso' | 'exposure' | 'mode';
export type ShootingMode = 'P' | 'A' | 'S' | 'M';

export const SHOOTING_MODES: readonly ShootingMode[] = ['P', 'A', 'S', 'M'];

export interface PhotoState {
  mode: ShootingMode;
  /** Where the zoom is heading. `focalMm` chases it. */
  targetFocalMm: number;
  focalMm: number;
  apertureIndex: number;
  shutterIndex: number;
  isoIndex: number;
  exposureIndex: number;
  selected: SettingId | null;
  /** Metres. Infinity reads as the infinity mark on the display. */
  focusDistance: number;
  focusConfirmed: boolean;
  focusUv: { x: number; y: number };
  remainingShots: number;
  /** 0..1. */
  battery: number;
  /** Bumped whenever anything the chrome layer draws changes. */
  revision: number;
}

export function createPhotoState(focalMm: number): PhotoState {
  return {
    mode: 'A',
    targetFocalMm: focalMm,
    focalMm,
    // f/2.8, 1/250, ISO 400, +0.0 — a correct exposure for PHOTOGRAPHY.sceneEv,
    // so the display is plausible before the player touches anything.
    apertureIndex: 6,
    shutterIndex: 39,
    isoIndex: 6,
    exposureIndex: 9,
    selected: null,
    focusDistance: Infinity,
    focusConfirmed: false,
    focusUv: { x: 0.5, y: 0.5 },
    remainingShots: 248,
    battery: 0.82,
    revision: 0,
  };
}

export function touch(state: PhotoState): void {
  state.revision++;
}
