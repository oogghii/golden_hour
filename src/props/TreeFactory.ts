import * as THREE from 'three';
import { PROPS } from '../core/Settings';
import { NOISE_GLSL } from '../render/shaders/noise.glsl';
import { createRng } from '../util/rng';
import { WIND_GLSL, type WindField } from '../grass/wind';
import { beamGeometry, paintGeometry } from './geometry';

export interface TreeSpec {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly scale: number;
  readonly seed: number;
}

export interface TreeGeometryParts {
  readonly wood: THREE.BufferGeometry[];
  readonly canopy: THREE.BufferGeometry[];
}

/** Builds irregular low-poly trees as geometry parts that PropLayer can merge. */
export class TreeFactory {
  static create(spec: TreeSpec): TreeGeometryParts {
    const rng = createRng(spec.seed);
    const wood: THREE.BufferGeometry[] = [];
    const canopy: THREE.BufferGeometry[] = [];
    const trunk = PROPS.trees.trunk;
    const crown = PROPS.trees.canopy;
    const base = new THREE.Vector3(spec.x, spec.y - 0.05, spec.z);
    const height = trunk.height * spec.scale;
    const top = new THREE.Vector3(
      spec.x + (rng() - 0.5) * 0.7 * spec.scale,
      spec.y + height,
      spec.z + (rng() - 0.5) * 0.7 * spec.scale,
    );

    const trunkGeometry = beamGeometry(
      base,
      top,
      trunk.radius * spec.scale,
      trunk.radius * spec.scale * 0.48,
      7,
    );
    wood.push(paintGeometry(trunkGeometry, trunk.color));

    const branchAnchors: THREE.Vector3[] = [];
    for (let i = 0; i < 5; i++) {
      const angle = (i / 5) * Math.PI * 2 + rng() * 0.8;
      const branchBase = base.clone().lerp(top, 0.48 + rng() * 0.32);
      const reach = (1.8 + rng() * 1.5) * spec.scale;
      const branchTip = new THREE.Vector3(
        branchBase.x + Math.cos(angle) * reach,
        branchBase.y + (1.25 + rng() * 1.35) * spec.scale,
        branchBase.z + Math.sin(angle) * reach,
      );
      branchAnchors.push(branchTip);
      wood.push(
        paintGeometry(
          beamGeometry(
            branchBase,
            branchTip,
            trunk.radius * spec.scale * 0.3,
            trunk.radius * spec.scale * 0.08,
            5,
          ),
          i % 2 === 0 ? trunk.lightColor : trunk.color,
        ),
      );
    }

    const centers = [top, ...branchAnchors];
    centers.forEach((center, index) => {
      const blobCount = index === 0 ? 3 : 1;
      for (let blob = 0; blob < blobCount; blob++) {
        const radius = crown.radius * spec.scale * (0.58 + rng() * 0.32);
        const geometry = new THREE.IcosahedronGeometry(radius, 0);
        geometry.scale(1 + rng() * 0.28, 0.72 + rng() * 0.3, 0.9 + rng() * 0.25);
        geometry.rotateX(rng() * Math.PI);
        geometry.rotateY(rng() * Math.PI);
        geometry.translate(
          center.x + (rng() - 0.5) * radius * 0.9,
          center.y + (0.25 + rng() * 0.55) * radius,
          center.z + (rng() - 0.5) * radius * 0.9,
        );
        const color = crown.colors[(index + blob + Math.floor(rng() * crown.colors.length)) % crown.colors.length]!;
        canopy.push(paintGeometry(geometry, color));
      }
    });

    return { wood, canopy };
  }

  static createWoodMaterial(): THREE.MeshStandardMaterial {
    return new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.92,
      metalness: 0,
      flatShading: true,
    });
  }

  static createCanopyMaterial(wind: WindField): THREE.MeshStandardMaterial {
    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.9,
      metalness: 0,
      flatShading: true,
      // A low grazing sun leaves whole icosahedron faces unlit. A restrained
      // green lift preserves their faceted shape without letting them collapse
      // into black cut-outs against the bright sky.
      emissive: 0x314223,
      emissiveIntensity: 0.42,
    });
    injectCanopyWind(material, wind, PROPS.trees.canopy.sway);
    return material;
  }

  static createCanopyDepthMaterial(wind: WindField): THREE.MeshDepthMaterial {
    const material = new THREE.MeshDepthMaterial({
      depthPacking: THREE.RGBADepthPacking,
    });
    injectCanopyWind(material, wind, PROPS.trees.canopy.sway);
    return material;
  }
}

function injectCanopyWind(
  material: THREE.MeshStandardMaterial | THREE.MeshDepthMaterial,
  wind: WindField,
  strength: number,
): void {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, wind.uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
${NOISE_GLSL}
${WIND_GLSL}
uniform float uCanopySway;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vec2 canopySway = windSway(position.xz, position.y * 0.17);
transformed.xz += canopySway * uCanopySway;`,
      );
    shader.uniforms.uCanopySway = { value: strength };
  };
  material.customProgramCacheKey = () => `golden-hour-canopy-wind-${strength}`;
}
