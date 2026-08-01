# Decisions

Why things are the way they are. Read the **Do not change** section before touching
anything visual — several of these values look wrong in isolation and are load-bearing.

## Locked with the project owner

| Decision | Choice |
|---|---|
| Stack | Vite + TypeScript. Lightweight and modular, no unnecessary abstraction |
| Grass | Hybrid — real instanced blades near, alpha-textured cross-quad clusters far |
| World | Finite art-directed valley, ~350 m walkable, soft haze boundaries not walls |
| Mobile input | Drag anywhere to look, touch-and-hold to walk, second finger to stroll. No visible control of any kind. **Implemented in Phase 8; hardware validation pending** |
| Mobile target | **Stable 30 fps, not 60.** Atmosphere beats frame rate. Subtle camera-only motion blur is explicitly sanctioned to help |
| Camera rear screen | Static/emissive for the first milestone, behind a `CameraScreen` interface so a live render target drops in without refactoring. **Implemented in Phase 7** |
| Build order | Post-processing pulled ahead of props, so the palette is tuned once against final grading |

## Do not change without understanding why

### `SUN.azimuthDeg = 8`, `SUN.elevationDeg = 6.5`

Owner reviewed the composition and asked to keep it. 6.5° is low enough for long
raking shadows but high enough that `normalBias` can clear the shadow acne a grazing
sun causes. `Settings.sunDirection()` is the single source of truth — `Sky`,
`Lighting`, `Water`, `GrassMaterials` and `PostFX` all read it, so the visual sun and
the shadow direction can never disagree. Changing the angle moves all five.

### `POST.bloom.threshold = 1.85`

Must stay clearly **above** the sky's base brightness. `SKY.horizon` peaks near 1.0 in
linear; a threshold of 1.05 with a wide knee let a slice of the entire sky into the
bloom, which blurred across the frame and veiled everything in milk. The sun disc
(9.0) and backlit grass tips still bloom hard.

### `GRASS.lightColor = 0xffe6c4`, not `SUN.color`

The grass is lit by a paler, near-white gold than the sun disc. Multiplying a green
base by a saturated orange gives olive-orange **however green the palette is**. This
was the single biggest cause of the field reading as orange.

### `GRASS.translucencyColor = 0xe4dda8`, `translucency = 0.55`, cone `pow(...,4.5)`

Backlit glow is the best effect in the project, and the easiest to overdo. Light
through a leaf comes out lime-gold, not orange — tinting it with the sun colour floods
the frame. It started at 1.5 with a `pow(...,3)` cone and washed out everything.

### `GRASS.palette.tip = 0x9caa66` — deliberately off pure green

With almost no blue in the palette, the translucency term drives green high against a
near-zero blue channel and the field goes neon lime.

### `SUN.fillSky` rose / `SUN.fillGround` cool slate

Warm light against cool shadow. This is what makes the scene read as rich rather than
as one orange wash. The original olive-brown fill just added more of the same hue
everywhere. Do not "fix" the fill to match the sun.

### `FOG.color = 0xe8a695` — rose, not orange

Saturated orange haze overwrites every other hue at distance and flattens the scene
into one colour. Pulling it toward dusty rose is what lets greens and blues survive
into the mid-ground.

### `LAKE.deep = 0x7e9ea8` and the fresnel cap of `0.72`

Two separate bugs are fixed here and both will come back if you touch it:

1. **Water read as lava.** Ripple noise was at 0.33/0.74 world scale, so at 140 m each
   wave was a huge on-screen blob; the glint threshold was low; and the sun-path term
   was `dot*0.5+0.5` to the 6th, which is ≈1 across the whole lake. Now: high-frequency
   specks (2.6/5.9), a hard `smoothstep(0.68, 0.94)` cut, and a genuinely narrow
   `pow(alignment, 42.0)` corridor.
2. **Water lost all blue at distance.** `fresnel → 1` as the view grazes, so the far
   lake became 100% warm reflection. The cap keeps some body colour at every angle,
   and the reflection itself blends warm→teal by sun alignment.

`deep` is also deliberately light. These mix in **linear** space, where a dark swatch
is far darker than it looks; too dark and it turns to red mud against warm light.

### `BACKDROP.layers` — heights rise faster than distance

Angular height must **increase** with distance (0.168 → 0.233 rad). Getting this
backwards makes the nearest ridge angularly tallest, which hides every layer behind it
and collapses the backdrop into one silhouette. `TERRAIN.rim.amplitude` is kept low (8)
for the same reason — a taller rim occludes the whole backdrop.

### The shore-closing clamp in `HeightField.heightAt`

The `Math.max(h, LAKE.level + 0.5 * shore)` block guarantees the basin closes. Without
it, hill noise can stay below the waterline past the basin and `Water`'s outward march
clamps to its maximum radius, cutting a straight chord across the lake. The boundary
wobbles by ±9 m of noise on purpose: a smooth boundary produced a suspiciously neat oval.

### `Sky` cloud projection uses `(h + 0.12)`, not `max(h, 0.12)`

A hard clamp freezes the divisor below the cutoff and smears the cloud pattern into
vertical stripes at the horizon. Needs a smooth floor.

Separately, the projection **scale** matters enormously: at `* 0.055` the entire visible
sky sampled one flat spot of the noise field and no clouds appeared at all. It is now
`* 0.9`.

### `SKY.cloudQuantize = 0.15`

Owner reviewed and asked to keep it. The reference image has voxelized clouds; the brief
asks for a smooth organic sky with stylization reserved for man-made objects, so smooth
is the faithful reading. Push toward 1.0 for flat stylized banding.

### `POST.saturation = 1.14` applied **after** the tonemap

ACES desaturates as it compresses, which drains a bright warm sky toward cream.
Restoring saturation after the curve buys the colour back without pushing pre-tonemap
values into clipping. `POST.exposure = 0.88` keeps the sky below the ACES shoulder for
the same reason. It was briefly at 1.3 and made the grass neon.

### `renderer.autoClear = false` and `info.autoReset = false` in `PostFX`

Both are required. With `autoClear` on, three wipes the target before each additive
bloom upsample and the chain never accumulates. With `info.autoReset` on, stats reset
per render call and only ever report the final blit — which is exactly how a working
scene appeared to be "1 draw call, 0 triangles".

### Motion blur is camera-only by construction

It reprojects depth with the previous frame's view-projection matrix. Because it uses
only camera matrices, moving geometry never smears — the wind stays crisp. Do not
"upgrade" it to a per-object velocity buffer; smearing the grass is not wanted.

## Deviations from the original plan

- **`EngineContext` does not carry the player or height field.** The plan had it as a
  shared bag. Passing those to constructors instead keeps dependencies visible and
  stops it becoming a god object.
- **No per-instance radial culling in grass tiles.** The plan proposed lowering
  `instanceCount` for instances outside the fade radius. That would require re-culling
  every frame as the player moves; instead tiles are culled whole (`mesh.visible`) and
  out-of-range blades are degenerate zero-height geometry. Tile layout stays a pure
  function of coordinates, which is what makes recycling stable.
- **Grass has three bands, not two.** Two materials, three rings. Two bands left either
  a sparse mid-ground or an unaffordable triangle count.
- **`?fps=` URL override added** beyond the plan, to compare cadences on desktop.
- **The Blockbench camera is merged at load time.** Its 15 exported mesh nodes
  share one material; preserving them individually doubled their draw cost in the
  shadow pass. Phase 9 bakes their transforms into one body mesh and keeps the
  static screen as the only second draw.

## Phase 10: Mid-Scale Ecology

- **No new draw calls for mid-scale vegetation.** The mid-scale ecology (40m Richness, 20m Overgrowth, 15m Floral) is entirely computed via `fbm` inside the existing grass vertex/fragment shaders and CPU scatter logic. This preserves performance while completely changing the visual structure.
- **Ecology is multiplicative, not deterministic.** We deliberately use three overlapping procedural noise fields instead of one biome map. This ensures flowers don't spawn in obvious circular blobs, and tall grass doesn't *always* mean green grass. The multiplicative intersection of fields (`Richness * (1 - Overgrowth) * Floral`) provides genuinely organic variance.
- **Distant Tapestry.** The `Terrain.ts` vertex shader fakes the continuation of the grass beyond 120m by painting the same procedural floral and richness noise directly onto the ground plane.

## Phase 11: Photography Mode

### The model merge splits again, and the Phase 9 shadow-pass rationale no longer applies

Phase 9 flattened all 15 of `camera.gltf`'s mesh nodes into one `VintageCameraBody`
because preserving them individually doubled their draw cost in the shadow pass (see
"Deviations from the original plan" above). Photography Mode needs the shutter cap to
physically depress on its own, which needs its own mesh, so `mergeModel()` now produces
two — `VintageCameraBody` and `ShutterButton` — plus an invisible `ShutterHitVolume` for
picking. The extra cost is one draw call, not fifteen. More to the point,
`prepareMaterials()` sets `castShadow = false` on every mesh of the camera
unconditionally: it floats near eye level, so a shadow pass would cost as much as
drawing it again and would produce an implausible moving shadow on the field. The
shadow-pass cost the Phase 9 flatten was solving for does not exist for this model at
all, so splitting the button back out is free.

### The viewfinder is a real second render pass, not a crop of the main frame

Four separate reasons converge on the same answer:

1. The lens sits at a different pose than the player's eye — offset, lagging and
   banking as `CameraPose` settles it. A crop of the main frame shows what the player's
   eye is pointed at, not what the lens is; there is no crop that recovers a pose the
   main camera never rendered.
2. Focal length is a real optical change of fov (`2·atan(12/f)`), decoupled from the
   player's own. A crop of a fixed-fov frame cannot zoom past what that frame already
   captured, and widening the main camera's fov to serve the crop would leak into the
   player's own view.
3. Exposure compensation grades **only** the viewfinder image, never the player's —
   possible only because it has its own render target to grade in isolation.
4. The camera model must not appear inside its own screen. `CAMERA_LAYER` gives this
   for free: the main camera renders layers 0+1, the viewfinder camera renders layer 0
   only. A crop of the main frame necessarily includes the camera model and would need
   extra masking to hide it.

### Gesture classification is latched, not blended

A continuous blend — routing some fraction of the mouse delta to the reticle and the
rest to look, weighted by speed — would mean the same physical gesture changes meaning
mid-stroke as incidental speed varies, which reads as broken tracking, not assistance.
Classification instead happens once, from the peak speed of a gesture's first two
samples (a two-sample window, so an accelerating flick cannot be mistaken for a slow
drag), and holds for the gesture's whole duration. Safety comes from the reticle's
clamp, not from reclassifying: the reticle crosses its whole domain in ~260 px of
travel, so a gesture misclassified as `RETICLE` reaches the boundary within a frame or
two, and the clamp's rejected component spills into look on its own. A slip
self-corrects without the classifier ever changing its mind.

### The watchdog reads medians, never a mean

Wall-clock `dt` cannot reveal the viewfinder's true cost under a frame cap — it measures
the rAF interval, not the work — so the watchdog instead reads `Engine.presentedFrames`,
accumulated into 0.5 s buckets. Every degrade/recover decision reads the median of a
window of those buckets (4 for degrade, 16 for recover), never the mean. A single
stalled bucket — a grass tile rebuild, a GC pause, a texture upload — can drag a mean
past a threshold; it cannot move a median. That is the whole point: the ladder must
react to the machine's sustained rate, not to one bad frame.

### A latch costs a recovery, but never the last one

Failing the same rung twice writes it off for the session, and also spends one of the
device's lifetime recoveries: a machine that has cratered twice has shown a pattern
rather than hit a blip, so it earns less benefit of the doubt on the rungs above it too.
Less, though — not none. `maxRecoveries` must therefore stay strictly above what a single
latch costs, or the two penalties collapse into one: a device that degraded, recovered
and degraded again would be left unable to climb back even to its own floor, which is a
harsher rule than either mechanism was meant to express. It sits at 3 against a latch
cost of 1.

### The focus ray starts at the lens, not at the model origin

`Viewfinder` places its camera at `FLOATING_CAMERA.lensLocal`; `CameraInteraction` marches
the focus ray from the same offset. This is not precision for its own sake — the offset is
about 13 cm on a march that steps 1.5 m. It matters because the error lies **along** the
ray rather than across it, so it does not blur the reading, it biases it: every distance
comes back short by the full offset, which moved a 15.7 m measurement by 0.6 m in test.
The number on the screen has to describe the image the screen is showing, and the two must
agree about where the lens is. That is why the offset lives in `Settings` and not in
either module.

## Still unresolved

See `STATUS.md`. Real iPhone 15 Safari validation is the top open item, alongside
Photography Mode's own browser verification pass and its touch bindings.
