import * as THREE from 'three';
import { GRASS, type GrassBand } from '../core/Settings';
import type { EngineContext, System } from '../core/System';
import { lerp } from '../util/math';
import { createRng, hash3 } from '../util/rng';
import type { HeightField } from '../world/HeightField';
import type { Player } from '../player/Player';
import { createBladeGeometry, createClusterGeometry, type SharedGeometry } from './BladeGeometry';
import { createBladeMaterial, createClusterMaterial } from './GrassMaterials';
import { createGrassTexture } from './grassTexture';
import type { WindField } from './wind';

/** Tiles regenerated per frame, across all bands. Keeps walking hitch-free. */
const REBUILD_BUDGET = 2;

interface Tile {
  readonly mesh: THREE.Mesh;
  readonly geometry: THREE.InstancedBufferGeometry;
  readonly offset: THREE.InstancedBufferAttribute;
  readonly rotation: THREE.InstancedBufferAttribute;
  readonly scale: THREE.InstancedBufferAttribute;
  readonly random: THREE.InstancedBufferAttribute;
  readonly curl: THREE.InstancedBufferAttribute | null;
  tileX: number;
  tileZ: number;
  dirty: boolean;
}

interface Band {
  readonly config: GrassBand;
  readonly material: THREE.ShaderMaterial;
  readonly tiles: Tile[];
  readonly capacity: number;
  readonly seed: number;
  /** Tile centre may sit this far outside the fade and still show geometry. */
  readonly cullRadius: number;
}

/**
 * Player-following rings of instanced grass. Each band is a toroidal grid of
 * tiles; layout is a pure function of tile coordinates, so walking away and
 * back regenerates an identical field rather than reshuffling it.
 */
export class GrassField implements System {
  private readonly bands: Band[] = [];
  private readonly group = new THREE.Group();
  private texture: THREE.Texture | null = null;
  private bladeGeometry: SharedGeometry | null = null;
  private clusterGeometry: SharedGeometry | null = null;

  constructor(
    private readonly height: HeightField,
    private readonly player: Player,
    private readonly wind: WindField,
  ) {}

  init(ctx: EngineContext): void {
    const configs = GRASS.bands[ctx.quality.tier];
    if (import.meta.env.DEV) assertBandsCoverTheirRings(configs);

    this.bladeGeometry = createBladeGeometry();
    this.clusterGeometry = createClusterGeometry();
    this.texture = createGrassTexture(ctx.renderer.capabilities.getMaxAnisotropy());

    // Without MSAA there is no alpha-to-coverage to soften cluster edges, so a
    // slightly higher cut hides the hard stair-stepping.
    const alphaTest = ctx.quality.msaaSamples > 0 ? 0.32 : 0.42;

    configs.forEach((config, index) => {
      this.bands.push(this.createBand(config, index, alphaTest));
    });

    this.group.frustumCulled = false;
    ctx.scene.add(this.group);
  }

  update(): void {
    const px = this.player.position.x;
    const pz = this.player.position.z;
    let budget = REBUILD_BUDGET;

    for (const band of this.bands) {
      band.material.uniforms.uPlayerXZ?.value.set(px, pz);

      const size = band.config.tileSize;
      const half = (band.config.ringTiles - 1) / 2;
      const centreX = Math.round(px / size);
      const centreZ = Math.round(pz / size);

      for (const tile of band.tiles) {
        // Toroidal wrap: a tile that has fallen off one edge of the ring is
        // teleported to the opposite edge and marked for regeneration.
        const wrappedX = wrap(tile.tileX, centreX, half, band.config.ringTiles);
        const wrappedZ = wrap(tile.tileZ, centreZ, half, band.config.ringTiles);
        if (wrappedX !== tile.tileX || wrappedZ !== tile.tileZ) {
          tile.tileX = wrappedX;
          tile.tileZ = wrappedZ;
          tile.dirty = true;
        }

        const worldX = tile.tileX * size;
        const worldZ = tile.tileZ * size;
        const distance = Math.hypot(worldX - px, worldZ - pz);
        // Tiles wholly beyond the fade contribute nothing, so skip the draw.
        tile.mesh.visible = distance <= band.cullRadius;

        if (tile.dirty && budget > 0 && tile.mesh.visible) {
          this.fillTile(band, tile);
          tile.dirty = false;
          budget--;
        }
      }
    }
  }

  dispose(): void {
    for (const band of this.bands) {
      for (const tile of band.tiles) tile.geometry.dispose();
      band.material.dispose();
    }
    this.bands.length = 0;
    this.texture?.dispose();
    this.group.removeFromParent();
  }

  private createBand(config: GrassBand, index: number, alphaTest: number): Band {
    const isBlades = config.kind === 'blades';
    const shared = isBlades ? this.bladeGeometry : this.clusterGeometry;
    if (!shared || !this.texture) throw new Error('GrassField.init ran out of order');

    const material = isBlades
      ? createBladeMaterial(this.wind)
      : createClusterMaterial(this.wind, this.texture, alphaTest);
    material.uniforms.uFadeStart!.value = config.fadeStart;
    material.uniforms.uFadeEnd!.value = config.fadeEnd;

    const capacity = Math.ceil(config.tileSize * config.tileSize * config.density);
    const diagonal = config.tileSize * Math.SQRT1_2;
    const band: Band = {
      config,
      material,
      tiles: [],
      capacity,
      seed: index * 7919 + 13,
      cullRadius: config.fadeEnd + diagonal + config.height[1],
    };

    const half = (config.ringTiles - 1) / 2;
    for (let gz = -half; gz <= half; gz++) {
      for (let gx = -half; gx <= half; gx++) {
        const tile = this.createTile(band, shared, isBlades, gx, gz);
        band.tiles.push(tile);
        this.group.add(tile.mesh);
      }
    }

    return band;
  }

  private createTile(
    band: Band,
    shared: SharedGeometry,
    isBlades: boolean,
    tileX: number,
    tileZ: number,
  ): Tile {
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.index = shared.index;
    geometry.setAttribute('position', shared.position);
    if (shared.uv) geometry.setAttribute('uv', shared.uv);

    const instanced = (size: number): THREE.InstancedBufferAttribute => {
      const attribute = new THREE.InstancedBufferAttribute(
        new Float32Array(band.capacity * size),
        size,
      );
      attribute.setUsage(THREE.DynamicDrawUsage);
      return attribute;
    };

    const offset = instanced(3);
    const rotation = instanced(1);
    const scale = instanced(2);
    const random = instanced(2);
    const curl = isBlades ? instanced(1) : null;

    geometry.setAttribute('aOffset', offset);
    geometry.setAttribute('aRotation', rotation);
    geometry.setAttribute('aScale', scale);
    geometry.setAttribute('aRandom', random);
    if (curl) geometry.setAttribute('aCurl', curl);

    // Instances live in world space inside the attributes, so three cannot
    // derive a bounding sphere; fillTile sets it explicitly.
    geometry.boundingSphere = new THREE.Sphere();
    geometry.instanceCount = 0;

    const mesh = new THREE.Mesh(geometry, band.material);
    mesh.frustumCulled = true;
    mesh.visible = false;

    return {
      mesh,
      geometry,
      offset,
      rotation,
      scale,
      random,
      curl,
      tileX,
      tileZ,
      dirty: true,
    };
  }

  /**
   * Lays out one tile from a seed derived purely from its coordinates. Grass is
   * skipped in the lake, which also trims the instance count for free.
   */
  private fillTile(band: Band, tile: Tile): void {
    const { config } = band;
    const size = config.tileSize;
    const originX = tile.tileX * size - size * 0.5;
    const originZ = tile.tileZ * size - size * 0.5;
    const rng = createRng(hash3(tile.tileX, tile.tileZ, band.seed));

    const offsets = tile.offset.array as Float32Array;
    const rotations = tile.rotation.array as Float32Array;
    const scales = tile.scale.array as Float32Array;
    const randoms = tile.random.array as Float32Array;
    const curls = tile.curl ? (tile.curl.array as Float32Array) : null;

    const minY = this.height.waterLevel + GRASS.shoreClearance;
    let count = 0;
    let lowest = Number.POSITIVE_INFINITY;
    let highest = Number.NEGATIVE_INFINITY;

    for (let i = 0; i < band.capacity; i++) {
      const x = originX + rng() * size;
      const z = originZ + rng() * size;
      const rotation = rng() * Math.PI * 2;
      const heightPick = rng();
      const widthPick = rng();
      const randA = rng();
      const randB = rng();
      const curlPick = rng();

      const y = this.height.heightAt(x, z);
      if (y < minY) continue;

      offsets[count * 3] = x;
      offsets[count * 3 + 1] = y;
      offsets[count * 3 + 2] = z;
      rotations[count] = rotation;
      scales[count * 2] = lerp(config.width[0], config.width[1], widthPick);
      scales[count * 2 + 1] = lerp(config.height[0], config.height[1], heightPick);
      randoms[count * 2] = randA;
      randoms[count * 2 + 1] = randB;
      // More arch than looks right on paper: straight blades read as wheat.
      if (curls) curls[count] = lerp(0.15, 0.62, curlPick);

      if (y < lowest) lowest = y;
      if (y > highest) highest = y;
      count++;
    }

    tile.geometry.instanceCount = count;
    tile.offset.needsUpdate = true;
    tile.rotation.needsUpdate = true;
    tile.scale.needsUpdate = true;
    tile.random.needsUpdate = true;
    if (tile.curl) tile.curl.needsUpdate = true;

    const sphere = tile.geometry.boundingSphere;
    if (sphere) {
      if (count === 0) {
        sphere.radius = -1;
      } else {
        sphere.center.set(tile.tileX * size, (lowest + highest) * 0.5, tile.tileZ * size);
        sphere.radius =
          size * Math.SQRT1_2 + (highest - lowest) * 0.5 + config.height[1] + config.width[1];
      }
    }
  }
}

/** Moves `value` into [centre - half, centre + half] in whole ring steps. */
function wrap(value: number, centre: number, half: number, period: number): number {
  let result = value;
  while (result < centre - half) result += period;
  while (result > centre + half) result -= period;
  return result;
}

/**
 * A band whose taper finishes outside the ground its ring covers leaves a bald
 * ring at the edge of the world. Cheap to get wrong, so it is checked.
 */
function assertBandsCoverTheirRings(bands: readonly GrassBand[]): void {
  bands.forEach((band, index) => {
    const inscribed = (band.tileSize * (band.ringTiles - 1)) / 2;
    if (band.fadeEnd > inscribed) {
      throw new Error(
        `GRASS band ${index} (${band.kind}) fades out at ${band.fadeEnd} m but its ` +
          `ring only covers ${inscribed} m. Raise ringTiles or tileSize, or lower fadeEnd.`,
      );
    }
    if (band.fadeStart >= band.fadeEnd) {
      throw new Error(`GRASS band ${index} has fadeStart >= fadeEnd`);
    }
  });
}
