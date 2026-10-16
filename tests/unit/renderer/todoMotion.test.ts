import { describe, expect, it } from 'vitest';
import { changedTodos, todoKey } from '../../../src/renderer/src/features/session/todoMotion';
import { buildTranscript } from '../../../src/renderer/src/features/session/transcriptModel';
import type { ContentBlock, StoredMessage } from '../../../src/shared/schemas/messages';
import type { TodoItem } from '../../../src/shared/schemas/toolDisplay';

const todo = (id: string, status: TodoItem['status']): TodoItem => ({ id, content: id || 'task', status });

describe('tasks that changed state', () => {
  it('are none when there was no list before', () => {
    expect(changedTodos(null, [todo('a', 'completed'), todo('b', 'pending')])).toEqual([]);
  });

  it('are the ones whose state is new, and not the ones new to the list', () => {
    const before = [todo('a', 'in_progress'), todo('b', 'pending'), todo('c', 'pending')];
    expect(changedTodos(before, [todo('a', 'completed'), todo('b', 'in_progress'), todo('c', 'pending'), todo('d', 'pending')])).toEqual(['a', 'b']);
  });

  it('are found by their words when every list brings new ids', () => {
    const before: TodoItem[] = [{ id: 'x1', content: 'Read the code', status: 'in_progress' }, { id: 'x2', content: 'Write the fix', status: 'pending' }];
    const after: TodoItem[] = [{ id: 'y1', content: 'Read the code', status: 'completed' }, { id: 'y2', content: 'Write the fix', status: 'pending' }, { id: 'y3', content: 'Test it', status: 'pending' }];
    expect(changedTodos(before, after)).toEqual(['y1']);
  });

  it('are found by their place when they have no id', () => {
    expect(todoKey(todo('', 'pending'), 1)).toBe('1');
    expect(changedTodos([todo('', 'pending'), todo('', 'pending')], [todo('', 'pending'), todo('', 'completed')])).toEqual(['1']);
  });
});

describe('the task lists of a conversation', () => {
  let n = 0;
  const message = (role: StoredMessage['role'], content: ContentBlock[]): StoredMessage => {
    n++;
    return { id: `m${String(n)}`, sessionId: 's', seq: n, role, content, meta: {}, createdAt: n };
  };
  const write = (id: string, todos: TodoItem[]): StoredMessage => message('assistant', [{ type: 'tool_use', id, name: 'TodoWrite', input: { todos } }]);
  const user = (text: string): StoredMessage => message('user', [{ type: 'text', text }]);
  const changedOf = (messages: StoredMessage[]): string[][] => buildTranscript(messages, { streaming: null, running: {} }).flatMap((item) => (item.kind === 'todos' ? [item.changed] : []));

  it('say which tasks changed since the list before, within one turn', () => {
    const first = [todo('a', 'pending'), todo('b', 'pending')];
    const second = [todo('a', 'completed'), todo('b', 'pending')];
    expect(changedOf([user('go'), write('t1', first), write('t2', second)])).toEqual([[], ['a']]);
  });

  it('start afresh with every message of the user, so a finished turn never depends on the one before', () => {
    const first = [todo('a', 'pending')];
    const second = [todo('a', 'completed')];
    expect(changedOf([user('go'), write('t1', first), user('again'), write('t2', second)])).toEqual([[], []]);
  });
});
