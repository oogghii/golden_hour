# Handoff — Photography Mode

Branch `photography-mode`, branched from `f2f7c0c` on `master`. The handoff pass added
touch bindings and two small regression fixes; the triage pass after it cleared the
deferred-minors list entirely; Phase 12 then built photo capture and the album.
**112 tests pass**; `typecheck` and `build` are clean.

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

Re-confirmed after the triage pass: `?vf=3` from a cold start holds a real dimmed frame
with live chrome over it, at `vf r3`; the default rung still shows a live, correctly
cropped feed; the rewritten `smoothstep` ramps compile and the corner sheen still sits
top-left; no console or dev-server errors.

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

**The list is empty.** Every item logged during review has been cleared — see *Result of
the triage pass* below for what each one turned into. Nothing new was deferred in its
place. What remains open for this phase is the human browser pass and real-device
acceptance, both listed under *Verified, and not*.

## Deliberately not built

Per the spec, and **not** oversights:

- **Touch bindings are implemented.** `TouchInput` uses the existing raycast path for
  body/screen taps, focus, shutter, adjustable-zone drags, pinch zoom, and album swipes.
  Real-device validation remains open.
- Depth of field, histogram, and live `focusMode`/`metering` zones. The focus distance
  that DoF needs is already measured and displayed.
- Deleting, exporting or downloading photographs, and any grid view of the album.

**Photo capture is no longer a stub** — see below.

## Phase 12: photo capture and the album

`onCapture` finally has a subscriber. `docs/superpowers/specs/2026-08-02-photo-capture-design.md`
is the design and `docs/superpowers/plans/2026-08-02-photo-capture.md` the plan.

```
photography/capture/
  CaptureSequence   the shutter animation as pure timing. No three. TESTED
  PhotoCapture      System. Targets, the capture render, readback, storage
  developMaterial   gain -> ACES -> sRGB. The photograph, not the screen showing it
  PhotoLibrary      IndexedDB. Every failure is a status, never a throw
  photoRecord       what a photograph remembers. No three. TESTED
  AlbumState        the cursor through the roll. No three. TESTED
  AlbumView         System. Decodes and shows the photograph being browsed
```

**The three things most likely to bite you:**

- **The capture render fires on the frame `CaptureSequence` reports fully black, not on
  the first frame of the sequence.** It is the most expensive frame in the animation and
  the blackout exists to hide it. `CaptureSequence.test.ts` asserts `blackout === 1` on
  the render frame. If you retime `PHOTOGRAPHY.capture`, that test is what protects the
  shutter from becoming a visible stutter.
- **`texture.flipY` does nothing for `ImageBitmap`.** WebGL ignores
  `UNPACK_FLIP_Y_WEBGL` for that source type. The album flips at decode via
  `createImageBitmap`'s `imageOrientation`. This bug shipped upside-down photographs
  once already and was only caught by eye.
- **`PhotoCapture` and `AlbumView` both write `uPhoto` and `setCapture`.** They are
  mutually exclusive by construction — the shutter no-ops while the album is open, and
  the album refuses to open over a capture in flight — and `AlbumView` is registered
  second so it wins the frame a transition straddles. Break either guard and the two
  will fight over the screen.

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

---

## Result of the triage pass

The deferred list is now empty. **91 tests pass**; `typecheck` and `build` are clean.
Three of these were behaviour changes rather than tidying, and they are the ones to read
first if something looks different:

**Two were real defects, not cosmetics:**

- **The focus ray started at the model origin, not the lens.** It now starts at
  `FLOATING_CAMERA.lensLocal`, the same offset `Viewfinder` places its camera at — which
  is the point: the ray and the image must agree about where the lens is. The offset is
  ~13 cm, but it moved a 15.7 m reading by 0.6 m, because the error is along the ray, not
  across it. `lensLocal` moved into `Settings` so the two cannot drift apart again.
- **`?vf=3` from cold showed an uninitialised target.** A frozen rung reached from below
  always has a last frame to hold; one pinned from cold never rendered at all. The
  viewfinder now draws exactly one priming frame before freezing, and re-primes whenever
  `setRung` reallocates. Verified in the browser: `?vf=3` cold now holds a real dimmed
  frame with live chrome over it.

**One tuning constant changed:**

- **`VIEWFINDER.watchdog.maxRecoveries` is 3, was 2.** A latch spends a lifetime recovery
  on top of raising the floor, which is deliberate — but at 2, one recovery plus one latch
  spent the entire budget, so a device that degraded, recovered and degraded again could
  never climb back to its own floor. The intent was less benefit of the doubt, not none.
  `latchFailures` joined it in `Settings`, replacing a hardcoded `failed >= 2`.

**The rest were structural or coverage:**

- `GestureClassifier.phase` and `.locked` are getters over private state, so the latch
  cannot be broken from outside.
- Space now `preventDefault`s, so firing the shutter cannot also scroll the page.
- The three reversed `smoothstep` calls in `screenMaterial` are written as
  `1.0 - smoothstep(lo, hi, x)`. Not an approximation — smoothstep is symmetric about its
  midpoint, so `S(1-t) == 1-S(t)` exactly. The corner sheen confirms the direction by eye.
- The watchdog's warm-up guard was called vacuous. It is not: a spike lasting the *full*
  warm-up window is two bad buckets, and the median of `[bad, bad, good, good]` does sit
  below the degrade threshold. The old test only produced one bad bucket, which the median
  absorbs on its own. The test was strengthened rather than the guard deleted — deleting
  it now fails.
- `castFocusRay` and `updateFocusRect` have focused coverage in
  `CameraInteraction.test.ts`, built on a real raycast against a real plane so the uv
  conventions are exercised end to end rather than asserted. Each assertion was checked by
  mutation: flipping `v`, dropping the lens offset, and squaring the frame in uv all fail
  it.
- `'P'` shooting mode, `formatAperture`, `formatIso`, `formatFocal` and
  `formatFocusDistance` are covered.
