/**
 * The entire UI: one warm overlay with a single line of type. Tapping it hands
 * control to the world and never shows anything again unless pointer lock is
 * lost, in which case it fades back in.
 */
export class Boot {
  private readonly root: HTMLElement;

  constructor(
    isTouch: boolean,
    private readonly onBegin: () => void,
  ) {
    const root = document.getElementById('boot');
    const line = document.getElementById('boot-line');
    if (!root || !line) {
      throw new Error('index.html is missing the #boot overlay');
    }

    this.root = root;
    line.textContent = isTouch ? 'touch to begin' : 'click to begin';
    root.addEventListener('pointerdown', this.onPointerDown);
  }

  /** Fade back in, e.g. after pointer lock is released. */
  show(): void {
    this.root.classList.remove('is-gone');
  }

  hide(): void {
    this.root.classList.add('is-gone');
  }

  dispose(): void {
    this.root.removeEventListener('pointerdown', this.onPointerDown);
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    event.preventDefault();
    this.hide();
    this.onBegin();
  };
}
