import type { ProviderKind } from '@shared/schemas/common';
import type { ProviderPreset } from '@shared/schemas/models';
import { PROVIDER_KIND_INFO } from '@shared/providerKinds';

/** Catalog preset that carries model metadata for each native adapter. */
export const NATIVE_PRESET: Record<ProviderKind, string | null> = {
  anthropic: 'anthropic',
  openai: 'openai',
  gemini: 'google',
  openrouter: 'openrouter',
  ollama: 'ollama',
  'openai-compatible': null
};

/** Shown first in pickers; the rest follow alphabetically. */
export const FEATURED_PRESETS = [
  'anthropic',
  'openai',
  'google',
  'openrouter',
  'ollama',
  'deepseek',
  'xai',
  'mistral',
  'groq',
  'moonshotai',
  'zai',
  'alibaba',
  'togetherai',
  'fireworks-ai',
  'cerebras',
  'deepinfra',
  'perplexity',
  'lmstudio'
];

/** What the key/connection form needs to know about the provider being added. */
export interface ProviderTarget {
  kind: ProviderKind;
  preset: string | null;
  name: string;
  description: string;
  key: 'required' | 'optional' | 'none';
  baseUrl: 'required' | 'optional' | 'hidden';
  defaultBaseUrl: string | null;
  keyPlaceholder: string;
  keyHelpUrl: string | null;
  envVars: string[];
}

export function targetFor(kind: ProviderKind, preset: ProviderPreset | null): ProviderTarget {
  const info = PROVIDER_KIND_INFO[kind];
  if (preset && kind === 'openai-compatible') {
    return {
      kind,
      preset: preset.id,
      name: preset.name,
      description: preset.local ? 'Runs on this computer.' : `${preset.modelCount} models in Graft's catalog.`,
      key: preset.key,
      baseUrl: 'required',
      defaultBaseUrl: preset.baseUrl,
      keyPlaceholder: preset.key === 'required' ? 'Paste your API key' : 'Optional',
      keyHelpUrl: preset.docUrl,
      envVars: preset.envVars
    };
  }
  return {
    kind,
    preset: preset?.id ?? NATIVE_PRESET[kind],
    name: info.name,
    description: info.description,
    key: info.key,
    baseUrl: info.baseUrl,
    defaultBaseUrl: info.defaultBaseUrl,
    keyPlaceholder: info.keyPlaceholder,
    keyHelpUrl: info.keyHelpUrl,
    envVars: preset?.envVars ?? []
  };
}

/** Placeholder such as ${ACCOUNT_ID} still left in a base URL. */
export function urlPlaceholder(url: string): string | null {
  return /\$\{([^}]+)\}/.exec(url)?.[1] ?? null;
}

/** Search score for a preset; null when it doesn't match. */
export function presetMatches(preset: ProviderPreset, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return preset.name.toLowerCase().includes(q) || preset.id.toLowerCase().includes(q) || (preset.baseUrl ?? '').toLowerCase().includes(q);
}

/** Featured presets first (in FEATURED_PRESETS order), then the rest by name. */
export function orderPresets(presets: ProviderPreset[]): { featured: ProviderPreset[]; rest: ProviderPreset[] } {
  const byId = new Map(presets.map((p) => [p.id, p]));
  const featured = FEATURED_PRESETS.map((id) => byId.get(id)).filter((p): p is ProviderPreset => p !== undefined);
  const chosen = new Set(featured.map((p) => p.id));
  return { featured, rest: presets.filter((p) => !chosen.has(p.id)) };
}
