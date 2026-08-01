# Photography Mode & Physical Camera Interface — Design

Status: approved by the project owner, not yet implemented.
Supersedes the `Photography` row in `docs/ARCHITECTURE.md` → *Where the next features plug in*.

## Goal

The floating camera stops being scenery and becomes the primary interface. Raising it
is a physical act; the rear display is the only UI the game has. There is no HUD, no
overlay, no menu — every pixel of interface lives on a mesh in the world.

## Non-goals for this milestone

- Photo capture to a file, albums, galleries, progression. `shutter` is a stub.
- Depth of field. `ExposureModel` and focus distance are built so it can land later.
- Full mobile input. The architecture must support it; the bindings are not written.
- Histogram. A zone is reserved; nothing draws into it.

## Constraints that must survive

Movement feel, grass, flowers, ecological vegetation, lighting, post-processing,
atmosphere and the performance targets are all unchanged. Specifically:

- **At `raise = 0` the floating-camera pose arithmetic must be identical to today's.**
  Every new term is multiplied by `raise` or by a value that is 0 at rest.
- `Player.ts` and `FirstPersonCamera.ts` are not modified. Movement gating happens in
  the input layer.
- Desktop `high` baseline measured 2026-08-01: **170 fps, 80 calls, 1382k triangles**.
  (`STATUS.md` still records the phase-9 figure of 66 calls / 739k triangles; phase 10
  ecology roughly doubled the triangle count. Measure against 80/1382k.)
- Mobile target is a **pinned 30 fps**. The viewfinder must degrade itself rather than
  cost frames.
- No new dependencies. `three` only.

---

## 1. Module map

```
src/photography/
  PhotographyMode.ts      System. Owns the mode, gates input, drives everything below
  PhotoState.ts           Plain data + a change counter. No three.js imports
  ExposureModel.ts        Keeps aperture / shutter / ISO consistent through EV
  CameraActions.ts        The semantic interface every input producer targets
  CameraInteraction.ts    Reticle -> raycast -> zone -> action
  InteractionZones.ts     The one table of named UV rects
  input/PhotoDesktopInput.ts   Mouse, wheel, right-click. Optional keyboard a11y map

src/camera/
  FloatingCamera.ts       MODIFIED. Target pose blends by `raise`; merge splits button
  CameraPose.ts           NEW. The raise spring and the rest/raised blend
  CameraScreen.ts         MODIFIED. Optional `surface` for picking
  StaticCameraScreen.ts   Unchanged. Retained as the hard floor
  LiveCameraScreen.ts     NEW. Implements CameraScreen + InteractiveScreen
  Viewfinder.ts           NEW. Second camera, render target, cadence, watchdog
  ScreenUI.ts             NEW. Canvas2D -> CanvasTexture. Redraw on change only
  screenMaterial.ts       NEW. Composites viewfinder + chrome + procedural shapes
```

`camera/` owns the physical object and its display. `photography/` owns the mode and
its semantics. Nothing in `photography/` imports `three` except `CameraInteraction`,
which needs `Raycaster` and `Vector2`.

---

## 2. Mode lifecycle

`PhotographyMode` is a `System` registered **before** `FirstPersonCamera`, so it can
scale the input state before anything consumes it.

```
enter:  raise target 1   (right-click, or tap the camera body on touch)
exit:   raise target 0   (right-click again, Escape, or losing pointer lock)
```

`contextmenu` is `preventDefault`ed on the canvas.

**Escape is not ours.** Under pointer lock the browser consumes Escape as its unlock
gesture and no `keydown` is delivered. It will therefore drop the lock, which already
triggers `pointerlockchange` → `Boot.show()` in `main.ts`. We hook the same event to
force `raise → 0`, so the state can never disagree with what the player sees. Right-click
remains the real toggle.

### Input gating while raised

`PhotographyMode.update()` runs first and scales the shared `InputState` in place:

| | multiplier |
|---|---|
| `moveForward`, `moveRight` | `lerp(1, PHOTOGRAPHY.moveScale, raise)` — 0.28 raised |
| `lookDeltaYaw`, `lookDeltaPitch` | `lerp(1, PHOTOGRAPHY.lookScale, raise)` — 0.8 raised |

`Player` still runs its full gait, spring and breathing simulation, just at shuffle
speed. Nothing in `Player.ts` changes. Setting `moveScale` to 0 fully freezes movement
if that ever reads better.

While raised, `PhotoDesktopInput` additionally diverts a fraction of the mouse delta
away from look and into the reticle — see §7.

---

## 3. Camera pose animation

`CameraPose` owns one scalar and its velocity:

```
raise'' = ω² (target − raise) − 2 ζ ω raise'
ω = 11 rad/s,  ζ = 0.62      → ~9% overshoot, ~0.6 s settle
```

Integrated semi-implicitly with the frame's clamped `dt`. Everything else is a blend by
`raise`, applied inside `FloatingCamera.updateTarget()`:

| term | rest | raised |
|---|---|---|
| anchor | `FLOATING_CAMERA.anchor` = `[0.47, −0.32, −0.93]` | derived, see below |
| local rotation | `x −5° y −12° z −2°` | `x −1.5° y 0° z 0°` |
| `followLambda` | 5.0 | 9.0 |
| `rotationLambda` | 6.0 | 11.0 |
| `idleDrift.amount` | ×1.0 | ×0.4 |
| `lookOffset` | ×1.0 | ×0.3 |
| `bank` | ×1.0 | ×0.35 |

A raised camera braced against your face is **steadier**, not looser — hence the higher
lambdas and the reduced drift. Some breathing is deliberately retained.

### The raised anchor is derived, not hardcoded

The knob is *framing*, not distance:

```
screenWorldHeight = FLOATING_CAMERA.screen.height × FLOATING_CAMERA.scale
d = screenWorldHeight / (2 · PHOTOGRAPHY.screenHeightFraction · tan(fov/2))
```

With `screen.height = 0.40`, `scale = 0.26`, `screenHeightFraction = 0.36` and the
desktop `fov = 62°` this gives **d ≈ 0.24 m**. It re-solves every frame, so mobile's 70°
fov and any window aspect are handled with no second constant.

The anchor must place the **screen centre** on the view axis, not the model origin. The
merged geometry spans `Y 0 → 0.719` with its origin at the base of the body, and the
screen centre sits at local `(0, 0.3125, 0.229)`:

```
anchor = forward · d  −  raisedRotation · (screenCentreLocal · scale)
```

Sanity at d = 0.24 m on a 16:9 desktop view: the body spans ~51% of the frame width and
~65% of its height, the screen is ~583 × 389 px at 1080p, and the lens front sits
~0.18 m from the eye — comfortably beyond `VIEW.near` of 0.05.

### Making it feel lifted rather than lerped

Two terms, both zero at `raise = 0` and `raise = 1`:

- **Arc.** `arc = raise · (1 − raise) · 4` (peaks at 0.5) adds `+arc · 0.06` on Y and
  `−arc · 0.04` on Z, so the path curves up and in rather than running a straight line.
- **Lead rotation.** Driven by the spring's *velocity*, not its position, so entering
  and exiting differ naturally without authoring a second animation. Raising tips the
  body up and rolls it slightly; lowering reverses on its own.

### Model merge change

`mergeModel()` currently flattens all 15 glTF meshes into one `VintageCameraBody`,
destroying the `button` node name — the only interactive part in the asset. It becomes
**two** merged meshes:

- `VintageCameraBody` — nodes under the `camera` root
- `ShutterButton` — the `button` root's single cylinder, kept as its own mesh so it can
  physically depress on press

Cost is one extra draw call. `DECISIONS.md` justified the flatten by shadow-pass cost;
this model sets `castShadow = false` in `prepareMaterials()`, so that reason does not
apply. `DECISIONS.md` gets a line recording the change.

A third, invisible `ShutterHitVolume` box is added as a sibling, ~2.4× the cap's extent,
`visible = false`, used for picking. Never pick against the cap geometry.

---

## 4. Viewfinder rendering

A second `PerspectiveCamera` rendered into a small `HalfFloatType` target, **only while
`raise > 0`**. Exploration cost is exactly zero.

- **Placed at the lens**, not the eye: world position of the lens node, looking down the
  model's local −Z. The body lags and banks, so the image on the screen drifts slightly
  as the camera settles. This is the detail that sells it.
- **Layers.** The floating-camera group and all its descendants move to layer 1. The
  main camera enables layers 0 and 1; the viewfinder camera enables layer 0 only. The
  camera therefore cannot appear inside its own screen. Free.
- `renderer.autoClear` is `false` (set by `PostFX`), so the pass clears explicitly.
- Aspect is fixed at 3:2 to match the screen aperture.

### Focal length

A 36 × 24 mm frame, so vertical fov is `2 · atan(12 / f)`.

| f | vertical fov |
|---|---|
| 24 mm | 53.1° |
| 50 mm | 27.0° |
| 120 mm | 11.4° |

The player's naked 62° view is a **~20 mm lens**, so every focal length in the range is
genuinely tighter than the eye — the crop is real, not decorative.

Zoom accumulates in **log space** (`logF += delta · wheelStep`), because linear steps
make 24→34 mm violent and 110→120 mm imperceptible. The result is damped toward the
target at λ = 9 so the zoom glides. Range 24–120 mm, ~29 wheel notches end to end.

### Stats visibility

`PostFX.render()` calls `renderer.info.reset()` before its first pass, which would erase
the viewfinder's draw counts. `Viewfinder` records its own `calls` / `triangles` deltas
around its render and exposes them; `DevStats` displays them as a separate line. The cost
of this feature must be visible while tuning it, not inferred.

---

## 5. Adaptive quality — the viewfinder must never cost the 30 fps target

### The ladder

| rung | resolution | cadence |
|---|---|---|
| 0 | 512 × 341 | 30 Hz |
| 1 | 384 × 256 | 20 Hz |
| 2 | 256 × 171 | 12 Hz |
| 3 | frozen | 0 Hz — last frame retained, dimmed to 0.55 |

Start rung by tier: `high` → 0, `medium` → 1, `low` → 2. `?vf=<0..3>` forces a rung, in
the style of the existing `?quality=` and `?fps=` overrides.

**Rung 3 is not a dead screen.** The last rendered frame stays on the display and the
entire chrome layer remains live and fully interactive. It reads as an LCD that has
dropped its refresh rate, which is a thing real cameras do.

`StaticCameraScreen` is retained unchanged as the hard floor, selected in `main.ts` when
half-float render targets are unavailable.

### The watchdog

The honest signal on a frame-capped device is the **achieved present rate**, which
`Engine.presentedFrames` already provides. Wall-clock `dt` cannot reveal the cost,
because under a cap it measures the rAF interval rather than the work.

```
target = isFinite(quality.frameCap) ? quality.frameCap
                                    : mean present rate over the 2 s before raising
```

Present counts are accumulated into **0.5 s buckets**. Every decision reads the
**median** of a window of buckets, never the mean — one stalled bucket cannot move a
median, which is the whole point.

```
degrade   median of the last  4 buckets (2.0 s)  <  target × 0.92   → one rung down
recover   median of the last 16 buckets (8.0 s)  >  target × 1.00   → one rung up
```

Four guards against a transient triggering a change:

1. **Warm-up.** No decision for `warmupSeconds` (1.0) after the camera is raised. The
   first viewfinder frames pay for target allocation, shader compilation and the first
   chrome upload; that spike is not representative of anything.
2. **Minimum observation window.** The degrade window is a full 2.0 s of buckets. A
   partially-filled window never evaluates — on a cold start there is simply no
   decision until 4 buckets exist.
3. **Median, not mean.** A single long frame — a grass tile rebuild, a GC pause, a
   texture upload — cannot pull the median below the threshold.
4. **Cooldown.** After any rung change, `cooldownSeconds` (3.0) during which no further
   change is possible, and the buckets are cleared so the new rung is judged only on its
   own evidence.

The hysteresis gap is explicit: degrade below `0.92 × target`, recover only above
`1.00 × target`. Nothing can sit in a band where both conditions are true.

Buckets are discarded across a `visibilitychange` and across any `raise` transition —
returning from a hidden tab produces a gap that is not a performance signal.

The watchdog only samples while `raise > 0`. Recovery is capped at 2 per session and the
floor **latches**: a rung that has failed twice is never re-entered. This prevents the
oscillation that makes adaptive systems feel broken.

---

## 6. Rear screen rendering

Three layers composited in one `ShaderMaterial`:

1. **Viewfinder texture** — §4.
2. **Chrome texture** — Canvas2D at 1024 × 683 → `CanvasTexture`. All typography and
   glyphs. Redrawn **only when a value changes**, tracked by a change counter on
   `PhotoState`. Mipmapped with anisotropy, since it is minified to ~583 px on screen.
3. **Procedural shapes in the fragment shader** — thirds grid, capture corners, focus
   frame, level indicator, reticle, hover/press washes. These move every frame; drawing
   them in GLSL avoids a 2.8 MB texture upload per frame, which would be unacceptable
   on mobile.

### Colour under PostFX

The renderer is `NoToneMapping` / `LinearSRGBColorSpace` for the whole frame, and all
grading happens in `composite.glsl.ts`. Consequences:

- `toneMapped: false` on a screen material is a **no-op** today. The display is ACES'd
  along with the world whether we like it or not.
- To read as emissive, the screen outputs around **1.3 in linear** — above the world's
  mid-tones so it glows, below `POST.bloom.threshold` of 1.85 so it does not smear.
- The shader imports the **same ACES function** from `composite.glsl.ts` for its
  internal viewfinder tonemap. No second definition of the curve exists.
- Exposure compensation grades **only the viewfinder texture**, never the player's view.
  This is the correct camera behaviour and is impossible without the render target.

Plus a light glass treatment: a fresnel sheen, a corner glare gradient, a slight
desaturation and lifted black point on the feed so it reads as an LCD rather than a hole
cut in the camera.

### Screen geometry correction

`FLOATING_CAMERA.screen` is currently `0.42 × 0.265` at local `y = 0.24`. Measured from
the glTF, the bezel aperture — the gap inside frame nodes 5–8, in front of the recessed
panel of node 9 — is `x ±0.30`, `y 0.106 → 0.519`. The screen becomes:

```
width  0.60
height 0.40                    (3:2, the photographic aspect)
position [0, 0.3125, 0.229]    centred in the aperture, just proud of the bezel at 0.2281
```

This leaves a 0.0065 margin top and bottom inside the aperture.

---

## 7. Interaction

### The reticle

Pointer lock is **retained** the whole time, so there is never an OS cursor and we keep
receiving `movementX/Y`. The single mouse stream is routed by a **latched gesture
classifier**, never by a continuous blend. The same physical gesture always means the
same thing for its whole duration.

```
IDLE ──movement starts──► classify once ──► RETICLE ──┐
                                        └─► LOOK ─────┤
                                                      │
        ◄──────────── movement settles ───────────────┘
```

**Classification happens once, on the frame a gesture begins**, from the peak speed of
that frame and the one before it (a two-sample peak, so an acceleration ramp cannot be
mistaken for a slow movement — and no input is buffered, so there is no latency):

```
peak ≥ flickPxPerSec (900)  →  LOOK
otherwise                   →  RETICLE
```

**The classification then holds until the gesture ends**, which is speed below
`settlePxPerSec` (60) for `settleSeconds` (0.12). Nothing re-evaluates mid-gesture.

| state | mouse delta goes to | reticle |
|---|---|---|
| `RETICLE` | the reticle, clamped to the camera's projected bounds. **The component the clamp rejects spills into look** | visible, hovering |
| `LOOK` | look, entirely | fades out, hover cleared |
| `IDLE` | nothing is moving | fades out after `fadeDelay` 1.1 s, λ = 7 |

Edge spill is not a blend — it is the clamp having nowhere to put the movement, and it
is what makes the system safe: **a gesture misclassified as `RETICLE` self-corrects**.
The reticle crosses its domain in ~260 px of travel, so a fast gesture that started with
a soft ramp reaches the boundary within a frame or two and becomes a pan anyway. The
player is never trapped and never has to learn the flick threshold.

On fade-out the reticle **returns to the centre of the rear screen**, so every gesture
starts from the same known place. Nothing is lost by this, because selection is state on
`PhotoState` and survives independently of where the reticle happens to be — the amber
rail stays where you put it.

**Its domain is the camera's projected bounding rect**, recomputed each frame from the
model's bounding box — not the LCD alone. That is what lets it travel up onto the
shutter button while still being "constrained to the camera", never a full-screen game
cursor.

### Hit resolution

One raycast per frame from the main camera through the reticle's NDC position. Whatever
it hits is the hover target:

- `LiveCameraScreen.surface` → `intersection.uv` → zone lookup
- `ShutterHitVolume` → `shutterButton`
- anything else on the model → `body`

### No pixel-perfect targeting

Three mechanisms, in order of importance:

1. **Exhaustive partition.** Each bar is tiled edge to edge with no gaps. Every pixel of
   the screen belongs to some zone. There is nothing to miss.
2. **Magnetism, applied only as the reticle settles.** The pull toward the hovered
   zone's centre is scaled by `1 − saturate(speed / magnetSpeedCutoff)`, so it is zero
   while the player is actively moving and only acts as the gesture comes to rest. It
   assists the landing; it can never drag the reticle off an intended path. Default
   strength **0.12**, configurable, range 0–1.
3. **Padding.** Only the physical button needs it: `ShutterHitVolume` is ~2.4× the cap.

### Hover, press and activation are three separate states

**Passing over a control does nothing.** Ever. The reticle crossing a zone changes
appearance only.

```
hover       reticle is over the zone                    → visual only, no action
press       left button goes down while hovering it     → visual only, no action
activate    left button comes up over the SAME zone     → selectSetting(id)
cancel      left button comes up over a different zone  → no action at all
```

Down-and-up must agree on the target, which is standard button semantics and means a
slip during the press is a cancel rather than a misfire. `shutter` follows the same
rule: `down` arms and depresses the cap, `up` over the same volume fires.

### Feedback states

| state | screen zone | shutter button |
|---|---|---|
| hover | label to full white; rounded wash behind at 8% white; reticle contracts | cap brightens, hit volume stays invisible |
| selected | amber rail glides under the label; value takes an amber tint | — |
| pressed | wash flashes to 18%; label scales to 0.97 and settles on release | cap physically depresses along −Y, springs back |

The rail *glides* between zones rather than cutting. It is the single clearest signal
that this is one continuous instrument and not a list of buttons.

### Zone table

Authored with `y` measured from the top, matching the canvas; the hit test converts with
`v = 1 − y`. One table drives both the drawing and the picking, so a label cannot drift
from its zone.

| zone | x range | y range | behaviour |
|---|---|---|---|
| `mode` | 0.000 – 0.240 | 0.000 – 0.115 | click cycles P → A → S → M |
| `focusMode` | 0.240 – 0.420 | 0.000 – 0.115 | reserved, inert |
| `metering` | 0.420 – 0.600 | 0.000 – 0.115 | reserved, inert |
| `status` | 0.600 – 1.000 | 0.000 – 0.115 | battery + shots remaining, inert |
| `focusPoint` | 0.000 – 1.000 | 0.115 – 0.833 | click focuses at that uv |
| `focal` | 0.000 – 0.160 | 0.833 – 1.000 | adjustable |
| `aperture` | 0.160 – 0.280 | 0.833 – 1.000 | adjustable |
| `shutterSpeed` | 0.280 – 0.410 | 0.833 – 1.000 | adjustable |
| `iso` | 0.410 – 0.590 | 0.833 – 1.000 | adjustable |
| `exposure` | 0.590 – 1.000 | 0.833 – 1.000 | adjustable, drag rail |

The setting is `shutterSpeed`, deliberately not `shutter`, so it never reads as the
capture action.

A histogram may later take the right half of `status`; the zone exists so the layout
does not have to be re-cut.

### Focus

A coarse ray march against `HeightField.heightAt` from the lens along the focus ray
(the reticle's uv unprojected through the viewfinder camera, or the centre if the
reticle is asleep), refined by bisection, with the water plane as a second candidate and
a fallback to infinity. Cheap, and it gives a real distance for the readout, the focus
confirmation and — later — depth of field.

---

## 8. Semantic actions

Every input producer targets this and nothing else:

```ts
type SettingId = 'focal' | 'aperture' | 'shutterSpeed' | 'iso' | 'exposure' | 'mode';

interface CameraActions {
  enterPhotographyMode(): void;
  exitPhotographyMode(): void;
  shutter(phase: 'down' | 'up'): void;
  focus(uv?: Vector2): void;        // omitted = centre of frame
  zoom(deltaLogMm: number): void;
  selectSetting(id: SettingId): void;
  changeSetting(delta: number): void;
}
```

### Desktop bindings

| input | action |
|---|---|
| right-click | `enter` / `exitPhotographyMode` |
| mouse move | reticle **or** look, per the latched classifier (§7) |
| left press + release on an adjustable zone | `selectSetting(id)` only. Changing the value is always a separate gesture |
| left press + release on `mode` | `selectSetting('mode')` + `changeSetting(1)`, since it is purely cyclic |
| left press + release on `focusPoint` | `focus(uv)` |
| left press + release on the shutter button | `shutter('down')` on press, `shutter('up')` on release over the same volume |
| wheel, reticle over the **selected** zone | `changeSetting` on it |
| wheel, anywhere else | `zoom` — and since the reticle recentres on fade, this is the resting behaviour |
| left-drag horizontally starting on the **selected** zone | `changeSetting`, continuous — the dial |
| pointer lock lost | `exitPhotographyMode` |

**Keyboard exists only as an optional accessibility and development alternative**, is
documented as such, and is never the primary path: `[` `]` for `changeSetting`, `Tab` to
cycle selection, `Space` for `shutter`.

### Touch, later

The same actions, from a `PointerRay` producer that is already the mouse's path:

| gesture | action |
|---|---|
| tap the camera body while lowered | `enterPhotographyMode` |
| tap a screen zone | `selectSetting` |
| tap `focusPoint` | `focus(uv)` |
| tap the shutter button | `shutter` |
| drag on an adjustable zone | `changeSetting` |
| pinch | `zoom` |

No virtual buttons. No mobile HUD. The camera remains the interface.

---

## 9. ExposureModel

Aperture, shutter speed and ISO are linked through EV so the numbers are internally
consistent. Changing aperture in `A` mode moves shutter speed to compensate; changing
ISO shifts the pair. Exposure compensation offsets the target EV and grades the
viewfinder image.

This is roughly 40 lines and it is the thing a photographer notices in the first ten
seconds. `f/1.4 + 1/8000 + ISO 6400` showing a normally-exposed image would break the
illusion completely.

Standard third-stop sequences for each: `f/1.4 … f/22`, `30s … 1/4000`, `ISO 100 …
12800`, EV `−3 … +3`.

---

## 10. Settings additions

Per the project convention, no look value lives in a module.

```ts
export const PHOTOGRAPHY = {
  raise: { omega: 11, zeta: 0.62, arcLift: 0.06, arcPull: 0.04 },
  raisedRotationDeg: { x: -1.5, y: 0, z: 0 },
  raisedFollowLambda: 9.0,
  raisedRotationLambda: 11.0,
  raisedDriftScale: 0.4,
  raisedLookOffsetScale: 0.3,
  raisedBankScale: 0.35,
  screenHeightFraction: 0.36,
  moveScale: 0.28,
  lookScale: 0.8,
  lens: { minMm: 24, maxMm: 120, sensorHeightMm: 24, wheelStep: 0.055, lambda: 9 },
  reticle: {
    // Gesture classification. Latched, never blended.
    flickPxPerSec: 900, settlePxPerSec: 60, settleSeconds: 0.12,
    pxPerScreenWidth: 260,
    // Magnetism assists the landing only; it is scaled to zero while moving fast.
    magnetism: 0.12, magnetSpeedCutoff: 220,
    // radius is a fraction of the screen's width, as are all uv-space values here
    fadeDelay: 1.1, fadeLambda: 7, radius: 0.016,
  },
  screenUI: {
    primary: 0xf5efe6, secondary: 0xc9bfb1,
    accent: 0xf2b45c, confirm: 0xa8d8a8,
    emissive: 1.3, gridOpacity: 0.14,
  },
} as const;

export const VIEWFINDER = {
  ladder: [
    { width: 512, height: 341, hz: 30 },
    { width: 384, height: 256, hz: 20 },
    { width: 256, height: 171, hz: 12 },
    { width: 256, height: 171, hz: 0 },
  ],
  startRung: { high: 0, medium: 1, low: 2 },
  frozenDim: 0.55,
  watchdog: {
    bucketSeconds: 0.5,
    warmupSeconds: 1.0,
    cooldownSeconds: 3.0,
    degradeBelow: 0.92, degradeBuckets: 4,
    recoverAbove: 1.0, recoverBuckets: 16,
    maxRecoveries: 2,
  },
} as const;
```

`FLOATING_CAMERA.screen` is amended per §6.

---

## 11. Registration order

```
Sky, Backdrop, Terrain, Water
DesktopInput | TouchInput      gathers raw input
PhotographyMode                owns the mode; scales InputState before anyone reads it
FirstPersonCamera              consumes look delta
Player                         moves along that heading
FloatingCamera                 follows the view pose, now blended by `raise`
Viewfinder                     renders the RT from the settled camera pose
GrassField, PropLayer, Pollen, Lighting, wind, DevStats
```

`PhotographyMode` must precede the look system; `Viewfinder` must follow `FloatingCamera`
or the viewfinder lags the body by a frame.

---

## 12. Verification

- `npx tsc --noEmit` clean
- `npx vite build` clean
- No console errors or shader-compile failures in the in-app browser
- **Rest pose unchanged.** A DEV-only assertion in `CameraPose` checks that at
  `raise = 0` every blended term equals its rest constant exactly — anchor, the three
  rotation angles, both lambdas, and the drift / lookOffset / bank scales — and that
  both arc terms and the lead rotation are 0. This is the one regression that would be
  invisible in a screenshot and unacceptable if it happened.
- `DevStats` deltas raised vs lowered on desktop `high`, against the 80 calls / 1382k
  triangle baseline
- `?quality=medium&fps=30` holds 30 fps with the camera raised
- `?vf=3` and `?vf=0` force the ladder ends; the watchdog is exercised by forcing a high
  rung on a capped tier and confirming it steps down, cools down and latches
- **A transient does not degrade.** Injecting a single 300 ms stall while raised must
  leave the rung unchanged — this is the specific failure the median and the warm-up
  exist to prevent
- **Gesture classification is stable.** A gesture classified `RETICLE` stays `RETICLE`
  for its whole duration however fast it later becomes, and vice versa; verified with a
  DEV readout of the current state and the classifying peak
- **Passing over a control never activates it.** Sweep the reticle across every zone
  with no button pressed and confirm `PhotoState` is unchanged; press on one zone and
  release over another and confirm the same
- Enter / exit / enter repeatedly with no leaked render targets — `renderer.info.memory`
  stable across 20 cycles

## 13. Deferred

Depth of field from focus distance; histogram; captured-photo storage; the `focusMode`
and `metering` zones becoming live; a cheap bloom pass on the viewfinder texture so it
matches the main view's highlight treatment.
