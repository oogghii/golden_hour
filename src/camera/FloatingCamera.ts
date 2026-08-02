import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import cameraSource from '../../blockbench/camera/camera.gltf?raw';
import { FLOATING_CAMERA } from '../core/Settings';
import type { EngineContext, System } from '../core/System';
import type { FirstPersonCamera } from '../player/FirstPersonCamera';
import type { Player } from '../player/Player';
import { clamp, saturate } from '../util/math';
import type { CameraScreen } from './CameraScreen';
import { createPoseBlend, type CameraPose, type PoseBlend } from './CameraPose';

/** Enlarged so the shutter never needs pixel-perfect targeting. */
const HIT_VOLUME_SCALE = 2.4;

/**
 * The floating camera lives on its own layer so the viewfinder pass can exclude
 * it. Without this the camera appears inside its own screen, recursively.
 */
export const CAMERA_LAYER = 1;

/**
 * A telekinetic vintage camera that follows in world space. Its target is
 * camera-relative, but the lagged position and orientation make it feel held
 * rather than bolted to the viewport.
 */
export class FloatingCamera implements System {
  private readonly root = new THREE.Group();
  private readonly local = new THREE.Vector3();
  private readonly targetPosition = new THREE.Vector3();
  private readonly targetQuaternion = new THREE.Quaternion();
  private readonly localRotation = new THREE.Quaternion();
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly pose: PoseBlend = createPoseBlend();
  private viewCamera: THREE.PerspectiveCamera | null = null;
  private model: THREE.Object3D | null = null;
  private initializedPose = false;
  private previousSpeed = 0;

  constructor(
    private readonly player: Player,
    private readonly look: FirstPersonCamera,
    private readonly screen: CameraScreen,
    private readonly raise: CameraPose,
  ) {}

  /** The merged camera object, once loaded. Null before `init`. */
  get object(): THREE.Object3D | null {
    return this.model;
  }

  /** The physically-depressing cap, distinct from its enlarged hit volume. */
  get shutterButton(): THREE.Object3D | null {
    return this.model?.getObjectByName('ShutterButton') ?? null;
  }

  async init(ctx: EngineContext): Promise<void> {
    this.viewCamera = ctx.camera;
    this.model = await loadCameraModel();
    this.model.scale.setScalar(FLOATING_CAMERA.scale);
    prepareMaterials(this.model, ctx.renderer.capabilities.getMaxAnisotropy());
    this.screen.attach(this.model);
    this.root.add(this.model);
    ctx.scene.add(this.root);
    this.root.traverse((child) => child.layers.set(CAMERA_LAYER));
    ctx.camera.layers.enable(CAMERA_LAYER);
    this.updateTarget(0, 0.016);
    this.root.position.copy(this.targetPosition);
    this.root.quaternion.copy(this.targetQuaternion);
    this.initializedPose = true;
  }

  update(dt: number, elapsed: number): void {
    if (!this.viewCamera || !this.model || !this.initializedPose || dt <= 0) return;
    this.raise.update(dt);
    this.updateTarget(elapsed, dt);

    const positionAlpha = 1 - Math.exp(-this.pose.followLambda * dt);
    this.root.position.lerp(this.targetPosition, positionAlpha);
    const rotationAlpha = 1 - Math.exp(-this.pose.rotationLambda * dt);
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

    this.raise.resolve(this.viewCamera.fov, this.pose);
    const pose = this.pose;

    const speed = saturate(this.player.speed / 1.9);
    const accel = dt > 0 ? (speed - this.previousSpeed) / dt : 0;
    this.previousSpeed = speed;

    const t = elapsed * FLOATING_CAMERA.idleDrift.rate;
    const drift = FLOATING_CAMERA.idleDrift.amount * pose.driftScale;
    const driftY = (Math.sin(t) + Math.sin(t * 1.63 + 1.2) * 0.4) * drift;
    const driftX = Math.sin(t * 0.83 + 2.4) * 0.5 * drift;

    this.local.copy(pose.anchor);
    this.local.y += driftY + speed * FLOATING_CAMERA.movementLift;
    this.local.x += driftX;

    // Inertia: camera pushes into the screen when accelerating, pulls back when stopping
    this.local.z += clamp(accel * 0.05, -0.08, 0.08);

    const lookOffset = FLOATING_CAMERA.lookOffset * pose.lookOffsetScale;
    this.local.x -= clamp(this.look.yawRate, -2.2, 2.2) * lookOffset;
    this.local.y += clamp(this.look.pitchRate, -1.8, 1.8) * lookOffset * 0.45;

    this.targetPosition.copy(this.local).applyQuaternion(this.viewCamera.quaternion);
    this.targetPosition.add(this.viewCamera.position);

    this.euler.set(
      pose.pitch - this.look.pitchRate * 0.012,
      pose.yaw,
      pose.roll - this.look.yawRate * FLOATING_CAMERA.bank * pose.bankScale,
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

/**
 * Two merged meshes, not one. The glTF's `button` root is the only interactive
 * part in the asset, so it keeps its own mesh and can physically depress.
 * DECISIONS.md justified the original flatten by shadow-pass cost; this model
 * sets castShadow = false, so that reason does not apply.
 */
function mergeModel(source: THREE.Object3D): THREE.Object3D {
  source.updateMatrixWorld(true);
  const model = new THREE.Group();

  const buttonRoot = source.getObjectByName('button');
  if (!buttonRoot) throw new Error('camera.gltf is missing its `button` root node');

  const body = mergeSubtree(source, (node) => !isDescendantOf(node, buttonRoot));
  body.name = 'VintageCameraBody';
  model.add(body);

  const button = mergeSubtree(buttonRoot, () => true);
  button.name = 'ShutterButton';
  model.add(button);

  model.add(createHitVolume(button));
  return model;
}

/** Merges every mesh under `root` that passes `accept` into one mesh. */
function mergeSubtree(
  root: THREE.Object3D,
  accept: (node: THREE.Mesh) => boolean,
): THREE.Mesh {
  const geometries: THREE.BufferGeometry[] = [];
  let material: THREE.Material | null = null;

  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh) || !accept(child)) return;
    const childMaterial = Array.isArray(child.material) ? child.material[0] : child.material;
    material ??= childMaterial ?? null;
    const geometry = child.geometry.clone();
    geometry.applyMatrix4(child.matrixWorld);
    geometries.push(geometry);
  });

  const merged = mergeGeometries(geometries, false);
  geometries.forEach((geometry) => geometry.dispose());
  if (!merged || !material) throw new Error('Blockbench camera geometry could not be merged');
  return new THREE.Mesh(merged, material);
}

function isDescendantOf(node: THREE.Object3D, ancestor: THREE.Object3D): boolean {
  for (let current: THREE.Object3D | null = node; current; current = current.parent) {
    if (current === ancestor) return true;
  }
  return false;
}

/**
 * Picking never runs against the cap geometry. This box is generous enough for
 * a reticle that is not pixel-perfect and for a fingertip on a phone.
 */
function createHitVolume(button: THREE.Mesh): THREE.Mesh {
  button.geometry.computeBoundingBox();
  const box = button.geometry.boundingBox;
  if (!box) throw new Error('Shutter button geometry has no bounding box');

  const size = box.getSize(new THREE.Vector3()).multiplyScalar(HIT_VOLUME_SCALE);
  const centre = box.getCenter(new THREE.Vector3());
  const volume = new THREE.Mesh(
    new THREE.BoxGeometry(size.x, size.y, size.z),
    new THREE.MeshBasicMaterial({ visible: false }),
  );
  volume.position.copy(centre);
  volume.name = 'ShutterHitVolume';
  volume.visible = false;
  return volume;
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
