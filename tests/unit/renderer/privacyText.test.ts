import { describe, expect, it } from 'vitest';
import type { ProviderSummary } from '../../../src/shared/schemas/models';
import { handlingText, incognitoNote } from '../../../src/renderer/src/features/privacy/privacyText';

function provider(partial: Partial<ProviderSummary>): ProviderSummary {
  return {
    id: 'p',
    kind: 'openai-compatible',
    preset: null,
    label: 'Provider',
    baseUrl: null,
    hasKey: true,
    enabled: true,
    isDefault: false,
    createdAt: 0,
    customModels: [],
    ...partial
  };
}

describe('privacy copy', () => {
  it('describes each case and blocks cloud models when incognito is local-only', () => {
    expect(handlingText('routed', 'OpenRouter', { incognito: false, noTraining: true })).toMatch(/don't train on or store/);
    expect(handlingText('routed', 'OpenRouter', { incognito: false, noTraining: false })).toMatch(/may send it to providers that store or train/);
    expect(handlingText('routed', 'OpenRouter', { incognito: true, noTraining: false })).toMatch(/zero data retention/);
    expect(handlingText('unknown', 'Acme', { incognito: false, noTraining: true })).toMatch(/can't check how Acme/);

    const openrouter = provider({ kind: 'openrouter', label: 'OpenRouter' });
    expect(incognitoNote(openrouter, false)).toMatchObject({ blocked: false, text: expect.stringMatching(/zero data retention/) as unknown });
    expect(incognitoNote(openrouter, true)).toMatchObject({ blocked: true, text: expect.stringMatching(/OpenRouter isn't one/) as unknown });
    expect(incognitoNote(provider({ kind: 'ollama', label: 'Ollama' }), true).blocked).toBe(false);
    expect(incognitoNote(undefined, true).blocked).toBe(false);
  });
});
