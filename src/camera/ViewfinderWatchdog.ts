import { VIEWFINDER } from '../core/Settings';

/**
 * Decides which rung of the viewfinder ladder the device can actually sustain.
 *
 * The honest signal on a frame-capped device is the ACHIEVED present rate.
 * Wall-clock dt cannot reveal the cost, because under a cap it measures the
 * rAF interval rather than the work being done inside it.
 *
 * Every decision reads a MEDIAN of buckets, never a mean, so one stalled frame
 * — a grass tile rebuild, a GC pause, a texture upload — cannot drag the whole
 * window under the threshold and trigger a downgrade the player will notice.
 */
export class ViewfinderWatchdog {
  rung: number;

  private readonly buckets: number[] = [];
  private bucketTime = 0;
  private bucketFrames = 0;
  private sinceReset = 0;
  private sinceChange = Infinity;
  private recoveries = 0;
  private floorRung = 0;
  private readonly failures = new Map<number, number>();

  constructor(startRung: number) {
    this.rung = startRung;
    this.floorRung = 0;
  }

  /** Called on every raise transition and every visibility change. */
  reset(): void {
    this.buckets.length = 0;
    this.bucketTime = 0;
    this.bucketFrames = 0;
    this.sinceReset = 0;
  }

  /**
   * `presentedDelta` is how many frames the engine has presented since the last
   * call. `targetRate` is the cap on a capped device, or the rate measured
   * before the camera was raised on an uncapped one.
   */
  update(dt: number, presentedDelta: number, targetRate: number): number {
    if (dt <= 0 || targetRate <= 0) return this.rung;

    this.sinceReset += dt;
    this.sinceChange += dt;

    const config = VIEWFINDER.watchdog;
    // The first frames pay for target allocation, shader compilation and the
    // first chrome upload. That spike is not representative of anything.
    if (this.sinceReset < config.warmupSeconds) return this.rung;

    if (this.sinceChange < config.cooldownSeconds) {
      // Still settling from the last change. Buckets built from this period
      // would mix pre- and post-change behaviour, so they are discarded
      // rather than banked — the new rung is judged only on evidence
      // collected once it has actually had a chance to settle.
      this.bucketTime = 0;
      this.bucketFrames = 0;
      return this.rung;
    }

    this.bucketTime += dt;
    this.bucketFrames += presentedDelta;
    if (this.bucketTime < config.bucketSeconds) return this.rung;

    this.buckets.push(this.bucketFrames / this.bucketTime);
    this.bucketTime = 0;
    this.bucketFrames = 0;
    if (this.buckets.length > config.recoverBuckets) this.buckets.shift();

    if (this.shouldDegrade(targetRate)) this.step(1);
    else if (this.shouldRecover(targetRate)) this.step(-1);

    return this.rung;
  }

  private shouldDegrade(targetRate: number): boolean {
    const config = VIEWFINDER.watchdog;
    if (this.rung >= VIEWFINDER.ladder.length - 1) return false;
    if (this.buckets.length < config.degradeBuckets) return false;
    return median(this.buckets.slice(-config.degradeBuckets)) < targetRate * config.degradeBelow;
  }

  private shouldRecover(targetRate: number): boolean {
    const config = VIEWFINDER.watchdog;
    if (this.rung <= this.floorRung) return false;
    if (this.recoveries >= config.maxRecoveries) return false;
    if (this.buckets.length < config.recoverBuckets) return false;
    return median(this.buckets.slice(-config.recoverBuckets)) > targetRate * config.recoverAbove;
  }

  private step(direction: 1 | -1): void {
    if (direction === 1) {
      // The rung we are leaving has now failed. Twice means never again.
      const failed = (this.failures.get(this.rung) ?? 0) + 1;
      this.failures.set(this.rung, failed);
      if (failed >= 2) {
        this.floorRung = Math.max(this.floorRung, this.rung + 1);
        // A rung that has permanently failed also spends one of the device's
        // lifetime recovery chances: a machine that has cratered down twice
        // has shown a pattern, not a blip, so it earns less benefit of the
        // doubt on every rung above it too.
        this.recoveries++;
      }
    } else {
      this.recoveries++;
    }

    this.rung += direction;
    this.sinceChange = 0;
    // The new rung is judged only on its own evidence.
    this.buckets.length = 0;
    this.bucketTime = 0;
    this.bucketFrames = 0;
  }
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return (sorted[middle - 1]! + sorted[middle]!) / 2;
}
