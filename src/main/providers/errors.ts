import type { ProviderErrorCode } from '@shared/schemas/models';

const RETRYABLE: ReadonlySet<ProviderErrorCode> = new Set(['rate_limit', 'overloaded', 'server', 'network']);

/** Normalized provider failure. `retryable` drives the backoff policy. */
export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly status: number | undefined;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(
    code: ProviderErrorCode,
    message: string,
    options: { status?: number; retryable?: boolean; retryAfterMs?: number; cause?: unknown } = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ProviderError';
    this.code = code;
    this.status = options.status;
    this.retryable = options.retryable ?? RETRYABLE.has(code);
    this.retryAfterMs = options.retryAfterMs;
  }
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof ProviderError) return error.code === 'aborted';
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'APIUserAbortError');
}

/** Parses Retry-After (seconds or HTTP date) and retry-after-ms headers. */
export function parseRetryAfter(headers: { get(name: string): string | null } | undefined, now = Date.now()): number | undefined {
  if (!headers) return undefined;
  const ms = headers.get('retry-after-ms');
  if (ms && /^\d+(\.\d+)?$/.test(ms)) return Math.round(Number(ms));
  const value = headers.get('retry-after');
  if (!value) return undefined;
  if (/^\d+(\.\d+)?$/.test(value.trim())) return Math.round(Number(value) * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** Pulls a human message out of the common provider error body shapes. */
export function extractProviderMessage(body: string): string | null {
  const trimmed = body.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      const err = obj.error;
      if (typeof err === 'string') return err;
      if (err && typeof err === 'object') {
        const message = (err as Record<string, unknown>).message;
        if (typeof message === 'string') return message;
      }
      if (typeof obj.message === 'string') return obj.message;
      if (typeof obj.detail === 'string') return obj.detail;
    }
  } catch {
    // Not JSON: fall through to the raw text.
  }
  if (/^\s*<(!doctype|html)/i.test(trimmed)) return null;
  return trimmed.slice(0, 300);
}

const CONTEXT_PATTERNS = [/prompt is too long/i, /context (length|window)/i, /maximum context/i, /too many tokens/i, /input is too long/i];

/**
 * Maps an HTTP failure to a ProviderError with a specific, actionable message.
 * `where` names the endpoint host for "wrong base URL" messages.
 */
export function errorFromHttp(
  status: number,
  body: string,
  headers: { get(name: string): string | null } | undefined,
  where: string
): ProviderError {
  const detail = extractProviderMessage(body);
  const isHtml = /^\s*<(!doctype|html)/i.test(body);
  const suffix = detail ? `: ${detail}` : '.';
  if (isHtml && status !== 429 && status < 500) {
    return new ProviderError('bad_base_url', `${where} returned a web page instead of an API response — check the base URL.`, {
      status
    });
  }
  switch (status) {
    case 401:
      return new ProviderError('auth', `The API key was rejected (401)${suffix}`, { status });
    case 403:
      return new ProviderError('auth', `This key doesn't have access (403)${suffix}`, { status });
    case 404:
      return new ProviderError('not_found', `Not found at ${where} (404)${suffix}`, { status });
    case 408:
      return new ProviderError('network', `The request timed out (408)${suffix}`, { status });
    case 413:
      return new ProviderError('context_length', `The request is too large (413)${suffix}`, { status });
    case 429:
      return new ProviderError('rate_limit', `Rate limited (429)${suffix}`, {
        status,
        retryAfterMs: parseRetryAfter(headers)
      });
    case 529:
      return new ProviderError('overloaded', `The provider is overloaded (529)${suffix}`, {
        status,
        retryAfterMs: parseRetryAfter(headers)
      });
    case 503:
      return new ProviderError('overloaded', `The provider is unavailable (503)${suffix}`, {
        status,
        retryAfterMs: parseRetryAfter(headers)
      });
    default:
      break;
  }
  if (status >= 500) return new ProviderError('server', `Provider error (${status})${suffix}`, { status });
  if (status === 400 || status === 422) {
    if (detail && CONTEXT_PATTERNS.some((p) => p.test(detail))) {
      return new ProviderError('context_length', `The conversation is too long for this model${suffix}`, { status });
    }
    return new ProviderError('bad_request', `The provider rejected the request (${status})${suffix}`, { status });
  }
  return new ProviderError('unknown', `Unexpected response (${status})${suffix}`, { status });
}

const UNREACHABLE = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'ERR_INVALID_URL']);

/** Maps fetch/socket failures. Unreachable hosts are not retried: they need a settings fix. */
export function errorFromNetwork(error: unknown, where: string): ProviderError {
  if (isAbortError(error)) return new ProviderError('aborted', 'Request cancelled.', { cause: error });
  if (causeMessages(error).some((m) => /bad port/i.test(m))) {
    return new ProviderError('bad_base_url', `${where} uses a port that browsers and fetch refuse to contact. Use a different port.`, {
      retryable: false,
      cause: error
    });
  }
  const code = networkCode(error);
  if (code && UNREACHABLE.has(code)) {
    return new ProviderError('network', `Couldn't reach ${where} (${code}). Check the base URL and your connection.`, {
      retryable: false,
      cause: error
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ProviderError('network', `Network error talking to ${where}${code ? ` (${code})` : ''}: ${message}`, {
    cause: error
  });
}

function causeMessages(error: unknown): string[] {
  const out: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
    out.push(current.message);
    current = current.cause;
  }
  return out;
}

function networkCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth++) {
    if (current && typeof current === 'object') {
      const code = (current as { code?: unknown }).code;
      if (typeof code === 'string') return code;
      current = (current as { cause?: unknown }).cause;
    } else break;
  }
  if (error instanceof TypeError && /invalid url/i.test(error.message)) return 'ERR_INVALID_URL';
  return undefined;
}
