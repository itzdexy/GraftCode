import { describe, expect, it } from 'vitest';
import type { ContentBlock, StoredMessage } from '../../src/shared/schemas/messages';
import { pruneCutoff, prunedStub, withPrunedOutput } from '../../src/main/agent/prune';

let seq = 0;
const msg = (role: 'user' | 'assistant', content: ContentBlock[]): StoredMessage => ({ id: `m${String(++seq)}`, sessionId: 's', seq, role, content, meta: {}, createdAt: 0 });
const called = (id: string, name: string) => msg('assistant', [{ type: 'tool_use', id, name, input: {} }]);
const result = (id: string, text: string, isError = false) => msg('user', [{ type: 'tool_result', toolUseId: id, isError, content: [{ type: 'text', text }] }]);
const big = 'x'.repeat(35_000); // 10,000 tokens
const small = 'y'.repeat(350); // 100 tokens
const textOf = (m: StoredMessage) => JSON.stringify(m.content);

describe('removing old tool output', () => {
  const history = [msg('user', [{ type: 'text', text: 'go' }]), called('a', 'Read'), result('a', big), called('b', 'Grep'), result('b', big), called('c', 'Read'), result('c', big)];

  it('keeps the newest output that fits, and always the latest step', () => {
    expect(pruneCutoff(history, 100_000)).toBeNull();
    expect(pruneCutoff(history, 15_000)).toBe(history[4]!.seq + 1);
    expect(pruneCutoff(history, 1)).toBe(history[4]!.seq + 1);
    expect(pruneCutoff([history[0]!, called('z', 'Read'), result('z', big)], 1)).toBeNull();
    // Output that is too small to be worth removing doesn't count against what is kept.
    expect(pruneCutoff([called('q', 'Glob'), result('q', small), ...history], 100_000)).toBeNull();
  });

  it('puts a line in place of each removed result, naming the tool, and changes nothing it was given', () => {
    const pruned = withPrunedOutput(history, history[4]!.seq + 1);
    expect(pruned[2]!.content).toEqual([{ type: 'tool_result', toolUseId: 'a', isError: false, content: [{ type: 'text', text: prunedStub('Read') }] }]);
    expect(textOf(pruned[4]!)).toContain('[The output of this Grep call was removed to save context. Run it again if you need it.]');
    expect(pruned[6]).toBe(history[6]);
    expect(pruned[1]).toBe(history[1]);
    expect(textOf(history[2]!)).toContain(big);
    // Nothing is removed before the first message, and a cutoff of 0 is no cutoff.
    expect(withPrunedOutput(history, 0)).toBe(history);
  });

  it('leaves small results alone, and removes pictures and long errors like anything else', () => {
    const picture = msg('user', [{ type: 'tool_result', toolUseId: 'p', isError: false, content: [{ type: 'image', mediaType: 'image/png', data: 'AAAA' }] }]);
    const mixed = [called('s', 'Glob'), result('s', small), called('p', 'Browser'), picture, called('e', 'Shell'), result('e', big, true), called('n', 'Read'), result('n', small)];
    const pruned = withPrunedOutput(mixed, mixed[7]!.seq);
    expect(pruned[1]).toBe(mixed[1]);
    expect(textOf(pruned[3]!)).toContain(prunedStub('Browser'));
    expect(textOf(pruned[3]!)).not.toContain('AAAA');
    expect(pruned[5]!.content[0]).toMatchObject({ type: 'tool_result', isError: true, content: [{ type: 'text', text: prunedStub('Shell') }] });
    expect(prunedStub('')).toBe('[The output of this tool call was removed to save context. Run it again if you need it.]');
  });

  it('keeps what else a message holds, and names a call it cannot find “tool”', () => {
    const both = msg('user', [
      { type: 'tool_result', toolUseId: 'gone', isError: false, content: [{ type: 'text', text: big }] },
      { type: 'tool_result', toolUseId: 'tiny', isError: false, content: [{ type: 'text', text: small }] },
      { type: 'text', text: 'and a word from the user' }
    ]);
    const [pruned] = withPrunedOutput([both], both.seq + 1);
    expect(pruned!.content).toHaveLength(3);
    expect(pruned!.content[0]).toMatchObject({ toolUseId: 'gone', content: [{ type: 'text', text: prunedStub('tool') }] });
    expect(pruned!.content[1]).toBe(both.content[1]);
    expect(pruned!.content[2]).toBe(both.content[2]);
    expect(pruned).toMatchObject({ id: both.id, seq: both.seq, role: 'user', meta: {} });
  });
});
