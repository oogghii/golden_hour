import { describe, expect, it } from 'vitest';
import { FLOATING_CAMERA, PHOTOGRAPHY, VIEWFINDER } from './Settings';

describe('FLOATING_CAMERA.screen', () => {
  it('is 3:2, the photographic aspect', () => {
    expect(FLOATING_CAMERA.screen.width / FLOATING_CAMERA.screen.height).toBeCloseTo(1.5, 5);
  });

  it('fits inside the bezel aperture measured from camera.gltf', () => {
    // Aperture: x +/-0.30, y 0.106 -> 0.519, bezel face at z 0.2281.
    const { width, height, position } = FLOATING_CAMERA.screen;
    expect(width).toBeLessThanOrEqual(0.60);
    expect(position[1] - height / 2).toBeGreaterThanOrEqual(0.106);
    expect(position[1] + height / 2).toBeLessThanOrEqual(0.519);
    expect(position[2]).toBeGreaterThanOrEqual(0.2281);
  });
});

describe('PHOTOGRAPHY', () => {
  it('reaches the raised pose with overshoot, not a critically damped crawl', () => {
    expect(PHOTOGRAPHY.raise.zeta).toBeLessThan(1);
    expect(PHOTOGRAPHY.raise.omega).toBeGreaterThan(0);
  });

  it('keeps magnetism subtle enough to assist rather than steer', () => {
    expect(PHOTOGRAPHY.reticle.magnetism).toBeLessThanOrEqual(0.15);
  });

  it('separates the flick threshold from the settle threshold', () => {
    expect(PHOTOGRAPHY.reticle.flickPxPerSec).toBeGreaterThan(
      PHOTOGRAPHY.reticle.settlePxPerSec * 4,
    );
  });
});

describe('VIEWFINDER', () => {
  it('ends its ladder in a frozen frame rather than a smaller live one', () => {
    const last = VIEWFINDER.ladder[VIEWFINDER.ladder.length - 1]!;
    expect(last.hz).toBe(0);
  });

  it('descends monotonically in cost', () => {
    for (let i = 1; i < VIEWFINDER.ladder.length; i++) {
      const prev = VIEWFINDER.ladder[i - 1]!;
      const next = VIEWFINDER.ladder[i]!;
      expect(next.width * next.height * next.hz).toBeLessThan(prev.width * prev.height * prev.hz);
    }
  });

  it('leaves an explicit hysteresis gap so no state satisfies both conditions', () => {
    expect(VIEWFINDER.watchdog.recoverAbove).toBeGreaterThan(VIEWFINDER.watchdog.degradeBelow);
  });

  it('observes for at least two seconds before degrading', () => {
    const { bucketSeconds, degradeBuckets } = VIEWFINDER.watchdog;
    expect(bucketSeconds * degradeBuckets).toBeGreaterThanOrEqual(2);
  });

  it('starts every tier on a rung that exists', () => {
    for (const rung of Object.values(VIEWFINDER.startRung)) {
      expect(rung).toBeLessThan(VIEWFINDER.ladder.length);
    }
  });
});
