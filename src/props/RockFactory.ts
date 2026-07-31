import * as THREE from 'three';
import { PROPS } from '../core/Settings';
import type { ScatterPoint } from '../world/Scatter';
import { paintGeometry } from './geometry';

/** Low-poly stones with deliberately uneven, grounded silhouettes. */
export class RockFactory {
  static create(point: ScatterPoint, scale: number): THREE.BufferGeometry {
    const geometry = new THREE.DodecahedronGeometry(scale, 0);
    geometry.scale(1.05 + point.scalePick * 0.65, 0.48 + point.colorPick * 0.36, 0.82);
    geometry.rotateX(point.colorPick * 0.22 - 0.11);
    geometry.rotateY(point.rotation);
    geometry.rotateZ(point.scalePick * 0.18 - 0.09);
    geometry.translate(point.x, point.y + scale * 0.32, point.z);

    const colors = PROPS.rocks.colors;
    const color = colors[Math.min(colors.length - 1, Math.floor(point.colorPick * colors.length))]!;
    return paintGeometry(geometry, color);
  }

  static createMaterial(): THREE.MeshStandardMaterial {
    return new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.96,
      metalness: 0,
      flatShading: true,
    });
  }
}
