import type { ModelInfo } from '@shared/schemas/models';
import { streamWithRetry } from '../providers/retry';
import type { LLMProvider, RequestPrivacy } from '../providers/types';

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
/** A model the provider serves at no charge (OpenRouter's free models, for one). */
export function isFree(model: ModelInfo): boolean {
  return model.pricing !== null && model.pricing.input === 0 && model.pricing.output === 0;
}

/**
 * The model for titles and other small jobs: the provider's cheap tier. Someone
 * working on a free model may have no credits at all, so they get a free model
 * (or their own) instead of a cheap one that would be refused.
 */
export function titleModel(current: ModelInfo, available: ModelInfo[]): ModelInfo {
  if (isFree(current)) return available.find((m) => isFree(m) && m.cheap) ?? current;
  return available.find((m) => m.cheap && m.featured && m.supportsTools) ?? available.find((m) => m.cheap) ?? current;
}

/** One short completion with the given system prompt (titles, commit messages); not shown while streaming. */
export async function quickText(
  provider: LLMProvider,
  model: ModelInfo,
  system: string,
  input: string,
  signal: AbortSignal,
  cacheKey: string,
  privacy: RequestPrivacy
): Promise<string> {
  let text = '';
  for await (const event of streamWithRetry(
    provider,
    {
      model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: input }] }],
      tools: [],
      effort: model.effort ? model.effort.levels[0] ?? null : null,
      webSearch: false,
      cacheKey,
      privacy
    },
    signal,
    () => undefined,
    { maxRetries: 1, baseDelayMs: 500, maxDelayMs: 2000, maxRetryAfterMs: 2000 }
  )) {
    if (event.type === 'block' && event.block.type === 'text') text += event.block.text;
  }
  return text;
}

export async function generateTitle(
  provider: LLMProvider,
  model: ModelInfo,
  firstMessage: string,
  signal: AbortSignal,
  privacy: RequestPrivacy
): Promise<string | null> {
  return cleanTitle(await quickText(provider, model, TITLE_SYSTEM, firstMessage.slice(0, 4000), signal, 'title', privacy));
}

const COMMIT_SYSTEM =
  'Write a git commit message for the diff below. First line: an imperative summary of at most 72 characters. If the change needs it, add a blank line and up to four short lines explaining what changed and why. Reply with the message only: no quotes, no code fences, no preamble.';

/** Normalizes a model-written commit message: no fences or quotes, subject line capped. */
export function cleanCommitMessage(raw: string): string | null {
  const text = raw
    .replace(/^```[a-z]*\s*\n?/i, '')
    .replace(/\n?```\s*$/, '')
    .trim();
  const lines = text.split(/\r?\n/);
  const subject = (lines[0] ?? '').replace(/^["'`]+|["'`]+$/g, '').trim();
  if (subject.length === 0) return null;
  const body = lines.slice(1).join('\n').trim();
  const capped = subject.length > 72 ? `${subject.slice(0, 71).trimEnd()}…` : subject;
  return body.length > 0 ? `${capped}\n\n${body}` : capped;
}

export async function generateCommitMessage(
  provider: LLMProvider,
  model: ModelInfo,
  diff: string,
  signal: AbortSignal,
  privacy: RequestPrivacy
): Promise<string | null> {
  return cleanCommitMessage(await quickText(provider, model, COMMIT_SYSTEM, diff, signal, 'commit-message', privacy));
}
