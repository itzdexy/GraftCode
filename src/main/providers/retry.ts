import { isAbortError, ProviderError } from './errors';
import type { LLMProvider, StreamEvent, StreamRequest } from './types';

export interface RetryPolicy {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Upper bound for a server-requested Retry-After. */
  maxRetryAfterMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 4,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
  maxRetryAfterMs: 60_000
};

export interface RetryInfo {
  attempt: number;
  delayMs: number;
  error: ProviderError;
}

/** Exponential backoff with ±20% jitter, or the server's Retry-After when given. */
export function backoffDelay(attempt: number, error: ProviderError, policy: RetryPolicy, random = Math.random): number {
  if (error.retryAfterMs !== undefined) return Math.min(error.retryAfterMs, policy.maxRetryAfterMs);
  const exp = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  const jitter = exp * 0.2 * (random() * 2 - 1);
  return Math.max(0, Math.round(exp + jitter));
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new ProviderError('aborted', 'Request cancelled.'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new ProviderError('aborted', 'Request cancelled.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function normalize(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  if (isAbortError(error)) return new ProviderError('aborted', 'Request cancelled.', { cause: error });
  const message = error instanceof Error ? error.message : String(error);
  return new ProviderError('unknown', message, { cause: error, retryable: false });
}

/**
 * Streams with retries on retryable failures (429 / 5xx / overloaded /
 * transient network). A retry only happens before the first event: once
 * output has reached the caller, replaying would duplicate it, so the error
 * surfaces instead and the partial response is kept.
 */
export async function* streamWithRetry(
  provider: LLMProvider,
  request: StreamRequest,
  signal: AbortSignal,
  onRetry: (info: RetryInfo) => void,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY
): AsyncGenerator<StreamEvent> {
  for (let attempt = 1; ; attempt++) {
    let yielded = false;
    try {
      for await (const event of provider.streamText(request, signal)) {
        yielded = true;
        yield event;
      }
      return;
    } catch (raw) {
      const error = normalize(raw);
      if (signal.aborted || error.code === 'aborted') throw new ProviderError('aborted', 'Request cancelled.', { cause: raw });
      if (yielded || !error.retryable || attempt > policy.maxRetries) throw error;
      const delayMs = backoffDelay(attempt, error, policy);
      onRetry({ attempt, delayMs, error });
      await sleep(delayMs, signal);
    }
  }
}
