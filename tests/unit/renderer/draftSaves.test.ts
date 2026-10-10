import { beforeEach, describe, expect, it } from 'vitest';
import { draftSaves, type SaveTarget } from '../../../src/renderer/src/features/panels/draftSaves';
import { useEditorDrafts } from '../../../src/renderer/src/features/panels/editorDrafts';

const KEY = 'session:notes.txt';
const TARGET: SaveTarget = { key: KEY, path: 'notes.txt', view: 1 };
const rev = (letter: string): string => letter.repeat(64);
const draft = (): unknown => useEditorDrafts.getState().drafts[KEY];
const type = (content: string): void => useEditorDrafts.getState().change(KEY, content);

/** A disk that answers a write when the test says so, and what the view was told meanwhile. */
function disk() {
  const writes: Array<{ content: string; revision: string; done: (revision: string) => void; refuse: (message: string) => void }> = [];
  const told: string[] = [];
  const save = draftSaves<{ revision?: string }>({
    write: (_target, content, revision) =>
      new Promise((resolve, reject) => {
        writes.push({ content, revision, done: (next) => resolve({ revision: next }), refuse: (message) => reject(new Error(message)) });
      }),
    started: () => told.push('started'),
    saved: (_target, result) => told.push(`saved ${result.revision?.[0] ?? ''}`),
    failed: (_target, error) => told.push(`failed: ${(error as Error).message}`),
    settled: () => told.push('settled')
  });
  return { writes, told, save };
}

/** Lets what was promised happen. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  useEditorDrafts.setState({ drafts: {} });
  useEditorDrafts.getState().open(KEY, { path: 'notes.txt', content: 'before', revision: rev('a'), size: 6, media: null, binary: false, tooLarge: false });
});

describe('saving an editor draft', () => {
  it('writes the draft as it is in the editor now, against the revision it was opened at', () => {
    const { writes, save } = disk();
    type('first');
    // The editor puts each keystroke in the store at once; a save right behind the last one must see it.
    type('first, and the rest');
    save(TARGET);
    expect(writes.map((w) => [w.content, w.revision])).toEqual([['first, and the rest', rev('a')]]);
  });

  it('does nothing when nothing changed', () => {
    const { writes, told, save } = disk();
    save(TARGET);
    expect(writes).toEqual([]);
    expect(told).toEqual([]);
  });

  it('does not drop a save asked for while another is on its way: it runs when that one is back, with what was typed meanwhile', async () => {
    const { writes, told, save } = disk();
    type('one');
    save(TARGET);
    type('one two');
    save(TARGET);
    save(TARGET);
    // One write at a time: the next one must start from the revision the first one returns.
    expect(writes).toHaveLength(1);
    writes[0]!.done(rev('b'));
    await settle();
    expect(writes.map((w) => [w.content, w.revision])).toEqual([['one', rev('a')], ['one two', rev('b')]]);
    writes[1]!.done(rev('c'));
    await settle();
    expect(writes).toHaveLength(2);
    expect(draft()).toEqual({ content: 'one two', original: 'one two', revision: rev('c') });
    expect(told).toEqual(['started', 'saved b', 'settled', 'started', 'saved c', 'settled']);
  });

  it('writes once when a second save was asked for and nothing more was typed', async () => {
    const { writes, save } = disk();
    type('one');
    save(TARGET);
    save(TARGET);
    writes[0]!.done(rev('b'));
    await settle();
    expect(writes).toHaveLength(1);
    expect(draft()).toEqual({ content: 'one', original: 'one', revision: rev('b') });
  });

  it('says so when the disk refuses, keeps the draft, and tries again the next time it is asked', async () => {
    const { writes, told, save } = disk();
    type('mine');
    save(TARGET);
    writes[0]!.refuse('The file changed on disk after this draft was opened.');
    await settle();
    expect(told).toEqual(['started', 'failed: The file changed on disk after this draft was opened.', 'settled']);
    expect(draft()).toEqual({ content: 'mine', original: 'before', revision: rev('a') });
    // Asking again is answered again, never met with silence.
    save(TARGET);
    expect(writes.map((w) => [w.content, w.revision])).toEqual([['mine', rev('a')], ['mine', rev('a')]]);
  });

  it('saves the file a queued save was asked for, not the one that happened to be saving', async () => {
    const { writes, save } = disk();
    const other = 'session:other.txt';
    useEditorDrafts.getState().open(other, { path: 'other.txt', content: 'other', revision: rev('x'), size: 5, media: null, binary: false, tooLarge: false });
    type('one');
    save(TARGET);
    useEditorDrafts.getState().change(other, 'other, edited');
    save({ key: other, path: 'other.txt', view: 2 });
    writes[0]!.done(rev('b'));
    await settle();
    expect(writes.map((w) => [w.content, w.revision])).toEqual([['one', rev('a')], ['other, edited', rev('x')]]);
  });
});
