import type { Engine } from '../core/Engine';
import type { System } from '../core/System';

const SAMPLE_SECONDS = 0.5;

const STYLE = `
  position: fixed;
  top: 8px;
  left: 8px;
  z-index: 10;
  padding: 6px 9px;
  border-radius: 5px;
  background: rgba(28, 14, 10, 0.55);
  color: #ffe6c8;
  font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
  font-variant-numeric: tabular-nums;
  white-space: pre;
  pointer-events: none;
`;

/**
 * DEV only. `main.ts` imports this dynamically so it never reaches production,
 * per the no-debug-overlay rule in AGENTS.md.
 */
export class DevStats implements System {
  private readonly el = document.createElement('div');
  private accum = 0;
  private lastFrame = 0;
  private ticks = 0;
  private rafHz = 0;

  constructor(
    private readonly engine: Engine,
    private readonly viewfinder?: { readonly lastCost: { calls: number; triangles: number }; readonly rung: number },
  ) {
    this.el.style.cssText = STYLE;
    document.body.appendChild(this.el);
  }

  update(dt: number): void {
    this.accum += dt;
    this.ticks++;
    if (this.accum < SAMPLE_SECONDS) return;
    this.rafHz = this.ticks / this.accum;
    this.ticks = 0;

    const info = this.engine.renderer.info;
    // Counts presented frames, not renderer passes: post-processing issues
    // several passes per frame, so info.render.frame would read many times high.
    const presented = this.engine.presentedFrames;
    const fps = (presented - this.lastFrame) / this.accum;
    this.lastFrame = presented;
    this.accum = 0;

    const { tier, frameCap, renderScale } = this.engine.quality;
    const cap = Number.isFinite(frameCap) ? String(frameCap) : 'off';

    this.el.textContent = [
      `${fps.toFixed(0).padStart(3)} fps   cap ${cap}`,
      `${info.render.calls} calls  ${(info.render.triangles / 1000).toFixed(0)}k tris`,
      `${tier}  x${renderScale}  ${info.memory.geometries}g ${info.memory.textures}t`,
      `budget ${(this.engine.frameBudget * 1000).toFixed(1)}ms  raf ${this.rafHz.toFixed(0)}Hz`,
      this.viewfinder
        ? `vf r${this.viewfinder.rung}  +${this.viewfinder.lastCost.calls} calls  +${(this.viewfinder.lastCost.triangles / 1000).toFixed(0)}k`
        : 'vf off',
    ].join('\n');
  }

  dispose(): void {
    this.el.remove();
  }
}
