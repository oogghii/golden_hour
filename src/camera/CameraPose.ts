import * as THREE from 'three';
import { FLOATING_CAMERA, PHOTOGRAPHY } from '../core/Settings';
import { DEG, lerp, spring, type SpringState } from '../util/math';

/**
 * What the floating camera should be aiming at this frame. `FloatingCamera`
 * keeps its own damping filter untouched and simply asks for this — which is
 * why raising the camera inherits the existing sense of weight for free.
 */
export interface PoseBlend {
  /** Camera-space. */
  anchor: THREE.Vector3;
  /** Radians. */
  pitch: number;
  yaw: number;
  roll: number;
  followLambda: number;
  rotationLambda: number;
  driftScale: number;
  lookOffsetScale: number;
  bankScale: number;
}

export function createPoseBlend(): PoseBlend {
  return {
    anchor: new THREE.Vector3(),
    pitch: 0,
    yaw: 0,
    roll: 0,
    followLambda: FLOATING_CAMERA.followLambda,
    rotationLambda: FLOATING_CAMERA.rotationLambda,
    driftScale: 1,
    lookOffsetScale: 1,
    bankScale: 1,
  };
}

/** Local offset from the model origin to the centre of the rear screen. */
const SCREEN_CENTRE_LOCAL = new THREE.Vector3(
  FLOATING_CAMERA.screen.position[0],
  FLOATING_CAMERA.screen.position[1],
  FLOATING_CAMERA.screen.position[2],
);

const REST_ANCHOR = new THREE.Vector3(...FLOATING_CAMERA.anchor);

export class CameraPose {
  /** 0 resting, 1 raised. Overshoots past 1 on the way up. */
  raise = 0;

  private target = 0;
  private readonly springState: SpringState = { velocity: 0 };
  private readonly raisedAnchor = new THREE.Vector3();
  private readonly scratch = new THREE.Vector3();
  private readonly rotation = new THREE.Quaternion();
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');

  get isRaised(): boolean {
    return this.target === 1;
  }

  setRaised(raised: boolean): void {
    this.target = raised ? 1 : 0;
  }

  update(dt: number): void {
    if (dt <= 0) return;
    const { omega, zeta } = PHOTOGRAPHY.raise;
    this.raise = spring(this.raise, this.target, this.springState, omega, zeta, dt);
  }

  /**
   * `fov` is the live vertical field of view in degrees, so the framing adapts
   * to the mobile fov and to any window aspect with no second constant.
   */
  resolve(fov: number, out: PoseBlend): void {
    const t = this.raise;

    this.solveRaisedAnchor(fov);
    out.anchor.copy(REST_ANCHOR).lerp(this.raisedAnchor, t);

    // Zero at both ends, so it can only ever bend the middle of the journey.
    const arc = t * (1 - t) * 4;
    out.anchor.y += arc * PHOTOGRAPHY.raise.arcLift;
    out.anchor.z -= arc * PHOTOGRAPHY.raise.arcPull;

    // Driven by the spring's velocity, so raising and lowering differ without
    // authoring a second animation. Scaled by `t` so the rest pose is exact.
    const lead = this.springState.velocity * PHOTOGRAPHY.raise.leadScale * t;

    const rest = FLOATING_CAMERA.rotationDeg;
    const raised = PHOTOGRAPHY.raisedRotationDeg;
    out.pitch = lerp(rest.x * DEG, raised.x * DEG, t) + lead;
    out.yaw = lerp(rest.y * DEG, raised.y * DEG, t);
    out.roll = lerp(rest.z * DEG, raised.z * DEG, t) - lead * PHOTOGRAPHY.raise.rollLeadScale;

    out.followLambda = lerp(FLOATING_CAMERA.followLambda, PHOTOGRAPHY.raisedFollowLambda, t);
    out.rotationLambda = lerp(FLOATING_CAMERA.rotationLambda, PHOTOGRAPHY.raisedRotationLambda, t);
    out.driftScale = lerp(1, PHOTOGRAPHY.raisedDriftScale, t);
    out.lookOffsetScale = lerp(1, PHOTOGRAPHY.raisedLookOffsetScale, t);
    out.bankScale = lerp(1, PHOTOGRAPHY.raisedBankScale, t);

    if (import.meta.env?.DEV) assertRestPoseUnchanged(t, out);
  }

  /**
   * The knob is framing, not distance: solve for the distance at which the
   * screen subtends `screenHeightFraction` of the view height, then offset so
   * it is the SCREEN CENTRE that lands on the view axis, not the model origin
   * — the merged geometry's origin sits at the base of the body.
   */
  private solveRaisedAnchor(fov: number): void {
    const screenHeight = FLOATING_CAMERA.screen.height * FLOATING_CAMERA.scale;
    const distance =
      screenHeight / (2 * PHOTOGRAPHY.screenHeightFraction * Math.tan((fov * DEG) / 2));

    const raised = PHOTOGRAPHY.raisedRotationDeg;
    this.euler.set(raised.x * DEG, raised.y * DEG, raised.z * DEG);
    this.rotation.setFromEuler(this.euler);

    this.scratch
      .copy(SCREEN_CENTRE_LOCAL)
      .multiplyScalar(FLOATING_CAMERA.scale)
      .applyQuaternion(this.rotation);

    this.raisedAnchor.set(0, 0, -distance).sub(this.scratch);
  }
}

/**
 * The one regression that would be invisible in a screenshot and unacceptable
 * if it happened: exploration must feel exactly as it did before this feature.
 */
function assertRestPoseUnchanged(raise: number, out: PoseBlend): void {
  if (raise !== 0) return;
  const exact =
    out.anchor.x === FLOATING_CAMERA.anchor[0] &&
    out.anchor.y === FLOATING_CAMERA.anchor[1] &&
    out.anchor.z === FLOATING_CAMERA.anchor[2] &&
    out.pitch === FLOATING_CAMERA.rotationDeg.x * DEG &&
    out.yaw === FLOATING_CAMERA.rotationDeg.y * DEG &&
    out.roll === FLOATING_CAMERA.rotationDeg.z * DEG &&
    out.followLambda === FLOATING_CAMERA.followLambda &&
    out.rotationLambda === FLOATING_CAMERA.rotationLambda &&
    out.driftScale === 1 &&
    out.lookOffsetScale === 1 &&
    out.bankScale === 1;
  console.assert(exact, 'CameraPose: the rest pose no longer matches the pre-photography values');
}
