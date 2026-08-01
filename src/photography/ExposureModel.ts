import { PHOTOGRAPHY } from '../core/Settings';
import { clamp } from '../util/math';
import type { PhotoState, SettingId } from './PhotoState';

/**
 * Aperture, shutter and ISO linked through EV. This is the thing a photographer
 * notices in the first ten seconds: f/1.4 with 1/8000 at ISO 6400 showing a
 * normally exposed image would break the illusion completely.
 *
 * All three ladders are third-stop, so an index step is always 1/3 EV and the
 * coupling arithmetic is plain integer addition.
 */

export const APERTURES: readonly number[] = [
  1.4, 1.6, 1.8, 2, 2.2, 2.5, 2.8, 3.2, 3.5, 4, 4.5, 5, 5.6, 6.3, 7.1, 8, 9, 10, 11, 13, 14, 16,
  18, 20, 22,
];

/** Seconds. Long to short, so a higher index is always a shorter exposure. */
export const SHUTTERS: readonly number[] = [
  30, 25, 20, 15, 13, 10, 8, 6, 5, 4, 3.2, 2.5, 2, 1.6, 1.3, 1, 1 / 1.3, 1 / 1.6, 1 / 2, 1 / 2.5,
  1 / 3, 1 / 4, 1 / 5, 1 / 6, 1 / 8, 1 / 10, 1 / 13, 1 / 15, 1 / 20, 1 / 25, 1 / 30, 1 / 40,
  1 / 50, 1 / 60, 1 / 80, 1 / 100, 1 / 125, 1 / 160, 1 / 200, 1 / 250, 1 / 320, 1 / 400, 1 / 500,
  1 / 640, 1 / 800, 1 / 1000, 1 / 1250, 1 / 1600, 1 / 2000, 1 / 2500, 1 / 3200, 1 / 4000,
];

export const ISOS: readonly number[] = [
  100, 125, 160, 200, 250, 320, 400, 500, 640, 800, 1000, 1250, 1600, 2000, 2500, 3200, 4000,
  5000, 6400, 8000, 10000, 12800,
];

/** Thirds from -3 to +3. Index 9 is 0. */
export const EXPOSURES: readonly number[] = Array.from(
  { length: 19 },
  (_unused, i) => Math.round((i - 9) * (1 / 3) * 100) / 100,
);

/** The gain is clamped so manual mode can never wash the display to white. */
const GAIN_LIMIT = 4;

function at(ladder: readonly number[], index: number): number {
  return ladder[clamp(Math.round(index), 0, ladder.length - 1)]!;
}

/** The EV the current settings are exposing for, referred to ISO 100. */
export function settingsEv(state: PhotoState): number {
  const aperture = at(APERTURES, state.apertureIndex);
  const shutter = at(SHUTTERS, state.shutterIndex);
  const iso = at(ISOS, state.isoIndex);
  return Math.log2((aperture * aperture) / shutter) - Math.log2(iso / 100);
}

/** The EV the scene actually is, offset by the compensation dial. */
export function targetEv(state: PhotoState): number {
  return PHOTOGRAPHY.sceneEv - at(EXPOSURES, state.exposureIndex);
}

/**
 * How much to scale the viewfinder image. Above 1 the settings are letting in
 * more light than the scene needs. This grades the viewfinder texture only,
 * never the player's own view.
 */
export function viewfinderGain(state: PhotoState): number {
  return clamp(2 ** (targetEv(state) - settingsEv(state)), 1 / GAIN_LIMIT, GAIN_LIMIT);
}

/**
 * Re-derives whichever setting the current mode controls, so the numbers stay
 * internally consistent. Manual couples nothing and lets the deviation show.
 */
export function applyModeCoupling(state: PhotoState, changed: SettingId): void {
  if (state.mode === 'M') return;

  // Thirds throughout, so the correction is a whole number of index steps.
  const errorSteps = Math.round((settingsEv(state) - targetEv(state)) * 3);
  if (errorSteps === 0) return;

  /*
   * Both ladders are ordered so that a HIGHER index means a HIGHER settings EV
   * — a narrower aperture, or a shorter exposure. So correcting a positive
   * error (settings exposing for a brighter scene than reality, image too dark)
   * always means stepping DOWN, in either ladder. Getting this sign wrong sends
   * the shutter to the end of its range on the very first coupling.
   */
  const drive = derivedSetting(state.mode, changed);
  if (drive === 'shutterSpeed') {
    state.shutterIndex = clamp(state.shutterIndex - errorSteps, 0, SHUTTERS.length - 1);
  } else {
    state.apertureIndex = clamp(state.apertureIndex - errorSteps, 0, APERTURES.length - 1);
  }
}

function derivedSetting(mode: PhotoState['mode'], changed: SettingId): 'shutterSpeed' | 'aperture' {
  if (mode === 'S') return 'aperture';
  if (mode === 'A') return 'shutterSpeed';
  // P derives whichever the player did not just touch.
  return changed === 'shutterSpeed' ? 'aperture' : 'shutterSpeed';
}

export function formatAperture(state: PhotoState): string {
  const value = at(APERTURES, state.apertureIndex);
  return `F${value < 10 ? value.toFixed(1) : value.toFixed(0)}`;
}

export function formatShutter(state: PhotoState): string {
  const seconds = at(SHUTTERS, state.shutterIndex);
  if (seconds >= 1) return `${seconds % 1 === 0 ? seconds : seconds.toFixed(1)}"`;
  return `1/${Math.round(1 / seconds)}`;
}

export function formatIso(state: PhotoState): string {
  return `ISO ${at(ISOS, state.isoIndex)}`;
}

export function formatExposure(state: PhotoState): string {
  const value = at(EXPOSURES, state.exposureIndex);
  if (value === 0) return '0';
  return `${value > 0 ? '+' : '−'}${Math.abs(value).toFixed(1)}`;
}

export function formatFocal(state: PhotoState): string {
  return `${Math.round(state.focalMm)}`;
}
