import type { MediaModel, MediaModelKind, ProviderMediaModels } from '@shared/ipc/contracts';
import { DEFAULT_VIDEO_MODEL } from '@shared/media';
import type { AppSettings, AppSettingsPatch } from '@shared/schemas/appSettings';
import { fuzzyScore } from '@shared/fuzzy';

/**
 * Settings → Models, below the text models: the image, video, voice, music
 * and transcription models of the providers that are set up, a section for
 * each kind, and which of them Graft can use and uses now. Pure, so it is
 * unit-tested without a DOM.
 */

export interface MediaSectionInfo {
  kind: MediaModelKind;
  title: string;
  /** What Graft does with this kind. */
  description: string;
}

export const MEDIA_SECTIONS: readonly MediaSectionInfo[] = [
  { kind: 'image', title: 'Image models', description: 'Pictures the agent makes with GenerateImage when you ask: art for a site, sprites and textures, icons, concept art.' },
  { kind: 'video', title: 'Video models', description: 'Clips the agent makes with GenerateVideo, through OpenRouter: a trailer shot, a cutscene, an animated background. Each second is billed.' },
  { kind: 'speech', title: 'Voices', description: 'Speech models. Read aloud speaks chat replies with OpenRouter’s.' },
  { kind: 'audio', title: 'Music and sound', description: 'Models that answer in sound: music, sound effects, spoken replies. Listed for reference; Graft doesn’t call them yet.' },
  { kind: 'transcription', title: 'Transcription', description: 'Models that turn speech into text. Listed for reference; Graft doesn’t call them yet.' }
];

/** Image engines Graft can generate with (Settings → Images). */
const IMAGE_ENGINES = new Set(['openrouter', 'openai', 'gemini']);

/** What "Use" does for a model of this kind from this provider, or null when Graft can't use it. */
export function actionFor(kind: MediaModelKind, providerKind: string, model: MediaModel): 'images' | 'video' | 'read-aloud' | null {
  if (kind === 'image' && IMAGE_ENGINES.has(providerKind)) return 'images';
  if (kind === 'video' && providerKind === 'openrouter') return 'video';
  if (kind === 'speech' && providerKind === 'openrouter' && (model.voices?.length ?? 0) > 0) return 'read-aloud';
  return null;
}

/** Why a provider's models of a kind have no Use, where Graft uses that kind through another provider. */
export function providerNote(kind: MediaModelKind, providerKind: string): string | null {
  if (kind === 'image' && !IMAGE_ENGINES.has(providerKind)) return 'Graft makes pictures through OpenRouter, OpenAI or Google.';
  if (kind === 'video' && providerKind !== 'openrouter') return 'Graft makes video through OpenRouter for now.';
  if (kind === 'speech' && providerKind !== 'openrouter') return 'Read aloud speaks with OpenRouter’s voices.';
  return null;
}

/** Whether a model is the one Graft uses now for its kind. */
export function inUse(kind: MediaModelKind, providerKind: string, model: MediaModel, settings: Pick<AppSettings, 'media' | 'voice'>): boolean {
  if (kind === 'image') return settings.media.imageEngine === providerKind && settings.media.imageModel.trim() === model.id;
  if (kind === 'video') return providerKind === 'openrouter' && (settings.media.videoModel.trim() || DEFAULT_VIDEO_MODEL) === model.id;
  if (kind === 'speech') return providerKind === 'openrouter' && settings.voice.engine === 'natural' && settings.voice.model === model.id;
  return false;
}

/** The settings that make a model the one Graft uses for its kind. */
export function patchFor(use: 'images' | 'video' | 'read-aloud', providerKind: string, model: MediaModel): AppSettingsPatch {
  if (use === 'images') return { media: { imageEngine: providerKind as AppSettings['media']['imageEngine'], imageModel: model.id } };
  if (use === 'video') return { media: { videoModel: model.id } };
  // A speech model is only offered with its voices, so it has a first one.
  return { voice: { engine: 'natural', model: model.id, voice: model.voices?.[0] ?? model.id } };
}

export interface ProviderGroup {
  providerId: string;
  providerLabel: string;
  providerKind: string;
  models: MediaModel[];
  /** Why the provider's list couldn't be read, for the providers known to have media models. */
  error: string | null;
}

export interface MediaSection extends MediaSectionInfo {
  providers: ProviderGroup[];
  count: number;
}

/** Providers known to offer media models; a list another provider couldn't give is not worth a line. */
const MEDIA_PROVIDERS = new Set(['openrouter', 'openai', 'gemini']);

/** The sections with what each provider offers, narrowed to what is typed (name or id), best matches first. */
export function mediaSections(lists: readonly ProviderMediaModels[], query: string): MediaSection[] {
  const typed = query.trim();
  return MEDIA_SECTIONS.map((section): MediaSection => {
    const providers = lists.flatMap((list): ProviderGroup[] => {
      let models = list.models.filter((m) => m.kind === section.kind);
      if (typed.length > 0) {
        models = models
          .map((m) => ({ m, score: Math.max(fuzzyScore(typed, m.name) ?? -Infinity, fuzzyScore(typed, m.id) ?? -Infinity) }))
          .filter((x) => x.score > -Infinity)
          .sort((a, b) => b.score - a.score)
          .map((x) => x.m);
      }
      const error = section.kind === 'image' && list.error && MEDIA_PROVIDERS.has(list.providerKind) ? list.error : null;
      if (models.length === 0 && !error) return [];
      return [{ providerId: list.providerId, providerLabel: list.providerLabel, providerKind: list.providerKind, models, error }];
    });
    return { ...section, providers, count: providers.reduce((n, p) => n + p.models.length, 0) };
  });
}

/** The lengths a video model makes, in a few words: "4–8 s", "5 or 10 s". */
export function durationText(durations: readonly number[] | undefined): string | null {
  if (!durations || durations.length === 0) return null;
  const sorted = [...new Set(durations)].sort((a, b) => a - b);
  if (sorted.length === 1) return `${String(sorted[0])} s`;
  if (sorted.length === 2) return `${String(sorted[0])} or ${String(sorted[1])} s`;
  return `${String(sorted[0])}–${String(sorted.at(-1))} s`;
}

/** What a second of video costs at the cheapest setting: "$0.05 a second". */
export function secondPriceText(price: number | null | undefined): string | null {
  if (price === null || price === undefined) return null;
  return `from $${price < 0.1 ? price.toFixed(3).replace(/0$/, '') : price.toFixed(2)} a second`;
}
