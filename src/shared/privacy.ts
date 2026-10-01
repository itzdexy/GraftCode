import type { ProviderKind } from './schemas/common';

/**
 * How a provider treats what Graft sends it, as far as Graft can tell:
 * - local: a server on this computer, so nothing goes over the internet.
 * - routed: OpenRouter, which Graft restricts per request to providers that
 *   don't train on or keep prompts (see RequestPrivacy).
 * - no-training: the vendor's own API, whose terms leave API data out of training by default.
 * - may-train: Google's Gemini API, which may use data sent with free-tier keys.
 * - unknown: anything else; Graft can't check its policy.
 */
export type DataHandling = 'local' | 'routed' | 'no-training' | 'may-train' | 'unknown';

const LOCAL_URL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i;

export function isLocalUrl(url: string): boolean {
  return LOCAL_URL.test(url);
}

/** Hosts of the vendor APIs whose terms Graft describes; a different base URL is someone else's server. */
const VENDOR_HOSTS: Partial<Record<ProviderKind, string>> = {
  anthropic: 'api.anthropic.com',
  openai: 'api.openai.com',
  gemini: 'generativelanguage.googleapis.com',
  openrouter: 'openrouter.ai'
};

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function dataHandling(provider: { kind: ProviderKind; baseUrl: string | null }): DataHandling {
  const { kind, baseUrl } = provider;
  if (baseUrl !== null && isLocalUrl(baseUrl)) return 'local';
  if (kind === 'ollama') return baseUrl === null ? 'local' : 'unknown';
  const vendor = VENDOR_HOSTS[kind];
  if (!vendor || (baseUrl !== null && hostOf(baseUrl) !== vendor)) return 'unknown';
  if (kind === 'openrouter') return 'routed';
  return kind === 'gemini' ? 'may-train' : 'no-training';
}
