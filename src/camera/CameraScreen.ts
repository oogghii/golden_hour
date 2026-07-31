import type * as THREE from 'three';

/**
 * The rear display seam. Phase 7 uses a static emissive screen; a later live
 * render target can replace it without changing FloatingCamera.
 */
export interface CameraScreen {
  attach(model: THREE.Object3D): void;
  update?(dt: number, elapsed: number): void;
  dispose(): void;
}
