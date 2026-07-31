import { FloatingCamera } from './camera/FloatingCamera';
import { StaticCameraScreen } from './camera/StaticCameraScreen';
import { Engine } from './core/Engine';
import { GrassField } from './grass/GrassField';
import { WindField } from './grass/wind';
import { Lighting } from './lighting/Lighting';
import { FirstPersonCamera } from './player/FirstPersonCamera';
import { DesktopInput } from './player/input/DesktopInput';
import { createInputState } from './player/input/InputState';
import { TouchInput } from './player/input/TouchInput';
import { Player } from './player/Player';
import { PropLayer } from './props/PropLayer';
import { PostFX } from './render/PostFX';
import { Boot } from './ui/Boot';
import { Backdrop } from './world/Backdrop';
import { HeightField } from './world/HeightField';
import { Pollen } from './world/Pollen';
import { Sky } from './world/Sky';
import { Terrain } from './world/Terrain';
import { Water } from './world/Water';

const canvas = document.querySelector<HTMLCanvasElement>('#view');
if (!canvas) throw new Error('index.html is missing the #view canvas');

const engine = new Engine(canvas);

// Takes over presentation from DirectRenderPipeline, and with it ownership of
// tonemapping and colour space. Must be set before start(), which sizes it.
engine.pipeline = new PostFX(engine.renderer, engine.quality);

// Shared by terrain, water, grass placement, prop scatter and the player, so
// nothing can disagree about where the ground is.
const heightField = new HeightField();
// One wind, shared by grass, flowers and tree canopies, so the whole world
// breathes together.
const wind = new WindField();
const input = createInputState();
const look = new FirstPersonCamera(input);
const player = new Player(heightField, look, input);
const desktopInput = new DesktopInput(input, canvas);
const touchInput = new TouchInput(input, canvas);

engine.add(new Sky());
engine.add(new Backdrop());
engine.add(new Terrain(heightField));
engine.add(new Water(heightField));

// Order matters from here: input gathers, the look system consumes it, the
// player moves along the resulting heading, and lighting reframes its shadow
// box around wherever the player ended up.
engine.add(engine.quality.isTouch ? touchInput : desktopInput);
engine.add(look);
engine.add(player);
engine.add(new FloatingCamera(player, look, new StaticCameraScreen()));
engine.add(new GrassField(heightField, player, wind));
engine.add(new PropLayer(heightField, wind));
engine.add(new Pollen(player, wind));
engine.add(new Lighting());

// The wind clock has to advance before anything samples it next frame.
engine.add({ update: (_dt, elapsed) => wind.update(elapsed) });

if (import.meta.env.DEV) {
  const { DevStats } = await import('./dev/DevStats');
  engine.add(new DevStats(engine));
}

const boot = new Boot(engine.quality.isTouch, () => {
  if (!engine.quality.isTouch) desktopInput.requestLock();
});

// Releasing the pointer hands control back to the overlay rather than leaving
// the player stranded with a dead mouse.
document.addEventListener('pointerlockchange', () => {
  if (!desktopInput.isLocked) boot.show();
});

await engine.start();
