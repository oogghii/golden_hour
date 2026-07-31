import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import cameraSource from '../../blockbench/camera/camera.gltf?raw';
import { FLOATING_CAMERA } from '../core/Settings';
import type { EngineContext, System } from '../core/System';
import type { FirstPersonCamera } from '../player/FirstPersonCamera';
import type { Player } from '../player/Player';
import { clamp, DEG, saturate } from '../util/math';
import type { CameraScreen } from './CameraScreen';

/**
 * A telekinetic vintage camera that follows in world space. Its target is
 * camera-relative, but the lagged position and orientation make it feel held
 * rather than bolted to the viewport.
 */
export class FloatingCamera implements System {
  private readonly root = new THREE.Group();
  private readonly anchor = new THREE.Vector3(...FLOATING_CAMERA.anchor);
  private readonly local = new THREE.Vector3();
  private readonly targetPosition = new THREE.Vector3();
  private readonly targetQuaternion = new THREE.Quaternion();
  private readonly localRotation = new THREE.Quaternion();
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private viewCamera: THREE.PerspectiveCamera | null = null;
  private model: THREE.Object3D | null = null;
  private initializedPose = false;
  private previousSpeed = 0;

  constructor(
    private readonly player: Player,
    private readonly look: FirstPersonCamera,
    private readonly screen: CameraScreen,
  ) {}

  async init(ctx: EngineContext): Promise<void> {
    this.viewCamera = ctx.camera;
    this.model = await loadCameraModel();
    this.model.scale.setScalar(FLOATING_CAMERA.scale);
    prepareMaterials(this.model, ctx.renderer.capabilities.getMaxAnisotropy());
    this.screen.attach(this.model);
    this.root.add(this.model);
    ctx.scene.add(this.root);
    this.updateTarget(0, 0.016);
    this.root.position.copy(this.targetPosition);
    this.root.quaternion.copy(this.targetQuaternion);
    this.initializedPose = true;
  }

  update(dt: number, elapsed: number): void {
    if (!this.viewCamera || !this.model || !this.initializedPose || dt <= 0) return;
    this.updateTarget(elapsed, dt);

    const positionAlpha = 1 - Math.exp(-FLOATING_CAMERA.followLambda * dt);
    this.root.position.lerp(this.targetPosition, positionAlpha);
    const rotationAlpha = 1 - Math.exp(-FLOATING_CAMERA.rotationLambda * dt);
    this.root.quaternion.slerp(this.targetQuaternion, rotationAlpha);
    this.screen.update?.(dt, elapsed);
  }

  dispose(): void {
    this.screen.dispose();
    if (this.model) disposeModel(this.model);
    this.root.clear();
    this.root.removeFromParent();
    this.model = null;
    this.viewCamera = null;
  }

  private updateTarget(elapsed: number, dt: number): void {
    if (!this.viewCamera) return;

    const speed = saturate(this.player.speed / 1.9);
    const accel = dt > 0 ? (speed - this.previousSpeed) / dt : 0;
    this.previousSpeed = speed;

    const t = elapsed * FLOATING_CAMERA.idleDrift.rate;
    const driftY = (Math.sin(t) + Math.sin(t * 1.63 + 1.2) * 0.4) * FLOATING_CAMERA.idleDrift.amount;
    const driftX = (Math.sin(t * 0.83 + 2.4) * 0.5) * FLOATING_CAMERA.idleDrift.amount;

    this.local.copy(this.anchor);
    this.local.y += driftY + speed * FLOATING_CAMERA.movementLift;
    this.local.x += driftX;
    
    // Inertia: camera pushes into the screen when accelerating, pulls back when stopping
    this.local.z += clamp(accel * 0.05, -0.08, 0.08);

    this.local.x -= clamp(this.look.yawRate, -2.2, 2.2) * FLOATING_CAMERA.lookOffset;
    this.local.y +=
      clamp(this.look.pitchRate, -1.8, 1.8) * FLOATING_CAMERA.lookOffset * 0.45;

    this.targetPosition.copy(this.local).applyQuaternion(this.viewCamera.quaternion);
    this.targetPosition.add(this.viewCamera.position);

    const rotation = FLOATING_CAMERA.rotationDeg;
    this.euler.set(
      rotation.x * DEG - this.look.pitchRate * 0.012,
      rotation.y * DEG,
      rotation.z * DEG - this.look.yawRate * FLOATING_CAMERA.bank,
    );
    this.localRotation.setFromEuler(this.euler);
    this.targetQuaternion.copy(this.viewCamera.quaternion).multiply(this.localRotation);
  }
}

function loadCameraModel(): Promise<THREE.Object3D> {
  return new Promise((resolve, reject) => {
    new GLTFLoader().parse(
      cameraSource,
      '',
      (gltf: GLTF) => resolve(mergeModel(gltf.scene)),
      (error: unknown) => reject(error),
    );
  });
}

function prepareMaterials(model: THREE.Object3D, anisotropy: number): void {
  model.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    // This object floats near eye level; a full shadow pass costs as much as
    // drawing it again and produces an implausible moving shadow on the field.
    child.castShadow = false;
    child.receiveShadow = false;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      if (!(material instanceof THREE.MeshStandardMaterial)) continue;
      material.roughness = 0.82;
      material.metalness = 0.04;
      material.flatShading = true;
      if (material.map) {
        material.map.magFilter = THREE.NearestFilter;
        material.map.minFilter = THREE.NearestMipmapNearestFilter;
        material.map.anisotropy = Math.min(4, anisotropy);
      }
      material.needsUpdate = true;
    }
  });
}

function mergeModel(source: THREE.Object3D): THREE.Object3D {
  source.updateMatrixWorld(true);
  const geometries: THREE.BufferGeometry[] = [];
  let material: THREE.Material | null = null;

  source.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const childMaterial = Array.isArray(child.material) ? child.material[0] : child.material;
    material ??= childMaterial ?? null;
    const geometry = child.geometry.clone();
    geometry.applyMatrix4(child.matrixWorld);
    geometries.push(geometry);
    child.geometry.dispose();
  });

  const merged = mergeGeometries(geometries, false);
  geometries.forEach((geometry) => geometry.dispose());
  if (!merged || !material) throw new Error('Blockbench camera geometry could not be merged');

  const model = new THREE.Group();
  const mesh = new THREE.Mesh(merged, material);
  mesh.name = 'VintageCameraBody';
  model.add(mesh);
  return model;
}

function disposeModel(model: THREE.Object3D): void {
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  model.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.geometry.dispose();
    const childMaterials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of childMaterials) {
      materials.add(material);
      if ('map' in material && material.map instanceof THREE.Texture) textures.add(material.map);
    }
  });
  textures.forEach((texture) => texture.dispose());
  materials.forEach((material) => material.dispose());
}
