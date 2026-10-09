import { create } from 'zustand';
import type { FilePreviewView } from '@shared/schemas/panels';
import type { EditorDraft } from '@shared/schemas/editorDrafts';
export type { EditorDraft } from '@shared/schemas/editorDrafts';

/** Drafts are backed up separately from project files; never sent to a model automatically. */
export const useEditorDrafts = create<{
  drafts: Record<string, EditorDraft>;
  recovery: Record<string, { state: 'pending' | 'backed-up' | 'error'; message?: string }>;
  restore(sessionId: string, drafts: Array<EditorDraft & { path: string }>): void;
  open(key: string, preview: FilePreviewView): void;
  change(key: string, content: string): void;
  saved(key: string, content: string, revision: string): void;
  discard(key: string): void;
  forgetSession(sessionId: string): void;
}>((set) => ({
  drafts: {},
  recovery: {},
  restore: (sessionId, recovered) => set((state) => {
    const drafts = { ...state.drafts };
    for (const d of recovered) {
      const key = `${sessionId}:${d.path}`, old = drafts[key];
      if (!old || old.content === old.original) drafts[key] = { content: d.content, original: d.original, revision: d.revision };
    }
    return { drafts };
  }),
  open: (key, preview) => set((state) => (state.drafts[key] && state.drafts[key].content !== state.drafts[key].original) || preview.content === null || !preview.revision ? state : {
    drafts: { ...state.drafts, [key]: { content: preview.content, original: preview.content, revision: preview.revision } }
  }),
  change: (key, content) => set((state) => { const old = state.drafts[key]; return old ? { drafts: { ...state.drafts, [key]: { ...old, content } } } : state; }),
  saved: (key, content, revision) => set((state) => {
    const old = state.drafts[key];
    // Edits made while a save was pending remain dirty against the saved revision.
    return old ? { drafts: { ...state.drafts, [key]: { content: old.content, original: content, revision } } } : state;
  }),
  discard: (key) => set((state) => { const next = { ...state.drafts }; delete next[key]; return { drafts: next }; }),
  forgetSession: (sessionId) => set((state) => ({
    drafts: Object.fromEntries(Object.entries(state.drafts).filter(([key]) => !key.startsWith(`${sessionId}:`))),
    recovery: Object.fromEntries(Object.entries(state.recovery).filter(([key]) => !key.startsWith(`${sessionId}:`)))
  }))
}));
