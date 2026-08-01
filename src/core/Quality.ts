export type QualityTier = 'high' | 'medium' | 'low';

export interface QualitySettings {
  readonly tier: QualityTier;
  /**
   * Hard render cap. Infinity on desktop; 30 on touch devices, where a pinned
   * 30 reads as film cadence while an unstable 45 just reads as broken.
   */
  readonly frameCap: number;
  readonly renderScale: number;
  readonly dprCap: number;
  /** 0 disables shadows entirely. */
  readonly shadowMapSize: number;
  readonly msaaSamples: number;
  readonly bloomMips: number;
  readonly motionBlurTaps: number;
  readonly isTouch: boolean;
}

type TierProfile = Omit<QualitySettings, 'tier' | 'frameCap' | 'isTouch'>;

const PROFILES: Record<QualityTier, TierProfile> = {
  high: {
    renderScale: 1,
    dprCap: 2,
    shadowMapSize: 2048,
    msaaSamples: 4,
    bloomMips: 3,
    motionBlurTaps: 5,
  },
  medium: {
    renderScale: 0.9,
    dprCap: 2,
    shadowMapSize: 1024,
    msaaSamples: 0,
    bloomMips: 2,
    motionBlurTaps: 5,
  },
  low: {
    renderScale: 0.7,
    dprCap: 1.5,
    shadowMapSize: 0,
    msaaSamples: 0,
    bloomMips: 2,
    motionBlurTaps: 3,
  },
};

const TIER_NAMES: readonly string[] = ['high', 'medium', 'low'];

function queryParam(name: string): string | null {
  return new URLSearchParams(window.location.search).get(name);
}

function forcedTier(): QualityTier | null {
  const raw = queryParam('quality');
  return raw !== null && TIER_NAMES.includes(raw) ? (raw as QualityTier) : null;
}

/** `?fps=30` or `?fps=off`, for comparing cadences on a desktop. */
function forcedFrameCap(): number | null {
  const raw = queryParam('fps');
  if (raw === null) return null;
  if (raw === 'off') return Number.POSITIVE_INFINITY;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** `?vf=0..3` pins a viewfinder ladder rung, for exercising the ends by hand. */
export function forcedViewfinderRung(): number | null {
  const raw = queryParam('vf');
  if (raw === null) return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function detectTier(isTouch: boolean): QualityTier {
  const cores = navigator.hardwareConcurrency ?? 4;
  if (!isTouch) return cores >= 4 ? 'high' : 'medium';
  // An iPhone 15 reports 6 logical cores and holds the medium profile
  // comfortably at a pinned 30. Older or cheaper phones fall to low.
  return cores >= 6 ? 'medium' : 'low';
}

export function resolveQuality(): QualitySettings {
  const isTouch = (navigator.maxTouchPoints ?? 0) > 0;
  const tier = forcedTier() ?? detectTier(isTouch);
  const frameCap = forcedFrameCap() ?? (isTouch ? 30 : Number.POSITIVE_INFINITY);
  return { tier, isTouch, frameCap, ...PROFILES[tier] };
}
