import type { ContentBlock, StoredMessage, ToolResultBlock } from '@shared/schemas/messages';
import type { SessionStore } from '../db/sessionsRepo';
import { isSent, NOT_RUN } from './history';

export { NOT_RUN };

/**
 * A tool call written down just before it runs. If the app stops while it runs, this is
 * all that is known: that it started, not how it ended.
 */
export interface JournalStart {
  sessionId: string;
  toolUseId: string;
  /** The call of the turn's own agent this one belongs to: itself, or the Task or RunAgents call whose agent made it. */
  rootId: string;
  /** The agent that made the call; null for the turn's own. */
  agent: string | null;
  name: string;
  /** What the user was shown for it: "Run npm test". */
  summary: string;
  /** 'read' changes nothing, so running it again does no harm. */
  effect: 'read' | 'change';
  startedAt: number;
}

export interface JournalEntry extends JournalStart {
  /** Null while only the intent is recorded. */
  endedAt: number | null;
  /** What it returned, as it would have gone into the conversation. */
  result: ToolResultBlock | null;
}

/** What a loop writes down about its tool calls (see LoopHost.journal). */
export interface LoopJournal {
  /** Before the tool starts. */
  started(call: { id: string; name: string; summary: string; effect: 'read' | 'change' }, agent: string | null): void;
  /** When it has returned, failed, timed out or been stopped. */
  finished(toolUseId: string, result: ToolResultBlock): void;
  /** When the results are stored in the conversation: nothing is left to reconcile for these calls. */
  settled(toolUseIds: string[]): void;
}

/** Why calls were left without an answer: the app stopped, or the turn failed before it stored them. */
export type Cut = 'stopped' | 'failed';

const what = (cut: Cut): string => (cut === 'stopped' ? 'Graft stopped' : 'The turn ended');

export const outcomeUnknown = (cut: Cut): string =>
  `Outcome unknown: ${what(cut)} while this was running, so it may have finished, stopped partway or never started. Do not assume either way: check what it left behind before you repeat it.`;
export const notFinished = (cut: Cut): string => `Not finished: ${what(cut)} while this was running. It changes nothing, so it can simply be run again.`;
export const recordedNote = (cut: Cut): string => `(${what(cut)} right after this finished. The result above was recorded then; the turn did not go on.)`;

export const OUTCOME_UNKNOWN = outcomeUnknown('stopped');
export const NOT_FINISHED = notFinished('stopped');
export const RECORDED_NOTE = recordedNote('stopped');

const MAX_RESULT_CHARS = 200_000;
const KEPT_TEXT_CHARS = 20_000;
/** Actions of an agent listed under the call that started it; the earlier ones are counted. */
const LISTED_ACTIONS = 20;
const NAMED_IN_NOTE = 3;

function textOf(content: ToolResultBlock['content']): string {
  return content.map((part) => (part.type === 'text' ? part.text : '')).filter((part) => part.length > 0).join('\n');
}

/** A result as the journal keeps it: whole when it is small enough, otherwise the start of its text without pictures. */
export function keepable(block: ToolResultBlock): ToolResultBlock {
  if (JSON.stringify(block).length <= MAX_RESULT_CHARS) return block;
  const text = textOf(block.content);
  return {
    type: 'tool_result',
    toolUseId: block.toolUseId,
    isError: block.isError,
    content: [{ type: 'text', text: `${text.slice(0, KEPT_TEXT_CHARS)}\n[The rest of this result was not kept.]` }]
  };
}

export interface Reconciliation {
  /** Finished before the stop: their recorded results were put into the conversation. */
  recovered: JournalEntry[];
  /** Were running and may have changed something. */
  unknown: JournalEntry[];
  /** Were running and change nothing. */
  unfinished: JournalEntry[];
  /** Asked for, never started. */
  notRun: number;
  /** What was added to the conversation: the answers, then the note for the user. */
  messages: StoredMessage[];
}

function refusal(toolUseId: string, message: string): ToolResultBlock {
  return { type: 'tool_result', toolUseId, isError: true, content: [{ type: 'text', text: message }], display: { kind: 'error', message } };
}

/** What an agent had done under a call that was still running, oldest first. */
function agentActions(children: JournalEntry[]): string[] {
  if (children.length === 0) return [];
  const shown = children.slice(-LISTED_ACTIONS);
  const lines = shown.map((child) => {
    // The summaries are the labels the transcript shows ("Ran npm test"), so they are quoted as such.
    if (child.endedAt === null) return `- still running, ${child.effect === 'change' ? 'outcome unknown' : 'changes nothing'}: “${child.summary}”`;
    return `- finished${child.result?.isError ? ' with an error' : ''}: “${child.summary}”`;
  });
  const earlier = children.length - shown.length;
  return ['What the agent it started had done by then:', ...(earlier > 0 ? [`- ${String(earlier)} earlier ${earlier === 1 ? 'action' : 'actions'}`] : []), ...lines];
}

function named(entries: JournalEntry[]): string {
  const names = entries.slice(0, NAMED_IN_NOTE).map((entry) => `“${entry.summary}”`);
  const more = entries.length - names.length;
  return more > 0 ? `${names.join(', ')} and ${String(more)} more` : names.join(', ');
}

function noteFor(found: Reconciliation, cut: Cut): string {
  return [
    cut === 'stopped' ? 'Graft stopped while this session was working.' : 'The last turn ended before its results were stored.',
    ...(found.unknown.length > 0 ? [`Outcome unknown: ${named(found.unknown)}.`] : []),
    ...(found.unfinished.length > 0 ? [`Not finished, safe to run again: ${named(found.unfinished)}.`] : []),
    ...(found.recovered.length > 0 ? [`Finished before the stop, result kept: ${named(found.recovered)}.`] : []),
    ...(found.notRun > 0 ? [`Not started: ${String(found.notRun)} ${found.notRun === 1 ? 'action' : 'actions'}.`] : []),
    'The agent has been told, and is asked to check before it repeats anything.'
  ].join(' ');
}

/**
 * After the app stopped in the middle of a turn: answers the tool calls the conversation still
 * has open from what was written down about them, and says so in the transcript.
 *
 * Three cases are told apart, which the conversation alone cannot do. A call that finished has
 * its recorded result put back. A call that had started and never ended has an unknown outcome:
 * the agent is told to check before repeating it, unless it changes nothing. A call that never
 * started was not run. The answers are stored, so the conversation reads the same from then on.
 *
 * Returns null when the journal had nothing to add.
 */
export function reconcileInterrupted(store: SessionStore, sessionId: string, cut: Cut = 'stopped'): Reconciliation | null {
  const entries = store.journalOpen(sessionId);
  if (entries.length === 0) return null;
  const clear = (): void => store.journalSettle(sessionId, [...new Set(entries.map((entry) => entry.rootId))]);
  const last = store.listMessages(sessionId).filter(isSent).at(-1);
  const calls = last?.role === 'assistant' ? last.content.flatMap((block) => (block.type === 'tool_use' ? [block] : [])) : [];
  if (calls.length === 0) {
    // The results reached the conversation; only forgetting the calls was cut short.
    clear();
    return null;
  }

  const byId = new Map(entries.map((entry) => [entry.toolUseId, entry]));
  const found: Reconciliation = { recovered: [], unknown: [], unfinished: [], notRun: 0, messages: [] };
  const answers: ContentBlock[] = calls.map((call) => {
    const entry = byId.get(call.id);
    if (!entry) {
      found.notRun++;
      return refusal(call.id, NOT_RUN);
    }
    if (entry.endedAt !== null && entry.result) {
      found.recovered.push(entry);
      return { ...entry.result, toolUseId: call.id, content: [...entry.result.content, { type: 'text', text: recordedNote(cut) }] };
    }
    const children = entries.filter((other) => other.rootId === call.id && other.toolUseId !== call.id);
    if (entry.effect === 'read' && children.every((child) => child.effect === 'read')) {
      found.unfinished.push(entry);
      return refusal(call.id, notFinished(cut));
    }
    found.unknown.push(entry);
    return refusal(call.id, [outcomeUnknown(cut), ...agentActions(children)].join('\n'));
  });

  found.messages.push(store.appendMessage(sessionId, 'user', answers, last?.meta.turnId ? { turnId: last.meta.turnId } : {}));
  found.messages.push(store.appendMessage(sessionId, 'assistant', [{ type: 'text', text: noteFor(found, cut) }], { kind: 'notice' }));
  clear();
  return found;
}
