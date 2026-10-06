import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../../src/shared/schemas/agentEvents';
import { createDeltaBuffer } from '../../../src/renderer/src/stores/deltaBuffer';
import { healMarkdown, nextReveal, splitBlocks } from '../../../src/renderer/src/features/session/streaming';

type Delta = Extract<AgentEvent, { type: 'assistant-delta' }>;
const delta = (text: string, kind: 'text' | 'thinking' = 'text', messageId = 'm1'): Delta => ({ type: 'assistant-delta', messageId, kind, text });

/** A buffer whose frame only arrives when the test says so. */
function harness() {
  const applied: Array<{ sessionId: string; deltas: Delta[] }> = [];
  const frames: Array<() => void> = [];
  const buffer = createDeltaBuffer(
    (sessionId, deltas) => applied.push({ sessionId, deltas }),
    (flush) => frames.push(flush)
  );
  return { applied, frames, buffer, frame: () => frames.splice(0).forEach((run) => run()) };
}

describe('streamed text waiting for the next frame', () => {
  it('joins the pieces of a reply that arrive within one frame into a single update', () => {
    const h = harness();
    h.buffer.push('s1', delta('Hel'));
    h.buffer.push('s1', delta('lo, '));
    h.buffer.push('s1', delta('world'));
    expect(h.applied).toEqual([]);
    expect(h.frames).toHaveLength(1);
    h.frame();
    expect(h.applied).toEqual([{ sessionId: 's1', deltas: [delta('Hello, world')] }]);
  });

  it('keeps thinking and text apart and in the order they came', () => {
    const h = harness();
    h.buffer.push('s1', delta('Weighing ', 'thinking'));
    h.buffer.push('s1', delta('options', 'thinking'));
    h.buffer.push('s1', delta('Done.'));
    h.frame();
    expect(h.applied[0]?.deltas).toEqual([delta('Weighing options', 'thinking'), delta('Done.')]);
  });

  it('hands over what is waiting at once when something else happens to the session', () => {
    const h = harness();
    h.buffer.push('s1', delta('almost '));
    h.buffer.push('s1', delta('there'));
    h.buffer.flush('s1');
    expect(h.applied).toEqual([{ sessionId: 's1', deltas: [delta('almost there')] }]);
    h.frame();
    expect(h.applied).toHaveLength(1);
  });

  it('keeps two sessions that stream at once apart', () => {
    const h = harness();
    h.buffer.push('s1', delta('one'));
    h.buffer.push('s2', delta('two', 'text', 'm2'));
    h.buffer.flush('s2');
    expect(h.applied).toEqual([{ sessionId: 's2', deltas: [delta('two', 'text', 'm2')] }]);
    h.frame();
    expect(h.applied[1]).toEqual({ sessionId: 's1', deltas: [delta('one')] });
  });

  it('asks for a new frame after each one it used', () => {
    const h = harness();
    h.buffer.push('s1', delta('a'));
    h.frame();
    h.buffer.push('s1', delta('b'));
    expect(h.frames).toHaveLength(1);
    h.frame();
    expect(h.applied.map((a) => a.deltas[0]?.text)).toEqual(['a', 'b']);
  });
});

describe('a long reply rendered in chunks', () => {
  const para = (n: number): string => `Paragraph ${String(n)} `.padEnd(180, 'x');
  const paras = (from: number, count: number): string => Array.from({ length: count }, (_, i) => para(from + i)).join('\n\n');

  it('keeps a short reply whole', () => {
    expect(splitBlocks('One short paragraph.')).toEqual(['One short paragraph.']);
    expect(splitBlocks(paras(1, 5))).toEqual([paras(1, 5)]);
  });

  it('cuts only between blocks, into chunks of a good size, and loses nothing', () => {
    const text = paras(1, 30);
    const chunks = splitBlocks(text);
    expect(chunks.join('')).toBe(text);
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk.length).toBeGreaterThanOrEqual(1200);
      expect(chunk.endsWith('\n\n')).toBe(true);
    }
  });

  it('never changes a chunk it has already cut as the reply grows, so settled text is not rendered again', () => {
    const text = `${paras(1, 12)}\n\n${['```ts', 'const a = 1;', '', 'const b = 2;', '```'].join('\n')}\n\n${paras(13, 12)}`;
    const full = splitBlocks(text);
    for (let length = 200; length < text.length; length += 37) {
      const settled = splitBlocks(text.slice(0, length)).slice(0, -1);
      expect(settled).toEqual(full.slice(0, settled.length));
    }
  });

  it('leaves the part still being written long enough to hide the seam', () => {
    const chunks = splitBlocks(`${paras(1, 8)}\n\nNew`);
    expect(chunks.at(-1)?.length).toBeGreaterThanOrEqual(160);
  });

  it('never cuts through a code block', () => {
    const code = ['```ts', ...Array.from({ length: 40 }, (_, i) => (i % 3 === 0 ? '' : `const line${String(i)} = ${'x'.repeat(60)};`)), '```'].join('\n');
    const text = `${paras(1, 8)}\n\n${code}\n\n${paras(9, 8)}`;
    const chunks = splitBlocks(text);
    expect(chunks.join('')).toBe(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.split('\n').filter((line) => line.startsWith('```')).length % 2).toBe(0);
  });

  it('keeps a list together, and what directly follows it, so numbering and spacing stay right', () => {
    const list = Array.from({ length: 12 }, (_, i) => `${String(i + 1)}. ${para(i)}`).join('\n\n');
    expect(splitBlocks(list)).toEqual([list]);
    const after = `${list}\n\n${para(99)}`;
    expect(splitBlocks(after)).toEqual([after]);
  });

  it('keeps a table and what directly follows it together', () => {
    const table = ['| a | b |', '|---|---|', ...Array.from({ length: 10 }, (_, i) => `| ${String(i)} | ${para(i)} |`)].join('\n');
    const text = `${table}\n\n${para(99)}`;
    expect(splitBlocks(text)).toEqual([text]);
  });

  it('leaves text with link definitions or footnotes in one piece, because they can point across a cut', () => {
    const refs = `${paras(1, 12)} [docs][d]\n\n[d]: https://example.com`;
    expect(splitBlocks(refs)).toEqual([refs]);
    const notes = `${para(1)}[^1]\n\n${paras(2, 12)}`;
    expect(splitBlocks(notes)).toEqual([notes]);
  });
});

describe('markdown that is still being typed', () => {
  it('closes bold that has opened but not closed yet, so the asterisks never show', () => {
    expect(healMarkdown('The **quick brown')).toBe('The **quick brown**');
    expect(healMarkdown('Both **closed** here')).toBe('Both **closed** here');
  });

  it('drops an opening mark with nothing after it yet', () => {
    expect(healMarkdown('The answer is **')).toBe('The answer is ');
    expect(healMarkdown('Run `')).toBe('Run ');
  });

  it('closes inline code that is still open', () => {
    expect(healMarkdown('Run `npm te')).toBe('Run `npm te`');
  });

  it('shows the label of a link whose address is still arriving', () => {
    expect(healMarkdown('See [the docs](https://exa')).toBe('See the docs');
    expect(healMarkdown('See [the docs](https://example.com) now')).toBe('See [the docs](https://example.com) now');
  });

  it('only mends the paragraph being written, and never touches an open code block', () => {
    expect(healMarkdown('A **bold** line\n\nNext **one')).toBe('A **bold** line\n\nNext **one**');
    const code = 'Here:\n\n```js\nconst s = `**not bold';
    expect(healMarkdown(code)).toBe(code);
    // A fence that has just opened, before its language arrives, is a code block too.
    expect(healMarkdown('Here:\n\n```')).toBe('Here:\n\n```');
    // …and once it has closed, the paragraph after it is mended again.
    expect(healMarkdown('```\ncode\n```\n\nThen **more')).toBe('```\ncode\n```\n\nThen **more**');
  });
});

describe('how fast streamed text is shown', () => {
  it('moves at a steady reading pace when little is waiting', () => {
    const text = 'word '.repeat(4);
    // 16ms at the base pace is a couple of characters; it finishes the word it lands in.
    expect(nextReveal(text, 0, 16)).toBe(4);
  });

  it('catches up quickly when a large piece arrives at once', () => {
    const text = 'word '.repeat(400);
    const shown = nextReveal(text, 0, 16);
    // 2,000 characters waiting are shown within about a third of a second: at least 90 in one frame.
    expect(shown).toBeGreaterThanOrEqual(90);
    expect(shown).toBeLessThanOrEqual(140);
  });

  it('never runs past what has arrived', () => {
    expect(nextReveal('short', 3, 1000)).toBe(5);
    expect(nextReveal('short', 5, 16)).toBe(5);
  });

  it('always moves forward, even on a very short frame', () => {
    expect(nextReveal('abcdef ghi', 0, 0)).toBeGreaterThan(0);
  });

  it('shows whole words, without stopping in the middle of one', () => {
    const text = 'internationalization is long';
    expect(nextReveal(text, 0, 16)).toBe('internationalization'.length);
  });
});
