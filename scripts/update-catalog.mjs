#!/usr/bin/env node
/**
 * Builds resources/catalog/models.json, the provider and model catalog Graft
 * ships with, from models.dev (https://models.dev, MIT licence).
 *
 * The catalog supplies provider presets (name, base URL, key requirement, docs)
 * and per-model metadata (context, output limit, vision, tools, reasoning and
 * effort options, pricing). Live list-models calls still decide which models a
 * provider offers; the catalog fills in what those calls don't report.
 *
 * Usage: npm run catalog            (downloads the current data)
 *        npm run catalog -- api.json (uses a local copy)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'resources', 'catalog', 'models.json');
const SOURCE = 'https://models.dev/api.json';

/** Providers Graft talks to with a dedicated adapter. */
const NATIVE = { anthropic: 'anthropic', openai: 'openai', google: 'gemini', openrouter: 'openrouter' };

/**
 * OpenAI-compatible endpoints for providers whose models.dev entry relies on a
 * dedicated SDK instead of listing a base URL.
 */
const COMPATIBLE_URLS = {
  cerebras: 'https://api.cerebras.ai/v1',
  cohere: 'https://api.cohere.ai/compatibility/v1',
  deepinfra: 'https://api.deepinfra.com/v1/openai',
  groq: 'https://api.groq.com/openai/v1',
  mistral: 'https://api.mistral.ai/v1',
  perplexity: 'https://api.perplexity.ai',
  togetherai: 'https://api.together.xyz/v1',
  venice: 'https://api.venice.ai/api/v1',
  vercel: 'https://ai-gateway.vercel.sh/v1',
  xai: 'https://api.x.ai/v1'
};

/** Providers that sign in with OAuth or device flows rather than an API key. */
const NO_API_KEY = new Set(['github-copilot']);

const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i;
const EFFORT_VALUES = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

function round(n) {
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/** Compact model record; absent fields mean "unknown" or "no". */
function compactModel(m) {
  const options = Array.isArray(m.reasoning_options) ? m.reasoning_options : [];
  const effort = options.find((o) => o.type === 'effort' && Array.isArray(o.values))?.values?.filter((v) => EFFORT_VALUES.has(v));
  const budget = options.find((o) => o.type === 'budget_tokens');
  const toggle = options.some((o) => o.type === 'toggle');
  const input = Array.isArray(m.modalities?.input) ? m.modalities.input : [];
  const interleaved = m.interleaved === true ? 'reasoning_content' : typeof m.interleaved?.field === 'string' ? m.interleaved.field : undefined;
  const out = { id: m.id, n: m.name ?? m.id };
  if (m.family) out.f = m.family;
  if (typeof m.tool_call === 'boolean') out.t = m.tool_call ? 1 : 0;
  if (typeof m.attachment === 'boolean' || m.modalities) out.v = m.attachment || input.includes('image') ? 1 : 0;
  if (typeof m.reasoning === 'boolean') out.r = m.reasoning ? 1 : 0;
  if (m.modalities) out.audio = input.includes('audio') || (m.modalities.output ?? []).includes('audio');
  if (typeof m.structured_output === 'boolean') out.structured = m.structured_output;
  if (effort && effort.length > 0) out.e = effort;
  if (budget) out.b = [typeof budget.min === 'number' ? Math.max(0, budget.min) : 1024, typeof budget.max === 'number' ? budget.max : 32_000];
  if (toggle) out.g = 1;
  if (interleaved) out.i = interleaved;
  if (typeof m.limit?.context === 'number' && m.limit.context > 0) out.c = m.limit.context;
  if (typeof m.limit?.output === 'number' && m.limit.output > 0) out.o = m.limit.output;
  const cost = m.cost;
  if (cost && typeof cost.input === 'number' && typeof cost.output === 'number') {
    // [input, output, cache read, cache write]; a missing cache price is null, trailing nulls are dropped.
    out.p = [round(cost.input), round(cost.output), ...[cost.cache_read, cost.cache_write].map((v) => (typeof v === 'number' ? round(v) : null))];
    while (out.p.at(-1) === null) out.p.pop();
  }
  if (typeof m.release_date === 'string') out.d = m.release_date;
  if (m.status === 'deprecated' || m.status === 'beta') out.s = m.status;
  return out;
}

async function load(arg) {
  if (arg) return JSON.parse(fs.readFileSync(path.resolve(arg), 'utf8'));
  const response = await fetch(SOURCE, { headers: { 'user-agent': 'graft-catalog-builder' } });
  if (!response.ok) throw new Error(`${SOURCE} answered ${response.status}`);
  return response.json();
}

async function main() {
  const data = await load(process.argv[2]);
  const providers = [];
  const skipped = [];
  for (const [id, p] of Object.entries(data)) {
    const kind = NATIVE[id] ?? (p.api || COMPATIBLE_URLS[id] ? 'openai-compatible' : null);
    if (!kind || NO_API_KEY.has(id)) {
      skipped.push(id);
      continue;
    }
    const api = kind === 'openai-compatible' ? (COMPATIBLE_URLS[id] ?? p.api) : (p.api ?? null);
    const models = Object.values(p.models ?? {})
      .filter((m) => m && typeof m.id === 'string' && m.experimental !== true)
      .map(compactModel)
      .sort((a, b) => (b.d ?? '').localeCompare(a.d ?? '') || a.id.localeCompare(b.id));
    providers.push({
      id,
      name: p.name ?? id,
      kind,
      api: api ?? null,
      env: Array.isArray(p.env) ? p.env : [],
      doc: typeof p.doc === 'string' ? p.doc : null,
      key: api && LOCAL.test(api) ? 'optional' : 'required',
      models
    });
  }
  providers.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
  const catalog = {
    source: 'https://models.dev',
    license: 'MIT',
    generatedAt: new Date().toISOString().slice(0, 10),
    providers
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(catalog)}\n`);
  const modelCount = providers.reduce((n, p) => n + p.models.length, 0);
  console.log(`Wrote ${path.relative(root, OUT)}: ${providers.length} providers, ${modelCount} models (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
  console.log(`Skipped (no OpenAI-compatible endpoint): ${skipped.join(', ')}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
