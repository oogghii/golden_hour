import * as THREE from 'three';

/**
 * Owns final presentation, including how colour reaches the screen. Swapping
 * the implementation is how `PostFX` takes over without the engine knowing.
 */
export interface RenderPipeline {
  render(scene: THREE.Scene, camera: THREE.Camera): void;
  setSize(width: number, height: number): void;
  dispose(): void;
}

/**
 * Straight to the canvas, with three's own tonemapping standing in for the
 * final grade. This keeps the image readable while the world is being built;
 * `PostFX` replaces it with the real composite in phase 6.
 */
export class DirectRenderPipeline implements RenderPipeline {
  constructor(private readonly renderer: THREE.WebGLRenderer) {
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
  }

  render(scene: THREE.Scene, camera: THREE.Camera): void {
    this.renderer.setRenderTarget(null);
    this.renderer.render(scene, camera);
  }

  setSize(): void {
    // The renderer already owns the canvas size; nothing else to resize.
  }

  dispose(): void {
    // Nothing owned.
  }
}
