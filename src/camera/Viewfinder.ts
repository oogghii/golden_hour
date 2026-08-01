import * as THREE from 'three';
import type { Engine } from '../core/Engine';
import { forcedViewfinderRung } from '../core/Quality';
import { FLOATING_CAMERA, PHOTOGRAPHY, VIEW, VIEWFINDER } from '../core/Settings';
import type { EngineContext, System } from '../core/System';
import type { PhotographyMode } from '../photography/PhotographyMode';
import { CAMERA_LAYER, type FloatingCamera } from './FloatingCamera';
import { ViewfinderWatchdog } from './ViewfinderWatchdog';

/** Local offset from the model origin to the front of the lens. */
const LENS_LOCAL = new THREE.Vector3(...FLOATING_CAMERA.lensLocal);

/**
 * Derived from the screen it will be displayed on, never written down twice.
 * A literal here would silently stretch the image the moment anyone retuned
 * FLOATING_CAMERA.screen — three keeps a camera's aspect and a render target's
 * pixel dimensions entirely independent, so a mismatch distorts rather than
 * letterboxes.
 */
const SCREEN_ASPECT = FLOATING_CAMERA.screen.width / FLOATING_CAMERA.screen.height;

/**
 * A 36x24mm frame. The player's naked 62 degrees is a ~20mm lens, which is why
 * every focal length in the range is a real crop rather than a decorative
 * number. Defined once, used by both the constructor and the per-frame update.
 */
function fovForFocal(focalMm: number): number {
  const half = PHOTOGRAPHY.lens.sensorHeightMm / 2;
  return 2 * Math.atan(half / focalMm) * (180 / Math.PI);
}

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

  private readonly camera = new THREE.PerspectiveCamera(
    fovForFocal(PHOTOGRAPHY.lens.startMm),
    SCREEN_ASPECT,
    VIEW.near,
    VIEW.far,
  );
  private readonly worldPosition = new THREE.Vector3();
  private readonly worldQuaternion = new THREE.Quaternion();
  private target: THREE.WebGLRenderTarget | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private accumulator = 0;
  /** Whether the current target has ever been rendered into. See `update`. */
  private primed = false;

  private watchdog: ViewfinderWatchdog | null = null;
  private pinnedRung: number | null = null;
  private lastPresented = 0;
  private targetRate = 60;
  private wasRaised = false;

  /** Rolling measurement of the machine's natural rate while the camera is down. */
  private baselineWindow = 0;
  private baselineFrames = 0;
  private baselineRate = 60;

  constructor(
    private readonly floating: FloatingCamera,
    private readonly photography: PhotographyMode,
    private readonly screen: {
      setFeed?(texture: THREE.Texture | null): void;
      setFrozen?(frozen: boolean): void;
    },
    private readonly engine: Engine,
  ) {}

  get texture(): THREE.Texture | null {
    return this.target?.texture ?? null;
  }

  /**
   * Places the lens camera for this frame and returns it.
   *
   * Exposed so a capture photographs precisely what the viewfinder is showing.
   * Reconstructing the pose a third time — `CameraInteraction` already does it
   * once for the focus ray — would let the photograph drift from the frame the
   * player actually composed. Placing it here rather than trusting this
   * system's own `update` to have run first makes the call order-independent.
   */
  prepareCameraForCapture(): THREE.PerspectiveCamera | null {
    const model = this.floating.object;
    if (!model) return null;
    this.placeCamera(model);
    return this.camera;
  }

  init(ctx: EngineContext): void {
    this.renderer = ctx.renderer;
    this.scene = ctx.scene;
    // Layer 0 only: the camera model is on CAMERA_LAYER and must not appear
    // inside its own screen.
    this.camera.layers.disable(CAMERA_LAYER);
    this.pinnedRung = forcedViewfinderRung();
    const start = this.pinnedRung ?? VIEWFINDER.startRung[ctx.quality.tier];
    this.setRung(start);
    this.watchdog = new ViewfinderWatchdog(start);
    this.targetRate = Number.isFinite(ctx.quality.frameCap) ? ctx.quality.frameCap : 60;
    document.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  private readonly onVisibilityChange = (): void => {
    // Returning from a hidden tab produces a gap that is not a performance
    // signal.
    this.watchdog?.reset();
  };

  setRung(rung: number): void {
    const clamped = Math.min(Math.max(rung, 0), VIEWFINDER.ladder.length - 1);
    if (this.target && clamped === this.rung) return;
    this.rung = clamped;

    const { width, height } = VIEWFINDER.ladder[clamped]!;
    if (this.target?.width !== width || this.target.height !== height) {
      this.target?.dispose();
      this.target = new THREE.WebGLRenderTarget(width, height, {
        type: THREE.HalfFloatType,
        depthBuffer: true,
        stencilBuffer: false,
        colorSpace: THREE.LinearSRGBColorSpace,
      });
      this.screen.setFeed?.(this.target.texture);
      // A brand new target holds nothing. A frozen rung has no frame to hold
      // until one has actually been drawn into it.
      this.primed = false;
    }
    // Runs after any reallocation above, and unconditionally on every actual
    // rung change: rung 2 -> 3 keeps the same 256x171 target (skipping the
    // block above entirely), and `setFeed` resets the material's colour, so
    // calling this first would let a same-frame reallocation undo the dim.
    this.screen.setFrozen?.(VIEWFINDER.ladder[clamped]!.hz === 0);
  }

  update(dt: number): void {
    const presented = this.engine.presentedFrames;
    const presentedDelta = presented - this.lastPresented;
    this.lastPresented = presented;

    const raised = this.photography.pose.raise > 0.001;
    if (raised !== this.wasRaised) {
      this.wasRaised = raised;
      this.watchdog?.reset();
      // On an uncapped display, what the machine was managing just before the
      // camera came up is the only fair thing to compare against.
      if (raised && !Number.isFinite(this.engine.quality.frameCap)) {
        this.targetRate = Math.max(1, this.baselineRate);
      }
    }
    if (raised && this.pinnedRung === null && this.watchdog) {
      this.setRung(this.watchdog.update(dt, presentedDelta, this.targetRate));
    }

    const model = this.floating.object;
    const renderer = this.renderer;
    const scene = this.scene;
    const target = this.target;
    if (!model || !renderer || !scene || !target) return;

    if (this.photography.pose.raise <= 0.001) {
      this.baselineWindow += dt;
      this.baselineFrames += presentedDelta;
      if (this.baselineWindow >= VIEWFINDER.watchdog.baselineSeconds) {
        this.baselineRate = this.baselineFrames / this.baselineWindow;
        this.baselineWindow = 0;
        this.baselineFrames = 0;
      }
      this.accumulator = 0;
      return;
    }

    const { hz } = VIEWFINDER.ladder[this.rung]!;
    if (hz > 0) {
      this.accumulator += dt;
      const interval = 1 / hz;
      if (this.accumulator < interval) return;
      // Carried rather than zeroed, so the cadence averages exactly to `hz`,
      // and clamped so a stall cannot trigger a catch-up burst.
      this.accumulator = Math.min(this.accumulator - interval, interval);
    } else if (this.primed) {
      // Frozen: the last frame stays on the display. A frozen rung reached
      // from below always HAS a last frame; one pinned from a cold start —
      // `?vf=3`, which never passes through rung 2 — does not, and would show
      // an uninitialised target. So the freeze waits for one priming frame.
      return;
    }

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
    this.primed = true;
  }

  dispose(): void {
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
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

    const fov = fovForFocal(this.photography.state.focalMm);
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }
}
