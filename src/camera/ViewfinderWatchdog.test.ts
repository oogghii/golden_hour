import { describe, expect, it } from 'vitest';
import { VIEWFINDER } from '../core/Settings';
import { ViewfinderWatchdog } from './ViewfinderWatchdog';

const TARGET = 30;
const DT = 1 / 60;

/** A rate that fails the degrade threshold, and one that clears recovery. */
const BAD = 20;
const GOOD = TARGET * 1.05;

/** Feeds `seconds` of steady frames achieving `rate` presented frames/sec. */
function run(dog: ViewfinderWatchdog, seconds: number, rate: number): void {
  for (let t = 0; t < seconds; t += DT) dog.update(DT, rate * DT, TARGET);
}

/**
 * Feeds `rate` until the rung moves, and returns where it moved to. Asserting
 * on this rather than on a fixed number of seconds keeps the ladder tests
 * independent of exactly how long a decision takes to accumulate — the cooldown
 * and the bucket window both delay it, and a run that is a second short reads
 * as "no change" rather than as the failure it is meant to catch.
 */
function until(dog: ViewfinderWatchdog, rate: number, limitSeconds = 40): number {
  const start = dog.rung;
  for (let t = 0; t < limitSeconds && dog.rung === start; t += DT) {
    dog.update(DT, rate * DT, TARGET);
  }
  return dog.rung;
}

describe('warm-up', () => {
  it('refuses to degrade during the first second, however bad it looks', () => {
    const dog = new ViewfinderWatchdog(0);
    run(dog, VIEWFINDER.watchdog.warmupSeconds - 0.1, 5);
    expect(dog.rung).toBe(0);
  });

  it('keeps the warm-up out of the buckets, not merely out of the decision', () => {
    // Half a bucket per step, so bucket boundaries land exactly and the warm-up
    // window is a whole number of buckets. Banking those buckets would leave
    // [bad, bad, good, good], whose MEDIAN is below the degrade threshold —
    // unlike a single bad bucket, which the median absorbs on its own. This is
    // the case that separates the guard from the minimum-window guard below:
    // delete the guard and this degrades to rung 1.
    const { warmupSeconds, bucketSeconds } = VIEWFINDER.watchdog;
    const dt = bucketSeconds / 2;
    const steps = warmupSeconds / dt;
    const dog = new ViewfinderWatchdog(0);

    for (let i = 0; i < steps; i++) dog.update(dt, 5 * dt, TARGET);
    for (let i = 0; i < steps; i++) dog.update(dt, TARGET * dt, TARGET);

    expect(dog.rung).toBe(0);
  });
});

describe('the minimum observation window', () => {
  it('needs a full window of buckets before it will act', () => {
    const dog = new ViewfinderWatchdog(0);
    run(dog, VIEWFINDER.watchdog.warmupSeconds, TARGET);
    run(dog, 1.0, 20); // bad, but only two buckets of it
    expect(dog.rung).toBe(0);
  });

  it('degrades once the window is genuinely full of bad buckets', () => {
    const dog = new ViewfinderWatchdog(0);
    run(dog, VIEWFINDER.watchdog.warmupSeconds, TARGET);
    run(dog, 2.5, 20);
    expect(dog.rung).toBe(1);
  });
});

describe('transients', () => {
  it('ignores a single stalled bucket in an otherwise healthy run', () => {
    const dog = new ViewfinderWatchdog(0);
    run(dog, VIEWFINDER.watchdog.warmupSeconds, TARGET);
    run(dog, 1.5, TARGET);
    run(dog, 0.5, 3); // one catastrophic bucket
    run(dog, 1.5, TARGET);
    expect(dog.rung).toBe(0);
  });

  it('ignores a 300ms stall, which is the specific case the median exists for', () => {
    const dog = new ViewfinderWatchdog(0);
    run(dog, VIEWFINDER.watchdog.warmupSeconds, TARGET);
    run(dog, 1.0, TARGET);
    dog.update(0.3, 1, TARGET);
    run(dog, 2.0, TARGET);
    expect(dog.rung).toBe(0);
  });
});

describe('hysteresis', () => {
  it('does not recover at a rate that would still count as failing', () => {
    const dog = new ViewfinderWatchdog(0);
    run(dog, VIEWFINDER.watchdog.warmupSeconds, TARGET);
    run(dog, 2.5, 20);
    expect(dog.rung).toBe(1);
    run(dog, 12, TARGET * 0.95); // between degradeBelow and recoverAbove
    expect(dog.rung).toBe(1);
  });

  it('recovers once the rate is genuinely at target', () => {
    const dog = new ViewfinderWatchdog(0);
    run(dog, VIEWFINDER.watchdog.warmupSeconds, TARGET);
    run(dog, 2.5, 20);
    run(dog, 12, TARGET * 1.05);
    expect(dog.rung).toBe(0);
  });
});

describe('cooldown', () => {
  it('cannot cascade two rungs inside the cooldown', () => {
    const dog = new ViewfinderWatchdog(0);
    run(dog, VIEWFINDER.watchdog.warmupSeconds, TARGET);
    run(dog, 2.5, 5);
    expect(dog.rung).toBe(1);
    run(dog, VIEWFINDER.watchdog.cooldownSeconds - 0.5, 5);
    expect(dog.rung).toBe(1);
  });
});

describe('the latch', () => {
  it('never returns to a rung that has failed twice', () => {
    const dog = new ViewfinderWatchdog(0);
    run(dog, VIEWFINDER.watchdog.warmupSeconds, TARGET);

    expect(until(dog, BAD)).toBe(1); // rung 0 fails once
    expect(until(dog, GOOD)).toBe(0); // and is given another try
    expect(until(dog, BAD)).toBe(1); // twice is a pattern: the floor is now 1

    run(dog, 40, GOOD);
    expect(dog.rung).toBe(1);
  });

  it('leaves a latched device one recovery rather than none', () => {
    // The latch spends a lifetime recovery on top of raising the floor, which
    // is deliberate — a machine that has cratered twice earns LESS benefit of
    // the doubt on the rungs above it. Less, not none: with the budget set to
    // the latch cost, one recovery plus one latch exhausted it outright and a
    // device that degraded, recovered and degraded again could never climb
    // back to its own floor.
    const dog = new ViewfinderWatchdog(0);
    run(dog, VIEWFINDER.watchdog.warmupSeconds, TARGET);

    expect(until(dog, BAD)).toBe(1);
    expect(until(dog, GOOD)).toBe(0);
    expect(until(dog, BAD)).toBe(1); // latched: floor 1, one recovery spent
    expect(until(dog, BAD)).toBe(2); // rung 1 fails too

    expect(until(dog, GOOD)).toBe(1); // and it can still climb back to the floor
  });
});

describe('the floor', () => {
  it('never descends past the last rung', () => {
    const dog = new ViewfinderWatchdog(0);
    run(dog, VIEWFINDER.watchdog.warmupSeconds, TARGET);
    run(dog, 60, 1);
    expect(dog.rung).toBe(VIEWFINDER.ladder.length - 1);
  });
});

describe('reset', () => {
  it('clears the observation window without forgetting the current rung', () => {
    const dog = new ViewfinderWatchdog(0);
    run(dog, VIEWFINDER.watchdog.warmupSeconds, TARGET);
    run(dog, 2.5, 20);
    expect(dog.rung).toBe(1);

    dog.reset();
    expect(dog.rung).toBe(1);
    run(dog, VIEWFINDER.watchdog.warmupSeconds + 1, TARGET);
    expect(dog.rung).toBe(1);
  });
});
