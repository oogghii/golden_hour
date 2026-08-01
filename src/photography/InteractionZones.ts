import type { SettingId } from './PhotoState';

/**
 * One table drives BOTH the drawing and the hit test, so a label can never
 * drift from the thing it activates.
 *
 * Authored with y measured from the TOP, matching the canvas. `zoneAtUv` takes
 * a three.js uv, which is y-up, and converts.
 *
 * Each bar tiles edge to edge. That exhaustive partition — not padding — is the
 * main reason targeting never has to be pixel-perfect: every point on the
 * screen belongs to some zone, so there is nothing to miss.
 */

export type ZoneId = SettingId | 'focusPoint' | 'focusMode' | 'metering' | 'status';

export interface Zone {
  readonly id: ZoneId;
  readonly x0: number;
  readonly x1: number;
  /** From the top. */
  readonly y0: number;
  readonly y1: number;
  readonly adjustable: boolean;
  readonly settingId: SettingId | null;
}

const TOP_BAR = 0.115;
const BOTTOM_BAR = 0.833;

function zone(
  id: ZoneId,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  settingId: SettingId | null = null,
  adjustable = false,
): Zone {
  return { id, x0, x1, y0, y1, settingId, adjustable };
}

export const SCREEN_ZONES: readonly Zone[] = [
  zone('mode', 0.0, 0.24, 0, TOP_BAR, 'mode'),
  zone('focusMode', 0.24, 0.42, 0, TOP_BAR),
  zone('metering', 0.42, 0.6, 0, TOP_BAR),
  zone('status', 0.6, 1.0, 0, TOP_BAR),

  zone('focusPoint', 0.0, 1.0, TOP_BAR, BOTTOM_BAR),

  zone('focal', 0.0, 0.16, BOTTOM_BAR, 1, 'focal', true),
  zone('aperture', 0.16, 0.28, BOTTOM_BAR, 1, 'aperture', true),
  zone('shutterSpeed', 0.28, 0.41, BOTTOM_BAR, 1, 'shutterSpeed', true),
  zone('iso', 0.41, 0.59, BOTTOM_BAR, 1, 'iso', true),
  zone('exposure', 0.59, 1.0, BOTTOM_BAR, 1, 'exposure', true),
];

/** `v` is a three.js uv: 0 at the bottom of the surface. */
export function zoneAtUv(u: number, v: number): Zone | null {
  if (u < 0 || u > 1 || v < 0 || v > 1) return null;
  const y = 1 - v;
  for (const candidate of SCREEN_ZONES) {
    if (u >= candidate.x0 && u <= candidate.x1 && y >= candidate.y0 && y <= candidate.y1) {
      return candidate;
    }
  }
  return null;
}

export function zoneCentreUv(target: Zone): { u: number; v: number } {
  return {
    u: (target.x0 + target.x1) / 2,
    v: 1 - (target.y0 + target.y1) / 2,
  };
}
