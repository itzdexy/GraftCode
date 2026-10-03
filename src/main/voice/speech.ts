import { ProviderError } from '../providers/errors';
import { joinUrl, request, requestJson } from '../providers/http';

/**
 * Natural voices for "Read aloud": OpenRouter's speech models, called with
 * the user's OpenRouter key from the main process (the key never reaches
 * the renderer, which only gets the audio). The list of speech models is
 * public and cached for a day.
 */
export interface SpeechModel {
  id: string;
  name: string;
  voices: string[];
  /** USD per 1,000 characters of text, when known. */
  pricePer1kChars: number | null;
  /** Also bills the audio it makes (priced per output token or second). */
  billsOutput: boolean;
}

export interface SpeechAccess {
  apiKey: string;
  /** The provider's base URL when the user set one; null for OpenRouter's own. */
  baseUrl: string | null;
}

const OPENROUTER = 'https://openrouter.ai/api/v1';
const MODELS_TTL_MS = 24 * 60 * 60 * 1000;

let cached: { at: number; endpoint: string; models: SpeechModel[] } | null = null;

export async function speechModels(signal?: AbortSignal, endpoint = OPENROUTER): Promise<SpeechModel[]> {
  if (cached && cached.endpoint === endpoint && Date.now() - cached.at < MODELS_TTL_MS) return cached.models;
  const body = await requestJson<{
    data?: Array<{ id?: unknown; name?: unknown; supported_voices?: unknown; pricing?: { prompt?: unknown; completion?: unknown } }>;
  }>({ url: `${joinUrl(endpoint, 'models')}?output_modalities=speech`, headers: { accept: 'application/json' }, ...(signal ? { signal } : {}), timeoutMs: 20_000 });
  const models = (body.data ?? []).flatMap((m): SpeechModel[] => {
    const voices = Array.isArray(m.supported_voices) ? m.supported_voices.filter((v): v is string => typeof v === 'string' && v.length <= 200).slice(0, 300) : [];
    // A voice has to be named in every request, so models without a voice list can't be offered.
    if (typeof m.id !== 'string' || voices.length === 0) return [];
    const input = Number(m.pricing?.prompt);
    const output = Number(m.pricing?.completion);
    return [
      {
        id: m.id,
        name: typeof m.name === 'string' && m.name.trim() ? m.name.trim() : m.id,
        voices,
        pricePer1kChars: Number.isFinite(input) ? input * 1000 : null,
        billsOutput: Number.isFinite(output) && output > 0
      }
    ];
  });
  cached = { at: Date.now(), endpoint, models };
  return models;
}

/** Speech for a piece of text, as MP3. */
export async function synthesize(access: SpeechAccess, input: { text: string; model: string; voice: string; speed: number }, signal?: AbortSignal): Promise<Buffer> {
  const response = await request({
    url: joinUrl(access.baseUrl ?? OPENROUTER, 'audio/speech'),
    headers: { authorization: `Bearer ${access.apiKey}`, 'x-title': 'Graft', accept: 'audio/mpeg' },
    body: { model: input.model, input: input.text, voice: input.voice, response_format: 'mp3', speed: input.speed },
    ...(signal ? { signal } : {}),
    timeoutMs: 60_000
  });
  const audio = Buffer.from(await response.arrayBuffer());
  if (audio.length === 0) throw new ProviderError('bad_request', 'The voice service sent no audio.', { retryable: false });
  return audio;
}
