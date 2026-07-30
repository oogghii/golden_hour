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
uniform vec3 uTipDry;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uFillColor;
uniform vec3 uThroughColor;
uniform float uTranslucency;

varying vec3 vWorldPos;
varying float vRand;

vec3 grassShade(float t, vec3 normal) {
  // Some clumps run green, some run dry and straw-coloured.
  vec3 tip = mix(uTip, uTipDry, vRand);
  vec3 base = mix(uRoot, uMid, smoothstep(0.0, 0.55, t));
  base = mix(base, tip, smoothstep(0.5, 1.0, t));
  base *= 0.85 + vRand * 0.3;

  // Wrap lighting: no blade ever goes black, which is what keeps the mass
  // reading as soft rather than as thousands of hard-lit slivers.
  float wrap = dot(normal, uSunDir) * 0.5 + 0.5;
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

varying float vT;
varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vRand;

#include <fog_pars_vertex>
${NOISE_GLSL}
${WIND_GLSL}

void main() {
  float t = position.y;
  vT = t;

  vec3 local = vec3(position.x * aScale.x, position.y * aScale.y, position.z * aCurl * aScale.y);

  float s = sin(aRotation);
  float c = cos(aRotation);
  vec3 world = vec3(local.x * c - local.z * s, local.y, local.x * s + local.z * c) + aOffset;

  // Height tapers to zero across the band, so the coarser band underneath is
  // revealed rather than swapped in. Nothing ever appears or disappears.
  float fade = 1.0 - smoothstep(uFadeStart, uFadeEnd, length(aOffset.xz - uPlayerXZ));
  world.y = aOffset.y + (world.y - aOffset.y) * fade;

  // Cubic along height, so only the tips whip.
  world.xz += windSway(aOffset.xz, aRandom.x * 6.2831) * t * t * t * aScale.y * fade;

  // Blended toward straight up so the field lights as a mass. A physically
  // correct blade normal flickers badly once there are tens of thousands.
  vNormal = normalize(mix(vec3(s, 0.0, c), vec3(0.0, 1.0, 0.0), 0.55));
  vWorldPos = world;
  vRand = aRandom.y;

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

varying vec2 vUv;
varying vec3 vWorldPos;
varying float vRand;

#include <fog_pars_vertex>
${NOISE_GLSL}
${WIND_GLSL}

void main() {
  vUv = uv;

  vec3 local = vec3(position.x * aScale.x, position.y * aScale.y, position.z * aScale.x);

  float s = sin(aRotation);
  float c = cos(aRotation);
  vec3 world = vec3(local.x * c - local.z * s, local.y, local.x * s + local.z * c) + aOffset;

  float fade = 1.0 - smoothstep(uFadeStart, uFadeEnd, length(aOffset.xz - uPlayerXZ));
  world.y = aOffset.y + (world.y - aOffset.y) * fade;

  // The whole cluster leans as one, which is correct: it stands in for a clump.
  world.xz += windSway(aOffset.xz, aRandom.x * 6.2831) * uv.y * uv.y * aScale.y * fade;

  vWorldPos = world;
  vRand = aRandom.y;

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
    uTipDry: { value: new THREE.Color(GRASS.palette.tipDry) },
    uSunDir: { value: sunDirection() },
    uSunColor: { value: new THREE.Color(GRASS.lightColor) },
    uFillColor: { value: new THREE.Color(SUN.fillSky).multiplyScalar(0.38) },
    uThroughColor: { value: new THREE.Color(GRASS.translucencyColor) },
    uTranslucency: { value: GRASS.translucency },
    uPlayerXZ: { value: new THREE.Vector2() },
    uFadeStart: { value: 0 },
    uFadeEnd: { value: 1 },
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
