import { Group, LoadingManager, Mesh, MeshStandardMaterial, Points, PointsMaterial, type AnimationClip, type BufferGeometry, type Material, type Object3D } from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { glbJson, gltfResources, modelFormat, unreadableCompression } from './modelFormats';

export interface LoadedModel {
  object: Object3D;
  clips: AnimationClip[];
}

/** Reads a file of the session's folder whole (the model, or a file a .gltf loads beside it). */
export type ReadBytes = (path: string) => Promise<Uint8Array>;

/** The grey a model without colors of its own is drawn in: light enough to show its shading in both themes. */
const CLAY = 0x9ea4ad;

function clay(geometry: BufferGeometry): MeshStandardMaterial {
  return new MeshStandardMaterial({ color: geometry.hasAttribute('color') ? 0xffffff : CLAY, vertexColors: geometry.hasAttribute('color'), roughness: 0.55, metalness: 0.05 });
}

function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** A mesh, or a cloud of points when the file has no faces (a scan saved as .ply has no index then). */
function fromGeometry(geometry: BufferGeometry, pointsWithoutIndex: boolean): Object3D {
  const faces = geometry.index !== null ? geometry.index.count > 0 : !pointsWithoutIndex;
  if (!faces) return new Points(geometry, new PointsMaterial({ size: 0.01, sizeAttenuation: true, vertexColors: geometry.hasAttribute('color'), color: geometry.hasAttribute('color') ? 0xffffff : CLAY }));
  if (!geometry.hasAttribute('normal')) geometry.computeVertexNormals();
  return new Mesh(geometry, clay(geometry));
}

async function gltf(read: ReadBytes, path: string, bytes: Uint8Array): Promise<LoadedModel> {
  const binary = modelFormat(path) === 'glb';
  let json: unknown;
  let text = '';
  if (binary) json = glbJson(bytes);
  else {
    text = new TextDecoder().decode(bytes);
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error('This .gltf file is not valid JSON.');
    }
  }
  const refusal = unreadableCompression(json);
  if (refusal) throw new Error(refusal);
  // A .gltf names its buffers and pictures; each is read from the folder and handed over as an address of its own.
  const addresses = new Map<string, string>();
  try {
    if (!binary) {
      for (const { uri, path: beside } of gltfResources(json, path)) {
        const data = await read(beside);
        addresses.set(uri, URL.createObjectURL(new Blob([exactBuffer(data)])));
      }
    }
    const manager = new LoadingManager();
    manager.setURLModifier((url) => addresses.get(url) ?? url);
    const result = await new GLTFLoader(manager).parseAsync(binary ? exactBuffer(bytes) : text, '');
    return { object: result.scene, clips: result.animations };
  } finally {
    for (const address of addresses.values()) URL.revokeObjectURL(address);
  }
}

/**
 * Reads a model with three.js's loaders. Everything comes from the session's
 * folder through `read`: nothing is fetched from anywhere else, and a model
 * that points elsewhere is drawn without what it points to.
 */
export async function loadModel(read: ReadBytes, path: string): Promise<LoadedModel> {
  const format = modelFormat(path);
  if (!format) throw new Error(`${path} is not a 3D model the preview reads.`);
  const bytes = await read(path);
  switch (format) {
    case 'glb':
    case 'gltf':
      return gltf(read, path, bytes);
    case 'fbx': {
      const group = new FBXLoader().parse(exactBuffer(bytes), '');
      return { object: group, clips: group.animations };
    }
    case 'obj': {
      const group = new OBJLoader().parse(new TextDecoder().decode(bytes));
      // An .obj read without its .mtl has plain white Phong surfaces; clay shows its shape better.
      group.traverse((child) => {
        const mesh = child as Mesh;
        if (!mesh.isMesh) return;
        const old: Material | Material[] = mesh.material;
        mesh.material = clay(mesh.geometry);
        for (const material of Array.isArray(old) ? old : [old]) material.dispose();
      });
      return { object: group, clips: [] };
    }
    case 'stl':
      return { object: fromGeometry(new STLLoader().parse(exactBuffer(bytes)), false), clips: [] };
    case 'ply': {
      const holder = new Group();
      holder.add(fromGeometry(new PLYLoader().parse(exactBuffer(bytes)), true));
      return { object: holder, clips: [] };
    }
  }
}
