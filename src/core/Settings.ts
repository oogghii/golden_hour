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
  near: 0.05,
  far: 900,
  dynamicFov: {
    walkBonus: 1.5,
    strollBonus: 3.5,
    lambda: 3.0,
  },
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
  /** Light enough that the mid-ground keeps its own colour, but hides the far grass fade. */
  density: 0.0037,
} as const;

export const PLAYER = {
  start: { x: 0, z: 55 },
  eyeHeight: 1.62,
  walkSpeed: 2.1,
  strollSpeed: 3.1,
  /** Separate rates so arrival and departure both ease, and departure lingers. */
  accelLambda: 3.5,
  decelLambda: 4.5,
  /** Radians per pixel of pointer movement. */
  lookSensitivity: 0.0022,
  /** Low enough to feel weighty, high enough not to feel laggy. */
  lookLambda: 16,
  pitchLimitDeg: 78,
  /**
   * A slow, body-led gait rather than an FPS-style camera bounce. The phase is
   * distance-driven, so it naturally slows with the player instead of playing
   * at a fixed tempo while they coast to a stop.
   */
  bob: {
    cyclesPerMetre: 0.45,
    verticalAmplitude: 0.026,
    swayAmplitude: 0.028,
    pitchAmplitude: 0.012,
  },
  physics: {
    gaitWeightLambda: 3.5,
    springStiffness: 85,
    springDamping: 12,
    accelPitchMultiplier: 0.012,
    accelZMultiplier: 0.015,
    turnRollMultiplier: 0.008,
    turnRollMax: 0.03,
    movementLeanRoll: 0.015,
    movementLeanPitch: 0.01,
  },
  breathe: { rate: 1.4, amplitude: 0.012 },
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
  /** Optional near-side height fade for coarser LODs. */
  readonly nearFadeStart?: number;
  readonly nearFadeEnd?: number;
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
    root: 0x3b5a28,
    mid: 0x718d45,
    /**
     * Kept off pure green. With almost no blue in the palette, the translucency
     * term drives green high against a near-zero blue channel and the field goes
     * neon lime.
     */
    tip: 0xa1b966,
    /** Reserved for the few blades catching the warmest direct light. */
    tipSun: 0xbdad69,
  },
  /**
   * Ecological noise fields driving the mid-scale vegetation.
   */
  ecology: {
    /** 40m scale baseline. High richness = taller, greener, more flowers. */
    richness: {
      scale: 0.025,
      heightInfluence: 0.25, // +/- 25% height
      colorInfluence: 0.4, // Pulls towards deep green
    },
    /** 20m scale competition. High overgrowth = much taller, spiky, slightly drier. */
    overgrowth: {
      scale: 0.05,
      heightInfluence: 0.35,
      colorInfluence: 0.3, // Pulls towards dry gold
    },
    /** 15m scale floral patches, gated by richness and overgrowth. */
    floral: {
      scale: 0.065,
      density: 0.65, // How aggressive the flower gating is
    },
    /** Value variation multiplier for shading. */
    valueVariation: 0.08,
    sunHighlight: 0.2,
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
        nearFadeStart: 9,
        nearFadeEnd: 18,
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
        fadeStart: 110,
        fadeEnd: 140,
        nearFadeStart: 46,
        nearFadeEnd: 62,
        clusterWidth: 4,
        height: [1.2, 2.4],
        width: [3.2, 4.8],
      },
      {
        kind: 'clusters',
        tileSize: 90,
        ringTiles: 5,
        density: 0.04,
        fadeStart: 135,
        fadeEnd: 180,
        nearFadeStart: 80,
        nearFadeEnd: 120,
        clusterWidth: 4.5,
        height: [1.2, 2.4],
        width: [3.6, 5.2],
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
        nearFadeStart: 8,
        nearFadeEnd: 16,
        clusterWidth: 1.4,
        height: [0.5, 0.95],
        width: [1, 1.6],
      },
      {
        kind: 'clusters',
        tileSize: 60,
        ringTiles: 5,
        density: 0.12,
        fadeStart: 80,
        fadeEnd: 110,
        nearFadeStart: 38,
        nearFadeEnd: 54,
        clusterWidth: 4.5,
        height: [1.2, 2.4],
        width: [3.6, 5.2],
      },
      {
        kind: 'clusters',
        tileSize: 80,
        ringTiles: 5,
        density: 0.03,
        fadeStart: 105,
        fadeEnd: 150,
        nearFadeStart: 60,
        nearFadeEnd: 95,
        clusterWidth: 5.0,
        height: [1.2, 2.4],
        width: [4.0, 5.8],
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
        fadeStart: 22,
        fadeEnd: 28,
        nearFadeStart: 5,
        nearFadeEnd: 10,
        clusterWidth: 1.6,
        height: [0.5, 0.95],
        width: [1.2, 1.8],
      },
      {
        kind: 'clusters',
        tileSize: 60,
        ringTiles: 3,
        density: 0.15,
        fadeStart: 25,
        fadeEnd: 60,
        nearFadeStart: 15,
        nearFadeEnd: 25,
        clusterWidth: 4.0,
        height: [1.0, 2.0],
        width: [3.0, 4.5],
      },
    ],
  } satisfies Record<QualityTier, readonly GrassBand[]>,
} as const;

/**
 * Phase 5 prop direction. Natural props use irregular low-poly silhouettes and
 * broad colour families; the fence stays visibly hand-built. Counts are tiered
 * so the composition survives on mobile without changing the layout rules.
 */
export const PROPS = {
  scatter: {
    attemptsPerItem: 18,
    startClearance: 5,
  },
  trees: {
    hero: {
      x: TERRAIN.heroRise.x,
      z: TERRAIN.heroRise.z,
      scale: 1.18,
      seed: 517,
    },
    scattered: {
      seed: 1049,
      count: { high: 11, medium: 8, low: 5 },
      bounds: [-132, 132, -62, 112] as const,
      minNormalY: 0.9,
      lakeClearance: 1.5,
      startClearance: 34,
      scale: [0.58, 0.92] as const,
    },
    trunk: {
      height: 7.4,
      radius: 0.68,
      color: 0x68452f,
      lightColor: 0x8c6040,
    },
    canopy: {
      radius: 3.35,
      sway: 0.24,
      colors: [0x526b34, 0x6f8140, 0x82914b, 0x9a9953] as const,
    },
  },
  rocks: {
    seed: 2081,
    count: { high: 28, medium: 20, low: 13 },
    bounds: [-145, 145, -78, 132] as const,
    minNormalY: 0.82,
    lakeClearance: 0.45,
    startClearance: 9,
    scale: [0.45, 1.45] as const,
    colors: [0x77675a, 0x8b7765, 0x6e7169, 0x9a806b] as const,
  },
  fence: {
    start: { x: 48, z: 76 },
    end: { x: 79, z: -28 },
    posts: 17,
    curve: 5.5,
    postHeight: 1.7,
    postRadius: 0.105,
    railRadius: 0.075,
    color: 0x8a5738,
  },
  flowers: {
    seed: 4093,
    count: { high: 60000, medium: 25000, low: 10000 },
    bounds: [-140, 140, -100, 130] as const,
    minNormalY: 0.86,
    lakeClearance: 0.3,
    startClearance: 2.7,
    scale: [0.72, 1.1] as const,
    stemColor: 0x496c32,
    lightColor: 0xffedcf,
    colors: [0xffd46f, 0xffa79a, 0xf4d3ef, 0xb9c8ff, 0xffeee0] as const,
    chunkSize: 32,
    fadeStart: 85,
    fadeEnd: 105,
  },
} as const;

export const POLLEN = {
  count: { high: 8000, medium: 4000, low: 1000 },
  boxSize: 24, // 24x24x24m box looping around camera
  color: 0xffe6b3,
  size: 0.08,
} as const;

export const FLOATING_CAMERA = {
  /** Camera-space anchor: lower-right, close enough to feel present but never HUD-like. */
  anchor: [0.47, -0.32, -0.93] as const,
  scale: 0.26,
  followLambda: 5.0,
  rotationLambda: 6.0,
  idleDrift: { amount: 0.016, rate: 0.55 },
  movementLift: 0.024,
  lookOffset: 0.028,
  bank: 0.045,
  rotationDeg: { x: -5, y: -12, z: -2 },
  /**
   * Model-space offset from the model origin to the front of the lens, before
   * `scale`. Both the viewfinder camera and the focus ray start here, so it
   * lives in one place: they must agree about where the lens is, or the
   * measured distance stops describing what the image actually shows.
   */
  lensLocal: [0, 0.3125, -0.375] as const,
  /**
   * The bezel aperture measured from camera.gltf: the gap inside frame nodes
   * 5-8, in front of the recessed panel of node 9, is x +/-0.30 and
   * y 0.106 -> 0.519, with the bezel face at z 0.2281. A 3:2 screen centred in
   * it leaves a 0.0065 margin top and bottom. The first draft was 0.42 x 0.265
   * at y 0.24, which under-filled the aperture and sat low.
   */
  screen: {
    width: 0.6,
    height: 0.4,
    position: [0, 0.3125, 0.229] as const,
    colorTop: 0xf3ac78,
    colorBottom: 0x6f7382,
  },
} as const;

/**
 * Photography Mode. The camera stops being scenery and becomes the interface.
 * Every value that changes how the raise *feels* lives here.
 */
export const PHOTOGRAPHY = {
  /**
   * Under-damped on purpose: the overshoot is what reads as weight.
   * `leadScale` drives pitch off the spring's velocity; `rollLeadScale` is how
   * much of that same lead reaches roll. Roll gets less, so the body tips up
   * more than it twists.
   */
  raise: {
    omega: 11,
    zeta: 0.62,
    arcLift: 0.06,
    arcPull: 0.04,
    leadScale: 0.09,
    rollLeadScale: 0.6,
  },
  /** Nearly square to the player, but not sterile. */
  raisedRotationDeg: { x: -1.5, y: 0, z: 0 },
  /** A camera braced against your face is steadier, not looser. */
  raisedFollowLambda: 9.0,
  raisedRotationLambda: 11.0,
  raisedDriftScale: 0.4,
  raisedLookOffsetScale: 0.3,
  raisedBankScale: 0.35,
  /** The framing knob. The raised distance is solved from this, never hardcoded. */
  screenHeightFraction: 0.36,
  /** Photographers step to compose. 0 would freeze movement entirely. */
  moveScale: 0.28,
  lookScale: 0.8,
  /**
   * A 36x24mm frame, so vertical fov is 2*atan(12/f). `startMm` is where the
   * lens sits when the camera first comes up — a mild wide, tighter than the
   * naked view, which reads as "a camera" rather than "a zoom".
   */
  lens: { minMm: 24, maxMm: 120, startMm: 36, sensorHeightMm: 24, wheelStep: 0.055, lambda: 9 },
  reticle: {
    /**
     * Gesture classification is latched, never blended: the same physical
     * gesture must not change meaning according to how fast it happens to be.
     */
    flickPxPerSec: 900,
    settlePxPerSec: 60,
    settleSeconds: 0.12,
    /** Mouse travel across the full screen width. An edge is always close. */
    pxPerScreenWidth: 260,
    /**
     * Magnetism assists the landing only. Scaled to zero above the cutoff so it
     * can never drag the reticle off the path the player intended.
     */
    magnetism: 0.12,
    magnetSpeedCutoff: 220,
    fadeDelay: 1.1,
    fadeLambda: 7,
    /** A fraction of the screen width, as are all uv-space values here. */
    radius: 0.016,
  },
  /** How the shutter cap depresses. Under-damped so the release has a bounce. */
  buttonSpring: { omega: 30, zeta: 0.5 },
  /**
   * The focus ray: a coarse march against the height field, refined by
   * bisection. Runs once per focus event, not per frame, so `stepMetres`
   * trades a little precision for very few `heightAt` calls.
   */
  focus: {
    /** Coarse march step, metres. */
    stepMetres: 1.5,
    /** Past this the ray reads as infinity — a camera pointed at the sky. */
    maxMetres: 260,
    /** Bisection passes after the coarse hit; each halves the residual span. */
    refineIterations: 8,
    /** Frame width as a fraction of the screen. Height follows the screen's own aspect, so the frame reads as square rather than stretched. */
    frameWidthFraction: 0.2,
  },
  /**
   * The photograph itself. `resolution` is 3:2, matching both the 36x24mm frame
   * the focal lengths are computed against and the rear screen it is reviewed
   * on, so a capture is never letterboxed or stretched.
   */
  capture: {
    resolution: {
      high: [1620, 1080],
      medium: [1200, 800],
      low: [900, 600],
    },
    /** ~400kB at 1620x1080. PNG would be ~4MB, and a 248-shot roll a quarter of a gigabyte. */
    jpegQuality: 0.92,
    /**
     * Seconds. The mirror slamming up. The capture render fires the moment this
     * reaches full, so it is the budget for hiding the most expensive frame in
     * the sequence — do not shorten it without re-checking that.
     */
    blackoutInSeconds: 0.05,
    /** How long the frame stays fully black. This is where the render happens. */
    blackoutHoldSeconds: 0.04,
    /** The black lifting, and the edge flash riding on top of it. */
    flashSeconds: 0.06,
    /** How long the photograph is held before the live feed returns. */
    reviewSeconds: 0.95,
    returnSeconds: 0.2,
  },
  /** Browsing the roll. */
  album: {
    /** Cross-fade between photographs. */
    fadeSeconds: 0.18,
  },
  screenUI: {
    primary: 0xf5efe6,
    secondary: 0xc9bfb1,
    accent: 0xf2b45c,
    confirm: 0xa8d8a8,
    /**
     * Above the world's mid-tones so the display glows, below
     * POST.bloom.threshold of 1.85 so it never smears.
     */
    emissive: 1.3,
    gridOpacity: 0.14,
  },
  /**
   * The sun in this world sits at 6.5 degrees, so the light is well past
   * sunny-16 — this is the last of it. EV 9 at ISO 100 is what makes
   * f/2.8, 1/250, ISO 400 read as a correct exposure, which is the triple the
   * approved layout shows.
   */
  sceneEv: 9,
} as const;

/**
 * The live viewfinder degrades itself rather than costing frames. Every
 * decision reads the median of buckets, never a mean, so one stalled frame
 * cannot trigger a downgrade.
 */
export const VIEWFINDER = {
  ladder: [
    { width: 512, height: 341, hz: 30 },
    { width: 384, height: 256, hz: 20 },
    { width: 256, height: 171, hz: 12 },
    /** Frozen: the last frame stays, the interface stays fully live. */
    { width: 256, height: 171, hz: 0 },
  ],
  startRung: { high: 0, medium: 1, low: 2 },
  frozenDim: 0.55,
  watchdog: {
    bucketSeconds: 0.5,
    /**
     * How long to measure the machine's natural rate before the camera comes
     * up, on displays with no frame cap. A single frame is not a baseline: two
     * rAF callbacks landing 4ms apart would read as 250fps and condemn a
     * healthy 60 to the bottom of the ladder within seconds.
     */
    baselineSeconds: 1.0,
    /** The first frames pay for allocation and shader compilation. */
    warmupSeconds: 1.0,
    cooldownSeconds: 3.0,
    degradeBelow: 0.92,
    degradeBuckets: 4,
    recoverAbove: 1.0,
    recoverBuckets: 16,
    /**
     * How many times a rung has to fail before it is written off for the rest
     * of the session. Two, so one bad patch is forgiven and a pattern is not.
     */
    latchFailures: 2,
    /**
     * Lifetime recoveries. A latch spends one of these on top of raising the
     * floor, so this must stay strictly above `latchFailures - 1` or a device
     * that degraded, recovered and degraded again would be left with no
     * benefit of the doubt at all rather than less of it.
     */
    maxRecoveries: 3,
  },
} as const;

export const TOUCH = {
  lookSensitivity: 0.0042,
  holdDelay: 0.12,
  dragDeadzone: 1.5,
  dragPxPerStep: 26,
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
