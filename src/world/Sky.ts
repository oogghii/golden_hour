import * as THREE from 'three';
import type { EngineContext, System } from '../core/System';
import { FOG, SKY, sunDirection } from '../core/Settings';
import { NOISE_GLSL } from '../render/shaders/noise.glsl';

const VERTEX = /* glsl */ `
varying vec3 vDir;

void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
uniform vec3 uHorizon;
uniform vec3 uMid;
uniform vec3 uZenith;
uniform vec3 uApex;
uniform vec3 uAntiSun;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform vec3 uCloudLit;
uniform vec3 uCloudShadow;
uniform vec3 uFogColor;
uniform float uTime;
uniform float uCloudQuantize;
uniform float uCoverage;
uniform float uDrift;

varying vec3 vDir;

${NOISE_GLSL}

void main() {
  vec3 dir = normalize(vDir);
  float h = dir.y;

  float sd = max(dot(dir, uSunDir), 0.0);

  // Azimuthal variety: the horizon is hot gold toward the sun and cools to rose
  // behind you. A sky that only varies vertically reads as one flat wash.
  vec2 flatDir = normalize(vec2(dir.x, dir.z) + vec2(1e-5));
  float alignment = dot(flatDir, normalize(uSunDir.xz));
  vec3 horizon = mix(uAntiSun, uHorizon, smoothstep(-0.85, 0.85, alignment));

  vec3 col = mix(horizon, uMid, smoothstep(-0.02, 0.30, h));
  col = mix(col, uZenith, smoothstep(0.20, 0.72, h));
  // Cool relief overhead, so looking up is a different colour experience.
  col = mix(col, uApex, smoothstep(0.55, 0.98, h));
  // Broad scatter halo, then a tight disc pushed well over 1.0 so the bloom
  // pass in phase 6 has a real highlight to grab.
  col += uSunColor * pow(sd, 5.0) * 0.75;
  col += uSunColor * smoothstep(0.9985, 0.9997, sd) * 9.0;

  // Project the clouds onto a plane so they foreshorten toward the horizon the
  // way a real cloud deck does.
  // The scale matters more than it looks: too small and the whole visible sky
  // samples one flat spot of the noise field and no clouds appear at all.
  // This spans roughly 9 cloud features toward the horizon down to 1.5 overhead.
  // A smooth floor, not max(h, k). A hard clamp freezes the divisor below the
  // cutoff and smears the cloud pattern into vertical stripes at the horizon.
  vec2 cp = dir.xz / (h + 0.12) * 0.9;
  cp += vec2(uTime * uDrift, uTime * uDrift * 0.4);
  float warp = gfbm(cp * 0.55);
  float d = gfbm(cp + warp * 0.75);

  float edge = 1.0 - uCoverage;
  float soft = smoothstep(edge, edge + 0.26, d);
  float stepped = step(edge + 0.13, d);
  float cloud = mix(soft, stepped, uCloudQuantize);
  // Carried much closer to the horizon than a naive fade allows, because the
  // horizon is exactly where the cloud deck should be most dramatic.
  cloud *= smoothstep(0.004, 0.075, h);

  float lit = pow(clamp(dot(dir, uSunDir) * 0.5 + 0.5, 0.0, 1.0), 2.2);
  vec3 cloudCol = mix(uCloudShadow, uCloudLit, lit);
  // Let the sun burn through the thinner edges.
  cloudCol += uSunColor * pow(sd, 8.0) * 0.5;
  col = mix(col, cloudCol, cloud * 0.88);

  // Sink below the horizon into the fog colour so the terrain edge has nowhere
  // visible to end.
  col = mix(uFogColor, col, smoothstep(-0.10, 0.015, h));

  gl_FragColor = vec4(col, 1.0);
}
`;

/**
 * A gradient dome with a stylized sun and soft procedural cloud bands. Follows
 * the camera so it is effectively at infinity, and always draws first.
 */
export class Sky implements System {
  private mesh: THREE.Mesh | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private readonly uniforms = {
    uHorizon: { value: new THREE.Color(SKY.horizon) },
    uMid: { value: new THREE.Color(SKY.mid) },
    uZenith: { value: new THREE.Color(SKY.zenith) },
    uApex: { value: new THREE.Color(SKY.apex) },
    uAntiSun: { value: new THREE.Color(SKY.antiSun) },
    uSunColor: { value: new THREE.Color(SKY.horizon) },
    uSunDir: { value: sunDirection() },
    uCloudLit: { value: new THREE.Color(SKY.cloudLit) },
    uCloudShadow: { value: new THREE.Color(SKY.cloudShadow) },
    uFogColor: { value: new THREE.Color(FOG.color) },
    uTime: { value: 0 },
    uCloudQuantize: { value: SKY.cloudQuantize },
    uCoverage: { value: SKY.coverage },
    uDrift: { value: SKY.driftSpeed },
  };

  init(ctx: EngineContext): void {
    this.camera = ctx.camera;

    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
      fog: false,
    });

    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(SKY.radius, 48, 24), material);
    this.mesh.renderOrder = -1000;
    this.mesh.frustumCulled = false;
    ctx.scene.add(this.mesh);
  }

  update(_dt: number, elapsed: number): void {
    this.uniforms.uTime.value = elapsed;
    if (this.mesh && this.camera) {
      this.mesh.position.copy(this.camera.position);
    }
  }

  dispose(): void {
    if (!this.mesh) return;
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh = null;
  }
}
