import { describe, expect, it } from 'vitest';
import { AlbumState } from './AlbumState';

function album(count: number): AlbumState {
  const state = new AlbumState();
  state.setIds(Array.from({ length: count }, (_unused, i) => i + 1));
  return state;
}

describe('the album cursor', () => {
  it('starts closed and showing nothing', () => {
    const state = new AlbumState();
    expect(state.isOpen).toBe(false);
    expect(state.currentId).toBe(null);
  });

  it('opens on the newest photograph, which is the one just taken', () => {
    const state = album(4);
    state.open();
    expect(state.isOpen).toBe(true);
    expect(state.currentId).toBe(4);
  });

  it('flips back and forward through the roll', () => {
    const state = album(4);
    state.open();
    expect(state.flip(-1)).toBe(true);
    expect(state.currentId).toBe(3);
    expect(state.flip(1)).toBe(true);
    expect(state.currentId).toBe(4);
  });

  it('stops at both ends rather than wrapping', () => {
    // Being thrown from the first photograph to the last is disorienting in a
    // container that has a real beginning.
    const state = album(3);
    state.open();
    expect(state.flip(1)).toBe(false);
    expect(state.currentId).toBe(3);
    state.flip(-1);
    state.flip(-1);
    expect(state.currentId).toBe(1);
    expect(state.flip(-1)).toBe(false);
    expect(state.currentId).toBe(1);
  });

  it('refuses to open an empty roll', () => {
    const state = new AlbumState();
    state.open();
    expect(state.isOpen).toBe(false);
  });

  it('holds its place when the roll grows underneath it', () => {
    // A photograph taken while the album is open must not slide the one being
    // looked at out from under the player.
    const state = album(3);
    state.open();
    state.flip(-1);
    const showing = state.currentId;
    state.setIds([1, 2, 3, 4, 5]);
    expect(state.currentId).toBe(showing);
  });

  it('closes when the roll it was showing disappears', () => {
    const state = album(2);
    state.open();
    state.setIds([]);
    expect(state.isOpen).toBe(false);
    expect(state.currentId).toBe(null);
  });

  it('does nothing when flipped while closed', () => {
    const state = album(3);
    expect(state.flip(1)).toBe(false);
    expect(state.currentId).toBe(null);
  });
});
