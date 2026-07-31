import * as THREE from 'three';
import { GRASS, SUN, sunDirection } from '../core/Settings';
import { NOISE_GLSL } from '../render/shaders/noise.glsl';
import { grassUniforms, WIND_GLSL, type WindField } from './wind';

/**
 * Both grass bands share their lighting model and their palette, which is what
 * makes real blades and painted clusters read as one material across the LOD
 * boundary.
 *
 * Deliberately not a PBR material. Soft wrap lighting plus backlit translucency
 * plus root darkening looks far better at golden hour than anything physical,
 * and it costs a handful of instructions.
 */
const SHARED_FRAGMENT_HEAD = /* glsl */ `
uniform vec3 uRoot;
uniform vec3 uMid;
uniform vec3 uTip;
uniform vec3 uTipSun;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uFillColor;
uniform vec3 uThroughColor;
uniform float uTranslucency;
uniform float uValueVariation;
uniform float uSunHighlight;

varying vec3 vWorldPos;
varying float vValueNoise;
varying float vRichness;
varying float vOvergrowth;

vec3 grassShade(float t, vec3 normal) {
  // The warmest tips are limited to broad regions facing the sun.
  float wrap = dot(normal, uSunDir) * 0.5 + 0.5;
  float warmth = smoothstep(0.56, 1.0, wrap) * uSunHighlight;
  
  vec3 tip = uTip;
  // Ecology: Richness makes it greener, overgrowth makes it drier/golden
  tip = mix(tip, uMid, vRichness * 0.35);
  tip = mix(tip, uTipSun, vOvergrowth * 0.45);
  tip = mix(tip, uTipSun, warmth);
  
  vec3 mid = uMid;
  // Ecology: Richness deepens the mid-layer
  mid = mix(mid, mix(uRoot, uMid, 0.5), vRichness * 0.4);

  vec3 base = mix(uRoot, mid, smoothstep(0.0, 0.55, t));
  base = mix(base, tip, smoothstep(0.5, 1.0, t));
  
  // Gentle value drift over tens of metres prevents a flat swatch without
  // breaking the field into visibly random yellow and green instances.
  base *= mix(1.0 - uValueVariation, 1.0 + uValueVariation, vValueNoise);

  // Wrap lighting: no blade ever goes black, which is what keeps the mass
  // reading as soft rather than as thousands of hard-lit slivers.
  vec3 lit = base * (uFillColor + uSunColor * wrap);

  // Looking into the sun through the field lights the blades from behind. A
  // tighter cone than it looks like it wants: any wider and the glow stops being
  // an accent and becomes the whole image.
  vec3 viewDir = normalize(cameraPosition - vWorldPos);
  float through = pow(max(dot(viewDir, -uSunDir), 0.0), 4.5);
  lit += uThroughColor * base * through * uTranslucency * t;

  // Fakes self-shadowing far more cheaply than real shadows would. Not too deep,
  // or a backlit field goes muddy at the bottom of frame.
  return lit * mix(0.62, 1.0, t);
}
`;

const BLADE_VERTEX = /* glsl */ `
attribute vec3 aOffset;
attribute float aRotation;
attribute vec2 aScale;
attribute vec2 aRandom;
attribute float aCurl;

uniform vec2 uPlayerXZ;
uniform float uFadeStart;
uniform float uFadeEnd;
uniform float uNearFadeStart;
uniform float uNearFadeEnd;
uniform float uRichnessScale;
uniform float uRichnessHeight;
uniform float uOvergrowthScale;
uniform float uOvergrowthHeight;

varying float vT;
varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vValueNoise;
varying float vRichness;
varying float vOvergrowth;

#include <fog_pars_vertex>
${NOISE_GLSL}
${WIND_GLSL}

void main() {
  float t = position.y;
  vT = t;

  vec2 richPoint = aOffset.xz * uRichnessScale;
  float richness = gnoise(richPoint + vec2(13.4, -7.2)) * 0.5 + 0.5;
  vRichness = smoothstep(0.3, 0.7, richness);

  vec2 overPoint = aOffset.xz * uOvergrowthScale;
  float overgrowth = gnoise(overPoint + vec2(-8.6, 15.3)) * 0.5 + 0.5;
  vOvergrowth = smoothstep(0.3, 0.7, overgrowth);

  vValueNoise = gnoise(aOffset.xz * 0.05 + vec2(4.1, 9.8)) * 0.5 + 0.5;

  // Restore the original base scale (~0.85) so the field isn't globally too tall
  float naturalHeight = aScale.y * 0.85;
  naturalHeight *= 1.0 + (vRichness * 2.0 - 1.0) * uRichnessHeight;
  naturalHeight *= 1.0 + (vOvergrowth * 2.0 - 1.0) * uOvergrowthHeight;
  vec3 local = vec3(position.x * aScale.x, position.y * naturalHeight, position.z * aCurl * naturalHeight);

  float s = sin(aRotation);
  float c = cos(aRotation);
  vec3 world = vec3(local.x * c - local.z * s, local.y, local.x * s + local.z * c) + aOffset;

  // Height tapers to zero across the band, so the coarser band underneath is
  // revealed rather than swapped in. Nothing ever appears or disappears.
  float fade = 1.0 - smoothstep(uFadeStart, uFadeEnd, length(aOffset.xz - uPlayerXZ));
  world.y = aOffset.y + (world.y - aOffset.y) * fade;

  // Cubic along height, so only the tips whip.
  world.xz += windSway(aOffset.xz, aRandom.x * 6.2831) * t * t * t * naturalHeight * fade;

  // Extremely subtle player parting
  float pushDist = length(aOffset.xz - uPlayerXZ);
  float pushAmount = smoothstep(0.6, 0.0, pushDist);
  vec2 pushDir = normalize(aOffset.xz - uPlayerXZ + vec2(0.001));
  world.xz += pushDir * pushAmount * 0.1 * t * fade;

  // Blended toward straight up so the field lights as a mass. A physically
  // correct blade normal flickers badly once there are tens of thousands.
  vNormal = normalize(mix(vec3(s, 0.0, c), vec3(0.0, 1.0, 0.0), 0.55));
  vWorldPos = world;

  vec4 mvPosition = viewMatrix * vec4(world, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const BLADE_FRAGMENT = /* glsl */ `
varying float vT;
varying vec3 vNormal;

#include <fog_pars_fragment>
${SHARED_FRAGMENT_HEAD}

void main() {
  vec3 normal = normalize(vNormal) * (gl_FrontFacing ? 1.0 : -1.0);
  gl_FragColor = vec4(grassShade(vT, normal), 1.0);
  #include <fog_fragment>
}
`;

const CLUSTER_VERTEX = /* glsl */ `
attribute vec3 aOffset;
attribute float aRotation;
attribute vec2 aScale;
attribute vec2 aRandom;

uniform vec2 uPlayerXZ;
uniform float uFadeStart;
uniform float uFadeEnd;
uniform float uNearFadeStart;
uniform float uNearFadeEnd;
uniform float uRichnessScale;
uniform float uRichnessHeight;
uniform float uOvergrowthScale;
uniform float uOvergrowthHeight;

varying vec2 vUv;
varying vec3 vWorldPos;
varying float vValueNoise;
varying float vRichness;
varying float vOvergrowth;

#include <fog_pars_vertex>
${NOISE_GLSL}
${WIND_GLSL}

void main() {
  vUv = uv;

  vec2 richPoint = aOffset.xz * uRichnessScale;
  float richness = gnoise(richPoint + vec2(13.4, -7.2)) * 0.5 + 0.5;
  vRichness = smoothstep(0.3, 0.7, richness);

  vec2 overPoint = aOffset.xz * uOvergrowthScale;
  float overgrowth = gnoise(overPoint + vec2(-8.6, 15.3)) * 0.5 + 0.5;
  vOvergrowth = smoothstep(0.3, 0.7, overgrowth);

  vValueNoise = gnoise(aOffset.xz * 0.05 + vec2(4.1, 9.8)) * 0.5 + 0.5;

  // Restore the original base scale (~0.85) so the field isn't globally too tall
  float naturalHeight = aScale.y * 0.85;
  naturalHeight *= 1.0 + (vRichness * 2.0 - 1.0) * uRichnessHeight;
  naturalHeight *= 1.0 + (vOvergrowth * 2.0 - 1.0) * uOvergrowthHeight;
  vec3 local = vec3(position.x * aScale.x, position.y * naturalHeight, position.z * aScale.x);

  float s = sin(aRotation);
  float c = cos(aRotation);
  vec3 world = vec3(local.x * c - local.z * s, local.y, local.x * s + local.z * c) + aOffset;

  float distanceToPlayer = length(aOffset.xz - uPlayerXZ);
  float fade =
    (1.0 - smoothstep(uFadeStart, uFadeEnd, distanceToPlayer)) *
    smoothstep(uNearFadeStart, uNearFadeEnd, distanceToPlayer);
  world.y = aOffset.y + (world.y - aOffset.y) * fade;

  // The whole cluster leans as one, which is correct: it stands in for a clump.
  world.xz += windSway(aOffset.xz, aRandom.x * 6.2831) * uv.y * uv.y * naturalHeight * fade;

  // Extremely subtle player parting
  float pushDist = length(aOffset.xz - uPlayerXZ);
  float pushAmount = smoothstep(0.6, 0.0, pushDist);
  vec2 pushDir = normalize(aOffset.xz - uPlayerXZ + vec2(0.001));
  world.xz += pushDir * pushAmount * 0.1 * uv.y * fade;

  vWorldPos = world;

  vec4 mvPosition = viewMatrix * vec4(world, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const CLUSTER_FRAGMENT = /* glsl */ `
uniform sampler2D uMap;
uniform float uAlphaTest;

varying vec2 vUv;

#include <fog_pars_fragment>
${SHARED_FRAGMENT_HEAD}

void main() {
  vec4 tex = texture2D(uMap, vUv);
  // Alpha test rather than blending, so depth stays correct and nothing needs
  // sorting.
  if (tex.a < uAlphaTest) discard;

  // The texture's red channel is the along-blade parameter, so the clusters get
  // exactly the same root-to-tip gradient as the real blades.
  gl_FragColor = vec4(grassShade(tex.r, vec3(0.0, 1.0, 0.0)), 1.0);
  #include <fog_fragment>
}
`;

function paletteUniforms(): Record<string, THREE.IUniform> {
  return {
    uRoot: { value: new THREE.Color(GRASS.palette.root) },
    uMid: { value: new THREE.Color(GRASS.palette.mid) },
    uTip: { value: new THREE.Color(GRASS.palette.tip) },
    uTipSun: { value: new THREE.Color(GRASS.palette.tipSun) },
    uSunDir: { value: sunDirection() },
    uSunColor: { value: new THREE.Color(GRASS.lightColor) },
    uFillColor: { value: new THREE.Color(SUN.fillSky).multiplyScalar(0.38) },
    uThroughColor: { value: new THREE.Color(GRASS.translucencyColor) },
    uTranslucency: { value: GRASS.translucency },
    uRichnessScale: { value: GRASS.ecology.richness.scale },
    uRichnessHeight: { value: GRASS.ecology.richness.heightInfluence },
    uOvergrowthScale: { value: GRASS.ecology.overgrowth.scale },
    uOvergrowthHeight: { value: GRASS.ecology.overgrowth.heightInfluence },
    uValueVariation: { value: GRASS.ecology.valueVariation },
    uSunHighlight: { value: GRASS.ecology.sunHighlight },
    uPlayerXZ: { value: new THREE.Vector2() },
    uFadeStart: { value: 0 },
    uFadeEnd: { value: 1 },
    uNearFadeStart: { value: 0 },
    uNearFadeEnd: { value: 0.01 },
  };
}

export function createBladeMaterial(wind: WindField): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: grassUniforms(wind, paletteUniforms()),
    vertexShader: BLADE_VERTEX,
    fragmentShader: BLADE_FRAGMENT,
    side: THREE.DoubleSide,
    fog: true,
  });
}

export function createClusterMaterial(
  wind: WindField,
  map: THREE.Texture,
  alphaTest: number,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: grassUniforms(wind, {
      ...paletteUniforms(),
      uMap: { value: map },
      uAlphaTest: { value: alphaTest },
    }),
    vertexShader: CLUSTER_VERTEX,
    fragmentShader: CLUSTER_FRAGMENT,
    side: THREE.DoubleSide,
    fog: true,
  });
}
