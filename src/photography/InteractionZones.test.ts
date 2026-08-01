import { describe, expect, it } from 'vitest';
import { SCREEN_ZONES, zoneAtUv, zoneCentreUv, type Zone } from './InteractionZones';

const TOP = SCREEN_ZONES.filter((z) => z.y0 === 0);
const BOTTOM = SCREEN_ZONES.filter((z) => z.y1 === 1);

function assertRowIsExhaustive(row: readonly Zone[]): void {
  const sorted = [...row].sort((a, b) => a.x0 - b.x0);
  expect(sorted[0]!.x0).toBe(0);
  expect(sorted[sorted.length - 1]!.x1).toBe(1);
  for (let i = 1; i < sorted.length; i++) {
    expect(sorted[i]!.x0).toBe(sorted[i - 1]!.x1);
  }
}

describe('the partition is exhaustive, so there is nothing to miss', () => {
  it('tiles the top bar edge to edge with no gaps and no overlaps', () => {
    assertRowIsExhaustive(TOP);
  });

  it('tiles the bottom bar edge to edge with no gaps and no overlaps', () => {
    assertRowIsExhaustive(BOTTOM);
  });

  it('finds a zone at every point on the screen', () => {
    for (let u = 0.01; u < 1; u += 0.017) {
      for (let v = 0.01; v < 1; v += 0.017) {
        expect(zoneAtUv(u, v), `no zone at ${u.toFixed(2)},${v.toFixed(2)}`).not.toBeNull();
      }
    }
  });
});

describe('lookup', () => {
  it('reads uv y-up, so the top bar is at high v', () => {
    expect(zoneAtUv(0.1, 0.97)!.id).toBe('mode');
    expect(zoneAtUv(0.1, 0.03)!.id).toBe('focal');
  });

  it('puts the image area between the two bars', () => {
    expect(zoneAtUv(0.5, 0.5)!.id).toBe('focusPoint');
  });

  it('returns null outside the surface rather than clamping', () => {
    expect(zoneAtUv(-0.01, 0.5)).toBeNull();
    expect(zoneAtUv(0.5, 1.01)).toBeNull();
  });
});

describe('zone metadata', () => {
  it('marks exactly the five exposure controls adjustable', () => {
    const adjustable = SCREEN_ZONES.filter((z) => z.adjustable).map((z) => z.id).sort();
    expect(adjustable).toEqual(['aperture', 'exposure', 'focal', 'iso', 'shutterSpeed']);
  });

  it('never names a zone `shutter`, which would read as the capture action', () => {
    expect(SCREEN_ZONES.some((z) => (z.id as string) === 'shutter')).toBe(false);
  });

  it('centres are inside their own zone', () => {
    for (const zone of SCREEN_ZONES) {
      const { u, v } = zoneCentreUv(zone);
      expect(zoneAtUv(u, v)!.id).toBe(zone.id);
    }
  });
});
