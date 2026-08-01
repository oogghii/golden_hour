import { TOUCH } from '../../core/Settings';
import type { System } from '../../core/System';
import type { CameraInteraction, HoverTarget } from '../../photography/CameraInteraction';
import type { CameraActions } from '../../photography/CameraActions';
import type { PhotographyMode } from '../../photography/PhotographyMode';
import type { Zone } from '../../photography/InteractionZones';
import type { InputState } from './InputState';

interface TouchPoint {
  x: number;
  y: number;
  downAt: number;
  target: HoverTarget;
  moved: boolean;
  draggingSetting: boolean;
  dragAccumulator: number;
  pressCancelled: boolean;
}

function isAdjustableTarget(target: HoverTarget): target is Zone {
  return (
    target !== null &&
    target !== 'body' &&
    target !== 'shutterButton' &&
    target.adjustable &&
    target.settingId !== null
  );
}

function isCameraBodyTarget(target: HoverTarget): boolean {
  return target === 'body' || target === 'shutterButton';
}

/**
 * Invisible mobile controls: drag anywhere to look, hold to walk, and add a
 * second finger for the faster stroll. While the camera is raised, the same
 * surface becomes a touch-ray producer for Photography Mode.
 */
export class TouchInput implements System {
  private readonly points = new Map<number, TouchPoint>();
  private primaryId: number | null = null;
  private pinchDistance: number | null = null;
  private readonly actions: CameraActions;

  constructor(
    private readonly input: InputState,
    private readonly canvas: HTMLCanvasElement,
    private readonly photography: PhotographyMode,
    private readonly interaction: CameraInteraction,
  ) {
    this.actions = photography;
  }

  init(): void {
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointercancel', this.onPointerCancel);
    window.addEventListener('blur', this.reset);
  }

  update(): void {
    const primary = this.primaryId === null ? undefined : this.points.get(this.primaryId);
    const heldFor = primary ? performance.now() * 0.001 - primary.downAt : 0;
    const raised = this.photography.pose.isRaised;
    const pinching = raised && this.points.size >= 2;

    this.input.moveForward = primary && heldFor >= TOUCH.holdDelay && !pinching ? 1 : 0;
    this.input.moveRight = 0;
    this.input.boost = !raised && this.points.size >= 2;
  }

  dispose(): void {
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerCancel);
    window.removeEventListener('blur', this.reset);
    this.reset();
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType !== 'touch') return;
    event.preventDefault();
    this.canvas.setPointerCapture(event.pointerId);

    const now = performance.now() * 0.001;
    const point: TouchPoint = {
      x: event.clientX,
      y: event.clientY,
      downAt: now,
      target: null,
      moved: false,
      draggingSetting: false,
      dragAccumulator: 0,
      pressCancelled: false,
    };
    this.points.set(event.pointerId, point);

    if (this.primaryId === null) {
      this.primaryId = event.pointerId;
      point.target = this.interaction.touchPress(this.toNdcX(event.clientX), this.toNdcY(event.clientY));
      return;
    }

    // A second finger changes the gesture to a pinch (or the existing stroll
    // gesture while lowered), so a pending single-finger camera press cannot
    // activate when one finger is lifted first.
    const primary = this.points.get(this.primaryId);
    if (primary) {
      primary.moved = true;
      primary.pressCancelled = true;
    }
    this.interaction.cancelPress();
    this.pinchDistance = this.distanceBetweenPoints();
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    const point = this.points.get(event.pointerId);
    if (!point) return;
    event.preventDefault();

    const dx = event.clientX - point.x;
    const dy = event.clientY - point.y;
    point.x = event.clientX;
    point.y = event.clientY;

    if (this.points.size >= 2) {
      if (this.photography.pose.isRaised) this.updatePinch();
      return;
    }
    if (event.pointerId !== this.primaryId) return;
    if (Math.hypot(dx, dy) < TOUCH.dragDeadzone) return;

    point.moved = true;
    if (!this.photography.pose.isRaised) {
      this.addLook(dx, dy);
      return;
    }

    this.interaction.touchMove(this.toNdcX(point.x), this.toNdcY(point.y));
    if (isAdjustableTarget(point.target)) {
      if (!point.draggingSetting) {
        this.actions.selectSetting(point.target.settingId);
        point.draggingSetting = true;
      }
      point.dragAccumulator += dx;
      const steps = Math.trunc(point.dragAccumulator / TOUCH.dragPxPerStep);
      if (steps !== 0) {
        point.dragAccumulator -= steps * TOUCH.dragPxPerStep;
        this.actions.changeSetting(steps);
      }
      return;
    }

    if (!point.pressCancelled) {
      this.interaction.cancelPress();
      point.pressCancelled = true;
    }
    this.addLook(dx, dy);
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    this.endPointer(event, false);
  };

  private readonly onPointerCancel = (event: PointerEvent): void => {
    this.endPointer(event, true);
  };

  private endPointer(event: PointerEvent, cancelled: boolean): void {
    if (event.pointerType !== 'touch') return;
    const point = this.points.get(event.pointerId);
    if (!point) return;
    event.preventDefault();

    if (this.canvas.hasPointerCapture(event.pointerId)) {
      this.canvas.releasePointerCapture(event.pointerId);
    }

    const wasPrimary = event.pointerId === this.primaryId;
    const hadMultiple = this.points.size >= 2;
    const raised = this.photography.pose.isRaised;

    if (raised) {
      if (cancelled || hadMultiple || (point.moved && point.pressCancelled)) {
        this.interaction.cancelPress();
      } else if (wasPrimary) {
        this.interaction.touchRelease(this.toNdcX(point.x), this.toNdcY(point.y));
        if (!point.moved && point.target === 'body') this.actions.exitPhotographyMode();
      }
    } else if (wasPrimary && !cancelled && !hadMultiple && !point.moved && isCameraBodyTarget(point.target)) {
      this.actions.enterPhotographyMode();
    }

    this.points.delete(event.pointerId);
    if (wasPrimary) {
      const next = this.points.keys().next().value;
      this.primaryId = next ?? null;
      if (next !== undefined) {
        const nextPoint = this.points.get(next);
        if (nextPoint) {
          nextPoint.moved = true;
          nextPoint.pressCancelled = true;
        }
      }
    }
    this.pinchDistance = this.points.size >= 2 ? this.distanceBetweenPoints() : null;

    if (this.points.size === 0) {
      this.input.moveForward = 0;
      this.input.boost = false;
    }
  }

  private updatePinch(): void {
    const distance = this.distanceBetweenPoints();
    if (distance <= 1e-4) return;
    if (this.pinchDistance === null || this.pinchDistance <= 1e-4) {
      this.pinchDistance = distance;
      return;
    }

    const deltaLog = Math.log(distance / this.pinchDistance);
    this.pinchDistance = distance;
    if (Math.abs(deltaLog) > 1e-4) this.actions.zoom(deltaLog);
  }

  private distanceBetweenPoints(): number {
    if (this.primaryId === null) return 0;
    const primary = this.points.get(this.primaryId);
    if (!primary) return 0;

    for (const [id, point] of this.points) {
      if (id !== this.primaryId) return Math.hypot(point.x - primary.x, point.y - primary.y);
    }
    return 0;
  }

  private addLook(dx: number, dy: number): void {
    this.input.lookDeltaYaw += dx * TOUCH.lookSensitivity;
    this.input.lookDeltaPitch += dy * TOUCH.lookSensitivity;
  }

  private toNdcX(clientX: number): number {
    const rect = this.canvas.getBoundingClientRect();
    return ((clientX - rect.left) / Math.max(rect.width, 1)) * 2 - 1;
  }

  private toNdcY(clientY: number): number {
    const rect = this.canvas.getBoundingClientRect();
    return 1 - ((clientY - rect.top) / Math.max(rect.height, 1)) * 2;
  }

  private readonly reset = (): void => {
    this.points.clear();
    this.primaryId = null;
    this.pinchDistance = null;
    this.interaction.cancelPress();
    if (this.photography.pose.isRaised) this.actions.exitPhotographyMode();
    this.input.moveForward = 0;
    this.input.moveRight = 0;
    this.input.boost = false;
  };
}
