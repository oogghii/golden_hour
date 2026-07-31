import * as THREE from 'three';
import { createRng, hash3 } from '../util/rng';
import type { HeightField } from './HeightField';

export interface ScatterRule {
  readonly seed: number;
  readonly count: number;
  /** [minX, maxX, minZ, maxZ]. */
  readonly bounds: readonly [number, number, number, number];
  readonly minNormalY: number;
  readonly lakeClearance: number;
  readonly avoid: { readonly x: number; readonly z: number; readonly radius: number };
  readonly attemptsPerItem: number;
  readonly accept?: (x: number, y: number, z: number) => boolean;
}

export interface ScatterPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly rotation: number;
  readonly scalePick: number;
  readonly colorPick: number;
  readonly seed: number;
}

/**
 * Deterministic rejection scatter against the shared height field. Every
 * consumer gets the same dry-ground and slope rules, so props cannot drift off
 * the terrain or appear in the lake.
 */
export function scatter(height: HeightField, rule: ScatterRule): ScatterPoint[] {
  const rng = createRng(hash3(rule.seed, rule.count, 0x51ca77));
  const points: ScatterPoint[] = [];
  const normal = new THREE.Vector3();
  const [minX, maxX, minZ, maxZ] = rule.bounds;
  const avoidRadiusSq = rule.avoid.radius * rule.avoid.radius;
  const maxAttempts = rule.count * rule.attemptsPerItem;

  for (let attempt = 0; attempt < maxAttempts && points.length < rule.count; attempt++) {
    const x = minX + rng() * (maxX - minX);
    const z = minZ + rng() * (maxZ - minZ);
    const dx = x - rule.avoid.x;
    const dz = z - rule.avoid.z;
    if (dx * dx + dz * dz < avoidRadiusSq) continue;

    const y = height.heightAt(x, z);
    if (y < height.waterLevel + rule.lakeClearance) continue;
    if (height.normalAt(x, z, normal).y < rule.minNormalY) continue;
    if (rule.accept && !rule.accept(x, y, z)) continue;

    points.push({
      x,
      y,
      z,
      rotation: rng() * Math.PI * 2,
      scalePick: rng(),
      colorPick: rng(),
      seed: Math.floor(rng() * 0x7fffffff),
    });
  }

  return points;
}
