import {
  formatAperture,
  formatFocusDistance,
  formatIso,
  formatShutter,
} from '../ExposureModel';
import type { PhotoState } from '../PhotoState';

/**
 * What the album shows underneath a photograph.
 *
 * Formatted strings rather than ladder indices, deliberately: the album must
 * show what the display showed at the moment of the shot, and retuning a ladder
 * later must not silently rewrite the history of what was taken.
 */
export interface PhotoMetadata {
  /** Epoch ms. */
  takenAt: number;
  focalMm: number;
  aperture: string;
  shutterSpeed: string;
  iso: string;
  focusDistance: string;
}

export interface PhotoRecord extends PhotoMetadata {
  id: number;
  blob: Blob;
}

export function photoMetadataFrom(state: PhotoState, takenAt: number): PhotoMetadata {
  return {
    takenAt,
    focalMm: Math.round(state.focalMm),
    aperture: formatAperture(state),
    shutterSpeed: formatShutter(state),
    iso: formatIso(state),
    focusDistance: formatFocusDistance(state),
  };
}
