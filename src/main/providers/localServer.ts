import { joinUrl, requestJson } from './http';

/** Servers on this computer whose own API says how much context they loaded a model with. */
export type LocalFlavor = 'llamacpp' | 'lmstudio' | null;

/** How long each question to a local server may take before Graft goes on without the answer. */
const PROBE_TIMEOUT_MS = 2_000;

/** The server behind an OpenAI-style base URL: its own endpoints live beside `/v1`, not under it. */
export function serverOrigin(base: string): string {
  return base.replace(/\/v1\/?$/, '');
}

/**
 * Which local server listed these models, from the marks each leaves on its
 * list: llama.cpp says it owns them and adds a `meta` block with the trained
 * length, and LM Studio says they belong to "organization_owner".
 */
export function flavorOf(entries: Array<{ owned_by?: unknown; meta?: unknown }>): LocalFlavor {
  for (const entry of entries) {
    if (entry.owned_by === 'llamacpp') return 'llamacpp';
    if (entry.meta !== null && typeof entry.meta === 'object' && 'n_ctx_train' in entry.meta) return 'llamacpp';
    if (entry.owned_by === 'organization_owner') return 'lmstudio';
  }
  return null;
}

function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * The context each model was loaded with, which is what a prompt has to fit in
 * on this server, whatever the model could hold. The key `'*'` stands for every
 * model on the server. Gives an empty map when the server does not answer, or
 * answers with something else: the size then comes from the model list as before.
 */
export async function loadedContexts(base: string, flavor: LocalFlavor, signal?: AbortSignal, headers: Record<string, string> = {}): Promise<Map<string, number>> {
  const loaded = new Map<string, number>();
  if (flavor === null) return loaded;
  const origin = serverOrigin(base);
  const ask = <T>(path: string): Promise<T> =>
    requestJson<T>({ url: joinUrl(origin, path), headers, timeoutMs: PROBE_TIMEOUT_MS, ...(signal ? { signal } : {}) });
  try {
    if (flavor === 'llamacpp') {
      // llama.cpp serves one model, and each request gets the context of one slot.
      const props = await ask<{ default_generation_settings?: { n_ctx?: unknown } }>('props');
      const n = tokenCount(props?.default_generation_settings?.n_ctx);
      if (n !== null) loaded.set('*', n);
    } else {
      const body = await ask<{ data?: Array<{ id?: unknown; state?: unknown; loaded_context_length?: unknown }> }>('api/v0/models');
      for (const entry of Array.isArray(body?.data) ? body.data : []) {
        const n = tokenCount(entry?.loaded_context_length);
        if (typeof entry?.id === 'string' && entry.state === 'loaded' && n !== null) loaded.set(entry.id, n);
      }
    }
  } catch {
    return new Map();
  }
  return loaded;
}
