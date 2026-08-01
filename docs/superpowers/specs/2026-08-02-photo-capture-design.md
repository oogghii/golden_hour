# Photo Capture and the Album — Design

Phase 12. Completes the one thing Phase 11 declared a stub: `PhotographyMode.onCapture`
is declared, invoked, and subscribed to by nothing. Pressing the shutter today decrements
a three-digit counter in the corner of a small screen and does nothing else.

Read `2026-08-01-photography-mode-design.md` first. This builds entirely on its machinery
and changes none of its decisions.

## Goal

Pressing the shutter — the cap on the camera body, or `Space` on desktop — takes a real
photograph of what the viewfinder is showing, plays a mechanical SLR capture animation,
stores the image, and lets the player browse everything they have shot on the camera's
own rear screen.

## Non-goals for this milestone

- **No file download and no export.** Photos live in the album. Nothing is written to disk.
- **No deletion, favouriting, rating or sorting.** The album is a roll of film in order.
- **No grid or contact-sheet view.** One photo at a time, full screen.
- **No sound.** The project has no audio layer and this is not the feature that adds one.
- **No depth of field, histogram, or viewfinder bloom.** Still deferred, unchanged.

## Constraints that must survive

Every constraint from Phase 11 holds. Restating the three this feature is most likely to
break:

1. **Nothing is added to the DOM.** `ui/Boot.ts` stays the only HTML in the project. The
   album is drawn on the rear screen, like everything else. (IndexedDB is not DOM.)
2. **`Player.ts` and `FirstPersonCamera.ts` are not touched.**
3. **Colour happens in exactly one place.** `ACES_GLSL` already has one definition, shared
   by `compositeFragment` and `screenMaterial`. The develop pass makes it a third
   consumer of the same constant — not a third copy.

A fourth, specific to this feature:

4. **A dropped photo must never break the game.** Storage is the one part of this that
   depends on the browser cooperating. Every failure mode degrades to "you still saw the
   picture, it just was not kept", never to a broken camera.

## 1. Module map

```
photography/capture/
  PhotoCapture       System. Owns the two targets, the develop pass, the readback and
                     the handoff to storage. Drives the screen's capture uniforms. three
  developMaterial    fullscreen gain -> ACES -> sRGB. three
  CaptureSequence    the animation timeline as a state machine. No three. TESTED
  AlbumState         which photo is showing and how flipping moves it. No three. TESTED
  PhotoLibrary       IndexedDB: open, put, count, listIds, get. No three
  photoRecord        builds the stored record from PhotoState. No three. TESTED
```

Three of the six have no `three` import and are unit tested, matching the existing split:
the modules that encode invariants you cannot check by looking at the screen are the
modules that get tests.

`PhotoLibrary` is deliberately thin and untested — it is an IndexedDB transcription with
no logic of its own, and testing it would mean adding `fake-indexeddb` as a dependency to
assert that IndexedDB is IndexedDB. Everything with a decision in it lives in
`photoRecord` and `AlbumState`, which are tested.

## 2. Where the photo's pixels come from

**Not the live viewfinder target.** It is 512x341 at rung 0 and 256x171 once the watchdog
degrades, so photographs would quietly get worse as the machine got hotter. The viewfinder
target exists to be shown at the size of a thumbnail on a model's rear screen; it is not a
negative.

**A dedicated capture render, taken through the viewfinder's own camera.** Sharing the
camera object — rather than reconstructing the pose a third time — is what guarantees the
photograph is exactly the framing the player composed. `Viewfinder` gains:

```ts
/**
 * Places the lens camera for this frame and returns it. Exposed so PhotoCapture
 * photographs precisely what the viewfinder is showing rather than reconstructing
 * the pose and drifting from it.
 */
prepareCameraForCapture(): THREE.PerspectiveCamera | null;
```

Returning it from a method that places it first makes the call order-independent:
`PhotoCapture` does not have to be registered after `Viewfinder` to get a correct pose.

Resolution is 3:2, scaled by tier:

| tier | pixels |
|---|---|
| high | 1620 x 1080 |
| medium | 1200 x 800 |
| low | 900 x 600 |

## 3. Two targets, and why

```
scene --(lens camera)--> captureTarget    HalfFloat, linear, HDR
captureTarget --(develop pass)--> photoTarget    RGBA8, sRGB
```

The scene renders linear and un-tonemapped, exactly as the viewfinder pass does. The
develop pass then applies, in order:

1. **`uGain`** — `viewfinderGain(state)`. The exposure model is the whole point of the
   camera; shoot at f/22 and the photograph is dark. Without this the settings would be
   decorative.
2. **ACES**, via the shared `ACES_GLSL`.
3. **sRGB encode**, so the bytes are directly presentable and directly encodable.

It does **not** apply the LCD grade (`screenMaterial`'s black lift and desaturation), the
grid, the reticle, the focus frame, or the glass vignette. Those are the *screen*
simulating a screen. A photograph is the image, not a picture of the display showing it.

`photoTarget` is RGBA8 because `readRenderTargetPixels` requires a readable format, and
because the encoded result is 8-bit regardless.

## 4. The capture sequence

`CaptureSequence` is pure timing over a single elapsed clock. Phase boundaries, in
seconds, all from `PHOTOGRAPHY.capture`:

| window | phase | what the player sees |
|---|---|---|
| 0.00 – 0.09 | `blackout` | the image slams to black — the mirror going up |
| 0.09 – 0.15 | `flash` | a bright inset frame-edge line as the black lifts |
| 0.15 – 1.10 | `review` | the photograph, held |
| 1.10 – 1.30 | `return` | cross-fade back to the live feed |

Three envelopes, each `0..1`, each read by the shader:

- **`blackout`** — `0 -> 1` over `[0, 0.05]`, holds `1` to `0.09`, `1 -> 0` over `[0.09, 0.15]`.
- **`flash`** — `0 -> 1` over `[0.09, 0.11]`, `1 -> 0` over `[0.11, 0.15]`.
- **`photoMix`** — `0` until `0.09`, `1` through `1.10`, `1 -> 0` over `[1.10, 1.30]`.

`photoMix` switching under full blackout is what makes the reveal read as a shutter rather
than a cross-fade: the live feed is replaced while nothing is visible, so the photograph is
simply *there* when the black lifts.

**The render happens on the first frame at which `blackout` has reached `1` — not on the
first frame of the sequence.** This distinction is the whole point of the animation and is
easy to get wrong. The capture render plus the develop pass is the most expensive thing in
its frame, roughly the viewfinder's cost at three times the resolution. Firing it at `t=0`
would put that hitch on a frame where the screen is still showing the live feed, which is
precisely where it is visible. Firing it at `t = blackoutInSeconds` puts it inside the
fully-black hold window, which is what the hold window is for.

`CaptureSequence` therefore exposes a one-shot:

```ts
/** True for exactly one update, on the first frame at which blackout is fully 1. */
get shouldRender(): boolean;
```

`PhotoCapture` polls it. The `blackoutHoldSeconds` window exists solely to give that frame
somewhere to happen, which is why it is tuned as a duration rather than a feel.

**Nothing waits on storage.** The review shows `photoTarget.texture`, which is already on
the GPU the moment the develop pass finishes. Encoding to a blob and writing to IndexedDB
happen afterwards, off the critical path, and their success or failure never affects what
is on screen. Readback uses `readRenderTargetPixelsAsync` (three 0.185 has it), so even
the readback does not stall the pipeline.

### Re-entry and interruption

- `start()` returns `false` and does nothing if the sequence is already running. A real
  mirror is up; a second press does not fire a second frame.
- `shutter()` no-ops entirely while `isBusy`, while the album is open, and — as today —
  when `remainingShots` is `0`.
- Lowering the camera mid-sequence calls `cancel()`, which returns to `idle` immediately.
  A photograph already rendered is still stored; the review is simply abandoned. This
  mirrors `CameraInteraction`'s existing "lowering cancels a press in flight".

## 5. Screen modes

`PhotoState` gains one field:

```ts
/** What the rear screen is showing. */
screenMode: 'live' | 'review' | 'album';
```

`review` is set by `CaptureSequence` and cleared by it. `album` is set by the player.
Because `ScreenUI` redraws only when `state.revision` changes, every mode transition must
call `touch(state)`.

`screenMaterial` gains four uniforms:

| uniform | meaning |
|---|---|
| `uPhoto` | the photograph — `photoTarget.texture` in review, the decoded album texture in album |
| `uPhotoMix` | `0` live feed, `1` photograph |
| `uBlackout` | `0..1`, multiplies the image toward black |
| `uFlash` | `0..1`, the frame-edge flash |

There is deliberately no `uAlbum`. The album holds `uPhotoMix` at `1`, and everything a
separate album flag would have suppressed is already gated on `uPhotoMix` — a second
uniform would be a second source of truth for the same thing.

In the fragment shader the live furniture — rule-of-thirds grid, focus frame, level
indicator, reticle, hover wash — is multiplied by `(1.0 - uPhotoMix)`. A photograph is
never covered in viewfinder markings. The glass vignette and sheen stay in all modes: those
are properties of the display, and the display is still a display.

## 6. The album

### Entering and leaving

The `status` zone already exists in `InteractionZones` — top right, `settingId: null`,
`adjustable: false` — and `CameraInteraction.release()` currently falls through it doing
nothing. It draws the remaining-shots count, which is exactly the right affordance for
"how many pictures do I have". Tapping it opens the album; tapping it again closes it.

`togglePhotographyMode()` closes the album first if it is open, instead of lowering the
camera. One press, one level of undo — right-click and `Esc` therefore both back out of
the album before they back out of Photography Mode, which is what a player expects.

### Navigation

| input | action |
|---|---|
| wheel | previous / next photo |
| left / right arrow | previous / next photo |
| horizontal drag | previous / next photo, `dragPxPerStep` as elsewhere |
| horizontal swipe (touch) | previous / next photo |
| tap `status`, `Esc`, right-click | close the album |

`Space` does nothing in the album. You cannot shoot what you are already looking at.

`AlbumState` clamps at both ends and **does not wrap**. Reaching the first photograph and
being thrown to the last is disorienting in a container that has a real beginning.

### Texture lifetime

One decoded texture at a time. Flipping disposes the previous texture and decodes the next
via `createImageBitmap`, cross-fading over `PHOTOGRAPHY.album.fadeSeconds`. A ~400 KB JPEG
decodes in well under a frame's budget asynchronously, and holding one image rather than a
cache means the album's memory cost does not grow with the roll.

Flips are absorbed rather than queued: `AlbumState` moves immediately on every flip, and a
decode that lands for an index the player has already moved past is discarded rather than
displayed. Holding the arrow key down therefore skates through the roll and settles on
whichever photograph the player stopped at, instead of playing back a backlog of decodes.

### Album chrome

`ScreenUI` gains an album layout, selected on `state.screenMode`. It replaces the exposure
bar and settings row with:

- **top left** — the frame number, `12 / 24`
- **top right** — the date the photograph was taken
- **bottom** — the settings it was taken at: `36mm F2.8 1/250 ISO 400`, and the focus
  distance

Those strings are stored with the photograph rather than re-derived, so the album shows
what the camera actually read at the moment of the shot. It is the closest thing this
project has to EXIF, and it costs nothing.

## 7. Storage

One IndexedDB database, `golden-hour`, one object store, `photos`, key `id` autoincrement.

```ts
interface PhotoRecord {
  id: number;
  takenAt: number;        // epoch ms
  blob: Blob;             // image/jpeg
  focalMm: number;
  aperture: string;       // 'F2.8'
  shutterSpeed: string;   // '1/250'
  iso: string;            // 'ISO 400'
  focusDistance: string;  // '3.2 m' | '∞'
}
```

Formatted strings, not ladder indices: the album must show what the display showed, and a
future change to a ladder must not silently rewrite the history of what was shot.

JPEG at quality 0.92 — roughly 400 KB at 1620x1080. PNG would be about 4 MB, and a full
248-shot roll of those is a quarter of a gigabyte for a game about walking in a field.

### Failure modes, all of which fail soft

| failure | behaviour |
|---|---|
| IndexedDB unavailable (private mode, disabled) | capture and review work normally; nothing persists; the top-right counter reads `NO CARD` and the album refuses to open |
| `QuotaExceededError` on write | the top-right counter reads `FULL`; further captures refuse; existing photos stay browsable |
| readback or encode throws | the review still plays — it comes from the GPU, not from the blob — and the write is skipped with one DEV-only warning |

All three reuse the top-right `status` zone, which already draws the remaining-shots count.
A camera reports card trouble where it reports frames remaining.

`remainingShots` already decrements and already stops at zero, so the film-roll limit needs
no new code.

## 8. Semantic actions

`CameraActions` gains two, keeping the rule that nothing outside it reaches into
`PhotoState`:

```ts
  /** Opens or closes the album on the rear screen. */
  toggleAlbum(): void;
  /** Steps through the album. `delta` is in photos. */
  flipAlbum(delta: number): void;
```

`zoom`, `focus`, `changeSetting` and `selectSetting` all no-op while the album is open.
Browsing is a separate mode, not an overlay on a live camera.

## 9. Settings additions

```ts
capture: {
  /** 3:2, matching the sensor and the screen. */
  resolution: { high: [1620, 1080], medium: [1200, 800], low: [900, 600] },
  jpegQuality: 0.92,
  /** Seconds. The blackout must be long enough to hide the capture render. */
  blackoutInSeconds: 0.05,
  blackoutHoldSeconds: 0.04,
  flashSeconds: 0.06,
  reviewSeconds: 0.95,
  returnSeconds: 0.20,
},
album: {
  /** Cross-fade between photographs. */
  fadeSeconds: 0.18,
},
```

## 10. Registration order

`PhotoCapture` is added after `Viewfinder`, so a capture in frame N photographs the pose
the viewfinder settled on in frame N. `prepareCameraForCapture()` makes this a preference
rather than a requirement, but the natural order should still be the correct one.

```
input -> photography -> look -> player -> floatingCamera -> interaction
      -> viewfinder -> photoCapture -> grass -> props -> pollen -> lighting
```

## 11. Testing

**`CaptureSequence`** — the module that must not be wrong, because a stuck sequence locks
the screen:

- phases occur in order and the total duration is the sum of its parts
- `shouldRender` is true for exactly one update in the whole sequence, and `blackout` is
  exactly `1` on that update — the assertion that keeps the capture hitch out of view
- `photoMix` flips from `0` to `1` only while `blackout` is `1`, never in view
- every envelope stays within `[0, 1]` at every step, including at exact boundaries
- `start()` returns `false` while busy and does not restart the clock
- `cancel()` returns to `idle` with all envelopes at rest
- the sequence terminates: after `totalSeconds`, `phase` is `idle`

**`AlbumState`** — clamps at both ends, does not wrap, reports `null` when empty, and
survives the roll growing underneath it while open.

**`photoRecord`** — the metadata matches what the display was showing at the shutter,
including `∞` focus and the `F2` / `F11` aperture-formatting boundary.

**By hand in the browser** — the animation reads as a shutter; the photograph matches the
framing that was composed; a photograph shot at f/22 is visibly darker than one at f/2.8;
the album survives a reload; the frame counter and album count agree.

## 12. Build order

There is a natural gate halfway through, and the plan should use it: **capture, the
sequence and the review are independently shippable without the album existing at all.**
At that point Space takes a photograph, the animation plays, the image is written to
storage, and nothing yet reads it back. Everything in sections 2 through 5 and 7 is done;
section 6 is untouched.

That midpoint is worth stopping at and looking at, because it is where the feel of the
shutter gets judged, and the album is easier to build against a store that is already
filling with real photographs than against an empty one.

## 13. Deferred

Unchanged from Phase 11, minus capture: depth of field, histogram, live `focusMode` and
`metering` zones, viewfinder bloom. Newly deferred and deliberately so: deleting photos,
exporting them off the album, and any grid view.
