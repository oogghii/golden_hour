/**
 * Deterministic hashing and streams. Grass tiles and prop scatter derive their
 * layout purely from coordinates, so a tile recycled by walking away and back
 * regenerates identically instead of reshuffling.
 */

export function hash3(a: number, b: number, c: number): number {
  let h = 2166136261;
  h = Math.imul(h ^ (a | 0), 16777619);
  h = Math.imul(h ^ (b | 0), 16777619);
  h = Math.imul(h ^ (c | 0), 16777619);
  h ^= h >>> 13;
  return h >>> 0;
}

/** mulberry32. Small, fast, and good enough for scatter. */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
