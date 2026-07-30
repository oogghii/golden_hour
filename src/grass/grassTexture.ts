import * as THREE from 'three';

const SIZE = 256;
const BLADES = 34;

/**
 * A cluster of blades painted to canvas. Deliberately colourless: the red
 * channel carries the along-blade parameter (dark at the root, bright at the
 * tip) and alpha carries coverage.
 *
 * That is what keeps the two grass bands matched — both shaders tint from the
 * same palette using the same parameter, so retuning the palette moves the
 * blades and the clusters together.
 */
export function createGrassTexture(anisotropy: number): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable for the grass texture');

  ctx.clearRect(0, 0, SIZE, SIZE);

  for (let i = 0; i < BLADES; i++) {
    // Deterministic layout, so the texture is identical every run.
    const r1 = fract(i * 0.6180339887);
    const r2 = fract(i * 0.3819660113 + 0.37);
    const r3 = fract(i * 0.7548776662 + 0.11);

    const rootX = 8 + r1 * (SIZE - 16);
    const height = SIZE * (0.55 + r2 * 0.44);
    const halfWidth = 2.2 + r3 * 3.4;
    const lean = (r3 - 0.5) * SIZE * 0.34;

    drawBlade(ctx, rootX, SIZE, height, halfWidth, lean);
  }

  const texture = new THREE.CanvasTexture(canvas);
  // Data, not colour: no sRGB decode should ever be applied to it.
  texture.colorSpace = THREE.NoColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = anisotropy;
  texture.needsUpdate = true;
  return texture;
}

function fract(v: number): number {
  return v - Math.floor(v);
}

function drawBlade(
  ctx: CanvasRenderingContext2D,
  rootX: number,
  rootY: number,
  height: number,
  halfWidth: number,
  lean: number,
): void {
  const tipX = rootX + lean;
  const tipY = rootY - height;
  const ctrlX = rootX + lean * 0.3;
  const ctrlY = rootY - height * 0.62;

  const gradient = ctx.createLinearGradient(rootX, rootY, tipX, tipY);
  gradient.addColorStop(0, 'rgb(20, 20, 20)');
  gradient.addColorStop(0.55, 'rgb(150, 150, 150)');
  gradient.addColorStop(1, 'rgb(255, 255, 255)');

  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.moveTo(rootX - halfWidth, rootY);
  ctx.quadraticCurveTo(ctrlX - halfWidth * 0.45, ctrlY, tipX, tipY);
  ctx.quadraticCurveTo(ctrlX + halfWidth * 0.45, ctrlY, rootX + halfWidth, rootY);
  ctx.closePath();
  ctx.fill();
}
