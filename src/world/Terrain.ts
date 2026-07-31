import * as THREE from 'three';
import type { EngineContext, System } from '../core/System';
import { GRASS, PROPS, TERRAIN, WORLD } from '../core/Settings';
import { saturate, smoothstep } from '../util/math';
import { fbm, type HeightField } from './HeightField';

/**
 * One displaced plane, vertex-coloured and smooth-shaded. The organic half of
 * the art direction: no flat shading, no texture, just a warm gradient that the
 * grass sits into.
 */
export class Terrain implements System {
  private mesh: THREE.Mesh | null = null;

  constructor(private readonly height: HeightField) {}

  init(ctx: EngineContext): void {
    const geometry = new THREE.PlaneGeometry(
      WORLD.size,
      WORLD.size,
      TERRAIN.segments,
      TERRAIN.segments,
    );
    geometry.rotateX(-Math.PI / 2);

    const position = geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i);
      const z = position.getZ(i);
      position.setY(i, this.height.heightAt(x, z));
    }
    position.needsUpdate = true;
    geometry.computeVertexNormals();

    this.applyVertexColours(geometry);

    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.95,
      metalness: 0,
    });

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.receiveShadow = ctx.quality.shadowMapSize > 0;
    // The player never leaves the terrain, so culling it only costs a test.
    this.mesh.frustumCulled = false;
    ctx.scene.add(this.mesh);
  }

  dispose(): void {
    if (!this.mesh) return;
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh = null;
  }

  /**
   * Height drives the green-to-gold gradient, slope exposes earth, and a broad
   * noise adds the patchiness that stops the ground reading as a single wash.
   */
  private applyVertexColours(geometry: THREE.BufferGeometry): void {
    const position = geometry.attributes.position as THREE.BufferAttribute;
    const normal = geometry.attributes.normal as THREE.BufferAttribute;
    const colours = new Float32Array(position.count * 3);

    const palette = TERRAIN.palette;
    const valley = new THREE.Color(palette.valley);
    const meadow = new THREE.Color(palette.meadow);
    const dryGold = new THREE.Color(palette.dryGold);
    const earth = new THREE.Color(palette.earth);
    const colour = new THREE.Color();

    const grassMid = new THREE.Color(GRASS.palette.mid);
    const grassTip = new THREE.Color(GRASS.palette.tip);
    const flowerWarm = new THREE.Color(PROPS.flowers.colors[0]);
    const flowerPink = new THREE.Color(PROPS.flowers.colors[1]);

    const distantBase = new THREE.Color();
    const floralColor = new THREE.Color();

    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i);
      const y = position.getY(i);
      const z = position.getZ(i);

      // Widened so the walkable area lands in the meadow-to-gold range rather
      // than bottoming out at valley olive, which read as uniform khaki.
      const elevation = saturate((y + 10) / 32);
      const slope = 1 - normal.getY(i);

      // Broad drifts of dry gold, plus a finer break-up so no two square metres
      // are the same value.
      const patch = fbm(x * 0.011, z * 0.011, 2) * 0.5 + 0.5;
      const fine = fbm(x * 0.055, z * 0.055, 2) * 0.5 + 0.5;

      colour.copy(valley).lerp(meadow, smoothstep(0, 0.45, elevation));
      // The gold has to stay gated behind elevation. Adding it unconditionally
      // from the patch noise turns the whole field into sand.
      colour.lerp(dryGold, saturate(smoothstep(0.42, 0.95, elevation) * (0.55 + patch * 0.45)));
      colour.lerp(earth, smoothstep(0.14, 0.42, slope));

      // Distant Meadow Tapestry
      // Fade to a varied grass color at the edges of the world so the distant grass
      // LOD cutoff is invisible. We modulate it by elevation and patch noise so it
      // feels organic rather than like a perfect circle.
      const dist = Math.hypot(x, z);
      const edgeBlend = smoothstep(120, 160, dist + patch * 20 - elevation * 15);
      
      if (edgeBlend > 0) {
        // 1. Large-scale vegetation grouping (broad patches of dark/light grass)
        const vegGroup = fbm(x * 0.015, z * 0.015, 2);
        distantBase.copy(grassMid).lerp(grassTip, smoothstep(-0.4, 0.6, vegGroup));
        
        // 2. Subconscious floral drifts (high frequency, tightly clustered)
        const floralNoise = fbm(x * 0.07 + 133, z * 0.07 - 42, 2);
        // Only appear where noise peaks, keeping it sparse and irregular
        const floralAmount = saturate((floralNoise - 0.25) * 1.5);
        
        // Alternate smoothly between warm yellow fields and cooler pink fields
        const floralHue = fbm(x * 0.012 - 50, z * 0.012 + 70, 1);
        floralColor.copy(flowerWarm).lerp(flowerPink, smoothstep(-0.2, 0.2, floralHue));
        
        // Blend into the base very subtly (max 15% opacity) so it doesn't look painted
        distantBase.lerp(floralColor, floralAmount * 0.15);
        
        colour.lerp(distantBase, edgeBlend);
      }

      // Strong contrast on purpose. A backlit slope lit only by the hemisphere
      // fill has almost no shading variation of its own, so the value break-up
      // has to come from here or the ground reads as one flat wash.
      // We add a tiny bit of extra fine contrast at distance to simulate texture
      // without making it faceted.
      colour.multiplyScalar(0.74 + fine * (0.42 + edgeBlend * 0.1));

      colours[i * 3] = colour.r;
      colours[i * 3 + 1] = colour.g;
      colours[i * 3 + 2] = colour.b;
    }

    geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  }
}
