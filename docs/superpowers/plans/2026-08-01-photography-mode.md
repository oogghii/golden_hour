# Photography Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the floating camera into the game's only interface — right-click raises it into a shooting pose, its rear screen shows a live viewfinder with real focal length, and the player operates it by pointing at controls on the screen itself.

**Architecture:** Photography Mode only changes the floating camera's *target* pose; the existing damping filter in `FloatingCamera` turns that into physical motion for free. Movement is gated in the input layer, so `Player.ts` and `FirstPersonCamera.ts` are untouched. The rear screen composites three layers — a live render target, a Canvas2D chrome texture redrawn only on change, and procedural shapes in the fragment shader. Every input producer targets one `CameraActions` interface.

**Tech Stack:** TypeScript, Vite 8, three.js 0.185, vitest (new, devDependency only). No runtime dependencies are added.

**Spec:** `docs/superpowers/specs/2026-08-01-photography-mode-design.md` — read it before starting. Section numbers below refer to it.

## Global Constraints

- **No new runtime dependencies.** `three` only. vitest is a devDependency and ships nothing.
- **At `raise = 0` the floating-camera pose arithmetic must be byte-identical to today's.** Every new term is multiplied by `raise` or by a value that is 0 when `raise` is 0.
- **`src/player/Player.ts` and `src/player/FirstPersonCamera.ts` are never modified.**
- **No look value lives in a module.** Every tunable goes in `src/core/Settings.ts`.
- **No HUD.** Nothing is added to the DOM. `src/ui/Boot.ts` remains the only HTML in the project.
- Desktop `high` baseline, measured 2026-08-01: **170 fps, 80 calls, 1382k triangles**. `docs/STATUS.md` records a stale phase-9 figure; ignore it.
- Mobile target is a **pinned 30 fps**. The viewfinder degrades itself rather than costing frames.
- Systems clean up in `dispose()`. Debug UI is DEV-only and dynamically imported.
- Verify with `npx tsc --noEmit` and `npx vite build` — both must stay clean.

## Two phases with a gate between them

**Phase A (Tasks 1–8)** ships working software on its own: right-click raises the camera with real spring motion, the rear screen shows a live viewfinder, the wheel changes focal length, and the viewfinder degrades itself under load. The screen shows no interface yet.

**STOP at the end of Phase A for owner review of the feel** before starting Phase B. Pose timing and viewfinder framing are the two things that must be right before any interface is drawn on top of them.

**Phase B (Tasks 9–15)** adds the interface: the chrome layer, the procedural overlay, the reticle, interaction and focus.

## File structure

| File | Responsibility |
|---|---|
| `src/core/Settings.ts` | **Modify.** Add `PHOTOGRAPHY`, `VIEWFINDER`; correct `FLOATING_CAMERA.screen` |
| `src/photography/PhotoState.ts` | Plain data + revision counter. No three.js |
| `src/photography/ExposureModel.ts` | Aperture / shutter / ISO linked through EV. No three.js |
| `src/photography/InteractionZones.ts` | The one table of named UV rects. No three.js |
| `src/photography/GestureClassifier.ts` | Latched reticle-vs-look state machine. No three.js |
| `src/photography/CameraActions.ts` | The semantic interface every input producer targets |
| `src/photography/PhotographyMode.ts` | System. Owns the mode, gates input, implements `CameraActions` |
| `src/photography/CameraInteraction.ts` | Reticle → raycast → zone → hover/press/activate |
| `src/photography/input/PhotoDesktopInput.ts` | Mouse, wheel, right-click → `CameraActions` |
| `src/camera/CameraPose.ts` | The raise spring and the rest/raised blend |
| `src/camera/FloatingCamera.ts` | **Modify.** Blend the target by `raise`; split the merge |
| `src/camera/CameraScreen.ts` | **Modify.** Add optional `surface` for picking |
| `src/camera/LiveCameraScreen.ts` | Implements `CameraScreen`. Owns the screen mesh and material |
| `src/camera/Viewfinder.ts` | Second camera, render target, cadence |
| `src/camera/ViewfinderWatchdog.ts` | Buckets, median, hysteresis, ladder. No three.js |
| `src/camera/ScreenUI.ts` | Canvas2D → CanvasTexture. Redraw on change only |
| `src/camera/screenMaterial.ts` | Shader compositing feed + chrome + procedural shapes |
| `src/main.ts` | **Modify.** Wire it up in the documented order |
| `src/dev/DevStats.ts` | **Modify.** Show viewfinder cost and rung |

Files with no three.js import are unit-tested. Everything else is verified in the browser.

---

# Phase A — the physical camera

## Task 1: Test harness, settings, and the screen geometry correction

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`
- Modify: `src/core/Settings.ts` (add two blocks; amend `FLOATING_CAMERA.screen`)
- Create: `src/core/Settings.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `PHOTOGRAPHY`, `VIEWFINDER` exported from `src/core/Settings.ts`; `npm test` runs vitest

**Why vitest:** five modules in this plan encode invariants that cannot be checked by looking at the screen — EV consistency, gesture latching, watchdog hysteresis, zone partitioning, and the `raise = 0` identity. Those are exactly the owner-stated requirements ("deterministic", "learnable", "a transient does not degrade"). It is a devDependency and ships zero bytes. *If the owner would rather not add it, the fallback is DEV-only assertions in the style of `assertBandsCoverTheirRings` in `src/grass/GrassField.ts`; convert the `it(...)` bodies into `console.assert` calls behind `import.meta.env.DEV`.*

- [ ] **Step 1: Install vitest**

```bash
npm install -D vitest
```

If npm rejects the peer range against Vite 8, retry with `npm install -D vitest --legacy-peer-deps`. Vitest reuses Vite's resolver, which is why extensionless TS imports work in tests without any loader configuration.

- [ ] **Step 2: Add the test script**

In `package.json`, add to `scripts`:

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 3: Create the vitest config**

Create `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
```

Then add `"vitest.config.ts"` to the `include` array in `tsconfig.json`, so `tsc --noEmit` type-checks it:

```json
"include": ["src", "vite.config.ts", "vitest.config.ts"]
```

- [ ] **Step 4: Write the failing test**

Create `src/core/Settings.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { FLOATING_CAMERA, PHOTOGRAPHY, VIEWFINDER } from './Settings';

describe('FLOATING_CAMERA.screen', () => {
  it('is 3:2, the photographic aspect', () => {
    expect(FLOATING_CAMERA.screen.width / FLOATING_CAMERA.screen.height).toBeCloseTo(1.5, 5);
  });

  it('fits inside the bezel aperture measured from camera.gltf', () => {
    // Aperture: x +/-0.30, y 0.106 -> 0.519, bezel face at z 0.2281.
    const { width, height, position } = FLOATING_CAMERA.screen;
    expect(width).toBeLessThanOrEqual(0.60);
    expect(position[1] - height / 2).toBeGreaterThanOrEqual(0.106);
    expect(position[1] + height / 2).toBeLessThanOrEqual(0.519);
    expect(position[2]).toBeGreaterThanOrEqual(0.2281);
  });
});

describe('PHOTOGRAPHY', () => {
  it('reaches the raised pose with overshoot, not a critically damped crawl', () => {
    expect(PHOTOGRAPHY.raise.zeta).toBeLessThan(1);
    expect(PHOTOGRAPHY.raise.omega).toBeGreaterThan(0);
  });

  it('keeps magnetism subtle enough to assist rather than steer', () => {
    expect(PHOTOGRAPHY.reticle.magnetism).toBeLessThanOrEqual(0.15);
  });

  it('separates the flick threshold from the settle threshold', () => {
    expect(PHOTOGRAPHY.reticle.flickPxPerSec).toBeGreaterThan(
      PHOTOGRAPHY.reticle.settlePxPerSec * 4,
    );
  });
});

describe('VIEWFINDER', () => {
  it('ends its ladder in a frozen frame rather than a smaller live one', () => {
    const last = VIEWFINDER.ladder[VIEWFINDER.ladder.length - 1]!;
    expect(last.hz).toBe(0);
  });

  it('descends monotonically in cost', () => {
    for (let i = 1; i < VIEWFINDER.ladder.length; i++) {
      const prev = VIEWFINDER.ladder[i - 1]!;
      const next = VIEWFINDER.ladder[i]!;
      expect(next.width * next.height * next.hz).toBeLessThan(prev.width * prev.height * prev.hz);
    }
  });

  it('leaves an explicit hysteresis gap so no state satisfies both conditions', () => {
    expect(VIEWFINDER.watchdog.recoverAbove).toBeGreaterThan(VIEWFINDER.watchdog.degradeBelow);
  });

  it('observes for at least two seconds before degrading', () => {
    const { bucketSeconds, degradeBuckets } = VIEWFINDER.watchdog;
    expect(bucketSeconds * degradeBuckets).toBeGreaterThanOrEqual(2);
  });

  it('starts every tier on a rung that exists', () => {
    for (const rung of Object.values(VIEWFINDER.startRung)) {
      expect(rung).toBeLessThan(VIEWFINDER.ladder.length);
    }
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

```bash
npm test
```

Expected: FAIL — `PHOTOGRAPHY` and `VIEWFINDER` are not exported from `Settings.ts`.

- [ ] **Step 6: Amend `FLOATING_CAMERA.screen`**

In `src/core/Settings.ts`, replace the `screen` block inside `FLOATING_CAMERA`:

```ts
  /**
   * The bezel aperture measured from camera.gltf: the gap inside frame nodes
   * 5-8, in front of the recessed panel of node 9, is x +/-0.30 and
   * y 0.106 -> 0.519, with the bezel face at z 0.2281. A 3:2 screen centred in
   * it leaves a 0.0065 margin top and bottom. The first draft was 0.42 x 0.265
   * at y 0.24, which under-filled the aperture and sat low.
   */
  screen: {
    width: 0.6,
    height: 0.4,
    position: [0, 0.3125, 0.229] as const,
    colorTop: 0xf3ac78,
    colorBottom: 0x6f7382,
  },
```

- [ ] **Step 7: Add the two new blocks**

Append to `src/core/Settings.ts`, after `FLOATING_CAMERA`:

```ts
/**
 * Photography Mode. The camera stops being scenery and becomes the interface.
 * Every value that changes how the raise *feels* lives here.
 */
export const PHOTOGRAPHY = {
  /**
   * Under-damped on purpose: the overshoot is what reads as weight.
   * `leadScale` drives pitch off the spring's velocity; `rollLeadScale` is how
   * much of that same lead reaches roll. Roll gets less, so the body tips up
   * more than it twists.
   */
  raise: {
    omega: 11,
    zeta: 0.62,
    arcLift: 0.06,
    arcPull: 0.04,
    leadScale: 0.09,
    rollLeadScale: 0.6,
  },
  /** Nearly square to the player, but not sterile. */
  raisedRotationDeg: { x: -1.5, y: 0, z: 0 },
  /** A camera braced against your face is steadier, not looser. */
  raisedFollowLambda: 9.0,
  raisedRotationLambda: 11.0,
  raisedDriftScale: 0.4,
  raisedLookOffsetScale: 0.3,
  raisedBankScale: 0.35,
  /** The framing knob. The raised distance is solved from this, never hardcoded. */
  screenHeightFraction: 0.36,
  /** Photographers step to compose. 0 would freeze movement entirely. */
  moveScale: 0.28,
  lookScale: 0.8,
  /**
   * A 36x24mm frame, so vertical fov is 2*atan(12/f). `startMm` is where the
   * lens sits when the camera first comes up — a mild wide, tighter than the
   * naked view, which reads as "a camera" rather than "a zoom".
   */
  lens: { minMm: 24, maxMm: 120, startMm: 36, sensorHeightMm: 24, wheelStep: 0.055, lambda: 9 },
  reticle: {
    /**
     * Gesture classification is latched, never blended: the same physical
     * gesture must not change meaning according to how fast it happens to be.
     */
    flickPxPerSec: 900,
    settlePxPerSec: 60,
    settleSeconds: 0.12,
    /** Mouse travel across the full screen width. An edge is always close. */
    pxPerScreenWidth: 260,
    /**
     * Magnetism assists the landing only. Scaled to zero above the cutoff so it
     * can never drag the reticle off the path the player intended.
     */
    magnetism: 0.12,
    magnetSpeedCutoff: 220,
    fadeDelay: 1.1,
    fadeLambda: 7,
    /** A fraction of the screen width, as are all uv-space values here. */
    radius: 0.016,
  },
  /** How the shutter cap depresses. Under-damped so the release has a bounce. */
  buttonSpring: { omega: 30, zeta: 0.5 },
  screenUI: {
    primary: 0xf5efe6,
    secondary: 0xc9bfb1,
    accent: 0xf2b45c,
    confirm: 0xa8d8a8,
    /**
     * Above the world's mid-tones so the display glows, below
     * POST.bloom.threshold of 1.85 so it never smears.
     */
    emissive: 1.3,
    gridOpacity: 0.14,
  },
  /**
   * The sun in this world sits at 6.5 degrees, so the light is well past
   * sunny-16 — this is the last of it. EV 9 at ISO 100 is what makes
   * f/2.8, 1/250, ISO 400 read as a correct exposure, which is the triple the
   * approved layout shows.
   */
  sceneEv: 9,
} as const;

/**
 * The live viewfinder degrades itself rather than costing frames. Every
 * decision reads the median of buckets, never a mean, so one stalled frame
 * cannot trigger a downgrade.
 */
export const VIEWFINDER = {
  ladder: [
    { width: 512, height: 341, hz: 30 },
    { width: 384, height: 256, hz: 20 },
    { width: 256, height: 171, hz: 12 },
    /** Frozen: the last frame stays, the interface stays fully live. */
    { width: 256, height: 171, hz: 0 },
  ],
  startRung: { high: 0, medium: 1, low: 2 },
  frozenDim: 0.55,
  watchdog: {
    bucketSeconds: 0.5,
    /**
     * How long to measure the machine's natural rate before the camera comes
     * up, on displays with no frame cap. A single frame is not a baseline: two
     * rAF callbacks landing 4ms apart would read as 250fps and condemn a
     * healthy 60 to the bottom of the ladder within seconds.
     */
    baselineSeconds: 1.0,
    /** The first frames pay for allocation and shader compilation. */
    warmupSeconds: 1.0,
    cooldownSeconds: 3.0,
    degradeBelow: 0.92,
    degradeBuckets: 4,
    recoverAbove: 1.0,
    recoverBuckets: 16,
    maxRecoveries: 2,
  },
} as const;
```

- [ ] **Step 8: Run the tests and the type-checker**

```bash
npm test
```

Expected: PASS, 10 tests across 3 `describe` blocks.

```bash
npx tsc --noEmit
```

Expected: no output.

- [ ] **Step 9: Confirm the screen now fills the bezel**

Start the preview (`preview_start` with name `golden-hour`), take a screenshot, and compare the rear display against the previous build: the bright inset should now fill the dark bezel rather than sitting low inside it.

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json vitest.config.ts tsconfig.json src/core/Settings.ts src/core/Settings.test.ts
git commit -m "Photography settings, screen geometry correction, vitest harness"
```

---

## Task 2: Split the model merge so the shutter button survives

**Files:**
- Modify: `src/camera/FloatingCamera.ts:106-164` (`loadCameraModel`, `mergeModel`)

**Interfaces:**
- Consumes: `FLOATING_CAMERA` from Task 1
- Produces: the loaded model contains three named children — `VintageCameraBody` (Mesh), `ShutterButton` (Mesh), `ShutterHitVolume` (Mesh, `visible = false`)

`mergeModel()` currently flattens all 15 glTF meshes into one mesh, destroying the `button` node name — the only interactive part in the asset. The glTF scene has exactly two roots: `camera` (14 children) and `button` (one cylinder spanning x 0.2875→0.4125, y 0.575→0.700, z ±0.0625).

- [ ] **Step 1: Rewrite `mergeModel`**

Replace the whole `mergeModel` function in `src/camera/FloatingCamera.ts`:

```ts
/**
 * Two merged meshes, not one. The glTF's `button` root is the only interactive
 * part in the asset, so it keeps its own mesh and can physically depress.
 * DECISIONS.md justified the original flatten by shadow-pass cost; this model
 * sets castShadow = false, so that reason does not apply.
 */
function mergeModel(source: THREE.Object3D): THREE.Object3D {
  source.updateMatrixWorld(true);
  const model = new THREE.Group();

  const buttonRoot = source.getObjectByName('button');
  if (!buttonRoot) throw new Error('camera.gltf is missing its `button` root node');

  const body = mergeSubtree(source, (node) => !isDescendantOf(node, buttonRoot));
  body.name = 'VintageCameraBody';
  model.add(body);

  const button = mergeSubtree(buttonRoot, () => true);
  button.name = 'ShutterButton';
  model.add(button);

  model.add(createHitVolume(button));
  return model;
}

/** Merges every mesh under `root` that passes `accept` into one mesh. */
function mergeSubtree(
  root: THREE.Object3D,
  accept: (node: THREE.Mesh) => boolean,
): THREE.Mesh {
  const geometries: THREE.BufferGeometry[] = [];
  let material: THREE.Material | null = null;

  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh) || !accept(child)) return;
    const childMaterial = Array.isArray(child.material) ? child.material[0] : child.material;
    material ??= childMaterial ?? null;
    const geometry = child.geometry.clone();
    geometry.applyMatrix4(child.matrixWorld);
    geometries.push(geometry);
  });

  const merged = mergeGeometries(geometries, false);
  geometries.forEach((geometry) => geometry.dispose());
  if (!merged || !material) throw new Error('Blockbench camera geometry could not be merged');
  return new THREE.Mesh(merged, material);
}

function isDescendantOf(node: THREE.Object3D, ancestor: THREE.Object3D): boolean {
  for (let current: THREE.Object3D | null = node; current; current = current.parent) {
    if (current === ancestor) return true;
  }
  return false;
}

/**
 * Picking never runs against the cap geometry. This box is generous enough for
 * a reticle that is not pixel-perfect and for a fingertip on a phone.
 */
function createHitVolume(button: THREE.Mesh): THREE.Mesh {
  button.geometry.computeBoundingBox();
  const box = button.geometry.boundingBox;
  if (!box) throw new Error('Shutter button geometry has no bounding box');

  const size = box.getSize(new THREE.Vector3()).multiplyScalar(HIT_VOLUME_SCALE);
  const centre = box.getCenter(new THREE.Vector3());
  const volume = new THREE.Mesh(
    new THREE.BoxGeometry(size.x, size.y, size.z),
    new THREE.MeshBasicMaterial({ visible: false }),
  );
  volume.position.copy(centre);
  volume.name = 'ShutterHitVolume';
  volume.visible = false;
  return volume;
}
```

Add near the top of the file, below the imports:

```ts
/** Enlarged so the shutter never needs pixel-perfect targeting. */
const HIT_VOLUME_SCALE = 2.4;
```

Note the original `mergeModel` called `child.geometry.dispose()` inside the traversal, which disposed the source geometry while it was still being walked. `mergeSubtree` traverses the same subtree twice (body pass skips the button, button pass takes it), so that dispose is deliberately dropped; the source geometries become garbage when `gltf.scene` goes out of scope.

- [ ] **Step 2: Verify in the browser**

Reload the preview. Expected: the camera looks exactly as before. `DevStats` draw calls rise from 80 to **81** (the hit volume is `visible = false`, so it is not drawn).

- [ ] **Step 3: Verify no console errors**

Read console messages. Expected: none. In particular no "missing `button` root node".

- [ ] **Step 4: Type-check and commit**

```bash
npx tsc --noEmit
git add src/camera/FloatingCamera.ts
git commit -m "Keep the shutter button as its own mesh with an enlarged hit volume"
```

---

## Task 3: PhotoState and ExposureModel

**Files:**
- Create: `src/photography/PhotoState.ts`
- Create: `src/photography/ExposureModel.ts`
- Create: `src/photography/ExposureModel.test.ts`

**Interfaces:**
- Consumes: `PHOTOGRAPHY` from Task 1
- Produces:
  - `type SettingId = 'focal' | 'aperture' | 'shutterSpeed' | 'iso' | 'exposure' | 'mode'`
  - `type ShootingMode = 'P' | 'A' | 'S' | 'M'`
  - `interface PhotoState` and `createPhotoState(): PhotoState`
  - `touch(state: PhotoState): void` — bumps `revision`
  - `APERTURES`, `SHUTTERS`, `ISOS`, `EXPOSURES: readonly number[]`
  - `settingsEv(state): number`, `targetEv(state): number`, `viewfinderGain(state): number`
  - `applyModeCoupling(state: PhotoState, changed: SettingId): void`
  - `formatAperture`, `formatShutter`, `formatIso`, `formatExposure`, `formatFocal: (state) => string`

- [ ] **Step 1: Create PhotoState**

Create `src/photography/PhotoState.ts`:

```ts
/**
 * Everything the rear display shows and the interaction layer edits. Plain data
 * with a revision counter, so the chrome texture can redraw only when something
 * it draws has actually changed.
 */

export type SettingId = 'focal' | 'aperture' | 'shutterSpeed' | 'iso' | 'exposure' | 'mode';
export type ShootingMode = 'P' | 'A' | 'S' | 'M';

export const SHOOTING_MODES: readonly ShootingMode[] = ['P', 'A', 'S', 'M'];

export interface PhotoState {
  mode: ShootingMode;
  /** Where the zoom is heading. `focalMm` chases it. */
  targetFocalMm: number;
  focalMm: number;
  apertureIndex: number;
  shutterIndex: number;
  isoIndex: number;
  exposureIndex: number;
  selected: SettingId | null;
  /** Metres. Infinity reads as the infinity mark on the display. */
  focusDistance: number;
  focusConfirmed: boolean;
  focusUv: { x: number; y: number };
  remainingShots: number;
  /** 0..1. */
  battery: number;
  /** Bumped whenever anything the chrome layer draws changes. */
  revision: number;
}

export function createPhotoState(focalMm: number): PhotoState {
  return {
    mode: 'A',
    targetFocalMm: focalMm,
    focalMm,
    // f/2.8, 1/250, ISO 400, +0.0 — a correct exposure for PHOTOGRAPHY.sceneEv,
    // so the display is plausible before the player touches anything.
    apertureIndex: 6,
    shutterIndex: 39,
    isoIndex: 6,
    exposureIndex: 9,
    selected: null,
    focusDistance: Infinity,
    focusConfirmed: false,
    focusUv: { x: 0.5, y: 0.5 },
    remainingShots: 248,
    battery: 0.82,
    revision: 0,
  };
}

export function touch(state: PhotoState): void {
  state.revision++;
}
```

- [ ] **Step 2: Write the failing test**

Create `src/photography/ExposureModel.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { createPhotoState, type PhotoState } from './PhotoState';
import {
  APERTURES,
  applyModeCoupling,
  EXPOSURES,
  formatExposure,
  formatShutter,
  ISOS,
  settingsEv,
  SHUTTERS,
  targetEv,
  viewfinderGain,
} from './ExposureModel';

let state: PhotoState;
beforeEach(() => {
  state = createPhotoState(35);
});

describe('the ladders', () => {
  it('runs apertures from wide to narrow', () => {
    expect(APERTURES[0]).toBeLessThan(APERTURES[APERTURES.length - 1]!);
  });

  it('runs shutters from long to short', () => {
    expect(SHUTTERS[0]).toBeGreaterThan(SHUTTERS[SHUTTERS.length - 1]!);
  });

  it('centres exposure compensation on zero', () => {
    expect(EXPOSURES[(EXPOSURES.length - 1) / 2]).toBe(0);
  });

  it('steps ISO in thirds', () => {
    expect(ISOS[3]! / ISOS[0]!).toBeCloseTo(2, 1);
  });
});

describe('A mode couples shutter to aperture', () => {
  it('shortens the shutter when the aperture opens up', () => {
    state.mode = 'A';
    applyModeCoupling(state, 'aperture');
    const before = state.shutterIndex;
    state.apertureIndex -= 3; // one full stop wider
    applyModeCoupling(state, 'aperture');
    expect(state.shutterIndex).toBeGreaterThan(before);
  });

  it('holds the exposure within a third of a stop across the aperture range', () => {
    state.mode = 'A';
    for (let i = 3; i < APERTURES.length - 3; i++) {
      state.apertureIndex = i;
      applyModeCoupling(state, 'aperture');
      // A third of a stop is 0.333; the ladders carry nominal marks (1/125, not
      // 1/128), which adds up to about 0.05 EV of drift on top.
      expect(Math.abs(settingsEv(state) - targetEv(state))).toBeLessThanOrEqual(0.4);
    }
  });
});

describe('S mode couples aperture to shutter', () => {
  it('opens the aperture when the shutter gets shorter', () => {
    state.mode = 'S';
    applyModeCoupling(state, 'shutterSpeed');
    const before = state.apertureIndex;
    state.shutterIndex += 3;
    applyModeCoupling(state, 'shutterSpeed');
    expect(state.apertureIndex).toBeLessThan(before);
  });
});

describe('M mode couples nothing', () => {
  it('leaves the other settings exactly where they were', () => {
    state.mode = 'M';
    const shutter = state.shutterIndex;
    state.apertureIndex -= 3;
    applyModeCoupling(state, 'aperture');
    expect(state.shutterIndex).toBe(shutter);
  });

  it('reports the deviation through the viewfinder gain', () => {
    state.mode = 'M';
    state.shutterIndex += 3; // one stop shorter, so one stop darker
    expect(viewfinderGain(state)).toBeLessThan(1);
  });
});

describe('exposure compensation', () => {
  it('brightens the viewfinder when dialled positive', () => {
    state.mode = 'A';
    applyModeCoupling(state, 'aperture');
    const neutral = viewfinderGain(state);
    state.exposureIndex += 3;
    applyModeCoupling(state, 'exposure');
    expect(viewfinderGain(state)).toBeGreaterThan(neutral);
  });

  it('never lets the gain run away far enough to blow the screen white', () => {
    state.mode = 'M';
    state.shutterIndex = 0;
    state.apertureIndex = 0;
    state.isoIndex = ISOS.length - 1;
    expect(viewfinderGain(state)).toBeLessThanOrEqual(4);
  });
});

describe('formatting a photographer would recognise', () => {
  it('writes long shutters in seconds and short ones as fractions', () => {
    state.shutterIndex = 0;
    expect(formatShutter(state)).toMatch(/"$/);
    state.shutterIndex = SHUTTERS.length - 1;
    expect(formatShutter(state)).toBe('1/4000');
  });

  it('signs exposure compensation and marks zero plainly', () => {
    state.exposureIndex = (EXPOSURES.length - 1) / 2;
    expect(formatExposure(state)).toBe('0');
    state.exposureIndex += 3;
    expect(formatExposure(state)).toMatch(/^\+/);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
npm test
```

Expected: FAIL — cannot resolve `./ExposureModel`.

- [ ] **Step 4: Create ExposureModel**

Create `src/photography/ExposureModel.ts`:

```ts
import { PHOTOGRAPHY } from '../core/Settings';
import { clamp } from '../util/math';
import type { PhotoState, SettingId } from './PhotoState';

/**
 * Aperture, shutter and ISO linked through EV. This is the thing a photographer
 * notices in the first ten seconds: f/1.4 with 1/8000 at ISO 6400 showing a
 * normally exposed image would break the illusion completely.
 *
 * All three ladders are third-stop, so an index step is always 1/3 EV and the
 * coupling arithmetic is plain integer addition.
 */

export const APERTURES: readonly number[] = [
  1.4, 1.6, 1.8, 2, 2.2, 2.5, 2.8, 3.2, 3.5, 4, 4.5, 5, 5.6, 6.3, 7.1, 8, 9, 10, 11, 13, 14, 16,
  18, 20, 22,
];

/** Seconds. Long to short, so a higher index is always a shorter exposure. */
export const SHUTTERS: readonly number[] = [
  30, 25, 20, 15, 13, 10, 8, 6, 5, 4, 3.2, 2.5, 2, 1.6, 1.3, 1, 1 / 1.3, 1 / 1.6, 1 / 2, 1 / 2.5,
  1 / 3, 1 / 4, 1 / 5, 1 / 6, 1 / 8, 1 / 10, 1 / 13, 1 / 15, 1 / 20, 1 / 25, 1 / 30, 1 / 40,
  1 / 50, 1 / 60, 1 / 80, 1 / 100, 1 / 125, 1 / 160, 1 / 200, 1 / 250, 1 / 320, 1 / 400, 1 / 500,
  1 / 640, 1 / 800, 1 / 1000, 1 / 1250, 1 / 1600, 1 / 2000, 1 / 2500, 1 / 3200, 1 / 4000,
];

export const ISOS: readonly number[] = [
  100, 125, 160, 200, 250, 320, 400, 500, 640, 800, 1000, 1250, 1600, 2000, 2500, 3200, 4000,
  5000, 6400, 8000, 10000, 12800,
];

/** Thirds from -3 to +3. Index 9 is 0. */
export const EXPOSURES: readonly number[] = Array.from(
  { length: 19 },
  (_unused, i) => Math.round((i - 9) * (1 / 3) * 100) / 100,
);

/** The gain is clamped so manual mode can never wash the display to white. */
const GAIN_LIMIT = 4;

function at(ladder: readonly number[], index: number): number {
  return ladder[clamp(Math.round(index), 0, ladder.length - 1)]!;
}

/** The EV the current settings are exposing for, referred to ISO 100. */
export function settingsEv(state: PhotoState): number {
  const aperture = at(APERTURES, state.apertureIndex);
  const shutter = at(SHUTTERS, state.shutterIndex);
  const iso = at(ISOS, state.isoIndex);
  return Math.log2((aperture * aperture) / shutter) - Math.log2(iso / 100);
}

/** The EV the scene actually is, offset by the compensation dial. */
export function targetEv(state: PhotoState): number {
  return PHOTOGRAPHY.sceneEv - at(EXPOSURES, state.exposureIndex);
}

/**
 * How much to scale the viewfinder image. Above 1 the settings are letting in
 * more light than the SCENE needs.
 *
 * Measured against `sceneEv`, deliberately not against `targetEv`. The coupling
 * aims settingsEv AT targetEv, and targetEv is sceneEv offset by the
 * compensation dial — so measuring against targetEv would cancel the dial out
 * and leave exposure compensation doing nothing at all in P, A and S. Against
 * sceneEv the gain settles at exactly 2^compensation, which is what the dial
 * is for. In M nothing couples, so this reads as the raw deviation.
 *
 * This grades the viewfinder texture only, never the player's own view.
 */
export function viewfinderGain(state: PhotoState): number {
  return clamp(2 ** (PHOTOGRAPHY.sceneEv - settingsEv(state)), 1 / GAIN_LIMIT, GAIN_LIMIT);
}

/**
 * Re-derives whichever setting the current mode controls, so the numbers stay
 * internally consistent. Manual couples nothing and lets the deviation show.
 */
export function applyModeCoupling(state: PhotoState, changed: SettingId): void {
  if (state.mode === 'M') return;

  // Thirds throughout, so the correction is a whole number of index steps.
  const errorSteps = Math.round((settingsEv(state) - targetEv(state)) * 3);
  if (errorSteps === 0) return;

  /*
   * Both ladders are ordered so that a HIGHER index means a HIGHER settings EV
   * — a narrower aperture, or a shorter exposure. So correcting a positive
   * error (settings exposing for a brighter scene than reality, image too dark)
   * always means stepping DOWN, in either ladder. Getting this sign wrong sends
   * the shutter to the end of its range on the very first coupling.
   */
  const drive = derivedSetting(state.mode, changed);
  if (drive === 'shutterSpeed') {
    state.shutterIndex = clamp(state.shutterIndex - errorSteps, 0, SHUTTERS.length - 1);
  } else {
    state.apertureIndex = clamp(state.apertureIndex - errorSteps, 0, APERTURES.length - 1);
  }
}

function derivedSetting(mode: PhotoState['mode'], changed: SettingId): 'shutterSpeed' | 'aperture' {
  if (mode === 'S') return 'aperture';
  if (mode === 'A') return 'shutterSpeed';
  // P derives whichever the player did not just touch.
  return changed === 'shutterSpeed' ? 'aperture' : 'shutterSpeed';
}

export function formatAperture(state: PhotoState): string {
  const value = at(APERTURES, state.apertureIndex);
  return `F${value < 10 ? value.toFixed(1) : value.toFixed(0)}`;
}

export function formatShutter(state: PhotoState): string {
  const seconds = at(SHUTTERS, state.shutterIndex);
  if (seconds >= 1) return `${seconds % 1 === 0 ? seconds : seconds.toFixed(1)}"`;
  return `1/${Math.round(1 / seconds)}`;
}

export function formatIso(state: PhotoState): string {
  return `ISO ${at(ISOS, state.isoIndex)}`;
}

export function formatExposure(state: PhotoState): string {
  const value = at(EXPOSURES, state.exposureIndex);
  if (value === 0) return '0';
  return `${value > 0 ? '+' : '−'}${Math.abs(value).toFixed(1)}`;
}

export function formatFocal(state: PhotoState): string {
  return `${Math.round(state.focalMm)}`;
}
```

- [ ] **Step 5: Run the tests**

```bash
npm test
```

Expected: PASS. If the A-mode drift test fails, the sign of `errorSteps` is inverted — read the comment on `state.shutterIndex` and check that a *higher* shutter index means a *shorter* exposure.

- [ ] **Step 6: Type-check and commit**

```bash
npx tsc --noEmit
git add src/photography/PhotoState.ts src/photography/ExposureModel.ts src/photography/ExposureModel.test.ts
git commit -m "Photo state and an exposure model a photographer would recognise"
```

---

## Task 4: CameraPose — the raise spring and the rest/raised blend

**Files:**
- Create: `src/camera/CameraPose.ts`
- Create: `src/camera/CameraPose.test.ts`

**Interfaces:**
- Consumes: `PHOTOGRAPHY`, `FLOATING_CAMERA` from Task 1; `spring`, `lerp`, `saturate`, `DEG` from `src/util/math`
- Produces:
  - `interface PoseBlend { anchor: THREE.Vector3; pitch: number; yaw: number; roll: number; followLambda: number; rotationLambda: number; driftScale: number; lookOffsetScale: number; bankScale: number }` — angles in radians
  - `class CameraPose { readonly raise: number; readonly isRaised: boolean; setRaised(v: boolean): void; update(dt: number): void; resolve(fov: number, out: PoseBlend): void }`

The whole point of this module: `FloatingCamera` keeps its existing damping filter untouched and only asks `CameraPose` what the target should be.

- [ ] **Step 1: Write the failing test**

Create `src/camera/CameraPose.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { FLOATING_CAMERA, PHOTOGRAPHY } from '../core/Settings';
import { DEG } from '../util/math';
import { CameraPose, createPoseBlend } from './CameraPose';

const FOV = 62;
const DT = 1 / 60;

function settle(pose: CameraPose, seconds: number): void {
  for (let t = 0; t < seconds; t += DT) pose.update(DT);
}

describe('the rest pose is untouched', () => {
  it('reproduces the pre-Photography-Mode anchor exactly at raise 0', () => {
    const pose = new CameraPose();
    const out = createPoseBlend();
    pose.resolve(FOV, out);

    expect(out.anchor.toArray()).toEqual([...FLOATING_CAMERA.anchor]);
    expect(out.pitch).toBe(FLOATING_CAMERA.rotationDeg.x * DEG);
    expect(out.yaw).toBe(FLOATING_CAMERA.rotationDeg.y * DEG);
    expect(out.roll).toBe(FLOATING_CAMERA.rotationDeg.z * DEG);
    expect(out.followLambda).toBe(FLOATING_CAMERA.followLambda);
    expect(out.rotationLambda).toBe(FLOATING_CAMERA.rotationLambda);
    expect(out.driftScale).toBe(1);
    expect(out.lookOffsetScale).toBe(1);
    expect(out.bankScale).toBe(1);
  });

  it('returns to that exact rest pose after a full raise and lower', () => {
    const pose = new CameraPose();
    const out = createPoseBlend();
    pose.setRaised(true);
    settle(pose, 3);
    pose.setRaised(false);
    settle(pose, 3);
    pose.resolve(FOV, out);

    expect(pose.raise).toBeCloseTo(0, 6);
    expect(out.anchor.x).toBeCloseTo(FLOATING_CAMERA.anchor[0], 4);
    expect(out.anchor.y).toBeCloseTo(FLOATING_CAMERA.anchor[1], 4);
    expect(out.anchor.z).toBeCloseTo(FLOATING_CAMERA.anchor[2], 4);
  });
});

describe('the raise spring', () => {
  it('overshoots, because the overshoot is what reads as weight', () => {
    const pose = new CameraPose();
    pose.setRaised(true);
    let peak = 0;
    for (let t = 0; t < 3; t += DT) {
      pose.update(DT);
      peak = Math.max(peak, pose.raise);
    }
    expect(peak).toBeGreaterThan(1.02);
  });

  it('settles inside a second', () => {
    const pose = new CameraPose();
    pose.setRaised(true);
    settle(pose, 1);
    expect(pose.raise).toBeCloseTo(1, 2);
  });

  it('is stable at a long frame, because dt is clamped but still coarse', () => {
    const pose = new CameraPose();
    pose.setRaised(true);
    for (let i = 0; i < 40; i++) pose.update(1 / 20);
    expect(Number.isFinite(pose.raise)).toBe(true);
    expect(pose.raise).toBeCloseTo(1, 2);
  });
});

describe('the raised pose', () => {
  it('puts the screen centre on the view axis at the framed distance', () => {
    const pose = new CameraPose();
    const out = createPoseBlend();
    pose.setRaised(true);
    settle(pose, 3);
    pose.resolve(FOV, out);

    const rotation = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(out.pitch, out.yaw, out.roll, 'YXZ'),
    );
    const screenCentre = new THREE.Vector3(0, 0.3125, 0.229)
      .multiplyScalar(FLOATING_CAMERA.scale)
      .applyQuaternion(rotation)
      .add(out.anchor);

    expect(screenCentre.x).toBeCloseTo(0, 3);
    expect(screenCentre.y).toBeCloseTo(0, 3);

    // The screen should subtend screenHeightFraction of the view height.
    const viewHeight = 2 * Math.abs(screenCentre.z) * Math.tan((FOV * DEG) / 2);
    const screenHeight = FLOATING_CAMERA.screen.height * FLOATING_CAMERA.scale;
    expect(screenHeight / viewHeight).toBeCloseTo(PHOTOGRAPHY.screenHeightFraction, 2);
  });

  it('reframes for a wider fov by bringing the camera closer', () => {
    const pose = new CameraPose();
    const narrow = createPoseBlend();
    const wide = createPoseBlend();
    pose.setRaised(true);
    settle(pose, 3);
    pose.resolve(62, narrow);
    pose.resolve(70, wide);
    // A wider view is TALLER at any given distance, so holding the screen at a
    // fixed fraction of that height means bringing it nearer, not pushing it
    // away. Mobile's 70 degree fov therefore ends up with the camera closer to
    // the eye than desktop's 62 — which is what you want on a small screen.
    expect(Math.abs(wide.anchor.z)).toBeLessThan(Math.abs(narrow.anchor.z));
  });

  it('steadies the follow rather than loosening it', () => {
    const pose = new CameraPose();
    const out = createPoseBlend();
    pose.setRaised(true);
    settle(pose, 3);
    pose.resolve(FOV, out);
    expect(out.followLambda).toBeGreaterThan(FLOATING_CAMERA.followLambda);
    expect(out.driftScale).toBeLessThan(1);
  });
});

describe('the arc', () => {
  it('lifts the path off the straight line mid-transition, and only there', () => {
    const settled = new CameraPose();
    settled.setRaised(true);
    settle(settled, 3);
    const destination = createPoseBlend();
    settled.resolve(FOV, destination);
    const end = destination.anchor.clone();
    const start = new THREE.Vector3(...FLOATING_CAMERA.anchor);

    const pose = new CameraPose();
    const out = createPoseBlend();
    let maxDeviation = 0;
    pose.setRaised(true);
    for (let t = 0; t < 3; t += DT) {
      pose.update(DT);
      pose.resolve(FOV, out);
      const straight = start.clone().lerp(end, Math.min(pose.raise, 1));
      maxDeviation = Math.max(maxDeviation, out.anchor.distanceTo(straight));
    }
    expect(maxDeviation).toBeGreaterThan(0.01);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test
```

Expected: FAIL — cannot resolve `./CameraPose`.

- [ ] **Step 3: Create CameraPose**

Create `src/camera/CameraPose.ts`:

```ts
import * as THREE from 'three';
import { FLOATING_CAMERA, PHOTOGRAPHY } from '../core/Settings';
import { DEG, lerp, spring, type SpringState } from '../util/math';

/**
 * What the floating camera should be aiming at this frame. `FloatingCamera`
 * keeps its own damping filter untouched and simply asks for this — which is
 * why raising the camera inherits the existing sense of weight for free.
 */
export interface PoseBlend {
  /** Camera-space. */
  anchor: THREE.Vector3;
  /** Radians. */
  pitch: number;
  yaw: number;
  roll: number;
  followLambda: number;
  rotationLambda: number;
  driftScale: number;
  lookOffsetScale: number;
  bankScale: number;
}

export function createPoseBlend(): PoseBlend {
  return {
    anchor: new THREE.Vector3(),
    pitch: 0,
    yaw: 0,
    roll: 0,
    followLambda: FLOATING_CAMERA.followLambda,
    rotationLambda: FLOATING_CAMERA.rotationLambda,
    driftScale: 1,
    lookOffsetScale: 1,
    bankScale: 1,
  };
}

/** Local offset from the model origin to the centre of the rear screen. */
const SCREEN_CENTRE_LOCAL = new THREE.Vector3(
  FLOATING_CAMERA.screen.position[0],
  FLOATING_CAMERA.screen.position[1],
  FLOATING_CAMERA.screen.position[2],
);

const REST_ANCHOR = new THREE.Vector3(...FLOATING_CAMERA.anchor);

export class CameraPose {
  /** 0 resting, 1 raised. Overshoots past 1 on the way up. */
  raise = 0;

  private target = 0;
  private readonly springState: SpringState = { velocity: 0 };
  private readonly raisedAnchor = new THREE.Vector3();
  private readonly scratch = new THREE.Vector3();
  private readonly rotation = new THREE.Quaternion();
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');

  get isRaised(): boolean {
    return this.target === 1;
  }

  setRaised(raised: boolean): void {
    this.target = raised ? 1 : 0;
  }

  update(dt: number): void {
    if (dt <= 0) return;
    const { omega, zeta } = PHOTOGRAPHY.raise;
    this.raise = spring(this.raise, this.target, this.springState, omega, zeta, dt);
  }

  /**
   * `fov` is the live vertical field of view in degrees, so the framing adapts
   * to the mobile fov and to any window aspect with no second constant.
   */
  resolve(fov: number, out: PoseBlend): void {
    const t = this.raise;

    this.solveRaisedAnchor(fov);
    out.anchor.copy(REST_ANCHOR).lerp(this.raisedAnchor, t);

    // Zero at both ends, so it can only ever bend the middle of the journey.
    const arc = t * (1 - t) * 4;
    out.anchor.y += arc * PHOTOGRAPHY.raise.arcLift;
    out.anchor.z -= arc * PHOTOGRAPHY.raise.arcPull;

    // Driven by the spring's velocity, so raising and lowering differ without
    // authoring a second animation. Scaled by `t` so the rest pose is exact.
    const lead = this.springState.velocity * PHOTOGRAPHY.raise.leadScale * t;

    const rest = FLOATING_CAMERA.rotationDeg;
    const raised = PHOTOGRAPHY.raisedRotationDeg;
    out.pitch = lerp(rest.x * DEG, raised.x * DEG, t) + lead;
    out.yaw = lerp(rest.y * DEG, raised.y * DEG, t);
    out.roll = lerp(rest.z * DEG, raised.z * DEG, t) - lead * PHOTOGRAPHY.raise.rollLeadScale;

    out.followLambda = lerp(FLOATING_CAMERA.followLambda, PHOTOGRAPHY.raisedFollowLambda, t);
    out.rotationLambda = lerp(FLOATING_CAMERA.rotationLambda, PHOTOGRAPHY.raisedRotationLambda, t);
    out.driftScale = lerp(1, PHOTOGRAPHY.raisedDriftScale, t);
    out.lookOffsetScale = lerp(1, PHOTOGRAPHY.raisedLookOffsetScale, t);
    out.bankScale = lerp(1, PHOTOGRAPHY.raisedBankScale, t);

    if (import.meta.env?.DEV) assertRestPoseUnchanged(t, out);
  }

  /**
   * The knob is framing, not distance: solve for the distance at which the
   * screen subtends `screenHeightFraction` of the view height, then offset so
   * it is the SCREEN CENTRE that lands on the view axis, not the model origin
   * — the merged geometry's origin sits at the base of the body.
   */
  private solveRaisedAnchor(fov: number): void {
    const screenHeight = FLOATING_CAMERA.screen.height * FLOATING_CAMERA.scale;
    const distance =
      screenHeight / (2 * PHOTOGRAPHY.screenHeightFraction * Math.tan((fov * DEG) / 2));

    const raised = PHOTOGRAPHY.raisedRotationDeg;
    this.euler.set(raised.x * DEG, raised.y * DEG, raised.z * DEG);
    this.rotation.setFromEuler(this.euler);

    this.scratch
      .copy(SCREEN_CENTRE_LOCAL)
      .multiplyScalar(FLOATING_CAMERA.scale)
      .applyQuaternion(this.rotation);

    this.raisedAnchor.set(0, 0, -distance).sub(this.scratch);
  }
}

/**
 * The one regression that would be invisible in a screenshot and unacceptable
 * if it happened: exploration must feel exactly as it did before this feature.
 */
function assertRestPoseUnchanged(raise: number, out: PoseBlend): void {
  if (raise !== 0) return;
  const exact =
    out.anchor.x === FLOATING_CAMERA.anchor[0] &&
    out.anchor.y === FLOATING_CAMERA.anchor[1] &&
    out.anchor.z === FLOATING_CAMERA.anchor[2] &&
    out.pitch === FLOATING_CAMERA.rotationDeg.x * DEG &&
    out.yaw === FLOATING_CAMERA.rotationDeg.y * DEG &&
    out.roll === FLOATING_CAMERA.rotationDeg.z * DEG &&
    out.followLambda === FLOATING_CAMERA.followLambda &&
    out.rotationLambda === FLOATING_CAMERA.rotationLambda &&
    out.driftScale === 1 &&
    out.lookOffsetScale === 1 &&
    out.bankScale === 1;
  console.assert(exact, 'CameraPose: the rest pose no longer matches the pre-photography values');
}
```

The import line is exactly `import { DEG, lerp, spring, type SpringState } from '../util/math';` — `saturate` is not needed here.

- [ ] **Step 4: Run the tests**

```bash
npm test
```

Expected: PASS, all `CameraPose` tests green.

- [ ] **Step 5: Type-check and commit**

```bash
npx tsc --noEmit
git add src/camera/CameraPose.ts src/camera/CameraPose.test.ts
git commit -m "CameraPose: the raise spring and the rest/raised blend"
```

---

## Task 5: FloatingCamera consumes the pose blend

**Files:**
- Modify: `src/camera/FloatingCamera.ts` (constructor, `update`, `updateTarget`)

**Interfaces:**
- Consumes: `CameraPose`, `PoseBlend`, `createPoseBlend` from Task 4
- Produces: `FloatingCamera` takes a `CameraPose` as its fourth constructor argument and exposes an `object` getter returning `THREE.Object3D | null`, which Tasks 7 and 13 use to reach the model without touching privates. (The rear screen mesh is reached through `LiveCameraScreen.surface`, not through `FloatingCamera` — see Tasks 7 and 13.)

- [ ] **Step 1: Add the pose to the constructor and fields**

In `src/camera/FloatingCamera.ts`, add to the imports:

```ts
import { createPoseBlend, type CameraPose, type PoseBlend } from './CameraPose';
```

Add the field beside the existing private fields:

```ts
  private readonly pose: PoseBlend = createPoseBlend();
```

And extend the constructor:

```ts
  constructor(
    private readonly player: Player,
    private readonly look: FirstPersonCamera,
    private readonly screen: CameraScreen,
    private readonly raise: CameraPose,
  ) {}
```

Add a public accessor so `Viewfinder` and `CameraInteraction` can reach the model without reaching into privates:

```ts
  /** The merged camera object, once loaded. Null before `init`. */
  get object(): THREE.Object3D | null {
    return this.model;
  }
```

- [ ] **Step 2: Advance the spring and use the blended lambdas in `update`**

Replace the body of `update`:

```ts
  update(dt: number, elapsed: number): void {
    if (!this.viewCamera || !this.model || !this.initializedPose || dt <= 0) return;
    this.raise.update(dt);
    this.updateTarget(elapsed, dt);

    const positionAlpha = 1 - Math.exp(-this.pose.followLambda * dt);
    this.root.position.lerp(this.targetPosition, positionAlpha);
    const rotationAlpha = 1 - Math.exp(-this.pose.rotationLambda * dt);
    this.root.quaternion.slerp(this.targetQuaternion, rotationAlpha);
    this.screen.update?.(dt, elapsed);
  }
```

- [ ] **Step 3: Blend the target**

Replace `updateTarget`. Every change is multiplied by a scale that is exactly 1 at `raise = 0`, so the resting arithmetic is unchanged:

```ts
  private updateTarget(elapsed: number, dt: number): void {
    if (!this.viewCamera) return;

    this.raise.resolve(this.viewCamera.fov, this.pose);
    const pose = this.pose;

    const speed = saturate(this.player.speed / 1.9);
    const accel = dt > 0 ? (speed - this.previousSpeed) / dt : 0;
    this.previousSpeed = speed;

    const t = elapsed * FLOATING_CAMERA.idleDrift.rate;
    const drift = FLOATING_CAMERA.idleDrift.amount * pose.driftScale;
    const driftY = (Math.sin(t) + Math.sin(t * 1.63 + 1.2) * 0.4) * drift;
    const driftX = Math.sin(t * 0.83 + 2.4) * 0.5 * drift;

    this.local.copy(pose.anchor);
    this.local.y += driftY + speed * FLOATING_CAMERA.movementLift;
    this.local.x += driftX;

    // Inertia: camera pushes into the screen when accelerating, pulls back when stopping
    this.local.z += clamp(accel * 0.05, -0.08, 0.08);

    const lookOffset = FLOATING_CAMERA.lookOffset * pose.lookOffsetScale;
    this.local.x -= clamp(this.look.yawRate, -2.2, 2.2) * lookOffset;
    this.local.y += clamp(this.look.pitchRate, -1.8, 1.8) * lookOffset * 0.45;

    this.targetPosition.copy(this.local).applyQuaternion(this.viewCamera.quaternion);
    this.targetPosition.add(this.viewCamera.position);

    this.euler.set(
      pose.pitch - this.look.pitchRate * 0.012,
      pose.yaw,
      pose.roll - this.look.yawRate * FLOATING_CAMERA.bank * pose.bankScale,
    );
    this.localRotation.setFromEuler(this.euler);
    this.targetQuaternion.copy(this.viewCamera.quaternion).multiply(this.localRotation);
  }
```

Note `FLOATING_CAMERA.rotationDeg` and `DEG` are no longer read here — the angles arrive already in radians from `CameraPose`. Remove `DEG` from the import if `noUnusedLocals` complains.

- [ ] **Step 4: Update the wiring so it still compiles**

In `src/main.ts`, add the import and the instance:

```ts
import { CameraPose } from './camera/CameraPose';
```

```ts
const cameraPose = new CameraPose();
```

and pass it:

```ts
engine.add(new FloatingCamera(player, look, new StaticCameraScreen(), cameraPose));
```

- [ ] **Step 5: Verify the rest pose is genuinely unchanged**

```bash
npx tsc --noEmit
npm test
```

Reload the preview and take a screenshot. The camera must sit in exactly the same place, moving exactly as before — nothing is raised yet, because nothing calls `setRaised`. Check the console: the `CameraPose: the rest pose no longer matches` assertion must not fire.

- [ ] **Step 6: Commit**

```bash
git add src/camera/FloatingCamera.ts src/main.ts
git commit -m "FloatingCamera targets the blended pose instead of the fixed anchor"
```

---

## Task 6: PhotographyMode — right-click to raise, and input gating

**Files:**
- Create: `src/photography/CameraActions.ts`
- Create: `src/photography/PhotographyMode.ts`
- Modify: `src/main.ts`

**Interfaces:**
- Consumes: `CameraPose` (Task 4), `PhotoState`/`createPhotoState` and `ExposureModel` (Task 3), `InputState` from `src/player/input/InputState`
- Produces:
  - `interface CameraActions` — the full semantic surface
  - `class PhotographyMode implements System, CameraActions` with `readonly state: PhotoState` and `readonly pose: CameraPose`
  - Constructor is `(input: InputState)` here. **Task 15 extends it to `(input, height: HeightField)`** for the focus ray, and updates the `main.ts` call site.

This is the first task with a visible result you can feel. After it, right-click raises the camera into a shooting pose with real spring motion and movement drops to a shuffle.

- [ ] **Step 1: Create the actions interface**

Create `src/photography/CameraActions.ts`:

```ts
import type { SettingId } from './PhotoState';

/**
 * The whole semantic surface of the camera. Mouse, raycasts and future touch
 * gestures all invoke exactly these — nothing else may reach into PhotoState.
 * This is what keeps a desktop-only assumption from leaking into the design.
 */
export interface CameraActions {
  enterPhotographyMode(): void;
  exitPhotographyMode(): void;
  /** Split so the cap can depress on `down` and only fire on a matching `up`. */
  shutter(phase: 'down' | 'up'): void;
  /** `uv` omitted focuses the centre of the frame. */
  focus(uv?: { x: number; y: number }): void;
  /** Additive in log-mm, so a step feels the same at 24mm and at 120mm. */
  zoom(deltaLogMm: number): void;
  selectSetting(id: SettingId | null): void;
  /** Steps the selected setting. `delta` is in ladder indices. */
  changeSetting(delta: number): void;
}
```

- [ ] **Step 2: Create the mode system**

Create `src/photography/PhotographyMode.ts`:

```ts
import { PHOTOGRAPHY } from '../core/Settings';
import type { System } from '../core/System';
import { CameraPose } from '../camera/CameraPose';
import type { InputState } from '../player/input/InputState';
import { clamp, damp, lerp } from '../util/math';
import {
  APERTURES,
  applyModeCoupling,
  EXPOSURES,
  ISOS,
  SHUTTERS,
} from './ExposureModel';
import type { CameraActions } from './CameraActions';
import {
  createPhotoState,
  SHOOTING_MODES,
  touch,
  type PhotoState,
  type SettingId,
} from './PhotoState';

/**
 * Owns the mode and implements every semantic action. Registered BEFORE the
 * look system so it can scale the shared input state in place — which is how
 * movement is gated without touching Player.ts or FirstPersonCamera.ts.
 */
export class PhotographyMode implements System, CameraActions {
  readonly pose = new CameraPose();
  readonly state: PhotoState = createPhotoState(PHOTOGRAPHY.lens.startMm);

  /** Set by CameraInteraction in phase B. Null means nothing is hovered. */
  onCapture: (() => void) | null = null;

  constructor(private readonly input: InputState) {}

  update(dt: number): void {
    if (dt <= 0) return;

    const raise = clamp(this.pose.raise, 0, 1);
    const move = lerp(1, PHOTOGRAPHY.moveScale, raise);
    const look = lerp(1, PHOTOGRAPHY.lookScale, raise);

    this.input.moveForward *= move;
    this.input.moveRight *= move;
    this.input.lookDeltaYaw *= look;
    this.input.lookDeltaPitch *= look;

    const next = damp(
      this.state.focalMm,
      this.state.targetFocalMm,
      PHOTOGRAPHY.lens.lambda,
      dt,
    );
    if (Math.round(next) !== Math.round(this.state.focalMm)) touch(this.state);
    this.state.focalMm = next;
  }

  enterPhotographyMode(): void {
    if (this.pose.isRaised) return;
    this.pose.setRaised(true);
    touch(this.state);
  }

  exitPhotographyMode(): void {
    if (!this.pose.isRaised) return;
    this.pose.setRaised(false);
    this.state.selected = null;
    touch(this.state);
  }

  togglePhotographyMode(): void {
    if (this.pose.isRaised) this.exitPhotographyMode();
    else this.enterPhotographyMode();
  }

  shutter(phase: 'down' | 'up'): void {
    if (phase === 'down' || !this.pose.isRaised) return;
    this.state.remainingShots = Math.max(0, this.state.remainingShots - 1);
    touch(this.state);
    this.onCapture?.();
  }

  focus(uv?: { x: number; y: number }): void {
    this.state.focusUv.x = uv?.x ?? 0.5;
    this.state.focusUv.y = uv?.y ?? 0.5;
    // The distance itself is filled in by the focus ray in phase B.
    this.state.focusConfirmed = false;
    touch(this.state);
  }

  zoom(deltaLogMm: number): void {
    const { minMm, maxMm } = PHOTOGRAPHY.lens;
    const next = Math.exp(clamp(Math.log(this.state.targetFocalMm) + deltaLogMm,
      Math.log(minMm), Math.log(maxMm)));
    this.state.targetFocalMm = next;
  }

  selectSetting(id: SettingId | null): void {
    if (this.state.selected === id) return;
    this.state.selected = id;
    touch(this.state);
  }

  changeSetting(delta: number): void {
    const id = this.state.selected;
    if (id === null || delta === 0) return;
    const step = Math.trunc(delta);
    if (step === 0) return;
    const state = this.state;

    switch (id) {
      case 'focal':
        this.zoom(step * PHOTOGRAPHY.lens.wheelStep);
        return;
      case 'aperture':
        state.apertureIndex = clamp(state.apertureIndex + step, 0, APERTURES.length - 1);
        break;
      case 'shutterSpeed':
        state.shutterIndex = clamp(state.shutterIndex + step, 0, SHUTTERS.length - 1);
        break;
      case 'iso':
        state.isoIndex = clamp(state.isoIndex + step, 0, ISOS.length - 1);
        break;
      case 'exposure':
        state.exposureIndex = clamp(state.exposureIndex + step, 0, EXPOSURES.length - 1);
        break;
      case 'mode': {
        const index = SHOOTING_MODES.indexOf(state.mode);
        const count = SHOOTING_MODES.length;
        state.mode = SHOOTING_MODES[(index + step % count + count) % count]!;
        break;
      }
    }

    applyModeCoupling(state, id);
    touch(state);
  }
}
```

- [ ] **Step 3: Wire it into main.ts**

In `src/main.ts`, replace the `CameraPose` import and instance added in Task 5 with the mode:

```ts
import { PhotographyMode } from './photography/PhotographyMode';
```

```ts
const photography = new PhotographyMode(input);
```

Register it **immediately before** `look`, and pass its pose to the floating camera:

```ts
engine.add(engine.quality.isTouch ? touchInput : desktopInput);
engine.add(photography);
engine.add(look);
engine.add(player);
engine.add(new FloatingCamera(player, look, new StaticCameraScreen(), photography.pose));
```

Remove the standalone `const cameraPose = new CameraPose();` line and its import.

- [ ] **Step 4: Add a temporary right-click binding**

Still in `src/main.ts`, below the pointer-lock handler. This is temporary scaffolding; Task 13 replaces it with `PhotoDesktopInput`.

```ts
// Temporary until PhotoDesktopInput lands. Right-click is the toggle; Escape is
// consumed by the browser as its pointer-lock release, so we mirror that here.
canvas.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  photography.togglePhotographyMode();
});
```

And extend the existing `pointerlockchange` handler:

```ts
document.addEventListener('pointerlockchange', () => {
  if (!desktopInput.isLocked) {
    photography.exitPhotographyMode();
    boot.show();
  }
});
```

- [ ] **Step 5: Feel it**

```bash
npx tsc --noEmit
npm test
```

Reload the preview, click to begin, then right-click. Verify by screenshot and by watching:

- the camera lifts from the lower right into the centre of the view, arcing rather than sliding
- it overshoots slightly and settles
- WASD still moves you, but slowly
- right-click again lowers it along a naturally different path
- no console errors, and no rest-pose assertion

- [ ] **Step 6: Commit**

```bash
git add src/photography/CameraActions.ts src/photography/PhotographyMode.ts src/main.ts
git commit -m "Photography Mode: right-click raises the camera, movement drops to a shuffle"
```

---

## Task 7: The live viewfinder

**Files:**
- Create: `src/camera/Viewfinder.ts`
- Modify: `src/camera/FloatingCamera.ts` (put the model on layer 1)
- Modify: `src/camera/CameraScreen.ts`
- Create: `src/camera/LiveCameraScreen.ts`
- Modify: `src/main.ts`

**Interfaces:**
- Consumes: `PhotographyMode` (Task 6), `PHOTOGRAPHY`/`VIEWFINDER` (Task 1)
- Produces:
  - `CameraScreen` gains `readonly surface?: THREE.Mesh` and `setFeed?(texture: THREE.Texture | null): void`
  - `class LiveCameraScreen implements CameraScreen` with `readonly surface: THREE.Mesh`. Constructor takes nothing here; **Task 11 extends it to `(photography: PhotographyMode)`**
  - `class Viewfinder implements System` with `readonly texture: THREE.Texture`, `rung: number`, `readonly lastCost: { calls: number; triangles: number }`, and `setRung(rung: number): void`. Constructor is `(floating, photography, screen)` here; **Task 8 extends it to `(floating, photography, screen, engine)`**

Both constructor changes require updating the `main.ts` call sites in their own task. The construction order stays `photography → screen → floatingCamera → viewfinder → interaction`, which has no cycles.

- [ ] **Step 1: Put the camera model on its own layer**

In `src/camera/FloatingCamera.ts`, add a constant near `HIT_VOLUME_SCALE`:

```ts
/**
 * The floating camera lives on its own layer so the viewfinder pass can exclude
 * it. Without this the camera appears inside its own screen, recursively.
 */
export const CAMERA_LAYER = 1;
```

And at the end of `init`, after `ctx.scene.add(this.root)`:

```ts
    this.root.traverse((child) => child.layers.set(CAMERA_LAYER));
    ctx.camera.layers.enable(CAMERA_LAYER);
```

`layers.set` replaces the mask rather than adding to it, so the model is on layer 1 and layer 1 only. The main camera sees layers 0 and 1; the viewfinder camera will see layer 0 only.

- [ ] **Step 2: Extend the CameraScreen seam**

Replace `src/camera/CameraScreen.ts`:

```ts
import type * as THREE from 'three';

/**
 * The rear display seam. `StaticCameraScreen` is the emissive first-milestone
 * implementation and remains the hard floor when render targets are
 * unavailable; `LiveCameraScreen` adds the viewfinder and the interface.
 */
export interface CameraScreen {
  attach(model: THREE.Object3D): void;
  update?(dt: number, elapsed: number): void;
  dispose(): void;
  /** The pickable rear surface, if this screen is interactive. */
  readonly surface?: THREE.Mesh;
  /** Hands over the live viewfinder texture, if this screen can show one. */
  setFeed?(texture: THREE.Texture | null): void;
}
```

- [ ] **Step 3: Create a minimal LiveCameraScreen**

This task gives it a plain unlit material showing the feed. Task 10 replaces the material with the full composite; keeping them separate means the framing can be judged before any interface is drawn on it.

Create `src/camera/LiveCameraScreen.ts`:

```ts
import * as THREE from 'three';
import { FLOATING_CAMERA } from '../core/Settings';
import type { CameraScreen } from './CameraScreen';

/** The rear display, showing what the lens sees. */
export class LiveCameraScreen implements CameraScreen {
  readonly surface: THREE.Mesh;

  private readonly material: THREE.MeshBasicMaterial;

  constructor() {
    const config = FLOATING_CAMERA.screen;
    this.material = new THREE.MeshBasicMaterial({
      color: 0x000000,
      toneMapped: false,
      side: THREE.FrontSide,
    });
    this.surface = new THREE.Mesh(
      new THREE.PlaneGeometry(config.width, config.height),
      this.material,
    );
    this.surface.name = 'CameraScreen';
    this.surface.position.set(...config.position);
    this.surface.renderOrder = 2;
  }

  attach(model: THREE.Object3D): void {
    model.add(this.surface);
  }

  setFeed(texture: THREE.Texture | null): void {
    this.material.map = texture;
    this.material.color.setScalar(texture ? 1 : 0);
    this.material.needsUpdate = true;
  }

  dispose(): void {
    this.surface.removeFromParent();
    this.surface.geometry.dispose();
    this.material.dispose();
  }
}
```

- [ ] **Step 4: Create the Viewfinder**

Create `src/camera/Viewfinder.ts`:

```ts
import * as THREE from 'three';
import { FLOATING_CAMERA, PHOTOGRAPHY, VIEWFINDER } from '../core/Settings';
import type { EngineContext, System } from '../core/System';
import type { PhotographyMode } from '../photography/PhotographyMode';
import { CAMERA_LAYER, type FloatingCamera } from './FloatingCamera';

/** Local offset from the model origin to the front of the lens. */
const LENS_LOCAL = new THREE.Vector3(0, 0.3125, -0.375);

/**
 * Derived from the screen it will be displayed on, never written down twice.
 * A literal here would silently stretch the image the moment anyone retuned
 * FLOATING_CAMERA.screen — three keeps a camera's aspect and a render target's
 * pixel dimensions entirely independent, so a mismatch distorts rather than
 * letterboxes.
 */
const SCREEN_ASPECT = FLOATING_CAMERA.screen.width / FLOATING_CAMERA.screen.height;

/**
 * A 36x24mm frame. The player's naked 62 degrees is a ~20mm lens, which is why
 * every focal length in the range is a real crop rather than a decorative
 * number. Defined once, used by both the constructor and the per-frame update.
 */
function fovForFocal(focalMm: number): number {
  const half = PHOTOGRAPHY.lens.sensorHeightMm / 2;
  return 2 * Math.atan(half / focalMm) * (180 / Math.PI);
}

/**
 * A second camera rendered into a small target, active only while the camera is
 * raised — so exploration pays nothing at all for this feature.
 *
 * It sits at the LENS, not at the eye. The body lags and banks, so the image on
 * the screen drifts slightly as the camera settles, which is the detail that
 * sells the whole thing.
 */
export class Viewfinder implements System {
  /** Draw cost of the last viewfinder pass, for DevStats. */
  readonly lastCost = { calls: 0, triangles: 0 };

  rung = 0;

  private readonly camera = new THREE.PerspectiveCamera(
    fovForFocal(PHOTOGRAPHY.lens.startMm),
    SCREEN_ASPECT,
    VIEW.near,
    VIEW.far,
  );
  private readonly worldPosition = new THREE.Vector3();
  private readonly worldQuaternion = new THREE.Quaternion();
  private target: THREE.WebGLRenderTarget | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private accumulator = 0;

  constructor(
    private readonly floating: FloatingCamera,
    private readonly photography: PhotographyMode,
    private readonly screen: { setFeed?(texture: THREE.Texture | null): void },
  ) {}

  get texture(): THREE.Texture | null {
    return this.target?.texture ?? null;
  }

  init(ctx: EngineContext): void {
    this.renderer = ctx.renderer;
    this.scene = ctx.scene;
    // Layer 0 only: the camera model is on CAMERA_LAYER and must not appear
    // inside its own screen.
    this.camera.layers.disable(CAMERA_LAYER);
    this.setRung(VIEWFINDER.startRung[ctx.quality.tier]);
    this.screen.setFeed?.(this.texture);
  }

  setRung(rung: number): void {
    const clamped = Math.min(Math.max(rung, 0), VIEWFINDER.ladder.length - 1);
    if (this.target && clamped === this.rung) return;
    this.rung = clamped;

    const { width, height } = VIEWFINDER.ladder[clamped]!;
    if (this.target?.width === width && this.target.height === height) return;

    this.target?.dispose();
    this.target = new THREE.WebGLRenderTarget(width, height, {
      type: THREE.HalfFloatType,
      depthBuffer: true,
      stencilBuffer: false,
      colorSpace: THREE.LinearSRGBColorSpace,
    });
    this.screen.setFeed?.(this.target.texture);
  }

  update(dt: number): void {
    const model = this.floating.object;
    const renderer = this.renderer;
    const scene = this.scene;
    const target = this.target;
    if (!model || !renderer || !scene || !target) return;

    if (this.photography.pose.raise <= 0.001) {
      this.accumulator = 0;
      return;
    }

    const { hz } = VIEWFINDER.ladder[this.rung]!;
    if (hz <= 0) return; // Frozen: the last frame stays on the display.

    this.accumulator += dt;
    const interval = 1 / hz;
    if (this.accumulator < interval) return;
    // Carried rather than zeroed, so the cadence averages exactly to `hz`,
    // and clamped so a stall cannot trigger a catch-up burst.
    this.accumulator = Math.min(this.accumulator - interval, interval);

    this.placeCamera(model);

    const before = renderer.info.render;
    const calls = before.calls;
    const triangles = before.triangles;

    renderer.setRenderTarget(target);
    // PostFX turns autoClear off, so this pass must clear for itself.
    renderer.clear();
    renderer.render(scene, this.camera);
    renderer.setRenderTarget(null);

    this.lastCost.calls = renderer.info.render.calls - calls;
    this.lastCost.triangles = renderer.info.render.triangles - triangles;
  }

  dispose(): void {
    this.screen.setFeed?.(null);
    this.target?.dispose();
    this.target = null;
  }

  private placeCamera(model: THREE.Object3D): void {
    model.getWorldQuaternion(this.worldQuaternion);
    this.worldPosition
      .copy(LENS_LOCAL)
      .multiplyScalar(FLOATING_CAMERA.scale)
      .applyQuaternion(this.worldQuaternion);
    model.getWorldPosition(this.camera.position);
    this.camera.position.add(this.worldPosition);
    this.camera.quaternion.copy(this.worldQuaternion);

    // A 36x24mm frame, so vertical fov is 2*atan(12/f). The player's naked 62
    // degrees is a ~20mm lens, which is why every focal length here is a real
    // crop rather than a decorative number.
    const half = PHOTOGRAPHY.lens.sensorHeightMm / 2;
    const fov = 2 * Math.atan(half / this.photography.state.focalMm) * (180 / Math.PI);
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }
}
```

- [ ] **Step 5: Wire it up**

In `src/main.ts`:

```ts
import { LiveCameraScreen } from './camera/LiveCameraScreen';
import { Viewfinder } from './camera/Viewfinder';
```

```ts
const screen = new LiveCameraScreen();
const floatingCamera = new FloatingCamera(player, look, screen, photography.pose);
engine.add(floatingCamera);
engine.add(new Viewfinder(floatingCamera, photography, screen));
```

Remove the `StaticCameraScreen` import if it is now unused — but keep the file; it is the documented hard floor.

- [ ] **Step 6: Add wheel zoom, temporarily**

In `src/main.ts`, beside the temporary `contextmenu` handler:

```ts
// Temporary until PhotoDesktopInput lands.
canvas.addEventListener('wheel', (event) => {
  if (!photography.pose.isRaised) return;
  event.preventDefault();
  photography.zoom(-Math.sign(event.deltaY) * PHOTOGRAPHY.lens.wheelStep);
}, { passive: false });
```

Add `import { PHOTOGRAPHY } from './core/Settings';` to `main.ts`.

- [ ] **Step 7: Verify**

```bash
npx tsc --noEmit
npm test
```

In the preview: right-click to raise. Expected:

- the rear screen shows the world live
- the camera body does **not** appear inside its own screen
- the wheel changes the framing on the screen only, never the player's view
- zooming in reveals detail the naked view compresses; zooming out stops just tighter than the naked view
- `DevStats` still reads ~170 fps at rest; while raised, calls roughly double on the frames the viewfinder renders

Read console messages: expected none.

- [ ] **Step 8: Commit**

```bash
git add src/camera/Viewfinder.ts src/camera/LiveCameraScreen.ts src/camera/CameraScreen.ts src/camera/FloatingCamera.ts src/main.ts
git commit -m "Live viewfinder with real focal length, active only while raised"
```

---

## Task 8: The adaptive ladder

**Files:**
- Create: `src/camera/ViewfinderWatchdog.ts`
- Create: `src/camera/ViewfinderWatchdog.test.ts`
- Modify: `src/camera/Viewfinder.ts`
- Modify: `src/core/Quality.ts` (add the `?vf=` override)
- Modify: `src/dev/DevStats.ts`

**Interfaces:**
- Consumes: `VIEWFINDER` (Task 1), `Viewfinder` (Task 7)
- Produces: `class ViewfinderWatchdog { readonly rung: number; reset(): void; update(dt: number, presentedDelta: number, targetRate: number): number }`; `forcedViewfinderRung(): number | null` from `Quality.ts`

- [ ] **Step 1: Write the failing test**

Create `src/camera/ViewfinderWatchdog.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test
```

Expected: FAIL — cannot resolve `./ViewfinderWatchdog`.

- [ ] **Step 3: Create the watchdog**

Create `src/camera/ViewfinderWatchdog.ts`:

```ts
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

    this.bucketTime += dt;
    this.bucketFrames += presentedDelta;
    if (this.bucketTime < config.bucketSeconds) return this.rung;

    this.buckets.push(this.bucketFrames / this.bucketTime);
    this.bucketTime = 0;
    this.bucketFrames = 0;
    if (this.buckets.length > config.recoverBuckets) this.buckets.shift();

    if (this.sinceChange < config.cooldownSeconds) return this.rung;

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
      if (failed >= 2) this.floorRung = Math.max(this.floorRung, this.rung + 1);
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
```

- [ ] **Step 4: Run the tests**

```bash
npm test
```

Expected: PASS, all watchdog tests green. If the latch test fails, check that `failures` is keyed on the rung being *left*, not the one being entered.

- [ ] **Step 5: Add the URL override**

In `src/core/Quality.ts`, below `forcedFrameCap`:

```ts
/** `?vf=0..3` pins a viewfinder ladder rung, for exercising the ends by hand. */
export function forcedViewfinderRung(): number | null {
  const raw = queryParam('vf');
  if (raw === null) return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}
```

- [ ] **Step 6: Wire the watchdog into the Viewfinder**

In `src/camera/Viewfinder.ts`, add the imports:

```ts
import type { Engine } from '../core/Engine';
import { forcedViewfinderRung } from '../core/Quality';
import { ViewfinderWatchdog } from './ViewfinderWatchdog';
```

Add the constructor argument `private readonly engine: Engine` and these fields:

```ts
  private watchdog: ViewfinderWatchdog | null = null;
  private pinnedRung: number | null = null;
  private lastPresented = 0;
  private targetRate = 60;
  private wasRaised = false;
```

In `init`, after `setRung(...)`:

```ts
    this.pinnedRung = forcedViewfinderRung();
    const start = this.pinnedRung ?? VIEWFINDER.startRung[ctx.quality.tier];
    this.setRung(start);
    this.watchdog = new ViewfinderWatchdog(start);
    this.targetRate = Number.isFinite(ctx.quality.frameCap) ? ctx.quality.frameCap : 60;
    document.addEventListener('visibilitychange', this.onVisibilityChange);
```

with the handler and its removal in `dispose`:

```ts
  private readonly onVisibilityChange = (): void => {
    // Returning from a hidden tab produces a gap that is not a performance
    // signal.
    this.watchdog?.reset();
  };
```

At the top of `update`, before the raise check:

```ts
    const presented = this.engine.presentedFrames;
    const presentedDelta = presented - this.lastPresented;
    this.lastPresented = presented;

    const raised = this.photography.pose.raise > 0.001;
    if (raised !== this.wasRaised) {
      this.wasRaised = raised;
      this.watchdog?.reset();
      // On an uncapped display, what the machine was managing just before the
      // camera came up is the only fair thing to compare against.
      if (raised && !Number.isFinite(this.engine.quality.frameCap)) {
        this.targetRate = Math.max(1, presentedDelta / Math.max(dt, 1e-4));
      }
    }
    if (raised && this.pinnedRung === null && this.watchdog) {
      this.setRung(this.watchdog.update(dt, presentedDelta, this.targetRate));
    }
```

Note `setRung` already early-returns when the resolution is unchanged, so rung 2 → 3 keeps the same target and simply stops rendering.

- [ ] **Step 7: Dim the frozen frame**

In `src/camera/LiveCameraScreen.ts`, add:

```ts
  /** Rung 3 keeps the last frame and drops the refresh rate, like a real LCD. */
  setFrozen(frozen: boolean): void {
    this.material.color.setScalar(frozen ? FLOATING_CAMERA.screen.frozenDim ?? 1 : 1);
  }
```

Simpler and without touching `FLOATING_CAMERA`: import `VIEWFINDER` and use `VIEWFINDER.frozenDim`. Call it from `Viewfinder.setRung`:

```ts
    this.screen.setFrozen?.(VIEWFINDER.ladder[clamped]!.hz === 0);
```

Widen the `screen` constructor parameter type to include `setFrozen?(frozen: boolean): void`.

- [ ] **Step 8: Show the cost in DevStats**

In `src/dev/DevStats.ts`, add an optional viewfinder reference to the constructor and one line to the readout:

```ts
  constructor(
    private readonly engine: Engine,
    private readonly viewfinder?: { readonly lastCost: { calls: number; triangles: number }; readonly rung: number },
  ) {
```

and inside the `textContent` array, after the tier line:

```ts
      this.viewfinder
        ? `vf r${this.viewfinder.rung}  +${this.viewfinder.lastCost.calls} calls  +${(this.viewfinder.lastCost.triangles / 1000).toFixed(0)}k`
        : 'vf off',
```

Pass it in `main.ts`: `engine.add(new DevStats(engine, viewfinder));`

`PostFX.render()` calls `renderer.info.reset()` before its first pass, which would otherwise erase the viewfinder's counts entirely — this is why `Viewfinder` records its own deltas rather than reading the shared totals.

- [ ] **Step 9: Verify**

```bash
npx tsc --noEmit
npm test
```

In the preview:

- `?vf=0` — raised, the screen is sharp and smooth; note the `+calls` line
- `?vf=3` — raised, the screen shows a frozen dimmed frame and `+0 calls`
- `?quality=medium&fps=30` — raised, `DevStats` holds 30 fps
- leave it raised for 30 seconds on `high` and confirm the rung does not drift

- [ ] **Step 10: Commit**

```bash
git add src/camera/ViewfinderWatchdog.ts src/camera/ViewfinderWatchdog.test.ts src/camera/Viewfinder.ts src/camera/LiveCameraScreen.ts src/core/Quality.ts src/dev/DevStats.ts src/main.ts
git commit -m "Adaptive viewfinder ladder with median buckets and explicit hysteresis"
```

---

# ⛔ STOP — Phase A review gate

Do not start Task 9. Report to the owner:

1. A screenshot at rest and one raised
2. `DevStats` at rest and raised on `high`, and on `?quality=medium&fps=30`
3. Confirmation that `npm test`, `npx tsc --noEmit` and `npx vite build` are clean

Ask specifically about **the raise timing** (`PHOTOGRAPHY.raise.omega` / `zeta`) and **the framing** (`PHOTOGRAPHY.screenHeightFraction`, currently putting the camera ~0.24 m from the eye). Both are single constants and both are far cheaper to change now than after an interface is drawn on top of them.

---

# Phase B — the interface

## Task 9: InteractionZones

**Files:**
- Create: `src/photography/InteractionZones.ts`
- Create: `src/photography/InteractionZones.test.ts`

**Interfaces:**
- Consumes: `SettingId` from `PhotoState` (Task 3)
- Produces:
  - `type ZoneId = SettingId | 'focusPoint' | 'focusMode' | 'metering' | 'status'`
  - `interface Zone { id: ZoneId; x0: number; x1: number; y0: number; y1: number; adjustable: boolean; settingId: SettingId | null }`
  - `const SCREEN_ZONES: readonly Zone[]`
  - `zoneAtUv(u: number, v: number): Zone | null` — `v` is a three.js uv, y-up
  - `zoneCentreUv(zone: Zone): { u: number; v: number }`

- [ ] **Step 1: Write the failing test**

Create `src/photography/InteractionZones.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { SCREEN_ZONES, zoneAtUv, zoneCentreUv, type Zone } from './InteractionZones';

const TOP = SCREEN_ZONES.filter((z) => z.y0 === 0);
const BOTTOM = SCREEN_ZONES.filter((z) => z.y1 === 1);

function assertRowIsExhaustive(row: readonly Zone[]): void {
  const sorted = [...row].sort((a, b) => a.x0 - b.x0);
  expect(sorted[0]!.x0).toBe(0);
  expect(sorted[sorted.length - 1]!.x1).toBe(1);
  for (let i = 1; i < sorted.length; i++) {
    expect(sorted[i]!.x0).toBe(sorted[i - 1]!.x1);
  }
}

describe('the partition is exhaustive, so there is nothing to miss', () => {
  it('tiles the top bar edge to edge with no gaps and no overlaps', () => {
    assertRowIsExhaustive(TOP);
  });

  it('tiles the bottom bar edge to edge with no gaps and no overlaps', () => {
    assertRowIsExhaustive(BOTTOM);
  });

  it('finds a zone at every point on the screen', () => {
    for (let u = 0.01; u < 1; u += 0.017) {
      for (let v = 0.01; v < 1; v += 0.017) {
        expect(zoneAtUv(u, v), `no zone at ${u.toFixed(2)},${v.toFixed(2)}`).not.toBeNull();
      }
    }
  });
});

describe('lookup', () => {
  it('reads uv y-up, so the top bar is at high v', () => {
    expect(zoneAtUv(0.1, 0.97)!.id).toBe('mode');
    expect(zoneAtUv(0.1, 0.03)!.id).toBe('focal');
  });

  it('puts the image area between the two bars', () => {
    expect(zoneAtUv(0.5, 0.5)!.id).toBe('focusPoint');
  });

  it('returns null outside the surface rather than clamping', () => {
    expect(zoneAtUv(-0.01, 0.5)).toBeNull();
    expect(zoneAtUv(0.5, 1.01)).toBeNull();
  });
});

describe('zone metadata', () => {
  it('marks exactly the five exposure controls adjustable', () => {
    const adjustable = SCREEN_ZONES.filter((z) => z.adjustable).map((z) => z.id).sort();
    expect(adjustable).toEqual(['aperture', 'exposure', 'focal', 'iso', 'shutterSpeed']);
  });

  it('never names a zone `shutter`, which would read as the capture action', () => {
    expect(SCREEN_ZONES.some((z) => (z.id as string) === 'shutter')).toBe(false);
  });

  it('centres are inside their own zone', () => {
    for (const zone of SCREEN_ZONES) {
      const { u, v } = zoneCentreUv(zone);
      expect(zoneAtUv(u, v)!.id).toBe(zone.id);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test
```

Expected: FAIL — cannot resolve `./InteractionZones`.

- [ ] **Step 3: Create the zone table**

Create `src/photography/InteractionZones.ts`:

```ts
import type { SettingId } from './PhotoState';

/**
 * One table drives BOTH the drawing and the hit test, so a label can never
 * drift from the thing it activates.
 *
 * Authored with y measured from the TOP, matching the canvas. `zoneAtUv` takes
 * a three.js uv, which is y-up, and converts.
 *
 * Each bar tiles edge to edge. That exhaustive partition — not padding — is the
 * main reason targeting never has to be pixel-perfect: every point on the
 * screen belongs to some zone, so there is nothing to miss.
 */

export type ZoneId = SettingId | 'focusPoint' | 'focusMode' | 'metering' | 'status';

export interface Zone {
  readonly id: ZoneId;
  readonly x0: number;
  readonly x1: number;
  /** From the top. */
  readonly y0: number;
  readonly y1: number;
  readonly adjustable: boolean;
  readonly settingId: SettingId | null;
}

const TOP_BAR = 0.115;
const BOTTOM_BAR = 0.833;

function zone(
  id: ZoneId,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  settingId: SettingId | null = null,
  adjustable = false,
): Zone {
  return { id, x0, x1, y0, y1, settingId, adjustable };
}

export const SCREEN_ZONES: readonly Zone[] = [
  zone('mode', 0.0, 0.24, 0, TOP_BAR, 'mode'),
  zone('focusMode', 0.24, 0.42, 0, TOP_BAR),
  zone('metering', 0.42, 0.6, 0, TOP_BAR),
  zone('status', 0.6, 1.0, 0, TOP_BAR),

  zone('focusPoint', 0.0, 1.0, TOP_BAR, BOTTOM_BAR),

  zone('focal', 0.0, 0.16, BOTTOM_BAR, 1, 'focal', true),
  zone('aperture', 0.16, 0.28, BOTTOM_BAR, 1, 'aperture', true),
  zone('shutterSpeed', 0.28, 0.41, BOTTOM_BAR, 1, 'shutterSpeed', true),
  zone('iso', 0.41, 0.59, BOTTOM_BAR, 1, 'iso', true),
  zone('exposure', 0.59, 1.0, BOTTOM_BAR, 1, 'exposure', true),
];

/** `v` is a three.js uv: 0 at the bottom of the surface. */
export function zoneAtUv(u: number, v: number): Zone | null {
  if (u < 0 || u > 1 || v < 0 || v > 1) return null;
  const y = 1 - v;
  for (const candidate of SCREEN_ZONES) {
    if (u >= candidate.x0 && u <= candidate.x1 && y >= candidate.y0 && y <= candidate.y1) {
      return candidate;
    }
  }
  return null;
}

export function zoneCentreUv(target: Zone): { u: number; v: number } {
  return {
    u: (target.x0 + target.x1) / 2,
    v: 1 - (target.y0 + target.y1) / 2,
  };
}
```

- [ ] **Step 4: Run the tests, type-check and commit**

```bash
npm test
npx tsc --noEmit
git add src/photography/InteractionZones.ts src/photography/InteractionZones.test.ts
git commit -m "Interaction zones: one table for drawing and picking, exhaustively tiled"
```

---

## Task 10: ScreenUI — the chrome layer

**Files:**
- Create: `src/camera/ScreenUI.ts`
- Modify: `src/camera/LiveCameraScreen.ts`

**Interfaces:**
- Consumes: `PhotoState` and the `format*` helpers (Task 3), `SCREEN_ZONES` (Task 9), `PHOTOGRAPHY` (Task 1)
- Produces: `class ScreenUI { readonly texture: THREE.CanvasTexture; sync(state: PhotoState): void; dispose(): void }`

`sync` redraws only when `state.revision` has changed since the last draw. Everything that moves every frame is drawn in the shader instead (Task 11), because uploading a 1024×683 canvas per frame is 2.8 MB of traffic and unacceptable on a phone.

- [ ] **Step 1: Create ScreenUI**

Create `src/camera/ScreenUI.ts`:

```ts
import * as THREE from 'three';
import { PHOTOGRAPHY } from '../core/Settings';
import {
  formatAperture,
  formatExposure,
  formatFocal,
  formatIso,
  formatShutter,
} from '../photography/ExposureModel';
import { SCREEN_ZONES } from '../photography/InteractionZones';
import type { PhotoState } from '../photography/PhotoState';

const WIDTH = 1024;
const HEIGHT = 683;
const FONT = 'Helvetica Neue, Helvetica, Arial, sans-serif';

function hex(value: number, alpha = 1): string {
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * The typography layer. Redrawn only when something it draws has changed, which
 * is what keeps a 2.8MB texture upload off the per-frame budget.
 */
export class ScreenUI {
  readonly texture: THREE.CanvasTexture;

  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private drawnRevision = -1;

  constructor() {
    this.canvas.width = WIDTH;
    this.canvas.height = HEIGHT;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable for the camera screen');
    this.ctx = ctx;

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.texture.generateMipmaps = true;
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
  }

  sync(state: PhotoState): void {
    if (state.revision === this.drawnRevision) return;
    this.drawnRevision = state.revision;
    this.draw(state);
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.texture.dispose();
  }

  private draw(state: PhotoState): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, WIDTH, HEIGHT);
    this.drawScrims();
    this.drawTopBar(state);
    this.drawBottomBar(state);
  }

  /** Real cameras scrim behind their overlays so type survives a bright sky. */
  private drawScrims(): void {
    const ctx = this.ctx;
    const top = ctx.createLinearGradient(0, 0, 0, HEIGHT * 0.13);
    top.addColorStop(0, 'rgba(0,0,0,0.42)');
    top.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = top;
    ctx.fillRect(0, 0, WIDTH, HEIGHT * 0.13);

    const bottom = ctx.createLinearGradient(0, HEIGHT, 0, HEIGHT * 0.82);
    bottom.addColorStop(0, 'rgba(0,0,0,0.5)');
    bottom.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = bottom;
    ctx.fillRect(0, HEIGHT * 0.82, WIDTH, HEIGHT * 0.18);
  }

  private drawTopBar(state: PhotoState): void {
    const ctx = this.ctx;
    const { primary, secondary } = PHOTOGRAPHY.screenUI;

    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillStyle = hex(primary);
    ctx.font = `600 31px ${FONT}`;
    ctx.fillText(state.mode, 32, 50);

    ctx.fillStyle = hex(secondary);
    ctx.font = `18px ${FONT}`;
    ctx.fillText('AF·S', 64, 49);
    ctx.fillText('MULTI', 150, 49);

    this.drawBattery(state.battery);

    ctx.textAlign = 'right';
    ctx.fillStyle = hex(primary);
    ctx.font = `22px ${FONT}`;
    ctx.fillText(String(state.remainingShots), WIDTH - 32, 49);
  }

  private drawBattery(level: number): void {
    const ctx = this.ctx;
    const x = WIDTH - 200;
    const y = 28;
    const w = 52;
    const h = 23;
    ctx.strokeStyle = hex(PHOTOGRAPHY.screenUI.secondary);
    ctx.lineWidth = 1.6;
    ctx.strokeRect(x, y, w, h);
    ctx.fillStyle = hex(PHOTOGRAPHY.screenUI.secondary);
    ctx.fillRect(x + w + 1, y + 7, 4, 9);
    ctx.fillStyle = hex(PHOTOGRAPHY.screenUI.primary, 0.85);
    ctx.fillRect(x + 4, y + 4, (w - 8) * Math.max(0, Math.min(1, level)), h - 8);
  }

  private drawBottomBar(state: PhotoState): void {
    const ctx = this.ctx;
    // `accent` is deliberately not destructured here — the selection rail is the
    // only thing that uses it, and it reads it directly. noUnusedLocals is on.
    const { primary, secondary } = PHOTOGRAPHY.screenUI;
    const baseline = HEIGHT - 39;

    ctx.strokeStyle = hex(primary, 0.16);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, HEIGHT * 0.833);
    ctx.lineTo(WIDTH, HEIGHT * 0.833);
    ctx.stroke();

    ctx.textAlign = 'left';
    ctx.fillStyle = hex(primary);
    ctx.font = `600 40px ${FONT}`;
    ctx.fillText(formatFocal(state), 32, baseline);
    const focalWidth = ctx.measureText(formatFocal(state)).width;
    ctx.fillStyle = hex(secondary);
    ctx.font = `19px ${FONT}`;
    ctx.fillText('mm', 36 + focalWidth, baseline);

    ctx.font = `26px ${FONT}`;
    ctx.fillStyle = hex(primary);
    ctx.fillText(formatAperture(state), WIDTH * 0.175, baseline);
    ctx.fillText(formatShutter(state), WIDTH * 0.295, baseline);
    ctx.fillText(formatIso(state), WIDTH * 0.425, baseline);

    this.drawExposureRail(state, baseline);
    this.drawSelectionRail(state);
  }

  private drawExposureRail(state: PhotoState, baseline: number): void {
    const ctx = this.ctx;
    const { primary } = PHOTOGRAPHY.screenUI;
    const left = WIDTH * 0.615;
    const right = WIDTH * 0.855;

    ctx.strokeStyle = hex(primary, 0.62);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(left, baseline - 8);
    ctx.lineTo(right, baseline - 8);
    ctx.stroke();

    for (let i = 0; i <= 4; i++) {
      const x = left + ((right - left) * i) / 4;
      const tall = i === 2;
      ctx.beginPath();
      ctx.moveTo(x, baseline - 8 - (tall ? 10 : 6));
      ctx.lineTo(x, baseline - 8 + (tall ? 10 : 6));
      ctx.stroke();
    }

    // -3..+3 across the rail.
    const value = Number(formatExposure(state).replace('−', '-')) || 0;
    const marker = left + ((right - left) * (value + 3)) / 6;
    ctx.fillStyle = hex(primary);
    ctx.beginPath();
    ctx.moveTo(marker, baseline - 26);
    ctx.lineTo(marker + 6, baseline - 16);
    ctx.lineTo(marker - 6, baseline - 16);
    ctx.closePath();
    ctx.fill();

    ctx.textAlign = 'right';
    ctx.font = `24px ${FONT}`;
    ctx.fillText(formatExposure(state), WIDTH - 32, baseline);
  }

  /**
   * The single clearest signal that this is one continuous instrument rather
   * than a list of buttons. Drawn here at the target; the glide between targets
   * is animated in the shader.
   */
  private drawSelectionRail(state: PhotoState): void {
    if (state.selected === null) return;
    const target = SCREEN_ZONES.find((z) => z.settingId === state.selected);
    if (!target || target.y1 !== 1) return;

    const ctx = this.ctx;
    const pad = WIDTH * 0.012;
    ctx.fillStyle = hex(PHOTOGRAPHY.screenUI.accent);
    ctx.fillRect(target.x0 * WIDTH + pad, HEIGHT - 22, (target.x1 - target.x0) * WIDTH - pad * 2, 2.5);
  }
}
```

- [ ] **Step 2: Verify it draws**

Temporarily set `LiveCameraScreen`'s material map to `screenUI.texture` instead of the feed, reload, raise the camera and screenshot. Expected: legible white type over a transparent-black field, `56mm F2.8 1/250 ISO 400` along the bottom, `A AF·S MULTI` and a battery with `248` along the top. Then revert the temporary change.

- [ ] **Step 3: Type-check and commit**

```bash
npx tsc --noEmit
npm test
git add src/camera/ScreenUI.ts
git commit -m "ScreenUI: the chrome layer, redrawn only when a value changes"
```

---

## Task 11: screenMaterial — the composite

**Files:**
- Create: `src/camera/screenMaterial.ts`
- Modify: `src/camera/LiveCameraScreen.ts`
- Modify: `src/render/shaders/composite.glsl.ts` (export the ACES function)

**Interfaces:**
- Consumes: `ScreenUI` (Task 10), `PHOTOGRAPHY` (Task 1)
- Produces: `createScreenMaterial(): THREE.ShaderMaterial` with uniforms `uFeed`, `uChrome`, `uGain`, `uFrozen`, `uFocusRect`, `uFocusConfirm`, `uReticle`, `uReticleAlpha`, `uHoverRect`, `uPressed`, `uRoll`

- [ ] **Step 1: Export the ACES function from the composite shader**

In `src/render/shaders/composite.glsl.ts`, extract the existing ACES tonemap into an exported string constant `ACES_GLSL` and reference it from `compositeFragment` via template interpolation, so the curve is defined exactly once in the project. Read the file first to match its existing structure and naming.

- [ ] **Step 2: Create the material**

Create `src/camera/screenMaterial.ts`:

```ts
import * as THREE from 'three';
import { PHOTOGRAPHY, VIEWFINDER } from '../core/Settings';
import { ACES_GLSL } from '../render/shaders/composite.glsl';

const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * Three layers: the live feed, the chrome texture, and shapes drawn right here
 * because they move every frame. Uploading them through the canvas would cost
 * 2.8MB a frame, which a phone cannot afford.
 *
 * Output lands near PHOTOGRAPHY.screenUI.emissive so the display reads as
 * emissive after the composite's ACES, and stays below POST.bloom.threshold of
 * 1.85 so it never smears into the frame.
 */
const FRAGMENT = /* glsl */ `
precision highp float;
varying vec2 vUv;

uniform sampler2D uFeed;
uniform sampler2D uChrome;
uniform float uGain;
uniform float uFrozen;
uniform vec4  uFocusRect;      // x0, y0, x1, y1 in uv
uniform float uFocusConfirm;   // 0 searching, 1 locked
uniform vec2  uReticle;
uniform float uReticleAlpha;
uniform vec4  uHoverRect;
uniform float uPressed;
uniform float uRoll;           // radians
uniform float uEmissive;
uniform float uGridOpacity;
uniform vec3  uPrimary;
uniform vec3  uConfirm;

${ACES_GLSL}

float line(float coord, float at, float halfWidth) {
  return 1.0 - smoothstep(halfWidth * 0.5, halfWidth, abs(coord - at));
}

/** Outline of a rect, w thick, in uv. Never use backticks in this comment: the
    whole shader is a JS template literal and a backtick terminates it early. */
float rectOutline(vec2 uv, vec4 r, float w) {
  vec2 inner = step(r.xy + w, uv) * step(uv, r.zw - w);
  vec2 outer = step(r.xy, uv) * step(uv, r.zw);
  return outer.x * outer.y - inner.x * inner.y;
}

float rectFill(vec2 uv, vec4 r) {
  vec2 inside = step(r.xy, uv) * step(uv, r.zw);
  return inside.x * inside.y;
}

/** Corner ticks only, which is how a focus frame is drawn on a real camera. */
float cornerTicks(vec2 uv, vec4 r, float w, float len) {
  float outline = rectOutline(uv, r, w);
  float nearX = min(uv.x - r.x, r.z - uv.x);
  float nearY = min(uv.y - r.y, r.w - uv.y);
  float corner = step(nearX, len) + step(nearY, len);
  return outline * clamp(corner, 0.0, 1.0);
}

void main() {
  vec3 feed = texture2D(uFeed, vUv).rgb * uGain;
  feed = acesFilmic(feed);
  // LCDs lift their blacks and hold slightly less saturation than the eye.
  feed = mix(vec3(dot(feed, vec3(0.299, 0.587, 0.114))), feed, 0.88);
  feed = feed * 0.94 + 0.045;
  feed *= mix(1.0, ${'${VIEWFINDER.frozenDim.toFixed(3)}'}, uFrozen);

  vec3 color = feed;

  // Rule of thirds.
  float grid = 0.0;
  grid += line(vUv.x, 1.0 / 3.0, 0.0016) + line(vUv.x, 2.0 / 3.0, 0.0016);
  grid += line(vUv.y, 1.0 / 3.0, 0.0024) + line(vUv.y, 2.0 / 3.0, 0.0024);
  color = mix(color, uPrimary, clamp(grid, 0.0, 1.0) * uGridOpacity);

  // Hover and press washes.
  float hover = rectFill(vUv, uHoverRect);
  color = mix(color, uPrimary, hover * mix(0.08, 0.18, uPressed));

  // Focus frame.
  vec3 focusColor = mix(uPrimary, uConfirm, uFocusConfirm);
  float focus = cornerTicks(vUv, uFocusRect, 0.004, 0.03);
  color = mix(color, focusColor, focus * 0.95);

  // Level indicator, two short segments that tilt with the body's roll.
  vec2 centred = vUv - 0.5;
  float rotated = centred.y * cos(uRoll) - centred.x * sin(uRoll);
  float span = step(0.16, abs(centred.x)) * step(abs(centred.x), 0.26);
  color = mix(color, uPrimary, span * line(rotated, 0.0, 0.004) * 0.6);

  // Chrome, premultiplied against the feed.
  vec4 chrome = texture2D(uChrome, vUv);
  color = mix(color, chrome.rgb, chrome.a);

  // Reticle: a thin ring that contracts when it has something to land on.
  float radius = ${'${PHOTOGRAPHY.reticle.radius.toFixed(4)}'} * mix(1.0, 0.72, hover);
  float d = length((vUv - uReticle) * vec2(1.5, 1.0));
  float ring = smoothstep(radius, radius - 0.0035, d) - smoothstep(radius - 0.004, radius - 0.0075, d);
  color = mix(color, uPrimary, ring * uReticleAlpha);

  // Glass: a corner sheen and a soft edge falloff.
  float vignette = 1.0 - 0.34 * pow(length(centred * vec2(1.15, 1.0)) * 1.4, 2.0);
  color *= clamp(vignette, 0.0, 1.0);
  color += uPrimary * 0.05 * smoothstep(0.75, 0.0, vUv.x + (1.0 - vUv.y));

  gl_FragColor = vec4(color * uEmissive, 1.0);
}
`;

export function createScreenMaterial(): THREE.ShaderMaterial {
  const ui = PHOTOGRAPHY.screenUI;
  return new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms: {
      uFeed: { value: null },
      uChrome: { value: null },
      uGain: { value: 1 },
      uFrozen: { value: 0 },
      uFocusRect: { value: new THREE.Vector4(0.4, 0.4, 0.6, 0.6) },
      uFocusConfirm: { value: 0 },
      uReticle: { value: new THREE.Vector2(0.5, 0.5) },
      uReticleAlpha: { value: 0 },
      uHoverRect: { value: new THREE.Vector4(0, 0, 0, 0) },
      uPressed: { value: 0 },
      uRoll: { value: 0 },
      uEmissive: { value: ui.emissive },
      uGridOpacity: { value: ui.gridOpacity },
      uPrimary: { value: new THREE.Color(ui.primary).convertSRGBToLinear() },
      uConfirm: { value: new THREE.Color(ui.confirm).convertSRGBToLinear() },
    },
    side: THREE.FrontSide,
    depthWrite: true,
  });
}
```

The two `${'${...}'}` placeholders above are literal template interpolations — write them as `${VIEWFINDER.frozenDim.toFixed(3)}` and `${PHOTOGRAPHY.reticle.radius.toFixed(4)}` inside the backtick string, so the constants are baked into the shader source at module load and stay in `Settings.ts` rather than being duplicated in GLSL.

- [ ] **Step 3: Swap LiveCameraScreen onto the new material**

Replace `LiveCameraScreen`'s `MeshBasicMaterial` with `createScreenMaterial()`. Hold a `ScreenUI` instance, call `screenUI.sync(state)` from `update`, and expose setters the interaction layer will drive:

```ts
  setFeed(texture: THREE.Texture | null): void {
    this.material.uniforms.uFeed!.value = texture;
  }

  setFrozen(frozen: boolean): void {
    this.material.uniforms.uFrozen!.value = frozen ? 1 : 0;
  }

  setGain(gain: number): void {
    this.material.uniforms.uGain!.value = gain;
  }

  setHover(rect: THREE.Vector4 | null, pressed: boolean): void {
    this.material.uniforms.uHoverRect!.value.copy(rect ?? ZERO_RECT);
    this.material.uniforms.uPressed!.value = pressed ? 1 : 0;
  }

  setReticle(u: number, v: number, alpha: number): void {
    this.material.uniforms.uReticle!.value.set(u, v);
    this.material.uniforms.uReticleAlpha!.value = alpha;
  }

  setFocus(rect: THREE.Vector4, confirmed: boolean): void {
    this.material.uniforms.uFocusRect!.value.copy(rect);
    this.material.uniforms.uFocusConfirm!.value = confirmed ? 1 : 0;
  }

  setRoll(radians: number): void {
    this.material.uniforms.uRoll!.value = radians;
  }
```

with `const ZERO_RECT = new THREE.Vector4(0, 0, 0, 0);` at module scope. Give it a constructor argument `private readonly photography: PhotographyMode` so `update` can call `this.screenUI.sync(this.photography.state)` and `this.setGain(viewfinderGain(this.photography.state))`.

- [ ] **Step 4: Verify**

```bash
npx tsc --noEmit
npm test
```

Reload and raise. Expected: a live image with a faint thirds grid, corner focus ticks, a level line, and the chrome layer over it. It should read as a display — emissive but not blooming. Check `read_console_messages` for shader-compile failures specifically; a GLSL error appears there and nowhere else.

- [ ] **Step 5: Commit**

```bash
git add src/camera/screenMaterial.ts src/camera/LiveCameraScreen.ts src/render/shaders/composite.glsl.ts
git commit -m "Screen material: feed, chrome and procedural shapes in one composite"
```

---

## Task 12: GestureClassifier

**Files:**
- Create: `src/photography/GestureClassifier.ts`
- Create: `src/photography/GestureClassifier.test.ts`

**Interfaces:**
- Consumes: `PHOTOGRAPHY.reticle` (Task 1)
- Produces: `type GesturePhase = 'idle' | 'reticle' | 'look'`; `class GestureClassifier { readonly phase: GesturePhase; readonly locked: boolean; update(dx: number, dy: number, dt: number): GesturePhase; reset(): void }`

The owner's requirement in full: the same physical gesture must not change meaning according to speed. Classification happens once at the start of a gesture and holds until movement settles.

- [ ] **Step 1: Write the failing test**

Create `src/photography/GestureClassifier.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test
```

Expected: FAIL — cannot resolve `./GestureClassifier`.

- [ ] **Step 3: Create the classifier**

Create `src/photography/GestureClassifier.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests, type-check and commit**

```bash
npm test
npx tsc --noEmit
git add src/photography/GestureClassifier.ts src/photography/GestureClassifier.test.ts
git commit -m "Latched gesture classification: one decision per gesture, held to the end"
```

---

## Task 13: CameraInteraction — reticle, raycast, hover/press/activate

**Files:**
- Create: `src/photography/CameraInteraction.ts`
- Modify: `src/photography/PhotographyMode.ts`

**Interfaces:**
- Consumes: `GestureClassifier` (Task 12), `zoneAtUv`/`zoneCentreUv`/`Zone` (Task 9), `CameraActions` (Task 6), `LiveCameraScreen` (Task 11), `FloatingCamera` (Task 5)
- Produces: `class CameraInteraction implements System` with `pointerDelta(dx, dy)`, `press()`, `release()`, `wheel(delta)`, and `readonly hovered: Zone | 'shutterButton' | 'body' | null`

- [ ] **Step 1: Create the interaction layer**

Create `src/photography/CameraInteraction.ts`:

```ts
import * as THREE from 'three';
import { PHOTOGRAPHY } from '../core/Settings';
import type { EngineContext, System } from '../core/System';
import type { FloatingCamera } from '../camera/FloatingCamera';
import type { LiveCameraScreen } from '../camera/LiveCameraScreen';
import { clamp, damp, saturate } from '../util/math';
import type { CameraActions } from './CameraActions';
import { GestureClassifier } from './GestureClassifier';
import { zoneAtUv, zoneCentreUv, type Zone } from './InteractionZones';
import type { PhotographyMode } from './PhotographyMode';

export type HoverTarget = Zone | 'shutterButton' | 'body' | null;

/** Model units. The cap spans y 0.575 -> 0.700, so this is a plausible throw. */
const BUTTON_TRAVEL = 0.018;

/**
 * The reticle, and what it is pointing at.
 *
 * Its domain is the camera's PROJECTED BOUNDS, not the screen alone — that is
 * what lets it travel up onto the shutter button while still being constrained
 * to the camera, never becoming a full-screen game cursor.
 *
 * Hover, press and activation are three separate states. Passing over a control
 * does nothing, ever; activation needs a press and a release that agree on the
 * target, so a slip cancels instead of misfiring.
 */
export class CameraInteraction implements System {
  hovered: HoverTarget = null;

  /** Screen-space NDC, clamped to the camera's projected bounds. */
  private readonly reticle = new THREE.Vector2(0, 0);
  private readonly gesture = new GestureClassifier();
  private readonly raycaster = new THREE.Raycaster();
  private readonly bounds = new THREE.Box2();
  private readonly box = new THREE.Box3();
  private readonly corner = new THREE.Vector3();
  private readonly hoverRect = new THREE.Vector4();
  private readonly screenUv = new THREE.Vector2(0.5, 0.5);

  private camera: THREE.PerspectiveCamera | null = null;
  private pressedTarget: HoverTarget = null;
  private alpha = 0;
  private idleTime = 0;
  private pointerSpeed = 0;
  private buttonRestY: number | null = null;
  private readonly press$ = { velocity: 0 };
  private pressDepth = 0;
  /** Look deltas the reticle clamp rejected, drained by PhotoDesktopInput. */
  readonly lookSpill = { x: 0, y: 0 };

  /** `photography` satisfies CameraActions; the alias documents which role is which. */
  private readonly actions: CameraActions;

  constructor(
    private readonly floating: FloatingCamera,
    private readonly screen: LiveCameraScreen,
    private readonly photography: PhotographyMode,
  ) {
    this.actions = photography;
  }

  init(ctx: EngineContext): void {
    this.camera = ctx.camera;
    this.raycaster.layers.set(1); // The camera model's layer.
  }

  /**
   * Raw mouse delta in pixels. Whatever does not belong to the reticle is left
   * in `lookSpill` for PhotoDesktopInput to drain into the shared input state.
   */
  pointerDelta(dx: number, dy: number, dt: number): void {
    this.lookSpill.x = 0;
    this.lookSpill.y = 0;
    if (!this.photography.pose.isRaised) return;

    const phase = this.gesture.update(dx, dy, dt);
    if (phase !== 'reticle') {
      this.lookSpill.x = dx;
      this.lookSpill.y = dy;
      return;
    }

    this.idleTime = 0;
    this.pointerSpeed = Math.hypot(dx, dy) / Math.max(dt, 1e-4);

    // Mouse travel is scaled so crossing the camera's full projected width
    // takes pxPerScreenWidth of movement: an edge is always close, which is
    // what lets a misclassified flick reach it and spill into look on its own.
    const span = Math.max(this.bounds.max.x - this.bounds.min.x, 1e-4);
    const perPixel = span / PHOTOGRAPHY.reticle.pxPerScreenWidth;
    const wantedX = this.reticle.x + dx * perPixel;
    const wantedY = this.reticle.y - dy * perPixel;

    const clampedX = clamp(wantedX, this.bounds.min.x, this.bounds.max.x);
    const clampedY = clamp(wantedY, this.bounds.min.y, this.bounds.max.y);

    // Not a blend: the clamp simply has nowhere to put this, so it becomes look.
    this.lookSpill.x = (wantedX - clampedX) / perPixel;
    this.lookSpill.y = -(wantedY - clampedY) / perPixel;

    this.reticle.set(clampedX, clampedY);
  }

  press(): void {
    if (!this.photography.pose.isRaised) return;
    this.pressedTarget = this.hovered;
    if (this.hovered === 'shutterButton') this.actions.shutter('down');
  }

  release(): void {
    const target = this.pressedTarget;
    this.pressedTarget = null;
    if (!this.photography.pose.isRaised) return;
    // Down and up must agree, so a slip during the press cancels.
    if (target === null || target !== this.hovered) return;

    if (target === 'shutterButton') {
      this.actions.shutter('up');
      return;
    }
    if (target === 'body') return;

    if (target.id === 'focusPoint') {
      this.actions.focus({ x: this.screenUv.x, y: this.screenUv.y });
      return;
    }
    if (target.settingId === 'mode') {
      this.actions.selectSetting('mode');
      this.actions.changeSetting(1);
      return;
    }
    if (target.settingId !== null) this.actions.selectSetting(target.settingId);
  }

  wheel(notches: number): void {
    if (!this.photography.pose.isRaised) return;
    const target = this.hovered;
    const selected = this.photography.state.selected;
    const overSelected =
      target !== null && target !== 'body' && target !== 'shutterButton' &&
      target.settingId !== null && target.settingId === selected;

    if (overSelected) this.actions.changeSetting(notches);
    else this.actions.zoom(notches * PHOTOGRAPHY.lens.wheelStep);
  }

  update(dt: number): void {
    const model = this.floating.object;
    if (!this.camera || !model || dt <= 0) return;

    if (!this.photography.pose.isRaised) {
      this.fade(dt, 0);
      this.hovered = null;
      this.screen.setHover(null, false);
      return;
    }

    this.updateBounds(model);
    this.resolveHover();
    this.applyMagnetism(dt);

    this.idleTime += dt;
    const wanted = this.idleTime > PHOTOGRAPHY.reticle.fadeDelay ? 0 : 1;
    if (wanted === 0) this.recentre(dt);
    this.fade(dt, wanted);

    this.screen.setReticle(this.screenUv.x, this.screenUv.y, this.alpha);
    this.screen.setHover(this.hoverTargetRect(), this.pressedTarget !== null);
  }

  private fade(dt: number, wanted: number): void {
    this.alpha = damp(this.alpha, wanted, PHOTOGRAPHY.reticle.fadeLambda, dt);
  }

  /** Every gesture starts from the same known place. */
  private recentre(dt: number): void {
    const centre = this.bounds.getCenter(new THREE.Vector2());
    this.reticle.lerp(centre, 1 - Math.exp(-PHOTOGRAPHY.reticle.fadeLambda * dt));
  }

  private updateBounds(model: THREE.Object3D): void {
    if (!this.camera) return;
    this.box.setFromObject(model);
    this.bounds.makeEmpty();
    for (let i = 0; i < 8; i++) {
      this.corner.set(
        i & 1 ? this.box.max.x : this.box.min.x,
        i & 2 ? this.box.max.y : this.box.min.y,
        i & 4 ? this.box.max.z : this.box.min.z,
      );
      this.corner.project(this.camera);
      this.bounds.expandByPoint(new THREE.Vector2(this.corner.x, this.corner.y));
    }
    this.reticle.set(
      clamp(this.reticle.x, this.bounds.min.x, this.bounds.max.x),
      clamp(this.reticle.y, this.bounds.min.y, this.bounds.max.y),
    );
  }

  private resolveHover(): void {
    const model = this.floating.object;
    if (!this.camera || !model) return;

    this.raycaster.setFromCamera(this.reticle, this.camera);
    const hits = this.raycaster.intersectObject(model, true);
    const hit = hits[0];
    if (!hit) {
      this.hovered = null;
      return;
    }

    if (hit.object.name === 'ShutterHitVolume' || hit.object.name === 'ShutterButton') {
      this.hovered = 'shutterButton';
      return;
    }
    if (hit.object === this.screen.surface && hit.uv) {
      this.screenUv.copy(hit.uv);
      this.hovered = zoneAtUv(hit.uv.x, hit.uv.y) ?? 'body';
      return;
    }
    this.hovered = 'body';
  }

  /**
   * Assists the landing only. Scaled to zero above the cutoff so it can never
   * drag the reticle off the path the player intended.
   */
  private applyMagnetism(dt: number): void {
    const target = this.hovered;
    if (target === null || target === 'body' || target === 'shutterButton') return;

    const strength =
      PHOTOGRAPHY.reticle.magnetism *
      (1 - saturate(this.pointerSpeed / PHOTOGRAPHY.reticle.magnetSpeedCutoff));
    if (strength <= 0) return;

    const centre = zoneCentreUv(target);
    this.screenUv.x += (centre.u - this.screenUv.x) * strength * Math.min(dt * 60, 1);
    this.screenUv.y += (centre.v - this.screenUv.y) * strength * Math.min(dt * 60, 1);
  }

  private hoverTargetRect(): THREE.Vector4 | null {
    const target = this.hovered;
    if (target === null || target === 'body' || target === 'shutterButton') return null;
    if (target.id === 'focusPoint') return null; // The image area never washes.
    return this.hoverRect.set(target.x0, 1 - target.y1, target.x1, 1 - target.y0);
  }

  /**
   * The cap physically depresses. Sprung rather than snapped, so the release
   * has the same small bounce a real shutter button has.
   */
  private updateButton(dt: number): void {
    const button = this.floating.shutterButton;
    if (!button) return;
    this.buttonRestY ??= button.position.y;
    const target = this.pressedTarget === 'shutterButton' ? 1 : 0;
    this.pressDepth = spring(this.pressDepth, target, this.press$, 30, 0.5, dt);
    button.position.y = this.buttonRestY - this.pressDepth * BUTTON_TRAVEL;
  }
}
```

`updateButton(dt)` is called from `update` immediately after `resolveHover()`. Import `spring` alongside `clamp`, `damp` and `saturate` from `../util/math`. Living here rather than in `PhotographyMode` avoids a construction cycle: `FloatingCamera` already depends on `PhotographyMode.pose`, so `PhotographyMode` cannot hold a `FloatingCamera`.

- [ ] **Step 2: Verify by hand**

Wire it temporarily in `main.ts` (Task 14 does it properly):

```ts
const interaction = new CameraInteraction(floatingCamera, screen, photography);
engine.add(interaction);
```

`CameraInteraction` reads `floating.shutterButton`, which Task 15 Step 1 adds. Add that accessor now if it is not there yet — it is two lines and `updateButton` no-ops without it.

Reload, raise the camera, move the mouse slowly. Expected: a small ring appears on the screen and tracks the mouse; zones brighten as it passes; **nothing changes in `PhotoState`** until you click. Flick the mouse: the ring fades and the world pans.

- [ ] **Step 3: Type-check and commit**

```bash
npx tsc --noEmit
npm test
git add src/photography/CameraInteraction.ts src/main.ts
git commit -m "CameraInteraction: a reticle constrained to the camera, with separate hover, press and activate"
```

---

## Task 14: PhotoDesktopInput

**Files:**
- Create: `src/photography/input/PhotoDesktopInput.ts`
- Modify: `src/main.ts` (remove the temporary handlers from Tasks 6 and 7)
- Modify: `src/player/input/DesktopInput.ts` (route look through the interaction layer)

**Interfaces:**
- Consumes: `CameraInteraction` (Task 13), `PhotographyMode` (Task 6)
- Produces: `class PhotoDesktopInput implements System` — owns every desktop binding in one place

- [ ] **Step 1: Create the input system**

Create `src/photography/input/PhotoDesktopInput.ts`:

```ts
import { PHOTOGRAPHY, PLAYER } from '../../core/Settings';
import type { System } from '../../core/System';
import type { InputState } from '../../player/input/InputState';
import type { CameraInteraction } from '../CameraInteraction';
import type { PhotographyMode } from '../PhotographyMode';

const DRAG_PX_PER_STEP = 26;

/**
 * Every desktop binding in one place. Keyboard exists only as an optional
 * accessibility and development alternative and is never the primary path.
 */
export class PhotoDesktopInput implements System {
  private dragAccumulator = 0;
  private dragging = false;
  private lastMoveTime = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly photography: PhotographyMode,
    private readonly interaction: CameraInteraction,
    private readonly input: InputState,
  ) {}

  init(): void {
    this.canvas.addEventListener('contextmenu', this.onContextMenu);
    this.canvas.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('keydown', this.onKeyDown);
  }

  dispose(): void {
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);
    this.canvas.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    this.canvas.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('keydown', this.onKeyDown);
  }

  /**
   * Called by DesktopInput with the raw pointer delta. Returns nothing: the
   * interaction layer decides what belongs to the reticle, and whatever it
   * rejects is written straight into the shared look accumulator.
   */
  routePointer(dx: number, dy: number): void {
    const now = performance.now() * 0.001;
    const dt = this.lastMoveTime > 0 ? Math.max(now - this.lastMoveTime, 1e-4) : 1 / 60;
    this.lastMoveTime = now;

    if (!this.photography.pose.isRaised) {
      this.input.lookDeltaYaw += dx * PLAYER.lookSensitivity;
      this.input.lookDeltaPitch += dy * PLAYER.lookSensitivity;
      return;
    }

    this.interaction.pointerDelta(dx, dy, dt);
    this.input.lookDeltaYaw += this.interaction.lookSpill.x * PLAYER.lookSensitivity;
    this.input.lookDeltaPitch += this.interaction.lookSpill.y * PLAYER.lookSensitivity;

    if (this.dragging) this.accumulateDrag(dx);
  }

  private accumulateDrag(dx: number): void {
    const selected = this.photography.state.selected;
    const hovered = this.interaction.hovered;
    const overSelected =
      hovered !== null && hovered !== 'body' && hovered !== 'shutterButton' &&
      hovered.settingId !== null && hovered.settingId === selected;
    if (!overSelected) return;

    this.dragAccumulator += dx;
    const steps = Math.trunc(this.dragAccumulator / DRAG_PX_PER_STEP);
    if (steps === 0) return;
    this.dragAccumulator -= steps * DRAG_PX_PER_STEP;
    this.photography.changeSetting(steps);
  }

  private readonly onContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
    this.photography.togglePhotographyMode();
  };

  private readonly onMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0 || !this.photography.pose.isRaised) return;
    this.dragging = true;
    this.dragAccumulator = 0;
    this.interaction.press();
  };

  private readonly onMouseUp = (event: MouseEvent): void => {
    if (event.button !== 0) return;
    this.dragging = false;
    this.interaction.release();
  };

  private readonly onWheel = (event: WheelEvent): void => {
    if (!this.photography.pose.isRaised) return;
    event.preventDefault();
    this.interaction.wheel(-Math.sign(event.deltaY));
  };

  /** Optional accessibility and development alternatives only. */
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.photography.pose.isRaised) return;
    if (event.code === 'BracketLeft') this.photography.changeSetting(-1);
    else if (event.code === 'BracketRight') this.photography.changeSetting(1);
    else if (event.code === 'Space') this.photography.shutter('up');
  };
}
```

`PHOTOGRAPHY` is imported for future use of `PHOTOGRAPHY.lens`; if it is unused when you finish, delete it — `noUnusedLocals` will say so.

- [ ] **Step 2: Route DesktopInput's mouse through it**

In `src/player/input/DesktopInput.ts`, add an optional route target so the photography layer can intercept without `DesktopInput` knowing anything about it:

```ts
  /** Set by main.ts. When present, it owns what happens to the pointer delta. */
  route: ((dx: number, dy: number) => void) | null = null;
```

and in `onMouseMove`:

```ts
  private readonly onMouseMove = (event: MouseEvent): void => {
    if (!this.isLocked) return;
    if (this.route) {
      this.route(event.movementX, event.movementY);
      return;
    }
    this.input.lookDeltaYaw += event.movementX * PLAYER.lookSensitivity;
    this.input.lookDeltaPitch += event.movementY * PLAYER.lookSensitivity;
  };
```

- [ ] **Step 3: Replace the temporary handlers in main.ts**

Delete the temporary `contextmenu` and `wheel` listeners added in Tasks 6 and 7. Add:

```ts
const photoInput = new PhotoDesktopInput(canvas, photography, interaction, input);
if (!engine.quality.isTouch) {
  engine.add(photoInput);
  desktopInput.route = (dx, dy) => photoInput.routePointer(dx, dy);
}
```

- [ ] **Step 4: Verify every binding**

```bash
npx tsc --noEmit
npm test
```

Walk the whole table in spec §8:

- right-click raises and lowers
- slow mouse moves the reticle; a flick pans the world
- clicking a bottom-bar value selects it — the amber rail moves — and changes nothing else
- pressing on one zone and releasing over another does nothing
- the wheel zooms; the wheel over the selected zone changes that value
- dragging horizontally on the selected zone turns it like a dial
- clicking the shutter button depresses it and decrements the counter
- Escape releases pointer lock, lowers the camera and shows the Boot overlay

- [ ] **Step 5: Commit**

```bash
git add src/photography/input/PhotoDesktopInput.ts src/player/input/DesktopInput.ts src/main.ts
git commit -m "PhotoDesktopInput: every desktop binding in one place, keyboard demoted to optional"
```

---

## Task 15: Focus, the button depression, and the docs

**Files:**
- Modify: `src/photography/PhotographyMode.ts` (focus ray, button animation)
- Modify: `src/camera/FloatingCamera.ts` (expose the button mesh)
- Modify: `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`, `docs/STATUS.md`

**Interfaces:**
- Consumes: `HeightField` from `src/world/HeightField`, everything above
- Produces: the finished feature

- [ ] **Step 1: Expose the button mesh**

In `src/camera/FloatingCamera.ts`, add:

```ts
  /** The shutter cap, so it can physically depress on press. */
  get shutterButton(): THREE.Object3D | null {
    return this.model?.getObjectByName('ShutterButton') ?? null;
  }
```

- [ ] **Step 2: Confirm the cap depresses**

The animation itself lives in `CameraInteraction.updateButton`, written in Task 13 — it belongs there because `FloatingCamera` already depends on `PhotographyMode.pose`, so `PhotographyMode` cannot hold a `FloatingCamera` without a construction cycle. With Step 1's accessor in place, verify by eye: press and hold the left button over the shutter cap and confirm it travels down, then springs back with a small bounce on release.

- [ ] **Step 3: Cast the focus ray**

Add to `PhotographyMode`, called from `focus()`:

```ts
  /**
   * A coarse march against the height field, refined by bisection. Cheap, and
   * it gives a real distance for the readout, the focus confirmation and — when
   * depth of field lands — the blur.
   */
  private measureFocusDistance(origin: THREE.Vector3, direction: THREE.Vector3): number {
    const STEP = 1.5;
    const MAX = 260;
    let previous = 0;
    for (let t = STEP; t < MAX; t += STEP) {
      const x = origin.x + direction.x * t;
      const y = origin.y + direction.y * t;
      const z = origin.z + direction.z * t;
      if (y <= this.height.heightAt(x, z)) {
        // Bisect between the last clear sample and this one.
        let lo = previous;
        let hi = t;
        for (let i = 0; i < 8; i++) {
          const mid = (lo + hi) / 2;
          const my = origin.y + direction.y * mid;
          if (my <= this.height.heightAt(origin.x + direction.x * mid, origin.z + direction.z * mid)) {
            hi = mid;
          } else {
            lo = mid;
          }
        }
        return (lo + hi) / 2;
      }
      previous = t;
    }
    return Infinity;
  }
```

Take `HeightField` as a constructor argument, wire it in `main.ts`, and set `state.focusDistance` and `state.focusConfirmed = true` from the result. Add the distance to the chrome layer's centre readout in `ScreenUI` (`3.2 m`, or `∞` for infinity) and move the focus rect in the material toward `state.focusUv`.

- [ ] **Step 4: Full verification pass**

```bash
npm test
npx tsc --noEmit
npx vite build
```

In the preview, run every item in spec §12 and record the numbers:

- `DevStats` at rest and raised on `high`
- `?quality=medium&fps=30` raised, held for 30 s
- `?vf=0` and `?vf=3`
- enter/exit 20 times and confirm `info.memory` is stable

- [ ] **Step 5: Update the docs**

- `docs/ARCHITECTURE.md`: add `photography/` to the tree; replace the `Photography` row in *Where the next features plug in* with a pointer to the spec; add `PhotographyMode` and `Viewfinder` to the registration-order list with the reason each must sit where it does.
- `docs/DECISIONS.md`: add a `## Phase 11: Photography Mode` section recording (1) the model merge split and why the shadow-cost rationale no longer applies, (2) why the viewfinder is a real render pass rather than a crop of the main frame, (3) why gesture classification is latched rather than blended, (4) why the watchdog reads medians.
- `docs/STATUS.md`: update the stale phase-9 performance figures to the phase-10 baseline plus the new raised-mode numbers, move the phase marker to 11, and update *Exact next task*.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Focus ray, shutter depression, and docs for Photography Mode"
```

---

## Self-review notes

Checked against the spec:

- §2 mode lifecycle → Task 6. §2 input gating → Task 6 Step 2.
- §3 pose → Tasks 4 and 5. Merge split → Task 2.
- §4 viewfinder → Task 7. Stats visibility → Task 8 Step 8.
- §5 ladder and watchdog → Task 8, with the transient and hysteresis cases as explicit tests.
- §6 screen rendering → Tasks 10 and 11. Geometry correction → Task 1.
- §7 reticle → Tasks 12 and 13. Three-state separation → Task 13 `press`/`release`.
- §8 actions and bindings → Tasks 6 and 14.
- §9 ExposureModel → Task 3.
- §10 settings → Task 1. §11 registration order → Tasks 6, 7, 14.
- §12 verification → distributed, with the full pass in Task 15 Step 4.

Deferred by the spec and therefore absent by design: depth of field, histogram, photo storage, live `focusMode`/`metering` zones, and viewfinder bloom. Touch bindings were added after the original desktop-only milestone through the existing `CameraActions` surface and raycast path; real-device validation remains open.
