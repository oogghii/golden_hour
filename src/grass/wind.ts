import * as THREE from 'three';
import { WIND, windDirection } from '../core/Settings';

/**
 * The one wind in the world. Near grass, far grass, flowers and tree canopies
 * all share these uniforms by reference, so the whole field breathes together
 * instead of drifting out of phase.
 */
export class WindField {
  readonly uniforms = {
    uTime: { value: 0 },
    uWindDir: { value: windDirection() },
    uWindStrength: { value: WIND.strength },
    uGustAmount: { value: WIND.gust },
  };

  update(elapsed: number): void {
    this.uniforms.uTime.value = elapsed;
  }
}

/**
 * Horizontal sway in metres for a point on the ground, to be scaled by height
 * along whatever is swaying. Requires NOISE_GLSL to be included first.
 *
 * Two non-harmonic octaves give an unrepeating breeze; the travelling gust wave
 * is what actually reads as a real field, because you can see it coming.
 */
export const WIND_GLSL = /* glsl */ `
uniform float uTime;
uniform vec2 uWindDir;
uniform float uWindStrength;
uniform float uGustAmount;

vec2 windSway(vec2 worldXZ, float phase) {
  float t = uTime;
  vec2 p = worldXZ * 0.05;

  // Different scales AND different speeds, at non-integer ratios, so the two
  // layers never resynchronise into a visible loop.
  float n1 = gnoise(p + vec2(t * 0.11, t * 0.06)) - 0.5;
  float n2 = gnoise(p * 2.7 + vec2(-t * 0.29, t * 0.19)) - 0.5;
  float breeze = n1 + n2 * 0.45;

  // A gust rolling across the field along the wind direction.
  float wave = sin(dot(worldXZ, uWindDir) * 0.08 - t * 1.1 + phase * 0.5);
  float gust = smoothstep(0.1, 1.0, wave);

  vec2 side = vec2(-uWindDir.y, uWindDir.x);
  vec2 sway = uWindDir * (0.45 + gust * uGustAmount) + side * breeze * 0.9;
  return sway * uWindStrength;
}
`;

/** Fog uniforms cloned per material, plus the shared wind uniforms by reference. */
export function grassUniforms(
  wind: WindField,
  extra: Record<string, THREE.IUniform>,
): Record<string, THREE.IUniform> {
  return {
    ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
    ...wind.uniforms,
    ...extra,
  };
}
