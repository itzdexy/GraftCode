import { ProviderError } from '../providers/errors';
import { joinUrl, requestJson } from '../providers/http';

/**
 * Image models, called with the user's own provider keys from the main
 * process. Three wire formats cover them: OpenRouter's images endpoint (one
 * key for GPT Image, Gemini, FLUX, Recraft, Seedream and more), OpenAI's
 * images endpoint, Gemini's interactions endpoint, and NVIDIA's genai endpoint
 * (FLUX, Stable Diffusion, SANA and Qwen-Image on build.nvidia.com).
 */
export type ImageProviderKind = 'openrouter' | 'openai' | 'gemini' | 'nvidia';

/** The shape of the picture, in words a model picks reliably; each engine maps it to what it accepts. */
export const IMAGE_ASPECTS = ['square', 'landscape', 'portrait', 'wide', 'tall'] as const;
export type ImageAspect = (typeof IMAGE_ASPECTS)[number];

export interface ImageAccess {
  kind: ImageProviderKind;
  apiKey: string;
  /** The provider's base URL when the user set one; null for the vendor's own. */
  baseUrl: string | null;
}

export interface ImageRequest {
  prompt: string;
  model: string;
  aspect: ImageAspect;
  transparent: boolean;
}

export interface GeneratedImage {
  data: Buffer;
  mediaType: string;
  /** What the provider charged, when it says (OpenRouter does). */
  costUsd: number | null;
}

const BASE: Record<ImageProviderKind, string> = {
  openrouter: 'https://openrouter.ai/api/v1',
  openai: 'https://api.openai.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
  nvidia: 'https://ai.api.nvidia.com/v1/genai'
};

/** Used when Settings → Images names no model. */
export const DEFAULT_IMAGE_MODEL: Record<ImageProviderKind, string> = {
  openrouter: 'google/gemini-3.1-flash-image',
  openai: 'gpt-image-2',
  gemini: 'gemini-3.1-flash-image',
  nvidia: 'black-forest-labs/flux.1-schnell'
};

const RATIO: Record<ImageAspect, string> = { square: '1:1', landscape: '3:2', portrait: '2:3', wide: '16:9', tall: '9:16' };
const OPENAI_SIZE: Record<ImageAspect, string> = { square: '1024x1024', landscape: '1536x1024', wide: '1536x1024', portrait: '1024x1536', tall: '1024x1536' };
/** Sizes NVIDIA's FLUX and SD models take (multiples of 64, about a megapixel). */
const NVIDIA_SIZE: Record<ImageAspect, [number, number]> = { square: [1024, 1024], landscape: [1216, 832], portrait: [832, 1216], wide: [1344, 768], tall: [768, 1344] };
/** A picture can take a couple of minutes before the first byte of the answer. */
const TIMEOUT_MS = 240_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The first picture in a provider's answer, wherever it sits: providers nest
 * it differently (output_image, an outputs list, inlineData in parts) and
 * rename the fields between API versions, so this looks for base64 data that
 * is labelled as an image rather than for one fixed path.
 */
export function extractImage(body: unknown, depth = 0): { data: string; mediaType: string } | null {
  if (depth > 8) return null;
  if (Array.isArray(body)) {
    for (const item of body) {
      const found = extractImage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (!isRecord(body)) return null;
  const data = body.data ?? body.b64_json;
  const type = body.mime_type ?? body.mimeType ?? body.media_type;
  if (typeof data === 'string' && data.length > 0 && typeof type === 'string' && type.startsWith('image/')) return { data, mediaType: type };
  for (const value of Object.values(body)) {
    const found = extractImage(value, depth + 1);
    if (found) return found;
  }
  return null;
}

function decoded(image: { data: string; mediaType: string } | null, costUsd: number | null): GeneratedImage {
  const data = image ? Buffer.from(image.data, 'base64') : Buffer.alloc(0);
  if (!image || data.length === 0) throw new ProviderError('bad_request', 'The model answered with no image. Try a different prompt or image model.', { retryable: false });
  return { data, mediaType: image.mediaType, costUsd };
}

/** Models take "transparent background" as a property of the picture; only OpenAI has a switch for it. */
function promptFor(req: ImageRequest): string {
  return req.transparent ? `${req.prompt}\n\nTransparent background.` : req.prompt;
}

async function openRouter(access: ImageAccess, req: ImageRequest, signal?: AbortSignal): Promise<GeneratedImage> {
  type Answer = { data?: Array<{ b64_json?: unknown; media_type?: unknown }>; usage?: { cost?: unknown } };
  const send = (shaped: boolean): Promise<Answer> =>
    requestJson<Answer>({
      url: joinUrl(access.baseUrl ?? BASE.openrouter, 'images'),
      headers: { authorization: `Bearer ${access.apiKey}`, 'x-title': 'Graft' },
      body: { model: req.model, prompt: promptFor(req), n: 1, ...(shaped ? { aspect_ratio: RATIO[req.aspect] } : {}) },
      ...(signal ? { signal } : {}),
      timeoutMs: TIMEOUT_MS
    });
  let answer: Answer;
  try {
    answer = await send(true);
  } catch (error) {
    // Not every model takes a shape; the picture matters more than its proportions.
    if (!(error instanceof ProviderError) || error.code !== 'bad_request' || !/aspect/i.test(error.message)) throw error;
    answer = await send(false);
  }
  const first = answer.data?.[0];
  const image = typeof first?.b64_json === 'string' ? { data: first.b64_json, mediaType: typeof first.media_type === 'string' ? first.media_type : 'image/png' } : null;
  const cost = Number(answer.usage?.cost);
  return decoded(image, Number.isFinite(cost) && answer.usage?.cost !== undefined ? cost : null);
}

async function openAi(access: ImageAccess, req: ImageRequest, signal?: AbortSignal): Promise<GeneratedImage> {
  const answer = await requestJson<{ data?: Array<{ b64_json?: unknown }>; output_format?: unknown }>({
    url: joinUrl(access.baseUrl ?? BASE.openai, 'images/generations'),
    headers: { authorization: `Bearer ${access.apiKey}` },
    body: {
      model: req.model,
      prompt: req.prompt,
      n: 1,
      size: OPENAI_SIZE[req.aspect],
      ...(req.transparent ? { background: 'transparent', output_format: 'png' } : {})
    },
    ...(signal ? { signal } : {}),
    timeoutMs: TIMEOUT_MS
  });
  const b64 = answer.data?.[0]?.b64_json;
  const format = typeof answer.output_format === 'string' ? answer.output_format : 'png';
  return decoded(typeof b64 === 'string' ? { data: b64, mediaType: `image/${format}` } : null, null);
}

async function gemini(access: ImageAccess, req: ImageRequest, signal?: AbortSignal): Promise<GeneratedImage> {
  const answer = await requestJson<unknown>({
    url: joinUrl(access.baseUrl ?? BASE.gemini, 'interactions'),
    headers: { 'x-goog-api-key': access.apiKey },
    body: { model: req.model, input: [{ type: 'text', text: promptFor(req) }], response_format: { type: 'image', aspect_ratio: RATIO[req.aspect] } },
    ...(signal ? { signal } : {}),
    timeoutMs: TIMEOUT_MS
  });
  return decoded(extractImage(answer), null);
}

/**
 * NVIDIA's image models are not on its chat endpoint (integrate.api.nvidia.com): each has its own address under
 * ai.api.nvidia.com/v1/genai/<model>. A model id may be that whole address. The answer carries the picture as
 * artifacts[].base64, or as an image field (sometimes a data: URL).
 */
async function nvidia(access: ImageAccess, req: ImageRequest, signal?: AbortSignal): Promise<GeneratedImage> {
  const url = /^https?:\/\//i.test(req.model) ? req.model : joinUrl(BASE.nvidia, req.model.replace(/^\/+/, ''));
  const [width, height] = NVIDIA_SIZE[req.aspect];
  const send = (sized: boolean): Promise<unknown> =>
    requestJson<unknown>({
      url,
      headers: { authorization: `Bearer ${access.apiKey}`, accept: 'application/json' },
      body: { prompt: promptFor(req), ...(sized ? { width, height } : {}), seed: 0 },
      ...(signal ? { signal } : {}),
      timeoutMs: TIMEOUT_MS
    });
  let answer: unknown;
  try {
    answer = await send(true);
  } catch (error) {
    // A model that takes no size (or other sizes) refuses the request; the picture matters more than its shape.
    if (!(error instanceof ProviderError) || error.code !== 'bad_request') throw error;
    answer = await send(false);
  }
  return decoded(nvidiaImage(answer), null);
}

export function nvidiaImage(answer: unknown): { data: string; mediaType: string } | null {
  if (!isRecord(answer)) return null;
  const artifact = Array.isArray(answer.artifacts) && isRecord(answer.artifacts[0]) ? answer.artifacts[0] : null;
  const raw = typeof artifact?.base64 === 'string' ? artifact.base64 : typeof answer.image === 'string' ? answer.image : null;
  if (raw) {
    const url = /^data:(image\/[\w.+-]+);base64,(.*)$/s.exec(raw);
    return url ? { mediaType: url[1]!, data: url[2]! } : { mediaType: raw.startsWith('/9j/') ? 'image/jpeg' : 'image/png', data: raw };
  }
  return extractImage(answer);
}

/** One picture from an image model. Throws ProviderError with a message the user can act on. */
export function generateImage(access: ImageAccess, req: ImageRequest, signal?: AbortSignal): Promise<GeneratedImage> {
  switch (access.kind) {
    case 'openrouter':
      return openRouter(access, req, signal);
    case 'openai':
      return openAi(access, req, signal);
    case 'gemini':
      return gemini(access, req, signal);
    case 'nvidia':
      return nvidia(access, req, signal);
  }
}
