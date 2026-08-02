import * as THREE from 'three';
import { FLOATING_CAMERA, PHOTOGRAPHY } from '../core/Settings';
import type { EngineContext, System } from '../core/System';
import { CAMERA_LAYER, type FloatingCamera } from '../camera/FloatingCamera';
import type { LiveCameraScreen } from '../camera/LiveCameraScreen';
import { clamp, damp, saturate, spring } from '../util/math';
import type { CameraActions } from './CameraActions';
import { GestureClassifier } from './GestureClassifier';
import { zoneAtUv, zoneCentreUv, type Zone } from './InteractionZones';
import type { PhotographyMode } from './PhotographyMode';

export type HoverTarget = Zone | 'shutterButton' | 'body' | null;

/** Model units. The cap spans y 0.575 -> 0.700, so this is a plausible throw. */
const BUTTON_TRAVEL = 0.018;

/**
 * Derived from the screen, never written down twice — matches Viewfinder's own
 * `SCREEN_ASPECT`. Needed here because the focus ray reconstructs the
 * viewfinder's frustum independently: `PhotographyMode` cannot depend on
 * `Viewfinder` (that would cycle back through `PhotographyMode`), so this
 * module, which already holds both `floating` and `photography`, does it
 * itself rather than importing Viewfinder's internals.
 */
const SCREEN_ASPECT = FLOATING_CAMERA.screen.width / FLOATING_CAMERA.screen.height;

/**
 * The same lens offset `Viewfinder` places its camera at, read from the same
 * settings entry. Scaled once here rather than per cast.
 */
const LENS_OFFSET = new THREE.Vector3(...FLOATING_CAMERA.lensLocal)
  .multiplyScalar(FLOATING_CAMERA.scale);

/**
 * Same 36x24mm-frame formula as Viewfinder's `fovForFocal`, computed
 * independently for the reason `SCREEN_ASPECT` above is.
 */
function verticalFovRadians(focalMm: number): number {
  return 2 * Math.atan(PHOTOGRAPHY.lens.sensorHeightMm / 2 / focalMm);
}

/**
 * The reticle, and what it is pointing at.
 *
 * Its domain is the camera's PROJECTED BOUNDS, not the screen alone — that is
 * what lets it travel up onto the shutter button while still being constrained
 * to the camera, never becoming a full-screen game cursor.
 *
 * Hover, press and activation are three separate states. Passing over a control
 * does nothing, ever; activation needs a press and a release that agree on the
 * target, so a slip cancels instead of misfiring.
 */
export class CameraInteraction implements System {
  hovered: HoverTarget = null;

  /** Screen-space NDC, clamped to the camera's projected bounds. */
  private readonly reticle = new THREE.Vector2(0, 0);
  private readonly gesture = new GestureClassifier();
  private readonly raycaster = new THREE.Raycaster();
  private readonly bounds = new THREE.Box2();
  private readonly box = new THREE.Box3();
  private readonly corner = new THREE.Vector3();
  private readonly hoverRect = new THREE.Vector4();
  private readonly screenUv = new THREE.Vector2(0.5, 0.5);
  /** Reused so updateBounds does not allocate a Vector2 per corner, per frame. */
  private readonly cornerNdc = new THREE.Vector2();
  /** Reused so recentre does not allocate a Vector2 every frame while fading out. */
  private readonly recentreTarget = new THREE.Vector2();
  /** Reused so resolveHover does not let `intersectObject` allocate a fresh array every frame. */
  private readonly hits: THREE.Intersection[] = [];
  /** Reused so applyMagnetism does not let zoneCentreUv allocate an object every frame. */
  private readonly centre = { u: 0, v: 0 };
  /** Reused by castFocusRay and updateFocusRect; a focus event, not a per-frame path, but the class-wide convention is to preallocate regardless. */
  private readonly focusOrigin = new THREE.Vector3();
  private readonly focusQuaternion = new THREE.Quaternion();
  private readonly focusDirection = new THREE.Vector3();
  private readonly lensOffset = new THREE.Vector3();
  private readonly focusRect = new THREE.Vector4();

  private camera: THREE.PerspectiveCamera | null = null;
  private pressedTarget: HoverTarget = null;
  private alpha = 0;
  private idleTime = 0;
  private pointerSpeed = 0;
  private buttonRestY: number | null = null;
  private readonly press$ = { velocity: 0 };
  private pressDepth = 0;
  /** Look deltas the reticle clamp rejected, drained by PhotoDesktopInput. */
  readonly lookSpill = { x: 0, y: 0 };

  /** `photography` satisfies CameraActions; the alias documents which role is which. */
  private readonly actions: CameraActions;

  constructor(
    private readonly floating: FloatingCamera,
    private readonly screen: LiveCameraScreen,
    private readonly photography: PhotographyMode,
  ) {
    this.actions = photography;
  }

  init(ctx: EngineContext): void {
    this.camera = ctx.camera;
    this.raycaster.layers.set(CAMERA_LAYER);
  }

  /**
   * Raw mouse delta in pixels. Whatever does not belong to the reticle is left
   * in `lookSpill` for PhotoDesktopInput to drain into the shared input state.
   */
  pointerDelta(dx: number, dy: number, dt: number): void {
    this.lookSpill.x = 0;
    this.lookSpill.y = 0;
    if (!this.photography.pose.isRaised) return;
    // Bounds are empty (min=+Inf, max=-Inf) until the first raised `update()`
    // tick runs updateBounds; clamping against that would produce +/-Infinity.
    if (!Number.isFinite(this.bounds.min.x) || !Number.isFinite(this.bounds.max.x)) return;

    const phase = this.gesture.update(dx, dy, dt);
    if (phase !== 'reticle') {
      this.lookSpill.x = dx;
      this.lookSpill.y = dy;
      return;
    }

    this.idleTime = 0;
    this.pointerSpeed = Math.hypot(dx, dy) / Math.max(dt, 1e-4);

    // Mouse travel is scaled so crossing the camera's full projected width
    // takes pxPerScreenWidth of movement: an edge is always close, which is
    // what lets a misclassified flick reach it and spill into look on its own.
    const span = Math.max(this.bounds.max.x - this.bounds.min.x, 1e-4);
    const perPixel = span / PHOTOGRAPHY.reticle.pxPerScreenWidth;
    const wantedX = this.reticle.x + dx * perPixel;
    const wantedY = this.reticle.y - dy * perPixel;

    const clampedX = clamp(wantedX, this.bounds.min.x, this.bounds.max.x);
    const clampedY = clamp(wantedY, this.bounds.min.y, this.bounds.max.y);

    // Not a blend: the clamp simply has nowhere to put this, so it becomes look.
    this.lookSpill.x = (wantedX - clampedX) / perPixel;
    this.lookSpill.y = -(wantedY - clampedY) / perPixel;

    this.reticle.set(clampedX, clampedY);
  }

  press(): void {
    if (!this.photography.pose.isRaised) return;
    this.pressedTarget = this.hovered;
    if (this.hovered === 'shutterButton') this.actions.shutter('down');
  }

  release(): void {
    const target = this.pressedTarget;
    this.pressedTarget = null;
    if (!this.photography.pose.isRaised) return;
    // Down and up must agree, so a slip during the press cancels.
    if (target === null || target !== this.hovered) return;

    if (target === 'shutterButton') {
      this.actions.shutter('up');
      return;
    }
    if (target === 'body') return;

    if (target.id === 'focusPoint') {
      this.actions.focus({ x: this.screenUv.x, y: this.screenUv.y });
      this.castFocusRay(this.screenUv.x, this.screenUv.y);
      return;
    }
    if (target.settingId === 'mode') {
      this.actions.selectSetting('mode');
      this.actions.changeSetting(1);
      return;
    }
    // The zone that draws how many frames are left is the natural way in to
    // looking at the ones already taken.
    if (target.id === 'status') {
      this.actions.toggleAlbum();
      return;
    }
    if (target.settingId !== null) this.actions.selectSetting(target.settingId);
  }

  wheel(notches: number): void {
    if (!this.photography.pose.isRaised) return;
    const target = this.hovered;
    const selected = this.photography.state.selected;
    const overSelected =
      target !== null && target !== 'body' && target !== 'shutterButton' &&
      target.adjustable && target.settingId !== null && target.settingId === selected;

    if (overSelected) this.actions.changeSetting(notches);
    else this.actions.zoom(notches * PHOTOGRAPHY.lens.wheelStep);
  }

  /** Resolve a touch point through the same camera model used by the mouse. */
  touchPress(ndcX: number, ndcY: number): HoverTarget {
    const target = this.touchPoint(ndcX, ndcY);
    if (this.photography.pose.isRaised) this.press();
    return target;
  }

  /** Update the touch ray without changing press state. */
  touchMove(ndcX: number, ndcY: number): HoverTarget {
    return this.touchPoint(ndcX, ndcY);
  }

  /** Resolve the release point, then apply normal press/release semantics. */
  touchRelease(ndcX: number, ndcY: number): HoverTarget {
    const target = this.touchPoint(ndcX, ndcY);
    if (this.photography.pose.isRaised) this.release();
    return target;
  }

  /** Cancel a touch or mouse press without activating its target. */
  cancelPress(): void {
    this.pressedTarget = null;
    this.lookSpill.x = 0;
    this.lookSpill.y = 0;
  }

  update(dt: number): void {
    const model = this.floating.object;
    if (!this.camera || !model || dt <= 0) return;

    if (!this.photography.pose.isRaised) {
      this.fade(dt, 0);
      this.hovered = null;
      this.screen.setHover(null, false);
      // Lowering ends any interaction: there is no target to release onto, so a
      // press in flight is cancelled rather than left to fire or stick.
      this.pressedTarget = null;
      // The raised path is the only other writer of these uniforms; without
      // this the reticle and a depressed cap would freeze at whatever they
      // showed the instant the camera came down, instead of visibly settling.
      this.screen.setReticle(this.screenUv.x, this.screenUv.y, this.alpha);
      this.updateButton(dt);
      return;
    }

    this.updateBounds(model);
    this.resolveHover();
    this.updateButton(dt);
    this.applyMagnetism(dt);

    this.idleTime += dt;
    // Written only while a gesture is classified 'reticle'; once the mouse
    // truly stops, no further pointerDelta calls arrive to update this, so it
    // must decay here or a fast drag that stops dead would suppress magnetism
    // forever even though the cursor is now at rest.
    this.pointerSpeed = damp(this.pointerSpeed, 0, PHOTOGRAPHY.reticle.fadeLambda, dt);
    const wanted = this.idleTime > PHOTOGRAPHY.reticle.fadeDelay ? 0 : 1;
    if (wanted === 0) this.recentre(dt);
    this.fade(dt, wanted);

    this.screen.setReticle(this.screenUv.x, this.screenUv.y, this.alpha);
    this.screen.setHover(this.hoverTargetRect(), this.pressedTarget !== null);
    this.updateFocusRect();
    this.screen.setFocus(this.focusRect, this.photography.state.focusConfirmed);
  }

  private fade(dt: number, wanted: number): void {
    this.alpha = damp(this.alpha, wanted, PHOTOGRAPHY.reticle.fadeLambda, dt);
  }

  /** Every gesture starts from the same known place. */
  private recentre(dt: number): void {
    this.bounds.getCenter(this.recentreTarget);
    this.reticle.lerp(this.recentreTarget, 1 - Math.exp(-PHOTOGRAPHY.reticle.fadeLambda * dt));
  }

  private updateBounds(model: THREE.Object3D): void {
    if (!this.camera) return;
    this.box.setFromObject(model);
    this.bounds.makeEmpty();
    for (let i = 0; i < 8; i++) {
      this.corner.set(
        i & 1 ? this.box.max.x : this.box.min.x,
        i & 2 ? this.box.max.y : this.box.min.y,
        i & 4 ? this.box.max.z : this.box.min.z,
      );
      this.corner.project(this.camera);
      this.cornerNdc.set(this.corner.x, this.corner.y);
      this.bounds.expandByPoint(this.cornerNdc);
    }
    this.reticle.set(
      clamp(this.reticle.x, this.bounds.min.x, this.bounds.max.x),
      clamp(this.reticle.y, this.bounds.min.y, this.bounds.max.y),
    );
  }

  private resolveHover(): void {
    const model = this.floating.object;
    if (!this.camera || !model) return;

    this.raycaster.setFromCamera(this.reticle, this.camera);
    // `intersectObject`'s third argument is `target = []` by default, so
    // omitting it allocates a fresh array every frame; three does not clear a
    // passed-in array itself, so it must be truncated here first.
    this.hits.length = 0;
    this.raycaster.intersectObject(model, true, this.hits);
    const hit = this.hits[0];
    if (!hit) {
      this.hovered = null;
      return;
    }

    if (hit.object.name === 'ShutterHitVolume' || hit.object.name === 'ShutterButton') {
      this.hovered = 'shutterButton';
      return;
    }
    if (hit.object === this.screen.surface && hit.uv) {
      this.screenUv.copy(hit.uv);
      this.hovered = zoneAtUv(hit.uv.x, hit.uv.y) ?? 'body';
      return;
    }
    this.hovered = 'body';
  }

  private touchPoint(ndcX: number, ndcY: number): HoverTarget {
    if (!this.camera || !this.floating.object) {
      this.hovered = null;
      return null;
    }

    this.reticle.set(clamp(ndcX, -1, 1), clamp(ndcY, -1, 1));
    this.idleTime = 0;
    this.pointerSpeed = 0;
    this.resolveHover();
    return this.hovered;
  }

  /**
   * Assists the landing only. Scaled to zero above the cutoff so it can never
   * drag the reticle off the path the player intended.
   */
  private applyMagnetism(dt: number): void {
    const target = this.hovered;
    if (target === null || target === 'body' || target === 'shutterButton') return;

    const strength =
      PHOTOGRAPHY.reticle.magnetism *
      (1 - saturate(this.pointerSpeed / PHOTOGRAPHY.reticle.magnetSpeedCutoff));
    if (strength <= 0) return;

    const centre = zoneCentreUv(target, this.centre);
    this.screenUv.x += (centre.u - this.screenUv.x) * strength * Math.min(dt * 60, 1);
    this.screenUv.y += (centre.v - this.screenUv.y) * strength * Math.min(dt * 60, 1);
  }

  private hoverTargetRect(): THREE.Vector4 | null {
    const target = this.hovered;
    if (target === null || target === 'body' || target === 'shutterButton') return null;
    if (target.id === 'focusPoint') return null; // The image area never washes.
    return this.hoverRect.set(target.x0, 1 - target.y1, target.x1, 1 - target.y0);
  }

  /**
   * Reconstructs the viewfinder's frustum from the floating model's world
   * pose and the current focal length, so a tap on the image can be marched
   * into a real world-space direction and, from there, a real distance.
   *
   * This lives here rather than in `Viewfinder` or `PhotographyMode` because
   * of a dependency shape: `Viewfinder` already depends on `PhotographyMode`
   * for its pose, so `PhotographyMode` cannot depend back on `Viewfinder`
   * without a cycle. `CameraInteraction` already holds both `floating` and
   * `photography`, so it is the natural place to bridge the two — it starts
   * the ray at the same lens offset `Viewfinder` places its camera at and
   * hands the result to `PhotographyMode.measureFocusDistance`, which owns the
   * height field the ray is marched against.
   */
  private castFocusRay(u: number, v: number): void {
    const model = this.floating.object;
    if (!model) return;

    model.getWorldPosition(this.focusOrigin);
    model.getWorldQuaternion(this.focusQuaternion);
    // The lens, not the model origin. About 13cm — negligible against a 1.5m
    // march step, but it is the difference between measuring the distance to
    // what the image shows and the distance to a point behind it.
    this.focusOrigin.add(this.lensOffset.copy(LENS_OFFSET).applyQuaternion(this.focusQuaternion));

    const halfHeight = Math.tan(verticalFovRadians(this.photography.state.focalMm) / 2);
    const halfWidth = halfHeight * SCREEN_ASPECT;
    this.focusDirection
      .set((u - 0.5) * 2 * halfWidth, (v - 0.5) * 2 * halfHeight, -1)
      .applyQuaternion(this.focusQuaternion)
      .normalize();

    const distance = this.photography.measureFocusDistance(this.focusOrigin, this.focusDirection);
    this.photography.setFocusResult(distance);
  }

  /**
   * The focus frame's rectangle, in the same screen uv space as the hover and
   * reticle uniforms. Roughly `PHOTOGRAPHY.focus.frameWidthFraction` of the
   * screen width; the height follows the screen's own aspect so the frame
   * reads as square rather than stretched, and the centre is clamped so the
   * frame never leaves the surface even when the focus point sits near an edge.
   */
  private updateFocusRect(): void {
    const halfWidth = PHOTOGRAPHY.focus.frameWidthFraction / 2;
    const halfHeight = halfWidth * SCREEN_ASPECT;
    const { x, y } = this.photography.state.focusUv;
    const centreX = clamp(x, halfWidth, 1 - halfWidth);
    const centreY = clamp(y, halfHeight, 1 - halfHeight);
    this.focusRect.set(
      centreX - halfWidth,
      centreY - halfHeight,
      centreX + halfWidth,
      centreY + halfHeight,
    );
  }

  /**
   * The cap physically depresses. Sprung rather than snapped, so the release
   * has the same small bounce a real shutter button has.
   */
  private updateButton(dt: number): void {
    const button = this.floating.shutterButton;
    if (!button) return;
    this.buttonRestY ??= button.position.y;
    const target = this.pressedTarget === 'shutterButton' ? 1 : 0;
    const { omega, zeta } = PHOTOGRAPHY.buttonSpring;
    this.pressDepth = spring(this.pressDepth, target, this.press$, omega, zeta, dt);
    button.position.y = this.buttonRestY - this.pressDepth * BUTTON_TRAVEL;
  }
}
