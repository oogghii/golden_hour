import * as THREE from 'three';
import { POST, sunDirection } from '../core/Settings';
import type { QualitySettings } from '../core/Quality';
import type { RenderPipeline } from '../core/RenderPipeline';
import {
  BRIGHT_FRAGMENT,
  compositeFragment,
  FULLSCREEN_VERTEX,
  TENT_FRAGMENT,
} from './shaders/composite.glsl';

/** How far up the sun ray the glow anchor sits. Only affects its screen position. */
const SUN_ANCHOR_DISTANCE = 500;

/**
 * Scene into a linear HDR target, a dual-filter bloom chain, then one composite
 * that does camera motion blur, tonemapping, grading and sRGB encoding.
 *
 * The renderer stays linear and untonemapped throughout; every conversion happens
 * in the composite shader. Splitting that responsibility is the classic way to end
 * up with a washed-out or double-encoded image.
 */
export class PostFX implements RenderPipeline {
  private readonly quadScene = new THREE.Scene();
  private readonly quadCamera = new THREE.Camera();
  private readonly quad: THREE.Mesh;

  private readonly bright: THREE.ShaderMaterial;
  private readonly tent: THREE.ShaderMaterial;
  private readonly composite: THREE.ShaderMaterial;

  private sceneTarget: THREE.WebGLRenderTarget;
  private bloomTargets: THREE.WebGLRenderTarget[] = [];

  private readonly prevViewProjection = new THREE.Matrix4();
  private readonly viewProjection = new THREE.Matrix4();
  private readonly sunDirection = sunDirection();
  private readonly sunAnchor = new THREE.Vector3();
  private readonly cameraForward = new THREE.Vector3();
  private hasPreviousFrame = false;
  private width = 1;
  private height = 1;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly quality: QualitySettings,
  ) {
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    // Clears are managed per pass. Left on, three would wipe the target before
    // each additive upsample and the bloom chain would never accumulate.
    renderer.autoClear = false;
    // Stats must span every pass in a frame. Left on, they reset per render call
    // and only ever report the last blit.
    renderer.info.autoReset = false;

    this.sceneTarget = this.createSceneTarget(1, 1);

    this.bright = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: BRIGHT_FRAGMENT,
      uniforms: {
        uSource: { value: null },
        uThreshold: { value: POST.bloom.threshold },
        uKnee: { value: POST.bloom.knee },
      },
      depthTest: false,
      depthWrite: false,
    });

    this.tent = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: TENT_FRAGMENT,
      uniforms: {
        uSource: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uRadius: { value: 1 },
      },
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });

    this.composite = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: compositeFragment(quality.motionBlurTaps),
      uniforms: {
        uScene: { value: null },
        uBloom: { value: null },
        uDepth: { value: null },
        uInvViewProjection: { value: new THREE.Matrix4() },
        uPrevViewProjection: { value: new THREE.Matrix4() },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uSunScreen: { value: new THREE.Vector2(0.5, 0.5) },
        uSunVisible: { value: 0 },
        uExposure: { value: POST.exposure },
        uSaturation: { value: POST.saturation },
        uBloomStrength: { value: POST.bloom.strength },
        uBlurStrength: { value: POST.motionBlur.strength },
        uMaxBlurPixels: { value: POST.motionBlur.maxPixels },
        uSunGlow: { value: POST.sunGlow.strength },
        uSunFalloff: { value: POST.sunGlow.falloff },
        uAberration: { value: POST.chromaticAberration },
        uGrain: { value: POST.grain },
        uGrainTime: { value: 0 },
        uVignetteStart: { value: POST.vignette.start },
        uVignetteEnd: { value: POST.vignette.end },
        uVignetteTint: { value: new THREE.Vector3(...POST.vignette.tint) },
        uHighlightTint: { value: new THREE.Vector3(...POST.highlightTint) },
        uShadowTint: { value: new THREE.Vector3(...POST.shadowTint) },
        uBlackLift: { value: new THREE.Vector3(...POST.blackLift) },
      },
      depthTest: false,
      depthWrite: false,
    });

    // A 2x2 plane in clip space; the vertex shader ignores the matrices entirely.
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.composite);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  setSize(width: number, height: number): void {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));

    this.sceneTarget.depthTexture?.dispose();
    this.sceneTarget.dispose();
    this.sceneTarget = this.createSceneTarget(this.width, this.height);

    for (const target of this.bloomTargets) target.dispose();
    this.bloomTargets = [];
    for (let i = 0; i < this.quality.bloomMips; i++) {
      const divisor = 2 << i;
      this.bloomTargets.push(
        new THREE.WebGLRenderTarget(
          Math.max(1, Math.floor(this.width / divisor)),
          Math.max(1, Math.floor(this.height / divisor)),
          {
            type: THREE.HalfFloatType,
            depthBuffer: false,
            stencilBuffer: false,
            colorSpace: THREE.LinearSRGBColorSpace,
          },
        ),
      );
    }

    this.composite.uniforms.uResolution!.value.set(this.width, this.height);
    // A resize invalidates the reprojection history, so skip blur for one frame.
    this.hasPreviousFrame = false;
  }

  render(scene: THREE.Scene, camera: THREE.Camera): void {
    this.renderer.info.reset();
    this.renderer.setRenderTarget(this.sceneTarget);
    this.renderer.clear();
    this.renderer.render(scene, camera);

    this.renderBloom();
    this.renderComposite(camera);

    // Captured after presenting, so the next frame reprojects against exactly
    // what was last shown rather than against a frame that was never drawn.
    this.prevViewProjection.copy(this.viewProjection);
    this.hasPreviousFrame = true;
  }

  dispose(): void {
    this.sceneTarget.depthTexture?.dispose();
    this.sceneTarget.dispose();
    for (const target of this.bloomTargets) target.dispose();
    this.bloomTargets = [];
    this.quad.geometry.dispose();
    this.bright.dispose();
    this.tent.dispose();
    this.composite.dispose();
  }

  private createSceneTarget(width: number, height: number): THREE.WebGLRenderTarget {
    const depthTexture = new THREE.DepthTexture(width, height);
    depthTexture.type = THREE.UnsignedIntType;

    return new THREE.WebGLRenderTarget(width, height, {
      // Half float so the sun and the backlit grass can exceed 1.0 and give the
      // bloom something real to find.
      type: THREE.HalfFloatType,
      depthBuffer: true,
      stencilBuffer: false,
      depthTexture,
      samples: this.quality.msaaSamples,
      colorSpace: THREE.LinearSRGBColorSpace,
    });
  }

  private renderBloom(): void {
    const first = this.bloomTargets[0];
    if (!first) return;

    this.bright.uniforms.uSource!.value = this.sceneTarget.texture;
    this.blit(this.bright, first);

    // Down the chain, blurring as we go.
    for (let i = 1; i < this.bloomTargets.length; i++) {
      this.tentPass(this.bloomTargets[i - 1]!, this.bloomTargets[i]!, 1);
    }

    // Back up, accumulating, which is what gives the wide soft falloff.
    this.tent.blending = THREE.AdditiveBlending;
    for (let i = this.bloomTargets.length - 1; i > 0; i--) {
      this.tentPass(this.bloomTargets[i]!, this.bloomTargets[i - 1]!, 2);
    }
    this.tent.blending = THREE.NoBlending;
  }

  private tentPass(
    source: THREE.WebGLRenderTarget,
    destination: THREE.WebGLRenderTarget,
    radius: number,
  ): void {
    this.tent.uniforms.uSource!.value = source.texture;
    this.tent.uniforms.uTexel!.value.set(1 / source.width, 1 / source.height);
    this.tent.uniforms.uRadius!.value = radius;
    this.blit(this.tent, destination, false);
  }

  private renderComposite(camera: THREE.Camera): void {
    const uniforms = this.composite.uniforms;

    this.viewProjection.copy(camera.projectionMatrix).multiply(camera.matrixWorldInverse);
    uniforms.uInvViewProjection!.value.copy(this.viewProjection).invert();
    uniforms.uPrevViewProjection!.value.copy(
      this.hasPreviousFrame ? this.prevViewProjection : this.viewProjection,
    );

    // Where the sun lands on screen, and how much of it is in front of us.
    this.sunAnchor
      .copy(this.sunDirection)
      .multiplyScalar(SUN_ANCHOR_DISTANCE)
      .add(camera.position);
    camera.getWorldDirection(this.cameraForward);
    const facing = this.cameraForward.dot(this.sunDirection);
    if (facing > 0) {
      this.sunAnchor.project(camera);
      uniforms.uSunScreen!.value.set(this.sunAnchor.x * 0.5 + 0.5, this.sunAnchor.y * 0.5 + 0.5);
      uniforms.uSunVisible!.value = THREE.MathUtils.smoothstep(facing, 0, 0.25);
    } else {
      uniforms.uSunVisible!.value = 0;
    }

    uniforms.uScene!.value = this.sceneTarget.texture;
    uniforms.uBloom!.value = this.bloomTargets[0]?.texture ?? null;
    uniforms.uDepth!.value = this.sceneTarget.depthTexture;
    uniforms.uGrainTime!.value = (uniforms.uGrainTime!.value + 1) % 1024;

    this.blit(this.composite, null);
  }

  private blit(
    material: THREE.ShaderMaterial,
    target: THREE.WebGLRenderTarget | null,
    clear = true,
  ): void {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    if (clear) this.renderer.clear();
    this.renderer.render(this.quadScene, this.quadCamera);
  }
}
