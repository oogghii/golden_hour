import * as THREE from 'three';
import { PHOTOGRAPHY } from '../core/Settings';
import {
  EXPOSURES,
  formatAperture,
  formatExposure,
  formatFocal,
  formatFocusDistance,
  formatIso,
  formatShutter,
} from '../photography/ExposureModel';
import { SCREEN_ZONES } from '../photography/InteractionZones';
import type { AlbumCaption } from '../photography/capture/photoRecord';
import type { PhotoState } from '../photography/PhotoState';

const WIDTH = 1024;
const HEIGHT = 683;
const FONT = 'Helvetica Neue, Helvetica, Arial, sans-serif';

function hex(value: number, alpha = 1): string {
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * The typography layer. Redrawn only when something it draws has changed, which
 * is what keeps a 2.8MB texture upload off the per-frame budget.
 */
export class ScreenUI {
  readonly texture: THREE.CanvasTexture;

  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private drawnKey = '';

  constructor() {
    this.canvas.width = WIDTH;
    this.canvas.height = HEIGHT;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable for the camera screen');
    this.ctx = ctx;

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.texture.generateMipmaps = true;
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
  }

  /**
   * The caption arrives alongside the state rather than inside it: a stored
   * photograph's readings are not part of the camera's live state, and folding
   * them in would let the album's contents leak into what the viewfinder draws.
   */
  sync(state: PhotoState, caption: AlbumCaption | null = null): void {
    const key = caption ? `${state.revision}:${caption.index}/${caption.count}` : `${state.revision}`;
    if (key === this.drawnKey) return;
    this.drawnKey = key;
    this.draw(state, caption);
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.texture.dispose();
  }

  private draw(state: PhotoState, caption: AlbumCaption | null): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, WIDTH, HEIGHT);
    // A photograph under review is shown uninterrupted: no scrims, no type.
    if (state.screenMode === 'review') return;
    this.drawScrims();
    if (state.screenMode === 'album') {
      if (caption) this.drawAlbumBars(caption);
      return;
    }
    this.drawTopBar(state);
    this.drawBottomBar(state);
    this.drawFocusDistance(state);
  }

  /**
   * The caption a print gets on the back: which frame it is, when it was taken,
   * and what it was taken at. Read from the stored record, so it says what the
   * camera was showing at the shutter rather than what it happens to read now.
   */
  private drawAlbumBars(caption: AlbumCaption): void {
    const ctx = this.ctx;
    const { primary, secondary } = PHOTOGRAPHY.screenUI;

    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillStyle = hex(primary);
    ctx.font = `600 26px ${FONT}`;
    ctx.fillText(`${caption.index} / ${caption.count}`, 32, 49);

    ctx.textAlign = 'right';
    ctx.fillStyle = hex(secondary);
    ctx.font = `19px ${FONT}`;
    ctx.fillText(new Date(caption.takenAt).toLocaleString(), WIDTH - 32, 49);

    const baseline = HEIGHT - 39;
    ctx.textAlign = 'left';
    ctx.fillStyle = hex(primary);
    ctx.font = `26px ${FONT}`;
    ctx.fillText(
      `${caption.focalMm}mm    ${caption.aperture}    ${caption.shutterSpeed}    ${caption.iso}`,
      32,
      baseline,
    );

    ctx.textAlign = 'right';
    ctx.fillStyle = hex(secondary);
    ctx.fillText(caption.focusDistance, WIDTH - 32, baseline);
  }

  /**
   * The centre readout, sitting just above the settings bar. The corner-ticked
   * focus frame itself is drawn in the shader, next to the live feed; this is
   * its typographic companion, coloured the same way — secondary while
   * searching, `confirm` once the ray has landed.
   */
  private drawFocusDistance(state: PhotoState): void {
    const ctx = this.ctx;
    const { secondary, confirm } = PHOTOGRAPHY.screenUI;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.font = `20px ${FONT}`;
    ctx.fillStyle = hex(state.focusConfirmed ? confirm : secondary);
    ctx.fillText(formatFocusDistance(state), WIDTH / 2, HEIGHT * 0.833 - 14);
  }

  /** Real cameras scrim behind their overlays so type survives a bright sky. */
  private drawScrims(): void {
    const ctx = this.ctx;
    const top = ctx.createLinearGradient(0, 0, 0, HEIGHT * 0.13);
    top.addColorStop(0, 'rgba(0,0,0,0.42)');
    top.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = top;
    ctx.fillRect(0, 0, WIDTH, HEIGHT * 0.13);

    const bottom = ctx.createLinearGradient(0, HEIGHT, 0, HEIGHT * 0.82);
    bottom.addColorStop(0, 'rgba(0,0,0,0.5)');
    bottom.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = bottom;
    ctx.fillRect(0, HEIGHT * 0.82, WIDTH, HEIGHT * 0.18);
  }

  private drawTopBar(state: PhotoState): void {
    const ctx = this.ctx;
    const { primary, secondary } = PHOTOGRAPHY.screenUI;

    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillStyle = hex(primary);
    ctx.font = `600 31px ${FONT}`;
    ctx.fillText(state.mode, 32, 50);

    ctx.fillStyle = hex(secondary);
    ctx.font = `18px ${FONT}`;
    ctx.fillText('AF·S', 64, 49);
    ctx.fillText('MULTI', 150, 49);

    this.drawBattery(state.battery);

    // A camera reports card trouble where it reports frames remaining.
    ctx.textAlign = 'right';
    ctx.fillStyle = hex(primary);
    ctx.font = `22px ${FONT}`;
    ctx.fillText(state.cardStatus ?? String(state.remainingShots), WIDTH - 32, 49);
  }

  private drawBattery(level: number): void {
    const ctx = this.ctx;
    const x = WIDTH - 200;
    const y = 28;
    const w = 52;
    const h = 23;
    ctx.strokeStyle = hex(PHOTOGRAPHY.screenUI.secondary);
    ctx.lineWidth = 1.6;
    ctx.strokeRect(x, y, w, h);
    ctx.fillStyle = hex(PHOTOGRAPHY.screenUI.secondary);
    ctx.fillRect(x + w + 1, y + 7, 4, 9);
    ctx.fillStyle = hex(PHOTOGRAPHY.screenUI.primary, 0.85);
    ctx.fillRect(x + 4, y + 4, (w - 8) * Math.max(0, Math.min(1, level)), h - 8);
  }

  private drawBottomBar(state: PhotoState): void {
    const ctx = this.ctx;
    const { primary, secondary } = PHOTOGRAPHY.screenUI;
    const baseline = HEIGHT - 39;

    ctx.strokeStyle = hex(primary, 0.16);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, HEIGHT * 0.833);
    ctx.lineTo(WIDTH, HEIGHT * 0.833);
    ctx.stroke();

    ctx.textAlign = 'left';
    ctx.fillStyle = hex(primary);
    ctx.font = `600 40px ${FONT}`;
    ctx.fillText(formatFocal(state), 32, baseline);
    const focalWidth = ctx.measureText(formatFocal(state)).width;
    ctx.fillStyle = hex(secondary);
    ctx.font = `19px ${FONT}`;
    ctx.fillText('mm', 36 + focalWidth, baseline);

    ctx.font = `26px ${FONT}`;
    ctx.fillStyle = hex(primary);
    ctx.fillText(formatAperture(state), WIDTH * 0.175, baseline);
    ctx.fillText(formatShutter(state), WIDTH * 0.295, baseline);
    ctx.fillText(formatIso(state), WIDTH * 0.425, baseline);

    this.drawExposureRail(state, baseline);
    this.drawSelectionRail(state);
  }

  private drawExposureRail(state: PhotoState, baseline: number): void {
    const ctx = this.ctx;
    const { primary } = PHOTOGRAPHY.screenUI;
    const left = WIDTH * 0.615;
    const right = WIDTH * 0.855;

    ctx.strokeStyle = hex(primary, 0.62);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(left, baseline - 8);
    ctx.lineTo(right, baseline - 8);
    ctx.stroke();

    for (let i = 0; i <= 4; i++) {
      const x = left + ((right - left) * i) / 4;
      const tall = i === 2;
      ctx.beginPath();
      ctx.moveTo(x, baseline - 8 - (tall ? 10 : 6));
      ctx.lineTo(x, baseline - 8 + (tall ? 10 : 6));
      ctx.stroke();
    }

    // -3..+3 across the rail. Read straight from the ladder that drives the
    // dial rather than parsing formatExposure's display string back into a
    // number — that string uses a Unicode minus for legibility on the display,
    // which makes round-tripping it through Number() fragile.
    const value = EXPOSURES[state.exposureIndex];
    const marker = left + ((right - left) * (value + 3)) / 6;
    ctx.fillStyle = hex(primary);
    ctx.beginPath();
    ctx.moveTo(marker, baseline - 26);
    ctx.lineTo(marker + 6, baseline - 16);
    ctx.lineTo(marker - 6, baseline - 16);
    ctx.closePath();
    ctx.fill();

    ctx.textAlign = 'right';
    ctx.font = `24px ${FONT}`;
    ctx.fillText(formatExposure(state), WIDTH - 32, baseline);
  }

  /**
   * The single clearest signal that this is one continuous instrument rather
   * than a list of buttons. Drawn here at the target; the glide between targets
   * is animated in the shader.
   */
  private drawSelectionRail(state: PhotoState): void {
    if (state.selected === null) return;
    const target = SCREEN_ZONES.find((z) => z.settingId === state.selected);
    if (!target || target.y1 !== 1) return;

    const ctx = this.ctx;
    const pad = WIDTH * 0.012;
    ctx.fillStyle = hex(PHOTOGRAPHY.screenUI.accent);
    ctx.fillRect(target.x0 * WIDTH + pad, HEIGHT - 22, (target.x1 - target.x0) * WIDTH - pad * 2, 2.5);
  }
}
