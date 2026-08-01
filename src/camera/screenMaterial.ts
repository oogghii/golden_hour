import * as THREE from 'three';
import { PHOTOGRAPHY, VIEWFINDER } from '../core/Settings';
import { ACES_GLSL } from '../render/shaders/composite.glsl';

const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * Three layers: the live feed, the chrome texture, and shapes drawn right here
 * because they move every frame. Uploading them through the canvas would cost
 * 2.8MB a frame, which a phone cannot afford.
 *
 * Output lands near PHOTOGRAPHY.screenUI.emissive so the display reads as
 * emissive after the composite's ACES, and stays below POST.bloom.threshold of
 * 1.85 so it never smears into the frame.
 */
const FRAGMENT = /* glsl */ `
precision highp float;
varying vec2 vUv;

uniform sampler2D uFeed;
uniform sampler2D uChrome;
uniform float uGain;
uniform float uFrozen;
uniform vec4  uFocusRect;      // x0, y0, x1, y1 in uv
uniform float uFocusConfirm;   // 0 searching, 1 locked
uniform vec2  uReticle;
uniform float uReticleAlpha;
uniform vec4  uHoverRect;
uniform float uPressed;
uniform float uRoll;           // radians
uniform float uEmissive;
uniform float uGridOpacity;
uniform vec3  uPrimary;
uniform vec3  uConfirm;
uniform float uFrozenDim;
uniform float uReticleRadius;

${ACES_GLSL}

float line(float coord, float at, float halfWidth) {
  return 1.0 - smoothstep(halfWidth * 0.5, halfWidth, abs(coord - at));
}

/** Outline of a rect, w thick, in uv. */
float rectOutline(vec2 uv, vec4 r, float w) {
  vec2 inner = step(r.xy + w, uv) * step(uv, r.zw - w);
  vec2 outer = step(r.xy, uv) * step(uv, r.zw);
  return outer.x * outer.y - inner.x * inner.y;
}

float rectFill(vec2 uv, vec4 r) {
  vec2 inside = step(r.xy, uv) * step(uv, r.zw);
  return inside.x * inside.y;
}

/** Corner ticks only, which is how a focus frame is drawn on a real camera. */
float cornerTicks(vec2 uv, vec4 r, float w, float len) {
  float outline = rectOutline(uv, r, w);
  float nearX = min(uv.x - r.x, r.z - uv.x);
  float nearY = min(uv.y - r.y, r.w - uv.y);
  float corner = step(nearX, len) + step(nearY, len);
  return outline * clamp(corner, 0.0, 1.0);
}

void main() {
  vec3 feed = texture2D(uFeed, vUv).rgb * uGain;
  feed = acesFilmic(feed);
  // LCDs lift their blacks and hold slightly less saturation than the eye.
  feed = mix(vec3(dot(feed, vec3(0.299, 0.587, 0.114))), feed, 0.88);
  feed = feed * 0.94 + 0.045;
  feed *= mix(1.0, uFrozenDim, uFrozen);

  vec3 color = feed;

  // Rule of thirds.
  float grid = 0.0;
  grid += line(vUv.x, 1.0 / 3.0, 0.0016) + line(vUv.x, 2.0 / 3.0, 0.0016);
  grid += line(vUv.y, 1.0 / 3.0, 0.0024) + line(vUv.y, 2.0 / 3.0, 0.0024);
  color = mix(color, uPrimary, clamp(grid, 0.0, 1.0) * uGridOpacity);

  // Hover and press washes.
  float hover = rectFill(vUv, uHoverRect);
  color = mix(color, uPrimary, hover * mix(0.08, 0.18, uPressed));

  // Focus frame.
  vec3 focusColor = mix(uPrimary, uConfirm, uFocusConfirm);
  float focus = cornerTicks(vUv, uFocusRect, 0.004, 0.03);
  color = mix(color, focusColor, focus * 0.95);

  // Level indicator, two short segments that tilt with the body's roll.
  vec2 centred = vUv - 0.5;
  float rotated = centred.y * cos(uRoll) - centred.x * sin(uRoll);
  float span = step(0.16, abs(centred.x)) * step(abs(centred.x), 0.26);
  color = mix(color, uPrimary, span * line(rotated, 0.0, 0.004) * 0.6);

  // Chrome, premultiplied against the feed.
  vec4 chrome = texture2D(uChrome, vUv);
  color = mix(color, chrome.rgb, chrome.a);

  // Reticle: a thin ring that contracts when it has something to land on.
  float radius = uReticleRadius * mix(1.0, 0.72, hover);
  float d = length((vUv - uReticle) * vec2(1.5, 1.0));
  float ring = smoothstep(radius, radius - 0.0035, d) - smoothstep(radius - 0.004, radius - 0.0075, d);
  color = mix(color, uPrimary, ring * uReticleAlpha);

  // Glass: a corner sheen and a soft edge falloff.
  float vignette = 1.0 - 0.34 * pow(length(centred * vec2(1.15, 1.0)) * 1.4, 2.0);
  color *= clamp(vignette, 0.0, 1.0);
  color += uPrimary * 0.05 * smoothstep(0.75, 0.0, vUv.x + (1.0 - vUv.y));

  gl_FragColor = vec4(color * uEmissive, 1.0);
}
`;

export function createScreenMaterial(): THREE.ShaderMaterial {
  const ui = PHOTOGRAPHY.screenUI;
  return new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms: {
      uFeed: { value: null },
      uChrome: { value: null },
      uGain: { value: 1 },
      uFrozen: { value: 0 },
      uFocusRect: { value: new THREE.Vector4(0.4, 0.4, 0.6, 0.6) },
      uFocusConfirm: { value: 0 },
      uReticle: { value: new THREE.Vector2(0.5, 0.5) },
      uReticleAlpha: { value: 0 },
      uHoverRect: { value: new THREE.Vector4(0, 0, 0, 0) },
      uPressed: { value: 0 },
      uRoll: { value: 0 },
      uEmissive: { value: ui.emissive },
      uGridOpacity: { value: ui.gridOpacity },
      uPrimary: { value: new THREE.Color(ui.primary).convertSRGBToLinear() },
      uConfirm: { value: new THREE.Color(ui.confirm).convertSRGBToLinear() },
      uFrozenDim: { value: VIEWFINDER.frozenDim },
      uReticleRadius: { value: PHOTOGRAPHY.reticle.radius },
    },
    side: THREE.FrontSide,
    depthWrite: true,
  });
}
