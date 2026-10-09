import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAiChatProvider } from '../../src/main/providers/openaiChat';
import { withModelLifecycle } from '../../src/main/providers/modelLifecycle';
import { fakeModel } from '../support/fakeProvider';

afterEach(() => { vi.unstubAllGlobals(); });

describe('authoritative model shutdown evidence', () => {
  it('reads the native OpenAI API shutdown date and blocks a past shutdown', async () => {
    const transport = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [
      { id: 'gpt-retired', shutdown_date: '2020-01-01' },
      { id: 'gpt-scheduled', shutdown_date: '2099-01-01' },
      { id: 'gpt-malformed', shutdown_date: '2026-02-30' }
    ] })));
    vi.stubGlobal('fetch', transport);
    const provider = new OpenAiChatProvider({ id: 'p', kind: 'openai', apiKey: 'fixture', preset: null, baseUrl: null });
    const models = await provider.listModels();
    expect(models.find((m) => m.ref.modelId === 'gpt-retired')).toMatchObject({ lifecycle: { shutdownDate: '2020-01-01', source: 'openai-models-api' }, availability: { state: 'confirmed-retired', source: 'provider', selectable: false } });
    expect(models.find((m) => m.ref.modelId === 'gpt-scheduled')).toMatchObject({ availability: { state: 'deprecated', selectable: true } });
    expect(models.find((m) => m.ref.modelId === 'gpt-malformed')?.lifecycle).toBeUndefined();
    expect(transport).toHaveBeenCalledWith('https://api.openai.com/v1/models', expect.objectContaining({ redirect: 'error' }));
  });

  it.each([
    { kind: 'openai' as const, baseUrl: 'https://proxy.test/v1' },
    { kind: 'openai-compatible' as const, baseUrl: 'https://api.openai.com/v1' },
    { kind: 'openai' as const, baseUrl: 'http://api.openai.com/v1' },
    { kind: 'openai' as const, baseUrl: 'https://api.openai.com.evil.test/v1' }
  ])('does not promote shutdown fields from a compatible/custom endpoint: $baseUrl ($kind)', async ({ kind, baseUrl }) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'gpt-model', shutdown_date: '2020-01-01' }] }))));
    const provider = new OpenAiChatProvider({ id: 'p', kind, apiKey: 'fixture', preset: null, baseUrl });
    const [model] = await provider.listModels();
    expect(model?.lifecycle).toBeUndefined();
    expect(model?.availability?.state).toBe('available');
  });

  it('expires cached shutdown evidence after the dated UTC day, including during an outage', () => {
    const model = fakeModel({ lifecycle: { shutdownDate: '2026-10-09', source: 'openai-models-api', sourceUrl: 'https://api.openai.com/v1/models' } });
    expect(withModelLifecycle(model, Date.parse('2026-10-09T23:59:59Z')).availability).toMatchObject({ state: 'deprecated', selectable: true });
    const offline = { ...model, availability: { state: 'temporarily-unavailable' as const, source: 'cache' as const, checkedAt: 1, reason: 'Offline.', selectable: false } };
    expect(withModelLifecycle(offline, Date.parse('2026-10-09T23:59:59Z')).availability).toMatchObject({ state: 'temporarily-unavailable', selectable: false });
    expect(withModelLifecycle(offline, Date.parse('2026-10-10T00:00:00Z')).availability).toMatchObject({ state: 'confirmed-retired', source: 'provider', selectable: false });
  });
});
