import { describe, expect, it } from 'vitest';
import type { MediaModel, ProviderMediaModels } from '../../../src/shared/ipc/contracts';
import { DEFAULT_APP_SETTINGS } from '../../../src/shared/schemas/appSettings';
import {
  durationText,
  inUse,
  mediaSections,
  providerNote,
  secondPriceText,
  actionFor,
  patchFor
} from '../../../src/renderer/src/features/settings/mediaModels';

const model = (id: string, kind: MediaModel['kind'], extra: Partial<MediaModel> = {}): MediaModel => ({ id, name: id, kind, description: null, created: null, ...extra });

const LISTS: ProviderMediaModels[] = [
  {
    providerId: 'or',
    providerLabel: 'OpenRouter',
    providerKind: 'openrouter',
    error: null,
    models: [model('black-forest-labs/flux-3', 'image'), model('google/veo-3.1-lite', 'video'), model('elevenlabs/eleven-v4', 'speech', { voices: ['Rachel'] })]
  },
  { providerId: 'oa', providerLabel: 'OpenAI', providerKind: 'openai', error: null, models: [model('gpt-image-2', 'image'), model('sora-2', 'video')] },
  { providerId: 'gg', providerLabel: 'Google', providerKind: 'gemini', error: 'The key was refused.', models: [] },
  { providerId: 'lo', providerLabel: 'My server', providerKind: 'openai-compatible', error: 'Not found', models: [] }
];

describe('the media sections of the Models page', () => {
  it('has a section for each kind, with what each provider offers and the providers that couldn’t say', () => {
    const sections = mediaSections(LISTS, '');
    expect(sections.map((s) => [s.kind, s.count])).toEqual([
      ['image', 2],
      ['video', 2],
      ['speech', 1],
      ['audio', 0],
      ['transcription', 0]
    ]);
    const images = sections[0]!;
    expect(images.providers.map((p) => p.providerLabel)).toEqual(['OpenRouter', 'OpenAI', 'Google']);
    // A provider known for media says why it has none; another server's failed list isn't worth a line.
    expect(images.providers[2]?.error).toBe('The key was refused.');
  });

  it('narrows to what is typed, by name or id', () => {
    const sections = mediaSections(LISTS, 'veo');
    expect(sections.filter((s) => s.count > 0).map((s) => s.kind)).toEqual(['video']);
    expect(sections[1]?.providers.map((p) => p.models.map((m) => m.id))).toEqual([['google/veo-3.1-lite']]);
  });
});

describe('using a media model', () => {
  it('is offered where Graft can use the model, and explained where it can’t', () => {
    expect(actionFor('image', 'openai', model('gpt-image-2', 'image'))).toBe('images');
    expect(actionFor('video', 'openrouter', model('google/veo-3.1-lite', 'video'))).toBe('video');
    expect(actionFor('video', 'openai', model('sora-2', 'video'))).toBeNull();
    expect(providerNote('video', 'openai')).toMatch(/OpenRouter/);
    expect(actionFor('speech', 'openrouter', model('elevenlabs/eleven-v4', 'speech', { voices: ['Rachel'] }))).toBe('read-aloud');
    expect(actionFor('speech', 'openrouter', model('silent', 'speech', { voices: [] }))).toBeNull();
    expect(actionFor('transcription', 'openrouter', model('scribe', 'transcription'))).toBeNull();
    expect(providerNote('image', 'openrouter')).toBeNull();
  });

  it('sets the settings that make it the one in use', () => {
    const settings = structuredClone(DEFAULT_APP_SETTINGS);
    const flux = model('black-forest-labs/flux-3', 'image');
    expect(patchFor('images', 'openrouter', flux)).toEqual({ media: { imageEngine: 'openrouter', imageModel: 'black-forest-labs/flux-3' } });
    Object.assign(settings.media, patchFor('images', 'openrouter', flux).media);
    expect(inUse('image', 'openrouter', flux, settings)).toBe(true);
    expect(inUse('image', 'openai', flux, settings)).toBe(false);
    // With no video model chosen, the default is the one in use.
    expect(inUse('video', 'openrouter', model('google/veo-3.1-lite', 'video'), settings)).toBe(true);
    const voice = model('elevenlabs/eleven-v4', 'speech', { voices: ['Rachel', 'Adam'] });
    expect(patchFor('read-aloud', 'openrouter', voice)).toEqual({ voice: { engine: 'natural', model: 'elevenlabs/eleven-v4', voice: 'Rachel' } });
  });

  it('says a video model’s lengths and price in a few words', () => {
    expect(durationText([8, 4, 6])).toBe('4–8 s');
    expect(durationText([5, 10])).toBe('5 or 10 s');
    expect(durationText([6])).toBe('6 s');
    expect(durationText(undefined)).toBeNull();
    expect(secondPriceText(0.05)).toBe('from $0.05 a second');
    expect(secondPriceText(0.112)).toBe('from $0.11 a second');
    expect(secondPriceText(null)).toBeNull();
  });
});
