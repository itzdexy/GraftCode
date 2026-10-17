/**
 * What the 3D viewer reads and how it says what it found. Pure, so it is
 * unit-tested without a DOM or a GPU; the drawing is in viewer.ts.
 */

export const MODEL_FORMATS = ['glb', 'gltf', 'obj', 'stl', 'fbx', 'ply'] as const;
export type ModelFormat = (typeof MODEL_FORMATS)[number];

/** The format of a model file by its name, or null for anything else. */
export function modelFormat(path: string): ModelFormat | null {
  const dot = path.lastIndexOf('.');
  if (dot < 0 || dot < Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))) return null;
  const ext = path.slice(dot + 1).toLowerCase();
  return (MODEL_FORMATS as readonly string[]).includes(ext) ? (ext as ModelFormat) : null;
}

/**
 * A name a model gives for a file beside it, as a path in the session's
 * folder: resolved against the model's own folder, with its %-escapes
 * decoded. Null for an address elsewhere (data:, http:, an absolute path) or
 * one that climbs out of the folder.
 */
export function besideModel(modelPath: string, uri: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(uri) || uri.startsWith('/') || uri.startsWith('\\')) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(uri);
  } catch {
    return null;
  }
  const dir = modelPath.replace(/\\/g, '/').split('/').slice(0, -1);
  const parts = [...dir];
  for (const part of decoded.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.length > 0 ? parts.join('/') : null;
}

interface GltfJson {
  buffers?: Array<{ uri?: unknown }>;
  images?: Array<{ uri?: unknown }>;
  extensionsUsed?: unknown;
  extensionsRequired?: unknown;
}

const asGltf = (json: unknown): GltfJson => (json && typeof json === 'object' ? json : {});

/** The files a .gltf loads from beside itself, each with the name it gives and where that is in the folder. */
export function gltfResources(json: unknown, modelPath: string): Array<{ uri: string; path: string }> {
  const gltf = asGltf(json);
  const uris = [...(gltf.buffers ?? []), ...(gltf.images ?? [])].map((entry) => entry.uri).filter((uri): uri is string => typeof uri === 'string');
  const out: Array<{ uri: string; path: string }> = [];
  for (const uri of new Set(uris)) {
    const path = besideModel(modelPath, uri);
    if (path) out.push({ uri, path });
  }
  return out;
}

/** Compression the viewer can't undo here: both need WebAssembly, which Graft's window doesn't run. */
const NEEDS_WASM: Record<string, string> = {
  KHR_draco_mesh_compression: 'Draco',
  EXT_meshopt_compression: 'meshopt',
  KHR_meshopt_compression: 'meshopt'
};

/** The sentence a model gets when it is compressed in a way the viewer can't read; null when it can be read. */
export function unreadableCompression(json: unknown): string | null {
  const gltf = asGltf(json);
  const named: unknown[] = [gltf.extensionsRequired, gltf.extensionsUsed].flatMap((list): unknown[] => (Array.isArray(list) ? (list as unknown[]) : []));
  const kinds = [...new Set(named.map((name) => (typeof name === 'string' ? NEEDS_WASM[name] : undefined)).filter((kind): kind is string => kind !== undefined))];
  if (kinds.length === 0) return null;
  return `This model is compressed with ${kinds.join(' and ')}, which the preview can't unpack yet. Open it in Blender, or export it again without compression, to see it here.`;
}

/** The JSON part of a .glb file, or null when the bytes are not one. */
export function glbJson(bytes: Uint8Array): unknown {
  if (bytes.length < 20) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // "glTF", then the version and the length; the first chunk is the JSON ("JSON").
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(16, true) !== 0x4e4f534a) return null;
  const length = view.getUint32(12, true);
  if (20 + length > bytes.length) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + length)));
  } catch {
    return null;
  }
}

export interface ModelStats {
  meshes: number;
  triangles: number;
  vertices: number;
  materials: number;
  /** Animation clips. */
  clips: number;
  /** The extent along each axis, in the file's own units. */
  size: { x: number; y: number; z: number };
}

const count = (n: number, one: string, many: string): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** One line on what a model is made of. */
export function statsText(stats: ModelStats): string {
  const parts = [count(stats.triangles, 'triangle', 'triangles'), count(stats.meshes, 'mesh', 'meshes')];
  if (stats.materials > 0) parts.push(count(stats.materials, 'material', 'materials'));
  if (stats.clips > 0) parts.push(count(stats.clips, 'animation', 'animations'));
  return parts.join(' · ');
}

/** Its size, as "1.2 × 0.4 × 3.1". */
export function sizeText(size: ModelStats['size']): string {
  const fmt = (v: number): string => {
    const fixed = v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
    return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
  };
  return `${fmt(size.x)} × ${fmt(size.y)} × ${fmt(size.z)}`;
}

/**
 * How far the camera stands from the middle of a model so a sphere of this
 * radius fills most of the view, whichever of the view's sides is shorter.
 */
export function cameraDistance(radius: number, verticalFovDeg: number, aspect: number): number {
  const vertical = (verticalFovDeg * Math.PI) / 180;
  const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * aspect);
  const fov = Math.min(vertical, horizontal);
  return (Math.max(radius, 1e-6) / Math.sin(fov / 2)) * 1.08;
}
