import * as THREE from 'three';
import type { EngineContext, System } from '../core/System';
import { BACKDROP } from '../core/Settings';
import { fbm } from './HeightField';

type RidgeLayer = (typeof BACKDROP.layers)[number];

/** Samples around each ring. */
const SEGMENTS = 128;
/** Far below the visible horizon, so no gap can open under a ridge. */
const SKIRT_Y = -150;

/**
 * Rings of low-poly ridge silhouette receding toward the horizon. Not walkable
 * and not lit: the colours are pre-hazed per layer, which is cheaper and more
 * controllable than letting the fog eat them.
 */
export class Backdrop implements System {
  private group: THREE.Group | null = null;

  init(ctx: EngineContext): void {
    this.group = new THREE.Group();
    this.group.renderOrder = -900;

    BACKDROP.layers.forEach((layer, index) => {
      this.group?.add(this.buildRidge(layer, index));
    });

    ctx.scene.add(this.group);
  }

  dispose(): void {
    if (!this.group) return;
    for (const child of this.group.children) {
      const mesh = child as THREE.Mesh;
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    this.group.removeFromParent();
    this.group = null;
  }

  private buildRidge(layer: RidgeLayer, index: number): THREE.Mesh {
    const positions: number[] = [];
    const colours: number[] = [];
    const indices: number[] = [];

    const base = new THREE.Color(layer.color);
    const crest = base.clone().lerp(new THREE.Color(0xffffff), 0.12);
    const foot = base.clone().multiplyScalar(0.82);

    for (let s = 0; s <= SEGMENTS; s++) {
      const angle = (s / SEGMENTS) * Math.PI * 2;
      const x = Math.cos(angle) * layer.distance;
      const z = Math.sin(angle) * layer.distance;

      // Each layer walks a different slice of the noise, so the ridges never
      // echo each other.
      const profile = fbm((s / SEGMENTS) * 9 + index * 13.7, index * 4.3, 3);
      const y = layer.height + profile * layer.jitter;

      positions.push(x, y, z, x, SKIRT_Y, z);
      colours.push(crest.r, crest.g, crest.b, foot.r, foot.g, foot.b);
    }

    for (let s = 0; s < SEGMENTS; s++) {
      const top = s * 2;
      const bottom = top + 1;
      const nextTop = top + 2;
      const nextBottom = top + 3;
      indices.push(top, bottom, nextTop, nextTop, bottom, nextBottom);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
    geometry.setIndex(indices);

    const material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      fog: false,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    return mesh;
  }
}
