import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StoredMessage } from '../../../src/shared/schemas/messages';
import { fuzzyFilter, fuzzyScore } from '../../../src/renderer/src/lib/fuzzy';
import { clearHistory, loadHistory, pushHistory } from '../../../src/renderer/src/lib/promptHistory';
import { buildTranscript, groupActivity } from '../../../src/renderer/src/features/session/transcriptModel';

describe('fuzzy matching for the command palette', () => {
  it('ranks a prefix over a word start over a substring over scattered letters', () => {
    const prefix = fuzzyScore('the', 'Theme: Dark')!;
    const wordStart = fuzzyScore('dark', 'Theme: Dark')!;
    const inside = fuzzyScore('eme', 'Theme: Dark')!;
    const scattered = fuzzyScore('tmd', 'Theme: Dark')!;
    expect(prefix).toBeGreaterThan(wordStart);
    expect(wordStart).toBeGreaterThan(inside);
    expect(inside).toBeGreaterThan(scattered);
    expect(fuzzyScore('xyz', 'Theme: Dark')).toBeNull();
  });

  it('needs every word of the query, in any order, ignoring case', () => {
    expect(fuzzyScore('DARK theme', 'Theme: Dark')).not.toBeNull();
    expect(fuzzyScore('dark sidebar', 'Theme: Dark')).toBeNull();
    expect(fuzzyScore('   ', 'anything')).toBe(0);
  });

  it('filters and sorts best first, keeping the original order for ties and an empty query', () => {
    const items = ['Toggle terminal', 'Show or hide the sidebar', 'Settings: Appearance', 'Theme: Light'];
    expect(fuzzyFilter(items, '', (s) => s)).toEqual(items);
    expect(fuzzyFilter(items, 'side', (s) => s)).toEqual(['Show or hide the sidebar']);
    // Both titles start with "t"; the shorter one ranks first, and both beat a "t" further in.
    expect(fuzzyFilter(items, 't', (s) => s).slice(0, 2)).toEqual(['Theme: Light', 'Toggle terminal']);
    expect(fuzzyFilter(items, 'appear', (s) => s)).toEqual(['Settings: Appearance']);
  });
});

describe('prompt history', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k)
    };
  });
  afterEach(() => {
    store.clear();
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it('keeps sent messages newest first, without blanks, repeats or huge entries', () => {
    pushHistory('first');
    pushHistory('  second  ');
    pushHistory('second');
    pushHistory('   ');
    pushHistory('x'.repeat(5000));
    pushHistory('first');
    expect(loadHistory()).toEqual(['first', 'second']);
    clearHistory();
    expect(loadHistory()).toEqual([]);
  });

  it('caps the list and survives broken or missing storage', () => {
    for (let i = 0; i < 130; i++) pushHistory(`message ${i}`);
    expect(loadHistory()).toHaveLength(100);
    expect(loadHistory()[0]).toBe('message 129');
    store.set('graft.prompt.history', '{not json');
    expect(loadHistory()).toEqual([]);
    delete (globalThis as { localStorage?: unknown }).localStorage;
    expect(loadHistory()).toEqual([]);
    expect(() => pushHistory('still fine')).not.toThrow();
  });
});

describe('shell commands in the transcript', () => {
  it('shows a "!" command as its own item, outside the turn work', () => {
    const shell = { command: 'git status', cwd: '/repo', exitCode: 0, output: 'clean', truncated: false, durationMs: 120, timedOut: false, interrupted: false };
    const messages: StoredMessage[] = [
      { id: 'u1', sessionId: 's', seq: 1, role: 'user', content: [{ type: 'text', text: 'hi' }], meta: {}, createdAt: 1 },
      { id: 'a1', sessionId: 's', seq: 2, role: 'assistant', content: [{ type: 'text', text: 'hello' }], meta: {}, createdAt: 2 },
      { id: 'sh', sessionId: 's', seq: 3, role: 'user', content: [{ type: 'text', text: '<user-shell-command …>' }], meta: { kind: 'shell', shell }, createdAt: 3 }
    ];
    const items = buildTranscript(messages, { streaming: null, running: {} });
    expect(items.map((i) => i.kind)).toEqual(['user', 'text', 'shell']);
    expect(items[2]).toMatchObject({ kind: 'shell', shell: { command: 'git status', output: 'clean' } });
  });

  it("keeps a turn's changed-files card with that turn when a \"!\" command follows it", () => {
    const shell = { command: 'npm test', cwd: '/repo', exitCode: 1, output: 'failed', truncated: false, durationMs: 900, timedOut: false, interrupted: false };
    const patch = '--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-x\n+y';
    const messages: StoredMessage[] = [
      { id: 'u1', sessionId: 's', seq: 1, role: 'user', content: [{ type: 'text', text: 'fix it' }], meta: {}, createdAt: 1 },
      { id: 'a1', sessionId: 's', seq: 2, role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'a.ts' } }], meta: {}, createdAt: 2 },
      {
        id: 'r1',
        sessionId: 's',
        seq: 3,
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: 't1', isError: false, content: [{ type: 'text', text: 'ok' }], display: { kind: 'edit', path: 'a.ts', created: false, patch, added: 1, removed: 1 } }],
        meta: {},
        createdAt: 3
      },
      { id: 'a2', sessionId: 's', seq: 4, role: 'assistant', content: [{ type: 'text', text: 'Fixed.' }], meta: {}, createdAt: 4 },
      { id: 'sh', sessionId: 's', seq: 5, role: 'user', content: [{ type: 'text', text: '…' }], meta: { kind: 'shell', shell }, createdAt: 5 }
    ];
    const kinds = groupActivity(buildTranscript(messages, { streaming: null, running: {} }), false).map((i) => i.kind);
    expect(kinds).toEqual(['user', 'activity', 'text', 'edits', 'shell']);
  });
});
