import type { ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mediaKindOf, mediaModelsOf } from '../../src/main/media/mediaModels';
import { generateVideo, nearestDuration, pricePerSecond, resetVideoModels } from '../../src/main/media/videos';
import { startFixtureServer, type FixtureServer } from '../support/httpFixture';

const json = (res: ServerResponse, body: unknown, status = 200): void => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

let server: FixtureServer;
beforeEach(async () => {
  server = await startFixtureServer();
  resetVideoModels();
});
afterEach(async () => {
  await server.close();
});

describe('what a model makes, by its name on an OpenAI-compatible server', () => {
  it('knows the well-known picture, video, voice, transcription and music models', () => {
    expect(mediaKindOf('black-forest-labs/FLUX.1-schnell')).toBe('image');
    expect(mediaKindOf('stabilityai/sdxl-turbo')).toBe('image');
    expect(mediaKindOf('Qwen/Qwen-Image')).toBe('image');
    expect(mediaKindOf('Wan-AI/Wan2.2-T2V-A14B')).toBe('video');
    expect(mediaKindOf('google/veo-3.1')).toBe('video');
    expect(mediaKindOf('hexgrad/Kokoro-82M')).toBe('speech');
    expect(mediaKindOf('openai/gpt-4o-mini-tts')).toBe('speech');
    expect(mediaKindOf('whisper-large-v3-turbo')).toBe('transcription');
    expect(mediaKindOf('nvidia/parakeet-tdt-0.6b-v2')).toBe('transcription');
    expect(mediaKindOf('facebook/musicgen-large')).toBe('audio');
  });

  it('leaves a model it doesn’t recognize a text model', () => {
    for (const id of ['llama-3.3-70b-versatile', 'qwen2.5-coder-32b-instruct', 'Qwen/Qwen2-VL-72B-Instruct', 'deepseek-r1', 'mistral-large-latest', 'nvidia/llama-3.1-nemotron-70b', 'gemma-3-27b-it', 'kimi-k2']) {
      expect(mediaKindOf(id)).toBeNull();
    }
  });
});

describe('the media models of a provider', () => {
  it('reads OpenRouter’s by kind, with what its video models can do and cost', async () => {
    server.route('GET', '/api/v1/models', (req, res) => {
      const kind = new URL(req.path, 'http://x').searchParams.get('output_modalities');
      const byKind: Record<string, unknown[]> = {
        image: [{ id: 'black-forest-labs/flux-3-image-klein', name: 'Black Forest Labs: FLUX 3 Image Klein', description: 'Pictures.', created: 20 }],
        speech: [{ id: 'elevenlabs/eleven-v4', name: 'ElevenLabs: Eleven v4', created: 10, supported_voices: ['Rachel', 'Adam'] }],
        audio: [],
        transcription: [{ id: 'elevenlabs/scribe-v2', name: 'ElevenLabs: Scribe v2' }]
      };
      json(res, { data: byKind[kind ?? ''] ?? [] });
    });
    server.route('GET', '/api/v1/videos/models', (_req, res) =>
      json(res, {
        data: [
          {
            id: 'google/veo-3.1-lite',
            name: 'Google: Veo 3.1 Lite',
            created: 30,
            supported_durations: [8, 4, 6],
            supported_aspect_ratios: ['16:9', '9:16'],
            supported_frame_images: ['first_frame', 'last_frame'],
            pricing_skus: { duration_seconds_with_audio: '0.08', duration_seconds_without_audio: '0.05' }
          }
        ]
      })
    );
    const models = await mediaModelsOf({ kind: 'openrouter', baseUrl: `${server.url}/api/v1`, apiKey: 'sk-or-test' });
    expect(models.map((m) => [m.kind, m.id, m.name])).toEqual([
      ['video', 'google/veo-3.1-lite', 'Veo 3.1 Lite'],
      ['image', 'black-forest-labs/flux-3-image-klein', 'FLUX 3 Image Klein'],
      ['speech', 'elevenlabs/eleven-v4', 'Eleven v4'],
      ['transcription', 'elevenlabs/scribe-v2', 'Scribe v2']
    ]);
    expect(models[0]).toMatchObject({ durations: [4, 6, 8], aspects: ['16:9', '9:16'], firstFrame: true, pricePerSecond: 0.05 });
    expect(models[2]?.voices).toEqual(['Rachel', 'Adam']);
    // OpenRouter's lists are public: the key isn't sent for them.
    expect(server.requests.every((r) => r.headers.authorization === undefined)).toBe(true);
  });

  it('reads OpenAI’s and Google’s from their model lists, by name', async () => {
    server.route('GET', '/v1/models', (_req, res) =>
      json(res, { data: ['gpt-5', 'gpt-image-1', 'sora-2', 'gpt-4o-mini-tts', 'whisper-1', 'gpt-4o-transcribe', 'gpt-audio', 'text-embedding-3-small'].map((id) => ({ id })) })
    );
    const openai = await mediaModelsOf({ kind: 'openai', baseUrl: `${server.url}/v1`, apiKey: 'sk-test' });
    expect(openai.map((m) => `${m.kind}:${m.id}`).sort()).toEqual(
      ['audio:gpt-audio', 'image:gpt-image-1', 'speech:gpt-4o-mini-tts', 'transcription:gpt-4o-transcribe', 'transcription:whisper-1', 'video:sora-2'].sort()
    );
    expect(server.requests.at(-1)?.headers.authorization).toBe('Bearer sk-test');

    server.route('GET', '/v1beta/models', (_req, res) =>
      json(res, {
        models: [
          { name: 'models/gemini-3-pro', displayName: 'Gemini 3 Pro' },
          { name: 'models/imagen-4.0-generate-001', displayName: 'Imagen 4' },
          { name: 'models/gemini-3.1-flash-image', displayName: 'Nano Banana' },
          { name: 'models/veo-3.1-generate-preview', displayName: 'Veo 3.1' },
          { name: 'models/gemini-2.5-flash-preview-tts', displayName: 'Gemini 2.5 Flash TTS' },
          { name: 'models/lyria-3-pro', displayName: 'Lyria 3 Pro' }
        ]
      })
    );
    const google = await mediaModelsOf({ kind: 'gemini', baseUrl: `${server.url}/v1beta`, apiKey: 'AIza-test' });
    expect(google.map((m) => `${m.kind}:${m.name}`)).toEqual(['image:Imagen 4', 'image:Nano Banana', 'video:Veo 3.1', 'speech:Gemini 2.5 Flash TTS', 'audio:Lyria 3 Pro']);
    expect(server.requests.at(-1)?.headers['x-goog-api-key']).toBe('AIza-test');
  });
});

describe('a clip from a video model', () => {
  it('reads a price per second whether it is said in dollars or cents, and nothing priced otherwise', () => {
    expect(pricePerSecond({ duration_seconds_720p: '0.1', duration_seconds_480p: '0.05' })).toBe(0.05);
    expect(pricePerSecond({ cents_per_second_output: '17', cents_per_second_output_2k: '28' })).toBe(0.17);
    expect(pricePerSecond({ video_tokens: '0.0000042' })).toBeNull();
    expect(pricePerSecond(null)).toBeNull();
  });

  it('asks for the length the model makes that is nearest the one wanted', () => {
    expect(nearestDuration(5, [4, 6, 8])).toBe(4);
    expect(nearestDuration(7, [4, 6, 8])).toBe(6);
    expect(nearestDuration(30, [4, 6, 8])).toBe(8);
  });

  it('is submitted, asked after until done, and downloaded, the key going to the provider’s own address only', async () => {
    let polls = 0;
    server.route('GET', '/api/v1/videos/models', (_req, res) =>
      json(res, { data: [{ id: 'google/veo-3.1-lite', supported_durations: [4, 6, 8], supported_aspect_ratios: ['16:9', '9:16'] }] })
    );
    server.route('POST', '/api/v1/videos', (_req, res) => json(res, { id: 'job-1', polling_url: '/api/v1/videos/job-1', status: 'pending' }, 202));
    server.route('GET', '/api/v1/videos/job-1', (_req, res) => {
      polls += 1;
      json(res, polls < 2 ? { id: 'job-1', status: 'in_progress' } : { id: 'job-1', status: 'completed', unsigned_urls: ['https://elsewhere.example/clip.mp4'], usage: { cost: 0.4 } });
    });
    server.route('GET', '/api/v1/videos/job-1/content', (_req, res) => {
      res.writeHead(200, { 'content-type': 'video/mp4' });
      res.end(Buffer.from('mp4-bytes'));
    });
    const progress: string[] = [];
    const made = await generateVideo(
      { apiKey: 'sk-or-test', baseUrl: `${server.url}/api/v1` },
      { model: 'google/veo-3.1-lite', prompt: 'a sprout grows', seconds: 5, aspect: '1:1', firstFrame: { mediaType: 'image/png', data: 'AAAA' }, audio: false },
      undefined,
      (text) => progress.push(text),
      { pollMs: 5, timeoutMs: 10_000 }
    );
    expect(made).toEqual({ data: Buffer.from('mp4-bytes'), mediaType: 'video/mp4', model: 'google/veo-3.1-lite', costUsd: 0.4 });
    const submitted = server.requests.find((r) => r.method === 'POST')?.json();
    // 5 seconds is asked as the model's nearest length, and a shape it doesn't make as its first.
    expect(submitted).toMatchObject({
      model: 'google/veo-3.1-lite',
      prompt: 'a sprout grows',
      duration: 4,
      aspect_ratio: '16:9',
      generate_audio: false,
      frame_images: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' }, frame_type: 'first_frame' }]
    });
    // The download address on another host was not used: the content came from the provider's own.
    expect(server.requests.some((r) => r.path === '/api/v1/videos/job-1/content?index=0')).toBe(true);
    expect(server.requests.filter((r) => r.path.startsWith('/api/v1/videos/job-1')).every((r) => r.headers.authorization === 'Bearer sk-or-test')).toBe(true);
    expect(progress.length).toBeGreaterThan(0);
  });

  it('says why when the job fails', async () => {
    server.route('GET', '/api/v1/videos/models', (_req, res) => json(res, { data: [] }));
    server.route('POST', '/api/v1/videos', (_req, res) => json(res, { id: 'job-2', polling_url: `${server.url}/api/v1/videos/job-2`, status: 'pending' }, 202));
    server.route('GET', '/api/v1/videos/job-2', (_req, res) => json(res, { id: 'job-2', status: 'failed', error: 'Content policy: the prompt was refused.' }));
    await expect(
      generateVideo({ apiKey: 'k', baseUrl: `${server.url}/api/v1` }, { model: 'm', prompt: 'p', seconds: null, aspect: null, firstFrame: null, audio: null }, undefined, undefined, {
        pollMs: 5,
        timeoutMs: 10_000
      })
    ).rejects.toThrow('The video failed: Content policy: the prompt was refused.');
  });
});
