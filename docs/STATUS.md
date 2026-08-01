# Status

Last updated at the end of Phase 11. Read this first, then `DECISIONS.md` before
changing anything visual.

## Current phase

**Phases 1–11 are implemented.** Phase 7 added the floating camera, Phase 8 added
invisible touch controls, Phase 9 merged and tuned the camera asset, Phase 10 added
ecological mid-scale structures and traversal speed tuning, and Phase 11 turned the
camera into a working interface — raise/lower, the live viewfinder with its adaptive
quality ladder, the rear-screen chrome and reticle, exposure/focal controls and a real
focus distance marched against the height field.

Three things keep Phase 11 from being the finished feature, not just the working one:
photo capture is still a stub (`shutter()` decrements the shot counter and calls an
`onCapture` hook that nothing assigns; nothing is stored or displayed), touch bindings
for Photography Mode are not written (`CameraActions` and the raycast path exist for
them; nothing calls them from `TouchInput`), and the interface itself — reticle,
hover/press/activate, the focus frame, the settings dials — has not been verified
end-to-end in a real browser. Real-device validation for exploration and touch is
separately still required before calling the mobile milestone shipped.

Verified at the end of this phase:

- `npx tsc --noEmit` — clean
- `npx vite build` — clean (730 kB including three.js, GLTFLoader and the embedded
  Blockbench camera; the chunk-size
  warning is expected and not worth splitting)
- No application console errors or shader-compile failures in the in-app browser
- Desktop `high`, at rest: **170 fps, 81 calls, 987k triangles**
- Desktop `high`, raised: **170 fps, 100 calls, 1795k triangles** — the viewfinder pass
  on top of the rest-state draw
- `?quality=medium&fps=30`, raised: holds **30 fps**, settling the adaptive ladder at
  **rung 1**
- Forced `medium` at 30 fps: **30 fps, 49 calls, 438k triangles**
- Forced `low` at 30 fps: **30 fps, 28 calls, 172k triangles**
- `?fps=30`: **30 fps, 33.3 ms budget** against a ~170 Hz rAF source

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
| Prop scatter | `src/world/Scatter.ts` | Deterministic rejection scatter for slope, water and protected clearings |
| Props | `src/props/PropLayer.ts` | Merged trees, rocks and fence plus one instanced flower draw; shared wind |
| Floating camera | `src/camera/FloatingCamera.ts` | Merged Blockbench model with world-space inertia and look-rate banking |
| Camera screen | `src/camera/StaticCameraScreen.ts` | Static emissive first-milestone implementation of `CameraScreen` |
| Touch input | `src/player/input/TouchInput.ts` | Drag to look, hold to walk, second finger for faster stroll; no visible controls |
| Boot UI | `src/ui/Boot.ts` | The only UI in the project. One line of type |
| Dev overlay | `src/dev/DevStats.ts` | DEV-only, dynamically imported so it never ships |

## Known issues

### 1. Real mobile hardware — OPEN, highest priority

The cap is now verified in the in-app browser: `?fps=30` reports **30 fps** with a
**33.3 ms** budget against a ~170 Hz rAF source. The earlier 40/58 readings were
caused by test/query state, not the accumulator. Touch controls and the automatic
medium tier still need an iPhone 15 Safari pass for cadence, thermals, pointer
semantics, MSAA depth resolve and safe-area behaviour.

### 2. Visual gaps

- **Overall image is soft and low-contrast.** Partly intended (haze, vignette,
  grain), but it is close to the edge of muddy. Worth a contrast pass with fresh
  eyes.
- **Lake reads silver rather than golden.** Correct behaviour — it mirrors the sky
  along the sun azimuth and the sun is bright enough to desaturate — but it may
  want more warmth.
- **The default sunward view remains intentionally open.** Phase 5 props now
  populate the walkable field, but the hero tree and fence sit off the initial
  centre line so the lake and low sun keep their clear corridor.
- **Low tier is visibly sparse beyond its second grass band.** This is now
  verified rather than theoretical. Do not retune the protected grass coverage
  without owner approval; the iPhone 15 target selects medium, not low.

### 3. Not verified

- **Anything on real hardware.** No iPhone 15 test has happened. The in-app pane
  remains the only browser used for this milestone.
- **Touch gestures.** Implemented, but the desktop browser does not expose a real
  multi-touch surface for validating capture and cancellation semantics.
- **MSAA + depth texture together.** `PostFX` requests `samples: 4` on `high`
  alongside a `DepthTexture`. It renders without error and motion blur appears to
  work, but depth-resolve correctness under MSAA was not specifically tested. If
  motion blur looks wrong on another machine, set `msaaSamples: 0` in
  `Quality.ts` first.
- **Photography Mode's interface, end-to-end in a browser.** Raise/lower, the reticle
  and its magnetism, hover/press/activate on every zone, the shutter cap's physical
  depression, focus-and-confirm against real terrain, and a 20-cycle raise/lower memory
  check (`info.memory` should be stable) have not yet been run in the in-app pane.

### 4. Photography Mode gaps — deferred by design, not oversights

- **Photo capture is a stub.** `shutter()` decrements the shot counter and calls
  `onCapture`, which nothing assigns. No image is stored or displayed.
- **No touch bindings.** `CameraActions` and the raycast path both exist for touch;
  `TouchInput` does not call either. Photography Mode is desktop-only until this lands.
- **Depth of field, histogram, live focus/metering zones and viewfinder bloom** are
  deferred by `docs/superpowers/specs/2026-08-01-photography-mode-design.md` §13.

## Exact next task

**Browser verification of Photography Mode, then its touch bindings.** Run the checklist
above — `DevStats` at rest and raised on `high`, `?quality=medium&fps=30` raised and
held, `?vf=0`/`?vf=3`, and the 20-cycle memory check — none of which has run in the
browser yet. After that, touch bindings: wire `CameraActions` and the existing raycast
path into `TouchInput` so the camera is not desktop-only. The pre-existing **real-device
acceptance pass on iPhone 15 Safari** (touch look, hold-to-walk, second-finger stroll,
stable 30 fps, MSAA depth resolve, thermal behaviour, floating-camera framing in the
mobile fov) remains open behind both.
