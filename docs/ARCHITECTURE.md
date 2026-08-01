# Architecture

## The shape of it

A tiny `Engine` owns the renderer, the scene, the clock and an ordered list of
`System`s. Everything else is a system.

```
main.ts            wires everything, owns registration order
core/
  Engine.ts        rAF loop, dt clamp, frame cap, resize fan-out, blur-pause
  System.ts        the one interface + EngineContext
  RenderPipeline.ts  presentation seam (DirectRenderPipeline | PostFX)
  Quality.ts       device tier -> QualitySettings
  Settings.ts      every art-direction constant in the project
world/             HeightField, Terrain, Sky, Water, Backdrop, Pollen, Scatter
grass/             wind, BladeGeometry, grassTexture, GrassMaterials, GrassField
props/             factories + one merged/instanced PropLayer
camera/            FloatingCamera + swappable CameraScreen implementation
photography/       PhotographyMode, CameraInteraction, and the exposure/gesture/zone
                    models Photography Mode reads
player/            Player, FirstPersonCamera, input/
lighting/          Lighting
render/            PostFX + shaders/
ui/                Boot
dev/               DevStats (DEV only)
util/              math, rng
```

## Adding a system

```ts
export class Thing implements System {
  init?(ctx: EngineContext): void | Promise<void>;
  update?(dt: number, elapsed: number): void;
  resize?(width: number, height: number): void;
  dispose?(): void;
}
```

Register it in `main.ts` before `engine.start()`. `EngineContext` gives you
`{ renderer, scene, camera, quality }` and nothing else — this is deliberate.
Anything else a system needs (the height field, the player, the wind) is passed to
its **constructor**, so dependencies are visible at the wiring site instead of
hidden behind a growing god object.

### Registration order matters

```
Sky, Backdrop, Terrain, Water     world geometry
DesktopInput                      gathers raw input
PhotographyMode                   gates that input in place, before look consumes it —
                                   how movement and look scale down while raised without
                                   touching Player.ts or FirstPersonCamera.ts
FirstPersonCamera                 consumes look delta, writes camera orientation
Player                            moves along that heading, writes camera position
FloatingCamera                    follows the new view pose with world-space lag
Viewfinder                        renders through the floating camera's pose, so it must
                                   come after FloatingCamera has resolved this frame's lag
GrassField                        follows the player's new position
PropLayer                         static composition; shares height + wind
Lighting                          reframes its shadow box around the camera
wind updater                      advances the shared wind clock
DevStats                          reads the frame's stats last
```

Input → look → player → dependents → lighting. Reordering these will produce a
one-frame lag somewhere, most visibly in grass tile placement.

## The four things worth understanding

### 1. Grass is a data table, not code

`Settings.GRASS.bands[tier]` is an array of `GrassBand`. `GrassField` builds one
toroidal ring of instanced tiles per band. Retuning coverage means editing numbers.

Bands overlap and fade out by **shrinking instance height to zero**, never by going
transparent. The coarser band underneath is already drawn, so nothing ever pops in
or out and everything stays opaque and depth-correct.

**The invariant**, asserted in DEV by `assertBandsCoverTheirRings`:

```
fadeEnd <= tileSize * (ringTiles - 1) / 2
```

A taper that finishes outside the ground its ring covers leaves a bald ring around
the player. This was violated in the first draft in both directions.

Tile layout is a pure function of `hash3(tileX, tileZ, bandSeed)`, so recycling a
tile by walking away and back regenerates it identically. Rebuilds are budgeted to
2 tiles per frame across all bands.

### 2. There is exactly one wind

`grass/wind.ts` owns the uniforms; `WIND_GLSL` owns the sway function. Everything
that moves in the breeze imports both, shares the uniform objects **by reference**,
and therefore stays in phase. When you add tree canopies or flowers in Phase 5, use
these — do not write a second sway.

Note `grassUniforms()`: fog uniforms are *cloned* per material (three writes into
them), while wind uniforms are *spread by reference* (they must stay shared).

### 3. Colour management lives in one place

The renderer stays `NoToneMapping` and `LinearSRGBColorSpace` for the whole frame.
The scene renders into a linear half-float target. **All** tonemapping, grading and
sRGB encoding happen in `render/shaders/composite.glsl.ts` and nowhere else.

Two consequences to remember:

- Custom `ShaderMaterial`s do not get three's tonemapping or colour-space chunks
  injected. Under the old `DirectRenderPipeline` the terrain was tonemapped and the
  sky/water/grass were not. `PostFX` made it uniform, which changed every colour in
  the scene at once.
- Palette hex values are converted sRGB→linear by `THREE.Color`. A swatch that
  looks mid-grey is much darker in linear, which is why mixing a "pleasant slate"
  water colour against a warm reflection produced red mud.

### 4. The render pipeline is swappable

`Engine.pipeline` is a `RenderPipeline`. `DirectRenderPipeline` renders straight to
the canvas with three's own ACES, and exists so the world stays viewable if PostFX
is disabled or broken. `PostFX` replaces it in `main.ts` before `start()`.

`PostFX` sets `renderer.autoClear = false` and `renderer.info.autoReset = false`
because it issues several passes per frame. Consequently `renderer.info.render.frame`
is **not** a frame count — use `Engine.presentedFrames`.

## Where the next features plug in

| Feature | Where |
|---|---|
| Blockbench models | A loader system; add to `props/`. Keep flat shading and the low-poly silhouette |
| Photography | Implemented — see `docs/superpowers/specs/2026-08-01-photography-mode-design.md` for the full design. Touch bindings now route through `CameraActions` and `CameraInteraction`; depth of field, the histogram, photo storage, live focus/metering zones and viewfinder bloom remain deferred by that spec (§13) |
| Floating camera screen going live | Write `LiveCameraScreen` against the `CameraScreen` interface described in `DECISIONS.md`; one line changes in `main.ts` |
| Animals | Systems with their own instanced meshes; sample `HeightField.heightAt` to sit on the ground |
| Prop scatter | `src/world/Scatter.ts` | Extracted deterministic rejection scatter logic |
| Pollen | `src/world/Pollen.ts` | Simulation of rising particle field near player |
| Sky objects | `world/Sky.ts` renders at `renderOrder -1000` with `depthTest:false`; add objects as normal scene children, they will draw over it |
| Sound | A system; use `update(dt, elapsed)` and read `Player.speed` for footsteps |
| Progression | A system holding state; nothing else stores game state today |

## Conventions

- Never hardcode a look value in a module. It goes in `Settings.ts`.
- Systems clean up after themselves in `dispose()`.
- Debug UI is DEV-only and dynamically imported so it cannot reach production.
- `util/rng.ts` for anything that must be deterministic across recycles.
