import { ModelLifecycleSchema, type ModelInfo, type ModelLifecycle } from '@shared/schemas/models';

/** Only the native HTTPS endpoint is evidence of an OpenAI announcement. */
export function isOfficialOpenAiModels(base: string, kind: string): boolean {
  if (kind !== 'openai') return false;
  try {
    const url = new URL(base);
    return url.origin === 'https://api.openai.com' && url.pathname.replace(/\/+$/, '') === '/v1'
      && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

export function openAiShutdownDate(date: unknown): ModelLifecycle | undefined {
  const parsed = ModelLifecycleSchema.safeParse({ shutdownDate: date, source: 'openai-models-api', sourceUrl: 'https://api.openai.com/v1/models' });
  return parsed.success ? parsed.data : undefined;
}

/** Re-evaluate retained evidence even without another successful discovery request. */
export function withModelLifecycle(model: ModelInfo, now = Date.now()): ModelInfo {
  const evidence = model.lifecycle;
  if (!evidence) return model;
  // The API publishes a date, not an exact shutdown instant. Keep the whole UTC
  // day selectable rather than disabling the model before its announced day ends.
  const expired = now >= Date.parse(`${evidence.shutdownDate}T00:00:00Z`) + 86_400_000;
  const reason = `OpenAI announced shutdown on ${evidence.shutdownDate}. Select a replacement in the model picker; your conversation and selected model are preserved.`;
  if (expired) return { ...model, availability: { state: 'confirmed-retired', source: 'provider',
    checkedAt: model.availability?.checkedAt ?? null, selectable: false, reason } };
  if (model.availability?.selectable === false) return model;
  return { ...model, availability: { state: 'deprecated', source: 'provider',
    checkedAt: model.availability?.checkedAt ?? null, selectable: true, reason } };
}
