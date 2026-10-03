import type { ContentBlock, LlmMessage, StoredMessage } from '@shared/schemas/messages';

/**
 * Turns stored messages into what a provider sees:
 *  - messages replaced by a compaction summary are skipped,
 *  - UI-only fields (tool display metadata) are dropped,
 *  - every tool_use gets a tool_result (interrupted turns are repaired so
 *    the history is always valid for strict providers),
 *  - notices shown only to the user are not sent.
 * Messages are never edited after they are sent: replay stays append-only.
 */
export function toLlmHistory(messages: StoredMessage[]): LlmMessage[] {
  const visible = messages.filter((m) => !m.meta.compacted && m.meta.kind !== 'notice' && m.meta.kind !== 'command-output');
  const out: LlmMessage[] = [];
  for (let i = 0; i < visible.length; i++) {
    const message = visible[i]!;
    const content = message.content
      .map((block): ContentBlock => (block.type === 'tool_result' ? { type: 'tool_result', toolUseId: block.toolUseId, content: block.content, isError: block.isError } : block))
      .filter((block) => !(block.type === 'text' && block.text.length === 0));
    if (content.length === 0) continue;
    out.push({ role: message.role, content });
    if (message.role !== 'assistant') continue;
    const calls = content.filter((b) => b.type === 'tool_use').map((b) => (b.type === 'tool_use' ? b.id : ''));
    if (calls.length === 0) continue;
    const next = visible[i + 1];
    const answered = new Set(
      next?.role === 'user' ? next.content.filter((b) => b.type === 'tool_result').map((b) => (b.type === 'tool_result' ? b.toolUseId : '')) : []
    );
    const missing = calls.filter((id) => !answered.has(id));
    if (missing.length === 0) continue;
    const repairs: ContentBlock[] = missing.map((id) => ({
      type: 'tool_result',
      toolUseId: id,
      isError: true,
      content: [{ type: 'text', text: 'Not run: the turn was interrupted.' }]
    }));
    if (next?.role === 'user') {
      // Results must lead the next user message; prepend the repairs to it.
      visible[i + 1] = { ...next, content: [...repairs, ...next.content] };
    } else {
      out.push({ role: 'user', content: repairs });
    }
  }
  return mergeAdjacent(out);
}

/** When a message was sent, in this computer's time zone: "Fri, Oct 2, 2026, 3:04 PM EDT (America/New_York)". */
export function sentStamp(ms: number, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): string {
  const when = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
    timeZone
  }).format(new Date(ms));
  return `[Sent ${when} (${timeZone})]`;
}

/**
 * Starts each message the user typed with the time it was sent, so a chat
 * can answer "what time is it" without a tool. The stamp comes from the
 * stored time, so replays (and provider caches) stay stable.
 */
export function withSentTimes(messages: StoredMessage[], timeZone?: string): StoredMessage[] {
  return messages.map((m) =>
    m.role === 'user' && (m.meta.kind === undefined || m.meta.kind === 'normal') && !m.content.some((b) => b.type === 'tool_result')
      ? { ...m, content: [{ type: 'text', text: sentStamp(m.createdAt, timeZone) }, ...m.content] }
      : m
  );
}

/** Joins consecutive same-role messages (some providers reject them). */
export function mergeAdjacent(messages: LlmMessage[]): LlmMessage[] {
  const out: LlmMessage[] = [];
  for (const m of messages) {
    const last = out.at(-1);
    if (last && last.role === m.role) {
      // Tool results must stay first in a user message.
      const results = [...last.content, ...m.content].filter((b) => b.type === 'tool_result');
      const rest = [...last.content, ...m.content].filter((b) => b.type !== 'tool_result');
      out[out.length - 1] = { role: m.role, content: m.role === 'user' ? [...results, ...rest] : [...last.content, ...m.content] };
    } else {
      out.push({ role: m.role, content: [...m.content] });
    }
  }
  return out;
}

/** Removes provider thinking blocks (used after a model switch or a history rewrite). */
export function withoutThinking(messages: LlmMessage[]): LlmMessage[] {
  return messages
    .map((m) => ({ ...m, content: m.content.filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking') }))
    .filter((m) => m.content.length > 0);
}
