import { describe, expect, it } from 'vitest';
import { draftsToStore, MAX_DRAFT_LENGTH, MAX_DRAFTS, mayStore, trackPrivate } from '../../../src/renderer/src/lib/draftStore';

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

describe('drafts typed in private', () => {
  const session = (incognito: boolean) => ({ incognito });

  it('are flagged the moment text is set in private, and stay flagged until the box is emptied', () => {
    const flagged = new Set<string>();
    trackPrivate(flagged, 'home:chat', 'a private thought', true);
    expect(flagged.has('home:chat')).toBe(true);
    // The incognito switch goes off without the message being sent: what was typed is still private.
    trackPrivate(flagged, 'home:chat', 'a private thought, continued', false);
    expect(flagged.has('home:chat')).toBe(true);
    trackPrivate(flagged, 'home:chat', '', false);
    expect(flagged.has('home:chat')).toBe(false);
    // Typed afresh with the switch off, it is an ordinary draft.
    trackPrivate(flagged, 'home:chat', 'hello', false);
    expect(flagged.has('home:chat')).toBe(false);
  });

  it('are never stored, whatever happens to their chat afterwards', () => {
    const flagged = new Set(['incognito-1', 'home:chat']);
    const atStart = new Set<string>();
    // While the chat exists, after it was deleted (no summary left), and on Chat home.
    expect(mayStore('incognito-1', flagged, { 'incognito-1': session(true) }, atStart)).toBe(false);
    expect(mayStore('incognito-1', flagged, {}, atStart)).toBe(false);
    expect(mayStore('home:chat', flagged, {}, atStart)).toBe(false);
  });

  it('lets an ordinary draft be stored only for a session that is known, or was stored before', () => {
    const none = new Set<string>();
    expect(mayStore('home:code', none, {}, none)).toBe(true);
    expect(mayStore('s1', none, { s1: session(false) }, none)).toBe(true);
    expect(mayStore('s1', none, { s1: session(true) }, none)).toBe(false);
    // A session nobody knows: its chat may have been incognito and is gone. Not stored.
    expect(mayStore('gone', none, {}, none)).toBe(false);
    // Read from storage at start, before the list of sessions has loaded: it was allowed then, so it stays.
    expect(mayStore('s2', none, {}, new Set(['s2']))).toBe(true);
  });
});
