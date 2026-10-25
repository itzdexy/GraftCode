import type { MediaModel, MediaModelKind } from '@shared/ipc/contracts';
import { labelFromId } from '../providers/catalog';
import type { CatalogModel } from '../providers/presets';
import { joinUrl, requestJson } from '../providers/http';
import { videoModels } from './videos';

/**
 * The image, video, voice, music and transcription models a provider offers,
 * for Settings → Models. The text models are the registry's; these are the
 * ones its lists leave out. OpenRouter says which kind each model is; OpenAI's
 * and Google's are known by their names, and so are the well-known ones on
 * other OpenAI-compatible servers. Keys stay in the main process.
 */

export type MediaSourceKind = 'openrouter' | 'openai' | 'gemini' | 'openai-compatible';

export interface MediaSource {
  kind: MediaSourceKind;
  /** The provider's base URL; null for the vendor's own. */
  baseUrl: string | null;
  apiKey: string | null;
}

const BASE: Record<Exclude<MediaSourceKind, 'openai-compatible'>, string> = {
  openrouter: 'https://openrouter.ai/api/v1',
  openai: 'https://api.openai.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta'
};

/** OpenAI's model names, by kind; the first that matches wins (gpt-4o-mini-tts speaks, gpt-4o-transcribe listens). */
const OPENAI_KINDS: ReadonlyArray<readonly [MediaModelKind, RegExp]> = [
  ['image', /^(gpt-image|chatgpt-image|dall-e)/i],
  ['video', /^sora/i],
  ['speech', /tts/i],
  ['transcription', /(whisper|transcribe)/i],
  ['audio', /(audio|realtime)/i]
];

/** Google's: Veo makes video, Imagen and the image Geminis pictures, the TTS Geminis speech, Lyria music. */
const GEMINI_KINDS: ReadonlyArray<readonly [MediaModelKind, RegExp]> = [
  ['video', /veo/i],
  ['image', /(imagen|image)/i],
  ['speech', /tts/i],
  ['audio', /(lyria|native-audio)/i]
];

/**
 * Well-known media models on other OpenAI-compatible servers (Together, Fireworks, DeepInfra, xAI, Groq, a
 * local server…), by name. Only names that can't be a chat model's: a model that isn't recognized stays a text
 * model, which is what it most likely is.
 */
export const COMPATIBLE_KINDS: ReadonlyArray<readonly [MediaModelKind, RegExp]> = [
  ['video', /(^|[/_-])(veo|sora|kling|seedance|hailuo|runway|pika|mochi|cogvideox?|ltx-?video|ltxv|hunyuan-?video|wan-?2\.\d|wan-?3|grok-imagine-video)([/._-]|$)|text-to-video|image-to-video|(^|[/_-])[ti]2v([/._-]|$)/i],
  ['image', /(^|[/_-])(flux|stable-diffusion|sdxl|sd3(\.\d)?|imagen|dall-e|gpt-image|seedream|recraft|ideogram|kolors|hidream|playground-v\d|qwen-image|z-image|grok-2-image|grok-imagine-image)([/._-]|$)|text-to-image/i],
  ['speech', /(^|[/_-])(tts|kokoro|orpheus|xtts|f5-tts|parler-tts|playai-tts|sesame|dia)([/._-]|$)|-tts([/._-]|$)|text-to-speech/i],
  ['transcription', /(^|[/_-])(whisper|parakeet|canary)|transcri|speech-to-text/i],
  ['audio', /(^|[/_-])(musicgen|lyria|stable-audio|ace-step|audioldm)([/._-]|$)/i]
];

/** The kind of media a model makes, by its name, or null for a text model. */
export function mediaKindOf(id: string, rules: ReadonlyArray<readonly [MediaModelKind, RegExp]> = COMPATIBLE_KINDS): MediaModelKind | null {
  return rules.find(([, pattern]) => pattern.test(id))?.[0] ?? null;
}

const text = (value: unknown, max: number): string | null => (typeof value === 'string' && value.trim().length > 0 ? value.trim().slice(0, max) : null);
const seconds = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : null);

/** A model OpenRouter names "Lab: Model"; the lab is said by the section it is in, so the name is its second half. */
function shortName(name: string | null, id: string): string {
  if (!name) return labelFromId(id);
  const cut = name.indexOf(': ');
  return cut > 0 && cut < name.length - 2 ? name.slice(cut + 2) : name;
}

type OpenRouterModel = { id?: unknown; name?: unknown; description?: unknown; created?: unknown; supported_voices?: unknown };

async function openRouter(base: string, signal?: AbortSignal): Promise<MediaModel[]> {
  const kinds: Array<[MediaModelKind, string]> = [
    ['image', 'image'],
    ['speech', 'speech'],
    ['audio', 'audio'],
    ['transcription', 'transcription']
  ];
  const lists = await Promise.all(
    kinds.map(async ([kind, modality]) => {
      const body = await requestJson<{ data?: OpenRouterModel[] }>({
        url: `${joinUrl(base, 'models')}?output_modalities=${modality}`,
        headers: { accept: 'application/json' },
        ...(signal ? { signal } : {}),
        timeoutMs: 20_000
      });
      return (body.data ?? []).flatMap((m): MediaModel[] => {
        if (typeof m.id !== 'string') return [];
        const voices = Array.isArray(m.supported_voices) ? m.supported_voices.filter((v): v is string => typeof v === 'string').slice(0, 300) : [];
        return [
          {
            id: m.id,
            name: shortName(text(m.name, 120), m.id),
            kind,
            description: text(m.description, 400),
            created: seconds(m.created),
            ...(kind === 'speech' ? { voices } : {})
          }
        ];
      });
    })
  );
  // Video models say more on their own list: the lengths, shapes and first frames they take, and what a second costs.
  const videos = (await videoModels({ apiKey: null, baseUrl: base }, signal)).map(
    (v): MediaModel => ({
      id: v.id,
      name: shortName(v.name, v.id),
      kind: 'video',
      description: v.description,
      created: v.created,
      durations: v.durations,
      aspects: v.aspects,
      firstFrame: v.frames.includes('first_frame'),
      pricePerSecond: v.pricePerSecond
    })
  );
  return [...lists.flat(), ...videos];
}

async function listedIds(base: string, apiKey: string | null, signal?: AbortSignal): Promise<string[]> {
  const body = await requestJson<{ data?: Array<{ id?: unknown }> }>({
    url: joinUrl(base, 'models'),
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
    ...(signal ? { signal } : {}),
    timeoutMs: 20_000
  });
  return (body.data ?? []).flatMap((m) => (typeof m.id === 'string' ? [m.id] : []));
}

function byName(ids: string[], rules: ReadonlyArray<readonly [MediaModelKind, RegExp]>): MediaModel[] {
  return ids.flatMap((id): MediaModel[] => {
    const kind = mediaKindOf(id, rules);
    return kind ? [{ id, name: labelFromId(id), kind, description: null, created: null }] : [];
  });
}

async function gemini(base: string, apiKey: string, signal?: AbortSignal): Promise<MediaModel[]> {
  type Model = { name?: unknown; displayName?: unknown; description?: unknown };
  const all: Model[] = [];
  let pageToken: string | undefined;
  do {
    const page = await requestJson<{ models?: Model[]; nextPageToken?: string }>({
      url: joinUrl(base, `models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`),
      headers: { 'x-goog-api-key': apiKey },
      ...(signal ? { signal } : {}),
      timeoutMs: 20_000
    });
    all.push(...(page.models ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return all.flatMap((m): MediaModel[] => {
    if (typeof m.name !== 'string') return [];
    const id = m.name.replace(/^models\//, '');
    const kind = mediaKindOf(id, GEMINI_KINDS);
    return kind ? [{ id, name: text(m.displayName, 120) ?? labelFromId(id), kind, description: text(m.description, 400), created: null }] : [];
  });
}

/**
 * The media models the catalog (models.dev) knows a provider offers, for the ones its own list leaves out:
 * NVIDIA's /v1/models, for one, lists none of its image, speech or video models. A model that writes text and
 * speaks (an omni chat model) stays a text model.
 */
export function catalogMediaModels(models: CatalogModel[]): MediaModel[] {
  return models.flatMap((m): MediaModel[] => {
    if (m.missing || m.outputs.length === 0) return [];
    const speaks = m.outputs.includes('audio') && !m.outputs.includes('image') && !m.outputs.includes('video');
    if (speaks && m.capabilities.tools === true) return [];
    const kind: MediaModelKind = m.outputs.includes('video') ? 'video' : m.outputs.includes('image') ? 'image'
      : (mediaKindOf(m.id) ?? (/(tts|voice|speech)/i.test(m.id) ? 'speech' : 'audio'));
    return [{ id: m.id, name: m.name, kind, description: null, created: m.releasedAt === null ? null : Math.round(m.releasedAt / 1000) }];
  });
}

/** The media models one provider offers, newest first within each kind where it says when they came out. */
export async function mediaModelsOf(source: MediaSource, signal?: AbortSignal): Promise<MediaModel[]> {
  let models: MediaModel[];
  switch (source.kind) {
    case 'openrouter':
      models = await openRouter(source.baseUrl ?? BASE.openrouter, signal);
      break;
    case 'openai':
      models = byName(await listedIds(source.baseUrl ?? BASE.openai, source.apiKey, signal), OPENAI_KINDS);
      break;
    case 'gemini':
      models = source.apiKey ? await gemini(source.baseUrl ?? BASE.gemini, source.apiKey, signal) : [];
      break;
    case 'openai-compatible':
      models = source.baseUrl ? byName(await listedIds(source.baseUrl, source.apiKey, signal), COMPATIBLE_KINDS) : [];
      break;
  }
  return models.sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
}
