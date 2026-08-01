import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createInputState } from '../player/input/InputState';
import { HeightField } from '../world/HeightField';
import { PhotographyMode } from './PhotographyMode';

function mode(): PhotographyMode {
  return new PhotographyMode(createInputState(), new HeightField());
}

describe('measureFocusDistance', () => {
  it('finds the ground directly below, close to the true drop', () => {
    const photography = mode();
    const height = new HeightField();
    const x = 5;
    const z = -5;
    const groundY = height.heightAt(x, z);
    const origin = new THREE.Vector3(x, groundY + 50, z);
    const direction = new THREE.Vector3(0, -1, 0);

    expect(photography.measureFocusDistance(origin, direction)).toBeCloseTo(50, 0);
  });

  it('returns Infinity for a ray that never meets the ground', () => {
    const photography = mode();
    const origin = new THREE.Vector3(0, 1000, 0);
    const direction = new THREE.Vector3(0, 1, 0);

    expect(photography.measureFocusDistance(origin, direction)).toBe(Infinity);
  });

  it('refines past the coarse step: two rays a metre apart resolve to distances that differ by less than the coarse step', () => {
    const photography = mode();
    const height = new HeightField();
    const y = height.heightAt(0, 0) + 30;
    const a = photography.measureFocusDistance(
      new THREE.Vector3(0, y, 0),
      new THREE.Vector3(0, -1, 0),
    );
    const b = photography.measureFocusDistance(
      new THREE.Vector3(0.3, y, 0.3),
      new THREE.Vector3(0, -1, 0),
    );
    expect(Math.abs(a - b)).toBeLessThan(1.5);
  });
});

describe('setFocusResult', () => {
  it('confirms focus and bumps the revision so the chrome layer redraws', () => {
    const photography = mode();
    const before = photography.state.revision;

    photography.setFocusResult(12.3);

    expect(photography.state.focusDistance).toBe(12.3);
    expect(photography.state.focusConfirmed).toBe(true);
    expect(photography.state.revision).toBeGreaterThan(before);
  });
});

describe('focus', () => {
  it('records the uv and un-confirms, leaving the distance for setFocusResult', () => {
    const photography = mode();
    photography.setFocusResult(8);

    photography.focus({ x: 0.2, y: 0.7 });

    expect(photography.state.focusUv).toEqual({ x: 0.2, y: 0.7 });
    expect(photography.state.focusConfirmed).toBe(false);
    // Untouched until CameraInteraction calls back with a real measurement.
    expect(photography.state.focusDistance).toBe(8);
  });

  it('defaults to the centre of the frame with no uv', () => {
    const photography = mode();
    photography.focus();
    expect(photography.state.focusUv).toEqual({ x: 0.5, y: 0.5 });
  });
});
