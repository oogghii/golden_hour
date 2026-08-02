import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { CAMERA_LAYER, type FloatingCamera } from '../camera/FloatingCamera';
import type { LiveCameraScreen } from '../camera/LiveCameraScreen';
import { FLOATING_CAMERA, PHOTOGRAPHY } from '../core/Settings';
import type { EngineContext } from '../core/System';
import { createInputState } from '../player/input/InputState';
import type { HeightField } from '../world/HeightField';
import { CameraInteraction } from './CameraInteraction';
import { PhotographyMode } from './PhotographyMode';

/**
 * The focus path is the one place three separate uv conventions have to agree:
 * the raycast's y-up uv, the y-down table in InteractionZones, and the y-up
 * rect the screen shader draws the frame from. Nothing on screen would look
 * obviously wrong if the vertical sense were inverted — the frame would still
 * be a frame, and the distance would still be a plausible number — so these
 * are checked here rather than by eye.
 *
 * The scene is deliberately trivial: a flat ground at y = 0, the camera body
 * held level at MODEL_HEIGHT above it, and the screen as a bare plane. That
 * makes every expected value something the test can derive rather than assert
 * from a recording.
 */

const SCREEN_ASPECT = FLOATING_CAMERA.screen.width / FLOATING_CAMERA.screen.height;
const MODEL_HEIGHT = 2;
const DT = 1 / 60;

/** Where the lens sits with the body level, which is where the ray must start. */
const LENS_HEIGHT = MODEL_HEIGHT + FLOATING_CAMERA.lensLocal[1] * FLOATING_CAMERA.scale;

function harness() {
  const surface = new THREE.Mesh(
    new THREE.PlaneGeometry(FLOATING_CAMERA.screen.width, FLOATING_CAMERA.screen.height),
    new THREE.MeshBasicMaterial(),
  );
  const model = new THREE.Object3D();
  model.position.set(0, MODEL_HEIGHT, 0);
  model.add(surface);
  model.traverse((child) => child.layers.set(CAMERA_LAYER));
  model.updateMatrixWorld(true);

  // Square on to the screen, so a uv maps to an NDC the projection can invert
  // exactly and a tap can be aimed in uv rather than in pixels.
  const camera = new THREE.PerspectiveCamera(62, 1, 0.1, 100);
  camera.position.set(0, MODEL_HEIGHT, 1);
  camera.lookAt(0, MODEL_HEIGHT, 0);
  camera.updateMatrixWorld(true);

  const setFocus = vi.fn();
  const screen = {
    surface,
    setReticle: vi.fn(),
    setHover: vi.fn(),
    setFocus,
  } as unknown as LiveCameraScreen;
  const floating = { object: model, shutterButton: null } as unknown as FloatingCamera;
  const height = { heightAt: () => 0 } as unknown as HeightField;

  const photography = new PhotographyMode(createInputState(), height);
  const interaction = new CameraInteraction(floating, screen, photography);
  interaction.init({ camera } as unknown as EngineContext);
  photography.enterPhotographyMode();

  const ndcForUv = (u: number, v: number): [number, number] => {
    const point = surface.localToWorld(
      new THREE.Vector3(
        (u - 0.5) * FLOATING_CAMERA.screen.width,
        (v - 0.5) * FLOATING_CAMERA.screen.height,
        0,
      ),
    );
    point.project(camera);
    return [point.x, point.y];
  };

  return {
    interaction,
    photography,
    ndcForUv,
    /** A complete press and release at one point, which is what activates. */
    tap(u: number, v: number): void {
      const ndc = ndcForUv(u, v);
      interaction.touchPress(...ndc);
      interaction.touchRelease(...ndc);
    },
    /** The rect handed to the screen on the most recent frame. */
    focusRect(): THREE.Vector4 {
      const call = setFocus.mock.calls.at(-1);
      if (!call) throw new Error('setFocus was never called');
      return call[0] as THREE.Vector4;
    },
  };
}

/** The vertical half-extent of the frustum, one unit forward. */
function halfHeightAt(focalMm: number): number {
  return PHOTOGRAPHY.lens.sensorHeightMm / 2 / focalMm;
}

describe('castFocusRay', () => {
  it('reads a tap on the image as the focus zone', () => {
    const test = harness();
    expect(test.interaction.touchMove(...test.ndcForUv(0.5, 0.3))).toMatchObject({
      id: 'focusPoint',
    });
  });

  it('aims below the horizon for a tap below centre, and above it for one above', () => {
    const test = harness();

    // The whole convention in two assertions: the focus path takes the y-up uv
    // straight from the raycast and does NOT flip it, unlike the zone lookup.
    // Held level over flat ground, a downward ray must land and an upward one
    // must escape. Invert the sense and these two swap.
    test.tap(0.5, 0.3);
    expect(Number.isFinite(test.photography.state.focusDistance)).toBe(true);

    test.tap(0.5, 0.7);
    expect(test.photography.state.focusDistance).toBe(Infinity);
  });

  it('marches from the lens, not the body, to the distance the frustum implies', () => {
    const test = harness();
    test.tap(0.5, 0.3);

    // Straight down the centre line, so the ray drops (v - 0.5) * 2 * halfHeight
    // per unit forward and the ground is reached where that drop equals the
    // lens height. Starting the march at the model origin instead would put
    // this out by the length of the lens offset — about 0.6 m here.
    const drop = (0.5 - 0.3) * 2 * halfHeightAt(test.photography.state.focalMm);
    const expected = (LENS_HEIGHT * Math.hypot(drop, 1)) / drop;

    expect(test.photography.state.focusDistance).toBeCloseTo(expected, 1);
    expect(test.photography.state.focusConfirmed).toBe(true);
  });

  it('confirms nothing until a press and a release agree on the image', () => {
    const test = harness();
    test.interaction.touchMove(...test.ndcForUv(0.5, 0.3));
    expect(test.photography.state.focusConfirmed).toBe(false);
  });
});

describe('updateFocusRect', () => {
  it('centres the frame on the focus point and keeps it square', () => {
    const test = harness();
    test.tap(0.5, 0.4);
    test.interaction.update(DT);

    const rect = test.focusRect();
    const width = PHOTOGRAPHY.focus.frameWidthFraction;

    expect((rect.x + rect.z) / 2).toBeCloseTo(0.5, 4);
    expect((rect.y + rect.w) / 2).toBeCloseTo(0.4, 4);
    expect(rect.z - rect.x).toBeCloseTo(width, 4);
    // Taller than it is wide in uv, which is what makes it square on a 3:2
    // screen. Equal extents here would draw a visibly flattened frame.
    expect(rect.w - rect.y).toBeCloseTo(width * SCREEN_ASPECT, 4);
  });

  it('clamps the frame inside the screen instead of letting it hang off an edge', () => {
    const test = harness();
    test.tap(0.02, 0.5);
    test.interaction.update(DT);

    const rect = test.focusRect();
    expect(rect.x).toBeCloseTo(0, 4);
    expect(rect.z).toBeCloseTo(PHOTOGRAPHY.focus.frameWidthFraction, 4);
    expect(rect.y).toBeGreaterThanOrEqual(0);
    expect(rect.w).toBeLessThanOrEqual(1);
  });
});
