/**
 * Shared GLSL value noise. Sky, water and the wind all sample this so their
 * motion belongs to the same world instead of three unrelated patterns.
 *
 * Written for GLSL ES 1.0, which is what three compiles ShaderMaterial to by
 * default, so every loop bound is a literal constant.
 */
export const NOISE_GLSL = /* glsl */ `
float gnHash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float gnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(gnHash(i), gnHash(i + vec2(1.0, 0.0)), u.x),
    mix(gnHash(i + vec2(0.0, 1.0)), gnHash(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

/** Four octaves, normalised to roughly 0..1. */
float gfbm(vec2 p) {
  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  vec2 q = p;
  for (int i = 0; i < 4; i++) {
    sum += gnoise(q) * amp;
    norm += amp;
    amp *= 0.5;
    // Non-integer lacunarity keeps the octaves off a shared lattice.
    q = q * 1.97 + vec2(23.1, -11.7);
  }
  return sum / norm;
}
`;
