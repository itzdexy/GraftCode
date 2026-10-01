import type { LlmMessage, StoredMessage } from '@shared/schemas/messages';
import type { ModelInfo } from '@shared/schemas/models';
import type { TodoItem } from '@shared/schemas/toolDisplay';
import { ProviderError } from '../providers/errors';
import { streamWithRetry } from '../providers/retry';
import type { LLMProvider, RequestPrivacy } from '../providers/types';
import { toLlmHistory } from './history';

const COMPACTION_SYSTEM = [
  'You summarize a coding session so it can continue in a fresh context without losing anything important.',
  'Write a Markdown summary with these sections:',
  '1. Goal — the user\'s objective and requirements. Quote the most recent user request verbatim.',
  '2. Decisions — what was decided and why, including rejected approaches.',
  '3. Work done — files created or changed (paths) and what changed in each.',
  '4. Current state — what is in progress, open errors (exact messages), test/build status.',
  '5. Next steps — what remains, in order.',
  'Be specific: keep file paths, function names, commands and error text. Leave out pleasantries and tool mechanics.',
  'Reply with the summary only; do not call tools or continue the task.'
].join('\n');

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.floor(max * 0.6))}\n…\n${text.slice(-Math.floor(max * 0.4))}` : text;
}

/** Renders history as plain text for the summarizer (provider-neutral, no tool schemas needed). */
export function renderTranscript(history: LlmMessage[], budgetChars: number): string {
  const parts: string[] = [];
  for (const m of history) {
    const lines: string[] = [];
    for (const b of m.content) {
      if (b.type === 'text') lines.push(b.text);
      else if (b.type === 'image') lines.push('[image]');
      else if (b.type === 'tool_use') lines.push(`[called ${b.name} ${clip(JSON.stringify(b.input ?? {}), 600)}]`);
      else if (b.type === 'tool_result') {
        const text = b.content.map((c) => (c.type === 'text' ? c.text : '[image]')).join('\n');
        lines.push(`[${b.isError ? 'error' : 'result'}] ${clip(text, 1500)}`);
      } else if (b.type === 'provider') lines.push(`[${b.summary}]`);
    }
    if (lines.length > 0) parts.push(`## ${m.role === 'user' ? 'User' : 'Assistant'}\n${lines.join('\n')}`);
  }
  const full = parts.join('\n\n');
  if (full.length <= budgetChars) return full;
  // Keep the opening request and as much recent work as fits.
  const head = parts[0] ?? '';
  const tail: string[] = [];
  let size = head.length;
  for (let i = parts.length - 1; i > 0; i--) {
    const p = parts[i]!;
    if (size + p.length > budgetChars) break;
    tail.unshift(p);
    size += p.length;
  }
  return `${head}\n\n[… earlier middle of the session omitted …]\n\n${tail.join('\n\n')}`;
}

export interface CompactionRequest {
  provider: LLMProvider;
  model: ModelInfo;
  messages: StoredMessage[];
  todos: TodoItem[];
  files: string[];
  instructions: string;
  cacheKey: string;
  privacy: RequestPrivacy;
  signal: AbortSignal;
}

/** Asks the model for a continuation summary of the session so far. */
export async function summarizeSession(req: CompactionRequest): Promise<string> {
  const history = toLlmHistory(req.messages);
  const budget = Math.min(600_000, Math.floor(req.model.contextWindow * 2.2));
  const transcript = renderTranscript(history, budget);
  const extra = req.instructions.trim().length > 0 ? `\n\nThe user asked the summary to keep: ${req.instructions.trim()}` : '';
  let text = '';
  for await (const event of streamWithRetry(
    req.provider,
    {
      model: req.model,
      system: COMPACTION_SYSTEM,
      messages: [{ role: 'user', content: [{ type: 'text', text: `Summarize this session:\n\n${transcript}${extra}` }] }],
      tools: [],
      effort: req.model.effort ? 'low' : null,
      webSearch: false,
      cacheKey: `${req.cacheKey}:compact`,
      privacy: req.privacy
    },
    req.signal,
    () => undefined
  )) {
    if (event.type === 'block' && event.block.type === 'text') text += event.block.text;
  }
  if (text.trim().length === 0) throw new ProviderError('unknown', 'The model returned an empty summary.', { retryable: false });
  return text.trim();
}

/** Text of the message that replaces the compacted history. */
export function summaryMessageText(summary: string, todos: TodoItem[], files: string[]): string {
  const todoText =
    todos.length > 0
      ? `\n\nTask list at the time of compaction:\n${todos.map((t) => `- [${t.status === 'completed' ? 'x' : t.status === 'in_progress' ? '~' : ' '}] ${t.content}`).join('\n')}`
      : '';
  const fileText = files.length > 0 ? `\n\nFiles read or changed so far:\n${files.slice(-60).map((f) => `- ${f}`).join('\n')}` : '';
  return [
    'This session was compacted to free up context. Summary of the work so far:',
    '',
    summary,
    `${todoText}${fileText}`,
    '',
    'Continue from where the work left off. Re-read files before editing them; earlier reads are no longer in context.'
  ].join('\n');
}
