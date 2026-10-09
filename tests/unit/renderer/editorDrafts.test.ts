import { beforeEach, describe, expect, it } from 'vitest';
import { useEditorDrafts } from '../../../src/renderer/src/features/panels/editorDrafts';

beforeEach(() => { useEditorDrafts.setState({ drafts: {} }); });
describe('editor draft ownership', () => {
  it('preserves a dirty draft on reopening instead of replacing it with a newer disk version', () => {
    const state = useEditorDrafts.getState();
    const preview = { path: 'a.ts', content: 'before', revision: 'a'.repeat(64), size: 6, media: null, binary: false, tooLarge: false };
    state.open('session:a.ts', preview); state.change('session:a.ts', 'draft');
    state.open('session:a.ts', { ...preview, content: 'external', revision: 'b'.repeat(64) });
    expect(useEditorDrafts.getState().drafts['session:a.ts']).toEqual({ content: 'draft', original: 'before', revision: 'a'.repeat(64) });
  });
  it('keeps typing during a save dirty against the completed revision, and isolates sessions', () => {
    const state = useEditorDrafts.getState();
    state.open('one:a.ts', { path: 'a.ts', content: 'before', revision: 'a'.repeat(64), size: 6, media: null, binary: false, tooLarge: false });
    state.change('one:a.ts', 'first save'); state.change('one:a.ts', 'typed while saving');
    state.saved('one:a.ts', 'first save', 'b'.repeat(64));
    expect(useEditorDrafts.getState().drafts['one:a.ts']).toEqual({ content: 'typed while saving', original: 'first save', revision: 'b'.repeat(64) });
    expect(useEditorDrafts.getState().drafts['two:a.ts']).toBeUndefined();
    state.discard('one:a.ts'); expect(useEditorDrafts.getState().drafts['one:a.ts']).toBeUndefined();
  });
  it('refreshes clean buffers, restores dirty copies without replacing newer typing, and forgets deleted sessions', () => {
    const s = useEditorDrafts.getState();
    const preview = { path: 'a.ts', content: 'before', revision: 'a'.repeat(64), size: 6, media: null, binary: false, tooLarge: false };
    s.open('one:a.ts', preview); s.open('one:a.ts', { ...preview, content: 'latest', revision: 'b'.repeat(64) });
    expect(useEditorDrafts.getState().drafts['one:a.ts']?.original).toBe('latest');
    s.restore('one', [{ path: 'a.ts', content: 'recovered', original: 'before', revision: 'a'.repeat(64) }]);
    s.change('one:a.ts', 'new typing');
    s.restore('one', [{ path: 'a.ts', content: 'older recovery', original: 'before', revision: 'a'.repeat(64) }]);
    expect(useEditorDrafts.getState().drafts['one:a.ts']?.content).toBe('new typing');
    s.open('two:a.ts', preview); s.forgetSession('one');
    expect(useEditorDrafts.getState().drafts['one:a.ts']).toBeUndefined();
    expect(useEditorDrafts.getState().drafts['two:a.ts']?.content).toBe('before');
  });
});
