import type * as THREE from 'three';

/**
 * The rear display seam. `StaticCameraScreen` is the emissive first-milestone
 * implementation and remains the hard floor when render targets are
 * unavailable; `LiveCameraScreen` adds the viewfinder and the interface.
 */
export interface CameraScreen {
  attach(model: THREE.Object3D): void;
  update?(dt: number, elapsed: number): void;
  dispose(): void;
  /** The pickable rear surface, if this screen is interactive. */
  readonly surface?: THREE.Mesh;
  /** Hands over the live viewfinder texture, if this screen can show one. */
  setFeed?(texture: THREE.Texture | null): void;
}
