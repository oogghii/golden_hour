import * as THREE from 'three';
import { LAKE, TERRAIN } from '../core/Settings';
import { smoothstep } from '../util/math';

/**
 * The single source of truth for ground height. Terrain geometry, grass
 * placement, prop scatter and the player all sample this, so they can never
 * disagree about where the ground is.
 *
 * Kept on the CPU and deliberately cheap: grass placement calls it hundreds of
 * thousands of times.
 */

function hashLattice(ix: number, iy: number): number {
  let n = Math.imul(ix, 374761393) + Math.imul(iy, 668265263);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 2147483647 - 1;
}

function valueNoise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  // Hermite weights, so the surface has no visible lattice creases.
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);

  const a = hashLattice(ix, iy);
  const b = hashLattice(ix + 1, iy);
  const c = hashLattice(ix, iy + 1);
  const d = hashLattice(ix + 1, iy + 1);

  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

export function fbm(x: number, y: number, octaves: number): number {
  let sum = 0;
  let amplitude = 1;
  let norm = 0;
  let fx = x;
  let fy = y;

  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(fx, fy) * amplitude;
    norm += amplitude;
    amplitude *= 0.5;
    // 1.93 rather than 2 keeps octaves off a shared lattice; the offsets stop
    // features from stacking up at the origin.
    fx = fx * 1.93 + 31.7;
    fy = fy * 1.93 - 17.3;
  }

  return sum / norm;
}

function gaussian(distanceSq: number, sigma: number): number {
  return Math.exp(-distanceSq / (2 * sigma * sigma));
}

export class HeightField {
  /** Surface height of the lake. */
  readonly waterLevel = LAKE.level;

  heightAt(x: number, z: number): number {
    const lakeDx = x - LAKE.x;
    const lakeDz = z - LAKE.z;
    const lakeMask = gaussian(lakeDx * lakeDx + lakeDz * lakeDz, LAKE.radius);

    // Broad landform, flattened toward the basin so a hill can never swallow
    // the lake and lose the composition.
    let h = fbm(x * TERRAIN.hills.scale, z * TERRAIN.hills.scale, 4) * TERRAIN.hills.amplitude;
    h *= 1 - 0.85 * lakeMask;

    h += fbm(x * TERRAIN.mid.scale, z * TERRAIN.mid.scale, 3) * TERRAIN.mid.amplitude;
    h += fbm(x * TERRAIN.micro.scale, z * TERRAIN.micro.scale, 2) * TERRAIN.micro.amplitude;

    h -= LAKE.depth * lakeMask;

    const hero = TERRAIN.heroRise;
    const heroDx = x - hero.x;
    const heroDz = z - hero.z;
    h += hero.amplitude * gaussian(heroDx * heroDx + heroDz * heroDz, hero.sigma);

    const distance = Math.hypot(x, z);
    h += smoothstep(TERRAIN.rim.start, TERRAIN.rim.end, distance) * TERRAIN.rim.amplitude;

    // Guarantee the basin closes into a shoreline. Without this the broad hill
    // noise can stay below the waterline past the basin, and the water mesh's
    // outward march clamps to its maximum radius, cutting a straight chord
    // across the lake.
    // The boundary itself wobbles, otherwise the clamp overrides the hill noise
    // in the shore ring and the lake comes out a suspiciously neat oval.
    const lakeDistance = Math.hypot(lakeDx, lakeDz);
    const wobble = fbm(x * 0.02, z * 0.02, 2) * 9;
    const shore = smoothstep(
      LAKE.radius + wobble,
      LAKE.radius * 1.35 + wobble,
      lakeDistance,
    );
    if (shore > 0) {
      h = Math.max(h, LAKE.level + 0.5 * shore);
    }

    return h;
  }

  /** Surface normal by central difference. */
  normalAt(x: number, z: number, target = new THREE.Vector3()): THREE.Vector3 {
    const e = 0.6;
    const dx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const dz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    return target.set(-dx, 2 * e, -dz).normalize();
  }

  /** True where the ground sits below the waterline. */
  isSubmerged(x: number, z: number): boolean {
    return this.heightAt(x, z) < this.waterLevel;
  }
}
