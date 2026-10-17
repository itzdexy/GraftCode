import {
  ACESFilmicToneMapping,
  AnimationMixer,
  Box3,
  CanvasTexture,
  CircleGeometry,
  Clock,
  DirectionalLight,
  GridHelper,
  Group,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  PMREMGenerator,
  Scene,
  Sphere,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
  type AnimationAction,
  type BufferGeometry,
  type Material,
  type Object3D,
  type Texture,
  type WebGLRenderTarget
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { LoadedModel } from './loadModel';
import { cameraDistance, type ModelStats } from './modelFormats';

/** What the viewer component asks of the scene. */
export interface ModelView {
  show(model: LoadedModel): ModelStats;
  setAutoRotate(on: boolean): void;
  setWireframe(on: boolean): void;
  /** Plays one of the model's clips from its start; null stops them. */
  playClip(index: number | null): void;
  setPlaying(on: boolean): void;
  resetView(): void;
  dispose(): void;
}

const FOV = 35;
/** Where the camera looks from: a little to the right, above, in front. */
const LOOK_FROM = new Vector3(1, 0.62, 1.3).normalize();
const ENTRANCE_MS = 520;

/** A soft dark disc under the model, so it stands on the floor instead of floating. */
function contactShadow(): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const g = canvas.getContext('2d');
  if (g) {
    const fade = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    fade.addColorStop(0, 'rgba(0,0,0,0.42)');
    fade.addColorStop(0.55, 'rgba(0,0,0,0.16)');
    fade.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = fade;
    g.fillRect(0, 0, 128, 128);
  }
  return new CanvasTexture(canvas);
}

/** A round number of grid lines as wide as about three times the model. */
function gridSize(span: number): number {
  const want = Math.max(span * 3, 1e-3);
  const step = 10 ** Math.floor(Math.log10(want));
  return Math.ceil(want / step) * step;
}

function materialsOf(object: Object3D): Material[] {
  const out: Material[] = [];
  object.traverse((child) => {
    const material = (child as Mesh).material as Material | Material[] | undefined;
    if (material) out.push(...(Array.isArray(material) ? material : [material]));
  });
  return out;
}

function disposeTree(object: Object3D): void {
  object.traverse((child) => {
    (child as Mesh).geometry?.dispose();
  });
  for (const material of new Set(materialsOf(object))) {
    for (const value of Object.values(material)) if (value && typeof value === 'object' && (value as Texture).isTexture) (value as Texture).dispose();
    material.dispose();
  }
}

function measure(object: Object3D, clips: number): ModelStats {
  let meshes = 0;
  let triangles = 0;
  let vertices = 0;
  object.traverse((child) => {
    const geometry = (child as Mesh).geometry as BufferGeometry | undefined;
    if (!geometry || !((child as Mesh).isMesh || (child as unknown as { isPoints?: boolean }).isPoints)) return;
    meshes += 1;
    const count = geometry.getAttribute('position')?.count ?? 0;
    vertices += count;
    if ((child as Mesh).isMesh) triangles += Math.floor((geometry.index?.count ?? count) / 3);
  });
  const size = new Box3().setFromObject(object).getSize(new Vector3());
  return { meshes, triangles, vertices, materials: new Set(materialsOf(object)).size, clips, size: { x: size.x, y: size.y, z: size.z } };
}

const easeOut = (t: number): number => 1 - (1 - t) ** 3;

/**
 * A three.js scene in `host`: soft studio light, a floor with a grid and a
 * contact shadow, a camera that orbits and can turn the model by itself.
 * Throws when this computer can't draw with WebGL. It draws only while it can
 * be seen, and frees its drawing context when disposed (a window has few).
 */
export function createModelView(host: HTMLElement, options: { reducedMotion: boolean; light: boolean }): ModelView {
  const renderer = new WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.92;
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  renderer.domElement.setAttribute('aria-hidden', 'true');
  host.appendChild(renderer.domElement);

  const scene = new Scene();
  const pmrem = new PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const environment: WebGLRenderTarget = pmrem.fromScene(room, 0.04);
  scene.environment = environment.texture;
  scene.environmentIntensity = 0.5;
  scene.add(new HemisphereLight(0xffffff, options.light ? 0xb8b4aa : 0x3a3631, 0.35));
  // Light from the upper right, so faces turned different ways read as different shades.
  const sun = new DirectionalLight(0xffffff, 1.7);
  sun.position.set(6, 9, 2.5);
  scene.add(sun);

  const camera = new PerspectiveCamera(FOV, 1, 0.01, 1000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.screenSpacePanning = true;
  controls.autoRotateSpeed = 1.6;

  const pivot = new Group();
  scene.add(pivot);
  const floor = new Group();
  scene.add(floor);
  const clock = new Clock();
  let mixer: AnimationMixer | null = null;
  let actions: AnimationAction[] = [];
  let playing = true;
  let entranceStart: number | null = null;
  let home: { position: Vector3; target: Vector3 } | null = null;
  let shown: LoadedModel | null = null;

  const fit = (): void => {
    const width = host.clientWidth;
    const height = host.clientHeight;
    if (width === 0 || height === 0) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };

  const tick = (): void => {
    const delta = clock.getDelta();
    if (entranceStart !== null) {
      const t = Math.min(1, (performance.now() - entranceStart) / ENTRANCE_MS);
      const k = easeOut(t);
      pivot.scale.setScalar(0.86 + 0.14 * k);
      pivot.rotation.y = -0.5 * (1 - k);
      if (t >= 1) entranceStart = null;
    }
    mixer?.update(playing ? delta : 0);
    controls.update(delta);
    renderer.render(scene, camera);
  };

  // Drawn only while on screen: a model far up the conversation costs nothing.
  let onScreen = true;
  const sync = (): void => renderer.setAnimationLoop(onScreen && !document.hidden ? tick : null);
  const seen = new IntersectionObserver((entries) => {
    onScreen = entries.some((entry) => entry.isIntersecting);
    sync();
  });
  seen.observe(host);
  const sized = new ResizeObserver(fit);
  sized.observe(host);
  document.addEventListener('visibilitychange', sync);
  fit();
  sync();

  return {
    show(model) {
      shown = model;
      const { object } = model;
      const box = new Box3().setFromObject(object);
      if (box.isEmpty()) throw new Error('This file has nothing to draw.');
      const center = box.getCenter(new Vector3());
      const size = box.getSize(new Vector3());
      // Stood on the floor, in the middle of it.
      object.position.x -= center.x;
      object.position.z -= center.z;
      object.position.y -= box.min.y;
      pivot.add(object);

      const radius = box.getBoundingSphere(new Sphere()).radius;
      const span = Math.max(size.x, size.z, size.y * 0.5);
      const grid = new GridHelper(gridSize(span), 20, options.light ? 0xa9a69e : 0x5f5c56, options.light ? 0xd2d0c9 : 0x3b3a36);
      const gridMaterials: Material[] = Array.isArray(grid.material) ? grid.material : [grid.material];
      for (const material of gridMaterials) {
        material.transparent = true;
        material.opacity = 0.7;
        material.depthWrite = false;
      }
      floor.add(grid);
      const shadow = new Mesh(new CircleGeometry(Math.max(size.x, size.z) * 0.75 || radius, 48), new MeshBasicMaterial({ map: contactShadow(), transparent: true, depthWrite: false }));
      shadow.rotation.x = -Math.PI / 2;
      shadow.position.y = Math.max(radius * 1e-3, 1e-4);
      floor.add(shadow);

      const target = new Vector3(0, size.y / 2, 0);
      const distance = cameraDistance(radius, FOV, camera.aspect || 1);
      camera.near = Math.max(distance / 200, 1e-4);
      camera.far = distance * 200;
      camera.position.copy(target).addScaledVector(LOOK_FROM, distance);
      camera.updateProjectionMatrix();
      controls.target.copy(target);
      controls.minDistance = radius * 0.15;
      controls.maxDistance = distance * 8;
      controls.update();
      home = { position: camera.position.clone(), target: target.clone() };

      if (model.clips.length > 0) {
        mixer = new AnimationMixer(object);
        actions = model.clips.map((clip) => mixer?.clipAction(clip)).filter((action): action is AnimationAction => action !== undefined);
      }
      entranceStart = options.reducedMotion ? null : performance.now();
      return measure(object, model.clips.length);
    },
    setAutoRotate(on) {
      // The viewer starts still when motion is reduced (ModelViewer); turning it on is then the person's own choice.
      controls.autoRotate = on;
    },
    setWireframe(on) {
      for (const material of materialsOf(pivot)) if ('wireframe' in material) (material as Material & { wireframe: boolean }).wireframe = on;
    },
    playClip(index) {
      for (const action of actions) action.stop();
      const action = index === null ? undefined : actions[index];
      action?.reset().play();
    },
    setPlaying(on) {
      playing = on;
    },
    resetView() {
      if (!home) return;
      camera.position.copy(home.position);
      controls.target.copy(home.target);
      controls.update();
    },
    dispose() {
      renderer.setAnimationLoop(null);
      seen.disconnect();
      sized.disconnect();
      document.removeEventListener('visibilitychange', sync);
      controls.dispose();
      mixer?.stopAllAction();
      if (shown) disposeTree(shown.object);
      disposeTree(floor);
      room.dispose();
      environment.dispose();
      pmrem.dispose();
      renderer.dispose();
      // Gives the drawing context back at once: a window may hold only a few.
      renderer.forceContextLoss();
      renderer.domElement.remove();
    }
  };
}
