# Status

Last updated at the end of Phase 6. Read this first, then `DECISIONS.md` before
changing anything visual.

## Current phase

**Phase 6 (post-processing and frame cadence) is complete.** Phases 5, 7, 8 and 9
have not been started. The build order was deliberately changed from the original
plan — post-processing was pulled ahead of props so the palette would only need
tuning once, against final grading.

Verified at the end of this phase:

- `npx tsc --noEmit` — clean
- `npx vite build` — clean (570 kB, almost all of it three.js; the chunk-size
  warning is expected and not worth splitting)
- No console errors or shader-compile failures
- Desktop `high` tier: **168 fps, 49 draw calls, 610k triangles** at 1280×720
- Walked ~40 steps with no hitch and no holes, confirming grass tile recycling

## Completed systems

| System | File | Notes |
|---|---|---|
| Engine loop | `src/core/Engine.ts` | rAF loop, dt clamp, resize, blur-pause, frame-cap accumulator, `presentedFrames` counter |
| Quality tiers | `src/core/Quality.ts` | `high`/`medium`/`low` from touch + core count; `?quality=` and `?fps=` overrides |
| Art constants | `src/core/Settings.ts` | **Every** tunable value. Change the look here, not in modules |
| Render pipeline seam | `src/core/RenderPipeline.ts` | `DirectRenderPipeline` (dev fallback) and `PostFX` both implement it |
| Height field | `src/world/HeightField.ts` | `heightAt()` is the single source of truth for ground |
| Terrain | `src/world/Terrain.ts` | One displaced plane, vertex-coloured, smooth-shaded |
| Sky | `src/world/Sky.ts` | Gradient dome, azimuthal warm/cool variation, procedural clouds, stylized sun |
| Water | `src/world/Water.ts` | Shoreline traced against the height field; fresnel sky mirror + speck glitter |
| Backdrop | `src/world/Backdrop.ts` | Four receding ridge rings with increasing angular height |
| Lighting | `src/lighting/Lighting.ts` | Warm sun + cool hemisphere fill, texel-snapped shadow rig following the view |
| Player | `src/player/Player.ts` | Eased accel/decel, terrain follow, head bob, soft radial boundary, shoreline stop |
| Look | `src/player/FirstPersonCamera.ts` | Damped yaw/pitch; exposes `yawRate`/`pitchRate` for Phase 7 |
| Desktop input | `src/player/input/DesktopInput.ts` | Pointer lock + WASD + Shift |
| Wind | `src/grass/wind.ts` | One shared uniform set; `WIND_GLSL` is the single sway function |
| Grass | `src/grass/GrassField.ts` | Three player-following bands, two materials, deterministic tiles |
| Post-processing | `src/render/PostFX.ts` | HDR target + depth, bloom chain, composite with camera motion blur |
| Boot UI | `src/ui/Boot.ts` | The only UI in the project. One line of type |
| Dev overlay | `src/dev/DevStats.ts` | DEV-only, dynamically imported so it never ships |

## Known issues

### 1. Frame cap does not land on its target — OPEN, highest priority

`?fps=30` produced readings of **40 fps and later 58 fps**, never ~30. Two
implementations were tried (wall-clock comparison with an epsilon, then the
current carry-over accumulator in `Engine.tick`) and neither hit the target.
The arithmetic says the accumulator should yield ~29 fps at any refresh rate, so
something is wrong that reading the code did not reveal.

This is **implemented but unverified**. Do not claim it works.

Complicating factors while debugging: the in-app browser pane's own rAF timing is
unstable, and the DevStats overlay intermittently renders blank after a reload.
`?fps=30` is also lost when navigating, because the harness strips query strings —
type the URL manually.

Next step: DevStats already prints `budget <ms>` (from `Engine.frameBudget`) and
`raf <Hz>` for exactly this. Read those two numbers first. If `budget` is not
33.3 ms then `quality.frameCap` is not reaching `minFrameTime`; if `raf` is far
from the presented fps then the measurement, not the cap, is wrong.

### 2. Visual gaps

- **Mid-ground is thin.** A visible band of near-bare terrain sits between the
  near blade band (fades 16→20 m) and the lake. The cluster bands cover it but
  read as sparse tufts rather than continuous field.
- **Terrain is one flat wash.** It is backlit, so it has almost no shading
  variation of its own and the vertex-colour break-up barely reads. Deliberately
  left alone: props and flowers will cover most of it. Do not sink time here
  before Phase 5.
- **Overall image is soft and low-contrast.** Partly intended (haze, vignette,
  grain), but it is close to the edge of muddy. Worth a contrast pass with fresh
  eyes.
- **Lake reads silver rather than golden.** Correct behaviour — it mirrors the sky
  along the sun azimuth and the sun is bright enough to desaturate — but it may
  want more warmth.
- **No objects at all.** No trees, rocks, fences or flowers yet (Phase 5), and no
  floating camera (Phase 7). The scene is landscape only, which is why it reads
  emptier than the reference image.

### 3. Not verified

- **Anything on real hardware.** No iPhone 15 test has happened. Chrome is not
  installed on this machine, so the in-app pane was the only browser available.
- **The `medium` and `low` tiers** have never been run. Only `high` has.
- **MSAA + depth texture together.** `PostFX` requests `samples: 4` on `high`
  alongside a `DepthTexture`. It renders without error and motion blur appears to
  work, but depth-resolve correctness under MSAA was not specifically tested. If
  motion blur looks wrong on another machine, set `msaaSamples: 0` in
  `Quality.ts` first.

## Exact next task

**Phase 5 — props.** In this order:

1. `src/world/Scatter.ts` — deterministic placement from `hash3`/`createRng`,
   rejecting steep slopes, submerged ground, and a radius around the player start.
2. `src/props/TreeFactory.ts` — the hero tree first, on the rise the height field
   already provides at **(-42, 30)** (`TERRAIN.heroRise`). Low-poly, flat-shaded,
   canopy blobs from `IcosahedronGeometry(r, 0)`. Share `WIND_GLSL` so canopies
   move with the field.
3. `RockFactory`, `FenceFactory` (a run along the right-hand ridge, merged with
   `mergeGeometries` into one draw call), `FlowerFactory` (instanced, per-instance
   colour, wind-shared, dense in the foreground).
4. `src/props/PropLayer.ts` — keep the total added draw calls in single digits.

Then re-check the terrain wash and the mid-ground thinness, which props may fix
for free.

Phase 7 (floating camera) is the other high-value piece and is independent of
props. `FirstPersonCamera.yawRate`/`pitchRate` already exist for its banking.
