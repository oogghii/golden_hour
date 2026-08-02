import { describe, expect, it } from 'vitest';
import { PHOTOGRAPHY } from '../../core/Settings';
import { CaptureSequence } from './CaptureSequence';

const DT = 1 / 60;
const C = PHOTOGRAPHY.capture;
const TOTAL =
  C.blackoutInSeconds +
  C.blackoutHoldSeconds +
  C.flashSeconds +
  C.reviewSeconds +
  C.returnSeconds;

interface Sample {
  phase: string;
  blackout: number;
  flash: number;
  photoMix: number;
  render: boolean;
}

/** Steps the sequence, collecting a sample per frame. */
function run(sequence: CaptureSequence, seconds: number): Sample[] {
  const samples: Sample[] = [];
  for (let t = 0; t < seconds; t += DT) {
    sequence.update(DT);
    samples.push({
      phase: sequence.phase,
      blackout: sequence.blackout,
      flash: sequence.flash,
      photoMix: sequence.photoMix,
      render: sequence.shouldRender,
    });
  }
  return samples;
}

describe('the capture sequence', () => {
  it('starts idle and stays there until it is started', () => {
    const sequence = new CaptureSequence();
    expect(sequence.phase).toBe('idle');
    expect(sequence.isBusy).toBe(false);
    run(sequence, 1);
    expect(sequence.phase).toBe('idle');
  });

  it('runs its phases in order and returns to idle', () => {
    const sequence = new CaptureSequence();
    sequence.start();
    const seen: string[] = [];
    for (const sample of run(sequence, TOTAL + 0.5)) {
      if (seen[seen.length - 1] !== sample.phase) seen.push(sample.phase);
    }
    expect(seen).toEqual(['blackout', 'hold', 'flash', 'review', 'return', 'idle']);
  });

  it('asks for exactly one render, on a fully black frame', () => {
    // The whole point of the animation: the capture render is the most
    // expensive frame in the sequence, and it must land where nothing is
    // visible. If this ever fails, the shutter has a visible stutter.
    const sequence = new CaptureSequence();
    sequence.start();
    const renderFrames = run(sequence, TOTAL + 0.5).filter((s) => s.render);
    expect(renderFrames).toHaveLength(1);
    expect(renderFrames[0]!.blackout).toBe(1);
  });

  it('never reveals the photograph while the screen is not black', () => {
    const sequence = new CaptureSequence();
    sequence.start();
    let previous = 0;
    for (const sample of run(sequence, TOTAL + 0.5)) {
      if (sample.photoMix > previous) expect(sample.blackout).toBe(1);
      previous = sample.photoMix;
    }
  });

  it('keeps every envelope inside 0..1', () => {
    const sequence = new CaptureSequence();
    sequence.start();
    for (const sample of run(sequence, TOTAL + 0.5)) {
      for (const value of [sample.blackout, sample.flash, sample.photoMix]) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });

  it('refuses to restart while it is already running', () => {
    const sequence = new CaptureSequence();
    expect(sequence.start()).toBe(true);
    run(sequence, 0.2);
    const phase = sequence.phase;
    expect(sequence.start()).toBe(false);
    expect(sequence.phase).toBe(phase);
  });

  it('still asks for its render when frames are far longer than a phase', () => {
    // A 4fps machine must not skip the render frame. One phase transition per
    // update, so the sequence stretches rather than dropping the capture and
    // leaving the review showing an empty target.
    const sequence = new CaptureSequence();
    sequence.start();
    let renders = 0;
    for (let i = 0; i < 60; i++) {
      sequence.update(0.25);
      if (sequence.shouldRender) {
        renders++;
        expect(sequence.blackout).toBe(1);
      }
    }
    expect(renders).toBe(1);
  });

  it('comes to rest when cancelled', () => {
    const sequence = new CaptureSequence();
    sequence.start();
    run(sequence, 0.3);
    sequence.cancel();
    expect(sequence.phase).toBe('idle');
    expect(sequence.isBusy).toBe(false);
    expect(sequence.blackout).toBe(0);
    expect(sequence.flash).toBe(0);
    expect(sequence.photoMix).toBe(0);
  });
});
