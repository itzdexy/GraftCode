import type { ModelInfo } from '@shared/schemas/models';
import { streamWithRetry } from '../providers/retry';
import type { LLMProvider } from '../providers/types';

const TITLE_SYSTEM =
  'Write a title of 2 to 6 words for a conversation that starts with the message below. Use sentence case, no quotes, no trailing punctuation. Reply with the title only.';

/** Cleans a model-proposed title: first line, no quotes/markdown, bounded length. */
export function cleanTitle(raw: string): string | null {
  const line = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return null;
  const stripped = line
    .replace(/^#+\s*/, '')
    .replace(/^(title|topic)\s*:\s*/i, '')
    .replace(/^["'“”‘’*`]+|["'“”‘’*`]+$/g, '')
    .replace(/[.!?:;,]+$/, '')
    .trim();
  if (stripped.length === 0) return null;
  return stripped.length > 60 ? `${stripped.slice(0, 57).trimEnd()}…` : stripped;
}

/** Picks the model for background titling: the provider's fast tier when listed, else the session's model. */
export function titleModel(current: ModelInfo, available: ModelInfo[]): ModelInfo {
  return available.find((m) => m.cheap && m.featured && m.supportsTools) ?? available.find((m) => m.cheap) ?? current;
}

export async function generateTitle(provider: LLMProvider, model: ModelInfo, firstMessage: string, signal: AbortSignal): Promise<string | null> {
  let text = '';
  for await (const event of streamWithRetry(
    provider,
    {
      model,
      system: TITLE_SYSTEM,
      messages: [{ role: 'user', content: [{ type: 'text', text: firstMessage.slice(0, 4000) }] }],
      tools: [],
      effort: model.effort ? model.effort.levels[0] ?? null : null,
      webSearch: false,
      cacheKey: 'title'
    },
    signal,
    () => undefined,
    { maxRetries: 1, baseDelayMs: 500, maxDelayMs: 2000, maxRetryAfterMs: 2000 }
  )) {
    if (event.type === 'block' && event.block.type === 'text') text += event.block.text;
  }
  return cleanTitle(text);
}
