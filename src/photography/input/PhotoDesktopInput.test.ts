import { describe, expect, it, vi } from 'vitest';
import { createInputState } from '../../player/input/InputState';
import type { CameraInteraction } from '../CameraInteraction';
import type { PhotographyMode } from '../PhotographyMode';
import { PhotoDesktopInput } from './PhotoDesktopInput';

function harness() {
  const listeners = new Map<string, EventListener>();
  const canvas = {
    addEventListener: vi.fn((type: string, listener: EventListener) => {
      listeners.set(type, listener);
    }),
    removeEventListener: vi.fn(),
  } as unknown as HTMLCanvasElement;
  const pose = { isRaised: false };
  const photography = {
    pose,
    state: { selected: 'focal' },
    togglePhotographyMode: vi.fn(() => {
      pose.isRaised = !pose.isRaised;
    }),
    changeSetting: vi.fn(),
    shutter: vi.fn(),
  } as unknown as PhotographyMode;
  const interaction = {
    hovered: null,
    lookSpill: { x: 0, y: 0 },
    press: vi.fn(),
    release: vi.fn(),
    pointerDelta: vi.fn(),
    wheel: vi.fn(),
  } as unknown as CameraInteraction;
  const input = createInputState();

  vi.stubGlobal('window', {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });

  const desktop = new PhotoDesktopInput(canvas, photography, interaction, input);
  desktop.init();

  return {
    photography,
    dispatch(type: string, event: Partial<MouseEvent> = {}): void {
      const listener = listeners.get(type);
      if (!listener) throw new Error(`Missing listener for ${type}`);
      listener({ preventDefault: vi.fn(), button: 2, ...event } as MouseEvent);
    },
  };
}

describe('PhotoDesktopInput right-click toggle', () => {
  it('toggles on the button press even when contextmenu is suppressed', () => {
    const test = harness();

    test.dispatch('mousedown', { button: 2 });
    test.dispatch('contextmenu', { button: 2 });

    expect(test.photography.togglePhotographyMode).toHaveBeenCalledOnce();
  });
});
