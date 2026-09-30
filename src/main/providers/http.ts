import { errorFromHttp, errorFromNetwork, ProviderError } from './errors';

export interface HttpRequest {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
  /** Time to first byte; streaming bodies are then unbounded. */
  timeoutMs?: number;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/**
 * fetch with a connect timeout, abort propagation and error normalization.
 * Resolves only for 2xx responses; everything else throws ProviderError.
 */
export async function request(req: HttpRequest): Promise<Response> {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(req.signal?.reason);
  if (req.signal?.aborted) throw new ProviderError('aborted', 'Request cancelled.');
  req.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('timeout')), req.timeoutMs ?? 60_000);
  const where = hostOf(req.url);
  let response: Response;
  try {
    response = await fetch(req.url, {
      method: req.method ?? (req.body === undefined ? 'GET' : 'POST'),
      headers: {
        ...(req.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...req.headers
      },
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
      signal: controller.signal
    });
  } catch (error) {
    clearTimeout(timer);
    req.signal?.removeEventListener('abort', onAbort);
    if (req.signal?.aborted) throw new ProviderError('aborted', 'Request cancelled.', { cause: error });
    if (controller.signal.aborted) {
      throw new ProviderError('network', `${where} did not respond in time.`, { cause: error });
    }
    throw errorFromNetwork(error, where);
  }
  clearTimeout(timer);
  // Keep forwarding caller aborts to the body stream; detach once the body ends.
  if (!response.ok) {
    req.signal?.removeEventListener('abort', onAbort);
    const text = await response.text().catch(() => '');
    throw errorFromHttp(response.status, text, response.headers, where);
  }
  return response;
}

export async function requestJson<T>(req: HttpRequest): Promise<T> {
  const response = await request(req);
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    const where = hostOf(req.url);
    throw new ProviderError('bad_base_url', `${where} did not return JSON — check the base URL.`, {
      cause: error,
      retryable: false
    });
  }
}
