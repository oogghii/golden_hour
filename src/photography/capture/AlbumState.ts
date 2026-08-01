import { clamp } from '../../util/math';

/**
 * Where the player is in the roll.
 *
 * Pure, because the two rules worth having are both invisible from a
 * screenshot: the ends do not wrap, and a photograph taken while the album is
 * open must not shuffle the one being looked at.
 */
export class AlbumState {
  private ids: readonly number[] = [];
  private cursor = 0;
  private opened = false;

  get isOpen(): boolean {
    return this.opened;
  }

  get index(): number {
    return this.cursor;
  }

  get count(): number {
    return this.ids.length;
  }

  get currentId(): number | null {
    return this.opened ? (this.ids[this.cursor] ?? null) : null;
  }

  /**
   * Identity is by id, not by position: a new photograph appended while the
   * album is open must not slide the one being looked at out from under it.
   */
  setIds(ids: readonly number[]): void {
    const showing = this.ids[this.cursor];
    this.ids = [...ids];
    if (this.ids.length === 0) {
      this.cursor = 0;
      this.opened = false;
      return;
    }
    const found = showing === undefined ? -1 : this.ids.indexOf(showing);
    this.cursor = found >= 0 ? found : clamp(this.cursor, 0, this.ids.length - 1);
  }

  /** Opens on the newest, which is the photograph the player just took. */
  open(): void {
    if (this.ids.length === 0) return;
    this.opened = true;
    this.cursor = this.ids.length - 1;
  }

  close(): void {
    this.opened = false;
  }

  /** Returns true only if the cursor actually moved. */
  flip(delta: number): boolean {
    if (!this.opened || this.ids.length === 0) return false;
    const next = clamp(this.cursor + Math.trunc(delta), 0, this.ids.length - 1);
    if (next === this.cursor) return false;
    this.cursor = next;
    return true;
  }
}
