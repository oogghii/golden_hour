import * as THREE from 'three';

/** Vertical divisions. Four gives 9 vertices and 7 triangles per blade. */
const SEGMENTS = 4;
/** Fraction of base width remaining at the tip. */
const TIP_TAPER = 0.15;

export interface SharedGeometry {
  readonly index: THREE.BufferAttribute;
  readonly position: THREE.BufferAttribute;
  readonly uv?: THREE.BufferAttribute;
  /** Largest local Y, used for tile bounding spheres. */
  readonly localHeight: number;
}

/**
 * One curved blade in normalised space: Y runs 0 at the root to 1 at the tip,
 * X is half-width either side, Z carries a forward curl that each instance
 * scales. The material reads `position.y` directly as the along-blade parameter.
 *
 * Attributes are returned to be shared across every tile's geometry — only the
 * per-instance attributes differ.
 */
export function createBladeGeometry(): SharedGeometry {
  const positions: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i < SEGMENTS; i++) {
    const t = i / SEGMENTS;
    const halfWidth = 0.5 * (1 - (1 - TIP_TAPER) * Math.pow(t, 1.5));
    // Quadratic curl, so the blade leans over rather than bending at the base.
    const curl = t * t;
    positions.push(-halfWidth, t, curl, halfWidth, t, curl);
  }
  // Single vertex at the tip closes the blade to a point.
  positions.push(0, 1, 1);

  for (let i = 0; i < SEGMENTS - 1; i++) {
    const a = i * 2;
    indices.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
  }
  const lastLeft = (SEGMENTS - 1) * 2;
  indices.push(lastLeft, lastLeft + 1, SEGMENTS * 2);

  return {
    index: new THREE.BufferAttribute(new Uint16Array(indices), 1),
    position: new THREE.BufferAttribute(new Float32Array(positions), 3),
    localHeight: 1,
  };
}

/**
 * Three quads crossed at 60 degrees. Each carries the full grass-cluster texture,
 * so one instance stands in for roughly 25 blades at a fraction of the cost.
 */
export function createClusterGeometry(): SharedGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const quads = 3;

  for (let q = 0; q < quads; q++) {
    const angle = (q / quads) * Math.PI;
    const dx = Math.cos(angle) * 0.5;
    const dz = Math.sin(angle) * 0.5;
    const base = q * 4;

    positions.push(-dx, 0, -dz, dx, 0, dz, dx, 1, dz, -dx, 1, -dz);
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  return {
    index: new THREE.BufferAttribute(new Uint16Array(indices), 1),
    position: new THREE.BufferAttribute(new Float32Array(positions), 3),
    uv: new THREE.BufferAttribute(new Float32Array(uvs), 2),
    localHeight: 1,
  };
}
