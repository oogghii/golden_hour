import type { System } from '../../core/System';
import { PLAYER } from '../../core/Settings';
import type { InputState } from './InputState';

const FORWARD_KEYS = ['KeyW', 'ArrowUp'];
const BACK_KEYS = ['KeyS', 'ArrowDown'];
const RIGHT_KEYS = ['KeyD', 'ArrowRight'];
const LEFT_KEYS = ['KeyA', 'ArrowLeft'];
const BOOST_KEYS = ['ShiftLeft', 'ShiftRight'];

/** Pointer lock for looking, WASD for walking, Shift for a slightly faster stroll. */
export class DesktopInput implements System {
  private readonly held = new Set<string>();

  /** Set by main.ts. When present, it owns what happens to the pointer delta. */
  route: ((dx: number, dy: number) => void) | null = null;

  constructor(
    private readonly input: InputState,
    private readonly canvas: HTMLCanvasElement,
  ) {}

  init(): void {
    this.canvas.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
  }

  update(): void {
    this.input.moveForward = this.axis(FORWARD_KEYS, BACK_KEYS);
    this.input.moveRight = this.axis(RIGHT_KEYS, LEFT_KEYS);
    this.input.boost = BOOST_KEYS.some((code) => this.held.has(code));
  }

  dispose(): void {
    this.canvas.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
  }

  requestLock(): void {
    void this.canvas.requestPointerLock();
  }

  get isLocked(): boolean {
    return document.pointerLockElement === this.canvas;
  }

  private axis(positive: readonly string[], negative: readonly string[]): number {
    const up = positive.some((code) => this.held.has(code)) ? 1 : 0;
    const down = negative.some((code) => this.held.has(code)) ? 1 : 0;
    return up - down;
  }

  private readonly onMouseMove = (event: MouseEvent): void => {
    if (!this.isLocked) return;
    if (this.route) {
      this.route(event.movementX, event.movementY);
      return;
    }
    this.input.lookDeltaYaw += event.movementX * PLAYER.lookSensitivity;
    this.input.lookDeltaPitch += event.movementY * PLAYER.lookSensitivity;
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    this.held.add(event.code);
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.held.delete(event.code);
  };

  /** Losing focus mid-stride would otherwise leave the player walking forever. */
  private readonly onBlur = (): void => {
    this.held.clear();
  };
}
