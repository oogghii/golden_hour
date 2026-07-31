import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PLAYER, PROPS, GRASS } from '../core/Settings';
import type { EngineContext, System } from '../core/System';
import type { WindField } from '../grass/wind';
import { lerp, smoothstep } from '../util/math';
import { fbm, type HeightField } from '../world/HeightField';
import { scatter } from '../world/Scatter';
import { FenceFactory } from './FenceFactory';
import { FlowerFactory } from './FlowerFactory';
import { RockFactory } from './RockFactory';
import { TreeFactory } from './TreeFactory';

/**
 * Phase 5 composition. Every prop family is merged or instanced, keeping the
 * whole layer to five added draw calls: wood, canopies, rocks, fence, flowers.
 */
export class PropLayer implements System {
  private readonly group = new THREE.Group();

  constructor(
    private readonly height: HeightField,
    private readonly wind: WindField,
  ) {}

  init(ctx: EngineContext): void {
    this.addTrees(ctx);
    this.addRocks(ctx);
    this.addFence(ctx);
    this.addFlowers(ctx);
    ctx.scene.add(this.group);
  }

  dispose(): void {
    const materials = new Set<THREE.Material>();
    this.group.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      child.geometry.dispose();
      const meshMaterials = Array.isArray(child.material) ? child.material : [child.material];
      meshMaterials.forEach((material) => materials.add(material));
      if (child.customDepthMaterial) materials.add(child.customDepthMaterial);
      if (child.customDistanceMaterial) materials.add(child.customDistanceMaterial);
    });
    materials.forEach((material) => material.dispose());
    this.group.clear();
    this.group.removeFromParent();
  }

  private addTrees(ctx: EngineContext): void {
    const config = PROPS.trees;
    const wood: THREE.BufferGeometry[] = [];
    const canopy: THREE.BufferGeometry[] = [];
    const heroY = this.height.heightAt(config.hero.x, config.hero.z);
    const hero = TreeFactory.create({
      x: config.hero.x,
      y: heroY,
      z: config.hero.z,
      scale: config.hero.scale,
      seed: config.hero.seed,
    });
    wood.push(...hero.wood);
    canopy.push(...hero.canopy);

    const points = scatter(this.height, {
      seed: config.scattered.seed,
      count: config.scattered.count[ctx.quality.tier],
      bounds: config.scattered.bounds,
      minNormalY: config.scattered.minNormalY,
      lakeClearance: config.scattered.lakeClearance,
      avoid: {
        x: PLAYER.start.x,
        z: PLAYER.start.z,
        radius: config.scattered.startClearance,
      },
      attemptsPerItem: PROPS.scatter.attemptsPerItem,
      accept: (x, _y, z) => Math.hypot(x - config.hero.x, z - config.hero.z) > 19,
    });

    points.forEach((point) => {
      const tree = TreeFactory.create({
        x: point.x,
        y: point.y,
        z: point.z,
        scale: lerp(config.scattered.scale[0], config.scattered.scale[1], point.scalePick),
        seed: point.seed,
      });
      wood.push(...tree.wood);
      canopy.push(...tree.canopy);
    });

    const woodMesh = new THREE.Mesh(mergeAndDispose(wood, 'tree wood'), TreeFactory.createWoodMaterial());
    woodMesh.castShadow = ctx.quality.shadowMapSize > 0;
    woodMesh.receiveShadow = true;
    this.group.add(woodMesh);

    const canopyMesh = new THREE.Mesh(
      mergeAndDispose(canopy, 'tree canopies'),
      TreeFactory.createCanopyMaterial(this.wind),
    );
    canopyMesh.castShadow = ctx.quality.shadowMapSize > 0;
    canopyMesh.receiveShadow = true;
    canopyMesh.customDepthMaterial = TreeFactory.createCanopyDepthMaterial(this.wind);
    this.group.add(canopyMesh);
  }

  private addRocks(ctx: EngineContext): void {
    const config = PROPS.rocks;
    const points = scatter(this.height, {
      seed: config.seed,
      count: config.count[ctx.quality.tier],
      bounds: config.bounds,
      minNormalY: config.minNormalY,
      lakeClearance: config.lakeClearance,
      avoid: { x: PLAYER.start.x, z: PLAYER.start.z, radius: config.startClearance },
      attemptsPerItem: PROPS.scatter.attemptsPerItem,
    });
    const geometries = points.map((point) =>
      RockFactory.create(point, lerp(config.scale[0], config.scale[1], point.scalePick)),
    );
    const mesh = new THREE.Mesh(mergeAndDispose(geometries, 'rocks'), RockFactory.createMaterial());
    // Their contact is already communicated by dark lower faces. Spending a
    // second draw in the shadow map on small scattered stones is not visible.
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  private addFence(ctx: EngineContext): void {
    const mesh = new THREE.Mesh(
      mergeAndDispose(FenceFactory.create(this.height), 'fence'),
      FenceFactory.createMaterial(),
    );
    mesh.castShadow = ctx.quality.shadowMapSize > 0;
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  private addFlowers(ctx: EngineContext): void {
    const config = PROPS.flowers;
    const ecology = GRASS.ecology;
    const points = scatter(this.height, {
      seed: config.seed,
      count: config.count[ctx.quality.tier],
      bounds: config.bounds,
      minNormalY: config.minNormalY,
      lakeClearance: config.lakeClearance,
      avoid: { x: PLAYER.start.x, z: PLAYER.start.z, radius: config.startClearance },
      attemptsPerItem: PROPS.scatter.attemptsPerItem,
      accept: (x, _y, z) => {
        // Evaluate the same noise fields as the grass shader
        const rawRich = fbm(x * ecology.richness.scale + 13.4, z * ecology.richness.scale - 7.2, 2) * 0.5 + 0.5;
        const rawOver = fbm(x * ecology.overgrowth.scale - 8.6, z * ecology.overgrowth.scale + 15.3, 2) * 0.5 + 0.5;
        
        const richNoise = smoothstep(0.3, 0.7, rawRich);
        const overNoise = smoothstep(0.3, 0.7, rawOver);
        const floralNoise = smoothstep(0.2, 0.8, fbm(x * ecology.floral.scale + 100, z * ecology.floral.scale - 100, 2) * 0.5 + 0.5);
        
        // Flowers need richness, avoid deep overgrowth, and need local floral clustering
        const probability = richNoise * (1.0 - overNoise * 0.8) * floralNoise;
        
        // Map the density tunable to a probability threshold
        const threshold = 1.0 - ecology.floral.density;
        return probability > threshold;
      }
    });
    this.group.add(FlowerFactory.create(points, this.wind));
  }
}

function mergeAndDispose(
  geometries: THREE.BufferGeometry[],
  label: string,
): THREE.BufferGeometry {
  const merged = mergeGeometries(geometries, false);
  geometries.forEach((geometry) => geometry.dispose());
  if (!merged) throw new Error(`Could not merge ${label} geometry`);
  return merged;
}
