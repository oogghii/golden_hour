import * as THREE from 'three';
import type { EngineContext, System } from '../core/System';
import { FOG, LAKE, SKY, sunDirection } from '../core/Settings';
import { NOISE_GLSL } from '../render/shaders/noise.glsl';
import type { HeightField } from './HeightField';

/** Radial samples around the shoreline. */
const SHORE_SEGMENTS = 96;
/** How far the water is pulled back from the true shoreline, in metres. */
const SHORE_INSET = 0.3;

const VERTEX = /* glsl */ `
varying vec3 vWorld;

void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const FRAGMENT = /* glsl */ `
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform vec3 uShallowCool;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uTime;

varying vec3 vWorld;

${NOISE_GLSL}

void main() {
  vec2 p = vWorld.xz;
  // High frequency on purpose. Sun glitter is a field of small specks; low
  // frequencies here read as molten blobs rather than water.
  float w1 = gnoise(p * 2.6 + vec2(uTime * 0.35, uTime * 0.12));
  float w2 = gnoise(p * 5.9 + vec2(-uTime * 0.21, uTime * 0.31));
  float swell = gnoise(p * 0.7 + vec2(uTime * 0.05, -uTime * 0.03));
  float ripple = w1 * 0.5 + w2 * 0.34 + swell * 0.16;

  vec3 toView = cameraPosition - vWorld;
  float distance = length(toView);
  vec3 viewDir = toView / max(distance, 0.001);

  // Grazing angles reflect the sky, steep angles show the dark body of water.
  // This gradient, not the glitter, is what makes it read as water.
  vec2 sunFlat = normalize(uSunDir.xz);
  vec2 away = vWorld.xz - cameraPosition.xz;
  vec2 viewFlat = away / max(length(away), 0.001);
  float alignment = dot(sunFlat, viewFlat);

  // A real lake mirrors whatever part of the sky it faces: warm along the sun's
  // azimuth, cool away from it. Reflecting one flat warm colour is what turned
  // the far water into orange sheet metal.
  vec3 reflected = mix(uShallowCool, uShallow, smoothstep(-0.3, 0.95, alignment));

  // Capped below 1 so the body of the water never fully disappears, however
  // grazing the angle. At distance fresnel saturates and the blue would be gone.
  float fresnel = pow(1.0 - clamp(viewDir.y, 0.0, 1.0), 2.0);
  vec3 col = mix(uDeep, reflected, fresnel * 0.72);

  // The glitter itself stays a narrow corridor. For a flat surface it lives in
  // the vertical plane through the sun, so matching azimuth is the right test.
  float path = pow(clamp(alignment, 0.0, 1.0), 42.0);

  // Only the top of the ripple distribution glints at all, and the specks fade
  // with distance because at range they alias into a shimmering mess.
  float speck = smoothstep(0.68, 0.94, ripple);
  float near = 1.0 - smoothstep(35.0, 150.0, distance);
  col += uSunColor * speck * path * (1.6 + 5.0 * near);
  col += uSunColor * speck * 0.10 * near;

  // Matches scene.fog (FogExp2) exactly, so the far shore dissolves in step
  // with the terrain around it.
  float fogFactor = 1.0 - exp(-uFogDensity * uFogDensity * distance * distance);
  col = mix(col, uFogColor, clamp(fogFactor, 0.0, 1.0));

  gl_FragColor = vec4(col, 1.0);
}
`;

/**
 * The valley lake. No real reflections: a warm gradient plus a sharp scrolling
 * specular gives the glitter path running out to the sun, which is the only part
 * anyone actually looks at.
 *
 * The outline is traced against the height field rather than being a disc, so
 * the shoreline follows the real basin.
 */
export class Water implements System {
  private mesh: THREE.Mesh | null = null;
  private readonly uniforms = {
    uDeep: { value: new THREE.Color(LAKE.deep) },
    uShallow: { value: new THREE.Color(LAKE.shallow) },
    uShallowCool: { value: new THREE.Color(LAKE.shallowCool) },
    uSunColor: { value: new THREE.Color(SKY.horizon) },
    uSunDir: { value: sunDirection() },
    uFogColor: { value: new THREE.Color(FOG.color) },
    uFogDensity: { value: FOG.density },
    uTime: { value: 0 },
  };

  constructor(private readonly height: HeightField) {}

  init(ctx: EngineContext): void {
    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      fog: false,
    });

    this.mesh = new THREE.Mesh(this.buildGeometry(), material);
    this.mesh.position.set(LAKE.x, this.height.waterLevel, LAKE.z);
    ctx.scene.add(this.mesh);
  }

  update(_dt: number, elapsed: number): void {
    this.uniforms.uTime.value = elapsed;
  }

  dispose(): void {
    if (!this.mesh) return;
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh = null;
  }

  /** Marches outward from the lake centre to find where the ground breaches. */
  private buildGeometry(): THREE.BufferGeometry {
    const maxRadius = LAKE.planeSize / 2;
    const marchStep = 0.75;
    const level = this.height.waterLevel;

    const raw: number[] = [];
    for (let s = 0; s < SHORE_SEGMENTS; s++) {
      const angle = (s / SHORE_SEGMENTS) * Math.PI * 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      let radius = maxRadius;
      for (let d = 2; d <= maxRadius; d += marchStep) {
        if (this.height.heightAt(LAKE.x + cos * d, LAKE.z + sin * d) > level) {
          radius = d;
          break;
        }
      }
      raw.push(radius);
    }

    // Smooth the outline, otherwise the march step crenellates the shore.
    const positions: number[] = [0, 0, 0];
    for (let s = 0; s < SHORE_SEGMENTS; s++) {
      const prev = raw[(s - 1 + SHORE_SEGMENTS) % SHORE_SEGMENTS] ?? 0;
      const here = raw[s] ?? 0;
      const next = raw[(s + 1) % SHORE_SEGMENTS] ?? 0;
      const radius = Math.max(1, (prev + 2 * here + next) / 4 - SHORE_INSET);
      const angle = (s / SHORE_SEGMENTS) * Math.PI * 2;
      positions.push(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
    }

    const indices: number[] = [];
    for (let s = 0; s < SHORE_SEGMENTS; s++) {
      const a = 1 + s;
      const b = 1 + ((s + 1) % SHORE_SEGMENTS);
      indices.push(0, b, a);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return geometry;
  }
}
