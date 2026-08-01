import * as THREE from 'three';
import { FLOATING_CAMERA } from '../core/Settings';
import type { PhotographyMode } from '../photography/PhotographyMode';
import { viewfinderGain } from '../photography/ExposureModel';
import type { CameraScreen } from './CameraScreen';
import { createScreenMaterial } from './screenMaterial';
import { ScreenUI } from './ScreenUI';

const ZERO_RECT = new THREE.Vector4(0, 0, 0, 0);

/** The rear display, showing what the lens sees. */
export class LiveCameraScreen implements CameraScreen {
  readonly surface: THREE.Mesh;

  private readonly material: THREE.ShaderMaterial;
  private readonly screenUI = new ScreenUI();

  constructor(private readonly photography: PhotographyMode) {
    const config = FLOATING_CAMERA.screen;
    this.material = createScreenMaterial();
    this.material.uniforms.uChrome!.value = this.screenUI.texture;
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

  update(_dt: number, _elapsed: number): void {
    this.screenUI.sync(this.photography.state);
    this.setGain(viewfinderGain(this.photography.state));
  }

  setFeed(texture: THREE.Texture | null): void {
    this.material.uniforms.uFeed!.value = texture;
  }

  setFrozen(frozen: boolean): void {
    this.material.uniforms.uFrozen!.value = frozen ? 1 : 0;
  }

  /** The developed photograph: the capture target in review, a decoded one in the album. */
  setPhoto(texture: THREE.Texture | null): void {
    this.material.uniforms.uPhoto!.value = texture;
  }

  /** The three capture envelopes, written together because they are one animation. */
  setCapture(photoMix: number, blackout: number, flash: number): void {
    this.material.uniforms.uPhotoMix!.value = photoMix;
    this.material.uniforms.uBlackout!.value = blackout;
    this.material.uniforms.uFlash!.value = flash;
  }

  setGain(gain: number): void {
    this.material.uniforms.uGain!.value = gain;
  }

  setHover(rect: THREE.Vector4 | null, pressed: boolean): void {
    this.material.uniforms.uHoverRect!.value.copy(rect ?? ZERO_RECT);
    this.material.uniforms.uPressed!.value = pressed ? 1 : 0;
  }

  setReticle(u: number, v: number, alpha: number): void {
    this.material.uniforms.uReticle!.value.set(u, v);
    this.material.uniforms.uReticleAlpha!.value = alpha;
  }

  setFocus(rect: THREE.Vector4, confirmed: boolean): void {
    this.material.uniforms.uFocusRect!.value.copy(rect);
    this.material.uniforms.uFocusConfirm!.value = confirmed ? 1 : 0;
  }

  setRoll(radians: number): void {
    this.material.uniforms.uRoll!.value = radians;
  }

  dispose(): void {
    this.surface.removeFromParent();
    this.surface.geometry.dispose();
    this.material.dispose();
    this.screenUI.dispose();
  }
}
