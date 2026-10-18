import { isLocalUrl } from '@shared/privacy';
import { PROVIDER_KIND_INFO } from '@shared/providerKinds';
import type { ProviderKind } from '@shared/schemas/common';
import type { DetectedServer } from '@shared/schemas/models';
import { joinUrl, requestJson } from './http';

/** Servers on this computer whose own API says how much context they loaded a model with. */
export type LocalFlavor = 'llamacpp' | 'lmstudio' | null;

/** How long each question to a local server may take before Graft goes on without the answer. */
const PROBE_TIMEOUT_MS = 2_000;

/**
 * How long a server on this computer may take to start answering. On a CPU it
 * can spend many minutes reading a long prompt before the first byte, and a
 * hosted limit would cut it off while it is still working.
 */
export const LOCAL_FIRST_BYTE_MS = 900_000;

/** The time to the first byte for a base URL: the local limit on this computer, the hosted one anywhere else. */
export function firstByteTimeout(base: string, hosted: number): number {
  return isLocalUrl(base) ? LOCAL_FIRST_BYTE_MS : hosted;
}

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

/** A port a known model server listens on by default, and the path that lists its models. */
export interface Candidate {
  name: string;
  port: number;
  kind: DetectedServer['kind'];
  preset: string | null;
  path: 'api/tags' | 'v1/models';
}

/** The servers people run models with, on the ports they use out of the box. */
export const LOCAL_CANDIDATES: Candidate[] = [
  { name: 'Ollama', port: 11434, kind: 'ollama', preset: 'ollama', path: 'api/tags' },
  { name: 'LM Studio', port: 1234, kind: 'openai-compatible', preset: 'lmstudio', path: 'v1/models' },
  { name: 'llama.cpp', port: 8080, kind: 'openai-compatible', preset: null, path: 'v1/models' },
  { name: 'vLLM', port: 8000, kind: 'openai-compatible', preset: null, path: 'v1/models' },
  { name: 'Jan', port: 1337, kind: 'openai-compatible', preset: null, path: 'v1/models' },
  { name: 'KoboldCpp', port: 5001, kind: 'openai-compatible', preset: null, path: 'v1/models' }
];

/** How long the whole search may take: a server on this computer answers its model list at once. */
const DETECT_TIMEOUT_MS = 1_500;

/**
 * The model servers answering on this computer. Every candidate is asked at
 * once, and one counts only when it answers its path with a model list, so a
 * web server that happens to sit on the same port is not taken for one.
 */
export async function detectLocalServers(
  opts: { host?: string; candidates?: Candidate[]; timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<DetectedServer[]> {
  const host = opts.host ?? '127.0.0.1';
  const timeoutMs = opts.timeoutMs ?? DETECT_TIMEOUT_MS;
  // The request timeout only covers the first byte. This deadline aborts a model list that never ends, and each
  // probe is raced against it because the body of an error answer is read with nothing that can abort it.
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, deadline]) : deadline;
  const found = await Promise.all(
    (opts.candidates ?? LOCAL_CANDIDATES).map((c) => settledBy(probe(`http://${host}:${c.port}`, c, timeoutMs, signal), signal))
  );
  return found.filter((server): server is DetectedServer => server !== null);
}

/**
 * A probe's answer, or null once the signal aborts: a server still sending its answer by then is not counted.
 * The abandoned request ends when that server closes the connection.
 */
function settledBy(work: Promise<DetectedServer | null>, signal: AbortSignal): Promise<DetectedServer | null> {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    const giveUp = (): void => resolve(null);
    signal.addEventListener('abort', giveUp, { once: true });
    work
      .then(resolve, () => resolve(null))
      .finally(() => signal.removeEventListener('abort', giveUp));
  });
}

async function probe(origin: string, candidate: Candidate, timeoutMs: number, signal: AbortSignal): Promise<DetectedServer | null> {
  const ask = <T>(path: string): Promise<T> => requestJson<T>({ url: joinUrl(origin, path), timeoutMs, signal });
  try {
    const body = await ask<{ data?: unknown; models?: unknown }>(candidate.path);
    const list = candidate.path === 'api/tags' ? body?.models : body?.data;
    if (!Array.isArray(list)) return null;
    return {
      name: candidate.name === 'llama.cpp' && !(await isLlamaCpp(ask)) ? 'OpenAI-compatible server' : candidate.name,
      kind: candidate.kind,
      preset: candidate.preset,
      baseUrl: candidate.path === 'v1/models' ? `${origin}/v1` : origin,
      models: list.length
    };
  } catch {
    return null;
  }
}

/** Port 8080 is a common default, so the server is called llama.cpp only when its own settings endpoint answers. */
async function isLlamaCpp(ask: <T>(path: string) => Promise<T>): Promise<boolean> {
  try {
    const props = await ask<{ default_generation_settings?: unknown }>('props');
    return props?.default_generation_settings !== null && typeof props?.default_generation_settings === 'object';
  } catch {
    return false;
  }
}

/** The names this computer goes by: a provider added as localhost is the same server found at 127.0.0.1. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

function addressKey(url: string): string {
  try {
    const parsed = new URL(url);
    const host = LOOPBACK.has(parsed.hostname) ? 'loopback' : parsed.hostname;
    return `${parsed.protocol}//${host}:${parsed.port}${parsed.pathname.replace(/\/+$/, '')}`;
  } catch {
    return url.trim().replace(/\/+$/, '').toLowerCase();
  }
}

/**
 * The servers found that no provider points at yet. A provider with no URL talks to its kind's
 * default address (Ollama's is localhost:11434), so it counts as pointing there.
 */
export function newServers(found: DetectedServer[], providers: Array<{ kind: ProviderKind; baseUrl: string | null }>): DetectedServer[] {
  const added = new Set(
    providers.flatMap((p) => {
      const url = p.baseUrl ?? PROVIDER_KIND_INFO[p.kind].defaultBaseUrl;
      return url ? [addressKey(url)] : [];
    })
  );
  return found.filter((server) => !added.has(addressKey(server.baseUrl)));
}
