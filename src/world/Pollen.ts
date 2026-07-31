import * as THREE from 'three';
import { POLLEN } from '../core/Settings';
import type { EngineContext, System } from '../core/System';
import type { Player } from '../player/Player';
import type { WindField } from '../grass/wind';

const VERTEX = /* glsl */ `
attribute vec2 aRandom;

uniform vec3 uCameraPos;
uniform float uBoxSize;
uniform float uTime;
uniform vec2 uWindDir;
uniform float uWindStrength;

varying float vAlpha;

void main() {
  // Drift slowly based on wind and random velocity
  vec3 drift = vec3(
    uWindDir.x * uWindStrength * 2.0 + (aRandom.x - 0.5) * 0.4,
    sin(uTime * 0.5 + aRandom.y * 6.28) * 0.15 + (aRandom.y - 0.5) * 0.2,
    uWindDir.y * uWindStrength * 2.0 + (aRandom.x - 0.5) * 0.4
  ) * uTime;

  // Combine initial position with drift
  vec3 worldPosition = position + drift;

  // Wrap around the camera perfectly seamlessly
  vec3 offset = worldPosition - uCameraPos;
  float halfBox = uBoxSize * 0.5;
  
  offset.x = mod(offset.x + halfBox, uBoxSize) - halfBox;
  offset.y = mod(offset.y + halfBox, uBoxSize) - halfBox;
  offset.z = mod(offset.z + halfBox, uBoxSize) - halfBox;
  
  vec3 wrappedPos = uCameraPos + offset;

  // Fade out near the edges of the box so they don't pop in/out
  float dist = length(offset);
  vAlpha = 1.0 - smoothstep(halfBox * 0.6, halfBox * 0.9, dist);

  vec4 mvPosition = viewMatrix * vec4(wrappedPos, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  
  // Size attenuation
  gl_PointSize = (200.0 * ${POLLEN.size.toFixed(3)}) / -mvPosition.z;
}
`;

const FRAGMENT = /* glsl */ `
uniform vec3 uColor;

varying float vAlpha;

void main() {
  // Circular particle
  vec2 uv = gl_PointCoord - 0.5;
  float distSq = dot(uv, uv);
  if (distSq > 0.25) discard;

  // Soft edge
  float edgeAlpha = 1.0 - smoothstep(0.15, 0.25, distSq);

  gl_FragColor = vec4(uColor, vAlpha * edgeAlpha * 0.6);
}
`;

export class Pollen implements System {
  private readonly points: THREE.Points;
  private readonly material: THREE.ShaderMaterial;

  constructor(
    private readonly player: Player,
    wind: WindField,
  ) {
    const geometry = new THREE.BufferGeometry();
    const count = POLLEN.count.high; 
    
    const positions = new Float32Array(count * 3);
    const randoms = new Float32Array(count * 2);

    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * POLLEN.boxSize;
      positions[i * 3 + 1] = (Math.random() - 0.5) * POLLEN.boxSize;
      positions[i * 3 + 2] = (Math.random() - 0.5) * POLLEN.boxSize;
      
      randoms[i * 2] = Math.random();
      randoms[i * 2 + 1] = Math.random();
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aRandom', new THREE.BufferAttribute(randoms, 2));

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uCameraPos: { value: new THREE.Vector3() },
        uBoxSize: { value: POLLEN.boxSize },
        uTime: { value: 0 },
        uWindDir: wind.uniforms.uWindDir,
        uWindStrength: wind.uniforms.uWindStrength,
        uColor: { value: new THREE.Color(POLLEN.color) },
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(geometry, this.material);
    this.points.frustumCulled = false; 
  }

  init(ctx: EngineContext): void {
    const count = POLLEN.count[ctx.quality.tier];
    this.points.geometry.setDrawRange(0, count);
    ctx.scene.add(this.points);
  }

  update(_dt: number, elapsed: number): void {
    this.material.uniforms.uCameraPos.value.copy(this.player.position);
    this.material.uniforms.uCameraPos.value.y += 1.62; // Eye height
    
    this.material.uniforms.uTime.value = elapsed;
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.material.dispose();
    this.points.removeFromParent();
  }
}
