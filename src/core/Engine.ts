import * as THREE from 'three';
import type { EngineContext, System } from './System';
import { resolveQuality, type QualitySettings } from './Quality';
import { DirectRenderPipeline, type RenderPipeline } from './RenderPipeline';
import { FOG, VIEW } from './Settings';
import { clamp } from '../util/math';

/** Never simulate a step longer than this, so a tab switch can't teleport the player. */
const MAX_DT = 1 / 20;

/**
 * Owns the renderer, the scene, the clock and an ordered list of systems.
 * Updates run every animation frame; rendering can run less often when a frame
 * cap is active, which keeps simulation smooth at a pinned 30 fps.
 */
export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly quality: QualitySettings;

  /** Replace before `start()` to take over presentation. */
  pipeline: RenderPipeline;

  /**
   * Frames actually presented. A pipeline may issue several renderer passes per
   * frame, so `renderer.info.render.frame` is not a frame count.
   */
  presentedFrames = 0;

  /** Seconds between presents that the frame cap is targeting. 0 = uncapped. */
  get frameBudget(): number {
    return this.minFrameTime;
  }

  private readonly canvas: HTMLCanvasElement;
  private readonly systems: System[] = [];
  private readonly minFrameTime: number;
  private readonly drawingBuffer = new THREE.Vector2();
  private readonly resizeObserver: ResizeObserver;

  private width = 0;
  private height = 0;
  private prevTime = 0;
  private renderAccumulator = Number.POSITIVE_INFINITY;
  private elapsed = 0;
  private rafId = 0;
  private sizeDirty = true;
  private started = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.quality = resolveQuality();

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      // MSAA is configured on the post-processing target instead, so the
      // default framebuffer stays cheap.
      antialias: false,
      alpha: false,
      stencil: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setClearColor(FOG.color, 1);

    if (this.quality.shadowMapSize > 0) {
      this.renderer.shadowMap.enabled = true;
      // PCFSoftShadowMap is deprecated in r185 and silently falls back to this.
      this.renderer.shadowMap.type = THREE.PCFShadowMap;
    }

    this.scene.fog = new THREE.FogExp2(FOG.color, FOG.density);

    const fov = this.quality.isTouch ? VIEW.fovMobile : VIEW.fovDesktop;
    this.camera = new THREE.PerspectiveCamera(fov, 1, VIEW.near, VIEW.far);

    this.pipeline = new DirectRenderPipeline(this.renderer);
    this.minFrameTime = Number.isFinite(this.quality.frameCap) ? 1 / this.quality.frameCap : 0;

    this.resizeObserver = new ResizeObserver(() => {
      this.sizeDirty = true;
    });
  }

  /** Register a system. All systems must be added before `start()`. */
  add<T extends System>(system: T): T {
    if (this.started) {
      throw new Error('Systems must be registered before Engine.start()');
    }
    this.systems.push(system);
    return system;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    const ctx: EngineContext = {
      renderer: this.renderer,
      scene: this.scene,
      camera: this.camera,
      quality: this.quality,
    };
    for (const system of this.systems) {
      await system.init?.(ctx);
    }

    this.syncSize();
    this.resizeObserver.observe(this.canvas);
    // ResizeObserver misses device-pixel-ratio changes, such as dragging the
    // window to a display with a different scale factor.
    window.addEventListener('resize', this.markSizeDirty, { passive: true });
    document.addEventListener('visibilitychange', this.onVisibilityChange);

    this.prevTime = performance.now() * 0.001;
    this.rafId = requestAnimationFrame(this.tick);
  }

  dispose(): void {
    cancelAnimationFrame(this.rafId);
    this.resizeObserver.disconnect();
    window.removeEventListener('resize', this.markSizeDirty);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    for (let i = this.systems.length - 1; i >= 0; i--) {
      this.systems[i]?.dispose?.();
    }
    this.systems.length = 0;
    this.pipeline.dispose();
    this.renderer.dispose();
  }

  private readonly tick = (nowMs: number): void => {
    this.rafId = requestAnimationFrame(this.tick);

    const now = nowMs * 0.001;
    const raw = now - this.prevTime;
    this.prevTime = now;

    if (document.hidden) return;

    const dt = clamp(raw, 0, MAX_DT);
    this.elapsed += dt;

    if (this.sizeDirty) {
      this.sizeDirty = false;
      this.syncSize();
    }

    for (const system of this.systems) {
      system.update?.(dt, this.elapsed);
    }

    // A carry-over accumulator rather than a wall-clock comparison with slack.
    // Comparing against elapsed time makes the achieved rate depend on the
    // display's refresh interval, which lands well off the requested cap on a
    // high-refresh monitor. Carrying the remainder averages exactly to the cap,
    // and clamping it stops a long stall from triggering a catch-up burst.
    this.renderAccumulator += dt;
    if (this.renderAccumulator >= this.minFrameTime) {
      this.renderAccumulator = Math.min(
        this.renderAccumulator - this.minFrameTime,
        this.minFrameTime,
      );
      this.pipeline.render(this.scene, this.camera);
      this.presentedFrames++;
    }
  };

  private readonly markSizeDirty = (): void => {
    this.sizeDirty = true;
  };

  private readonly onVisibilityChange = (): void => {
    if (document.hidden) return;
    // Returning from a hidden tab: drop the accumulated gap rather than
    // simulating it, and allow the next frame to render immediately.
    this.prevTime = performance.now() * 0.001;
    this.renderAccumulator = Number.POSITIVE_INFINITY;
  };

  private syncSize(): void {
    const width = Math.max(1, this.canvas.clientWidth);
    const height = Math.max(1, this.canvas.clientHeight);
    const pixelRatio =
      Math.min(window.devicePixelRatio || 1, this.quality.dprCap) * this.quality.renderScale;

    if (
      width === this.width &&
      height === this.height &&
      pixelRatio === this.renderer.getPixelRatio()
    ) {
      return;
    }

    this.width = width;
    this.height = height;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height, false);
    this.renderer.getDrawingBufferSize(this.drawingBuffer);
    this.pipeline.setSize(this.drawingBuffer.x, this.drawingBuffer.y);

    for (const system of this.systems) {
      system.resize?.(width, height);
    }
  }
}
