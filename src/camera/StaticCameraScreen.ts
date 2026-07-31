import * as THREE from 'three';
import { FLOATING_CAMERA } from '../core/Settings';
import type { CameraScreen } from './CameraScreen';

/** A low-resolution warm landscape memory, emissive but not bright enough to bloom. */
export class StaticCameraScreen implements CameraScreen {
  private mesh: THREE.Mesh | null = null;
  private texture: THREE.CanvasTexture | null = null;

  attach(model: THREE.Object3D): void {
    const config = FLOATING_CAMERA.screen;
    this.texture = createScreenTexture();
    const material = new THREE.MeshBasicMaterial({
      map: this.texture,
      side: THREE.FrontSide,
      depthWrite: true,
      toneMapped: false,
    });
    const geometry = new THREE.PlaneGeometry(config.width, config.height);
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.name = 'CameraScreen';
    this.mesh.position.set(...config.position);
    this.mesh.renderOrder = 2;
    model.add(this.mesh);
  }

  dispose(): void {
    if (!this.mesh) return;
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.texture?.dispose();
    this.texture = null;
    this.mesh = null;
  }
}

function createScreenTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 80;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('2D canvas context unavailable for the camera screen');

  const config = FLOATING_CAMERA.screen;
  const top = new THREE.Color(config.colorTop).getStyle();
  const bottom = new THREE.Color(config.colorBottom).getStyle();
  const gradient = context.createLinearGradient(0, 0, 0, canvas.height);
  gradient.addColorStop(0, top);
  gradient.addColorStop(0.62, '#e6a278');
  gradient.addColorStop(1, bottom);
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);

  context.fillStyle = 'rgba(255, 232, 174, 0.9)';
  context.beginPath();
  context.arc(82, 35, 7, 0, Math.PI * 2);
  context.fill();

  context.fillStyle = '#7a7658';
  context.beginPath();
  context.moveTo(0, 58);
  context.lineTo(22, 48);
  context.lineTo(45, 56);
  context.lineTo(69, 45);
  context.lineTo(96, 55);
  context.lineTo(128, 47);
  context.lineTo(128, 80);
  context.lineTo(0, 80);
  context.closePath();
  context.fill();

  context.fillStyle = '#4f693d';
  context.fillRect(0, 65, canvas.width, 15);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  return texture;
}
