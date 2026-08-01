import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { FLOATING_CAMERA, PHOTOGRAPHY } from '../core/Settings';
import { DEG } from '../util/math';
import { CameraPose, createPoseBlend } from './CameraPose';

const FOV = 62;
const DT = 1 / 60;

function settle(pose: CameraPose, seconds: number): void {
  for (let t = 0; t < seconds; t += DT) pose.update(DT);
}

describe('the rest pose is untouched', () => {
  it('reproduces the pre-Photography-Mode anchor exactly at raise 0', () => {
    const pose = new CameraPose();
    const out = createPoseBlend();
    pose.resolve(FOV, out);

    expect(out.anchor.toArray()).toEqual([...FLOATING_CAMERA.anchor]);
    expect(out.pitch).toBe(FLOATING_CAMERA.rotationDeg.x * DEG);
    expect(out.yaw).toBe(FLOATING_CAMERA.rotationDeg.y * DEG);
    expect(out.roll).toBe(FLOATING_CAMERA.rotationDeg.z * DEG);
    expect(out.followLambda).toBe(FLOATING_CAMERA.followLambda);
    expect(out.rotationLambda).toBe(FLOATING_CAMERA.rotationLambda);
    expect(out.driftScale).toBe(1);
    expect(out.lookOffsetScale).toBe(1);
    expect(out.bankScale).toBe(1);
  });

  it('returns to that exact rest pose after a full raise and lower', () => {
    const pose = new CameraPose();
    const out = createPoseBlend();
    pose.setRaised(true);
    settle(pose, 3);
    pose.setRaised(false);
    settle(pose, 3);
    pose.resolve(FOV, out);

    expect(pose.raise).toBeCloseTo(0, 6);
    expect(out.anchor.x).toBeCloseTo(FLOATING_CAMERA.anchor[0], 4);
    expect(out.anchor.y).toBeCloseTo(FLOATING_CAMERA.anchor[1], 4);
    expect(out.anchor.z).toBeCloseTo(FLOATING_CAMERA.anchor[2], 4);
  });
});

describe('the raise spring', () => {
  it('overshoots, because the overshoot is what reads as weight', () => {
    const pose = new CameraPose();
    pose.setRaised(true);
    let peak = 0;
    for (let t = 0; t < 3; t += DT) {
      pose.update(DT);
      peak = Math.max(peak, pose.raise);
    }
    expect(peak).toBeGreaterThan(1.02);
  });

  it('settles inside a second', () => {
    const pose = new CameraPose();
    pose.setRaised(true);
    settle(pose, 1);
    expect(pose.raise).toBeCloseTo(1, 2);
  });

  it('is stable at a long frame, because dt is clamped but still coarse', () => {
    const pose = new CameraPose();
    pose.setRaised(true);
    for (let i = 0; i < 40; i++) pose.update(1 / 20);
    expect(Number.isFinite(pose.raise)).toBe(true);
    expect(pose.raise).toBeCloseTo(1, 2);
  });
});

describe('the raised pose', () => {
  it('puts the screen centre on the view axis at the framed distance', () => {
    const pose = new CameraPose();
    const out = createPoseBlend();
    pose.setRaised(true);
    settle(pose, 3);
    pose.resolve(FOV, out);

    const rotation = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(out.pitch, out.yaw, out.roll, 'YXZ'),
    );
    const screenCentre = new THREE.Vector3(0, 0.3125, 0.229)
      .multiplyScalar(FLOATING_CAMERA.scale)
      .applyQuaternion(rotation)
      .add(out.anchor);

    expect(screenCentre.x).toBeCloseTo(0, 3);
    expect(screenCentre.y).toBeCloseTo(0, 3);

    // The screen should subtend screenHeightFraction of the view height.
    const viewHeight = 2 * Math.abs(screenCentre.z) * Math.tan((FOV * DEG) / 2);
    const screenHeight = FLOATING_CAMERA.screen.height * FLOATING_CAMERA.scale;
    expect(screenHeight / viewHeight).toBeCloseTo(PHOTOGRAPHY.screenHeightFraction, 2);
  });

  it('reframes for a wider fov by moving the camera further away', () => {
    const pose = new CameraPose();
    const narrow = createPoseBlend();
    const wide = createPoseBlend();
    pose.setRaised(true);
    settle(pose, 3);
    pose.resolve(62, narrow);
    pose.resolve(70, wide);
    expect(Math.abs(wide.anchor.z)).toBeGreaterThan(Math.abs(narrow.anchor.z));
  });

  it('steadies the follow rather than loosening it', () => {
    const pose = new CameraPose();
    const out = createPoseBlend();
    pose.setRaised(true);
    settle(pose, 3);
    pose.resolve(FOV, out);
    expect(out.followLambda).toBeGreaterThan(FLOATING_CAMERA.followLambda);
    expect(out.driftScale).toBeLessThan(1);
  });
});

describe('the arc', () => {
  it('lifts the path off the straight line mid-transition, and only there', () => {
    const settled = new CameraPose();
    settled.setRaised(true);
    settle(settled, 3);
    const destination = createPoseBlend();
    settled.resolve(FOV, destination);
    const end = destination.anchor.clone();
    const start = new THREE.Vector3(...FLOATING_CAMERA.anchor);

    const pose = new CameraPose();
    const out = createPoseBlend();
    let maxDeviation = 0;
    pose.setRaised(true);
    for (let t = 0; t < 3; t += DT) {
      pose.update(DT);
      pose.resolve(FOV, out);
      const straight = start.clone().lerp(end, Math.min(pose.raise, 1));
      maxDeviation = Math.max(maxDeviation, out.anchor.distanceTo(straight));
    }
    expect(maxDeviation).toBeGreaterThan(0.01);
  });
});
