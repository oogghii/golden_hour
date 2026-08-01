import * as THREE from 'three';
import type { LiveCameraScreen } from '../../camera/LiveCameraScreen';
import type { Viewfinder } from '../../camera/Viewfinder';
import { PHOTOGRAPHY } from '../../core/Settings';
import type { EngineContext, System } from '../../core/System';
import { viewfinderGain } from '../ExposureModel';
import type { PhotographyMode } from '../PhotographyMode';
import { touch } from '../PhotoState';
import { CaptureSequence } from './CaptureSequence';
import { createDevelopMaterial } from './developMaterial';
import type { PhotoLibrary } from './PhotoLibrary';
import { photoMetadataFrom } from './photoRecord';

/**
 * Takes the photograph.
 *
 * The expensive frame — a full-resolution scene render plus the develop pass —
 * fires only when `CaptureSequence` says the screen is fully black, which is
 * what the blackout exists for. Everything after it is off the critical path:
 * the review reads the developed target straight off the GPU, so nothing the
 * player sees ever waits on an encode or a database.
 */
export class PhotoCapture implements System {
  /** Set by main.ts. Called after a photograph has been written to the card. */
  onStored: (() => void) | null = null;

  private readonly sequence = new CaptureSequence();
  private readonly quadScene = new THREE.Scene();
  private readonly quadCamera = new THREE.Camera();
  private readonly develop = createDevelopMaterial();
  private readonly quad: THREE.Mesh;

  private captureTarget: THREE.WebGLRenderTarget | null = null;
  private photoTarget: THREE.WebGLRenderTarget | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private size: readonly [number, number] = [1620, 1080];

  constructor(
    private readonly viewfinder: Viewfinder,
    private readonly photography: PhotographyMode,
    private readonly screen: LiveCameraScreen,
    private readonly library: PhotoLibrary,
  ) {
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.develop);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  init(ctx: EngineContext): void {
    this.renderer = ctx.renderer;
    this.scene = ctx.scene;
    this.size = PHOTOGRAPHY.capture.resolution[ctx.quality.tier];
    const [width, height] = this.size;

    this.captureTarget = new THREE.WebGLRenderTarget(width, height, {
      type: THREE.HalfFloatType,
      depthBuffer: true,
      stencilBuffer: false,
      colorSpace: THREE.LinearSRGBColorSpace,
    });
    // 8-bit and already sRGB-encoded by the develop pass: readable by
    // readRenderTargetPixels, and exactly the bytes the encoder wants.
    this.photoTarget = new THREE.WebGLRenderTarget(width, height, {
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false,
      colorSpace: THREE.NoColorSpace,
    });

    // Subscribing here is what Phase 11 left undone: shutter() has always
    // invoked this hook, and until now nothing was listening to it.
    this.photography.onCapture = () => this.begin();
  }

  /** Returns false when the mirror is already up, so a second press does nothing. */
  private begin(): boolean {
    if (!this.sequence.start()) return false;
    this.photography.state.screenMode = 'review';
    touch(this.photography.state);
    return true;
  }

  update(dt: number): void {
    // Lowering the camera abandons a review in flight rather than riding the
    // screen down still black.
    if (this.sequence.isBusy && !this.photography.pose.isRaised) {
      this.sequence.cancel();
      this.finish();
      return;
    }

    const wasBusy = this.sequence.isBusy;
    this.sequence.update(dt);
    if (this.sequence.shouldRender) this.capture();

    if (this.sequence.isBusy) {
      this.screen.setCapture(this.sequence.photoMix, this.sequence.blackout, this.sequence.flash);
    } else if (wasBusy) {
      this.finish();
    }
  }

  private finish(): void {
    this.screen.setCapture(0, 0, 0);
    if (this.photography.state.screenMode === 'review') {
      this.photography.state.screenMode = 'live';
      touch(this.photography.state);
    }
  }

  /** The one expensive frame, taken while the screen is fully black. */
  private capture(): void {
    const renderer = this.renderer;
    const scene = this.scene;
    const camera = this.viewfinder.prepareCameraForCapture();
    const captureTarget = this.captureTarget;
    const photoTarget = this.photoTarget;
    if (!renderer || !scene || !camera || !captureTarget || !photoTarget) return;

    renderer.setRenderTarget(captureTarget);
    // PostFX turns autoClear off, so this pass clears for itself.
    renderer.clear();
    renderer.render(scene, camera);

    this.develop.uniforms.uSource!.value = captureTarget.texture;
    this.develop.uniforms.uGain!.value = viewfinderGain(this.photography.state);
    renderer.setRenderTarget(photoTarget);
    renderer.render(this.quadScene, this.quadCamera);
    renderer.setRenderTarget(null);

    this.screen.setPhoto(photoTarget.texture);
    void this.store(photoTarget);
  }

  /**
   * Everything in here is allowed to fail. The player has already seen the
   * photograph; this is only about keeping it.
   */
  private async store(target: THREE.WebGLRenderTarget): Promise<void> {
    const renderer = this.renderer;
    if (!renderer) return;
    const [width, height] = this.size;
    const metadata = photoMetadataFrom(this.photography.state, Date.now());

    try {
      const pixels = new Uint8Array(width * height * 4);
      await renderer.readRenderTargetPixelsAsync(target, 0, 0, width, height, pixels);

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      // WebGL reads bottom-up; a canvas is top-down. Flipping by row here is
      // cheaper and far simpler than a second GPU pass to do the same thing.
      const image = ctx.createImageData(width, height);
      const stride = width * 4;
      for (let row = 0; row < height; row++) {
        const source = (height - 1 - row) * stride;
        image.data.set(pixels.subarray(source, source + stride), row * stride);
      }
      ctx.putImageData(image, 0, 0);

      const blob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve, 'image/jpeg', PHOTOGRAPHY.capture.jpegQuality);
      });
      if (!blob) return;

      const id = await this.library.put(metadata, blob);
      if (id === null) this.reportCard();
      this.onStored?.();
    } catch (error) {
      if (import.meta.env.DEV) console.warn('Photo was shown but not stored:', error);
    }
  }

  /** A camera reports card trouble where it reports frames remaining. */
  private reportCard(): void {
    const status = this.library.status;
    const reading = status === 'full' ? 'FULL' : status === 'unavailable' ? 'NO CARD' : null;
    if (this.photography.state.cardStatus === reading) return;
    this.photography.state.cardStatus = reading;
    touch(this.photography.state);
  }

  dispose(): void {
    this.photography.onCapture = null;
    this.captureTarget?.dispose();
    this.photoTarget?.dispose();
    this.quad.geometry.dispose();
    this.develop.dispose();
  }
}
