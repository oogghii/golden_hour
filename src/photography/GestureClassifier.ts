import { PHOTOGRAPHY } from '../core/Settings';

export type GesturePhase = 'idle' | 'reticle' | 'look';

/**
 * Decides once, at the start of a gesture, whether the mouse is operating the
 * camera or reframing the world — and then holds that decision until movement
 * settles. Nothing re-evaluates mid-gesture, so the same physical movement
 * always means the same thing for its whole duration.
 *
 * The classification is provisional on the first frame and locked at the end of
 * the second, with only a reticle->look upgrade permitted in that window. That
 * is what stops an acceleration ramp from reading as a deliberate movement,
 * without buffering input and adding latency.
 */
export class GestureClassifier {
  phase: GesturePhase = 'idle';
  locked = false;
  /** The speed the current gesture was classified on, for the DEV readout. */
  classifyPeak = 0;

  private previousSpeed = 0;
  private settleTime = 0;

  reset(): void {
    this.phase = 'idle';
    this.locked = false;
    this.previousSpeed = 0;
    this.settleTime = 0;
  }

  update(dx: number, dy: number, dt: number): GesturePhase {
    if (dt <= 0) return this.phase;

    const config = PHOTOGRAPHY.reticle;
    const speed = Math.hypot(dx, dy) / dt;
    const peak = Math.max(speed, this.previousSpeed);
    this.previousSpeed = speed;

    if (this.phase === 'idle') {
      if (speed > config.settlePxPerSec) {
        this.phase = speed >= config.flickPxPerSec ? 'look' : 'reticle';
        // A look classification is certain; a reticle one gets one more frame.
        this.locked = this.phase === 'look';
        this.classifyPeak = speed;
        this.settleTime = 0;
      }
      return this.phase;
    }

    if (!this.locked) {
      if (peak >= config.flickPxPerSec) {
        this.phase = 'look';
        this.classifyPeak = peak;
      }
      this.locked = true;
    }

    if (speed <= config.settlePxPerSec) {
      this.settleTime += dt;
      if (this.settleTime >= config.settleSeconds) this.reset();
    } else {
      this.settleTime = 0;
    }

    return this.phase;
  }
}
