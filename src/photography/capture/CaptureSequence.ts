import { PHOTOGRAPHY } from '../../core/Settings';
import { saturate } from '../../util/math';

export type CapturePhase = 'idle' | 'blackout' | 'hold' | 'flash' | 'review' | 'return';

/**
 * The shutter, as pure timing. No three, no renderer, no state beyond a phase
 * and a clock — so the one property that actually matters can be asserted:
 * the capture render happens on a frame the player cannot see.
 *
 * The blackout is split into a ramp (`blackout`) and a fully opaque hold
 * (`hold`) for exactly that reason. It makes the render frame addressable:
 * `shouldRender` fires on the transition between them, where the screen is
 * black by construction rather than by arithmetic a long frame could step past.
 *
 * Phases advance at most one per update and carry their overshoot forward. A
 * machine slow enough to cross a whole phase in one frame therefore stretches
 * the sequence rather than skipping the render, which would leave the review
 * holding an empty target.
 */
export class CaptureSequence {
  private current: CapturePhase = 'idle';
  private timer = 0;
  private rendered = false;
  private renderFrame = false;

  get phase(): CapturePhase {
    return this.current;
  }

  get isBusy(): boolean {
    return this.current !== 'idle';
  }

  /** True for exactly one update per sequence, on a fully black frame. */
  get shouldRender(): boolean {
    return this.renderFrame;
  }

  get blackout(): number {
    const config = PHOTOGRAPHY.capture;
    switch (this.current) {
      case 'blackout':
        return saturate(this.timer / config.blackoutInSeconds);
      case 'hold':
        return 1;
      case 'flash':
        return 1 - saturate(this.timer / config.flashSeconds);
      default:
        return 0;
    }
  }

  /** A spike as the black lifts: a third of the window up, two thirds down. */
  get flash(): number {
    if (this.current !== 'flash') return 0;
    const u = saturate(this.timer / PHOTOGRAPHY.capture.flashSeconds);
    return u < 1 / 3 ? u * 3 : saturate((1 - u) * 1.5);
  }

  get photoMix(): number {
    switch (this.current) {
      case 'hold':
      case 'flash':
      case 'review':
        return 1;
      case 'return':
        return 1 - saturate(this.timer / PHOTOGRAPHY.capture.returnSeconds);
      default:
        return 0;
    }
  }

  /** Returns false if a sequence is already running: the mirror is already up. */
  start(): boolean {
    if (this.isBusy) return false;
    this.current = 'blackout';
    this.timer = 0;
    this.rendered = false;
    this.renderFrame = false;
    return true;
  }

  cancel(): void {
    this.current = 'idle';
    this.timer = 0;
    this.rendered = false;
    this.renderFrame = false;
  }

  update(dt: number): void {
    this.renderFrame = false;
    if (this.current === 'idle' || dt <= 0) return;

    this.timer += dt;
    const config = PHOTOGRAPHY.capture;

    switch (this.current) {
      case 'blackout':
        if (this.timer >= config.blackoutInSeconds) {
          this.advance(config.blackoutInSeconds, 'hold');
          // Raised here rather than in `hold`'s own body so it lands on the
          // same update the screen becomes fully black, not the one after it.
          if (!this.rendered) {
            this.rendered = true;
            this.renderFrame = true;
          }
        }
        break;
      case 'hold':
        if (this.timer >= config.blackoutHoldSeconds) {
          this.advance(config.blackoutHoldSeconds, 'flash');
        }
        break;
      case 'flash':
        if (this.timer >= config.flashSeconds) this.advance(config.flashSeconds, 'review');
        break;
      case 'review':
        if (this.timer >= config.reviewSeconds) this.advance(config.reviewSeconds, 'return');
        break;
      case 'return':
        if (this.timer >= config.returnSeconds) this.cancel();
        break;
    }
  }

  private advance(duration: number, next: CapturePhase): void {
    this.timer -= duration;
    this.current = next;
  }
}
