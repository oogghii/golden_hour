import * as THREE from 'three';
import { PROPS } from '../core/Settings';
import { createRng } from '../util/rng';
import type { HeightField } from '../world/HeightField';
import { beamGeometry, paintGeometry } from './geometry';

/** A slightly wandering, hand-built fence following the right-hand ridge. */
export class FenceFactory {
  static create(height: HeightField): THREE.BufferGeometry[] {
    const config = PROPS.fence;
    const rng = createRng(8837);
    const points: THREE.Vector3[] = [];
    const geometries: THREE.BufferGeometry[] = [];

    for (let i = 0; i < config.posts; i++) {
      const t = i / (config.posts - 1);
      const x = THREE.MathUtils.lerp(config.start.x, config.end.x, t);
      const z =
        THREE.MathUtils.lerp(config.start.z, config.end.z, t) +
        Math.sin(t * Math.PI) * config.curve;
      const y = height.heightAt(x, z);
      const point = new THREE.Vector3(x, y, z);
      points.push(point);

      const leanX = (rng() - 0.5) * 0.16;
      const leanZ = (rng() - 0.5) * 0.16;
      const postHeight = config.postHeight * (0.9 + rng() * 0.18);
      const top = new THREE.Vector3(x + leanX, y + postHeight, z + leanZ);
      geometries.push(
        paintGeometry(
          beamGeometry(
            new THREE.Vector3(x, y - 0.12, z),
            top,
            config.postRadius * 1.12,
            config.postRadius * 0.8,
            5,
          ),
          config.color,
        ),
      );
    }

    for (let i = 0; i < points.length - 1; i++) {
      const here = points[i]!;
      const next = points[i + 1]!;
      for (const fraction of [0.42, 0.74]) {
        const start = new THREE.Vector3(
          here.x,
          here.y + config.postHeight * fraction,
          here.z,
        );
        const end = new THREE.Vector3(
          next.x,
          next.y + config.postHeight * (fraction + (rng() - 0.5) * 0.06),
          next.z,
        );
        geometries.push(
          paintGeometry(
            beamGeometry(start, end, config.railRadius, config.railRadius * 0.92, 4),
            config.color,
          ),
        );
      }
    }

    return geometries;
  }

  static createMaterial(): THREE.MeshStandardMaterial {
    return new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.88,
      metalness: 0,
      flatShading: true,
    });
  }
}
