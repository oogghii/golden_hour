# Photo Capture and the Album — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pressing the shutter takes a real photograph of what the viewfinder is showing, plays a mechanical SLR capture animation, stores it, and lets the player browse the roll on the camera's rear screen.

**Architecture:** A dedicated high-resolution render through the viewfinder's own camera, developed through gain → ACES → sRGB into an 8-bit target. The review shows that target's texture directly, so nothing on screen ever waits on storage. A pure timing state machine drives the animation and tells the renderer the one frame on which it may draw. Photos persist in IndexedDB and are decoded back one at a time for the album.

**Tech Stack:** TypeScript, three.js 0.185, Vite, vitest. No new dependencies.

## Global Constraints

Copied from `docs/superpowers/specs/2026-08-02-photo-capture-design.md` §"Constraints that must survive". Every task's requirements implicitly include these.

- **Nothing is added to the DOM.** `src/ui/Boot.ts` stays the only HTML in the project. IndexedDB is not DOM and is allowed.
- **`src/player/Player.ts` and `src/player/FirstPersonCamera.ts` are not modified.** Not one line.
- **Colour happens in exactly one place.** `ACES_GLSL` has one definition in `src/render/shaders/composite.glsl.ts`. The develop pass imports it. Never copy it.
- **A dropped photo must never break the game.** Every storage failure degrades to "you still saw the picture, it just was not kept".
- **Do not retune the sky, grass, lighting, post-processing or movement constants.**
- Every new tunable value goes in `src/core/Settings.ts`, never inline in a module.
- `npm test`, `npx tsc --noEmit` and `npm run build` must be clean at the end of every task.

## File structure

```
CREATE  src/photography/capture/CaptureSequence.ts    animation timeline. No three. TESTED
CREATE  src/photography/capture/CaptureSequence.test.ts
CREATE  src/photography/capture/photoRecord.ts        stored-record shaping. No three. TESTED
CREATE  src/photography/capture/photoRecord.test.ts
CREATE  src/photography/capture/PhotoLibrary.ts       IndexedDB. No three. Thin, untested
CREATE  src/photography/capture/developMaterial.ts    gain -> ACES -> sRGB. three
CREATE  src/photography/capture/PhotoCapture.ts       System. Targets, render, readback
CREATE  src/photography/capture/AlbumState.ts         album cursor. No three. TESTED
CREATE  src/photography/capture/AlbumState.test.ts
CREATE  src/photography/capture/AlbumView.ts          System. Decodes the shown photo
MODIFY  src/core/Settings.ts                          PHOTOGRAPHY.capture, PHOTOGRAPHY.album
MODIFY  src/photography/PhotoState.ts                 screenMode field
MODIFY  src/photography/CameraActions.ts              toggleAlbum, flipAlbum
MODIFY  src/photography/PhotographyMode.ts            album state, gating, capture hook
MODIFY  src/photography/CameraInteraction.ts          status zone opens the album
MODIFY  src/photography/input/PhotoDesktopInput.ts    arrows, wheel and Esc in the album
MODIFY  src/player/input/TouchInput.ts                swipe in the album
MODIFY  src/camera/Viewfinder.ts                      prepareCameraForCapture()
MODIFY  src/camera/LiveCameraScreen.ts                setPhoto, setCapture
MODIFY  src/camera/screenMaterial.ts                  uPhoto, uPhotoMix, uBlackout, uFlash
MODIFY  src/camera/ScreenUI.ts                        album chrome
MODIFY  src/render/shaders/composite.glsl.ts          export SRGB_GLSL
MODIFY  src/main.ts                                   wiring
MODIFY  docs/ARCHITECTURE.md, docs/DECISIONS.md, docs/STATUS.md, docs/HANDOFF.md
```

**One deviation from the spec's module map:** the spec lists six modules; this plan adds a seventh, `AlbumView`. Loading and decoding the photograph being browsed is a different job from capturing one, and folding it into `PhotoCapture` would give that class two reasons to change.

**`uPhoto` has two writers, and they are mutually exclusive by construction.** `PhotoCapture` writes it while `CaptureSequence.isBusy`; `AlbumView` writes it while `screenMode === 'album'`. The shutter no-ops while the album is open (Task 9) and the album cannot be opened mid-sequence (Task 9), so the two states cannot overlap. `AlbumView` is registered after `PhotoCapture`.

---

# Phase A — the photograph

Tasks 1–8. At the end of Phase A the shutter takes a photograph, the animation plays, and the image is written to storage. Nothing reads it back yet.

## Task 1: Settings and the screen mode

**Files:**
- Modify: `src/core/Settings.ts`
- Modify: `src/photography/PhotoState.ts`

**Interfaces:**
- Produces: `PHOTOGRAPHY.capture`, `PHOTOGRAPHY.album`, `PhotoState.screenMode`, `ScreenMode`

- [ ] **Step 1: Add the settings blocks**

In `src/core/Settings.ts`, inside the `PHOTOGRAPHY` object, after the `focus` block:

```ts
  /**
   * The photograph itself. `resolution` is 3:2, matching both the 36x24mm frame
   * the focal lengths are computed against and the rear screen it is reviewed
   * on, so a capture is never letterboxed or stretched.
   */
  capture: {
    resolution: {
      high: [1620, 1080],
      medium: [1200, 800],
      low: [900, 600],
    },
    /** ~400kB at 1620x1080. PNG would be ~4MB, and a 248-shot roll of those is a quarter of a gigabyte. */
    jpegQuality: 0.92,
    /**
     * Seconds. The mirror slamming up. The capture render fires the moment this
     * reaches full, so it is the budget for hiding the most expensive frame in
     * the sequence — do not shorten it without re-checking that.
     */
    blackoutInSeconds: 0.05,
    /** How long the frame stays fully black. This is where the render happens. */
    blackoutHoldSeconds: 0.04,
    /** The black lifting, and the edge flash riding on top of it. */
    flashSeconds: 0.06,
    /** How long the photograph is held before the live feed returns. */
    reviewSeconds: 0.95,
    returnSeconds: 0.2,
  },
  album: {
    /** Cross-fade between photographs. */
    fadeSeconds: 0.18,
  },
```

- [ ] **Step 2: Add the screen mode to PhotoState**

In `src/photography/PhotoState.ts`, add above `PhotoState`:

```ts
/** What the rear screen is showing. */
export type ScreenMode = 'live' | 'review' | 'album';
```

Add to the `PhotoState` interface, after `mode`:

```ts
  screenMode: ScreenMode;
```

Add to `createPhotoState`'s returned object, after `mode: 'A',`:

```ts
    screenMode: 'live',
```

- [ ] **Step 3: Typecheck and commit**

```bash
npx tsc --noEmit
npm test
git add src/core/Settings.ts src/photography/PhotoState.ts
git commit -m "Settings and screen mode for photo capture"
```

---

## Task 2: CaptureSequence

The module that must not be wrong: a stuck sequence locks the rear screen, and a
mistimed one puts the capture render on a visible frame.

**Files:**
- Create: `src/photography/capture/CaptureSequence.ts`
- Create: `src/photography/capture/CaptureSequence.test.ts`

**Interfaces:**
- Consumes: `PHOTOGRAPHY.capture` (Task 1)
- Produces:

```ts
export type CapturePhase = 'idle' | 'blackout' | 'hold' | 'flash' | 'review' | 'return';
export class CaptureSequence {
  get phase(): CapturePhase;
  get blackout(): number;    // 0..1
  get flash(): number;       // 0..1
  get photoMix(): number;    // 0..1
  get isBusy(): boolean;
  get shouldRender(): boolean;   // true for exactly one update per sequence
  start(): boolean;
  update(dt: number): void;
  cancel(): void;
}
```

**Note on `hold`:** the spec's timeline names four phases; this splits the blackout
into `blackout` (the ramp) and `hold` (fully black). The split is what makes the
render frame addressable — `shouldRender` fires on the `blackout -> hold`
transition, where `blackout` is exactly `1` by construction rather than by
arithmetic that a long frame could skip past.

- [ ] **Step 1: Write the failing test**

Create `src/photography/capture/CaptureSequence.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { PHOTOGRAPHY } from '../../core/Settings';
import { CaptureSequence } from './CaptureSequence';

const DT = 1 / 60;
const C = PHOTOGRAPHY.capture;
const TOTAL =
  C.blackoutInSeconds + C.blackoutHoldSeconds + C.flashSeconds +
  C.reviewSeconds + C.returnSeconds;

/** Steps the sequence, collecting a sample per frame. */
function run(sequence: CaptureSequence, seconds: number) {
  const samples: { phase: string; blackout: number; flash: number; photoMix: number; render: boolean }[] = [];
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
    const samples = run(sequence, TOTAL + 0.5);
    const renderFrames = samples.filter((s) => s.render);
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
    // A 10fps machine must not skip the render frame. One phase transition per
    // update, so the sequence stretches rather than dropping the capture.
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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/photography/capture/CaptureSequence.test.ts
```

Expected: FAIL, cannot resolve `./CaptureSequence`.

- [ ] **Step 3: Implement CaptureSequence**

Create `src/photography/capture/CaptureSequence.ts`:

```ts
import { PHOTOGRAPHY } from '../../core/Settings';
import { saturate } from '../../util/math';

export type CapturePhase = 'idle' | 'blackout' | 'hold' | 'flash' | 'review' | 'return';

/**
 * The shutter, as pure timing. No three, no renderer, no state beyond a phase
 * and a clock — so the one property that matters can actually be asserted:
 * the capture render happens on a frame the player cannot see.
 *
 * Phases advance one per update and carry their overshoot forward. A machine
 * slow enough to step past a whole phase in one frame therefore stretches the
 * sequence rather than skipping the render, which would leave the review
 * showing an empty target.
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

  /** A quick spike as the black lifts: a third of the window up, two thirds down. */
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
          // Fires here, not in `hold`'s body, so it lands on the same update
          // the phase becomes fully black rather than the one after it.
          if (!this.rendered) {
            this.rendered = true;
            this.renderFrame = true;
          }
        }
        break;
      case 'hold':
        if (this.timer >= config.blackoutHoldSeconds) this.advance(config.blackoutHoldSeconds, 'flash');
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
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run src/photography/capture/CaptureSequence.test.ts
```

Expected: all 8 pass. If "runs its phases in order" fails with a missing `idle`
at the end, the `return` phase is not calling `cancel()`.

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/photography/capture/CaptureSequence.ts src/photography/capture/CaptureSequence.test.ts
git commit -m "CaptureSequence: the shutter as pure timing, with the render frame pinned to full black"
```

---

## Task 3: photoRecord

**Files:**
- Create: `src/photography/capture/photoRecord.ts`
- Create: `src/photography/capture/photoRecord.test.ts`

**Interfaces:**
- Consumes: `PhotoState`, the formatters in `src/photography/ExposureModel.ts`
- Produces:

```ts
export interface PhotoMetadata {
  takenAt: number;
  focalMm: number;
  aperture: string;
  shutterSpeed: string;
  iso: string;
  focusDistance: string;
}
export interface PhotoRecord extends PhotoMetadata { id: number; blob: Blob; }
export function photoMetadataFrom(state: PhotoState, takenAt: number): PhotoMetadata;
```

- [ ] **Step 1: Write the failing test**

Create `src/photography/capture/photoRecord.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { APERTURES, ISOS } from '../ExposureModel';
import { createPhotoState } from '../PhotoState';
import { photoMetadataFrom } from './photoRecord';

describe('the stored record', () => {
  it('keeps what the display was reading at the shutter', () => {
    const state = createPhotoState(36);
    state.apertureIndex = APERTURES.indexOf(2.8);
    state.isoIndex = ISOS.indexOf(400);
    state.focusDistance = 3.24;

    const record = photoMetadataFrom(state, 1_700_000_000_000);

    expect(record).toMatchObject({
      takenAt: 1_700_000_000_000,
      focalMm: 36,
      aperture: 'F2.8',
      iso: 'ISO 400',
      focusDistance: '3.2 m',
    });
    expect(record.shutterSpeed).toMatch(/^1\//);
  });

  it('stores the infinity mark rather than a number that is not one', () => {
    const state = createPhotoState(36);
    state.focusDistance = Infinity;
    expect(photoMetadataFrom(state, 0).focusDistance).toBe('∞');
  });

  it('rounds the focal length the way the display does', () => {
    const state = createPhotoState(36);
    state.focalMm = 84.6;
    expect(photoMetadataFrom(state, 0).focalMm).toBe(85);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/photography/capture/photoRecord.test.ts
```

Expected: FAIL, cannot resolve `./photoRecord`.

- [ ] **Step 3: Implement photoRecord**

Create `src/photography/capture/photoRecord.ts`:

```ts
import {
  formatAperture,
  formatFocusDistance,
  formatIso,
  formatShutter,
} from '../ExposureModel';
import type { PhotoState } from '../PhotoState';

/**
 * What the album shows underneath a photograph.
 *
 * Formatted strings rather than ladder indices, deliberately: the album must
 * show what the display showed at the moment of the shot, and retuning a ladder
 * later must not silently rewrite the history of what was taken.
 */
export interface PhotoMetadata {
  /** Epoch ms. */
  takenAt: number;
  focalMm: number;
  aperture: string;
  shutterSpeed: string;
  iso: string;
  focusDistance: string;
}

export interface PhotoRecord extends PhotoMetadata {
  id: number;
  blob: Blob;
}

export function photoMetadataFrom(state: PhotoState, takenAt: number): PhotoMetadata {
  return {
    takenAt,
    focalMm: Math.round(state.focalMm),
    aperture: formatAperture(state),
    shutterSpeed: formatShutter(state),
    iso: formatIso(state),
    focusDistance: formatFocusDistance(state),
  };
}
```

- [ ] **Step 4: Run the tests, typecheck and commit**

```bash
npx vitest run src/photography/capture/photoRecord.test.ts
npx tsc --noEmit
git add src/photography/capture/photoRecord.ts src/photography/capture/photoRecord.test.ts
git commit -m "photoRecord: a photograph remembers what the display read when it was taken"
```

---

## Task 4: PhotoLibrary

**Files:**
- Create: `src/photography/capture/PhotoLibrary.ts`

**Interfaces:**
- Consumes: `PhotoMetadata`, `PhotoRecord` (Task 3)
- Produces:

```ts
export type LibraryStatus = 'opening' | 'ready' | 'unavailable' | 'full';
export class PhotoLibrary {
  get status(): LibraryStatus;
  open(): Promise<void>;
  put(metadata: PhotoMetadata, blob: Blob): Promise<number | null>;
  listIds(): Promise<number[]>;
  get(id: number): Promise<PhotoRecord | null>;
}
```

No test: this is an IndexedDB transcription with no logic of its own, and testing
it would mean adding `fake-indexeddb` to assert that IndexedDB is IndexedDB.
Everything with a decision in it lives in `photoRecord` and `AlbumState`, both tested.

- [ ] **Step 1: Implement PhotoLibrary**

Create `src/photography/capture/PhotoLibrary.ts`:

```ts
import type { PhotoMetadata, PhotoRecord } from './photoRecord';

const DB_NAME = 'golden-hour';
const STORE = 'photos';
const VERSION = 1;

export type LibraryStatus = 'opening' | 'ready' | 'unavailable' | 'full';

/** Promisifies an IDBRequest, which is otherwise pure event plumbing. */
function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

/**
 * The card. Every method resolves rather than throwing: a browser in private
 * mode, a disabled store or a full quota must cost the player a saved
 * photograph, never a working camera.
 */
export class PhotoLibrary {
  private db: IDBDatabase | null = null;
  private state: LibraryStatus = 'opening';

  get status(): LibraryStatus {
    return this.state;
  }

  async open(): Promise<void> {
    if (typeof indexedDB === 'undefined') {
      this.state = 'unavailable';
      return;
    }
    try {
      this.db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, VERSION);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains(STORE)) {
            request.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
        request.onblocked = () => reject(new Error('IndexedDB open blocked'));
      });
      this.state = 'ready';
    } catch {
      this.state = 'unavailable';
    }
  }

  /** Returns the new id, or null if the photograph could not be kept. */
  async put(metadata: PhotoMetadata, blob: Blob): Promise<number | null> {
    const db = this.db;
    if (!db || this.state !== 'ready') return null;
    try {
      const transaction = db.transaction(STORE, 'readwrite');
      const id = await promisify(transaction.objectStore(STORE).add({ ...metadata, blob }));
      return typeof id === 'number' ? id : null;
    } catch (error) {
      // A full card is a state the camera reports, not an error it throws.
      if (error instanceof DOMException && error.name === 'QuotaExceededError') {
        this.state = 'full';
      }
      return null;
    }
  }

  /** Oldest first, which is the order the roll was shot in. */
  async listIds(): Promise<number[]> {
    const db = this.db;
    if (!db || this.state === 'unavailable') return [];
    try {
      const transaction = db.transaction(STORE, 'readonly');
      const keys = await promisify(transaction.objectStore(STORE).getAllKeys());
      return keys.filter((key): key is number => typeof key === 'number');
    } catch {
      return [];
    }
  }

  async get(id: number): Promise<PhotoRecord | null> {
    const db = this.db;
    if (!db || this.state === 'unavailable') return null;
    try {
      const transaction = db.transaction(STORE, 'readonly');
      const record = await promisify<PhotoRecord | undefined>(
        transaction.objectStore(STORE).get(id),
      );
      return record ?? null;
    } catch {
      return null;
    }
  }
}
```

- [ ] **Step 2: Typecheck and commit**

```bash
npx tsc --noEmit
npm test
git add src/photography/capture/PhotoLibrary.ts
git commit -m "PhotoLibrary: the card, where every failure is a state and never a throw"
```

---

## Task 5: The develop pass

**Files:**
- Modify: `src/render/shaders/composite.glsl.ts`
- Create: `src/photography/capture/developMaterial.ts`

**Interfaces:**
- Consumes: `ACES_GLSL` from `src/render/shaders/composite.glsl`
- Produces: `SRGB_GLSL` export; `createDevelopMaterial(): THREE.ShaderMaterial` with uniforms `uSource`, `uGain`

- [ ] **Step 1: Export the sRGB encode alongside the ACES curve**

Read `src/render/shaders/composite.glsl.ts` first. It already exports `ACES_GLSL`
and interpolates it into `compositeFragment`. `linearToSrgb` currently lives
inline inside `compositeFragment`'s template string. Give it the same treatment:
lift it to an exported constant next to `ACES_GLSL`,

```ts
/**
 * Exported for the same reason `ACES_GLSL` is: the develop pass encodes captured
 * photographs with the exact same curve rather than a second copy that could drift.
 */
export const SRGB_GLSL = /* glsl */ `
vec3 linearToSrgb(vec3 c) {
  vec3 low = c * 12.92;
  vec3 high = 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
  return mix(low, high, step(vec3(0.0031308), c));
}
`;
```

and replace the inline definition inside `compositeFragment` with `${SRGB_GLSL}`,
placed exactly where the old function body sat so the composite is byte-identical
in behaviour.

- [ ] **Step 2: Create the develop material**

Create `src/photography/capture/developMaterial.ts`:

```ts
import * as THREE from 'three';
import { ACES_GLSL, SRGB_GLSL } from '../../render/shaders/composite.glsl';

const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * Turns the linear HDR capture into a photograph.
 *
 * Gain first, because the exposure model is the whole point of the camera: shoot
 * at f/22 and the picture is dark. Then the same ACES curve the rest of the
 * project grades with, then sRGB.
 *
 * Deliberately absent: the LCD black lift and desaturation, the grid, the
 * reticle, the focus frame and the glass vignette. Those are `screenMaterial`
 * simulating a display. A photograph is the image, not a picture of the screen
 * that was showing it.
 */
const FRAGMENT = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uSource;
uniform float uGain;

${ACES_GLSL}
${SRGB_GLSL}

void main() {
  vec3 linear = texture2D(uSource, vUv).rgb * uGain;
  gl_FragColor = vec4(linearToSrgb(acesFilmic(linear)), 1.0);
}
`;

export function createDevelopMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms: { uSource: { value: null }, uGain: { value: 1 } },
    depthTest: false,
    depthWrite: false,
  });
}
```

- [ ] **Step 3: Verify the composite is unchanged**

```bash
npx tsc --noEmit
npm test
npm run build
```

Then open the preview and confirm the world looks exactly as before — Step 1
touched the main composite shader, so a mistake there changes the whole image,
not just the photograph. If the scene has shifted in brightness or gamma, the
`${SRGB_GLSL}` interpolation landed in the wrong place.

- [ ] **Step 4: Commit**

```bash
git add src/render/shaders/composite.glsl.ts src/photography/capture/developMaterial.ts
git commit -m "Develop pass: gain, ACES and sRGB, sharing both curves with the composite"
```

---

## Task 6: Viewfinder exposes its camera

**Files:**
- Modify: `src/camera/Viewfinder.ts`

**Interfaces:**
- Produces: `Viewfinder.prepareCameraForCapture(): THREE.PerspectiveCamera | null`

- [ ] **Step 1: Add the accessor**

`Viewfinder` already has a private `placeCamera(model)` and a private `camera`.
Add, after `get texture()`:

```ts
  /**
   * Places the lens camera for this frame and returns it.
   *
   * Exposed so a capture photographs precisely what the viewfinder is showing.
   * Reconstructing the pose a third time — `CameraInteraction` already does it
   * once for the focus ray — would let the photograph drift from the frame the
   * player actually composed. Placing it here rather than relying on the
   * viewfinder's own update having run makes the call order-independent.
   */
  prepareCameraForCapture(): THREE.PerspectiveCamera | null {
    const model = this.floating.object;
    if (!model) return null;
    this.placeCamera(model);
    return this.camera;
  }
```

- [ ] **Step 2: Typecheck and commit**

```bash
npx tsc --noEmit
npm test
git add src/camera/Viewfinder.ts
git commit -m "Viewfinder: expose the placed lens camera so a capture matches the frame"
```

---

## Task 7: The screen shows a photograph

**Files:**
- Modify: `src/camera/screenMaterial.ts`
- Modify: `src/camera/LiveCameraScreen.ts`

**Interfaces:**
- Produces: uniforms `uPhoto`, `uPhotoMix`, `uBlackout`, `uFlash`;
  `LiveCameraScreen.setPhoto(texture: THREE.Texture | null): void` and
  `LiveCameraScreen.setCapture(photoMix: number, blackout: number, flash: number): void`

- [ ] **Step 1: Add the uniforms to the material**

In `src/camera/screenMaterial.ts`, add to the uniform declarations in `FRAGMENT`,
after `uniform float uFrozen;`:

```glsl
uniform sampler2D uPhoto;
uniform float uPhotoMix;   // 0 live feed, 1 photograph
uniform float uBlackout;   // the mirror
uniform float uFlash;
```

Add to the `uniforms` object in `createScreenMaterial`, after `uFrozen`:

```ts
      uPhoto: { value: null },
      uPhotoMix: { value: 0 },
      uBlackout: { value: 0 },
      uFlash: { value: 0 },
```

- [ ] **Step 2: Blend the photograph in and gate the live furniture**

In `main()`, immediately after the existing `feed` block ends with
`feed *= mix(1.0, uFrozenDim, uFrozen);`, replace `vec3 color = feed;` with:

```glsl
  // The photograph is already developed — gain, ACES and sRGB happened in the
  // capture pass — so it is mixed in AFTER the feed's own grade rather than
  // through it. Grading it twice would darken every review.
  vec3 shot = texture2D(uPhoto, vUv).rgb;
  vec3 color = mix(feed, shot, uPhotoMix);

  // Everything below is the viewfinder's furniture, and a photograph is never
  // shown with viewfinder markings on it.
  float live = 1.0 - uPhotoMix;
```

Then multiply the existing overlay contributions by `live`:

- rule of thirds: `clamp(grid, 0.0, 1.0) * uGridOpacity * live`
- hover wash: `hover * mix(0.08, 0.18, uPressed) * live`
- focus frame: `focus * 0.95 * live`
- level indicator: `span * line(rotated, 0.0, 0.004) * 0.6 * live`
- reticle ring: `ring * uReticleAlpha * live`

Leave the chrome (`uChrome`), the vignette and the corner sheen alone: `ScreenUI`
swaps its own content by mode, and the glass is a property of the display in
every mode.

- [ ] **Step 3: Add the mirror and the flash**

Immediately before the final `gl_FragColor` line, after the glass block:

```glsl
  // The mirror. Multiplied last so it takes the glass down with it: a blacked
  // out finder does not have a lit sheen floating on top of it.
  color *= 1.0 - uBlackout;

  // A hard inset line as the black lifts, the one moment the display is allowed
  // to be brighter than its own emissive ceiling.
  vec4 flashRect = vec4(0.045, 0.055, 0.955, 0.945);
  color += uPrimary * uFlash * rectOutline(vUv, flashRect, 0.012) * 1.6;
```

- [ ] **Step 4: Add the setters**

In `src/camera/LiveCameraScreen.ts`, after `setFrozen`:

```ts
  setPhoto(texture: THREE.Texture | null): void {
    this.material.uniforms.uPhoto!.value = texture;
  }

  /** The three capture envelopes, written together because they are one animation. */
  setCapture(photoMix: number, blackout: number, flash: number): void {
    this.material.uniforms.uPhotoMix!.value = photoMix;
    this.material.uniforms.uBlackout!.value = blackout;
    this.material.uniforms.uFlash!.value = flash;
  }
```

- [ ] **Step 5: Verify the shader still compiles**

```bash
npx tsc --noEmit
npm test
npm run build
```

Open the preview, raise the camera, and confirm the live view is unchanged — with
`uPhotoMix` at 0 and `uBlackout` at 0 every new term is inert, so anything that
looks different is a mistake in Step 2. Check the console for shader compile errors.

- [ ] **Step 6: Commit**

```bash
git add src/camera/screenMaterial.ts src/camera/LiveCameraScreen.ts
git commit -m "Screen material: a photograph, a mirror and a flash"
```

---

## Task 8: PhotoCapture, and the shutter that fires it

**Files:**
- Create: `src/photography/capture/PhotoCapture.ts`
- Modify: `src/photography/PhotographyMode.ts`
- Modify: `src/main.ts`

**Interfaces:**
- Consumes: `CaptureSequence` (Task 2), `photoMetadataFrom` (Task 3), `PhotoLibrary` (Task 4), `createDevelopMaterial` (Task 5), `Viewfinder.prepareCameraForCapture` (Task 6), `LiveCameraScreen.setPhoto`/`setCapture` (Task 7)
- Produces: `class PhotoCapture implements System`

- [ ] **Step 1: Create PhotoCapture**

Create `src/photography/capture/PhotoCapture.ts`:

```ts
import * as THREE from 'three';
import type { Viewfinder } from '../../camera/Viewfinder';
import type { LiveCameraScreen } from '../../camera/LiveCameraScreen';
import { PHOTOGRAPHY } from '../../core/Settings';
import type { EngineContext, System } from '../../core/System';
import { viewfinderGain } from '../ExposureModel';
import type { PhotographyMode } from '../PhotographyMode';
import { touch } from '../PhotoState';
import { CaptureSequence } from './CaptureSequence';
import { createDevelopMaterial } from './developMaterial';
import type { PhotoLibrary } from './PhotoLibrary';
import { photoMetadataFrom } from './photoRecord';

/**
 * Takes the photograph.
 *
 * The expensive frame — a full-resolution scene render plus the develop pass —
 * fires only when `CaptureSequence` says the screen is fully black, which is
 * what the blackout exists for. Everything after that is off the critical path:
 * the review reads the developed target straight off the GPU, so nothing the
 * player sees ever waits on an encode or a database.
 */
export class PhotoCapture implements System {
  private readonly sequence = new CaptureSequence();
  private readonly quadScene = new THREE.Scene();
  private readonly quadCamera = new THREE.Camera();
  private readonly develop = createDevelopMaterial();
  private readonly quad: THREE.Mesh;

  private captureTarget: THREE.WebGLRenderTarget | null = null;
  private photoTarget: THREE.WebGLRenderTarget | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private size: readonly [number, number] = [1620, 1080];

  constructor(
    private readonly viewfinder: Viewfinder,
    private readonly photography: PhotographyMode,
    private readonly screen: LiveCameraScreen,
    private readonly library: PhotoLibrary,
  ) {
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.develop);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  init(ctx: EngineContext): void {
    this.renderer = ctx.renderer;
    this.scene = ctx.scene;
    this.size = PHOTOGRAPHY.capture.resolution[ctx.quality.tier];
    const [width, height] = this.size;

    this.captureTarget = new THREE.WebGLRenderTarget(width, height, {
      type: THREE.HalfFloatType,
      depthBuffer: true,
      stencilBuffer: false,
      colorSpace: THREE.LinearSRGBColorSpace,
    });
    // 8-bit and already sRGB: readable by readRenderTargetPixels, and exactly
    // the bytes the encoder wants.
    this.photoTarget = new THREE.WebGLRenderTarget(width, height, {
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false,
      colorSpace: THREE.NoColorSpace,
    });

    // Subscribing here is what Phase 11 left undone: shutter() has always called
    // this hook, and until now nothing was listening.
    this.photography.onCapture = () => this.begin();
  }

  /** Returns false when the mirror is already up, so a second press does nothing. */
  private begin(): boolean {
    if (!this.sequence.start()) return false;
    this.photography.state.screenMode = 'review';
    touch(this.photography.state);
    return true;
  }

  update(dt: number): void {
    // Lowering the camera abandons a review in flight rather than leaving the
    // screen black on the way down.
    if (this.sequence.isBusy && !this.photography.pose.isRaised) {
      this.sequence.cancel();
      this.finish();
      return;
    }

    const wasBusy = this.sequence.isBusy;
    this.sequence.update(dt);
    if (this.sequence.shouldRender) this.capture();

    if (this.sequence.isBusy) {
      this.screen.setCapture(this.sequence.photoMix, this.sequence.blackout, this.sequence.flash);
    } else if (wasBusy) {
      this.finish();
    }
  }

  private finish(): void {
    this.screen.setCapture(0, 0, 0);
    if (this.photography.state.screenMode === 'review') {
      this.photography.state.screenMode = 'live';
      touch(this.photography.state);
    }
  }

  /** The one expensive frame, taken while the screen is fully black. */
  private capture(): void {
    const renderer = this.renderer;
    const scene = this.scene;
    const camera = this.viewfinder.prepareCameraForCapture();
    const captureTarget = this.captureTarget;
    const photoTarget = this.photoTarget;
    if (!renderer || !scene || !camera || !captureTarget || !photoTarget) return;

    renderer.setRenderTarget(captureTarget);
    renderer.clear();
    renderer.render(scene, camera);

    this.develop.uniforms.uSource!.value = captureTarget.texture;
    this.develop.uniforms.uGain!.value = viewfinderGain(this.photography.state);
    renderer.setRenderTarget(photoTarget);
    renderer.render(this.quadScene, this.quadCamera);
    renderer.setRenderTarget(null);

    this.screen.setPhoto(photoTarget.texture);
    void this.store(photoTarget);
  }

  /**
   * Everything here is allowed to fail. The player has already seen the
   * photograph; this is only about keeping it.
   */
  private async store(target: THREE.WebGLRenderTarget): Promise<void> {
    const renderer = this.renderer;
    if (!renderer) return;
    const [width, height] = this.size;
    const metadata = photoMetadataFrom(this.photography.state, Date.now());

    try {
      const pixels = new Uint8Array(width * height * 4);
      await renderer.readRenderTargetPixelsAsync(target, 0, 0, width, height, pixels);

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      // WebGL reads bottom-up; a canvas is top-down. Flipping by row here is
      // cheaper and simpler than a second GPU pass to do it.
      const image = ctx.createImageData(width, height);
      const stride = width * 4;
      for (let row = 0; row < height; row++) {
        const source = (height - 1 - row) * stride;
        image.data.set(pixels.subarray(source, source + stride), row * stride);
      }
      ctx.putImageData(image, 0, 0);

      const blob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve, 'image/jpeg', PHOTOGRAPHY.capture.jpegQuality);
      });
      if (blob) await this.library.put(metadata, blob);
    } catch (error) {
      if (import.meta.env.DEV) console.warn('Photo was shown but not stored:', error);
    }
  }

  dispose(): void {
    this.photography.onCapture = null;
    this.captureTarget?.dispose();
    this.photoTarget?.dispose();
    this.quad.geometry.dispose();
    this.develop.dispose();
  }
}
```

- [ ] **Step 2: Gate the shutter while a capture is running**

In `src/photography/PhotographyMode.ts`, `shutter()` currently always decrements.
It must not spend a frame of film on a press the sequence is going to refuse.
Replace the body with:

```ts
  shutter(phase: 'down' | 'up'): void {
    if (phase === 'down' || !this.pose.isRaised) return;
    if (this.state.remainingShots <= 0) return;
    // The hook returns false when a capture is already running: the mirror is
    // up, and a press that takes no photograph must not cost a frame either.
    if (this.onCapture && this.onCapture() === false) return;
    this.state.remainingShots -= 1;
    touch(this.state);
  }
```

and widen the hook's type on the field declaration:

```ts
  /**
   * Set by PhotoCapture. Returns false if the press was refused — a capture is
   * already in flight — so the film counter is not spent on it.
   */
  onCapture: (() => boolean | void) | null = null;
```

- [ ] **Step 3: Wire it into main.ts**

In `src/main.ts`, add the imports:

```ts
import { PhotoCapture } from './photography/capture/PhotoCapture';
import { PhotoLibrary } from './photography/capture/PhotoLibrary';
```

After the `viewfinder` line, add:

```ts
// Opened in the background: a camera whose card is still mounting is still a
// working camera, so nothing waits on this.
const library = new PhotoLibrary();
void library.open();
engine.add(new PhotoCapture(viewfinder, photography, screen, library));
```

- [ ] **Step 4: Verify by hand**

```bash
npx tsc --noEmit
npm test
npm run build
```

In the preview: raise the camera, press `Space`. Expected — the screen slams to
black, a bright edge line flashes as it lifts, the photograph holds for about a
second, and the live feed returns. The frame counter drops by exactly one per
press. Hold `Space` down: the counter must not run away, because re-entry is
refused. Check `Application > IndexedDB > golden-hour > photos` in devtools and
confirm rows are accumulating with a blob and its settings.

Shoot one at f/2.8 and one at f/22 and confirm the second photograph is visibly
darker — that is the develop pass's gain, and it is the difference between the
exposure model being real and being decorative.

- [ ] **Step 5: Commit**

```bash
git add src/photography/capture/PhotoCapture.ts src/photography/PhotographyMode.ts src/main.ts
git commit -m "PhotoCapture: the shutter takes a photograph, and the blackout is what hides the cost"
```

---

# ⛔ Phase A gate

Stop here and look at it. The shutter should *feel* like a shutter, and that
judgement is easier now than after the album is layered on top. If the timing is
wrong, `PHOTOGRAPHY.capture` is the only place to change and no other code moves.

---

# Phase B — the album

## Task 9: AlbumState

**Files:**
- Create: `src/photography/capture/AlbumState.ts`
- Create: `src/photography/capture/AlbumState.test.ts`

**Interfaces:**
- Produces:

```ts
export class AlbumState {
  get isOpen(): boolean;
  get index(): number;
  get count(): number;
  get currentId(): number | null;
  setIds(ids: readonly number[]): void;
  open(): void;
  close(): void;
  flip(delta: number): boolean;
}
```

- [ ] **Step 1: Write the failing test**

Create `src/photography/capture/AlbumState.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { AlbumState } from './AlbumState';

function album(count: number): AlbumState {
  const state = new AlbumState();
  state.setIds(Array.from({ length: count }, (_unused, i) => i + 1));
  return state;
}

describe('the album cursor', () => {
  it('starts closed and showing nothing', () => {
    const state = new AlbumState();
    expect(state.isOpen).toBe(false);
    expect(state.currentId).toBe(null);
  });

  it('opens on the newest photograph, which is the one just taken', () => {
    const state = album(4);
    state.open();
    expect(state.isOpen).toBe(true);
    expect(state.currentId).toBe(4);
  });

  it('flips back and forward through the roll', () => {
    const state = album(4);
    state.open();
    expect(state.flip(-1)).toBe(true);
    expect(state.currentId).toBe(3);
    expect(state.flip(1)).toBe(true);
    expect(state.currentId).toBe(4);
  });

  it('stops at both ends rather than wrapping', () => {
    // Being thrown from the first photograph to the last is disorienting in a
    // container that has a real beginning.
    const state = album(3);
    state.open();
    expect(state.flip(1)).toBe(false);
    expect(state.currentId).toBe(3);
    state.flip(-1);
    state.flip(-1);
    expect(state.currentId).toBe(1);
    expect(state.flip(-1)).toBe(false);
    expect(state.currentId).toBe(1);
  });

  it('refuses to open an empty roll', () => {
    const state = new AlbumState();
    state.open();
    expect(state.isOpen).toBe(false);
  });

  it('holds its place when the roll grows underneath it', () => {
    const state = album(3);
    state.open();
    state.flip(-1);
    const showing = state.currentId;
    state.setIds([1, 2, 3, 4, 5]);
    expect(state.currentId).toBe(showing);
  });

  it('closes when the roll it was showing disappears', () => {
    const state = album(2);
    state.open();
    state.setIds([]);
    expect(state.isOpen).toBe(false);
    expect(state.currentId).toBe(null);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/photography/capture/AlbumState.test.ts
```

Expected: FAIL, cannot resolve `./AlbumState`.

- [ ] **Step 3: Implement AlbumState**

Create `src/photography/capture/AlbumState.ts`:

```ts
import { clamp } from '../../util/math';

/**
 * Where the player is in the roll. Pure, because the two rules worth having are
 * both invisible from a screenshot: the ends do not wrap, and a photograph taken
 * while the album is open must not shuffle the one being looked at.
 */
export class AlbumState {
  private ids: readonly number[] = [];
  private cursor = 0;
  private open_ = false;

  get isOpen(): boolean {
    return this.open_;
  }

  get index(): number {
    return this.cursor;
  }

  get count(): number {
    return this.ids.length;
  }

  get currentId(): number | null {
    return this.open_ ? (this.ids[this.cursor] ?? null) : null;
  }

  /**
   * Identity is by id, not by position: a new photograph appended while the
   * album is open must not slide the one being looked at out from under it.
   */
  setIds(ids: readonly number[]): void {
    const showing = this.ids[this.cursor];
    this.ids = [...ids];
    if (this.ids.length === 0) {
      this.cursor = 0;
      this.open_ = false;
      return;
    }
    const found = showing === undefined ? -1 : this.ids.indexOf(showing);
    this.cursor = found >= 0 ? found : clamp(this.cursor, 0, this.ids.length - 1);
  }

  /** Opens on the newest, which is what the player just shot. */
  open(): void {
    if (this.ids.length === 0) return;
    this.open_ = true;
    this.cursor = this.ids.length - 1;
  }

  close(): void {
    this.open_ = false;
  }

  /** Returns true only if the cursor actually moved. */
  flip(delta: number): boolean {
    if (!this.open_ || this.ids.length === 0) return false;
    const next = clamp(this.cursor + Math.trunc(delta), 0, this.ids.length - 1);
    if (next === this.cursor) return false;
    this.cursor = next;
    return true;
  }
}
```

- [ ] **Step 4: Run the tests, typecheck and commit**

```bash
npx vitest run src/photography/capture/AlbumState.test.ts
npx tsc --noEmit
git add src/photography/capture/AlbumState.ts src/photography/capture/AlbumState.test.ts
git commit -m "AlbumState: a cursor through the roll that does not wrap and does not lose its place"
```

---

## Task 10: The album as an action

**Files:**
- Modify: `src/photography/CameraActions.ts`
- Modify: `src/photography/PhotographyMode.ts`
- Modify: `src/photography/CameraInteraction.ts`

**Interfaces:**
- Consumes: `AlbumState` (Task 9)
- Produces: `CameraActions.toggleAlbum()`, `CameraActions.flipAlbum(delta)`, `PhotographyMode.album`

- [ ] **Step 1: Extend the action surface**

In `src/photography/CameraActions.ts`, add to the interface:

```ts
  /** Opens or closes the album on the rear screen. */
  toggleAlbum(): void;
  /** Steps through the album. `delta` is in photographs. */
  flipAlbum(delta: number): void;
```

- [ ] **Step 2: Implement them, and gate the live controls**

In `src/photography/PhotographyMode.ts`, import `AlbumState` and add the field:

```ts
  /** The roll, and where the player is in it. Ids are pushed in by AlbumView. */
  readonly album = new AlbumState();
```

Add the two actions:

```ts
  toggleAlbum(): void {
    if (!this.pose.isRaised) return;
    if (this.album.isOpen) {
      this.album.close();
      this.state.screenMode = 'live';
    } else {
      // Never over a capture in flight: the review owns the screen until it ends.
      if (this.state.screenMode !== 'live') return;
      this.album.open();
      if (!this.album.isOpen) return; // Nothing shot yet.
      this.state.screenMode = 'album';
      this.state.selected = null;
    }
    touch(this.state);
  }

  flipAlbum(delta: number): void {
    if (!this.album.isOpen || delta === 0) return;
    if (this.album.flip(delta)) touch(this.state);
  }
```

Gate the live controls while browsing. Add this guard as the first line of
`zoom`, `focus`, `selectSetting` and `changeSetting`:

```ts
    if (this.album.isOpen) return;
```

and in `shutter`, after the existing `pose.isRaised` check:

```ts
    if (this.album.isOpen) return;
```

Make `togglePhotographyMode` back out of the album first, so one press is one
level of undo:

```ts
  togglePhotographyMode(): void {
    // The album is a mode within the mode. Backing out of it should not also
    // put the camera down.
    if (this.pose.isRaised && this.album.isOpen) {
      this.toggleAlbum();
      return;
    }
    if (this.pose.isRaised) this.exitPhotographyMode();
    else this.enterPhotographyMode();
  }
```

and have `exitPhotographyMode` close the album so lowering never leaves it armed:

```ts
  exitPhotographyMode(): void {
    if (!this.pose.isRaised) return;
    this.pose.setRaised(false);
    this.album.close();
    this.state.screenMode = 'live';
    this.state.selected = null;
    touch(this.state);
  }
```

- [ ] **Step 3: Open the album from the status zone**

In `src/photography/CameraInteraction.ts`, `release()` currently falls through
zones whose `settingId` is null. Add, immediately before the final
`if (target.settingId !== null)` line:

```ts
    // The zone that draws how many frames are left is the natural way in to
    // looking at the ones already taken.
    if (target.id === 'status') {
      this.actions.toggleAlbum();
      return;
    }
```

- [ ] **Step 4: Typecheck, test and commit**

```bash
npx tsc --noEmit
npm test
git add src/photography/CameraActions.ts src/photography/PhotographyMode.ts src/photography/CameraInteraction.ts
git commit -m "The album as a mode: entered from the status zone, and one level of undo"
```

---

## Task 11: Album input

**Files:**
- Modify: `src/photography/input/PhotoDesktopInput.ts`
- Modify: `src/player/input/TouchInput.ts`

**Interfaces:**
- Consumes: `CameraActions.flipAlbum`, `CameraActions.toggleAlbum` (Task 10)

- [ ] **Step 1: Desktop bindings**

In `src/photography/input/PhotoDesktopInput.ts`, replace `onKeyDown` with:

```ts
  /** Optional accessibility and development alternatives only. */
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.photography.pose.isRaised) return;

    if (this.photography.album.isOpen) {
      if (event.code === 'ArrowLeft') this.photography.flipAlbum(-1);
      else if (event.code === 'ArrowRight') this.photography.flipAlbum(1);
      else if (event.code === 'Escape') this.photography.toggleAlbum();
      return;
    }

    if (event.code === 'BracketLeft') this.photography.changeSetting(-1);
    else if (event.code === 'BracketRight') this.photography.changeSetting(1);
    else if (event.code === 'Space') {
      // Space is the page's scroll key whenever focus is not on the locked
      // canvas. Firing the shutter and scrolling the document at the same time
      // is never what was meant.
      event.preventDefault();
      this.photography.shutter('up');
    }
  };
```

`Escape` also releases pointer lock, and `main.ts` already lowers the camera on
`pointerlockchange`. That is why the album is closed by `exitPhotographyMode` in
Task 10 — both paths converge on a camera that is down and an album that is shut.

In `onWheel`, send the wheel to the album while it is open:

```ts
  private readonly onWheel = (event: WheelEvent): void => {
    if (!this.photography.pose.isRaised) return;
    event.preventDefault();
    const notches = -Math.sign(event.deltaY);
    if (this.photography.album.isOpen) this.photography.flipAlbum(-notches);
    else this.interaction.wheel(notches);
  };
```

The sign is inverted for the album deliberately: scrolling down should advance
through the roll, the way it advances through a page.

- [ ] **Step 2: Touch swipe**

In `src/player/input/TouchInput.ts`, find the single-pointer move handler that
currently accumulates drag for adjustable zones. Add an album branch before it,
using the existing `TOUCH.dragPxPerStep` constant:

```ts
    if (this.photography.album.isOpen) {
      this.albumDrag += dx;
      const steps = Math.trunc(this.albumDrag / TOUCH.dragPxPerStep);
      if (steps !== 0) {
        this.albumDrag -= steps * TOUCH.dragPxPerStep;
        // Dragging left moves forward, the way a physical stack of prints does.
        this.photography.flipAlbum(-steps);
      }
      return;
    }
```

with `private albumDrag = 0;` declared alongside the other accumulators and reset
to `0` wherever a gesture begins.

- [ ] **Step 3: Typecheck, test and commit**

```bash
npx tsc --noEmit
npm test
git add src/photography/input/PhotoDesktopInput.ts src/player/input/TouchInput.ts
git commit -m "Album input: arrows, wheel and swipe"
```

---

## Task 12: AlbumView

**Files:**
- Create: `src/photography/capture/AlbumView.ts`
- Modify: `src/main.ts`

**Interfaces:**
- Consumes: `PhotoLibrary` (Task 4), `AlbumState` (Task 9), `LiveCameraScreen.setPhoto`/`setCapture` (Task 7)
- Produces: `class AlbumView implements System`

- [ ] **Step 1: Create AlbumView**

Create `src/photography/capture/AlbumView.ts`:

```ts
import * as THREE from 'three';
import type { LiveCameraScreen } from '../../camera/LiveCameraScreen';
import { PHOTOGRAPHY } from '../../core/Settings';
import type { System } from '../../core/System';
import { damp } from '../../util/math';
import type { PhotographyMode } from '../PhotographyMode';
import { touch } from '../PhotoState';
import type { PhotoLibrary } from './PhotoLibrary';

/**
 * Shows the photograph the player is currently looking at.
 *
 * One decoded texture at a time, so the album's memory cost does not grow with
 * the roll. Flips are absorbed rather than queued: the cursor moves immediately
 * and a decode that lands for a photograph the player has already moved past is
 * dropped, so holding an arrow key skates through the roll and settles wherever
 * it stopped instead of replaying a backlog.
 */
export class AlbumView implements System {
  private texture: THREE.Texture | null = null;
  private shownId: number | null = null;
  private pending: number | null = null;
  private fade = 0;
  private wasOpen = false;
  private known = -1;

  constructor(
    private readonly photography: PhotographyMode,
    private readonly screen: LiveCameraScreen,
    private readonly library: PhotoLibrary,
  ) {}

  update(dt: number): void {
    const album = this.photography.album;

    if (!album.isOpen) {
      if (this.wasOpen) this.leave();
      return;
    }

    if (!this.wasOpen) {
      this.wasOpen = true;
      this.fade = 0;
    }

    const wanted = album.currentId;
    if (wanted !== null && wanted !== this.shownId && wanted !== this.pending) {
      void this.load(wanted);
    }

    // Fades in only once a texture is actually up, so an empty frame is never
    // faded to.
    const target = this.texture !== null && this.shownId === wanted ? 1 : 0;
    this.fade = damp(this.fade, target, 1 / Math.max(PHOTOGRAPHY.album.fadeSeconds, 1e-3), dt);
    this.screen.setCapture(this.fade, 0, 0);
  }

  /** Called by main.ts once the card has been read, and after every capture. */
  async refresh(): Promise<void> {
    const ids = await this.library.listIds();
    if (ids.length === this.known) return;
    this.known = ids.length;
    this.photography.album.setIds(ids);
    touch(this.photography.state);
  }

  private async load(id: number): Promise<void> {
    this.pending = id;
    const record = await this.library.get(id);
    // The player may have flipped past this one while it was decoding.
    if (this.photography.album.currentId !== id) {
      if (this.pending === id) this.pending = null;
      return;
    }
    if (!record) {
      this.pending = null;
      return;
    }

    const bitmap = await createImageBitmap(record.blob);
    if (this.photography.album.currentId !== id) {
      bitmap.close();
      if (this.pending === id) this.pending = null;
      return;
    }

    this.texture?.dispose();
    // flipY stays at three's default `true`, and the two orientations differ:
    // `photoTarget.texture` in the review is already in GL row order, but this
    // JPEG was written from a canvas that `store()` row-flipped into top-down
    // order. Leaving the default is what makes an album photograph appear the
    // same way up as its own review. If album photos come out upside down
    // relative to the review, this line and the flip in `store()` disagree —
    // fix one of them, not both.
    const texture = new THREE.Texture(bitmap);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    this.texture = texture;
    this.shownId = id;
    this.pending = null;
    this.screen.setPhoto(texture);
  }

  private leave(): void {
    this.wasOpen = false;
    this.fade = 0;
    this.shownId = null;
    this.pending = null;
    this.screen.setCapture(0, 0, 0);
    this.screen.setPhoto(null);
    this.texture?.dispose();
    this.texture = null;
  }

  dispose(): void {
    this.texture?.dispose();
    this.texture = null;
  }
}
```

- [ ] **Step 2: Keep the roll current**

In `src/photography/capture/PhotoCapture.ts`, add an optional listener so a new
photograph shows up in the album without polling. Add the field and setter:

```ts
  /** Set by main.ts. Called after a photograph has been written to the card. */
  onStored: (() => void) | null = null;
```

and at the end of `store()`, inside the `try`, after `await this.library.put(...)`:

```ts
      this.onStored?.();
```

- [ ] **Step 3: Wire it into main.ts**

Replace the Task 8 wiring block in `src/main.ts` with:

```ts
const library = new PhotoLibrary();
const photoCapture = new PhotoCapture(viewfinder, photography, screen, library);
const albumView = new AlbumView(photography, screen, library);
// AlbumView after PhotoCapture: both write the screen's photo uniforms, and the
// two states are mutually exclusive, so the later writer wins in the one frame
// a transition straddles.
engine.add(photoCapture);
engine.add(albumView);
photoCapture.onStored = () => void albumView.refresh();
void library.open().then(() => albumView.refresh());
```

with the import added:

```ts
import { AlbumView } from './photography/capture/AlbumView';
```

- [ ] **Step 4: Typecheck, test and commit**

```bash
npx tsc --noEmit
npm test
git add src/photography/capture/AlbumView.ts src/photography/capture/PhotoCapture.ts src/main.ts
git commit -m "AlbumView: one decoded photograph at a time, and stale decodes dropped"
```

---

## Task 13: Album chrome

**Files:**
- Modify: `src/camera/ScreenUI.ts`
- Modify: `src/photography/PhotographyMode.ts`

**Interfaces:**
- Consumes: `PhotoState.screenMode` (Task 1), `AlbumState` (Task 9), `PhotoMetadata` (Task 3)
- Produces: album layout in `ScreenUI`

- [ ] **Step 1: Give ScreenUI the album's caption**

`ScreenUI.sync(state)` currently takes only `PhotoState`, and the album's caption
comes from the stored record rather than from live state. Add an optional second
argument rather than widening `PhotoState`, so a photograph's metadata never
becomes part of the camera's live state:

```ts
  /** The caption under the photograph being browsed. Null in live and review. */
  sync(state: PhotoState, caption: AlbumCaption | null = null): void {
    const key = state.revision + (caption ? `:${caption.index}/${caption.count}` : '');
    if (key === this.drawnKey) return;
    this.drawnKey = key;
    this.draw(state, caption);
    this.texture.needsUpdate = true;
  }
```

with `private drawnKey: string | number = -1;` replacing `drawnRevision`, and the
type exported from `ScreenUI.ts`:

```ts
export interface AlbumCaption {
  /** 1-based, for display. */
  index: number;
  count: number;
  takenAt: number;
  focalMm: number;
  aperture: string;
  shutterSpeed: string;
  iso: string;
  focusDistance: string;
}
```

- [ ] **Step 2: Draw the album layout**

In `draw`, branch on the mode:

```ts
  private draw(state: PhotoState, caption: AlbumCaption | null): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, WIDTH, HEIGHT);
    this.drawScrims();
    if (state.screenMode === 'album' && caption) {
      this.drawAlbumBars(caption);
      return;
    }
    if (state.screenMode === 'review') return; // The photograph, uninterrupted.
    this.drawTopBar(state);
    this.drawBottomBar(state);
    this.drawFocusDistance(state);
  }
```

and add:

```ts
  /**
   * The caption a print gets on the back: which frame it is, when it was taken,
   * and what it was taken at. Read from the stored record, so it is what the
   * camera was showing at the shutter rather than what it happens to read now.
   */
  private drawAlbumBars(caption: AlbumCaption): void {
    const ctx = this.ctx;
    const { primary, secondary } = PHOTOGRAPHY.screenUI;

    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillStyle = hex(primary);
    ctx.font = `600 26px ${FONT}`;
    ctx.fillText(`${caption.index} / ${caption.count}`, 32, 49);

    ctx.textAlign = 'right';
    ctx.fillStyle = hex(secondary);
    ctx.font = `19px ${FONT}`;
    ctx.fillText(new Date(caption.takenAt).toLocaleString(), WIDTH - 32, 49);

    const baseline = HEIGHT - 39;
    ctx.textAlign = 'left';
    ctx.fillStyle = hex(primary);
    ctx.font = `26px ${FONT}`;
    ctx.fillText(
      `${caption.focalMm}mm   ${caption.aperture}   ${caption.shutterSpeed}   ${caption.iso}`,
      32,
      baseline,
    );

    ctx.textAlign = 'right';
    ctx.fillStyle = hex(secondary);
    ctx.fillText(caption.focusDistance, WIDTH - 32, baseline);
  }
```

- [ ] **Step 3: Feed the caption through**

`LiveCameraScreen.update` calls `this.screenUI.sync(this.photography.state)`. It
needs the caption for the photograph being shown. Give `PhotographyMode` a field
`AlbumView` writes and `LiveCameraScreen` reads:

```ts
  /** The caption for the photograph on screen, set by AlbumView. */
  albumCaption: AlbumCaption | null = null;
```

In `AlbumView.load`, once a record has been accepted, set it:

```ts
    this.photography.albumCaption = {
      index: this.photography.album.index + 1,
      count: this.photography.album.count,
      takenAt: record.takenAt,
      focalMm: record.focalMm,
      aperture: record.aperture,
      shutterSpeed: record.shutterSpeed,
      iso: record.iso,
      focusDistance: record.focusDistance,
    };
    touch(this.photography.state);
```

and clear it in `leave()`:

```ts
    this.photography.albumCaption = null;
```

In `LiveCameraScreen.update`:

```ts
    this.screenUI.sync(this.photography.state, this.photography.albumCaption);
```

- [ ] **Step 4: Report a card that will not take photographs**

In `drawTopBar`, replace the remaining-shots line so the status zone reports card
trouble where it reports frames remaining:

```ts
    ctx.textAlign = 'right';
    ctx.fillStyle = hex(primary);
    ctx.font = `22px ${FONT}`;
    ctx.fillText(state.cardStatus ?? String(state.remainingShots), WIDTH - 32, 49);
```

Add to `PhotoState`:

```ts
  /** 'FULL' or 'NO CARD' when storage will not take photographs. Null when it will. */
  cardStatus: string | null;
```

initialised to `null` in `createPhotoState`, and set from `PhotoCapture.store()`
after a failed `put`:

```ts
      if (blob) {
        const id = await this.library.put(metadata, blob);
        if (id === null) {
          const status = this.library.status;
          this.photography.state.cardStatus =
            status === 'full' ? 'FULL' : status === 'unavailable' ? 'NO CARD' : null;
          touch(this.photography.state);
        }
        this.onStored?.();
      }
```

- [ ] **Step 5: Typecheck, test and commit**

```bash
npx tsc --noEmit
npm test
npm run build
git add src/camera/ScreenUI.ts src/camera/LiveCameraScreen.ts src/photography/PhotographyMode.ts src/photography/PhotoState.ts src/photography/capture/AlbumView.ts src/photography/capture/PhotoCapture.ts
git commit -m "Album chrome: the caption a print gets on the back"
```

---

## Task 14: Verification and docs

**Files:**
- Modify: `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`, `docs/STATUS.md`, `docs/HANDOFF.md`

- [ ] **Step 1: Full verification**

```bash
npm test
npx tsc --noEmit
npm run build
```

In the preview, walk this list and record what happens:

- `Space` takes a photograph; the animation reads as a shutter, not a fade
- the frame counter falls by exactly one per photograph, and holding `Space` does
  not run it away
- clicking the shutter cap does the same thing as `Space`
- a photograph shot at f/22 is visibly darker than one at f/2.8
- the photograph matches the framing that was composed, including at 120mm
- tapping the frame counter opens the album on the newest photograph
- arrows and the wheel flip through the roll and stop at both ends
- right-click closes the album and leaves the camera up; right-click again lowers it
- the album survives a page reload
- `DevStats` shows no sustained cost while idle — the capture pass is one frame,
  not a per-frame addition

- [ ] **Step 2: Update the docs**

- `docs/ARCHITECTURE.md`: add `photography/capture/` to the tree; add
  `PhotoCapture` and `AlbumView` to the registration-order list with the reason
  each sits where it does.
- `docs/DECISIONS.md`: add a `## Phase 12: Photo capture` section recording (1)
  why the photograph is a dedicated render rather than the viewfinder target, (2)
  why the capture render is pinned to the blackout's full-black frame, (3) why
  nothing on screen waits on storage, (4) why the album stores formatted strings
  rather than ladder indices.
- `docs/STATUS.md`: move the phase marker to 12, replace the "photo capture is a
  stub" entries with what now exists, and update *Exact next task*.
- `docs/HANDOFF.md`: replace the "Deliberately not built — photo capture is a
  stub" bullet with what shipped, and note the album's storage footprint.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "Photo capture and the album: verification and docs"
```

---

## Self-review notes

Checked against `docs/superpowers/specs/2026-08-02-photo-capture-design.md`:

- §1 module map → Tasks 2, 3, 4, 5, 8, 9, 12, plus the documented seventh module.
- §2 pixel source → Task 6 (shared camera) and Task 8 (`capture()`).
- §3 two targets and the develop order → Tasks 5 and 8 Step 1.
- §4 the sequence, and the render pinned to full black → Task 2, with
  `shouldRender` asserted on a fully black frame and under 0.25 s frames.
- §4 re-entry and interruption → Task 2 (`start` returns false), Task 8 Step 2
  (film not spent), Task 8 `update` (cancel on lowering).
- §5 screen modes and the four uniforms → Tasks 1 and 7.
- §6 album entry, navigation, texture lifetime, chrome → Tasks 10, 11, 12, 13.
- §7 storage and all three failure modes → Task 4, Task 8 `store`, Task 13 Step 4.
- §8 semantic actions and live-control gating → Task 10 Step 2.
- §9 settings → Task 1.
- §10 registration order → Task 8 Step 3 and Task 12 Step 3.
- §11 testing → Tasks 2, 3, 9 for the unit tests; Task 14 Step 1 for the browser pass.
- §12 build order → the Phase A gate after Task 8.

Deferred by the spec and therefore absent by design: downloads and export,
deletion, favouriting, sorting, a grid view, and sound.
