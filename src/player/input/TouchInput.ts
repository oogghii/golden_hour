import { TOUCH } from '../../core/Settings';
import type { System } from '../../core/System';
import type { InputState } from './InputState';

interface TouchPoint {
  x: number;
  y: number;
  downAt: number;
}

/**
 * Invisible mobile controls: drag anywhere to look, hold to walk, and add a
 * second finger for the faster stroll. No screen-space controls are created.
 */
export class TouchInput implements System {
  private readonly points = new Map<number, TouchPoint>();
  private primaryId: number | null = null;

  constructor(
    private readonly input: InputState,
    private readonly canvas: HTMLCanvasElement,
  ) {}

  init(): void {
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerEnd);
    this.canvas.addEventListener('pointercancel', this.onPointerEnd);
    window.addEventListener('blur', this.reset);
  }

  update(): void {
    const primary = this.primaryId === null ? undefined : this.points.get(this.primaryId);
    const heldFor = primary ? performance.now() * 0.001 - primary.downAt : 0;
    this.input.moveForward = primary && heldFor >= TOUCH.holdDelay ? 1 : 0;
    this.input.moveRight = 0;
    this.input.boost = this.points.size >= 2;
  }

  dispose(): void {
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerEnd);
    this.canvas.removeEventListener('pointercancel', this.onPointerEnd);
    window.removeEventListener('blur', this.reset);
    this.reset();
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType !== 'touch') return;
    event.preventDefault();
    this.canvas.setPointerCapture(event.pointerId);
    this.points.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
      downAt: performance.now() * 0.001,
    });
    if (this.primaryId === null) this.primaryId = event.pointerId;
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    const point = this.points.get(event.pointerId);
    if (!point) return;
    event.preventDefault();

    const dx = event.clientX - point.x;
    const dy = event.clientY - point.y;
    point.x = event.clientX;
    point.y = event.clientY;
    if (event.pointerId !== this.primaryId) return;
    if (Math.hypot(dx, dy) < TOUCH.dragDeadzone) return;

    this.input.lookDeltaYaw += dx * TOUCH.lookSensitivity;
    this.input.lookDeltaPitch += dy * TOUCH.lookSensitivity;
  };

  private readonly onPointerEnd = (event: PointerEvent): void => {
    if (!this.points.delete(event.pointerId)) return;
    if (this.canvas.hasPointerCapture(event.pointerId)) {
      this.canvas.releasePointerCapture(event.pointerId);
    }
    if (event.pointerId === this.primaryId) {
      this.primaryId = this.points.keys().next().value ?? null;
    }
    if (this.points.size === 0) {
      this.input.moveForward = 0;
      this.input.boost = false;
    }
  };

  private readonly reset = (): void => {
    this.points.clear();
    this.primaryId = null;
    this.input.moveForward = 0;
    this.input.moveRight = 0;
    this.input.boost = false;
  };
}
