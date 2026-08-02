import * as THREE from 'three';
import { ACES_GLSL, SRGB_GLSL } from '../../render/shaders/composite.glsl';

const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * Turns the linear HDR capture into a photograph.
 *
 * Gain first, because the exposure model is the whole point of the camera:
 * shoot at f/22 and the picture is dark. Then the same ACES curve the rest of
 * the project grades with, then sRGB. Both curves are imported, never copied.
 *
 * Deliberately absent: the LCD black lift and desaturation, the rule-of-thirds
 * grid, the reticle, the focus frame and the glass vignette. Those are
 * `screenMaterial` simulating a display. A photograph is the image, not a
 * picture of the screen that happened to be showing it.
 */
const FRAGMENT = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uSource;
uniform float uGain;

${ACES_GLSL}
${SRGB_GLSL}

void main() {
  vec3 linear = texture2D(uSource, vUv).rgb * uGain;
  gl_FragColor = vec4(linearToSrgb(acesFilmic(linear)), 1.0);
}
`;

export function createDevelopMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms: { uSource: { value: null }, uGain: { value: 1 } },
    depthTest: false,
    depthWrite: false,
  });
}
