import * as THREE from 'three';
import { FLOATING_CAMERA, PHOTOGRAPHY, VIEWFINDER } from '../core/Settings';
import type { EngineContext, System } from '../core/System';
import type { PhotographyMode } from '../photography/PhotographyMode';
import { CAMERA_LAYER, type FloatingCamera } from './FloatingCamera';

/** Local offset from the model origin to the front of the lens. */
const LENS_LOCAL = new THREE.Vector3(0, 0.3125, -0.375);

/**
 * A second camera rendered into a small target, active only while the camera is
 * raised — so exploration pays nothing at all for this feature.
 *
 * It sits at the LENS, not at the eye. The body lags and banks, so the image on
 * the screen drifts slightly as the camera settles, which is the detail that
 * sells the whole thing.
 */
export class Viewfinder implements System {
  /** Draw cost of the last viewfinder pass, for DevStats. */
  readonly lastCost = { calls: 0, triangles: 0 };

  rung = 0;

  private readonly camera = new THREE.PerspectiveCamera(40, 1.5, 0.05, 900);
  private readonly worldPosition = new THREE.Vector3();
  private readonly worldQuaternion = new THREE.Quaternion();
  private target: THREE.WebGLRenderTarget | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private accumulator = 0;

  constructor(
    private readonly floating: FloatingCamera,
    private readonly photography: PhotographyMode,
    private readonly screen: { setFeed?(texture: THREE.Texture | null): void },
  ) {}

  get texture(): THREE.Texture | null {
    return this.target?.texture ?? null;
  }

  init(ctx: EngineContext): void {
    this.renderer = ctx.renderer;
    this.scene = ctx.scene;
    // Layer 0 only: the camera model is on CAMERA_LAYER and must not appear
    // inside its own screen.
    this.camera.layers.disable(CAMERA_LAYER);
    this.setRung(VIEWFINDER.startRung[ctx.quality.tier]);
    this.screen.setFeed?.(this.texture);
  }

  setRung(rung: number): void {
    const clamped = Math.min(Math.max(rung, 0), VIEWFINDER.ladder.length - 1);
    if (this.target && clamped === this.rung) return;
    this.rung = clamped;

    const { width, height } = VIEWFINDER.ladder[clamped]!;
    if (this.target?.width === width && this.target.height === height) return;

    this.target?.dispose();
    this.target = new THREE.WebGLRenderTarget(width, height, {
      type: THREE.HalfFloatType,
      depthBuffer: true,
      stencilBuffer: false,
      colorSpace: THREE.LinearSRGBColorSpace,
    });
    this.screen.setFeed?.(this.target.texture);
  }

  update(dt: number): void {
    const model = this.floating.object;
    const renderer = this.renderer;
    const scene = this.scene;
    const target = this.target;
    if (!model || !renderer || !scene || !target) return;

    if (this.photography.pose.raise <= 0.001) {
      this.accumulator = 0;
      return;
    }

    const { hz } = VIEWFINDER.ladder[this.rung]!;
    if (hz <= 0) return; // Frozen: the last frame stays on the display.

    this.accumulator += dt;
    const interval = 1 / hz;
    if (this.accumulator < interval) return;
    // Carried rather than zeroed, so the cadence averages exactly to `hz`,
    // and clamped so a stall cannot trigger a catch-up burst.
    this.accumulator = Math.min(this.accumulator - interval, interval);

    this.placeCamera(model);

    const before = renderer.info.render;
    const calls = before.calls;
    const triangles = before.triangles;

    renderer.setRenderTarget(target);
    // PostFX turns autoClear off, so this pass must clear for itself.
    renderer.clear();
    renderer.render(scene, this.camera);
    renderer.setRenderTarget(null);

    this.lastCost.calls = renderer.info.render.calls - calls;
    this.lastCost.triangles = renderer.info.render.triangles - triangles;
  }

  dispose(): void {
    this.screen.setFeed?.(null);
    this.target?.dispose();
    this.target = null;
  }

  private placeCamera(model: THREE.Object3D): void {
    model.getWorldQuaternion(this.worldQuaternion);
    this.worldPosition
      .copy(LENS_LOCAL)
      .multiplyScalar(FLOATING_CAMERA.scale)
      .applyQuaternion(this.worldQuaternion);
    model.getWorldPosition(this.camera.position);
    this.camera.position.add(this.worldPosition);
    this.camera.quaternion.copy(this.worldQuaternion);

    // A 36x24mm frame, so vertical fov is 2*atan(12/f). The player's naked 62
    // degrees is a ~20mm lens, which is why every focal length here is a real
    // crop rather than a decorative number.
    const half = PHOTOGRAPHY.lens.sensorHeightMm / 2;
    const fov = 2 * Math.atan(half / this.photography.state.focalMm) * (180 / Math.PI);
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }
}
