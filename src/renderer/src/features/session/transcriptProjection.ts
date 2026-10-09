import type { StoredMessage } from '@shared/schemas/messages';
import { buildTranscript, groupActivity, type LiveState, type TranscriptItem } from './transcriptModel';

const BOOKKEEPING = new Set(['reminder', 'compaction-summary', 'command-output', 'notice', 'check']);

function startsSegment(message: StoredMessage): boolean {
  const kind = message.meta.kind ?? 'normal';
  if (kind === 'shell' || kind === 'mission') return true;
  if (BOOKKEEPING.has(kind) || message.role !== 'user') return false;
  const text = message.meta.typed ?? message.content.filter(b => b.type === 'text').map(b => b.text).join('');
  return text.trim().length > 0 || message.content.some(b => b.type === 'image') || (message.meta.attachments?.length ?? 0) > 0;
}

/** A component-local cache of completed turns; live text only rebuilds the current turn. */
export function createTranscriptProjection() {
  let previousMessages: StoredMessage[] | null = null;
  let previousRunning: LiveState['running'] | null = null;
  let boundary = 0;
  let prefix: TranscriptItem[] = [];
  let tail: StoredMessage[] = [];
  let turnOffset = 0;
  return (messages: StoredMessage[], live: LiveState, turnActive: boolean): TranscriptItem[] => {
    if (messages !== previousMessages || live.running !== previousRunning) {
      previousMessages = messages;
      previousRunning = live.running;
      const ordered = [...messages].sort((a, b) => a.seq - b.seq);
      boundary = ordered.findLastIndex(startsSegment);
      // A mixed user/tool-result record can resolve a call in an earlier segment.
      // Keep the full path for this uncommon history instead of breaking that link.
      if (boundary < 0 || ordered[boundary]?.content.some(b => b.type === 'tool_result')) boundary = 0;
      const before = buildTranscript(ordered.slice(0, boundary), { streaming: null, running: live.running });
      turnOffset = before.filter(item => item.kind === 'user').length;
      prefix = groupActivity(before, false);
      tail = ordered.slice(boundary);
    }
    const current = buildTranscript(tail, live);
    for (const item of current) if (item.kind === 'user') item.turn += turnOffset;
    return [...prefix, ...groupActivity(current, turnActive)];
  };
}
