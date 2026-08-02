import { describe, expect, it } from 'vitest';
import { PHOTOGRAPHY } from '../core/Settings';
import { GestureClassifier } from './GestureClassifier';

const DT = 1 / 60;
const SLOW = 120 * DT; // px per frame, well under the flick threshold
const FAST = 2000 * DT;

function move(g: GestureClassifier, pxPerFrame: number, frames: number): void {
  for (let i = 0; i < frames; i++) g.update(pxPerFrame, 0, DT);
}

function rest(g: GestureClassifier, frames: number): void {
  for (let i = 0; i < frames; i++) g.update(0, 0, DT);
}

describe('classification', () => {
  it('starts idle', () => {
    expect(new GestureClassifier().phase).toBe('idle');
  });

  it('routes a deliberate movement to the reticle', () => {
    const g = new GestureClassifier();
    move(g, SLOW, 5);
    expect(g.phase).toBe('reticle');
  });

  it('routes a flick to look', () => {
    const g = new GestureClassifier();
    move(g, FAST, 5);
    expect(g.phase).toBe('look');
  });

  it('catches a flick that ramps, within the two-sample window', () => {
    const g = new GestureClassifier();
    g.update(SLOW, 0, DT);   // soft first sample
    g.update(FAST, 0, DT);   // the real speed arrives
    expect(g.phase).toBe('look');
  });
});

describe('latching — the whole point of this module', () => {
  it('keeps a reticle gesture on the reticle however fast it later becomes', () => {
    const g = new GestureClassifier();
    move(g, SLOW, 4);   // classified and locked
    move(g, FAST, 20);  // would have been a flick
    expect(g.phase).toBe('reticle');
  });

  it('keeps a look gesture on look however slow it later becomes', () => {
    const g = new GestureClassifier();
    move(g, FAST, 4);
    move(g, SLOW, 20);
    expect(g.phase).toBe('look');
  });

  it('locks within two frames and never reclassifies after', () => {
    const g = new GestureClassifier();
    g.update(SLOW, 0, DT);
    g.update(SLOW, 0, DT);
    expect(g.locked).toBe(true);
    move(g, FAST, 10);
    expect(g.phase).toBe('reticle');
  });
});

describe('settling ends the gesture', () => {
  it('returns to idle after the settle window', () => {
    const g = new GestureClassifier();
    move(g, FAST, 4);
    rest(g, Math.ceil(PHOTOGRAPHY.reticle.settleSeconds / DT) + 2);
    expect(g.phase).toBe('idle');
  });

  it('does not end on a single slow frame mid-gesture', () => {
    const g = new GestureClassifier();
    move(g, SLOW, 4);
    g.update(0, 0, DT);
    expect(g.phase).toBe('reticle');
  });

  it('reclassifies freely once a new gesture begins', () => {
    const g = new GestureClassifier();
    move(g, SLOW, 4);
    rest(g, Math.ceil(PHOTOGRAPHY.reticle.settleSeconds / DT) + 2);
    move(g, FAST, 3);
    expect(g.phase).toBe('look');
  });
});
