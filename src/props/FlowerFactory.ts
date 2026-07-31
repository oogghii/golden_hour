import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PROPS, SUN, sunDirection } from '../core/Settings';
import { NOISE_GLSL } from '../render/shaders/noise.glsl';
import { WIND_GLSL, grassUniforms, type WindField } from '../grass/wind';
import { lerp } from '../util/math';
import type { ScatterPoint } from '../world/Scatter';

const VERTEX = /* glsl */ `
attribute float aPart;

uniform vec3 uStem;
uniform float uFadeStart;
uniform float uFadeEnd;

varying vec3 vColor;
varying vec3 vNormal;
varying vec3 vWorldPos;

#include <fog_pars_vertex>
${NOISE_GLSL}
${WIND_GLSL}

void main() {
  vec4 instanced = instanceMatrix * vec4(position, 1.0);
  vec3 world = instanced.xyz;
  vec2 root = instanceMatrix[3].xz;
  
  float dist = length(cameraPosition - instanceMatrix[3].xyz);
  float scaleDrop = 1.0 - smoothstep(uFadeStart, uFadeEnd, dist);
  world = mix(vec3(root.x, instanceMatrix[3].y, root.y), world, scaleDrop);
  
  float t = smoothstep(0.0, 0.82, position.y);
  world.xz += windSway(root, instanceMatrix[3].x * 0.13) * t * t * 0.48 * scaleDrop;

  vColor = mix(uStem, instanceColor, aPart);
  vNormal = normalize(mat3(instanceMatrix) * normal);
  vWorldPos = world;

  vec4 mvPosition = viewMatrix * vec4(world, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const FRAGMENT = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uLight;
uniform vec3 uFill;

varying vec3 vColor;
varying vec3 vNormal;
varying vec3 vWorldPos;

#include <fog_pars_fragment>

void main() {
  vec3 normal = normalize(vNormal) * (gl_FrontFacing ? 1.0 : -1.0);
  float wrap = dot(normal, uSunDir) * 0.5 + 0.5;
  vec3 color = vColor * (uFill + uLight * wrap);
  vec3 viewDir = normalize(cameraPosition - vWorldPos);
  float rim = pow(max(dot(viewDir, -uSunDir), 0.0), 5.0);
  color += vColor * uLight * rim * 0.32;
  gl_FragColor = vec4(color, 1.0);
  #include <fog_fragment>
}
`;

/** One instanced draw for stems and blooms, with per-instance petal colour. */
export class FlowerFactory {
  static create(points: readonly ScatterPoint[], wind: WindField): THREE.Group {
    const geometry = createFlowerGeometry();
    const material = new THREE.ShaderMaterial({
      uniforms: grassUniforms(wind, {
        uStem: { value: new THREE.Color(PROPS.flowers.stemColor) },
        uSunDir: { value: sunDirection() },
        uLight: { value: new THREE.Color(PROPS.flowers.lightColor) },
        uFill: { value: new THREE.Color(SUN.fillSky).multiplyScalar(0.34) },
        uFadeStart: { value: PROPS.flowers.fadeStart },
        uFadeEnd: { value: PROPS.flowers.fadeEnd },
      }),
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      side: THREE.DoubleSide,
      fog: true,
    });

    const chunkSize = PROPS.flowers.chunkSize;
    const chunks = new Map<string, ScatterPoint[]>();
    for (const point of points) {
      const cx = Math.floor(point.x / chunkSize);
      const cz = Math.floor(point.z / chunkSize);
      const key = `${cx}_${cz}`;
      let arr = chunks.get(key);
      if (!arr) {
        arr = [];
        chunks.set(key, arr);
      }
      arr.push(point);
    }

    const group = new THREE.Group();
    const colors = PROPS.flowers.colors;
    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const position = new THREE.Vector3();

    for (const chunkPoints of chunks.values()) {
      const mesh = new THREE.InstancedMesh(geometry, material, chunkPoints.length);
      
      chunkPoints.forEach((point, index) => {
        const size = lerp(PROPS.flowers.scale[0], PROPS.flowers.scale[1], point.scalePick);
        quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), point.rotation);
        scale.setScalar(size);
        position.set(point.x, point.y, point.z);
        matrix.compose(position, quaternion, scale);
        mesh.setMatrixAt(index, matrix);

        const colorIndex = Math.min(colors.length - 1, Math.floor(point.colorPick * colors.length));
        mesh.setColorAt(index, new THREE.Color(colors[colorIndex]!));
      });

      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.frustumCulled = true;
      group.add(mesh);
    }

    return group;
  }
}

function createFlowerGeometry(): THREE.BufferGeometry {
  const stem = new THREE.CylinderGeometry(0.026, 0.04, 0.74, 5, 1, false);
  stem.translate(0, 0.37, 0);
  stem.deleteAttribute('uv');
  addPart(stem, 0);

  const petalPositions: number[] = [];
  const petalNormals: number[] = [];
  const petalIndices: number[] = [];
  for (let i = 0; i < 5; i++) {
    const angle = (i / 5) * Math.PI * 2;
    const radialX = Math.cos(angle);
    const radialZ = Math.sin(angle);
    const sideX = -radialZ;
    const sideZ = radialX;
    const base = i * 4;

    petalPositions.push(
      radialX * 0.04,
      0.75,
      radialZ * 0.04,
      radialX * 0.11 + sideX * 0.075,
      0.78,
      radialZ * 0.11 + sideZ * 0.075,
      radialX * 0.21,
      0.82,
      radialZ * 0.21,
      radialX * 0.11 - sideX * 0.075,
      0.78,
      radialZ * 0.11 - sideZ * 0.075,
    );
    for (let v = 0; v < 4; v++) petalNormals.push(0, 1, 0);
    petalIndices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  const petals = new THREE.BufferGeometry();
  petals.setAttribute('position', new THREE.Float32BufferAttribute(petalPositions, 3));
  petals.setAttribute('normal', new THREE.Float32BufferAttribute(petalNormals, 3));
  petals.setIndex(petalIndices);
  addPart(petals, 1);

  const center = new THREE.OctahedronGeometry(0.105, 0);
  center.scale(1, 0.55, 1);
  center.translate(0, 0.79, 0);
  center.deleteAttribute('uv');
  addPart(center, 1);

  const source = [stem, petals, center];
  const compatible = source.map((geometry) =>
    geometry.index ? geometry.toNonIndexed() : geometry.clone(),
  );
  const merged = mergeGeometries(compatible, false);
  source.forEach((geometry) => geometry.dispose());
  compatible.forEach((geometry) => geometry.dispose());
  if (!merged) throw new Error('Flower geometry attributes could not be merged');
  merged.computeBoundingSphere();
  return merged;
}

function addPart(geometry: THREE.BufferGeometry, value: number): void {
  const count = geometry.attributes.position?.count ?? 0;
  const values = new Float32Array(count);
  values.fill(value);
  geometry.setAttribute('aPart', new THREE.BufferAttribute(values, 1));
}
