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
      hovered.adjustable && hovered.settingId !== null && hovered.settingId === selected;
    if (!overSelected) return;

    this.dragAccumulator += dx;
    const steps = Math.trunc(this.dragAccumulator / DRAG_PX_PER_STEP);
    if (steps === 0) return;
    this.dragAccumulator -= steps * DRAG_PX_PER_STEP;
    this.photography.changeSetting(steps);
  }

  private readonly onContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
  };

  private readonly onMouseDown = (event: MouseEvent): void => {
    // Pointer lock can suppress `contextmenu`, but it still delivers the
    // button press. Toggle here so right-click remains the desktop entry
    // point after the boot overlay has locked the canvas.
    if (event.button === 2) {
      event.preventDefault();
      this.photography.togglePhotographyMode();
      return;
    }
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
    const notches = -Math.sign(event.deltaY);
    // Inverted for the album on purpose: scrolling down should advance through
    // the roll, the way it advances through a page.
    if (this.photography.album.isOpen) this.photography.flipAlbum(-notches);
    else this.interaction.wheel(notches);
  };

  /** Optional accessibility and development alternatives only. */
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.photography.pose.isRaised) return;

    // Browsing rebinds the whole keyboard: there is nothing to shoot or adjust
    // while looking at a photograph already taken.
    if (this.photography.album.isOpen) {
      if (event.code === 'ArrowLeft') this.photography.flipAlbum(-1);
      else if (event.code === 'ArrowRight') this.photography.flipAlbum(1);
      else if (event.code === 'Escape') this.photography.toggleAlbum();
      return;
    }

    if (event.code === 'BracketLeft') this.photography.changeSetting(-1);
    else if (event.code === 'BracketRight') this.photography.changeSetting(1);
    else if (event.code === 'Space') {
      // Space is the page's scroll key whenever focus is not on the locked
      // canvas. Firing the shutter and scrolling the document at the same time
      // is never what was meant.
      event.preventDefault();
      this.photography.shutter('up');
    }
  };
}
