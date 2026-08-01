import * as THREE from 'three';
import { FLOATING_CAMERA, VIEWFINDER } from '../core/Settings';
import type { CameraScreen } from './CameraScreen';

/** The rear display, showing what the lens sees. */
export class LiveCameraScreen implements CameraScreen {
  readonly surface: THREE.Mesh;

  private readonly material: THREE.MeshBasicMaterial;

  constructor() {
    const config = FLOATING_CAMERA.screen;
    this.material = new THREE.MeshBasicMaterial({
      color: 0x000000,
      toneMapped: false,
      side: THREE.FrontSide,
    });
    this.surface = new THREE.Mesh(
      new THREE.PlaneGeometry(config.width, config.height),
      this.material,
    );
    this.surface.name = 'CameraScreen';
    this.surface.position.set(...config.position);
    this.surface.renderOrder = 2;
  }

  attach(model: THREE.Object3D): void {
    model.add(this.surface);
  }

  setFeed(texture: THREE.Texture | null): void {
    this.material.map = texture;
    this.material.color.setScalar(texture ? 1 : 0);
    this.material.needsUpdate = true;
  }

  /** Rung 3 keeps the last frame and drops the refresh rate, like a real LCD. */
  setFrozen(frozen: boolean): void {
    this.material.color.setScalar(frozen ? VIEWFINDER.frozenDim : 1);
  }

  dispose(): void {
    this.surface.removeFromParent();
    this.surface.geometry.dispose();
    this.material.dispose();
  }
}
