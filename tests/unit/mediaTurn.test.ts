import { describe, expect, it } from 'vitest';
import { mediaTurnKind } from '../../src/main/agent/loop';
import { nvidiaImage } from '../../src/main/media/images';

describe('a session whose model makes pictures or clips', () => {
  it('knows image and video models by their id, and leaves chat models alone', () => {
    expect(mediaTurnKind('https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux-3-image-klein')).toBe('image');
    expect(mediaTurnKind('black-forest-labs/flux.1-schnell')).toBe('image');
    expect(mediaTurnKind('google/veo-3.1-fast')).toBe('video');
    expect(mediaTurnKind('meta/llama-3.3-70b-instruct')).toBeNull();
    expect(mediaTurnKind('nvidia/nemotron-3.5-super-vl-120b-a12b')).toBeNull();
  });

  it("reads NVIDIA's picture from artifacts or an image data URL", () => {
    expect(nvidiaImage({ artifacts: [{ base64: 'iVBORw0', finishReason: 'SUCCESS' }] })).toEqual({ data: 'iVBORw0', mediaType: 'image/png' });
    expect(nvidiaImage({ image: 'data:image/jpeg;base64,/9j/abc' })).toEqual({ data: '/9j/abc', mediaType: 'image/jpeg' });
    expect(nvidiaImage({ nothing: true })).toBeNull();
  });
});
