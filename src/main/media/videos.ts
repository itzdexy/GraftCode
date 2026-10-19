import { ProviderError } from '../providers/errors';
import { joinUrl, request, requestJson } from '../providers/http';

/**
 * Video models, through OpenRouter's video API with the user's own key: a job
 * is submitted, asked after until it is done, and its file downloaded. The key
 * is only ever sent to the address the provider is set up with.
 */

export interface VideoAccess {
  apiKey: string | null;
  /** The provider's base URL when the user set one; null for OpenRouter's own. */
  baseUrl: string | null;
}

export interface VideoModelInfo {
  id: string;
  name: string | null;
  description: string | null;
  created: number | null;
  /** Lengths in seconds it can make; empty when the provider doesn't say. */
  durations: number[];
  aspects: string[];
  resolutions: string[];
  /** first_frame, last_frame: the pictures it can start or end a clip on. */
  frames: string[];
  /** USD for a second of video at its cheapest setting, when the price is per second. */
  pricePerSecond: number | null;
}

export interface VideoRequest {
  model: string;
  prompt: string;
  /** Seconds; the nearest length the model makes is used. Null leaves it to the model. */
  seconds: number | null;
  /** 16:9, 9:16, 1:1…; one the model doesn't make falls back to its first. Null leaves it to the model. */
  aspect: string | null;
  /** A picture the clip starts on. */
  firstFrame: { mediaType: string; data: string } | null;
  /** Sound with the picture, for models that make it; null leaves it to the model. */
  audio: boolean | null;
}

export interface MadeVideo {
  data: Buffer;
  mediaType: string;
  model: string;
  costUsd: number | null;
}

export { DEFAULT_VIDEO_MODEL } from '@shared/media';

const OPENROUTER = 'https://openrouter.ai/api/v1';
const MODELS_TTL_MS = 60 * 60_000;
const DONE = new Set(['completed', 'failed', 'cancelled', 'expired']);

let cached: { at: number; base: string; models: VideoModelInfo[] } | null = null;

/** Forgets the cached list (tests). */
export function resetVideoModels(): void {
  cached = null;
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);
const text = (value: unknown, max: number): string | null => (typeof value === 'string' && value.trim().length > 0 ? value.trim().slice(0, max) : null);

/**
 * The cheapest per-second price among a model's price lines. Prices come as dollars ("duration_seconds_720p":
 * "0.1") or cents ("cents_per_second_output": "17"); lines priced per token or per picture aren't per second.
 */
export function pricePerSecond(skus: unknown): number | null {
  if (typeof skus !== 'object' || skus === null) return null;
  const prices = Object.entries(skus as Record<string, unknown>).flatMap(([key, raw]): number[] => {
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) return [];
    if (/^cents_per(_video_output)?_second/.test(key)) return [value / 100];
    if (/^(text_to_video_)?duration_seconds/.test(key)) return [value];
    return [];
  });
  return prices.length > 0 ? Math.min(...prices) : null;
}

export async function videoModels(access: VideoAccess, signal?: AbortSignal): Promise<VideoModelInfo[]> {
  const base = access.baseUrl ?? OPENROUTER;
  if (cached && cached.base === base && Date.now() - cached.at < MODELS_TTL_MS) return cached.models;
  const body = await requestJson<{ data?: Array<Record<string, unknown>> }>({
    url: joinUrl(base, 'videos/models'),
    headers: { accept: 'application/json', ...(access.apiKey ? { authorization: `Bearer ${access.apiKey}` } : {}) },
    ...(signal ? { signal } : {}),
    timeoutMs: 20_000
  });
  const models = (body.data ?? []).flatMap((m): VideoModelInfo[] => {
    if (typeof m.id !== 'string') return [];
    const durations = Array.isArray(m.supported_durations) ? m.supported_durations.filter((d): d is number => typeof d === 'number' && d > 0).sort((a, b) => a - b) : [];
    return [
      {
        id: m.id,
        name: text(m.name, 120),
        description: text(m.description, 400),
        created: typeof m.created === 'number' ? m.created : null,
        durations,
        aspects: strings(m.supported_aspect_ratios),
        resolutions: strings(m.supported_resolutions),
        frames: strings(m.supported_frame_images),
        pricePerSecond: pricePerSecond(m.pricing_skus)
      }
    ];
  });
  cached = { at: Date.now(), base, models };
  return models;
}

/** The length a model makes that is nearest the one asked for. */
export function nearestDuration(wanted: number, durations: number[]): number {
  return durations.reduce((best, d) => (Math.abs(d - wanted) < Math.abs(best - wanted) ? d : best), durations[0] ?? wanted);
}

/** An address the provider gave, on its own host only: the key goes nowhere else. */
function sameOrigin(raw: unknown, base: string): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const url = new URL(raw, base);
    return url.origin === new URL(base).origin ? url.toString() : null;
  } catch {
    return null;
  }
}

const wait = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ProviderError('aborted', 'Request cancelled.'));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new ProviderError('aborted', 'Request cancelled.'));
      },
      { once: true }
    );
  });

export interface VideoTimings {
  /** Between two asks after the job. */
  pollMs: number;
  /** The longest a clip may take. */
  timeoutMs: number;
}

/** One clip from a video model. Throws ProviderError with a message the user can act on. */
export async function generateVideo(
  access: VideoAccess & { apiKey: string },
  req: VideoRequest,
  signal?: AbortSignal,
  onProgress?: (text: string) => void,
  timings: VideoTimings = { pollMs: 5_000, timeoutMs: 20 * 60_000 }
): Promise<MadeVideo> {
  const base = access.baseUrl ?? OPENROUTER;
  const auth = { authorization: `Bearer ${access.apiKey}`, 'x-title': 'Graft' };
  // What the model makes: a length and a shape it accepts, so the request isn't refused for them.
  const info = (await videoModels(access, signal).catch(() => [])).find((m) => m.id === req.model) ?? null;
  const duration = req.seconds === null ? null : info && info.durations.length > 0 ? nearestDuration(req.seconds, info.durations) : Math.round(req.seconds);
  const aspect = req.aspect === null ? null : info && info.aspects.length > 0 && !info.aspects.includes(req.aspect) ? (info.aspects[0] ?? null) : req.aspect;
  const submitted = await requestJson<{ id?: unknown; polling_url?: unknown; status?: unknown }>({
    url: joinUrl(base, 'videos'),
    headers: auth,
    body: {
      model: req.model,
      prompt: req.prompt,
      ...(duration !== null ? { duration } : {}),
      ...(aspect !== null ? { aspect_ratio: aspect } : {}),
      ...(req.audio !== null ? { generate_audio: req.audio } : {}),
      ...(req.firstFrame
        ? { frame_images: [{ type: 'image_url', image_url: { url: `data:${req.firstFrame.mediaType};base64,${req.firstFrame.data}` }, frame_type: 'first_frame' }] }
        : {})
    },
    ...(signal ? { signal } : {}),
    timeoutMs: 120_000
  });
  const id = typeof submitted.id === 'string' ? submitted.id : null;
  if (!id) throw new ProviderError('bad_request', 'The video service didn’t start a job.', { retryable: false });
  const polling = sameOrigin(submitted.polling_url, base) ?? joinUrl(base, `videos/${encodeURIComponent(id)}`);

  const started = Date.now();
  let job: { status?: unknown; error?: unknown; unsigned_urls?: unknown; usage?: { cost?: unknown } } = submitted;
  while (!DONE.has(String(job.status))) {
    if (Date.now() - started > timings.timeoutMs) {
      throw new ProviderError('network', `The video wasn’t ready after ${String(Math.round(timings.timeoutMs / 60_000))} minutes.`, { retryable: false });
    }
    await wait(timings.pollMs, signal);
    job = await requestJson<typeof job>({ url: polling, headers: auth, ...(signal ? { signal } : {}), timeoutMs: 60_000 });
    onProgress?.(`${job.status === 'in_progress' ? 'Rendering' : 'Waiting in line'} · ${String(Math.round((Date.now() - started) / 1000))}s`);
  }
  if (job.status !== 'completed') {
    const why = typeof job.error === 'string' ? job.error : typeof job.error === 'object' && job.error !== null ? text((job.error as { message?: unknown }).message, 300) : null;
    throw new ProviderError('bad_request', `The video ${job.status === 'failed' ? 'failed' : `was ${String(job.status)}`}${why ? `: ${why}` : '.'}`, { retryable: false });
  }
  const content = sameOrigin(strings(job.unsigned_urls)[0], base) ?? `${joinUrl(base, `videos/${encodeURIComponent(id)}/content`)}?index=0`;
  const response = await request({ url: content, headers: auth, ...(signal ? { signal } : {}), timeoutMs: 120_000 });
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length === 0) throw new ProviderError('bad_request', 'The video service sent an empty file.', { retryable: false });
  const type = response.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
  const cost = Number(job.usage?.cost);
  return {
    data,
    mediaType: type.startsWith('video/') ? type : 'video/mp4',
    model: req.model,
    costUsd: job.usage?.cost !== undefined && Number.isFinite(cost) ? cost : null
  };
}
