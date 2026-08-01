import { beforeEach, describe, expect, it } from 'vitest';
import { createPhotoState, type PhotoState } from './PhotoState';
import {
  APERTURES,
  applyModeCoupling,
  EXPOSURES,
  formatAperture,
  formatExposure,
  formatFocal,
  formatFocusDistance,
  formatIso,
  formatShutter,
  ISOS,
  settingsEv,
  SHUTTERS,
  targetEv,
  viewfinderGain,
} from './ExposureModel';

let state: PhotoState;
beforeEach(() => {
  state = createPhotoState(35);
});

describe('the ladders', () => {
  it('runs apertures from wide to narrow', () => {
    expect(APERTURES[0]).toBeLessThan(APERTURES[APERTURES.length - 1]!);
  });

  it('runs shutters from long to short', () => {
    expect(SHUTTERS[0]).toBeGreaterThan(SHUTTERS[SHUTTERS.length - 1]!);
  });

  it('centres exposure compensation on zero', () => {
    expect(EXPOSURES[(EXPOSURES.length - 1) / 2]).toBe(0);
  });

  it('steps ISO in thirds', () => {
    expect(ISOS[3]! / ISOS[0]!).toBeCloseTo(2, 1);
  });
});

describe('A mode couples shutter to aperture', () => {
  it('shortens the shutter when the aperture opens up', () => {
    state.mode = 'A';
    applyModeCoupling(state, 'aperture');
    const before = state.shutterIndex;
    state.apertureIndex -= 3; // one full stop wider
    applyModeCoupling(state, 'aperture');
    expect(state.shutterIndex).toBeGreaterThan(before);
  });

  it('holds the exposure within a third of a stop across the aperture range', () => {
    state.mode = 'A';
    for (let i = 3; i < APERTURES.length - 3; i++) {
      state.apertureIndex = i;
      applyModeCoupling(state, 'aperture');
      // A third of a stop is 0.333; the ladders carry nominal marks (1/125, not
      // 1/128), which adds up to about 0.05 EV of drift on top.
      expect(Math.abs(settingsEv(state) - targetEv(state))).toBeLessThanOrEqual(0.4);
    }
  });
});

describe('S mode couples aperture to shutter', () => {
  it('opens the aperture when the shutter gets shorter', () => {
    state.mode = 'S';
    applyModeCoupling(state, 'shutterSpeed');
    const before = state.apertureIndex;
    state.shutterIndex += 3;
    applyModeCoupling(state, 'shutterSpeed');
    expect(state.apertureIndex).toBeLessThan(before);
  });
});

describe('P mode derives whichever setting was not just touched', () => {
  it('drives the aperture when the shutter is what changed', () => {
    state.mode = 'P';
    applyModeCoupling(state, 'aperture');
    const aperture = state.apertureIndex;

    state.shutterIndex += 3; // one stop shorter
    const shutter = state.shutterIndex;
    applyModeCoupling(state, 'shutterSpeed');

    expect(state.apertureIndex).toBeLessThan(aperture); // opens up to compensate
    expect(state.shutterIndex).toBe(shutter); // and leaves the touched one alone
  });

  it('drives the shutter when the aperture is what changed', () => {
    state.mode = 'P';
    applyModeCoupling(state, 'aperture');
    const shutter = state.shutterIndex;

    state.apertureIndex -= 3; // one stop wider
    const aperture = state.apertureIndex;
    applyModeCoupling(state, 'aperture');

    expect(state.shutterIndex).toBeGreaterThan(shutter); // shortens to compensate
    expect(state.apertureIndex).toBe(aperture);
  });

  it('holds the exposure whichever side the player works from', () => {
    state.mode = 'P';
    for (let i = 3; i < SHUTTERS.length - 3; i++) {
      state.shutterIndex = i;
      applyModeCoupling(state, 'shutterSpeed');
      // Only where the aperture ladder can still reach; past its ends the
      // clamp is doing its job and the deviation is meant to show.
      if (state.apertureIndex > 0 && state.apertureIndex < APERTURES.length - 1) {
        expect(Math.abs(settingsEv(state) - targetEv(state))).toBeLessThanOrEqual(0.4);
      }
    }
  });
});

describe('M mode couples nothing', () => {
  it('leaves the other settings exactly where they were', () => {
    state.mode = 'M';
    const shutter = state.shutterIndex;
    state.apertureIndex -= 3;
    applyModeCoupling(state, 'aperture');
    expect(state.shutterIndex).toBe(shutter);
  });

  it('reports the deviation through the viewfinder gain', () => {
    state.mode = 'M';
    state.shutterIndex += 3; // one stop shorter, so one stop darker
    expect(viewfinderGain(state)).toBeLessThan(1);
  });
});

describe('exposure compensation', () => {
  it('brightens the viewfinder when dialled positive', () => {
    state.mode = 'A';
    applyModeCoupling(state, 'aperture');
    const neutral = viewfinderGain(state);
    state.exposureIndex += 3;
    applyModeCoupling(state, 'exposure');
    expect(viewfinderGain(state)).toBeGreaterThan(neutral);
  });

  it('never lets the gain run away far enough to blow the screen white', () => {
    state.mode = 'M';
    state.shutterIndex = 0;
    state.apertureIndex = 0;
    state.isoIndex = ISOS.length - 1;
    expect(viewfinderGain(state)).toBeLessThanOrEqual(4);
  });
});

describe('formatting a photographer would recognise', () => {
  it('does not print a trailing zero on whole-stop apertures', () => {
    state.apertureIndex = APERTURES.indexOf(9);
    expect(formatAperture(state)).toBe('F9');
  });

  it('writes long shutters in seconds and short ones as fractions', () => {
    state.shutterIndex = 0;
    expect(formatShutter(state)).toMatch(/"$/);
    state.shutterIndex = SHUTTERS.length - 1;
    expect(formatShutter(state)).toBe('1/4000');
  });

  it('signs exposure compensation and marks zero plainly', () => {
    state.exposureIndex = (EXPOSURES.length - 1) / 2;
    expect(formatExposure(state)).toBe('0');
    state.exposureIndex += 3;
    expect(formatExposure(state)).toMatch(/^\+/);
  });

  it('keeps the decimal on fast apertures and drops it from f/10 up', () => {
    state.apertureIndex = APERTURES.indexOf(1.4);
    expect(formatAperture(state)).toBe('F1.4');
    state.apertureIndex = APERTURES.indexOf(2);
    expect(formatAperture(state)).toBe('F2');
    state.apertureIndex = APERTURES.indexOf(11);
    expect(formatAperture(state)).toBe('F11');
  });

  it('labels ISO rather than printing a bare number', () => {
    state.isoIndex = ISOS.indexOf(400);
    expect(formatIso(state)).toBe('ISO 400');
  });

  it('rounds the focal length to whole millimetres as the lens glides', () => {
    state.focalMm = 36.4;
    expect(formatFocal(state)).toBe('36');
    state.focalMm = 36.6;
    expect(formatFocal(state)).toBe('37');
  });

  it('reads focus distance the way a lens barrel does', () => {
    state.focusDistance = 3.24;
    expect(formatFocusDistance(state)).toBe('3.2 m');
    state.focusDistance = 42.7;
    expect(formatFocusDistance(state)).toBe('43 m');
    state.focusDistance = Infinity;
    expect(formatFocusDistance(state)).toBe('∞');
  });
});
