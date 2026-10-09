import { afterEach, expect, it, vi } from 'vitest';
import type { ContentBlock, StoredMessage } from '../../../src/shared/schemas/messages';
import { buildTranscript, groupActivity, type LiveState } from '../../../src/renderer/src/features/session/transcriptModel';
import { createTranscriptProjection } from '../../../src/renderer/src/features/session/transcriptProjection';

function message(seq: number, role: StoredMessage['role'], content: ContentBlock[], meta: StoredMessage['meta'] = {}): StoredMessage {
  return { id: `m${seq}`, sessionId: 's', seq, role, content, meta, createdAt: seq };
}
const user = (seq: number, text = 'Question') => message(seq, 'user', [{ type: 'text', text }]);
const answer = (seq: number, text = 'Answer') => message(seq, 'assistant', [{ type: 'text', text }]);
const blank: LiveState = { streaming: null, running: {} };
afterEach(() => vi.restoreAllMocks());

it('matches the full projection through streaming, completion, append, rewind and unordered histories', () => {
  vi.spyOn(Date, 'now').mockReturnValue(1000);
  const project = createTranscriptProjection();
  const histories = [[], [user(1)], [user(1), answer(2), user(3)], [user(1), answer(2), user(3), answer(4)], [answer(4), user(3), answer(2), user(1)], [user(1)], [user(1), answer(2, 'Replacement answer')]];
  for (const messages of histories) for (const active of [true, false]) for (const live of [blank, { running: {}, streaming: { messageId: 'live', text: 'Current answer', thinking: 'Working' } }]) {
    expect(project(messages, live, active)).toEqual(groupActivity(buildTranscript(messages, live), active));
  }
});

it('keeps tool results, edits, todos, plans and background progress attached to their original turns', () => {
  const project = createTranscriptProjection();
  const messages = [user(1), message(2, 'assistant', [
    { type: 'thinking', text: 'Review', display: 'summary', origin: 'openai-compatible' },
    { type: 'tool_use', id: 'edit', name: 'Edit', input: {} },
    { type: 'tool_use', id: 'background', name: 'Shell', input: {} },
    { type: 'tool_use', id: 'todo', name: 'TodoWrite', input: { todos: [] } }
  ]), message(3, 'user', [{ type: 'tool_result', toolUseId: 'edit', isError: false, content: [], display: { kind: 'edit', path: 'a.ts', added: 1, removed: 1, created: false, patch: 'diff' } }]), answer(4), user(5)];
  const states: LiveState['running'][] = [{}, { background: { name: 'Shell', summary: 'Running', output: 'Output' } }, {}];
  for (const running of states) {
    const live = { streaming: null, running };
    expect(project(messages, live, true)).toEqual(groupActivity(buildTranscript(messages, live), true));
  }
  const mixed = [...messages.slice(0, -1), message(5, 'user', [{ type: 'text', text: 'Next question' }, { type: 'tool_result', toolUseId: 'background', isError: false, content: [] }])];
  expect(project(mixed, blank, false)).toEqual(groupActivity(buildTranscript(mixed, blank), false));
});

it('retains global turn indices and stable completed items while only live text changes', () => {
  const project = createTranscriptProjection();
  const messages = [user(1), answer(2), user(3), answer(4), user(5)];
  const first = project(messages, { running: blank.running, streaming: { messageId: 'live', text: 'First', thinking: '' } }, true);
  const second = project(messages, { running: blank.running, streaming: { messageId: 'live', text: 'First and second', thinking: '' } }, true);
  expect(second[0]).toBe(first[0]);
  expect(second[1]).toBe(first[1]);
  expect(second.filter(item => item.kind === 'user').map(item => item.turn)).toEqual([0, 1, 2]);
  expect(first.at(-1)).toMatchObject({ text: 'First' });
  expect(second.at(-1)).toMatchObject({ text: 'First and second' });
});

it('preserves mission and shell boundaries with notices, summaries and attached images', () => {
  const project = createTranscriptProjection();
  const messages = [user(1), answer(2), message(3, 'assistant', [{ type: 'text', text: 'Continue' }], { kind: 'mission', mission: { turn: 2, of: 3, afterChecks: true } }), answer(4), message(5, 'user', [{ type: 'image', mediaType: 'image/png', data: 'AAAA' }]), message(6, 'assistant', [{ type: 'text', text: 'Notice' }], { kind: 'notice' }), answer(7)];
  expect(project(messages, blank, false)).toEqual(groupActivity(buildTranscript(messages, blank), false));
});
