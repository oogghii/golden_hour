import type * as THREE from 'three';
import type { QualitySettings } from './Quality';

/**
 * What the engine hands every system. Deliberately small: anything a system
 * needs beyond this (the height field, the player, the wind) is passed to its
 * constructor by `main.ts`, so dependencies stay explicit instead of turning
 * this into a god object.
 */
export interface EngineContext {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly quality: QualitySettings;
}

export interface System {
  /** Called once, in registration order, before the first frame. */
  init?(ctx: EngineContext): void | Promise<void>;
  /** `dt` is clamped seconds; `elapsed` is total seconds since start. */
  update?(dt: number, elapsed: number): void;
  /** CSS pixel size of the canvas. */
  resize?(width: number, height: number): void;
  dispose?(): void;
}
