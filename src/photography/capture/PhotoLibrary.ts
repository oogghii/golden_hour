import type { PhotoMetadata, PhotoRecord } from './photoRecord';

const DB_NAME = 'golden-hour';
const STORE = 'photos';
const VERSION = 1;

export type LibraryStatus = 'opening' | 'ready' | 'unavailable' | 'full';

/** Promisifies an IDBRequest, which is otherwise pure event plumbing. */
function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

/**
 * The card.
 *
 * Every method resolves rather than throwing. A browser in private mode, a
 * disabled store or an exhausted quota must cost the player a saved
 * photograph — never a working camera — so failure is reported as a status the
 * display can read, not as an exception the render loop has to survive.
 *
 * Deliberately untested: this is an IndexedDB transcription with no decisions
 * of its own, and covering it would mean adding a fake-indexeddb dependency to
 * assert that IndexedDB is IndexedDB. Everything with a judgement in it lives
 * in `photoRecord` and `AlbumState`, which are tested.
 */
export class PhotoLibrary {
  private db: IDBDatabase | null = null;
  private state: LibraryStatus = 'opening';

  get status(): LibraryStatus {
    return this.state;
  }

  async open(): Promise<void> {
    if (typeof indexedDB === 'undefined') {
      this.state = 'unavailable';
      return;
    }
    try {
      this.db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, VERSION);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains(STORE)) {
            request.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
        request.onblocked = () => reject(new Error('IndexedDB open blocked'));
      });
      this.state = 'ready';
    } catch {
      this.state = 'unavailable';
    }
  }

  /** Returns the new id, or null if the photograph could not be kept. */
  async put(metadata: PhotoMetadata, blob: Blob): Promise<number | null> {
    const db = this.db;
    if (!db || this.state !== 'ready') return null;
    try {
      const transaction = db.transaction(STORE, 'readwrite');
      const id = await promisify(transaction.objectStore(STORE).add({ ...metadata, blob }));
      return typeof id === 'number' ? id : null;
    } catch (error) {
      // A full card is a state the camera reports, not an error it throws.
      if (error instanceof DOMException && error.name === 'QuotaExceededError') {
        this.state = 'full';
      }
      return null;
    }
  }

  /** Oldest first, which is the order the roll was shot in. */
  async listIds(): Promise<number[]> {
    const db = this.db;
    if (!db || this.state === 'unavailable') return [];
    try {
      const transaction = db.transaction(STORE, 'readonly');
      const keys = await promisify(transaction.objectStore(STORE).getAllKeys());
      return keys.filter((key): key is number => typeof key === 'number');
    } catch {
      return [];
    }
  }

  async get(id: number): Promise<PhotoRecord | null> {
    const db = this.db;
    if (!db || this.state === 'unavailable') return null;
    try {
      const transaction = db.transaction(STORE, 'readonly');
      const record = await promisify<PhotoRecord | undefined>(
        transaction.objectStore(STORE).get(id),
      );
      return record ?? null;
    } catch {
      return null;
    }
  }
}
