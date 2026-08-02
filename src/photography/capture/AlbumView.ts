import * as THREE from 'three';
import type { LiveCameraScreen } from '../../camera/LiveCameraScreen';
import { PHOTOGRAPHY } from '../../core/Settings';
import type { System } from '../../core/System';
import { damp } from '../../util/math';
import type { PhotographyMode } from '../PhotographyMode';
import { touch } from '../PhotoState';
import type { PhotoLibrary } from './PhotoLibrary';

/**
 * Shows the photograph the player is currently looking at.
 *
 * One decoded texture at a time, so the album's memory cost does not grow with
 * the roll. Flips are absorbed rather than queued: the cursor moves
 * immediately and a decode that lands for a photograph the player has already
 * moved past is dropped, so holding an arrow key skates through the roll and
 * settles wherever it stopped instead of replaying a backlog of decodes.
 *
 * Registered after `PhotoCapture`. Both write the screen's photograph
 * uniforms, and the two states are mutually exclusive by construction — the
 * shutter no-ops while the album is open, and the album refuses to open over a
 * capture in flight — so the later writer wins on the one frame a transition
 * straddles.
 */
export class AlbumView implements System {
  private texture: THREE.Texture | null = null;
  private shownId: number | null = null;
  private pending: number | null = null;
  private fade = 0;
  private wasOpen = false;
  private knownCount = -1;

  constructor(
    private readonly photography: PhotographyMode,
    private readonly screen: LiveCameraScreen,
    private readonly library: PhotoLibrary,
  ) {}

  update(dt: number): void {
    const album = this.photography.album;

    if (!album.isOpen) {
      if (this.wasOpen) this.leave();
      return;
    }
    if (!this.wasOpen) {
      this.wasOpen = true;
      this.fade = 0;
    }

    const wanted = album.currentId;
    if (wanted !== null && wanted !== this.shownId && wanted !== this.pending) {
      void this.load(wanted);
    }

    // Fades in only once a texture is actually up, so the screen never fades
    // to an empty frame while a decode is still in flight.
    const ready = this.texture !== null && this.shownId === wanted;
    this.fade = damp(this.fade, ready ? 1 : 0, 1 / Math.max(PHOTOGRAPHY.album.fadeSeconds, 1e-3), dt);
    this.screen.setCapture(this.fade, 0, 0);
  }

  /** Re-reads the card. Called once it has mounted, and after every capture. */
  async refresh(): Promise<void> {
    const ids = await this.library.listIds();
    if (ids.length === this.knownCount) return;
    this.knownCount = ids.length;
    this.photography.album.setIds(ids);
    touch(this.photography.state);
  }

  private async load(id: number): Promise<void> {
    this.pending = id;
    const record = await this.library.get(id);
    if (!this.stillWanted(id)) return;
    if (!record) {
      this.pending = null;
      return;
    }

    // Flipped at decode, not at upload. The stored JPEG is top-down — that is
    // what makes it a valid image file — but the screen quad samples it with
    // v=0 at the bottom, the way it samples the review's render target. The
    // obvious fix, three's `texture.flipY`, does NOT work here: WebGL ignores
    // UNPACK_FLIP_Y_WEBGL for ImageBitmap sources, so the flag is silently a
    // no-op and the photograph comes out upside down. `imageOrientation` is
    // honoured because the flip happens before the texture ever reaches GL.
    const bitmap = await createImageBitmap(record.blob, { imageOrientation: 'flipY' });
    if (!this.stillWanted(id)) {
      bitmap.close();
      return;
    }

    this.texture?.dispose();
    const texture = new THREE.Texture(bitmap);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.flipY = false;
    texture.needsUpdate = true;
    this.texture = texture;
    this.shownId = id;
    this.pending = null;
    this.screen.setPhoto(texture);

    this.photography.albumCaption = {
      index: this.photography.album.index + 1,
      count: this.photography.album.count,
      takenAt: record.takenAt,
      focalMm: record.focalMm,
      aperture: record.aperture,
      shutterSpeed: record.shutterSpeed,
      iso: record.iso,
      focusDistance: record.focusDistance,
    };
    touch(this.photography.state);
  }

  /** The player may have flipped past this one while it was loading. */
  private stillWanted(id: number): boolean {
    if (this.photography.album.currentId === id) return true;
    if (this.pending === id) this.pending = null;
    return false;
  }

  private leave(): void {
    this.wasOpen = false;
    this.fade = 0;
    this.shownId = null;
    this.pending = null;
    this.screen.setCapture(0, 0, 0);
    this.screen.setPhoto(null);
    this.texture?.dispose();
    this.texture = null;
    this.photography.albumCaption = null;
    touch(this.photography.state);
  }

  dispose(): void {
    this.texture?.dispose();
    this.texture = null;
  }
}
