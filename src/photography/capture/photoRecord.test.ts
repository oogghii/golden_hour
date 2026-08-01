import { describe, expect, it } from 'vitest';
import { APERTURES, ISOS } from '../ExposureModel';
import { createPhotoState } from '../PhotoState';
import { photoMetadataFrom } from './photoRecord';

describe('the stored record', () => {
  it('keeps what the display was reading at the shutter', () => {
    const state = createPhotoState(36);
    state.apertureIndex = APERTURES.indexOf(2.8);
    state.isoIndex = ISOS.indexOf(400);
    state.focusDistance = 3.24;

    const record = photoMetadataFrom(state, 1_700_000_000_000);

    expect(record).toMatchObject({
      takenAt: 1_700_000_000_000,
      focalMm: 36,
      aperture: 'F2.8',
      iso: 'ISO 400',
      focusDistance: '3.2 m',
    });
    expect(record.shutterSpeed).toMatch(/^1\//);
  });

  it('stores the infinity mark rather than a number that is not one', () => {
    const state = createPhotoState(36);
    state.focusDistance = Infinity;
    expect(photoMetadataFrom(state, 0).focusDistance).toBe('∞');
  });

  it('rounds the focal length the way the display does', () => {
    const state = createPhotoState(36);
    state.focalMm = 84.6;
    expect(photoMetadataFrom(state, 0).focalMm).toBe(85);
  });

  it('records whole-stop apertures without a trailing zero', () => {
    const state = createPhotoState(36);
    state.apertureIndex = APERTURES.indexOf(11);
    expect(photoMetadataFrom(state, 0).aperture).toBe('F11');
  });
});
