import { z } from 'zod';
import { ProviderKindSchema } from '@shared/schemas/common';

const text = z.string().max(4096);
const id = z.string().min(1).max(500);
const positive = z.number().int().positive().max(100_000_000);
const price = z.number().nonnegative();
const flag = z.union([z.literal(0), z.literal(1)]);
const url = text.refine((value) => {
  try {
    // Placeholder URLs remain editable presets; they are never fetched by the synchronizer.
    const parsed = new URL(value.replace(/^\$\{[^}]+\}/, 'https://placeholder.invalid').replace(/\$\{[^}]+\}/g, 'placeholder'));
    return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password;
  } catch { return false; }
}, 'Invalid catalog URL');

export const CatalogModelSchema = z.object({
  id, n: text, f: text.optional(), t: flag.optional(), v: flag.optional(), r: flag.optional(),
  e: z.array(text).max(20).optional(), b: z.tuple([z.number().nonnegative(), positive]).refine(([min, max]) => min <= max).optional(),
  g: flag.optional(), i: text.optional(), c: positive.optional(), o: positive.optional(),
  p: z.array(price.nullable()).min(2).max(4).optional(), d: text.optional(), s: text.optional(),
  /** Missing from a later catalog is uncertainty, never retirement. */
  missing: z.boolean().optional(),
  audio: z.boolean().optional(), structured: z.boolean().optional()
});
export type RawModel = z.infer<typeof CatalogModelSchema>;
export const CatalogProviderSchema = z.object({
  id, name: text, kind: ProviderKindSchema, api: url.nullable(), env: z.array(text).max(50),
  doc: url.nullable(), key: z.enum(['required', 'optional']), models: z.array(CatalogModelSchema).max(50_000)
}).refine((p) => new Set(p.models.map((m) => m.id)).size === p.models.length, 'Duplicate model IDs');
export const CatalogDataSchema = z.object({
  source: text.optional(), license: text.optional(), generatedAt: text.optional(),
  providers: z.array(CatalogProviderSchema).max(2000)
}).refine((data) => new Set(data.providers.map((p) => p.id)).size === data.providers.length, 'Duplicate provider IDs');
export type CatalogData = z.infer<typeof CatalogDataSchema>;
export type RawProvider = z.infer<typeof CatalogProviderSchema>;

const RemoteModelSchema = z.object({
  id, name: text.optional(), family: text.optional(), experimental: z.union([z.boolean(), z.record(text, z.unknown())]).optional(),
  tool_call: z.boolean().optional(), attachment: z.boolean().optional(), reasoning: z.boolean().optional(),
  structured_output: z.boolean().optional(), modalities: z.object({ input: z.array(text).optional(), output: z.array(text).optional() }).optional(),
  limit: z.object({ context: z.number().int().nonnegative().optional(), output: z.number().int().nonnegative().optional() }).optional(),
  cost: z.object({ input: price.optional(), output: price.optional(), cache_read: price.optional(), cache_write: price.optional() }).optional(),
  reasoning_options: z.array(z.object({ type: text, values: z.array(text.nullable()).optional(), min: z.number().int().min(-1).optional(), max: positive.optional() })).max(30).optional(),
  interleaved: z.union([z.boolean(), z.object({ field: text })]).optional(),
  release_date: text.optional(), status: text.optional()
});
const RemoteSchema = z.record(id, z.object({
  name: text.optional(), api: url.optional(), env: z.array(text).optional(), doc: url.optional(),
  models: z.record(id, RemoteModelSchema)
}));
const NATIVE = { anthropic: 'anthropic', openai: 'openai', google: 'gemini', openrouter: 'openrouter' } as const;
const COMPATIBLE: Record<string, string> = {
  cerebras: 'https://api.cerebras.ai/v1', cohere: 'https://api.cohere.ai/compatibility/v1',
  deepinfra: 'https://api.deepinfra.com/v1/openai', groq: 'https://api.groq.com/openai/v1',
  mistral: 'https://api.mistral.ai/v1', perplexity: 'https://api.perplexity.ai',
  togetherai: 'https://api.together.xyz/v1', venice: 'https://api.venice.ai/api/v1',
  vercel: 'https://ai-gateway.vercel.sh/v1', xai: 'https://api.x.ai/v1'
};
const EFFORT = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

/** Decode data only; SDK names, scripts, headers and credentials are never imported or executed. */
export function decodeModelsDev(input: unknown, generatedAt: string): CatalogData {
  const parsed = RemoteSchema.parse(input);
  const providers: RawProvider[] = [];
  for (const [providerId, provider] of Object.entries(parsed)) {
    const native = NATIVE[providerId as keyof typeof NATIVE];
    const api = native ? provider.api ?? null : COMPATIBLE[providerId] ?? provider.api ?? null;
    if ((!native && !api) || providerId === 'github-copilot') continue;
    const models: RawModel[] = [];
    for (const model of Object.values(provider.models)) {
      if (model.experimental === true) continue;
      const options = model.reasoning_options ?? [];
      const budget = options.find((o) => o.type === 'budget_tokens');
      const effort = options.find((o) => o.type === 'effort')?.values?.filter((v): v is string => v !== null && EFFORT.has(v));
      const inputModes = model.modalities?.input ?? [];
      const cost = model.cost;
      models.push({
        id: model.id, n: model.name ?? model.id,
        ...(model.family ? { f: model.family } : {}),
        ...(model.tool_call !== undefined ? { t: model.tool_call ? 1 : 0 } : {}),
        ...(model.attachment !== undefined || model.modalities ? { v: model.attachment || inputModes.includes('image') ? 1 : 0 } : {}),
        ...(model.reasoning !== undefined ? { r: model.reasoning ? 1 : 0 } : {}),
        ...(effort?.length ? { e: effort } : {}), ...(budget ? { b: [Math.max(0, budget.min ?? 1024), budget.max ?? 32_000] as [number, number] } : {}),
        ...(options.some((o) => o.type === 'toggle') ? { g: 1 } : {}),
        ...(model.interleaved ? { i: model.interleaved === true ? 'reasoning_content' : model.interleaved.field } : {}),
        ...(model.limit?.context ? { c: model.limit.context } : {}), ...(model.limit?.output ? { o: model.limit.output } : {}),
        ...(cost?.input !== undefined && cost.output !== undefined ? { p: [cost.input, cost.output, cost.cache_read ?? null, cost.cache_write ?? null] } : {}),
        ...(model.release_date ? { d: model.release_date } : {}),
        // Community metadata may report deprecation; it cannot confirm official retirement.
        ...(model.status === 'deprecated' || model.status === 'beta' ? { s: model.status } : {}),
        ...(model.modalities ? { audio: inputModes.includes('audio') || (model.modalities.output ?? []).includes('audio') } : {}),
        ...(model.structured_output !== undefined ? { structured: model.structured_output } : {})
      });
    }
    providers.push({ id: providerId, name: provider.name ?? providerId, kind: native ?? 'openai-compatible', api,
      env: provider.env ?? [], doc: provider.doc ?? null,
      key: api && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(api) ? 'optional' : 'required', models });
  }
  if (!providers.length || !providers.some((p) => p.models.length)) throw new Error('The catalog contains no supported models.');
  return CatalogDataSchema.parse({ source: 'https://models.dev', license: 'MIT', generatedAt, providers });
}

export interface CatalogChanges { added: number; changed: number; omitted: number; deprecated: number }

/** Preserve omitted metadata for existing conversations without advertising it as a current model. */
export function reconcileCatalog(previous: CatalogData, incoming: CatalogData): { catalog: CatalogData; changes: CatalogChanges } {
  const changes: CatalogChanges = { added: 0, changed: 0, omitted: 0, deprecated: 0 };
  const old = new Map(previous.providers.map((p) => [p.id, p]));
  const providers = incoming.providers.map((p) => {
    const before = old.get(p.id);
    old.delete(p.id);
    const models = new Map(before?.models.map((m) => [m.id, m]) ?? []);
    const current = p.models.map((m) => {
      const was = models.get(m.id);
      models.delete(m.id);
      if (!was) changes.added++;
      else if (JSON.stringify(was) !== JSON.stringify(m)) changes.changed++;
      if (m.s === 'deprecated' && was?.s !== 'deprecated') changes.deprecated++;
      return m;
    });
    for (const m of models.values()) { if (!m.missing) changes.omitted++; current.push({ ...m, missing: true }); }
    return { ...p, models: current };
  });
  for (const p of old.values()) {
    providers.push({ ...p, models: p.models.map((m) => { if (!m.missing) changes.omitted++; return { ...m, missing: true }; }) });
  }
  return { catalog: { ...incoming, providers }, changes };
}
