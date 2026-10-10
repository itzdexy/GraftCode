import { describe, expect, it } from 'vitest';
import { draftsToStore, MAX_DRAFT_LENGTH, MAX_DRAFTS } from '../../../src/renderer/src/lib/draftStore';

describe('drafts kept across a restart', () => {
  const all = (): boolean => true;

  it('keeps what the caller allows and leaves out empty and huge drafts', () => {
    const drafts = { 'home:code': 'fix the build', 'home:chat': 'a private thought', s1: 'half a message', s2: '', s3: 'x'.repeat(MAX_DRAFT_LENGTH + 1) };
    expect(draftsToStore(drafts, all)).toEqual({ 'home:code': 'fix the build', 'home:chat': 'a private thought', s1: 'half a message' });
    // An incognito chat's draft is the caller's to refuse.
    expect(draftsToStore(drafts, (key) => key !== 'home:chat' && key !== 's1')).toEqual({ 'home:code': 'fix the build' });
  });

  it('keeps only the newest drafts when there are too many', () => {
    const many = Object.fromEntries(Array.from({ length: MAX_DRAFTS + 5 }, (_, i) => [`s${String(i)}`, `draft ${String(i)}`]));
    const kept = Object.keys(draftsToStore(many, all));
    expect(kept).toHaveLength(MAX_DRAFTS);
    expect(kept[0]).toBe('s5');
    expect(kept.at(-1)).toBe(`s${String(MAX_DRAFTS + 4)}`);
  });
});
