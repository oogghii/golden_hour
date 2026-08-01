import { describe, expect, it } from 'vitest';
import { VIEWFINDER } from '../core/Settings';
import { ViewfinderWatchdog } from './ViewfinderWatchdog';

const TARGET = 30;
const DT = 1 / 60;

/** Feeds `seconds` of steady frames achieving `rate` presented frames/sec. */
function run(dog: ViewfinderWatchdog, seconds: number, rate: number): void {
  for (let t = 0; t < seconds; t += DT) dog.update(DT, rate * DT, TARGET);
}

describe('warm-up', () => {
  it('refuses to degrade during the first second, however bad it looks', () => {
    const dog = new ViewfinderWatchdog(0);
    run(dog, VIEWFINDER.watchdog.warmupSeconds - 0.1, 5);
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
  it('stops trying a rung that has failed twice', () => {
    const dog = new ViewfinderWatchdog(0);
    run(dog, VIEWFINDER.watchdog.warmupSeconds, TARGET);
    for (let cycle = 0; cycle < 2; cycle++) {
      run(dog, 3, 20); // fail down
      run(dog, 12, TARGET * 1.05); // recover up
    }
    run(dog, 3, 20);
    const latched = dog.rung;
    run(dog, 20, TARGET * 1.05);
    expect(dog.rung).toBe(latched);
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
