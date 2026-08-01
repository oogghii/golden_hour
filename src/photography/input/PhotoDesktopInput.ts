import { PLAYER } from '../../core/Settings';
import type { System } from '../../core/System';
import type { InputState } from '../../player/input/InputState';
import type { CameraInteraction } from '../CameraInteraction';
import type { PhotographyMode } from '../PhotographyMode';

const DRAG_PX_PER_STEP = 26;

/**
 * Every desktop binding in one place. Keyboard exists only as an optional
 * accessibility and development alternative and is never the primary path.
 */
export class PhotoDesktopInput implements System {
  private dragAccumulator = 0;
  private dragging = false;
  private lastMoveTime = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly photography: PhotographyMode,
    private readonly interaction: CameraInteraction,
    private readonly input: InputState,
  ) {}

  init(): void {
    this.canvas.addEventListener('contextmenu', this.onContextMenu);
    this.canvas.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('keydown', this.onKeyDown);
  }

  dispose(): void {
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);
    this.canvas.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    this.canvas.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('keydown', this.onKeyDown);
  }

  /**
   * Called by DesktopInput with the raw pointer delta. Returns nothing: the
   * interaction layer decides what belongs to the reticle, and whatever it
   * rejects is written straight into the shared look accumulator.
   */
  routePointer(dx: number, dy: number): void {
    const now = performance.now() * 0.001;
    const dt = this.lastMoveTime > 0 ? Math.max(now - this.lastMoveTime, 1e-4) : 1 / 60;
    this.lastMoveTime = now;

    if (!this.photography.pose.isRaised) {
      this.input.lookDeltaYaw += dx * PLAYER.lookSensitivity;
      this.input.lookDeltaPitch += dy * PLAYER.lookSensitivity;
      return;
    }

    this.interaction.pointerDelta(dx, dy, dt);
    this.input.lookDeltaYaw += this.interaction.lookSpill.x * PLAYER.lookSensitivity;
    this.input.lookDeltaPitch += this.interaction.lookSpill.y * PLAYER.lookSensitivity;

    if (this.dragging) this.accumulateDrag(dx);
  }

  private accumulateDrag(dx: number): void {
    const selected = this.photography.state.selected;
    const hovered = this.interaction.hovered;
    const overSelected =
      hovered !== null && hovered !== 'body' && hovered !== 'shutterButton' &&
      hovered.settingId !== null && hovered.settingId === selected;
    if (!overSelected) return;

    this.dragAccumulator += dx;
    const steps = Math.trunc(this.dragAccumulator / DRAG_PX_PER_STEP);
    if (steps === 0) return;
    this.dragAccumulator -= steps * DRAG_PX_PER_STEP;
    this.photography.changeSetting(steps);
  }

  private readonly onContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
    this.photography.togglePhotographyMode();
  };

  private readonly onMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0 || !this.photography.pose.isRaised) return;
    this.dragging = true;
    this.dragAccumulator = 0;
    this.interaction.press();
  };

  private readonly onMouseUp = (event: MouseEvent): void => {
    if (event.button !== 0) return;
    this.dragging = false;
    this.interaction.release();
  };

  private readonly onWheel = (event: WheelEvent): void => {
    if (!this.photography.pose.isRaised) return;
    event.preventDefault();
    this.interaction.wheel(-Math.sign(event.deltaY));
  };

  /** Optional accessibility and development alternatives only. */
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.photography.pose.isRaised) return;
    if (event.code === 'BracketLeft') this.photography.changeSetting(-1);
    else if (event.code === 'BracketRight') this.photography.changeSetting(1);
    else if (event.code === 'Space') this.photography.shutter('up');
  };
}
