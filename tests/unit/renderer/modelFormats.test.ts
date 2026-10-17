import { describe, expect, it } from 'vitest';
import {
  besideModel,
  cameraDistance,
  glbJson,
  gltfResources,
  modelFormat,
  sizeText,
  statsText,
  unreadableCompression
} from '../../../src/renderer/src/features/models/modelFormats';

describe('which files are 3D models', () => {
  it('goes by the name, whatever its case', () => {
    expect(modelFormat('exports/AK74M.FBX')).toBe('fbx');
    expect(modelFormat('a/b/scene.glb')).toBe('glb');
    expect(modelFormat('mesh.gltf')).toBe('gltf');
    expect(['x.obj', 'x.stl', 'x.ply'].map(modelFormat)).toEqual(['obj', 'stl', 'ply']);
    expect(modelFormat('notes.md')).toBeNull();
    expect(modelFormat('folder.glb/readme')).toBeNull();
    expect(modelFormat('glb')).toBeNull();
  });
});

describe('the files a .gltf loads beside it', () => {
  it('are found next to the model, decoded, and kept inside the folder', () => {
    expect(besideModel('art/ship/ship.gltf', 'ship.bin')).toBe('art/ship/ship.bin');
    expect(besideModel('art/ship/ship.gltf', 'textures/hull%20base.png')).toBe('art/ship/textures/hull base.png');
    expect(besideModel('art/ship/ship.gltf', '../shared/metal.jpg')).toBe('art/shared/metal.jpg');
    expect(besideModel('ship.gltf', '../outside.bin')).toBeNull();
    expect(besideModel('ship.gltf', 'data:application/octet-stream;base64,AAAA')).toBeNull();
    expect(besideModel('ship.gltf', 'https://example.com/a.bin')).toBeNull();
    expect(besideModel('ship.gltf', '/etc/passwd')).toBeNull();
    expect(besideModel('ship.gltf', '%E0%A4%A')).toBeNull();
  });

  it('are listed once each, buffers and pictures together', () => {
    const json = {
      buffers: [{ uri: 'ship.bin' }, { uri: 'data:application/octet-stream;base64,AAAA' }],
      images: [{ uri: 'hull.png' }, { uri: 'ship.bin' }, { bufferView: 2 }]
    };
    expect(gltfResources(json, 'models/ship.gltf')).toEqual([
      { uri: 'ship.bin', path: 'models/ship.bin' },
      { uri: 'hull.png', path: 'models/hull.png' }
    ]);
    expect(gltfResources(null, 'x.gltf')).toEqual([]);
  });

  it('says plainly when a model is compressed in a way the preview can’t unpack', () => {
    expect(unreadableCompression({ extensionsUsed: ['KHR_materials_unlit'] })).toBeNull();
    expect(unreadableCompression({ extensionsRequired: ['KHR_draco_mesh_compression'] })).toMatch(/^This model is compressed with Draco, /);
    expect(unreadableCompression({ extensionsUsed: ['EXT_meshopt_compression', 'KHR_draco_mesh_compression'] })).toMatch(/with meshopt and Draco,/);
  });
});

describe('the JSON inside a .glb', () => {
  const glb = (json: string): Uint8Array => {
    const text = new TextEncoder().encode(json.padEnd(Math.ceil(json.length / 4) * 4, ' '));
    const bytes = new Uint8Array(20 + text.length);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x46546c67, true);
    view.setUint32(4, 2, true);
    view.setUint32(8, bytes.length, true);
    view.setUint32(12, text.length, true);
    view.setUint32(16, 0x4e4f534a, true);
    bytes.set(text, 20);
    return bytes;
  };

  it('is read from its first chunk', () => {
    expect(glbJson(glb('{"asset":{"version":"2.0"},"extensionsUsed":["KHR_draco_mesh_compression"]}'))).toEqual({
      asset: { version: '2.0' },
      extensionsUsed: ['KHR_draco_mesh_compression']
    });
  });

  it('is nothing for bytes that are not a .glb', () => {
    expect(glbJson(new Uint8Array(10))).toBeNull();
    expect(glbJson(new TextEncoder().encode('solid cube\nfacet normal 0 0 1\n'))).toBeNull();
  });
});

describe('what the viewer says about a model', () => {
  it('counts what it is made of', () => {
    expect(statsText({ meshes: 3, triangles: 12345, vertices: 9000, materials: 2, clips: 1, size: { x: 1, y: 1, z: 1 } })).toBe('12,345 triangles · 3 meshes · 2 materials · 1 animation');
    expect(statsText({ meshes: 1, triangles: 12, vertices: 8, materials: 0, clips: 0, size: { x: 1, y: 1, z: 1 } })).toBe('12 triangles · 1 mesh');
  });

  it('gives its size without trailing zeros', () => {
    expect(sizeText({ x: 1.2, y: 0.4, z: 3.1 })).toBe('1.2 × 0.4 × 3.1');
    expect(sizeText({ x: 2, y: 100, z: 12.25 })).toBe('2 × 100 × 12.3');
  });

  it('stands the camera back far enough for the narrower side of the view', () => {
    const square = cameraDistance(1, 40, 1);
    expect(square).toBeCloseTo((1 / Math.sin((20 * Math.PI) / 180)) * 1.08, 5);
    // A tall, narrow view needs more room than a wide one.
    expect(cameraDistance(1, 40, 0.5)).toBeGreaterThan(square);
    expect(cameraDistance(1, 40, 2)).toBeCloseTo(square, 5);
  });
});
