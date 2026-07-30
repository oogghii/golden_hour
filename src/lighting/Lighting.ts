import * as THREE from 'three';
import type { EngineContext, System } from '../core/System';
import { SUN, sunDirection } from '../core/Settings';

/** How far up the sun ray the light is parked. Only affects shadow framing. */
const LIGHT_DISTANCE = 150;
/** Half-extent of the shadow ortho box, in metres. */
const SHADOW_EXTENT = 32;

/**
 * One warm sun plus a hemisphere fill. The shadow camera follows the view and
 * snaps to its own texel grid, which is what stops long raking shadows from
 * crawling as the player walks.
 */
export class Lighting implements System {
  private readonly sun = new THREE.DirectionalLight();
  private readonly fill = new THREE.HemisphereLight();
  private readonly direction = sunDirection();
  private readonly focus = new THREE.Vector3();
  private camera: THREE.PerspectiveCamera | null = null;
  private texelWorldSize = 0;

  init(ctx: EngineContext): void {
    this.camera = ctx.camera;

    this.sun.color.set(SUN.color);
    this.sun.intensity = SUN.intensity;

    const shadowMapSize = ctx.quality.shadowMapSize;
    if (shadowMapSize > 0) {
      this.sun.castShadow = true;
      this.sun.shadow.mapSize.set(shadowMapSize, shadowMapSize);

      const shadowCamera = this.sun.shadow.camera;
      shadowCamera.left = -SHADOW_EXTENT;
      shadowCamera.right = SHADOW_EXTENT;
      shadowCamera.top = SHADOW_EXTENT;
      shadowCamera.bottom = -SHADOW_EXTENT;
      shadowCamera.near = 1;
      shadowCamera.far = LIGHT_DISTANCE * 2;
      shadowCamera.updateProjectionMatrix();

      // A very low sun grazes surfaces, so depth bias alone leaves acne; the
      // normal offset is what actually clears it.
      this.sun.shadow.bias = -0.0006;
      this.sun.shadow.normalBias = 0.045;

      this.texelWorldSize = (SHADOW_EXTENT * 2) / shadowMapSize;
    }

    this.fill.color.set(SUN.fillSky);
    this.fill.groundColor.set(SUN.fillGround);
    this.fill.intensity = SUN.fillIntensity;

    ctx.scene.add(this.sun, this.sun.target, this.fill);
    this.syncSunPosition();
  }

  update(): void {
    if (!this.camera || !this.sun.castShadow) return;

    // Snapping the focus to whole shadow texels keeps the depth map stable
    // between frames instead of resampling every step.
    const texel = this.texelWorldSize;
    this.focus.set(
      Math.round(this.camera.position.x / texel) * texel,
      Math.round(this.camera.position.y / texel) * texel,
      Math.round(this.camera.position.z / texel) * texel,
    );
    this.syncSunPosition();
  }

  dispose(): void {
    this.sun.removeFromParent();
    this.sun.target.removeFromParent();
    this.fill.removeFromParent();
    this.sun.dispose();
    this.fill.dispose();
  }

  private syncSunPosition(): void {
    this.sun.target.position.copy(this.focus);
    this.sun.position.copy(this.focus).addScaledVector(this.direction, LIGHT_DISTANCE);
  }
}
