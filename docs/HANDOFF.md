# Handoff — Photography Mode

Branch `photography-mode`, 28 commits, branched from `f2f7c0c` on `master`.
The handoff pass adds touch bindings and two small regression fixes. **76 tests pass**;
`typecheck` and `build` are clean.

Read `ARCHITECTURE.md` and `DECISIONS.md` first — this file covers only what is
specific to picking the work up, not how the project is built.

The design spec is `superpowers/specs/2026-08-01-photography-mode-design.md` and the
implementation plan is `superpowers/plans/2026-08-01-photography-mode.md`. Both were
amended during implementation whenever a defect was found in them, so they describe
what actually exists rather than what was originally intended.

---

## What this branch does

Right-click raises the floating camera from its resting position into a shooting pose.
Its rear screen becomes the game's only interface: a live viewfinder at a real focal
length, with the photographic readout drawn over it. A reticle constrained to the camera
resolves what you are pointing at. Movement drops to a slow shuffle while raised.

Nothing was added to the DOM. `ui/Boot.ts` is still the only HTML in the project.

## Module map

```
photography/          the mode and its semantics
  PhotographyMode     System. Owns the mode, gates input, implements CameraActions
  PhotoState          plain data + a revision counter. No three.js
  ExposureModel       aperture/shutter/ISO linked through EV. No three.js
  InteractionZones    the one table of named uv rects. No three.js
  GestureClassifier   latched reticle-vs-look state machine. No three.js
  CameraActions       the semantic interface every input producer targets
  CameraInteraction   reticle -> raycast -> zone -> hover/press/activate
  input/PhotoDesktopInput   every desktop binding, in one place

camera/               the physical object and its display
  CameraPose          the raise spring and the rest/raised blend
  Viewfinder          second camera, render target, cadence
  ViewfinderWatchdog  buckets, median, hysteresis, ladder. No three.js
  LiveCameraScreen    the screen mesh, its material, and the setters
  ScreenUI            Canvas2D -> CanvasTexture, redrawn only on change
  screenMaterial      the composite shader
  FloatingCamera      MODIFIED: targets the blended pose; merge splits the button

player/input/
  TouchInput          exploration gestures plus touch-ray Photography Mode actions
```

The five modules with no `three` import are the unit-tested ones. That is deliberate —
they encode invariants that cannot be checked by looking at the screen.

## The four things worth understanding

### 1. Photography Mode only changes the *target* pose

`FloatingCamera` already separated the target pose from the actual pose and damped
between them. Photography Mode never touches that filter — it only moves the target, so
the raise inherits the existing sense of weight for free.

**At `raise = 0` the arithmetic is bit-identical to before this branch.** Every new
factor is exactly `1` at rest, and IEEE-754 multiplication by 1.0 is lossless.
`CameraPose` carries a DEV assertion that fires if that ever stops being true. If you
change anything in `CameraPose.resolve` or `FloatingCamera.updateTarget`, that assertion
is the thing protecting exploration feel.

### 2. Movement is gated in the input layer, not in `Player`

`PhotographyMode` is registered *before* `FirstPersonCamera` and scales the shared
`InputState` in place. `Player.ts` and `FirstPersonCamera.ts` are untouched by this whole
branch and must stay that way.

Registration order is the correctness argument:

```
raw input  ->  photography (scales in place)  ->  look (drains)  ->  player
```

`consumeLook` zeroes the look deltas when it reads them, which is the only reason
scaling them in place works. Reorder these and the gating silently stops working.

### 3. The viewfinder is a real second render pass, and it pays for itself

A `PerspectiveCamera` at the lens, rendered into a small target, **active only while
raised** — exploration costs nothing. The camera model sits on `CAMERA_LAYER` (1) and the
viewfinder camera has that layer disabled, so the camera cannot appear inside its own
screen.

Focal length is real: a 36×24 mm frame, `2·atan(12/f)`. The player's naked 62° view is a
~20 mm lens, so **every focal length from 24 mm up is a genuine crop**, not a decorative
number. Zoom accumulates in log space because linear steps make 24→34 mm violent and
110→120 mm imperceptible.

`ViewfinderWatchdog` steps the pass down a four-rung ladder against the *achieved present
rate*. Wall-clock `dt` cannot reveal the cost — under a frame cap it measures the rAF
interval, not the work. Every decision reads a **median** of 0.5 s buckets, never a mean,
so one stalled frame cannot trigger a downgrade.

### 4. Colour still happens in exactly one place

The renderer stays `NoToneMapping`/`LinearSRGBColorSpace` for the whole frame. The ACES
curve now lives in `ACES_GLSL`, exported from `composite.glsl.ts` and interpolated by
*both* `compositeFragment` and `screenMaterial`. There is one copy. Keep it that way.

The screen outputs around 1.3 in linear so it reads as emissive after the composite's
ACES, and stays under `POST.bloom.threshold` (1.85) so it never smears. Worst-case
analysis puts the ceiling at ~1.36 — about 26% headroom.

---

## Verified, and not

**Verified in the browser** (desktop, 1280×720, `high`):

| | calls | triangles | fps |
|---|---|---|---|
| at rest | 81 | 987k | 170 |
| raised | 100 | 1795k | 170 |

`?quality=medium&fps=30` raised, held 12 s: **30 fps, budget 33.3 ms, ladder rung 1**, no
downward drift. That is the mobile target the ladder exists to protect, and it held.

Also confirmed: the rest pose is visually unchanged; the raised pose is centred and
square-on; the viewfinder shows a genuinely tighter crop than the naked view; focal
wheel and focus confirmation work; `?vf=0` and `?vf=3` reach their intended ends; and
the in-app browser held `143g 11t` across 20 raise/lower cycles. The browser emitted one
generic Chromium `UnknownError` diagnostic with no application stack; no shader compile
failure or application error accompanied it.

**Not verified:**

- **Every interaction binding by hand.** Wheel-to-zoom and focus were driven; pointer-lock
  automation could not reliably produce a slow reticle gesture, so hover, press,
  cancel-by-releasing-elsewhere, drag-a-dial, and shutter-cap depression still need a
  human browser pass.
- **Anything on real mobile hardware.** Unchanged from before this branch — still the
  project's top open item.
- Touch bindings are implemented but remain unverified on real multi-touch hardware.

## Environment quirks that will waste your time

- **The in-app Browser pane throttles when backgrounded.** `document.hidden` goes true,
  `Engine.tick` early-returns, and nothing composites — so `DevStats` never accumulates a
  sample and the raise spring advances only a frame or two per screenshot, never settling.
  The pane must be genuinely visible to evaluate anything time-based.
- **A Vite HMR partial update can leave two `Engine` instances on one canvas** — two
  DevStats overlays, two sets of listeners, and an apparently non-functional toggle. A
  hard reload fixes it. Do not chase it as a defect.
- **Pointer lock can suppress the native `contextmenu` event.** The desktop binding
  toggles on the right-button press and uses `contextmenu` only to suppress the browser
  menu, so automation should send a real right-button click rather than dispatching a
  synthetic `contextmenu` event.

---

## Deferred minors, for triage

None of these block anything. They were logged during review and consciously deferred.

**Completed in this handoff pass:**

- `formatAperture` no longer prints a trailing zero on whole-stop apertures.
- Desktop dial drag and wheel input now require `Zone.adjustable`.
- `ViewfinderWatchdog.reset()` has a regression test preserving the current rung.
- Touch bindings now route through `CameraActions` and `CameraInteraction`.
- Desktop right-click now toggles on button press, so it still works after pointer lock.

**Still worth doing:**

1. Add focused coverage for `castFocusRay` and `updateFocusRect`; their correctness still
   rests on uv conventions in `screenMaterial` and `InteractionZones`.

**Cosmetic or low-risk:**

5. The warm-up guard in the watchdog is vacuous — deleting it does not fail its test,
   because the minimum-window guard already subsumes it.
6. With `maxRecoveries: 2`, one recovery plus one latch exhausts the lifetime budget, so a
   device that degrades–recovers–degrades can never recover again.
7. `?vf=3` pinned from a *cold* start shows an uninitialised render target rather than a
   held frame, because rung 3 never renders and the pinned path never passes through
   rung 2 first. Debug-only override; the watchdog-driven path is unaffected.
8. The latch threshold `failed >= 2` is a hardcoded constant while every neighbouring
   threshold lives in `VIEWFINDER.watchdog`.
9. `GestureClassifier.phase` and `.locked` are mutable public fields, so a consumer could
   assign them directly and break the latch from outside.
10. No test covers `'P'` shooting mode in `derivedSetting`; `formatAperture`/`formatIso`/
    `formatFocal` have no coverage either.
11. `onKeyDown` does not `preventDefault` on Space, which could scroll the page alongside
    firing the shutter if focus ever leaves the locked canvas.
12. The focus ray approximates the lens as the model's world position rather than the
    exact `LENS_LOCAL` offset — about 13 cm. Negligible against a 1.5 m march step, but it
    could shift a 1–2 m reading by a tenth of a metre.
13. Two `smoothstep` calls in `screenMaterial` use `edge0 > edge1`, which GLSL calls
    undefined. Every mainstream vendor produces a well-behaved reversed ramp and the
    result was hand-traced to stay in `[0,1]`. Portability note only.

## Deliberately not built

Per the spec, and **not** oversights:

- **Photo capture is a stub.** `PhotographyMode.onCapture` is declared and invoked but
  nothing subscribes. No file is written, no album exists.
- **Touch bindings are implemented.** `TouchInput` uses the existing raycast path for
  body/screen taps, focus, shutter, adjustable-zone drags, and pinch zoom. Real-device
  validation remains open.
- Depth of field, histogram, and live `focusMode`/`metering` zones. The focus distance
  that DoF needs is already measured and displayed.

## Things that will bite you

- **`StaticCameraScreen.ts` looks unused. Leave it.** It is the documented hard floor for
  when half-float render targets are unavailable.
- **`setRung` early-returns when the resolution is unchanged.** Rungs 2 and 3 share
  256×171 and differ only in `hz`, so the `rung` assignment and the `setFrozen` call must
  sit outside that early return. This is the one place the ladder could silently fail to
  freeze.
- **`LiveCameraScreen.setFeed` unconditionally re-brightens the material.** Any new call
  to it after `setFrozen` will silently undo the dim. This bug has been fixed twice
  already, in two different scopes.
- **`PhotographyMode` must never import `Viewfinder`.** `Viewfinder` already depends on
  `PhotographyMode`; the reverse is a cycle. That is why `CameraInteraction` computes the
  focus ray and writes the result back.
- **Zones are authored y-down; `zoneAtUv` takes a y-up three.js uv and flips internally.**
  The flip belongs in exactly one place. The focus path deliberately does *not* flip.

---

## Result of this handoff pass

1. Browser verification covered high/medium cadence, forced rungs, focal wheel, focus,
   and the 20-cycle memory check.
2. The adjustable-zone, aperture-formatting, and watchdog-reset minors were triaged.
3. Touch bindings were added without changing `Player.ts`, `FirstPersonCamera.ts`, the
   sky, grass, lighting, post-processing, or movement constants.
4. The remaining handoff is human reticle-zone verification and iPhone 15 Safari
   acceptance. Photo capture remains deferred by design.
5. Desktop right-click now toggles on `mousedown` because pointer lock can suppress
   `contextmenu`; the browser menu is still suppressed and the behavior has regression
   coverage.
