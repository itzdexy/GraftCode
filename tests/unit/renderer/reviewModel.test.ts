import { describe, expect, it } from 'vitest';
import { commentAnchor, commentsAt, parsePatch } from '../../../src/renderer/src/features/diff/diffModel';
import {
  capped,
  commentLine,
  commentPlace,
  commentsLabel,
  parseStored,
  quoteOf,
  selectionAnchor,
  withComments,
  type ReviewComment
} from '../../../src/renderer/src/features/review/reviewModel';

const c = (over: Partial<ReviewComment> = {}): ReviewComment => ({ id: 'a', at: 1, path: 'src/health.js', line: 14, endLine: 14, side: 'new', quote: 'return { status: 200, body }', text: 'Use 503 when the database is down.', ...over });

describe('a comment as the agent reads it', () => {
  it('names the place, quotes the line and says what to change', () => {
    expect(commentLine(c())).toBe('- src/health.js:14 `return { status: 200, body }` — Use 503 when the database is down.');
    expect(commentLine(c({ line: 20, endLine: 24, side: 'old', quote: 'const ok = await db.ping();', text: 'Keep this check.' }))).toBe('- src/health.js:20-24 (removed) `const ok = await db.ping();` — Keep this check.');
    expect(commentLine(c({ quote: '', text: 'Add a\nblank line  here.' }))).toBe('- src/health.js:14 — Add a blank line here.');
    expect(commentLine(c({ quote: 'const s = `a`;' }))).toBe("- src/health.js:14 `const s = 'a';` — Use 503 when the database is down.");
  });

  it('names its place the same way in the list above the message box', () => {
    expect(commentPlace(c())).toBe('src/health.js:14');
    expect(commentPlace(c({ line: 20, endLine: 24, side: 'old' }))).toBe('src/health.js:20-24 (removed)');
  });

  it('is cut to a line of 200 characters when quoted', () => {
    expect(quoteOf('   return x;  ')).toBe('return x;');
    expect(quoteOf('x'.repeat(300))).toHaveLength(200);
    expect(quoteOf('first\nsecond')).toBe('first');
  });
});

describe('comments going with a message', () => {
  const two = [c({ id: 'b', path: 'src/z.js', line: 3, endLine: 3 }), c({ id: 'a', line: 14 }), c({ id: 'c', line: 2, endLine: 2, quote: 'x', text: 'Y.' })];

  it('follow the message after a blank line, by file and line', () => {
    expect(withComments('Please fix these.', two)).toEqual({
      attached: true,
      text: 'Please fix these.\n\nComments on the code:\n- src/health.js:2 `x` — Y.\n- src/health.js:14 `return { status: 200, body }` — Use 503 when the database is down.\n- src/z.js:3 `return { status: 200, body }` — Use 503 when the database is down.'
    });
  });

  it('come in the order they were written when two are on one line', () => {
    const same = [c({ id: 'late', at: 9, text: 'Second.' }), c({ id: 'early', at: 2, text: 'First.' })];
    expect(withComments('x', same).text).toBe('x\n\nComments on the code:\n- src/health.js:14 `return { status: 200, body }` — First.\n- src/health.js:14 `return { status: 200, body }` — Second.');
  });

  it('stand under a line of their own when nothing was typed', () => {
    expect(withComments('  ', [c()]).text).toBe('Address these comments.\n\nComments on the code:\n- src/health.js:14 `return { status: 200, body }` — Use 503 when the database is down.');
  });

  it('wait when the message is a command, and add nothing when there are none', () => {
    expect(withComments('/compact', [c()])).toEqual({ text: '/compact', attached: false });
    expect(withComments('  ! npm test', [c()])).toEqual({ text: '  ! npm test', attached: false });
    expect(withComments('hello', [])).toEqual({ text: 'hello', attached: false });
  });

  it('are counted in words', () => {
    expect(commentsLabel(1)).toBe('1 comment');
    expect(commentsLabel(12)).toBe('12 comments');
  });
});

describe('what is kept', () => {
  it('is the newest 100 of a session and the 50 sessions commented on last', () => {
    const many = Array.from({ length: 101 }, (_, i) => c({ id: String(i), at: i }));
    expect(capped({ s: many }).s?.map((x) => x.id)).toEqual(many.slice(1).map((x) => x.id));
    const sessions = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`s${String(i)}`, [c({ at: i })]]));
    const kept = capped(sessions);
    expect(Object.keys(kept)).toHaveLength(50);
    expect(kept.s0).toBeUndefined();
    expect(capped({ empty: [] })).toEqual({});
  });

  it('is nothing when what was stored does not fit', () => {
    expect(parseStored(null)).toEqual({});
    expect(parseStored('not json')).toEqual({});
    expect(parseStored('{"s":[{"id":"a"}]}')).toEqual({});
    expect(parseStored('[1,2]')).toEqual({});
    expect(parseStored(JSON.stringify({ s: [c()] }))).toEqual({ s: [c()] });
  });
});

describe('where a comment sits in a diff', () => {
  const rows = parsePatch('--- a\n+++ b\n@@ -10,3 +10,3 @@\n ten\n-eleven\n+ELEVEN\n twelve\n');

  it('is the old line of a removed row and the new line of every other', () => {
    expect(rows.map(commentAnchor)).toEqual([null, { line: 10, side: 'new' }, { line: 11, side: 'old' }, { line: 11, side: 'new' }, { line: 12, side: 'new' }]);
  });

  it('shows a comment under the line it ends on, on its own side', () => {
    const list = [c({ id: 'r', line: 11, endLine: 11, side: 'old' }), c({ id: 'n', line: 10, endLine: 11, side: 'new' }), c({ id: 'x', line: 40, endLine: 40 })];
    expect(commentsAt(list, { line: 11, side: 'old' }).map((x) => x.id)).toEqual(['r']);
    expect(commentsAt(list, { line: 11, side: 'new' }).map((x) => x.id)).toEqual(['n']);
    expect(commentsAt(list, { line: 10, side: 'new' })).toEqual([]);
  });
});

describe('commenting from the editor', () => {
  const text = (line: number): string => ['', '  const a = 1;', '  const b = 2;', 'return a + b;'][line] ?? '';

  it('takes the line of the cursor, or the lines that are selected', () => {
    expect(selectionAnchor({ startLine: 2, endLine: 2, endColumn: 5 }, text)).toEqual({ line: 2, endLine: 2, quote: 'const b = 2;' });
    expect(selectionAnchor({ startLine: 1, endLine: 3, endColumn: 4 }, text)).toEqual({ line: 1, endLine: 3, quote: 'const a = 1;' });
    expect(selectionAnchor({ startLine: 1, endLine: 3, endColumn: 1 }, text)).toEqual({ line: 1, endLine: 2, quote: 'const a = 1;' });
    expect(selectionAnchor({ startLine: 2, endLine: 2, endColumn: 1 }, text)).toEqual({ line: 2, endLine: 2, quote: 'const b = 2;' });
  });
});
