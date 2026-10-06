import type { LlmMessage } from '@shared/schemas/messages';
import type { ContextPart, ContextReport } from '@shared/schemas/sessions';
import type { ToolSpec } from '../providers/types';
import { estimateTextTokens, IMAGE_TOKENS } from './tokens';

/**
 * What the next request would hold, split by where it comes from. These are
 * estimates from the text (the same ones compaction goes by), not a provider's
 * count: they say which part is large, and are labelled as estimates wherever
 * they are shown.
 */

const LABELS: Record<ContextPart['id'], string> = {
  system: 'System prompt',
  tools: 'Built-in tools',
  mcp: 'MCP tools',
  user: 'Your messages',
  replies: 'Replies',
  results: 'Tool results',
  reasoning: 'Reasoning'
};

/** The parts of a request, largest first, empty ones left out. */
export function contextBreakdown(input: { system: string; tools: ToolSpec[]; messages: LlmMessage[] }): ContextPart[] {
  const tokens: Record<ContextPart['id'], number> = { system: estimateTextTokens(input.system), tools: 0, mcp: 0, user: 0, replies: 0, results: 0, reasoning: 0 };
  // A tool costs what its name, description and input schema take once written out.
  for (const spec of input.tools) tokens[spec.name.startsWith('mcp__') ? 'mcp' : 'tools'] += estimateTextTokens(JSON.stringify(spec));
  for (const message of input.messages) {
    const said = message.role === 'user' ? 'user' : 'replies';
    for (const block of message.content) {
      switch (block.type) {
        case 'text':
          tokens[said] += estimateTextTokens(block.text);
          break;
        case 'image':
          tokens[said] += IMAGE_TOKENS;
          break;
        case 'tool_use':
          tokens.replies += estimateTextTokens(JSON.stringify(block.input ?? {})) + 10;
          break;
        case 'tool_result':
          for (const part of block.content) tokens.results += part.type === 'text' ? estimateTextTokens(part.text) : IMAGE_TOKENS;
          break;
        case 'thinking':
          tokens.reasoning += estimateTextTokens(block.text);
          break;
        case 'redacted_thinking':
          tokens.reasoning += estimateTextTokens(block.data) / 2;
          break;
        case 'provider':
          // What a provider did on its own side during a reply (a search it ran, say), sent back as it came.
          tokens.replies += estimateTextTokens(JSON.stringify(block.raw ?? {}));
          break;
      }
    }
  }
  return (Object.keys(tokens) as Array<ContextPart['id']>)
    .map((id) => ({ id, label: LABELS[id], tokens: Math.ceil(tokens[id]) }))
    .filter((part) => part.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens);
}

const count = (n: number): string => n.toLocaleString('en-US');

/** The lines /context prints: the total against the window, each part, and where the numbers come from. */
export function contextLines(report: ContextReport): string[] {
  const sum = report.parts.reduce((total, part) => total + part.tokens, 0);
  const first =
    report.limit > 0
      ? `Context: about ${count(sum)} of ${count(report.limit)} tokens (${String(Math.round((sum / report.limit) * 100))}%).`
      : `Context: about ${count(sum)} tokens (window size unknown).`;
  const source = report.measured === null ? 'Estimated from the text.' : `Estimated from the text; the provider counted ${count(report.measured)}.`;
  return [first, ...report.parts.map((part) => `- ${part.label}: ${count(part.tokens)}`), source];
}
