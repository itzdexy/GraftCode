import type { Usage } from '@shared/schemas/common';
import type { LlmMessage } from '@shared/schemas/messages';

/** Rough per-image cost used by estimates (providers charge ~1–1.6K tokens for typical screenshots). */
const IMAGE_TOKENS = 1600;

/** Conservative token estimate (≈3.5 characters per token for code-heavy text). */
export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

export function estimateMessagesTokens(messages: LlmMessage[]): number {
  let total = 0;
  for (const m of messages) {
    total += 4;
    for (const b of m.content) {
      switch (b.type) {
        case 'text':
          total += estimateTextTokens(b.text);
          break;
        case 'thinking':
          total += estimateTextTokens(b.text);
          break;
        case 'image':
          total += IMAGE_TOKENS;
          break;
        case 'tool_use':
          total += estimateTextTokens(JSON.stringify(b.input ?? {})) + 10;
          break;
        case 'tool_result':
          for (const c of b.content) total += c.type === 'text' ? estimateTextTokens(c.text) : IMAGE_TOKENS;
          break;
        case 'redacted_thinking':
          total += estimateTextTokens(b.data) / 2;
          break;
        case 'provider':
          total += estimateTextTokens(JSON.stringify(b.raw ?? {}));
          break;
      }
    }
  }
  return Math.ceil(total);
}

/** Tokens occupying the context after a response: everything sent plus what came back. */
export function contextTokens(usage: Usage): number {
  return usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens;
}

/** Automatic compaction starts once the context passes this share of the window. */
export const COMPACT_THRESHOLD = 0.8;

export function shouldCompact(currentTokens: number, contextWindow: number): boolean {
  return contextWindow > 0 && currentTokens >= contextWindow * COMPACT_THRESHOLD;
}
