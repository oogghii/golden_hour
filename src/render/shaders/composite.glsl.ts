/**
 * Narkowicz ACES approximation. Cheap and the right shape for warm highlights.
 * Exported so the screen material can tonemap the viewfinder feed with the
 * exact same curve instead of a second copy that could drift from this one.
 */
export const ACES_GLSL = /* glsl */ `
vec3 acesFilmic(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
`;

/**
 * Exported for the same reason `ACES_GLSL` is: the capture develop pass encodes
 * photographs with the exact same curve rather than a second copy that could
 * drift from this one. sRGB encoding happens here and nowhere else.
 */
export const SRGB_GLSL = /* glsl */ `
vec3 linearToSrgb(vec3 c) {
  vec3 low = c * 12.92;
  vec3 high = 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
  return mix(low, high, step(vec3(0.0031308), c));
}
`;

/**
 * The final grade. Order matters: bloom and the sun glow are added in HDR, the
 * tonemap brings it to display range, and everything after that is LDR grading.
 * sRGB encoding happens here and nowhere else.
 */
export function compositeFragment(motionBlurTaps: number): string {
  const taps = Math.max(1, Math.round(motionBlurTaps));
  // Guards the divisor when TAPS is 1, which would otherwise divide by zero.
  const span = taps > 1 ? taps - 1 : 1;
  return /* glsl */ `
#define TAPS ${taps}
#define TAP_SPAN ${span}.0

uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform sampler2D uDepth;
uniform mat4 uInvViewProjection;
uniform mat4 uPrevViewProjection;
uniform vec2 uResolution;
uniform vec2 uSunScreen;
uniform float uSunVisible;
uniform float uExposure;
uniform float uSaturation;
uniform float uBloomStrength;
uniform float uBlurStrength;
uniform float uMaxBlurPixels;
uniform float uSunGlow;
uniform float uSunFalloff;
uniform float uAberration;
uniform float uGrain;
uniform float uGrainTime;
uniform float uVignetteStart;
uniform float uVignetteEnd;
uniform vec3 uVignetteTint;
uniform vec3 uHighlightTint;
uniform vec3 uShadowTint;
uniform vec3 uBlackLift;

varying vec2 vUv;

${ACES_GLSL}
${SRGB_GLSL}

/**
 * Screen-space velocity from camera motion alone, reconstructed by unprojecting
 * this pixel's depth and reprojecting it with the previous frame's matrix.
 *
 * Because it only uses camera matrices, moving geometry never smears — the wind
 * stays crisp while the camera does not.
 */
vec2 cameraVelocity(vec2 uv) {
  float depth = texture2D(uDepth, uv).r;
  // Sky pixels sit at the far plane; blurring them costs taps and changes nothing.
  if (depth >= 0.9999) return vec2(0.0);

  vec4 ndc = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec4 world = uInvViewProjection * ndc;
  world /= world.w;

  vec4 previous = uPrevViewProjection * world;
  vec2 previousUv = (previous.xy / previous.w) * 0.5 + 0.5;
  return uv - previousUv;
}

void main() {
  vec2 velocity = cameraVelocity(vUv) * uBlurStrength;

  // Clamped so a fast spin cannot turn the whole frame to mush.
  float maxLength = uMaxBlurPixels / uResolution.x;
  float travelled = length(velocity);
  if (travelled > maxLength) velocity *= maxLength / travelled;

  vec3 scene = vec3(0.0);
  for (int i = 0; i < TAPS; i++) {
    float offset = float(i) / TAP_SPAN - 0.5;
    scene += texture2D(uScene, vUv + velocity * offset).rgb;
  }
  scene /= float(TAPS);

  // Radial chromatic aberration, weighted by r squared so the centre of frame is
  // untouched and the single-tap fetch is never noticeable against the blur.
  vec2 toCentre = vUv - 0.5;
  float aberration = uAberration * dot(toCentre, toCentre) / uResolution.x;
  scene.r = texture2D(uScene, vUv + toCentre * aberration).r;
  scene.b = texture2D(uScene, vUv - toCentre * aberration).b;

  vec3 col = scene * uExposure;
  col += texture2D(uBloom, vUv).rgb * uBloomStrength;

  // Warm lift toward the sun's screen position.
  vec2 toSun = (uSunScreen - vUv) * vec2(uResolution.x / uResolution.y, 1.0);
  col += uHighlightTint * exp(-length(toSun) * uSunFalloff) * uSunGlow * uSunVisible;

  col = acesFilmic(col);

  // ACES desaturates as it compresses, which drains a bright warm sky toward
  // cream. Restoring a little saturation after the curve is what buys back the
  // colour without pushing the pre-tonemap values into clipping.
  float greyLuma = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(greyLuma), col, uSaturation);

  // Split toning. Warm highlights against cool shadows is what reads as rich;
  // adding saturation alone just reads as oversaturated.
  float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col *= mix(uShadowTint, uHighlightTint, smoothstep(0.15, 0.8, luma));
  col += uBlackLift * (1.0 - smoothstep(0.0, 0.35, luma));

  float radius = length(toCentre * vec2(uResolution.x / uResolution.y, 1.0)) * 1.6;
  float vignette = 1.0 - smoothstep(uVignetteStart, uVignetteEnd, radius);
  col *= mix(uVignetteTint, vec3(1.0), vignette);

  float grain =
    fract(sin(dot(vUv * uResolution + uGrainTime, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
  col += grain * uGrain;

  gl_FragColor = vec4(linearToSrgb(max(col, vec3(0.0))), 1.0);
}
`;
}

export const FULLSCREEN_VERTEX = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const BRIGHT_FRAGMENT = /* glsl */ `
uniform sampler2D uSource;
uniform float uThreshold;
uniform float uKnee;

varying vec2 vUv;

void main() {
  vec3 c = texture2D(uSource, vUv).rgb;
  float brightest = max(max(c.r, c.g), c.b);
  // Soft knee, so the bloom eases in rather than switching on at a hard edge.
  float soft = clamp(brightest - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 1e-4);
  float weight = max(soft, brightest - uThreshold) / max(brightest, 1e-4);
  gl_FragColor = vec4(c * weight, 1.0);
}
`;

/** Nine-tap tent, used for both halves of the dual-filter bloom chain. */
export const TENT_FRAGMENT = /* glsl */ `
uniform sampler2D uSource;
uniform vec2 uTexel;
uniform float uRadius;

varying vec2 vUv;

void main() {
  vec2 t = uTexel * uRadius;
  vec3 sum = texture2D(uSource, vUv).rgb * 4.0;
  sum += texture2D(uSource, vUv + vec2(-t.x, 0.0)).rgb * 2.0;
  sum += texture2D(uSource, vUv + vec2(t.x, 0.0)).rgb * 2.0;
  sum += texture2D(uSource, vUv + vec2(0.0, -t.y)).rgb * 2.0;
  sum += texture2D(uSource, vUv + vec2(0.0, t.y)).rgb * 2.0;
  sum += texture2D(uSource, vUv + vec2(-t.x, -t.y)).rgb;
  sum += texture2D(uSource, vUv + vec2(t.x, -t.y)).rgb;
  sum += texture2D(uSource, vUv + vec2(-t.x, t.y)).rgb;
  sum += texture2D(uSource, vUv + vec2(t.x, t.y)).rgb;
  gl_FragColor = vec4(sum / 16.0, 1.0);
}
`;
