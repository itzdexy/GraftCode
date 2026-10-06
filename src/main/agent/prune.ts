import type { ContentBlock, StoredMessage } from '@shared/schemas/messages';
import { estimateTextTokens, IMAGE_TOKENS } from './tokens';

/**
 * Removing old tool output from what is sent to the model. A long session
 * fills its context mostly with the output of tools it ran long ago: files it
 * read, searches, test runs. The agent can run those again, so they go first,
 * before anything is summarized. This only decides how the history is sent:
 * the stored messages, and so the transcript, keep everything.
 */

/** Tokens of the newest tool output that stay as they are (the session takes less for a small context window). */
export const PRUNE_KEEP_TOKENS = 40_000;

/** A result below this is not worth a line saying it was removed. */
export const PRUNE_MIN_TOKENS = 200;

type ToolResult = Extract<ContentBlock, { type: 'tool_result' }>;

/** The line that stands in for a removed result. It names the tool so the agent knows what to run again. */
export function prunedStub(toolName: string): string {
  return `[The output of this ${toolName.length > 0 ? toolName : 'tool'} call was removed to save context. Run it again if you need it.]`;
}

function resultTokens(block: ToolResult): number {
  let total = 0;
  for (const part of block.content) total += part.type === 'text' ? estimateTextTokens(part.text) : IMAGE_TOKENS;
  return total;
}

/** Tokens of the tool results a message holds, or null when it holds none. */
function outputTokens(message: StoredMessage): number | null {
  let total: number | null = null;
  for (const block of message.content) if (block.type === 'tool_result') total = (total ?? 0) + resultTokens(block);
  return total;
}

/**
 * The seq before which tool output is removed; null when all of it fits in
 * `keepTokens`. The newest message that holds results is always kept, whatever
 * its size: the agent is about to read it.
 */
export function pruneCutoff(messages: StoredMessage[], keepTokens: number): number | null {
  let total = 0;
  let latestSeen = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    const tokens = outputTokens(message);
    if (tokens === null) continue;
    total += tokens;
    if (!latestSeen) {
      latestSeen = true;
      continue;
    }
    if (total > keepTokens) return message.seq + 1;
  }
  return null;
}

/**
 * The same messages, with results of PRUNE_MIN_TOKENS or more in messages
 * before `beforeSeq` replaced by a line. Nothing given is changed: a message
 * that loses output is copied, the others are returned as they are. Every call
 * keeps its result, so the history stays valid for providers that check.
 */
export function withPrunedOutput(messages: StoredMessage[], beforeSeq: number): StoredMessage[] {
  if (beforeSeq <= 0) return messages;
  const names = new Map<string, string>();
  let any = false;
  const out = messages.map((message) => {
    for (const block of message.content) if (block.type === 'tool_use') names.set(block.id, block.name);
    if (message.seq >= beforeSeq) return message;
    let changed = false;
    const content = message.content.map((block): ContentBlock => {
      if (block.type !== 'tool_result' || resultTokens(block) < PRUNE_MIN_TOKENS) return block;
      changed = true;
      return { ...block, content: [{ type: 'text', text: prunedStub(names.get(block.toolUseId) ?? 'tool') }] };
    });
    if (!changed) return message;
    any = true;
    return { ...message, content };
  });
  return any ? out : messages;
}
