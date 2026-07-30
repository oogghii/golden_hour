import * as THREE from 'three';
import type { QualityTier } from './Quality';
import { DEG } from '../util/math';

/**
 * Every art-direction constant lives here so the look can be retuned without
 * hunting through modules. Sections are added as the phases that consume them
 * land.
 */

export const WORLD = {
  /** Walkable extent, centred on the origin. */
  size: 350,
  /** Distance from centre where the player starts being gently discouraged. */
  softBoundary: 150,
  /** Distance where the pushback is at full strength. */
  hardBoundary: 172,
} as const;

export const VIEW = {
  fovDesktop: 62,
  /** Wider on a phone: a narrow FOV on a small screen feels claustrophobic. */
  fovMobile: 70,
  /** Close enough that the floating camera never clips. */
  near: 0.05,
  far: 900,
} as const;

export const SUN = {
  /** Degrees clockwise from -Z, which is the player's default facing. */
  azimuthDeg: 8,
  /** Low enough for long raking shadows, high enough to avoid shadow acne. */
  elevationDeg: 6.5,
  color: 0xffbe7a,
  intensity: 4.6,
  /**
   * Warm light, cool shadow. This split is what makes the scene read as rich
   * rather than as one orange wash — an olive-brown fill just adds more of the
   * same hue everywhere.
   */
  fillSky: 0xffb0a8,
  fillGround: 0x4a5560,
  fillIntensity: 1.25,
} as const;

export const FOG = {
  /**
   * A dusty rose rather than pure orange. Saturated orange haze overwrites every
   * other hue at distance and flattens the whole scene into one colour; pulling
   * it toward rose lets greens and blues survive into the mid-ground.
   */
  color: 0xe8a695,
  /** Light enough that the mid-ground keeps its own colour. */
  density: 0.0034,
} as const;

export const PLAYER = {
  start: { x: 0, z: 55 },
  eyeHeight: 1.62,
  walkSpeed: 1.25,
  strollSpeed: 1.9,
  /** Separate rates so arrival and departure both ease, and departure lingers. */
  accelLambda: 2.4,
  decelLambda: 3.4,
  /** Radians per pixel of pointer movement. */
  lookSensitivity: 0.0022,
  /** Low enough to feel weighty, high enough not to feel laggy. */
  lookLambda: 16,
  pitchLimitDeg: 78,
  /** Deliberately tiny. Any more and it reads as a shooter. */
  bob: { frequency: 1.9, amplitude: 0.015, roll: 0.007 },
  breathe: { rate: 1.6, amplitude: 0.008 },
  /** Stop this far short of the waterline rather than wading in. */
  shoreMargin: 0.6,
} as const;

export const TERRAIN = {
  /** 350 m across this many quads is ~2 m per quad, which the grass hides. */
  segments: 176,
  hills: { scale: 0.0055, amplitude: 22 },
  mid: { scale: 0.022, amplitude: 3.2 },
  micro: { scale: 0.09, amplitude: 0.55 },
  /**
   * An outer rise that quietly closes the composition instead of a wall. Kept
   * low so it cannot occlude the backdrop ridges behind it.
   */
  rim: { start: 135, end: 178, amplitude: 8 },
  /** The left-hand hill the hero tree stands on. */
  heroRise: { x: -42, z: 30, sigma: 26, amplitude: 9 },
  palette: {
    valley: 0x5c6b34,
    meadow: 0x8f9a48,
    dryGold: 0xcbb066,
    earth: 0x8a6a45,
  },
} as const;

export const LAKE = {
  x: 10,
  z: -88,
  /** Radius of the basin the height field carves, not of the visible water. */
  radius: 78,
  depth: 17,
  level: -12.5,
  /** Must comfortably exceed the shore-guarantee radius in HeightField. */
  planeSize: 260,
  /**
   * The body of the water, seen at steep angles. These are mixed in LINEAR
   * space, where a dark swatch is far darker than it appears — too dark here and
   * the lake turns to red mud against the warm reflection.
   */
  deep: 0x4e8c9c,
  /**
   * The sky it mirrors along the sun's azimuth. Bright, because the sky just
   * above the horizon is bright.
   */
  shallow: 0xf0b98a,
  /**
   * The sky it mirrors away from the sun. Without this the far lake goes 100%
   * warm reflection and loses every trace of blue.
   */
  shallowCool: 0x8fbfc4,
} as const;

export const SKY = {
  /** Inside the far plane, so the dome is never clipped. */
  radius: 800,
  /**
   * Held below the ACES shoulder. At full brightness the tonemap compresses the
   * warm end and the whole sky drains toward cream.
   */
  horizon: 0xf0b877,
  mid: 0xe8875a,
  zenith: 0xc25f80,
  /** Above the pink, so looking up gives cool relief from the warm horizon. */
  apex: 0x685a9c,
  /** Away from the sun the sky is cooler; this is most of the colour variety. */
  antiSun: 0xaf5d7c,
  cloudLit: 0xffd9a8,
  cloudShadow: 0xa8697f,
  /** 0 = soft organic bands, 1 = flat stylized steps like the reference image. */
  cloudQuantize: 0.15,
  coverage: 0.62,
  /** In cloud-projection units, so it scales with the projection above. */
  driftSpeed: 0.04,
} as const;

/**
 * Non-walkable ridges receding toward the horizon. Colours get paler and closer
 * to the fog with distance, which is what reads as aerial perspective.
 */
export const BACKDROP = {
  /**
   * Heights rise faster than distance so each ridge subtends slightly MORE than
   * the one in front of it (0.168 → 0.233 radians). Getting this backwards is
   * what makes a backdrop collapse into a single silhouette.
   */
  layers: [
    { distance: 250, height: 42, jitter: 14, color: 0xd89a7e },
    { distance: 430, height: 82, jitter: 24, color: 0xeeb494 },
    { distance: 640, height: 135, jitter: 36, color: 0xfbcdac },
    { distance: 880, height: 205, jitter: 48, color: 0xffe0c6 },
  ],
} as const;

export const WIND = {
  directionDeg: 118,
  /** Metres of horizontal sway at the tip of a one-metre blade. */
  strength: 0.26,
  /** How much the travelling gust adds on top of the base breeze. */
  gust: 0.9,
} as const;

/**
 * Grading constants. Tints are plain vectors, not colours, so three's colour
 * management never touches them — they are multipliers, not pigments.
 */
export const POST = {
  /** Under 1 so the warm sky sits below the ACES shoulder and keeps its hue. */
  exposure: 0.88,
  /** Applied after the tonemap, to recover what ACES desaturates. */
  saturation: 1.14,
  /**
   * The threshold must sit clearly ABOVE the sky's base brightness. The horizon
   * colour peaks near 1.0 in linear, so a threshold of 1.05 with a wide knee let
   * a slice of the entire sky into the bloom and veiled the whole frame in milk.
   * The sun disc and the backlit grass tips run far higher and still bloom hard.
   */
  bloom: { threshold: 1.85, knee: 0.35, strength: 0.45 },
  /** Effectively a shutter angle. */
  motionBlur: { strength: 0.55, maxPixels: 12 },
  /** Fakes atmospheric scattering around the sun for a handful of instructions. */
  sunGlow: { strength: 0.16, falloff: 4 },
  chromaticAberration: 1.8,
  grain: 0.022,
  vignette: { start: 0.52, end: 1.15, tint: [0.62, 0.5, 0.56] },
  /** Warm highlights, cool shadows. What keeps it rich without oversaturating. */
  highlightTint: [1.07, 1.01, 0.93],
  shadowTint: [0.94, 0.96, 1.08],
  /** Blacks never reach zero, and lift slightly violet. */
  blackLift: [0.018, 0.01, 0.022],
} as const;

export interface GrassBand {
  readonly kind: 'blades' | 'clusters';
  readonly tileSize: number;
  /** Odd. Tiles outside the fade radius are hidden rather than drawn. */
  readonly ringTiles: number;
  readonly density: number;
  readonly fadeStart: number;
  readonly fadeEnd: number;
  /** Ground footprint of a cluster. Clusters only. */
  readonly clusterWidth?: number;
  readonly height: readonly [number, number];
  readonly width: readonly [number, number];
}

/**
 * Bands overlap and fade out by shrinking height to zero, never by going
 * transparent, so nothing ever pops in or out.
 *
 * The invariant every band must satisfy, asserted in DEV by GrassField:
 *   fadeEnd <= tileSize * (ringTiles - 1) / 2
 * A taper that finishes outside the ground its ring covers leaves a bald edge.
 */
export const GRASS = {
  palette: {
    root: 0x334d24,
    mid: 0x6b8342,
    /**
     * Kept off pure green. With almost no blue in the palette, the translucency
     * term drives green high against a near-zero blue channel and the field goes
     * neon lime.
     */
    tip: 0x9caa66,
    /** Per-instance drift toward straw, so some clumps read drier than others. */
    tipDry: 0xc4b478,
  },
  /**
   * Backlit glow through the blades — the biggest single win at golden hour, but
   * it has to be its own colour. Light through a leaf comes out lime-gold; tinting
   * it with the warm sun colour instead floods the whole field orange and kills
   * every trace of green.
   */
  translucency: 0.55,
  translucencyColor: 0xe4dda8,
  /**
   * The grass is lit by a paler gold than the sun disc. Multiplying green by a
   * saturated orange gives olive-orange however green the palette is; keeping the
   * light near-white lets the green survive being lit.
   */
  lightColor: 0xffe6c4,
  /** Grass never grows below this much above the waterline. */
  shoreClearance: 0.15,
  bands: {
    high: [
      {
        kind: 'blades',
        tileSize: 10,
        ringTiles: 5,
        density: 75,
        fadeStart: 16,
        fadeEnd: 20,
        height: [0.45, 1.05],
        width: [0.035, 0.07],
      },
      {
        kind: 'clusters',
        tileSize: 24,
        ringTiles: 7,
        density: 2.6,
        fadeStart: 60,
        fadeEnd: 68,
        clusterWidth: 1.1,
        // Matched to the near band's height, or the mid-ground visibly sags.
        height: [0.6, 1.15],
        width: [0.9, 1.4],
      },
      {
        kind: 'clusters',
        tileSize: 50,
        ringTiles: 7,
        density: 0.14,
        fadeStart: 135,
        fadeEnd: 150,
        clusterWidth: 4,
        height: [1.2, 2.4],
        width: [3.2, 4.8],
      },
    ],
    medium: [
      {
        kind: 'blades',
        tileSize: 10,
        ringTiles: 5,
        density: 40,
        fadeStart: 13,
        fadeEnd: 17,
        height: [0.55, 1.15],
        width: [0.032, 0.06],
      },
      {
        kind: 'clusters',
        tileSize: 30,
        ringTiles: 5,
        density: 1.5,
        fadeStart: 52,
        fadeEnd: 58,
        clusterWidth: 1.4,
        height: [0.5, 0.95],
        width: [1, 1.6],
      },
      {
        kind: 'clusters',
        tileSize: 60,
        ringTiles: 5,
        density: 0.12,
        fadeStart: 105,
        fadeEnd: 118,
        clusterWidth: 4.5,
        height: [1.2, 2.4],
        width: [3.6, 5.2],
      },
    ],
    low: [
      {
        kind: 'blades',
        tileSize: 10,
        ringTiles: 3,
        density: 22,
        fadeStart: 8,
        fadeEnd: 10,
        height: [0.55, 1.1],
        width: [0.035, 0.065],
      },
      {
        kind: 'clusters',
        tileSize: 30,
        ringTiles: 3,
        density: 0.9,
        fadeStart: 26,
        fadeEnd: 30,
        clusterWidth: 1.6,
        height: [0.5, 0.95],
        width: [1.2, 1.8],
      },
    ],
  } satisfies Record<QualityTier, readonly GrassBand[]>,
} as const;

/** Unit wind direction on the ground plane. */
export function windDirection(target = new THREE.Vector2()): THREE.Vector2 {
  const a = WIND.directionDeg * DEG;
  return target.set(Math.sin(a), -Math.cos(a)).normalize();
}

/** Unit vector pointing from the world toward the sun. */
export function sunDirection(target = new THREE.Vector3()): THREE.Vector3 {
  const azimuth = SUN.azimuthDeg * DEG;
  const elevation = SUN.elevationDeg * DEG;
  const horizontal = Math.cos(elevation);
  return target
    .set(Math.sin(azimuth) * horizontal, Math.sin(elevation), -Math.cos(azimuth) * horizontal)
    .normalize();
}
