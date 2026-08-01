import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CameraInteraction, HoverTarget } from '../../photography/CameraInteraction';
import type { PhotographyMode } from '../../photography/PhotographyMode';
import { SCREEN_ZONES } from '../../photography/InteractionZones';
import { createInputState } from './InputState';
import { TouchInput } from './TouchInput';

type Listener = (event: PointerEvent) => void;

function createHarness(initialTarget: HoverTarget, raised: boolean) {
  const listeners = new Map<string, Listener>();
  const pose = { isRaised: raised };
  const actions = {
    enterPhotographyMode: vi.fn(() => { pose.isRaised = true; }),
    exitPhotographyMode: vi.fn(() => { pose.isRaised = false; }),
    shutter: vi.fn(),
    focus: vi.fn(),
    zoom: vi.fn(),
    selectSetting: vi.fn(),
    changeSetting: vi.fn(),
  };
  const interaction = {
    touchPress: vi.fn(() => initialTarget),
    touchMove: vi.fn(),
    touchRelease: vi.fn(),
    cancelPress: vi.fn(),
  };
  const canvas = {
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
      if (typeof listener === 'function') listeners.set(type, listener as Listener);
    },
    removeEventListener: vi.fn(),
    setPointerCapture: vi.fn(),
    hasPointerCapture: vi.fn(() => false),
    releasePointerCapture: vi.fn(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
  } as unknown as HTMLCanvasElement;
  const input = createInputState();
  const touch = new TouchInput(
    input,
    canvas,
    { pose, ...actions } as unknown as PhotographyMode,
    interaction as unknown as CameraInteraction,
  );

  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  touch.init();

  const dispatch = (type: string, pointerId: number, x: number, y: number): void => {
    listeners.get(type)?.({
      pointerId,
      pointerType: 'touch',
      clientX: x,
      clientY: y,
      preventDefault: vi.fn(),
    } as unknown as PointerEvent);
  };

  return { actions, dispatch, input, interaction, touch };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TouchInput Photography Mode bindings', () => {
  it('enters when a lowered camera body is tapped', () => {
    const harness = createHarness('body', false);

    harness.dispatch('pointerdown', 1, 80, 80);
    harness.dispatch('pointerup', 1, 80, 80);

    expect(harness.actions.enterPhotographyMode).toHaveBeenCalledOnce();
  });

  it('exits when the raised camera body is tapped', () => {
    const harness = createHarness('body', true);

    harness.dispatch('pointerdown', 1, 80, 80);
    harness.dispatch('pointerup', 1, 80, 80);

    expect(harness.actions.exitPhotographyMode).toHaveBeenCalledOnce();
    expect(harness.interaction.touchRelease).toHaveBeenCalledOnce();
  });

  it('routes an adjustable-zone drag to setting selection and change', () => {
    const focal = SCREEN_ZONES.find((zone) => zone.id === 'focal')!;
    const harness = createHarness(focal, true);

    harness.dispatch('pointerdown', 1, 20, 80);
    harness.dispatch('pointermove', 1, 50, 80);
    harness.dispatch('pointerup', 1, 50, 80);

    expect(harness.actions.selectSetting).toHaveBeenCalledWith('focal');
    expect(harness.actions.changeSetting).toHaveBeenCalledWith(1);
    expect(harness.interaction.touchRelease).toHaveBeenCalledOnce();
  });

  it('routes a pinch to logarithmic zoom', () => {
    const harness = createHarness(null, true);

    harness.dispatch('pointerdown', 1, 40, 50);
    harness.dispatch('pointerdown', 2, 60, 50);
    harness.dispatch('pointermove', 2, 80, 50);

    expect(harness.actions.zoom).toHaveBeenCalledOnce();
    expect(harness.actions.zoom.mock.calls[0]![0]).toBeGreaterThan(0);
    expect(harness.interaction.cancelPress).toHaveBeenCalled();
  });
});
